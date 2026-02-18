// Ultra-minimal Flow Durable Object
import { createOpenHandsConversation, injectMessageToOpenHands } from '../services/openhands';
import { ALARM_DELAY_INIT, ALARM_DELAY_WAITING, ALARM_DELAY_ACTIVE, MIN_POLL_INTERVAL } from '../constants';

interface FlowDOEnv {
  FLOW_RUNS_DB: D1Database;
  OPENHANDS_API_URL: string;
}

export class ConversationOrchestratorDO_2026A {
  state: DurableObjectState;
  env: FlowDOEnv;
  
  private flow: {
    id: string;
    flow_id: string;
    current_step: number;
    steps: Array<{
      step_id: string;
      title: string;
      instructions: string;
      order_index: number;
      task_id?: string;
      requires_task?: boolean;
    }>;
    state: 'LOADING' | 'SENDING_STEP' | 'WAITING_RESPONSE' | 'DONE';
    created_at: number;
    openhands_conversation_id?: string;
    repository?: string;
    branch?: string;
    last_step_response?: string;
    current_task_id?: string;
    current_task_title?: string;
    current_task_description?: string;
  } | null = null;
  
  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
    
    // Load from storage
    state.blockConcurrencyWhile(async () => {
      this.flow = await state.storage.get('flow');
    });
  }
  
  // Alarm handler (kept for compatibility but no longer schedules new alarms)
  async alarm(): Promise<void> {
    try {
      if (!this.flow) {
        console.log(`[DO:${this.state.id}] Alarm fired but no flow state`);
        return;
      }
      
      console.log(`[DO:${this.state.id}] Alarm: state=${this.flow.state}, step=${this.flow.current_step + 1}/${this.flow.steps.length}`);
      
      if (this.flow.state === 'SENDING_STEP' || this.flow.state === 'FETCHING_TASK') {
        // For FETCHING_TASK, just send the step (simplified)
        await this.sendCurrentStep();
      } else if (this.flow.state === 'WAITING_RESPONSE') {
        // Webhook-only mode: No polling, only webhook responses
        // await this.pollOpenHandsForResponse();
      } else {
        console.log(`[DO:${this.state.id}] Alarm fired but flow in unexpected state: ${this.flow.state}`);
      }
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Alarm handler error: ${error.message}`);
      // Don't schedule another alarm - use on-demand polling instead
    }
  }
  
  // HTTP endpoints
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    
    if (path === '/init' && request.method === 'POST') {
      return this.handleInit(request);
    }
    
    if (path === '/openhands-response' && request.method === 'POST') {
      return this.handleOpenHandsResponse(request);
    }
    
    if (path === '/status' && request.method === 'GET') {
      return this.handleGetStatus();
    }
    
    if (path === '/trigger-api-call' && request.method === 'POST') {
      return this.handleTriggerApiCall(request);
    }
    
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  }
  
  // Initialize flow
  private async handleInit(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { flow_id: string };
      const { flow_id } = body;
      
      console.log(`[DO:${this.state.id}] Initializing flow: ${flow_id}`);
      
      // Load flow definition
      const flowDefinition = await this.loadFlowDefinition(flow_id);
      if (!flowDefinition) {
        return new Response(JSON.stringify({ error: `Flow definition not found: ${flow_id}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Load steps from database
      const steps = await this.loadFlowSteps(flow_id);
      
      if (!steps || steps.length === 0) {
        return new Response(JSON.stringify({ error: `No steps found for flow: ${flow_id}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Create OpenHands conversation with first step as initial message
      console.log(`[DO:${this.state.id}] Creating OpenHands conversation for repository: ${flowDefinition.repository}, branch: ${flowDefinition.branch || 'main'}`);
      
      // Get first step to use as initial message
      const firstStep = steps[0];
      if (!firstStep) {
        console.error(`[DO:${this.state.id}] No steps found for flow ${flow_id}`);
        return new Response(JSON.stringify({ error: 'No steps found for flow' }), { status: 400 });
      }
      const firstStepTitle = firstStep.title || 'Step 1';
      const instructions = firstStep.instructions || 'No instructions provided';
      let initialMessage = `Execute step 1: ${firstStepTitle}`;
      
      // Variables to store task data for the flow object
      let currentTaskId: string | undefined;
      let currentTaskTitle: string | undefined;
      let currentTaskDescription: string | undefined;
      
      // Check for task injection for first step
      if (firstStep.requires_task && flow_id && this.env.FLOW_RUNS_DB) {
        console.log(`[DO:${this.state.id}] First step requires dynamic task, fetching first pending task for flow: ${flow_id}`);
        try {
          const { getFirstPendingTask } = await import('../services/database');
          const pendingTask = await getFirstPendingTask(this.env.FLOW_RUNS_DB, flow_id);
          if (pendingTask) {
            initialMessage += `\n\n=== TASK ===`;
            initialMessage += `\nTitle: ${pendingTask.title}`;
            if (pendingTask.description) {
              initialMessage += `\nDescription: ${pendingTask.description}`;
            }
            initialMessage += `\n=== END TASK ===\n`;
            
            // Store task data for the flow object
            currentTaskId = pendingTask.id;
            currentTaskTitle = pendingTask.title;
            currentTaskDescription = pendingTask.description || undefined;
            
            console.log(`[DO:${this.state.id}] Injected task for first step: ${pendingTask.title}`);
          } else {
            console.log(`[DO:${this.state.id}] No pending tasks found for flow: ${flow_id}`);
          }
        } catch (error: any) {
          console.error(`[DO:${this.state.id}] Error fetching pending task for first step: ${error.message}`);
        }
      } else if (firstStep.task_id && this.env.FLOW_RUNS_DB) {
        console.log(`[DO:${this.state.id}] First step has static task_id: ${firstStep.task_id}`);
        try {
          const { getTaskData } = await import('../services/database');
          const taskData = await getTaskData(this.env.FLOW_RUNS_DB, firstStep.task_id);
          if (taskData) {
            initialMessage += `\n\n=== TASK ===`;
            initialMessage += `\nTitle: ${taskData.title}`;
            if (taskData.description) {
              initialMessage += `\nDescription: ${taskData.description}`;
            }
            initialMessage += `\n=== END TASK ===\n`;
            
            // Store task data for the flow object
            currentTaskId = firstStep.task_id;
            currentTaskTitle = taskData.title;
            currentTaskDescription = taskData.description || undefined;
            
            console.log(`[DO:${this.state.id}] Injected task for first step: ${taskData.title}`);
          }
        } catch (error: any) {
          console.error(`[DO:${this.state.id}] Error fetching task data for first step: ${error.message}`);
        }
      }
      
      // Add step instructions
      initialMessage += `\n\n${instructions}`;
      
      const openhandsResult = await createOpenHandsConversation(
        this.env.OPENHANDS_API_URL,
        initialMessage,
        flowDefinition.repository,
        flowDefinition.branch || 'main'
      );
      
      if (!openhandsResult.success) {
        console.error(`[DO:${this.state.id}] Failed to create OpenHands conversation: ${openhandsResult.error}`);
        return new Response(JSON.stringify({ error: `Failed to create OpenHands conversation: ${openhandsResult.error}` }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Initialize flow - step 1 already sent as initial message
      this.flow = {
        id: this.state.id.toString(),
        flow_id,
        current_step: 0,
        steps,
        state: 'WAITING_RESPONSE', // Already sent step 1 as initial message
        created_at: Date.now(),
        openhands_conversation_id: openhandsResult.conversationId,
        repository: flowDefinition.repository,
        branch: flowDefinition.branch || 'main',
        current_task_id: currentTaskId,
        current_task_title: currentTaskTitle,
        current_task_description: currentTaskDescription
      };
      
      await this.state.storage.put('flow', this.flow);
      
      console.log(`[DO:${this.state.id}] Flow initialized, waiting for OpenHands response... (polling on status check)`);
      
      // Save flow run to database
      if (this.env.FLOW_RUNS_DB) {
        try {
          const { saveFlowRun, generateFlowRunId } = await import('../services/database');
          const flowRunId = generateFlowRunId();
          const now = Date.now();
          
          const flowRunData = {
            id: flowRunId,
            conversation_id: this.state.id.toString(),
            initial_prompt: initialMessage,
            deepseek_system: undefined,
            repository: flowDefinition.repository,
            branch: flowDefinition.branch || 'main',
            max_iterations: flowDefinition.max_iterations || 500,
            actual_iterations: 0,
            status: 'active' as const,
            stop_reason: undefined,
            prompts_and_responses: JSON.stringify([{
              prompt: initialMessage,
              response: null,
              timestamp: now
            }]),
            created_at: now,
            updated_at: now,
            ended_at: undefined,
            next_flow_id: undefined,
            task_type: undefined,
            success_score: undefined,
            quality_metrics: undefined,
            deployment_id: undefined,
            improvement_suggestions: undefined
          };
          
          const saveResult = await saveFlowRun(this.env.FLOW_RUNS_DB, flowRunData);
          if (!saveResult.success) {
            console.error(`[DO:${this.state.id}] Failed to save flow run to database: ${saveResult.error}`);
          } else {
            console.log(`[DO:${this.state.id}] Saved flow run to database with ID: ${flowRunId}`);
          }
        } catch (error: any) {
          console.error(`[DO:${this.state.id}] Error saving flow run to database: ${error.message}`);
        }
      } else {
        console.warn(`[DO:${this.state.id}] No FLOW_RUNS_DB available, skipping database save`);
      }
      
      // No need to schedule alarm - already waiting for response to step 1
      
      console.log(`[DO:${this.state.id}] Flow initialized with ${steps.length} steps, OpenHands conversation: ${openhandsResult.conversationId}`);
      
      return new Response(JSON.stringify({
        success: true,
        flow_id,
        conversation_id: openhandsResult.conversationId,
        steps_count: steps.length,
        message: 'Flow execution started',
        endpoints: {
          status: `/status/${this.state.id.toString()}`,
          response: `/response/${this.state.id.toString()}`,
          trigger: `/trigger-api-call/${this.state.id.toString()}`
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Init error: ${error.message}`);
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  }
  
  // Load flow definition from database
  private async loadFlowDefinition(flowId: string): Promise<any> {
    if (!this.env.FLOW_RUNS_DB) {
      console.log(`[DO:${this.state.id}] No database available`);
      return null;
    }
    
    try {
      const result = await this.env.FLOW_RUNS_DB.prepare(
        'SELECT name, repository, branch, max_iterations FROM flow_definitions WHERE id = ?'
      ).bind(flowId).first();
      
      return result;
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Error loading flow definition: ${error.message}`);
      return null;
    }
  }

  // Load steps from database
  private async loadFlowSteps(flowId: string): Promise<any[]> {
    if (!this.env.FLOW_RUNS_DB) {
      console.log(`[DO:${this.state.id}] No database available`);
      return [];
    }
    
    try {
      // Try with new column names first (title, instructions, order_index, task_id, requires_task)
      const result = await this.env.FLOW_RUNS_DB.prepare(
        'SELECT id as step_id, step_key, title, instructions, order_index, step_type, default_next_step, task_id, requires_task FROM flow_steps WHERE flow_id = ? ORDER BY order_index'
      ).bind(flowId).all();
      
      console.log(`[DO:${this.state.id}] Loaded ${result.results?.length || 0} steps with new schema for flow ${flowId}`);
      if (result.results && result.results.length > 0) {
        console.log(`[DO:${this.state.id}] First step: ${JSON.stringify(result.results[0])}`);
        console.log(`[DO:${this.state.id}] All step order_index values: ${result.results.map((s: any) => s.order_index).join(', ')}`);
        return result.results;
      } else {
        console.log(`[DO:${this.state.id}] No steps found with new schema for flow ${flowId}`);
      }
      
      return [];
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Error loading steps with new schema: ${error.message}`);
      
      // If new schema fails (columns don't exist), try old schema
      try {
        const oldResult = await this.env.FLOW_RUNS_DB.prepare(
          'SELECT id as step_id, prompt as instructions, step_number as order_index FROM flow_steps WHERE flow_id = ? ORDER BY step_number'
        ).bind(flowId).all();
        
        console.log(`[DO:${this.state.id}] Loaded ${oldResult.results?.length || 0} steps with old schema for flow ${flowId}`);
        if (oldResult.results && oldResult.results.length > 0) {
          console.log(`[DO:${this.state.id}] All step step_number values: ${oldResult.results.map((s: any) => s.order_index).join(', ')}`);
        }
        return oldResult.results || [];
      } catch (oldError: any) {
        console.error(`[DO:${this.state.id}] Error loading steps with old schema: ${oldError.message}`);
        return [];
      }
    }
  }
  
  // Send current step to OpenHands
  private async sendCurrentStep(): Promise<void> {
    if (!this.flow) {
      console.log(`[DO:${this.state.id}] sendCurrentStep: No flow`);
      return;
    }
    
    console.log(`[DO:${this.state.id}] sendCurrentStep: state=${this.flow.state}, current_step=${this.flow.current_step}, steps.length=${this.flow.steps.length}`);
    
    const stepIndex = this.flow.current_step;
    if (stepIndex >= this.flow.steps.length) {
      this.flow.state = 'DONE';
      await this.state.storage.put('flow', this.flow);
      console.log(`[DO:${this.state.id}] All steps completed`);
      return;
    }
    
    const step = this.flow.steps[stepIndex];
    const stepTitle = step.title || `Step ${stepIndex + 1}`;
    console.log(`[DO:${this.state.id}] Sending step ${stepIndex + 1}: ${stepTitle}`);
    
    // Send step to OpenHands
    if (this.flow.openhands_conversation_id) {
      const instructions = step.instructions || 'No instructions provided';
      let message = `Execute step ${stepIndex + 1}: ${stepTitle}`;
      
      // Check for task injection
      if (step.requires_task && this.flow.flow_id && this.env.FLOW_RUNS_DB) {
        console.log(`[DO:${this.state.id}] Step requires dynamic task, fetching first pending task for flow: ${this.flow.flow_id}`);
        try {
          const { getFirstPendingTask } = await import('../services/database');
          const pendingTask = await getFirstPendingTask(this.env.FLOW_RUNS_DB, this.flow.flow_id);
          if (pendingTask) {
            message += `\n\n=== TASK ===`;
            message += `\nTitle: ${pendingTask.title}`;
            if (pendingTask.description) {
              message += `\nDescription: ${pendingTask.description}`;
            }
            message += `\n=== END TASK ===\n`;
            
            // Store task data for trigger handling
            this.flow.current_task_id = pendingTask.id;
            this.flow.current_task_title = pendingTask.title;
            this.flow.current_task_description = pendingTask.description || undefined;
            
            console.log(`[DO:${this.state.id}] Injected task: ${pendingTask.title}`);
          } else {
            console.log(`[DO:${this.state.id}] No pending tasks found for flow: ${this.flow.flow_id}`);
          }
        } catch (error: any) {
          console.error(`[DO:${this.state.id}] Error fetching pending task: ${error.message}`);
        }
      } else if (step.task_id && this.env.FLOW_RUNS_DB) {
        console.log(`[DO:${this.state.id}] Step has static task_id: ${step.task_id}`);
        try {
          const { getTaskData } = await import('../services/database');
          const taskData = await getTaskData(this.env.FLOW_RUNS_DB, step.task_id);
          if (taskData) {
            message += `\n\n=== TASK ===`;
            message += `\nTitle: ${taskData.title}`;
            if (taskData.description) {
              message += `\nDescription: ${taskData.description}`;
            }
            message += `\n=== END TASK ===\n`;
            
            // Store task data for trigger handling
            this.flow.current_task_id = step.task_id;
            this.flow.current_task_title = taskData.title;
            this.flow.current_task_description = taskData.description || undefined;
            
            console.log(`[DO:${this.state.id}] Injected task: ${taskData.title}`);
          }
        } catch (error: any) {
          console.error(`[DO:${this.state.id}] Error fetching task data: ${error.message}`);
        }
      }
      
      // Add step instructions
      message += `\n\n${instructions}`;
      
      const injectResult = await injectMessageToOpenHands(
        this.env.OPENHANDS_API_URL,
        this.flow.openhands_conversation_id,
        message
      );
      
      if (!injectResult.success) {
        console.error(`[DO:${this.state.id}] Failed to send step to OpenHands: ${injectResult.error}`);
        // Still set state to waiting for response, but log error
      }
      
      console.log(`[DO:${this.state.id}] Step sent to OpenHands conversation: ${this.flow.openhands_conversation_id}`);
    } else {
      console.error(`[DO:${this.state.id}] No OpenHands conversation ID available`);
    }
    
    // Set state to waiting for response
    this.flow.state = 'WAITING_RESPONSE';
    await this.state.storage.put('flow', this.flow);
    
    console.log(`[DO:${this.state.id}] Waiting for OpenHands response... (polling on status check)`);
  }
  
  // Handle OpenHands response with conditional branching
  private async handleOpenHandsResponse(request: Request): Promise<Response> {
    if (!this.flow) {
      return new Response(JSON.stringify({ error: 'Flow not initialized' }), { status: 404 });
    }
    
    try {
      const body = await request.json() as { response: string };
      const responseText = body.response;
      
      console.log(`[DO:${this.state.id}] Received OpenHands response for step ${this.flow.current_step + 1}`);
      console.log(`[DO:${this.state.id}] Response (${responseText.length} chars): ${responseText.substring(0, 100)}...`);
      
      // Store response for conditional branching
      this.flow.last_step_response = responseText;
      
      // Check for triggers in response
      await this.checkForTriggers(responseText);
      
      // Get next step based on conditional branching
      const currentStep = this.flow.steps[this.flow.current_step];
      let nextStepIndex = this.flow.current_step + 1; // Default: next sequential step
      
      console.log(`[DO:${this.state.id}] Current step index: ${this.flow.current_step}, steps length: ${this.flow.steps.length}`);
      if (this.flow.steps.length <= 1) {
        console.warn(`[DO:${this.state.id}] WARNING: Only ${this.flow.steps.length} step(s) loaded! Flow will end after first step.`);
      }
      if (currentStep) {
        console.log(`[DO:${this.state.id}] Current step ID: ${currentStep.step_id}, title: ${currentStep.title}`);
      }
      
      if (currentStep && this.env.FLOW_RUNS_DB) {
        try {
          const { getNextStepBasedOnConditions } = await import('../services/database');
          const nextStep = await getNextStepBasedOnConditions(
            this.env.FLOW_RUNS_DB,
            this.flow.flow_id,
            currentStep.step_id,
            responseText
          );
          
          if (nextStep) {
            // Use the step's order_index (1-based in DB, convert to 0-based)
            nextStepIndex = nextStep.order_index - 1;
            console.log(`[DO:${this.state.id}] Conditional branching selected step at index ${nextStepIndex}: ${nextStep.title} (order_index: ${nextStep.order_index})`);
          } else {
            console.log(`[DO:${this.state.id}] No conditional branching, using sequential step ${nextStepIndex + 1}`);
          }
        } catch (error: any) {
          console.error(`[DO:${this.state.id}] Error in conditional branching: ${error.message}`);
          // Continue with sequential step
        }
      }
      
      // Update current step index
      this.flow.current_step = nextStepIndex;
      console.log(`[DO:${this.state.id}] Updated current_step to ${nextStepIndex}`);
      
      // Clear task data for next step
      this.flow.current_task_id = undefined;
      this.flow.current_task_title = undefined;
      this.flow.current_task_description = undefined;
      
      // Check if done
      console.log(`[DO:${this.state.id}] Checking if done: current_step=${this.flow.current_step}, steps.length=${this.flow.steps.length}`);
      if (this.flow.current_step >= this.flow.steps.length) {
        this.flow.state = 'DONE';
        console.log(`[DO:${this.state.id}] All ${this.flow.steps.length} steps completed`);
      } else {
        // Send next step IMMEDIATELY
        this.flow.state = 'SENDING_STEP';
        console.log(`[DO:${this.state.id}] Setting state to SENDING_STEP for step ${this.flow.current_step + 1}`);

        // Send next step immediately instead of waiting for alarm
        await this.sendCurrentStep();
      }
      
      await this.state.storage.put('flow', this.flow);
      
      return new Response(JSON.stringify({
        success: true,
        step_completed: this.flow.current_step - 1,
        total_steps: this.flow.steps.length,
        next_step: this.flow.state === 'DONE' ? null : this.flow.steps[this.flow.current_step],
        next_state: this.flow.state
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Response error: ${error.message}`);
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  }
  
  // Check for triggers in response text and make API calls
  private async checkForTriggers(responseText: string): Promise<void> {
    if (!this.flow) return;
    
    const triggers = [
      { 
        keyword: 'TASK COMPLETE', 
        action: async () => {
          console.log(`[DO:${this.state.id}] Trigger detected: TASK COMPLETE`);
          // Make API call to update task status
          if (this.flow?.current_task_id && this.env.FLOW_RUNS_DB) {
            try {
              const { updateTaskStatus } = await import('../services/database');
              await updateTaskStatus(
                this.env.FLOW_RUNS_DB,
                this.flow.current_task_id,
                'DONE'
              );
              console.log(`[DO:${this.state.id}] Updated task ${this.flow.current_task_id} to DONE`);
            } catch (error: any) {
              console.error(`[DO:${this.state.id}] Error updating task status: ${error.message}`);
            }
          }
        }
      },
      { 
        keyword: 'TASK FAILED', 
        action: async () => {
          console.log(`[DO:${this.state.id}] Trigger detected: TASK FAILED`);
          // Make API call to update task status
          if (this.flow?.current_task_id && this.env.FLOW_RUNS_DB) {
            try {
              const { updateTaskStatus } = await import('../services/database');
              await updateTaskStatus(
                this.env.FLOW_RUNS_DB,
                this.flow.current_task_id,
                'FAILED'
              );
              console.log(`[DO:${this.state.id}] Updated task ${this.flow.current_task_id} to FAILED`);
            } catch (error: any) {
              console.error(`[DO:${this.state.id}] Error updating task status: ${error.message}`);
            }
          }
        }
      },
      { 
        keyword: 'DEPLOYMENT COMPLETE', 
        action: async () => {
          console.log(`[DO:${this.state.id}] Trigger detected: DEPLOYMENT COMPLETE`);
          // TODO: Make Cloudflare API call for deployment
          // This would be a real API call to Cloudflare's API
        }
      }
    ];
    
    const lowerResponse = responseText.toLowerCase();
    
    for (const trigger of triggers) {
      if (lowerResponse.includes(trigger.keyword.toLowerCase())) {
        console.log(`[DO:${this.state.id}] Executing trigger action for: ${trigger.keyword}`);
        await trigger.action();
      }
    }
  }
  
  // Handle external trigger API calls
  private async handleTriggerApiCall(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { 
        trigger_type: string; 
        data?: any;
        flow_id?: string;
        step_id?: string;
      };
      
      console.log(`[DO:${this.state.id}] Received trigger API call: ${body.trigger_type}`);
      
      // Process different trigger types
      switch (body.trigger_type) {
        case 'MANUAL_TASK_COMPLETE':
          if (body.data?.task_id && this.env.FLOW_RUNS_DB) {
            const { updateTaskStatus } = await import('../services/database');
            await updateTaskStatus(
              this.env.FLOW_RUNS_DB,
              body.data.task_id,
              'DONE'
            );
            return new Response(JSON.stringify({
              success: true,
              message: `Task ${body.data.task_id} marked as DONE`
            }), { headers: { 'Content-Type': 'application/json' } });
          }
          break;
          
        case 'UPDATE_FLOW_STATUS':
          // Update flow status in database
          return new Response(JSON.stringify({
            success: true,
            message: 'Flow status update received'
          }), { headers: { 'Content-Type': 'application/json' } });
          
        default:
          return new Response(JSON.stringify({
            error: `Unknown trigger type: ${body.trigger_type}`
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Trigger processed'
      }), { headers: { 'Content-Type': 'application/json' } });
      
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Trigger API error: ${error.message}`);
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  }
  
  // Get status
  private async handleGetStatus(): Promise<Response> {
    if (!this.flow) {
      return new Response(JSON.stringify({ error: 'Flow not initialized' }), { status: 404 });
    }
    
    // Webhook-only mode: No polling, only webhook responses
    // if (this.flow.state === 'WAITING_RESPONSE') {
    //   console.log(`[DO:${this.state.id}] Status check for WAITING_RESPONSE flow (polling disabled, webhook-only mode)`);
    // }
    
    return new Response(JSON.stringify({
      id: this.flow.id,
      flow_id: this.flow.flow_id,
      state: this.flow.state,
      current_step: this.flow.current_step,
      total_steps: this.flow.steps.length,
      current_step_info: this.flow.steps[this.flow.current_step] || null,
      current_task_id: this.flow.current_task_id,
      current_task_title: this.flow.current_task_title,
      last_step_response_length: this.flow.last_step_response?.length || 0,
      created_at: this.flow.created_at
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Poll OpenHands for responses when in WAITING_RESPONSE state
  private async pollOpenHandsForResponse(): Promise<void> {
    if (!this.flow || !this.flow.openhands_conversation_id) {
      console.error(`[DO:${this.state.id}] Cannot poll: no flow or conversation ID`);
      return;
    }
    
    console.log(`[DO:${this.state.id}] Polling OpenHands for response to step ${this.flow.current_step + 1}`);
    
    try {
      console.log(`[DO:${this.state.id}] Calling getOpenHandsConversation with API URL: ${this.env.OPENHANDS_API_URL}, conversation ID: ${this.flow.openhands_conversation_id}`);
      const { getOpenHandsConversation } = await import('../services/openhands');
      const result = await getOpenHandsConversation(
        this.env.OPENHANDS_API_URL,
        this.flow.openhands_conversation_id,
        true // bypassCache for flow execution
      );
      
      if (!result.success) {
        console.error(`[DO:${this.state.id}] Failed to poll OpenHands: ${result.error}`);
        // Don't schedule alarm - will check again on next status request
        return;
      }
      
      // Look for assistant responses in events
      const events = result.events || [];
      console.log(`[DO:${this.state.id}] Found ${events.length} events in OpenHands conversation`);
      
      // Find the most recent assistant response
      // Events are returned newest first (reverse=true in getOpenHandsConversation)
      let latestAssistantResponse: string | null = null;
      let responseFound = false;
      let foundAgentWaiting = false;
      
      // First pass: look for actual response text
      for (const event of events) {
        if (event.source !== 'user') {
          const responseText = event.content || event.message || event.args?.content || '';
          const agentState = event.agent_state || event.args?.agent_state;
          const isAgentWaiting = agentState === 'awaiting_user_input';
          
          if (responseText && responseText !== this.flow.last_step_response) {
            // Found actual response text
            latestAssistantResponse = responseText;
            responseFound = true;
            foundAgentWaiting = isAgentWaiting;
            console.log(`[DO:${this.state.id}] Found ${event.source} response with text (${responseText.length} chars), agent_state=${agentState}`);
            break;
          } else if (isAgentWaiting && !responseFound) {
            // Agent is waiting for user input (step completed)
            // Store this but continue looking for actual response text
            latestAssistantResponse = 'Agent completed step and is waiting for user input';
            responseFound = true;
            foundAgentWaiting = true;
            console.log(`[DO:${this.state.id}] Found agent_state: awaiting_user_input (step completed)`);
            // Don't break - continue looking for actual response text
          }
        }
      }
      
      // If we found agent waiting but no response text, use the placeholder
      if (responseFound && foundAgentWaiting && (!latestAssistantResponse || latestAssistantResponse === 'Agent completed step and is waiting for user input')) {
        // Already set correctly
      }
      
      if (responseFound && latestAssistantResponse) {
        // Process the response
        console.log(`[DO:${this.state.id}] Processing OpenHands response for step ${this.flow.current_step + 1}`);
        
        // Store response
        this.flow.last_step_response = latestAssistantResponse;
        
        // Check for triggers in response
        await this.checkForTriggers(latestAssistantResponse);
        
        // Get next step based on conditional branching
        const currentStep = this.flow.steps[this.flow.current_step];
        let nextStepIndex = this.flow.current_step + 1; // Default: next sequential step
        
        console.log(`[DO:${this.state.id}] Current step index: ${this.flow.current_step}, step object: ${JSON.stringify(currentStep)}`);
        
        if (currentStep && this.env.FLOW_RUNS_DB) {
          try {
            const { getNextStepBasedOnConditions } = await import('../services/database');
            // Use step_id (aliased from id in loadFlowSteps) or fall back to id
            const stepId = currentStep.step_id || currentStep.id;
            console.log(`[DO:${this.state.id}] Calling getNextStepBasedOnConditions with step_id: ${stepId}, flow_id: ${this.flow.flow_id}`);
            
            const nextStep = await getNextStepBasedOnConditions(
              this.env.FLOW_RUNS_DB,
              this.flow.flow_id,
              stepId,
              latestAssistantResponse
            );
            
            if (nextStep) {
              // Use the step's order_index (1-based in DB, convert to 0-based)
              nextStepIndex = nextStep.order_index - 1;
              console.log(`[DO:${this.state.id}] Conditional branching selected step at index ${nextStepIndex}: ${nextStep.title} (order_index: ${nextStep.order_index})`);
            } else {
              console.log(`[DO:${this.state.id}] No conditional branching, using sequential step ${nextStepIndex + 1}`);
            }
          } catch (error: any) {
            console.error(`[DO:${this.state.id}] Error in conditional branching: ${error.message}`);
            console.error(`[DO:${this.state.id}] Error stack: ${error.stack}`);
            // Continue with sequential step
          }
        }
        
        // Update current step index
        this.flow.current_step = nextStepIndex;
        console.log(`[DO:${this.state.id}] Updated current_step to ${nextStepIndex}`);
        
        // Clear task data for next step
        this.flow.current_task_id = undefined;
        this.flow.current_task_title = undefined;
        this.flow.current_task_description = undefined;
        
        // Check if done
        console.log(`[DO:${this.state.id}] Checking if done: current_step=${this.flow.current_step}, steps.length=${this.flow.steps.length}`);
        if (this.flow.current_step >= this.flow.steps.length) {
          this.flow.state = 'DONE';
          console.log(`[DO:${this.state.id}] All ${this.flow.steps.length} steps completed`);
        } else {
          // Send next step IMMEDIATELY
          this.flow.state = 'SENDING_STEP';
          console.log(`[DO:${this.state.id}] Setting state to SENDING_STEP for step ${this.flow.current_step + 1}`);
          
          // Send next step immediately instead of waiting for alarm
          await this.sendCurrentStep();
        }
        
        await this.state.storage.put('flow', this.flow);
        
      } else {
        // No response yet, will check again on next status request
        console.log(`[DO:${this.state.id}] No new assistant response found. Will check again on next status request.`);
      }
      
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Error polling OpenHands: ${error.message}`);
      // Don't schedule alarm - will check again on next status request
    }
  }
}