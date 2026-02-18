export interface FlowStep {
  id: string;
  type: string;
  content: string;
  config?: Record<string, any>;
}

export interface FlowState {
  id: string;
  flow_id: string;
  current_step: number;
  flow_state: 'LOADING' | 'SENDING_STEP' | 'WAITING_RESPONSE' | 'DONE';
  openhands_conversation_id: string | null;
  last_processed_event_id: string | null;
  retry_count: number;
  last_poll_time: number | null;
  steps: FlowStep[];
  current_step_data: Record<string, any> | null;
}

interface FlowControllerEnv {
  OPENHANDS_API_URL: string;
}

export class FlowControllerDO {
  private state: DurableObjectState;
  private env: FlowControllerEnv;
  private flow: FlowState | null = null;

  constructor(state: DurableObjectState, env: FlowControllerEnv) {
    this.state = state;
    this.env = env;
    this.state.blockConcurrencyWhile(async () => {
      this.flow = await this.state.storage.get<FlowState>('flow');
    });
  }

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

  private async handleInit(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { 
        flow_id: string; 
        steps: FlowStep[];
        openhands_conversation_id?: string;
      };
      
      const flowState: FlowState = {
        id: this.state.id.toString(),
        flow_id: body.flow_id,
        current_step: 0,
        flow_state: 'LOADING',
        openhands_conversation_id: body.openhands_conversation_id || null,
        last_processed_event_id: null,
        retry_count: 0,
        last_poll_time: null,
        steps: body.steps,
        current_step_data: null
      };

      await this.state.storage.put('flow', flowState);
      this.flow = flowState;

      await this.sendCurrentStep();

      return new Response(JSON.stringify({
        success: true,
        flow_id: flowState.flow_id,
        state: flowState.flow_state,
        current_step: flowState.current_step + 1,
        total_steps: flowState.steps.length
      }), { headers: { 'Content-Type': 'application/json' } });

    } catch (error: any) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  }

  private async handleOpenHandsResponse(request: Request): Promise<Response> {
    if (!this.flow) {
      return new Response(JSON.stringify({ error: 'Flow not initialized' }), { status: 404 });
    }

    try {
      const body = await request.json() as { 
        conversation_id: string;
        event_id: string;
        agent_state?: string;
        content?: string;
      };

      if (this.flow.openhands_conversation_id !== body.conversation_id) {
        return new Response(JSON.stringify({ error: 'Conversation ID mismatch' }), { status: 400 });
      }

      if (this.flow.flow_state !== 'WAITING_RESPONSE') {
        return new Response(JSON.stringify({ 
          success: true, 
          message: 'Flow not waiting for response' 
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (body.event_id === this.flow.last_processed_event_id) {
        return new Response(JSON.stringify({ 
          success: true, 
          message: 'Event already processed' 
        }), { headers: { 'Content-Type': 'application/json' } });
      }

      this.flow.last_processed_event_id = body.event_id;
      this.flow.flow_state = 'SENDING_STEP';
      await this.state.storage.put('flow', this.flow);

      await this.sendCurrentStep();

      return new Response(JSON.stringify({
        success: true,
        message: 'Response processed, advancing to next step'
      }), { headers: { 'Content-Type': 'application/json' } });

    } catch (error: any) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  }

  private async handleGetStatus(): Promise<Response> {
    if (!this.flow) {
      return new Response(JSON.stringify({ error: 'Flow not initialized' }), { status: 404 });
    }

    if (this.flow.flow_state === 'WAITING_RESPONSE') {
      await this.pollForOpenHandsResponse();
    }

    return new Response(JSON.stringify({
      id: this.flow.id,
      flow_id: this.flow.flow_id,
      state: this.flow.flow_state,
      current_step: this.flow.current_step + 1,
      total_steps: this.flow.steps.length,
      openhands_conversation_id: this.flow.openhands_conversation_id,
      last_processed_event_id: this.flow.last_processed_event_id,
      retry_count: this.flow.retry_count
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  private async pollForOpenHandsResponse(): Promise<void> {
    if (!this.flow || !this.flow.openhands_conversation_id) return;

    try {
      const { getOpenHandsConversation } = await import('../services/openhands');
      const result = await getOpenHandsConversation(
        this.env.OPENHANDS_API_URL,
        this.flow.openhands_conversation_id,
        true
      );

      if (!result.events || result.events.length < 2) return;

      const latestEvent = result.events[0];
      const previousEvent = result.events[1];

      const latestAgentState = latestEvent.agent_state || (latestEvent.args || {}).agent_state;
      const previousContent = previousEvent.content || previousEvent.message || 
                            ((previousEvent.args || {}).content || '');

      if (latestAgentState === 'awaiting_user_input' && previousContent && 
          latestEvent.id !== this.flow.last_processed_event_id) {
        
        this.flow.last_processed_event_id = latestEvent.id;
        this.flow.flow_state = 'SENDING_STEP';
        await this.state.storage.put('flow', this.flow);

        await this.sendCurrentStep();
      }

    } catch (error: any) {
      console.error(`[DO:${this.flow.id}] Polling error: ${error.message}`);
      this.flow.retry_count++;
      await this.state.storage.put('flow', this.flow);
    }
  }

  private async sendCurrentStep(): Promise<void> {
    if (!this.flow) return;

    if (this.flow.current_step >= this.flow.steps.length) {
      this.flow.flow_state = 'DONE';
      await this.state.storage.put('flow', this.flow);
      return;
    }

    const step = this.flow.steps[this.flow.current_step];
    
    try {
      const { sendStepToOpenHands } = await import('../services/openhands');
      const result = await sendStepToOpenHands(
        this.env.OPENHANDS_API_URL,
        this.flow.openhands_conversation_id,
        step.content,
        step.config || {}
      );

      if (result.conversation_id) {
        this.flow.openhands_conversation_id = result.conversation_id;
      }

      this.flow.current_step++;
      this.flow.flow_state = 'WAITING_RESPONSE';
      this.flow.last_poll_time = Date.now();
      await this.state.storage.put('flow', this.flow);

    } catch (error: any) {
      console.error(`[DO:${this.flow.id}] Send step error: ${error.message}`);
      this.flow.flow_state = 'WAITING_RESPONSE';
      this.flow.retry_count++;
      await this.state.storage.put('flow', this.flow);
    }
  }
}