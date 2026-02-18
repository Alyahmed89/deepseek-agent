// Database service for flow runs tracking
import { FlowRunData, IterationData, StepData } from '../types';

/**
 * Save a flow run to the database
 * @param db D1Database instance
 * @param flowRun Flow run data to save
 * @returns Promise with success status
 */
export async function saveFlowRun(db: D1Database, flowRun: FlowRunData): Promise<{success: boolean; error?: string}> {
  try {
    await db.prepare(`
      INSERT INTO flow_runs (
        id, conversation_id, initial_prompt, deepseek_system, repository, branch,
        max_iterations, actual_iterations, status, stop_reason, prompts_and_responses,
        created_at, updated_at, ended_at, next_flow_id,
        task_type, success_score, quality_metrics, deployment_id, improvement_suggestions
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      flowRun.id,
      flowRun.conversation_id,
      flowRun.initial_prompt,
      flowRun.deepseek_system || null,
      flowRun.repository,
      flowRun.branch || 'main',
      flowRun.max_iterations,
      flowRun.actual_iterations,
      flowRun.status,
      flowRun.stop_reason || null,
      flowRun.prompts_and_responses,
      flowRun.created_at,
      flowRun.updated_at,
      flowRun.ended_at || null,
      flowRun.next_flow_id || null,
      flowRun.task_type || null,
      flowRun.success_score || null,
      flowRun.quality_metrics || null,
      flowRun.deployment_id || null,
      flowRun.improvement_suggestions || null
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
  nextFlowId?: string
): Promise<{success: boolean; error?: string}> {
  try {
    const now = Date.now();
    await db.prepare(`
      UPDATE flow_runs 
      SET status = ?, stop_reason = ?, next_flow_id = ?, updated_at = ?, ended_at = ?
      WHERE id = ?
    `).bind(
      status,
      stopReason || null,
      nextFlowId || null,
      now,
      status !== 'active' ? now : null,
      flowRunId
    ).run();

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
        AND t.status = 'DONE'
        AND tf.status = 'PENDING'
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
        AND t.status = 'PENDING'
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
 * Get all steps for a flow (for caching)
 * @param db D1Database instance
 * @param flow_id Flow ID
 * @returns Array of flow steps
 */
export async function getFlowSteps(db: D1Database, flow_id: string): Promise<StepData[]> {
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
        fs.requires_task
      FROM flow_steps fs
      WHERE fs.flow_id = ?
      ORDER BY fs.order_index
    `;
    
    const result = await db.prepare(query).bind(flow_id).all();
    
    if (!result.results || result.results.length === 0) {
      console.log(`[DATABASE] No steps found for flow ${flow_id}`);
      return [];
    }
    
    console.log(`[DATABASE] Loaded ${result.results.length} steps for flow ${flow_id}`);
    return result.results as StepData[];
  } catch (error: any) {
    console.error(`[DATABASE] Error getting flow steps for ${flow_id}: ${error.message}`);
    return [];
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
    // Query tasks table (new schema)
    // For consistent ordering with mixed data types, use a simpler approach:
    // Get all pending tasks and sort in JavaScript where we have better date parsing
    const query = `
      SELECT id, title, description, payload, created_at
      FROM tasks
      WHERE flow_id = ? AND status != 'DONE'
    `;
    
    const results = await db.prepare(query).bind(flow_id).all();
    
    if (!results || !results.results || results.results.length === 0) {
      return null;
    }
    
    // Sort by created_at, handling mixed data types
    const sortedTasks = results.results.sort((a, b) => {
      const timeA = parseTime(a.created_at);
      const timeB = parseTime(b.created_at);
      return timeA - timeB;
    });
    
    const result = sortedTasks[0];
    
    if (!result) {
      return null;
    }
    
    const resultObj = result as unknown as { id: string; title: string; description: string | null; payload: string | null };
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
    
    return { id: resultObj.id, title: resultObj.title, description, payload: resultObj.payload };
  } catch (error: any) {
    console.error(`[DATABASE] Error getting first pending task for flow ${flow_id}: ${error.message}`);
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
        fs.retryable
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
            AND tes.status = 'DONE'
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
      SELECT fsc.condition_type, fsc.condition_value, fsc.condition_operator, fsc.next_step
      FROM flow_step_conditions fsc
      WHERE fsc.flow_step_id = ?
      ORDER BY fsc.created_at
    `;
    
    const conditionsResult = await db.prepare(conditionsQuery).bind(current_step_id).all();
    
    if (conditionsResult.results && conditionsResult.results.length > 0) {
      console.log(`[DATABASE] Found ${conditionsResult.results.length} conditions for step ${current_step_id}`);
      
      // Check each condition against the response
      for (const condition of conditionsResult.results) {
        const { condition_type, condition_value, condition_operator, next_step } = condition;
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
          console.log(`[DATABASE] Condition met: ${condition_type} "${condition_value}" -> next_step: ${next_step}`);
          
          // Get the step details for the next step
          const nextStepQuery = `
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
              fs.retryable
            FROM flow_steps fs
            WHERE fs.flow_id = ? AND fs.order_index = ?
            LIMIT 1
          `;
          
          const nextStepResult = await db.prepare(nextStepQuery).bind(flow_id, next_step).first();
          
          if (nextStepResult) {
            console.log(`[DATABASE] Found next step: ${nextStepResult.title} (order_index: ${next_step})`);
            return nextStepResult as unknown as StepData;
          } else {
            console.warn(`[DATABASE] No step found at order_index ${next_step} for flow ${flow_id}`);
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
        fs.default_next_step
      FROM flow_steps fs
      WHERE fs.id = ?
      LIMIT 1
    `;
    
    const currentStepResult = await db.prepare(defaultStepQuery).bind(current_step_id).first();
    
    if (currentStepResult && currentStepResult.default_next_step) {
      console.log(`[DATABASE] Using default_next_step: ${currentStepResult.default_next_step} for step ${current_step_id}`);
      
      // Get the step at default_next_step order_index
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
          fs.retryable
        FROM flow_steps fs
        WHERE fs.flow_id = ? AND fs.order_index = ?
        LIMIT 1
      `;
      
      const defaultStepResult = await db.prepare(defaultStepQuery).bind(flow_id, currentStepResult.default_next_step).first();
      
      if (defaultStepResult) {
        console.log(`[DATABASE] Found default next step: ${defaultStepResult.title} (order_index: ${currentStepResult.default_next_step})`);
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
          fs.retryable
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
 * @param status New status ('PENDING' or 'DONE')
 * @returns Promise with success status
 */
export async function updateTaskStatus(
  db: D1Database,
  task_id: string,
  status: 'PENDING' | 'DONE'
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
      'PENDING',
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
      SET finished_at = ?, status = 'DONE', updated_at = ?
      WHERE id = ? AND status = 'PENDING'
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
export async function getFlowDefinition(
  db: D1Database,
  flow_id: string
): Promise<{
  id: string;
  name: string;
  description: string;
  deepseek_system: string;
  max_iterations: number;
  repository: string;
  branch: string;
} | null> {
  try {
    // First try the flows table with repo column
    try {
      const result = await db.prepare(`
        SELECT id, name, first_prompt as description, deepseek_system, max_iterations, repo as repository, branch
        FROM flows
        WHERE id = ?
      `).bind(flow_id).first();

      if (result) {
        return result as any;
      }
    } catch (firstError: any) {
      // flows table might not exist, that's OK
      console.log(`[DATABASE] flows table not available or query failed: ${firstError.message}`);
    }

    // If not found in flows table, try flow_definitions table (if it exists)
    // Note: This is a fallback in case the table name is different
    try {
      const result2 = await db.prepare(`
        SELECT id, name, description, deepseek_system, max_iterations, repository, branch
        FROM flow_definitions
        WHERE id = ?
      `).bind(flow_id).first();

      if (result2) {
        console.log(`[DATABASE] Found flow definition in flow_definitions table for ${flow_id}`);
        return result2 as any;
      }
    } catch (innerError: any) {
      // flow_definitions table might not exist, that's OK
      console.log(`[DATABASE] flow_definitions table not available or query failed: ${innerError.message}`);
    }

    return null;
  } catch (error: any) {
    console.error(`[DATABASE] Error getting flow definition: ${error.message}`);
    return null;
  }
}

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