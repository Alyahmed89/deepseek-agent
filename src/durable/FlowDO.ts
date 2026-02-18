// Ultra-minimal Flow Durable Object
import { createOpenHandsConversation, injectMessageToOpenHands } from '../services/openhands';

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
    }>;
    state: 'LOADING' | 'SENDING_STEP' | 'WAITING_RESPONSE' | 'DONE';
    created_at: number;
    openhands_conversation_id?: string;
    repository?: string;
    branch?: string;
  } | null = null;
  
  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
    
    // Load from storage
    state.blockConcurrencyWhile(async () => {
      this.flow = await state.storage.get('flow');
    });
  }
  
  // Alarm handler
  async alarm(): Promise<void> {
    if (!this.flow) return;
    
    console.log(`[DO:${this.state.id}] Alarm: state=${this.flow.state}, step=${this.flow.current_step + 1}/${this.flow.steps.length}`);
    
    if (this.flow.state === 'SENDING_STEP') {
      await this.sendCurrentStep();
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
      const initialMessage = `Execute step 1: ${firstStep.title}\n\n${firstStep.instructions}`;
      
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
        branch: flowDefinition.branch || 'main'
      };
      
      await this.state.storage.put('flow', this.flow);
      
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
      const result = await this.env.FLOW_RUNS_DB.prepare(
        'SELECT id as step_id, title, instructions, order_index FROM flow_steps WHERE flow_id = ? ORDER BY order_index'
      ).bind(flowId).all();
      
      return result.results || [];
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Error loading steps: ${error.message}`);
      return [];
    }
  }
  
  // Send current step to OpenHands
  private async sendCurrentStep(): Promise<void> {
    if (!this.flow) return;
    
    const stepIndex = this.flow.current_step;
    if (stepIndex >= this.flow.steps.length) {
      this.flow.state = 'DONE';
      await this.state.storage.put('flow', this.flow);
      console.log(`[DO:${this.state.id}] All steps completed`);
      return;
    }
    
    const step = this.flow.steps[stepIndex];
    console.log(`[DO:${this.state.id}] Sending step ${stepIndex + 1}: ${step.title}`);
    
    // Send step to OpenHands
    if (this.flow.openhands_conversation_id) {
      const message = `Execute step ${stepIndex + 1}: ${step.title}\n\n${step.instructions}`;
      
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
    
    console.log(`[DO:${this.state.id}] Waiting for OpenHands response...`);
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
            console.log(`[DO:${this.state.id}] Conditional branching selected step at index ${nextStepIndex}: ${nextStep.title}`);
          }
        } catch (error: any) {
          console.error(`[DO:${this.state.id}] Error in conditional branching: ${error.message}`);
          // Continue with sequential step
        }
      }
      
      // Update current step index
      this.flow.current_step = nextStepIndex;
      
      // Clear task data for next step
      this.flow.current_task_id = undefined;
      this.flow.current_task_title = undefined;
      this.flow.current_task_description = undefined;
      
      // Check if done
      if (this.flow.current_step >= this.flow.steps.length) {
        this.flow.state = 'DONE';
        console.log(`[DO:${this.state.id}] All ${this.flow.steps.length} steps completed`);
      } else {
        // Check if next step requires task fetching
        const nextStep = this.flow.steps[this.flow.current_step];
        if (nextStep && (nextStep.requires_task || nextStep.task_id)) {
          this.flow.state = 'FETCHING_TASK';
          console.log(`[DO:${this.state.id}] Next step requires task fetching`);
        } else {
          this.flow.state = 'SENDING_STEP';
        }
        
        // Schedule alarm for next action
        await this.state.storage.setAlarm(Date.now() + 1000);
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
}