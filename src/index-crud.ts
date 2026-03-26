// Hono HTTP API with CRUD endpoints
import { Hono } from 'hono';
import { CloudflareBindings } from './types';
import { crudApi } from './crud-api';
import { getFlowSteps, saveFlowRun, updateFlowRunStatus, saveStepRun, saveApiLog } from './services/database';
import { StepExecutor } from './core/step-executor';
import { resolveStepInstructions } from './services/stepResolver';

const app = new Hono<{ Bindings: CloudflareBindings }>();

// CORS middleware
app.use('*', async (c, next) => {
  // Handle preflight requests
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { 
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-key',
        'Access-Control-Max-Age': '86400'
      }
    });
  }
  
  // Set CORS headers for other requests
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
  c.header('Access-Control-Max-Age', '86400');
  
  await next();
});

// Mount CRUD API at /api
app.route('/api', crudApi);

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: Date.now() });
});

// Simple in-memory flow execution state
const flowExecutions = new Map<string, {
  flowId: string;
  currentStepIndex: number;
  variables: Record<string, any>;
  steps: any[];
}>();

// Start a new flow
app.post('/start-flow', async (c) => {
  try {
    const body = await c.req.json();
    const { flow_id, inputs = {} } = body;

    if (!flow_id) {
      return c.json({ error: 'flow_id is required' }, 400);
    }

    // Get flow steps from database
    const steps = await getFlowSteps(c.env.FLOW_RUNS_DB, flow_id);
    if (!steps || steps.length === 0) {
      return c.json({ error: 'Flow not found or has no steps' }, 404);
    }

    // Create flow run
    const flowRunId = `flow-run-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    await saveFlowRun(c.env.FLOW_RUNS_DB, {
      flow_run_id: flowRunId,
      flow_id,
      status: 'running',
      started_at: new Date().toISOString()
    });

    // Initialize execution state
    flowExecutions.set(flowRunId, {
      flowId: flow_id,
      currentStepIndex: 0,
      variables: { ...inputs },
      steps
    });

    return c.json({
      success: true,
      flow_run_id: flowRunId,
      flow_id,
      message: 'Flow execution started'
    });
  } catch (error: any) {
    console.error('Error starting flow:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Execute next step in a flow
app.post('/step', async (c) => {
  try {
    const body = await c.req.json();
    const { flow_run_id } = body;

    if (!flow_run_id) {
      return c.json({ error: 'flow_run_id is required' }, 400);
    }

    // Get execution state
    const execution = flowExecutions.get(flow_run_id);
    if (!execution) {
      return c.json({ error: 'Flow execution not found' }, 404);
    }

    const { flowId, currentStepIndex, variables, steps } = execution;

    // Check if flow is completed
    if (currentStepIndex >= steps.length) {
      await updateFlowRunStatus(c.env.FLOW_RUNS_DB, flow_run_id, 'completed');
      return c.json({
        success: true,
        step_id: null,
        output: { message: 'Flow completed' },
        next_step_id: null,
        next_flow_id: null,
        variables
      });
    }

    // Get current step
    const step = steps[currentStepIndex];
    
    // Resolve step instructions
    const resolved = await resolveStepInstructions(
      step,
      c.env.FLOW_RUNS_DB,
      c.env,
      variables
    );

    // Execute step
    const stepExecutor = new StepExecutor(c.env);
    const context = {
      variables,
      ai_output: null,
      ai_timestamp: Date.now(),
      step_id: step.id,
      step_count: currentStepIndex
    };

    const result = await stepExecutor.executeStep(context, step, 'deepseek');

    // Save step run
    await saveStepRun(c.env.FLOW_RUNS_DB, {
      flow_run_id,
      step_id: step.id,
      status: 'completed',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString()
    });

    // Save API log
    await saveApiLog(c.env.FLOW_RUNS_DB, {
      flow_run_id,
      step_id: step.id,
      type: 'step_execution',
      request: {
        step_fields: Object.keys(step).filter(k => ['command', 'api', 'url', 'instructions'].includes(k)),
        instructions: resolved.instructions,
        agent: step.agent || 'deepseek'
      },
      response: result.ai_output,
      status_code: 200,
      duration_ms: 100
    });

    // Update variables
    const updatedVariables = { ...variables, ...result.ai_output.variables };

    // Move to next step
    const nextStepIndex = currentStepIndex + 1;
    execution.currentStepIndex = nextStepIndex;
    execution.variables = updatedVariables;

    // Get next step ID (not index)
    let nextStepId = null;
    if (nextStepIndex < steps.length) {
      const nextStep = steps[nextStepIndex];
      nextStepId = nextStep.id;
    }

    // Update execution state
    flowExecutions.set(flow_run_id, execution);

    return c.json({
      success: true,
      step_id: step.id,
      output: result.ai_output,
      next_step_id: nextStepId,
      next_flow_id: step.next_flow_id || null,
      variables: updatedVariables
    });
  } catch (error: any) {
    console.error('Error executing step:', error);
    return c.json({ error: error.message }, 500);
  }
});

// 404 handler
app.all('*', (c) => {
  return c.json({ error: 'Not found' }, 404);
});

export default app;


