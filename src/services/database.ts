// Database service for flow runs tracking
import { FlowRunData, IterationData, ProjectFact, StepData, StepRunData } from '../types';

// API Log interface
export interface ApiLogData {
  id?: string;
  flow_run_id: string;
  step_id: string;
  type: string;
  request: any;
  response: any;
  status_code: number;
  duration_ms: number;
  created_at?: number;
}

/**
 * Save a flow run to the database
 * @param db D1Database instance
 * @param flowRun Flow run data to save
 * @returns Promise with success status
 */
export async function saveFlowRun(db: D1Database, flowRun: FlowRunData): Promise<{success: boolean; error?: string}> {
  try {
    // Calculate started_at and completed_at based on status
    const now = Math.floor(Date.now() / 1000);
    const started_at = flowRun.status === 'active' ? now : null;
    const completed_at = (flowRun.status === 'completed' || flowRun.status === 'failed' || flowRun.status === 'stopped' || flowRun.status === 'new_flow_started') ? now : null;
    
    // Ensure conversation_id is not undefined
    const conversation_id = flowRun.conversation_id || null;
    
    await db.prepare(`
      INSERT INTO flow_runs (
        id, flow_id, conversation_id, step_id, input_prompt, input_payload, output_response,
        status, duration_ms, started_at, completed_at, created_at, next_flow_id, next_flow_ids, stop_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      flowRun.id,
      flowRun.flow_id || null,
      conversation_id,
      flowRun.step_id || null,
      flowRun.input_prompt || null,
      flowRun.input_payload || null,
      flowRun.output_response || null,
      flowRun.status || 'active',
      flowRun.duration_ms || 0,
      started_at,
      completed_at,
      flowRun.created_at || now,
      flowRun.next_flow_id || null,
      flowRun.next_flow_ids ? JSON.stringify(flowRun.next_flow_ids) : null,
      null // stop_reason
    ).run();

    return { success: true };
  } catch (error: any) {
    console.error(`[DATABASE] Error saving flow run: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Update a flow run status
 * @param db D1Database instance
 * @param flowRunId Flow run ID
 * @param status New status
 * @param stopReason Reason for stopping (optional)
 * @param nextFlowId Next flow ID if starting new flow (optional)
 * @returns Promise with success status
 */
export async function updateFlowRunStatus(
  db: D1Database,
  flowRunId: string,
  status: FlowRunData['status'],
  stopReason?: string,
  nextFlowId?: string,
  outputResponse?: string,
  nextFlowIds?: string[]
): Promise<{success: boolean; error?: string}> {
  try {
    // Set completed_at for terminal states
    const completed_at = (status === 'completed' || status === 'failed' || status === 'stopped' || status === 'new_flow_started') 
      ? Math.floor(Date.now() / 1000) 
      : null;
    
    // Build the update query dynamically based on what fields are provided
    let query = `UPDATE flow_runs SET status = ?, completed_at = ?`;
    const bindings: any[] = [status, completed_at];
    
    if (nextFlowId !== undefined) {
      query += `, next_flow_id = ?`;
      bindings.push(nextFlowId || null);
    }
    
    if (nextFlowIds !== undefined) {
      query += `, next_flow_ids = ?`;
      bindings.push(nextFlowIds ? JSON.stringify(nextFlowIds) : null);
    }
    
    if (stopReason !== undefined) {
      query += `, stop_reason = ?`;
      bindings.push(stopReason || null);
    }
    
    if (outputResponse !== undefined) {
      query += `, output_response = ?`;
      bindings.push(outputResponse || null);
    }
    
    query += ` WHERE id = ?`;
    bindings.push(flowRunId);
    
    await db.prepare(query).bind(...bindings).run();

    return { success: true };
  } catch (error: any) {
    console.error(`[DATABASE] Error updating flow run status: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Save an iteration to the database
 * @param db D1Database instance
 * @param iteration Iteration data to save
 * @returns Promise with success status
 */
export async function saveIteration(db: D1Database, iteration: IterationData): Promise<{success: boolean; error?: string}> {
  try {
    await db.prepare(`
      INSERT INTO iterations (
        flow_run_id, iteration_number, prompt, response, openhands_response, timestamp, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      iteration.flow_run_id,
      iteration.iteration_number,
      iteration.prompt,
      iteration.response,
      iteration.openhands_response || null,
      iteration.timestamp,
      iteration.metadata || null
    ).run();

    return { success: true };
  } catch (error: any) {
    console.error(`[DATABASE] Error saving iteration: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Save a step run to the database
 * @param db D1Database instance
 * @param stepRun Step run data to save
 * @returns Promise with success status
 */
export async function saveStepRun(db: D1Database, stepRun: StepRunData): Promise<{success: boolean; error?: string}> {
  try {
    await db.prepare(`
      INSERT INTO step_runs (
        id, flow_run_id, step_id, iteration, attempt, prompt, response,
        input_payload, output_payload, status, created_at, duration_ms, api_calls
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(flow_run_id, step_id, iteration, attempt) 
      DO UPDATE SET
        prompt = excluded.prompt,
        response = excluded.response,
        input_payload = excluded.input_payload,
        output_payload = excluded.output_payload,
        status = excluded.status,
        duration_ms = excluded.duration_ms,
        api_calls = excluded.api_calls
    `).bind(
      stepRun.id,
      stepRun.flow_run_id,
      stepRun.step_id,
      stepRun.iteration,
      stepRun.attempt,
      stepRun.prompt,
      stepRun.response,
      stepRun.input_payload || null,
      stepRun.output_payload || null,
      stepRun.status,
      stepRun.created_at,
      stepRun.duration_ms,
      stepRun.api_calls || null
    ).run();

    return { success: true };
  } catch (error: any) {
    console.error(`[DATABASE] Error saving step run: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Get a flow run by ID
 * @param db D1Database instance
 * @param flowRunId Flow run ID
 * @returns Promise with flow run data or null
 */
export async function getFlowRun(db: D1Database, flowRunId: string): Promise<FlowRunData | null> {
  try {
    const result = await db.prepare(`
      SELECT * FROM flow_runs WHERE id = ?
    `).bind(flowRunId).first();

    return result as FlowRunData | null;
  } catch (error: any) {
    console.error(`[DATABASE] Error getting flow run: ${error.message}`);
    return null;
  }
}

/**
 * Get flow runs by status
 * @param db D1Database instance
 * @param status Status to filter by
 * @param limit Maximum number of results
 * @returns Promise with array of flow runs
 */
export async function getFlowRunsByStatus(
  db: D1Database,
  status: FlowRunData['status'],
  limit: number = 100
): Promise<FlowRunData[]> {
  try {
    const result = await db.prepare(`
      SELECT * FROM flow_runs 
      WHERE status = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `).bind(status, limit).all();

    return result.results as unknown as FlowRunData[];
  } catch (error: any) {
    console.error(`[DATABASE] Error getting flow runs by status: ${error.message}`);
    return [];
  }
}

/**
 * Get iterations for a flow run
 * @param db D1Database instance
 * @param flowRunId Flow run ID
 * @returns Promise with array of iterations
 */
export async function getIterationsForFlowRun(db: D1Database, flowRunId: string): Promise<IterationData[]> {
  try {
    const result = await db.prepare(`
      SELECT * FROM iterations 
      WHERE flow_run_id = ? 
      ORDER BY iteration_number ASC
    `).bind(flowRunId).all();

    return result.results as unknown as IterationData[];
  } catch (error: any) {
    console.error(`[DATABASE] Error getting iterations: ${error.message}`);
    return [];
  }
}

/**
 * Generate a unique flow run ID
 * @returns Unique flow run ID
 */
export function generateFlowRunId(): string {
  return `flow_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Generate a unique step run ID
 * @returns Unique step run ID
 */
export function generateStepRunId(): string {
  return `step_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get all project facts from the database
 * @param db D1Database instance (PROJECT_FACTS_DB)
 * @returns Promise with array of project facts
 */
export async function getProjectFacts(db: D1Database): Promise<ProjectFact[]> {
  try {
    const result = await db.prepare(`
      SELECT tag, value FROM project_facts
    `).all();
    
    return result.results as unknown as ProjectFact[];
  } catch (error: any) {
    console.error(`[DATABASE] Error getting project facts: ${error.message}`);
    return [];
  }
}

// ==========================================================================
// TASK MANAGEMENT FUNCTIONS
// ==========================================================================

export interface TaskData {
  task_id: string;
  title: string;
  description: string | null;
  task_type: 'TASK' | 'FOLLOWUP';
  parent_task_id: string | null;
}

/**
 * Get the next pending task for a flow
 * @param db D1Database instance
 * @param flow_id Flow ID
 * @returns Promise with next task data or null if no pending tasks
 */
export async function getNextTaskForFlow(db: D1Database, flow_id: string): Promise<TaskData | null> {
  try {
    // Use the exact logic from task_selection_logic.sql
    // 1. First check for PENDING follow-ups where parent is DONE
    const followupResult = await db.prepare(`
      SELECT 
        tf.id as task_id,
        tf.title,
        tf.description,
        'FOLLOWUP' as task_type,
        tf.parent_task_id
      FROM task_followups tf
      INNER JOIN tasks t ON tf.parent_task_id = t.id
      WHERE t.flow_id = ? 
        AND t.status = 'done'
        AND tf.status = 'pending'
      ORDER BY tf.order_index
      LIMIT 1
    `).bind(flow_id).first();
    
    if (followupResult) {
      return followupResult as unknown as TaskData;
    }
    
    // 2. If no such follow-up, get first PENDING task
    const taskResult = await db.prepare(`
      SELECT 
        t.id as task_id,
        t.title,
        t.description,
        'TASK' as task_type,
        NULL as parent_task_id
      FROM tasks t
      WHERE t.flow_id = ? 
        AND t.status = 'pending'
      ORDER BY t.order_index
      LIMIT 1
    `).bind(flow_id).first();
    
    return taskResult as unknown as TaskData | null;
    
  } catch (error: any) {
    console.error(`[DATABASE] Error getting next task for flow ${flow_id}: ${error.message}`);
    return null;
  }
}



/**
 * Get step with task data if task_id is present
 * @param db D1Database instance
 * @param step_id Step ID
 * @returns Step data with optional task data
 */
export async function getStepWithTaskData(db: D1Database, step_id: string): Promise<StepData & { task_title?: string; task_description?: string }> {
  try {
    const query = `
      SELECT 
        fs.id as step_id,
        fs.step_key,
        fs.title,
        fs.instructions as description,
        fs.step_type,
        fs.order_index,
        fs.page_key,
        fs.blocking,
        fs.auto_fail_on_error,
        fs.retryable,
        fs.task_id,
        fs.input_keys,  -- For dynamic API data fetching
        CASE WHEN fs.output_url IS NOT NULL AND fs.output_url != '' THEN 1 ELSE 0 END as output,
        fs.output_url,
        fs.output_auth_token,
        fs.requires_task,
        fs.dual_agent,
        fs.ruler_agent,
        fs.goal_criteria,
        fs.max_iterations_per_step,
        fs.expected_response,
        fs.use_endpoints,
        fs.extra_step,
        fs.next_flow_id,
        t.title as task_title,
        t.description as task_description
      FROM flow_steps fs
      LEFT JOIN tasks t ON fs.task_id = t.id
      WHERE fs.id = ?
    `;
    
    const result = await db.prepare(query).bind(step_id).first();
    
    if (!result) {
      throw new Error(`Step not found: ${step_id}`);
    }
    
    return result as unknown as StepData & { task_title?: string; task_description?: string };
  } catch (error: any) {
    console.error(`[DATABASE] Error getting step with task data: ${error.message}`);
    throw error;
  }
}

/**
 * Get task data by task ID
 * @param db D1Database instance
 * @param task_id Task ID
 * @returns Promise with task data or null if not found
 */
export async function getTaskData(
  db: D1Database,
  task_id: string
): Promise<{ title: string; description: string | null; payload: string | null } | null> {
  try {
    // Query tasks table (new schema)
    // Get title, description, and payload columns
    const query = `
      SELECT title, 
             description,
             payload
      FROM tasks
      WHERE id = ?
    `;
    
    const result = await db.prepare(query).bind(task_id).first();
    
    if (!result) {
      return null;
    }
    
    const resultObj = result as unknown as { title: string; description: string | null; payload: string | null };
    let description = resultObj.description;
    
    // If description is null, use payload as fallback
    if (!description && resultObj.payload) {
      description = resultObj.payload;
    }
    
    // Try to parse JSON if description looks like JSON
    if (description && description.trim().startsWith('{') && description.trim().endsWith('}')) {
      try {
        const parsed = JSON.parse(description);
        // Extract instructions field if present, otherwise use the whole object
        if (parsed.instructions) {
          description = parsed.instructions;
        } else if (typeof parsed === 'object') {
          // Try to find any string field that looks like instructions
          const stringFields = Object.values(parsed).filter(v => typeof v === 'string');
          if (stringFields.length > 0) {
            description = stringFields[0];
          }
        }
      } catch (e) {
        // Not valid JSON, keep as-is
        console.log(`[DATABASE] Task description is not valid JSON: ${e.message}`);
      }
    }
    
    return { title: resultObj.title, description, payload: resultObj.payload };
  } catch (error: any) {
    console.error(`[DATABASE] Error getting task data: ${error.message}`);
    return null;
  }
}

/**
 * Get first pending task for a flow
 * @param db D1Database instance
 * @param flow_id Flow ID
 * @returns Promise with task data or null if no pending tasks
 */
// Helper function to parse mixed date/time formats
function parseTime(time: any): number {
  if (time === null || time === undefined) {
    return 0;
  }
  
  // If it's already a number (Unix timestamp)
  if (typeof time === 'number') {
    return time;
  }
  
  // If it's a string that's all digits (Unix timestamp as string)
  if (typeof time === 'string' && /^\d+$/.test(time)) {
    return parseInt(time, 10);
  }
  
  // Try to parse as ISO date string
  if (typeof time === 'string') {
    const date = new Date(time);
    if (!isNaN(date.getTime())) {
      return Math.floor(date.getTime() / 1000); // Convert to Unix timestamp
    }
  }
  
  // Fallback: return 0 (will sort to beginning) or large number (will sort to end)
  // Using 0 so undefined/bad dates come first (conservative approach)
  return 0;
}

export async function getFirstPendingTask(
  db: D1Database,
  flow_id: string
): Promise<{ id: string; title: string; description: string | null; payload: string | null } | null> {
  try {
    // Query tasks table with new unified schema
    // Sort by numeric_priority (lower number = higher priority) then by created_at
    const query = `
      SELECT 
        id,
        title,
        task_type,
        action,
        file,
        line,
        dependencies,
        numeric_priority,
        description,
        endpoint_path,
        http_method,
        sample_payload,
        expected_response,
        auth_required
      FROM tasks
      WHERE status = 'pending' AND task_type = 'implementation' AND flow_id = ?
      ORDER BY numeric_priority ASC, created_at ASC
      LIMIT 1
    `;
    
    console.log(`[getFirstPendingTask] Querying pending implementation tasks for flow: ${flow_id}`);
    const results = await db.prepare(query).bind(flow_id).all();
    
    console.log(`[getFirstPendingTask] Query returned ${results?.results?.length || 0} tasks`);
    if (results?.results?.length > 0) {
      console.log(`[getFirstPendingTask] First task sample:`, {
        id: results.results[0].id,
        title: results.results[0].title,
        task_type: results.results[0].task_type,
        numeric_priority: results.results[0].numeric_priority
      });
    }
    
    if (!results || !results.results || results.results.length === 0) {
      console.log(`[getFirstPendingTask] No pending implementation tasks found`);
      return null;
    }
    
    const result = results.results[0];
    
    const resultObj = result as unknown as { 
      id: string; 
      title: string; 
      description: string | null;
      action: string | null;
      file: string | null;
      line: number | null;
      dependencies: string | null;
      numeric_priority: number;
      endpoint_path: string | null;
      http_method: string | null;
      sample_payload: string | null;
      expected_response: string | null;
      auth_required: boolean;
    };
    
    // Use action as description if description is null
    let description = resultObj.description;
    if (!description && resultObj.action) {
      description = resultObj.action;
    }
    
    // Build a comprehensive payload with all task details
    const payload = JSON.stringify({
      task_type: resultObj.task_type,
      action: resultObj.action,
      file: resultObj.file,
      line: resultObj.line,
      dependencies: resultObj.dependencies ? JSON.parse(resultObj.dependencies) : [],
      numeric_priority: resultObj.numeric_priority,
      endpoint_path: resultObj.endpoint_path,
      http_method: resultObj.http_method,
      sample_payload: resultObj.sample_payload ? JSON.parse(resultObj.sample_payload) : null,
      expected_response: resultObj.expected_response ? JSON.parse(resultObj.expected_response) : null,
      auth_required: resultObj.auth_required
    }, null, 2);
    
    return { id: resultObj.id, title: resultObj.title, description, payload };
  } catch (error: any) {
    console.error(`[DATABASE] Error getting first pending task: ${error.message}`);
    return null;
  }
}

/**
 * Get latest task for a flow (most recently created)
 * @param db D1Database instance
 * @param flow_id Flow ID
 * @returns Promise with task data or null
 */
export async function getLatestTaskForFlow(
  db: D1Database,
  flow_id: string
): Promise<{ id: string; title: string; description: string | null; payload: string | null } | null> {
  try {
    // Query tasks table for the most recently created task for this flow
    const query = `
      SELECT 
        id,
        title,
        description,
        payload
      FROM tasks
      WHERE flow_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `;
    
    console.log(`[getLatestTaskForFlow] Querying latest task for flow: ${flow_id}`);
    const result = await db.prepare(query).bind(flow_id).first();
    
    if (!result) {
      console.log(`[getLatestTaskForFlow] No tasks found for flow ${flow_id}`);
      return null;
    }
    
    const resultObj = result as unknown as { 
      id: string; 
      title: string; 
      description: string | null;
      payload: string | null;
    };
    
    console.log(`[getLatestTaskForFlow] Found task: ${resultObj.title} (ID: ${resultObj.id})`);
    return { 
      id: resultObj.id, 
      title: resultObj.title, 
      description: resultObj.description, 
      payload: resultObj.payload 
    };
  } catch (error: any) {
    console.error(`[DATABASE] Error getting latest task for flow: ${error.message}`);
    return null;
  }
}

/**
 * Get next step for a flow from flow_steps table
 * @param db D1Database instance
 * @param flow_id Flow ID
 * @param flow_run_id Optional flow run ID to check for completed steps
 * @returns Promise with step data or null
 */
export async function getNextStepForFlow(db: D1Database, flow_id: string, flow_run_id?: string): Promise<StepData | null> {
  try {
    // Get the next step that hasn't been completed yet
    // We check task_execution_steps table for completed steps
    let query = `
      SELECT 
        fs.id as step_id,
        fs.step_key,
        fs.title,
        fs.instructions as description,
        fs.step_type,
        fs.order_index,
        fs.page_key,
        fs.blocking,
        fs.auto_fail_on_error,
        fs.retryable,
        fs.task_id,
        fs.input_keys,
        CASE WHEN fs.output_url IS NOT NULL AND fs.output_url != '' THEN 1 ELSE 0 END as output,
        fs.output_url,
        fs.output_auth_token,
        fs.requires_task,
        fs.dual_agent,
        fs.ruler_agent,
        fs.goal_criteria,
        fs.max_iterations_per_step,
        fs.expected_response,
        fs.use_endpoints,
        fs.extra_step,
        fs.next_flow_id
      FROM flow_steps fs
      WHERE fs.flow_id = ? 
    `;
    
    // If we have a flow_run_id, exclude steps that have been completed
    if (flow_run_id) {
      query += `
        AND fs.id NOT IN (
          SELECT tes.task_id 
          FROM task_execution_steps tes 
          WHERE tes.execution_id = ? 
            AND tes.status = 'done'
        )
      `;
    }
    
    query += ` ORDER BY fs.order_index LIMIT 1`;
    
    const bindings = flow_run_id ? [flow_id, flow_run_id] : [flow_id];
    const stepResult = await db.prepare(query).bind(...bindings).first();
    
    return stepResult as unknown as StepData | null;
    
  } catch (error: any) {
    console.error(`[DATABASE] Error getting next step for flow ${flow_id}: ${error.message}`);
    return null;
  }
}

/**
 * Get next step for flow based on previous step response and conditions
 * @param db D1Database instance
 * @param flow_id Flow ID
 * @param current_step_id Current step ID
 * @param response_text Response text from current step
 * @returns Next step data or null if no matching condition
 */
export async function getNextStepBasedOnConditions(
  db: D1Database,
  flow_id: string,
  current_step_id: string,
  response_text: string
): Promise<StepData | null> {
  try {
    console.log(`[DATABASE] Getting next step based on conditions for flow ${flow_id}, step ${current_step_id}, response: ${response_text.substring(0, 100)}...`);
    
    // First, check if current step has conditions
    const conditionsQuery = `
      SELECT fsc.condition_type, fsc.condition_value, fsc.condition_operator, 
             fsc.next_step, fsc.next_step_id
      FROM flow_step_conditions fsc
      WHERE fsc.flow_step_id = ?
      ORDER BY fsc.created_at
    `;
    
    const conditionsResult = await db.prepare(conditionsQuery).bind(current_step_id).all();
    
    if (conditionsResult.results && conditionsResult.results.length > 0) {
      console.log(`[DATABASE] Found ${conditionsResult.results.length} conditions for step ${current_step_id}`);
      
      // Check each condition against the response
      for (const condition of conditionsResult.results) {
        const { condition_type, condition_value, condition_operator, next_step, next_step_id } = condition;
        let conditionMet = false;
        
        switch (condition_type) {
          case 'response_contains':
            conditionMet = response_text.toLowerCase().includes(condition_value.toLowerCase());
            break;
          case 'response_matches':
            // Simple exact match (case-insensitive)
            conditionMet = response_text.toLowerCase() === condition_value.toLowerCase();
            break;
          case 'response_starts_with':
            conditionMet = response_text.toLowerCase().startsWith(condition_value.toLowerCase());
            break;
          case 'response_ends_with':
            conditionMet = response_text.toLowerCase().endsWith(condition_value.toLowerCase());
            break;
          default:
            console.warn(`[DATABASE] Unknown condition type: ${condition_type}`);
            continue;
        }
        
        if (conditionMet) {
          console.log(`[DATABASE] Condition met: ${condition_type} "${condition_value}" -> next_step_id: ${next_step_id}, next_step (legacy): ${next_step}`);
          
          // Check for termination first (next_step_id = 'TERMINATE_FLOW' or next_step = -1)
          if (next_step_id === 'TERMINATE_FLOW' || next_step === -1) {
            console.log(`[DATABASE] Termination condition met, flow should end`);
            // Return a special marker to indicate termination
            return {
              step_id: 'TERMINATE_FLOW',
              step_key: 'terminate',
              title: 'Flow Termination',
              description: 'Flow terminated by condition',
              step_type: 'termination',
              order_index: -1,
              page_key: null,
              blocking: false,
              auto_fail_on_error: false,
              retryable: false,
              task_id: null,
              input_keys: null,
              output: false,
              output_url: null,
              output_auth_token: null,
              requires_task: false,
              dual_agent: false,
              ruler_agent: null,
              goal_criteria: null,
              max_iterations_per_step: null,
              expected_response: null,
              use_endpoints: null,
              extra_step: false
            } as unknown as StepData;
          }
          
          // Try to get next step by step ID first (new system)
          let nextStepResult = null;
          if (next_step_id && next_step_id !== 'TERMINATE_FLOW') {
            const nextStepByIdQuery = `
              SELECT 
                fs.id as step_id,
                fs.step_key,
                fs.title,
                fs.instructions as description,
                fs.step_type,
                fs.order_index,
                fs.page_key,
                fs.blocking,
                fs.auto_fail_on_error,
                fs.retryable,
                fs.task_id,
                fs.input_keys,
                CASE WHEN fs.output_url IS NOT NULL AND fs.output_url != '' THEN 1 ELSE 0 END as output,
                fs.output_url,
                fs.output_auth_token,
                fs.requires_task,
                fs.dual_agent,
                fs.ruler_agent,
                fs.goal_criteria,
                fs.max_iterations_per_step,
                fs.expected_response,
                fs.use_endpoints,
                fs.extra_step,
                fs.next_flow_id
              FROM flow_steps fs
              WHERE fs.id = ?
              LIMIT 1
            `;
            
            nextStepResult = await db.prepare(nextStepByIdQuery).bind(next_step_id).first();
            
            if (nextStepResult) {
              console.log(`[DATABASE] Found next step by ID: ${nextStepResult.title} (step_id: ${next_step_id})`);
              return nextStepResult as unknown as StepData;
            } else {
              console.warn(`[DATABASE] No step found with ID ${next_step_id}, falling back to legacy index lookup`);
            }
          }
          
          // Fall back to legacy index-based lookup if step ID not found or not provided
          if (next_step !== null && next_step !== undefined && next_step !== -1) {
            const nextStepByIndexQuery = `
              SELECT 
                fs.id as step_id,
                fs.step_key,
                fs.title,
                fs.instructions as description,
                fs.step_type,
                fs.order_index,
                fs.page_key,
                fs.blocking,
                fs.auto_fail_on_error,
                fs.retryable,
                fs.task_id,
                fs.input_keys,
                CASE WHEN fs.output_url IS NOT NULL AND fs.output_url != '' THEN 1 ELSE 0 END as output,
                fs.output_url,
                fs.output_auth_token,
                fs.requires_task,
                fs.dual_agent,
                fs.ruler_agent,
                fs.goal_criteria,
                fs.max_iterations_per_step,
                fs.expected_response,
                fs.use_endpoints,
                fs.extra_step,
                fs.next_flow_id
              FROM flow_steps fs
              WHERE fs.flow_id = ? AND fs.order_index = ?
              LIMIT 1
            `;
            
            nextStepResult = await db.prepare(nextStepByIndexQuery).bind(flow_id, next_step).first();
            
            if (nextStepResult) {
              console.log(`[DATABASE] Found next step by index: ${nextStepResult.title} (order_index: ${next_step})`);
              return nextStepResult as unknown as StepData;
            } else {
              console.warn(`[DATABASE] No step found at order_index ${next_step} for flow ${flow_id}`);
            }
          }
        }
      }
      
      console.log(`[DATABASE] No conditions met for step ${current_step_id}`);
    } else {
      console.log(`[DATABASE] No conditions found for step ${current_step_id}`);
    }
    
    // If no conditions met or no conditions exist, check for default_next_step
    const defaultStepQuery = `
      SELECT 
        fs.id as step_id,
        fs.step_key,
        fs.title,
        fs.instructions as description,
        fs.step_type,
        fs.order_index,
        fs.page_key,
        fs.blocking,
        fs.auto_fail_on_error,
        fs.retryable,
        fs.task_id,
        fs.requires_task,
        CASE WHEN fs.output_url IS NOT NULL AND fs.output_url != '' THEN 1 ELSE 0 END as output,
        fs.output_url,
        fs.output_auth_token,
        fs.default_next_step,
        fs.default_next_step_id
      FROM flow_steps fs
      WHERE fs.id = ?
      LIMIT 1
    `;
    
    const currentStepResult = await db.prepare(defaultStepQuery).bind(current_step_id).first();
    
    // Try default_next_step_id first (new system)
    if (currentStepResult && currentStepResult.default_next_step_id) {
      console.log(`[DATABASE] Using default_next_step_id: ${currentStepResult.default_next_step_id} for step ${current_step_id}`);
      
      const defaultStepByIdQuery = `
        SELECT 
          fs.id as step_id,
          fs.step_key,
          fs.title,
          fs.instructions as description,
          fs.step_type,
          fs.order_index,
          fs.page_key,
          fs.blocking,
          fs.auto_fail_on_error,
          fs.retryable,
          fs.task_id,
          fs.input_keys,
          CASE WHEN fs.output_url IS NOT NULL AND fs.output_url != '' THEN 1 ELSE 0 END as output,
          fs.output_url,
          fs.output_auth_token,
          fs.requires_task,
          fs.dual_agent,
          fs.ruler_agent,
          fs.goal_criteria,
          fs.max_iterations_per_step,
          fs.expected_response,
          fs.use_endpoints,
          fs.extra_step,
          fs.next_flow_id
        FROM flow_steps fs
        WHERE fs.id = ?
        LIMIT 1
      `;
      
      const defaultStepResult = await db.prepare(defaultStepByIdQuery).bind(currentStepResult.default_next_step_id).first();
      
      if (defaultStepResult) {
        console.log(`[DATABASE] Found default next step by ID: ${defaultStepResult.title} (step_id: ${currentStepResult.default_next_step_id})`);
        return defaultStepResult as unknown as StepData;
      } else {
        console.warn(`[DATABASE] No step found with ID ${currentStepResult.default_next_step_id}, falling back to legacy index lookup`);
      }
    }
    
    // Fall back to legacy default_next_step (index-based)
    if (currentStepResult && currentStepResult.default_next_step) {
      console.log(`[DATABASE] Using legacy default_next_step: ${currentStepResult.default_next_step} for step ${current_step_id}`);
      
      // Get the step at default_next_step order_index
      const defaultStepByIndexQuery = `
        SELECT 
          fs.id as step_id,
          fs.step_key,
          fs.title,
          fs.instructions as description,
          fs.step_type,
          fs.order_index,
          fs.page_key,
          fs.blocking,
          fs.auto_fail_on_error,
          fs.retryable,
          fs.task_id,
          fs.input_keys,
          CASE WHEN fs.output_url IS NOT NULL AND fs.output_url != '' THEN 1 ELSE 0 END as output,
          fs.output_url,
          fs.output_auth_token,
          fs.requires_task,
          fs.dual_agent,
          fs.ruler_agent,
          fs.goal_criteria,
          fs.max_iterations_per_step,
          fs.expected_response,
          fs.use_endpoints,
          fs.extra_step,
          fs.next_flow_id
        FROM flow_steps fs
        WHERE fs.flow_id = ? AND fs.order_index = ?
        LIMIT 1
      `;
      
      const defaultStepResult = await db.prepare(defaultStepByIndexQuery).bind(flow_id, currentStepResult.default_next_step).first();
      
      if (defaultStepResult) {
        console.log(`[DATABASE] Found default next step by index: ${defaultStepResult.title} (order_index: ${currentStepResult.default_next_step})`);
        return defaultStepResult as unknown as StepData;
      }
    }
    
    // If no default_next_step, get next sequential step
    console.log(`[DATABASE] No conditions or default_next_step, getting next sequential step`);
    
    // Get current step's order_index
    const currentStepOrderQuery = `
      SELECT order_index FROM flow_steps WHERE id = ? LIMIT 1
    `;
    
    const currentStepOrderResult = await db.prepare(currentStepOrderQuery).bind(current_step_id).first();
    
    if (currentStepOrderResult) {
      const currentOrderIndex = currentStepOrderResult.order_index;
      const nextOrderIndex = currentOrderIndex + 1;
      
      const nextSequentialQuery = `
        SELECT 
          fs.id as step_id,
          fs.step_key,
          fs.title,
          fs.instructions as description,
          fs.step_type,
          fs.order_index,
          fs.page_key,
          fs.blocking,
          fs.auto_fail_on_error,
          fs.retryable,
          fs.task_id,
          fs.input_keys,
          CASE WHEN fs.output_url IS NOT NULL AND fs.output_url != '' THEN 1 ELSE 0 END as output,
          fs.output_url,
          fs.output_auth_token,
          fs.requires_task,
          fs.dual_agent,
          fs.ruler_agent,
          fs.goal_criteria,
          fs.max_iterations_per_step,
          fs.expected_response,
          fs.use_endpoints,
          fs.extra_step,
          fs.next_flow_id
        FROM flow_steps fs
        WHERE fs.flow_id = ? AND fs.order_index = ?
        LIMIT 1
      `;
      
      const nextSequentialResult = await db.prepare(nextSequentialQuery).bind(flow_id, nextOrderIndex).first();
      
      if (nextSequentialResult) {
        console.log(`[DATABASE] Found next sequential step: ${nextSequentialResult.title} (order_index: ${nextOrderIndex})`);
        return nextSequentialResult as unknown as StepData;
      } else {
        console.log(`[DATABASE] No sequential step found at order_index ${nextOrderIndex}`);
      }
    }
    
    console.log(`[DATABASE] No next step found based on conditions, default, or sequential order`);
    return null;
    
  } catch (error: any) {
    console.error(`[DATABASE] Error getting next step based on conditions: ${error.message}`);
    return null;
  }
}

/**
 * Update task status
 * @param db D1Database instance
 * @param task_id Task ID
 * @param status New status ('pending' or 'done')
 * @returns Promise with success status
 */
export async function updateTaskStatus(
  db: D1Database,
  task_id: string,
  status: 'pending' | 'done'
): Promise<{success: boolean; error?: string}> {
  try {
    // Check if this is a task or follow-up
    const taskCheck = await db.prepare(`
      SELECT id FROM tasks WHERE id = ?
      UNION ALL
      SELECT id FROM task_followups WHERE id = ?
    `).bind(task_id, task_id).first();
    
    if (!taskCheck) {
      return { success: false, error: `Task not found: ${task_id}` };
    }
    
    // Update task status
    const taskUpdate = await db.prepare(`
      UPDATE tasks SET status = ? WHERE id = ?
    `).bind(status, task_id).run();
    
    if (taskUpdate.meta.changes > 0) {
      return { success: true };
    }
    
    // If not a task, try updating as follow-up
    const followupUpdate = await db.prepare(`
      UPDATE task_followups SET status = ? WHERE id = ?
    `).bind(status, task_id).run();
    
    if (followupUpdate.meta.changes > 0) {
      return { success: true };
    }
    
    return { success: false, error: 'Failed to update task status' };
    
  } catch (error: any) {
    console.error(`[DATABASE] Error updating task status: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ==========================================================================
// TASK EXECUTION TRACKING FUNCTIONS (minimal, hard facts only)
// ==========================================================================

/**
 * Start tracking a task execution
 * @param db D1Database instance
 * @param execution_id Execution ID
 * @param task_id Task ID
 * @returns Promise with success status and execution step ID
 */
export async function startTaskExecution(
  db: D1Database,
  execution_id: string,
  task_id: string
): Promise<{success: boolean; execution_step_id?: string; error?: string}> {
  try {
    const execution_step_id = `task_exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();
    
    await db.prepare(`
      INSERT INTO task_execution_steps (
        id, execution_id, task_id, started_at, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      execution_step_id,
      execution_id,
      task_id,
      now,
      'pending',
      now,
      now
    ).run();

    return { success: true, execution_step_id };

  } catch (error: any) {
    console.error(`[DATABASE] Error starting task execution: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Complete a task execution
 * @param db D1Database instance
 * @param execution_step_id Execution step ID
 * @returns Promise with success status
 */
export async function completeTaskExecution(
  db: D1Database,
  execution_step_id: string
): Promise<{success: boolean; error?: string}> {
  try {
    const now = Date.now();
    
    const result = await db.prepare(`
      UPDATE task_execution_steps 
      SET finished_at = ?, status = 'done', updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).bind(now, now, execution_step_id).run();

    if (result.meta.changes === 0) {
      return { success: false, error: 'Execution step not found or already completed' };
    }

    return { success: true };

  } catch (error: any) {
    console.error(`[DATABASE] Error completing task execution: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Get task execution history for an execution
 * @param db D1Database instance
 * @param execution_id Execution ID
 * @returns Promise with task execution history
 */
export async function getTaskExecutionHistory(
  db: D1Database,
  execution_id: string
): Promise<{success: boolean; history?: Array<{
  id: string;
  task_id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
}>; error?: string}> {
  try {
    const result = await db.prepare(`
      SELECT id, task_id, started_at, finished_at, status
      FROM task_execution_steps
      WHERE execution_id = ?
      ORDER BY started_at
    `).bind(execution_id).all();

    return { success: true, history: result.results as any };

  } catch (error: any) {
    console.error(`[DATABASE] Error getting task execution history: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Get flow definition from database
 * @param db D1Database instance
 * @param flow_id Flow ID
 * @returns Promise with flow definition or null
 */


/**
 * Get project context for a flow
 * @param db D1Database instance
 * @param flow_id Flow ID
 * @returns Promise with project context items
 */
export async function getFlowProjectContext(
  db: D1Database,
  flow_id: string
): Promise<Array<{
  id: string;
  context_type: string;
  key: string;
  value: string;
  metadata?: string;
}>> {
  try {
    const result = await db.prepare(`
      SELECT id, context_type, key, value, metadata
      FROM project_context
      WHERE flow_id = ?
      ORDER BY context_type, key
    `).bind(flow_id).all();

    return result.results as any;
  } catch (error: any) {
    console.error(`[DATABASE] Error getting flow project context: ${error.message}`);
    return [];
  }
}

/**
 * Get testing priorities for a flow
 * @param db D1Database instance
 * @param flow_id Flow ID
 * @returns Promise with testing priorities
 */
export async function getFlowTestingPriorities(
  db: D1Database,
  flow_id: string
): Promise<Array<{
  id: string;
  priority: number;
  name: string;
  description: string;
  tests?: string;
  ui_requirements?: string;
  sections?: string;
}>> {
  try {
    const result = await db.prepare(`
      SELECT id, priority, name, description, tests, ui_requirements, sections
      FROM testing_priorities
      WHERE flow_id = ?
      ORDER BY priority
    `).bind(flow_id).all();

    return result.results as any;
  } catch (error: any) {
    console.error(`[DATABASE] Error getting flow testing priorities: ${error.message}`);
    return [];
  }
}

/**
 * Get API commands for a flow
 * @param db D1Database instance
 * @param flow_id Flow ID
 * @returns Promise with API commands
 */
export async function getFlowApiCommands(
  db: D1Database,
  flow_id: string
): Promise<Array<{
  id: string;
  name: string;
  command: string;
  description: string;
  placeholder_example?: string;
}>> {
  try {
    const result = await db.prepare(`
      SELECT id, name, command, description, placeholder_example
      FROM api_commands
      WHERE flow_id = ?
      ORDER BY name
    `).bind(flow_id).all();

    return result.results as any;
  } catch (error: any) {
    console.error(`[DATABASE] Error getting flow API commands: ${error.message}`);
    return [];
  }
}

/**
 * Build comprehensive flow context from database
 * @param db D1Database instance
 * @param flow_id Flow ID
 * @returns Promise with complete flow context
 */
export async function getFlowContext(
  db: D1Database,
  flow_id: string
): Promise<{
  definition: any;
  project_context: any[];
  testing_priorities: any[];
  api_commands: any[];
} | null> {
  try {
    const definition = await getFlowDefinition(db, flow_id);
    if (!definition) {
      return null;
    }

    const project_context = await getFlowProjectContext(db, flow_id);
    const testing_priorities = await getFlowTestingPriorities(db, flow_id);
    const api_commands = await getFlowApiCommands(db, flow_id);

    return {
      definition,
      project_context,
      testing_priorities,
      api_commands
    };
  } catch (error: any) {
    console.error(`[DATABASE] Error getting flow context: ${error.message}`);
    return null;
  }
}

/**
 * Get the last response from a flow run
 * @param db D1Database instance
 * @param flow_id Flow ID
 * @param conversation_messages Conversation messages array
 * @returns Last response text or empty string
 */
export function getLastFlowResponse(conversation_messages?: any[]): string {
  if (!conversation_messages || conversation_messages.length === 0) {
    return '';
  }
  
  // Find the last assistant message (DeepSeek response)
  for (let i = conversation_messages.length - 1; i >= 0; i--) {
    const message = conversation_messages[i];
    if (message.role === 'assistant' && message.content) {
      return message.content;
    }
  }
  
  return '';
}

/**
 * Get next flow ID based on flow conditions
 * @param db D1Database instance
 * @param flow_id Current flow ID
 * @param last_response Last response text from the flow
 * @returns Next flow ID or null if no condition matches
 */
export async function getNextFlowBasedOnConditions(
  db: D1Database,
  flow_id: string,
  last_response: string
): Promise<string | null> {
  try {
    console.log(`[DATABASE] Getting next flow based on conditions for flow ${flow_id}, last response: ${last_response.substring(0, 100)}...`);
    
    // Check if current flow has conditions (from flow_flow_conditions table)
    const flowConditionsQuery = `
      SELECT ffc.condition_type, ffc.condition_value, ffc.condition_operator, 
             ffc.next_flow_id
      FROM flow_flow_conditions ffc
      WHERE ffc.flow_id = ?
      ORDER BY ffc.created_at
    `;
    
    const flowConditionsResult = await db.prepare(flowConditionsQuery).bind(flow_id).all();
    
    if (flowConditionsResult.results && flowConditionsResult.results.length > 0) {
      console.log(`[DATABASE] Found ${flowConditionsResult.results.length} flow conditions for flow ${flow_id}`);
      
      // Check each condition against the response
      for (const condition of flowConditionsResult.results) {
        const { condition_type, condition_value, condition_operator, next_flow_id } = condition;
        let conditionMet = false;
        
        switch (condition_type) {
          case 'response_contains':
            conditionMet = last_response.toLowerCase().includes(condition_value.toLowerCase());
            break;
          case 'response_matches':
            // Simple exact match (case-insensitive)
            conditionMet = last_response.toLowerCase() === condition_value.toLowerCase();
            break;
          case 'response_starts_with':
            conditionMet = last_response.toLowerCase().startsWith(condition_value.toLowerCase());
            break;
          case 'response_ends_with':
            conditionMet = last_response.toLowerCase().endsWith(condition_value.toLowerCase());
            break;
          default:
            console.warn(`[DATABASE] Unknown flow condition type: ${condition_type}`);
            continue;
        }
        
        if (conditionMet) {
          console.log(`[DATABASE] Flow condition met: ${condition_type} "${condition_value}" -> next_flow_id: ${next_flow_id}`);
          return next_flow_id;
        }
      }
      
      console.log(`[DATABASE] No flow conditions matched for flow ${flow_id}`);
    } else {
      console.log(`[DATABASE] No flow conditions found for flow ${flow_id}`);
    }
    
    // Also check flow_step_conditions with next_flow_id for the last step of the flow
    const stepConditionsQuery = `
      SELECT fsc.condition_type, fsc.condition_value, fsc.condition_operator, 
             fsc.next_flow_id
      FROM flow_step_conditions fsc
      JOIN flow_steps fs ON fsc.flow_step_id = fs.id
      WHERE fs.flow_id = ? AND fsc.next_flow_id IS NOT NULL
      ORDER BY fs.order_index DESC, fsc.created_at
    `;
    
    const stepConditionsResult = await db.prepare(stepConditionsQuery).bind(flow_id).all();
    
    if (stepConditionsResult.results && stepConditionsResult.results.length > 0) {
      console.log(`[DATABASE] Found ${stepConditionsResult.results.length} step conditions with next_flow_id for flow ${flow_id}`);
      
      // Check each condition against the response
      for (const condition of stepConditionsResult.results) {
        const { condition_type, condition_value, condition_operator, next_flow_id } = condition;
        let conditionMet = false;
        
        switch (condition_type) {
          case 'response_contains':
            conditionMet = last_response.toLowerCase().includes(condition_value.toLowerCase());
            break;
          case 'response_matches':
            // Simple exact match (case-insensitive)
            conditionMet = last_response.toLowerCase() === condition_value.toLowerCase();
            break;
          case 'response_starts_with':
            conditionMet = last_response.toLowerCase().startsWith(condition_value.toLowerCase());
            break;
          case 'response_ends_with':
            conditionMet = last_response.toLowerCase().endsWith(condition_value.toLowerCase());
            break;
          default:
            console.warn(`[DATABASE] Unknown step condition type: ${condition_type}`);
            continue;
        }
        
        if (conditionMet) {
          console.log(`[DATABASE] Step condition met: ${condition_type} "${condition_value}" -> next_flow_id: ${next_flow_id}`);
          return next_flow_id;
        }
      }
      
      console.log(`[DATABASE] No step conditions with next_flow_id matched for flow ${flow_id}`);
    } else {
      console.log(`[DATABASE] No step conditions with next_flow_id found for flow ${flow_id}`);
    }
    
    return null;
    
  } catch (error: any) {
    console.error(`[DATABASE] Error getting next flow based on conditions: ${error.message}`);
    return null;
  }
}

/**
 * Get flow definition by ID
 */
export async function getFlowDefinition(db: D1Database, flowId: string): Promise<any> {
  try {
    const result = await db.prepare(`
      SELECT id, name, description, created_at
      FROM flow_definitions
      WHERE id = ?
    `).bind(flowId).first();
    
    return result;
  } catch (error: any) {
    console.error(`[DATABASE] Error getting flow definition: ${error.message}`);
    return null;
  }
}

/**
 * Get flow steps by flow ID
 */
export async function getFlowSteps(db: D1Database, flowId: string): Promise<StepData[]> {
  try {
    const result = await db.prepare(`
      SELECT id, flow_id, step_id, title, description, instructions, agent, created_at
      FROM flow_steps
      WHERE flow_id = ?
      ORDER BY step_id ASC
    `).bind(flowId).all();
    
    return result.results as StepData[];
  } catch (error: any) {
    console.error(`[DATABASE] Error getting flow steps: ${error.message}`);
    return [];
  }
}

/**
 * Save API log entry
 */
export async function saveApiLog(db: D1Database, log: ApiLogData): Promise<{success: boolean; error?: string}> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const id = log.id || crypto.randomUUID();
    
    await db.prepare(`
      INSERT INTO api_logs (
        id, flow_run_id, step_id, type, request, response, status_code, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      log.flow_run_id,
      log.step_id,
      log.type,
      JSON.stringify(log.request),
      JSON.stringify(log.response),
      log.status_code,
      log.duration_ms,
      now
    ).run();
    
    return { success: true };
  } catch (error: any) {
    console.error(`[DATABASE] Error saving API log: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Get API logs for a flow run
 */
export async function getApiLogs(db: D1Database, flowRunId: string): Promise<ApiLogData[]> {
  try {
    const result = await db.prepare(`
      SELECT id, flow_run_id, step_id, type, request, response, status_code, duration_ms, created_at
      FROM api_logs
      WHERE flow_run_id = ?
      ORDER BY created_at ASC
    `).bind(flowRunId).all();
    
    return result.results.map((row: any) => ({
      ...row,
      request: row.request ? JSON.parse(row.request) : null,
      response: row.response ? JSON.parse(row.response) : null
    })) as ApiLogData[];
  } catch (error: any) {
    console.error(`[DATABASE] Error getting API logs: ${error.message}`);
    return [];
  }
}