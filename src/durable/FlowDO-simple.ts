// Ultra-minimal Flow Durable Object
export class FlowDO {
  state: DurableObjectState;
  env: any;
  
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
      
      // Load steps from database
      const steps = await this.loadFlowSteps(flow_id);
      
      if (!steps || steps.length === 0) {
        return new Response(JSON.stringify({ error: `No steps found for flow: ${flow_id}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Initialize flow
      this.flow = {
        id: this.state.id.toString(),
        flow_id,
        current_step: 0,
        steps,
        state: 'SENDING_STEP',
        created_at: Date.now()
      };
      
      await this.state.storage.put('flow', this.flow);
      
      // Schedule alarm to send first step
      await this.state.storage.setAlarm(Date.now() + 1000);
      
      console.log(`[DO:${this.state.id}] Flow initialized with ${steps.length} steps`);
      
      return new Response(JSON.stringify({
        success: true,
        flow_id,
        steps_count: steps.length,
        message: 'Flow execution started'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Init error: ${error.message}`);
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  }
  
  // Load steps from database
  private async loadFlowSteps(flowId: string): Promise<any[]> {
    if (!this.env.PROJECT_FACTS_DB) {
      console.log(`[DO:${this.state.id}] No database available`);
      return [];
    }
    
    try {
      const result = await this.env.PROJECT_FACTS_DB.prepare(
        'SELECT step_id, title, instructions, order_index FROM flow_steps WHERE flow_id = ? ORDER BY order_index'
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
    
    // This is where we would send to OpenHands
    // For now, just log what would be sent
    console.log(`[DO:${this.state.id}] Step instructions:`);
    console.log(`Execute step: ${step.title}`);
    console.log(step.instructions);
    
    // In real implementation, call OpenHands API here
    // For now, simulate waiting for response
    this.flow.state = 'WAITING_RESPONSE';
    await this.state.storage.put('flow', this.flow);
    
    console.log(`[DO:${this.state.id}] Waiting for OpenHands response...`);
  }
  
  // Handle OpenHands response
  private async handleOpenHandsResponse(request: Request): Promise<Response> {
    if (!this.flow) {
      return new Response(JSON.stringify({ error: 'Flow not initialized' }), { status: 404 });
    }
    
    try {
      const body = await request.json() as { response: string };
      
      console.log(`[DO:${this.state.id}] Received OpenHands response for step ${this.flow.current_step + 1}`);
      
      // Move to next step
      this.flow.current_step++;
      
      // Check if done
      if (this.flow.current_step >= this.flow.steps.length) {
        this.flow.state = 'DONE';
        console.log(`[DO:${this.state.id}] All ${this.flow.steps.length} steps completed`);
      } else {
        this.flow.state = 'SENDING_STEP';
        // Schedule alarm to send next step
        await this.state.storage.setAlarm(Date.now() + 1000);
      }
      
      await this.state.storage.put('flow', this.flow);
      
      return new Response(JSON.stringify({
        success: true,
        step_completed: this.flow.current_step - 1,
        total_steps: this.flow.steps.length,
        next_step: this.flow.state === 'DONE' ? null : this.flow.steps[this.flow.current_step]
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Response error: ${error.message}`);
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
      created_at: this.flow.created_at
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}