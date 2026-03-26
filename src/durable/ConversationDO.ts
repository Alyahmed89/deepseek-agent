// Simplified Durable Object for deterministic flow execution
import { StepExecutor } from '../core/step-executor';
import { ConditionEvaluator } from '../core/condition-evaluator';
import { resolveStepInstructions } from '../services/stepResolver';
import { saveFlowRun, updateFlowRunStatus, saveStepRun, getFlowSteps, getFlowDefinition, saveApiLog } from '../services/database';

export class ConversationOrchestratorDO_2026A {
  private state: DurableObjectState;
  private env: any;
  private flowRunId: string | null = null;
  private currentStepIndex: number = 0;
  private variables: Record<string, any> = {};
  private stepExecutor: StepExecutor;
  private conditionEvaluator: ConditionEvaluator;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
    this.stepExecutor = new StepExecutor(env);
    this.conditionEvaluator = new ConditionEvaluator();
  }

  // ==========================================================================
  // CORE FLOW EXECUTION METHODS
  // ==========================================================================

  async startFlow(flowId: string, inputs: Record<string, any> = {}): Promise<any> {
    console.log(`[ConversationDO] Starting flow: ${flowId}`);
    
    // Get flow definition
    const flow = await getFlowDefinition(this.env.FLOW_RUNS_DB, flowId);
    if (!flow) {
      throw new Error(`Flow not found: ${flowId}`);
    }

    // Create flow run
    this.flowRunId = await saveFlowRun(this.env.FLOW_RUNS_DB, {
      flow_id: flowId,
      conversation_id: this.state.id.toString(),
      status: 'running',
      inputs: JSON.stringify(inputs)
    });

    // Store inputs as variables
    this.variables = { ...inputs };

    // Get flow steps
    const steps = await getFlowSteps(this.env.FLOW_RUNS_DB, flowId);
    await this.state.storage.put('steps', steps);
    await this.state.storage.put('currentStepIndex', 0);
    await this.state.storage.put('variables', this.variables);

    // Set alarm for immediate execution
    await this.state.storage.setAlarm(Date.now() + 100);

    return {
      success: true,
      flow_run_id: this.flowRunId,
      flow_id: flowId,
      message: 'Flow execution started'
    };
  }

  async executeStep(): Promise<any> {
    const steps = await this.state.storage.get<Array<any>>('steps');
    const currentStepIndex = await this.state.storage.get<number>('currentStepIndex') || 0;
    const variables = await this.state.storage.get<Record<string, any>>('variables') || {};

    if (!steps || currentStepIndex >= steps.length) {
      // Flow completed
      await updateFlowRunStatus(this.env.FLOW_RUNS_DB, this.flowRunId!, 'completed');
      return {
        success: true,
        step_id: null,
        output: { message: 'Flow completed' },
        next_step_id: null,
        next_flow_id: null,
        variables: variables
      };
    }

    const step = steps[currentStepIndex];
    
    // Resolve step instructions
    const resolved = await resolveStepInstructions(
      step,
      this.env.FLOW_RUNS_DB,
      this.env,
      {
        flow_id: step.flow_id,
        inputs: variables
      }
    );

    // Create execution context
    const context = {
      ai_input: resolved.instructions,
      step_id: step.id,
      variables: { ...variables, ...resolved.variables }
    };

    // Execute step
    const result = await this.stepExecutor.executeStep(
      context,
      step,
      step.agent || 'deepseek'
    );

    // Save step run
    await saveStepRun(this.env.FLOW_RUNS_DB, {
      flow_run_id: this.flowRunId!,
      step_id: step.id,
      prompt: resolved.instructions,
      response: JSON.stringify(result.ai_output),
      status: 'completed'
    });

    // Save API log for step execution
    await saveApiLog(this.env.FLOW_RUNS_DB, {
      flow_run_id: this.flowRunId!,
      step_id: step.id,
      type: 'step_execution',
      request: {
        step_fields: Object.keys(step).filter(k => ['command', 'api', 'url', 'instructions'].includes(k)),
        instructions: resolved.instructions,
        agent: step.agent || 'deepseek'
      },
      response: result.ai_output,
      status_code: 200,
      duration_ms: 100 // Mock duration
    });

    // Update variables with step output
    const updatedVariables = { ...variables, ...result.ai_output.variables };
    await this.state.storage.put('variables', updatedVariables);
    this.variables = updatedVariables;

    // Move to next step
    const nextStepIndex = currentStepIndex + 1;
    await this.state.storage.put('currentStepIndex', nextStepIndex);

    // Get next step ID (not index)
    let nextStepId = null;
    if (nextStepIndex < steps.length) {
      const nextStep = steps[nextStepIndex];
      nextStepId = nextStep.id;
    }

    // Set alarm for next step
    await this.state.storage.setAlarm(Date.now() + 100);

    return {
      success: true,
      step_id: step.id,
      output: result.ai_output,
      next_step_id: nextStepId,
      next_flow_id: step.next_flow_id || null,
      variables: updatedVariables
    };
  }

  async evaluateCondition(condition: any, context: any): Promise<boolean> {
    return this.conditionEvaluator.evaluate(condition, context);
  }

  async goNext(): Promise<any> {
    // Simply execute the next step
    return this.executeStep();
  }

  async alarm(): Promise<void> {
    // Alarm handler for background execution
    try {
      await this.executeStep();
    } catch (error) {
      console.error(`[ConversationDO] Error in alarm execution:`, error);
      await updateFlowRunStatus(this.env.FLOW_RUNS_DB, this.flowRunId!, 'failed');
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'POST') {
        const body = await request.json();

        if (path.endsWith('/start-flow')) {
          const result = await this.startFlow(body.flow_id, body.inputs || {});
          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (path.endsWith('/step')) {
          const result = await this.executeStep();
          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error: any) {
      return new Response(JSON.stringify({ 
        error: error.message,
        stack: error.stack 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
}
