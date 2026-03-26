// Step Resolver for Dynamic API Data Fetching
// ============================================================================

import { StepData } from '../types';

// Backward compatibility wrapper for step instructions
export async function resolveStepInstructions(
  step: StepData,
  db: D1Database | null,
  env: Record<string, string>,
  context: {
    flow_id?: string;
    execution_id?: string;
    step_id?: string;
    previous_step_responses?: Record<string, any>;
    inputs?: Record<string, any>;
  }
): Promise<{
  instructions: string;
  variables?: Record<string, any>;
  api_responses?: Record<string, any>;
  task_data?: {
    title?: string;
    description?: string;
    payload?: any;
  };
}> {
  
  // Simplified step resolver - just return the step instructions
  return {
    instructions: step.instructions || '',
    variables: {},
    api_responses: {},
    task_data: undefined
  };
}
