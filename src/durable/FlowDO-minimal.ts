// Minimal Flow Durable Object
export class FlowDO {
  state: DurableObjectState;
  env: any;
  
  // Conversation state
  private conversation: {
    id: string;
    flow_id: string;
    state: 'INIT' | 'WAITING_OPENHANDS' | 'PROCESSING_RESPONSE' | 'DONE';
    iteration: number;
    max_iterations: number;
    current_step_index: number;
    steps: Array<{
      step_id: string;
      title: string;
      instructions: string;
      order_index: number;
    }>;
    messages: Array<{role: string; content: string}>;
    created_at: number;
    updated_at: number;
  } | null = null;
  
  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
    
    // Load conversation from storage
    state.blockConcurrencyWhile(async () => {
      this.conversation = await state.storage.get('conversation');
    });
  }
  
  // Alarm handler
  async alarm(): Promise<void> {
    console.log(`[DO:${this.state.id}] Alarm triggered`);
    await this.handleAlarm();
  }
  
  // HTTP endpoints
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    
    if (path === '/initialize-flow' && request.method === 'POST') {
      return this.handleInitializeFlow(request);
    }
    
    if (path === '/get-state' && request.method === 'GET') {
      return this.handleGetState();
    }
    
    if (path === '/openhands-response' && request.method === 'POST') {
      return this.handleOpenHandsResponse(request);
    }
    
    return new Response(JSON.stringify({
      error: 'Not found',
      available_endpoints: ['POST /initialize-flow', 'GET /get-state', 'POST /openhands-response']
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Initialize flow execution
  private async handleInitializeFlow(request: Request): Promise<Response> {
    try {
      const body = await request.json() as {
        flow_id: string;
        initial_user_prompt?: string;
        max_iterations?: number;
      };
      
      const { flow_id, initial_user_prompt, max_iterations } = body;
      
      if (!flow_id) {
        return new Response(JSON.stringify({ error: 'Need flow_id' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      console.log(`[DO:${this.state.id}] Initializing flow: ${flow_id}`);
      
      // Load flow steps from database
      const steps = await this.loadFlowSteps(flow_id);
      
      if (!steps || steps.length === 0) {
        return new Response(JSON.stringify({ 
          error: `No steps found for flow: ${flow_id}` 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Initialize conversation
      this.conversation = {
        id: this.state.id.toString(),
        flow_id,
        state: 'INIT',
        iteration: 0,
        max_iterations: max_iterations || 50,
        current_step_index: 0,
        steps,
        messages: [],
        created_at: Date.now(),
        updated_at: Date.now()
      };
      
      await this.state.storage.put('conversation', this.conversation);
      
      // Schedule first alarm
      await this.state.storage.setAlarm(Date.now() + 1000);
      
      console.log(`[DO:${this.state.id}] Flow initialized with ${steps.length} steps`);
      
      return new Response(JSON.stringify({
        success: true,
        conversation_id: this.state.id.toString(),
        flow_id,
        steps_count: steps.length,
        message: 'Flow execution started'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Initialize flow error: ${error.message}`);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // Load flow steps from database
  private async loadFlowSteps(flowId: string): Promise<any[]> {
    if (!this.env.PROJECT_FACTS_DB) {
      console.log(`[DO:${this.state.id}] PROJECT_FACTS_DB not available`);
      return [];
    }
    
    try {
      const result = await this.env.PROJECT_FACTS_DB.prepare(
        'SELECT step_id, title, instructions, order_index FROM flow_steps WHERE flow_id = ? ORDER BY order_index'
      ).bind(flowId).all();
      
      return result.results || [];
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Error loading flow steps: ${error.message}`);
      return [];
    }
  }
  
  // Get current state
  private async handleGetState(): Promise<Response> {
    if (!this.conversation) {
      return new Response(JSON.stringify({ error: 'Conversation not initialized' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({
      id: this.conversation.id,
      flow_id: this.conversation.flow_id,
      state: this.conversation.state,
      iteration: this.conversation.iteration,
      current_step_index: this.conversation.current_step_index,
      total_steps: this.conversation.steps.length,
      current_step: this.conversation.steps[this.conversation.current_step_index] || null,
      created_at: this.conversation.created_at,
      updated_at: this.conversation.updated_at
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Handle OpenHands response
  private async handleOpenHandsResponse(request: Request): Promise<Response> {
    if (!this.conversation) {
      return new Response(JSON.stringify({ error: 'Conversation not initialized' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      const body = await request.json() as {
        response: string;
        conversation_id?: string;
      };
      
      console.log(`[DO:${this.state.id}] Received OpenHands response for step ${this.conversation.current_step_index + 1}`);
      
      // Store response in messages
      this.conversation.messages.push({
        role: 'user',
        content: body.response
      });
      
      // Move to next step
      this.conversation.current_step_index++;
      this.conversation.updated_at = Date.now();
      
      // Check if all steps completed
      if (this.conversation.current_step_index >= this.conversation.steps.length) {
        this.conversation.state = 'DONE';
        console.log(`[DO:${this.state.id}] All ${this.conversation.steps.length} steps completed`);
      } else {
        this.conversation.state = 'INIT';
        // Schedule next alarm to process next step
        await this.state.storage.setAlarm(Date.now() + 1000);
      }
      
      await this.state.storage.put('conversation', this.conversation);
      
      return new Response(JSON.stringify({
        success: true,
        step_completed: this.conversation.current_step_index - 1,
        total_steps: this.conversation.steps.length,
        next_step: this.conversation.state === 'DONE' ? null : 
          this.conversation.steps[this.conversation.current_step_index]
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] OpenHands response error: ${error.message}`);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // Main alarm handler
  private async handleAlarm(): Promise<void> {
    if (!this.conversation) {
      console.log(`[DO:${this.state.id}] No conversation to handle alarm`);
      return;
    }
    
    console.log(`[DO:${this.state.id}] Alarm: state=${this.conversation.state}, step=${this.conversation.current_step_index + 1}/${this.conversation.steps.length}`);
    
    this.conversation.updated_at = Date.now();
    
    switch (this.conversation.state) {
      case 'INIT':
        await this.handleInitState();
        break;
        
      case 'WAITING_OPENHANDS':
        // Waiting for OpenHands response - check timeout
        const timeWaiting = Date.now() - this.conversation.updated_at;
        if (timeWaiting > 300000) { // 5 minutes timeout
          console.log(`[DO:${this.state.id}] OpenHands response timeout, moving to next step`);
          this.conversation.current_step_index++;
          this.conversation.state = 'INIT';
          await this.state.storage.setAlarm(Date.now() + 1000);
        }
        break;
        
      case 'PROCESSING_RESPONSE':
        // Should not happen in alarm
        break;
        
      case 'DONE':
        console.log(`[DO:${this.state.id}] Flow execution completed`);
        return;
    }
    
    await this.state.storage.put('conversation', this.conversation);
  }
  
  // Handle INIT state - send step to OpenHands
  private async handleInitState(): Promise<void> {
    if (!this.conversation) return;
    
    const currentStepIndex = this.conversation.current_step_index;
    if (currentStepIndex >= this.conversation.steps.length) {
      this.conversation.state = 'DONE';
      return;
    }
    
    const step = this.conversation.steps[currentStepIndex];
    console.log(`[DO:${this.state.id}] Sending step ${currentStepIndex + 1}: ${step.title}`);
    
    // Build message for OpenHands
    // Format: Assistant (DeepSeek) gives command → User (OpenHands) executes
    const message = {
      role: 'assistant',
      content: `Execute step: ${step.title}\n\n${step.instructions}`
    };
    
    this.conversation.messages.push(message);
    this.conversation.state = 'WAITING_OPENHANDS';
    this.conversation.iteration++;
    
    console.log(`[DO:${this.state.id}] Step sent to OpenHands: ${step.title.substring(0, 100)}...`);
    
    // In real implementation, this would call OpenHands API
    // For now, we'll just log and wait for response via /openhands-response endpoint
    console.log(`[DO:${this.state.id}] Waiting for OpenHands response via /openhands-response endpoint`);
    
    // Set timeout alarm
    await this.state.storage.setAlarm(Date.now() + 300000); // 5 minutes timeout
  }
}