// Durable Object for conversation orchestration
// ALL state management and alarm-driven logic lives here
import { callDeepSeek } from '../services/deepseek';
import { createOpenHandsConversation, getOpenHandsConversation, injectMessageToOpenHands } from '../services/openhands';
import { MAX_ITERATIONS, STOP_TOKEN, ALARM_DELAY_INIT, ALARM_DELAY_WAITING } from '../constants';
import { CloudflareBindings, ConversationData, ConversationState, OpenHandsMessage } from '../types';

export class ConversationDO_v2 {
  private state: DurableObjectState;
  private env: CloudflareBindings;
  private conversation: ConversationData | null = null;

  constructor(state: DurableObjectState, env: CloudflareBindings) {
    this.state = state;
    this.env = env;
    
    // Load conversation state from storage
    this.state.blockConcurrencyWhile(async () => {
      this.conversation = await this.state.storage.get('conversation') || null;
    });
  }
  
  // HTTP endpoints for the Durable Object
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Initialize a new conversation
    if (path === '/initialize' && request.method === 'POST') {
      return this.handleInitialize(request);
    }
    
    // Get conversation state
    if (path === '/get-state' && request.method === 'GET') {
      return this.handleGetState();
    }
    
    // Stop conversation
    if (path === '/stop' && request.method === 'POST') {
      return this.handleStop();
    }
    
    // Alarm endpoint (called by Cloudflare when alarm triggers)
    if (path === '/alarm') {
      await this.handleAlarm();
      return new Response(null, { status: 204 });
    }
    
    return new Response(JSON.stringify({
      error: 'Not found',
      available_endpoints: ['POST /initialize', 'GET /get-state', 'POST /stop', '/alarm']
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // ==========================================================================
  // HTTP HANDLERS
  // ==========================================================================
  
  private async handleInitialize(request: Request): Promise<Response> {
    try {
      const body = await request.json() as {
        repository: string;
        branch?: string;
        initial_user_prompt: string;
        max_iterations?: number;
      };
      const { repository, branch, initial_user_prompt, max_iterations } = body;
      
      if (!repository || !initial_user_prompt) {
        return new Response(JSON.stringify({ error: 'Need repository and initial_user_prompt' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Initialize conversation
      this.conversation = {
        state: 'INIT',
        initial_user_prompt,
        iteration: 0,
        repository,
        branch,
        max_iterations: max_iterations || MAX_ITERATIONS,
        status: 'active',
        created_at: Date.now(),
        updated_at: Date.now()
      };
      
      await this.state.storage.put('conversation', this.conversation);
      
      // Schedule first alarm immediately
      await this.state.storage.setAlarm(Date.now() + ALARM_DELAY_INIT);
      
      console.log(`[DO:${this.state.id}] Initialized conversation, alarm scheduled`);
      
      return new Response(JSON.stringify({
        success: true,
        conversation_id: this.state.id.toString(),
        state: 'INIT',
        message: 'Conversation initialized. First alarm scheduled.'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Initialize error: ${error.message}`);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  private handleGetState(): Response {
    return new Response(JSON.stringify({
      success: true,
      conversation: this.conversation || { state: 'not_initialized' }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  private async handleStop(): Promise<Response> {
    await this.stopConversation('manually_stopped');
    return new Response(JSON.stringify({
      success: true,
      message: 'Conversation stopped'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // ==========================================================================
  // ALARM HANDLER (MAIN STATE MACHINE)
  // ==========================================================================
  
  private async handleAlarm(): Promise<void> {
    if (!this.conversation) {
      console.log(`[DO:${this.state.id}] No conversation to handle alarm`);
      return;
    }
    
    console.log(`[DO:${this.state.id}] Alarm triggered, state: ${this.conversation.state}, iteration: ${this.conversation.iteration}`);
    
    // Update timestamp
    this.conversation.updated_at = Date.now();
    
    try {
      // State machine
      switch (this.conversation.state) {
        case 'INIT':
          await this.handleInitState();
          break;
          
        case 'WAITING_OPENHANDS':
          await this.handleWaitingOpenHandsState();
          break;
          
        case 'DONE':
          console.log(`[DO:${this.state.id}] Conversation already DONE, no action needed`);
          return;
          
        default:
          await this.stopConversation(`invalid_state: ${this.conversation.state}`);
          return;
      }
      
      // Save updated state
      await this.state.storage.put('conversation', this.conversation);
      
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Alarm handler error: ${error.message}`);
      await this.stopConversation(`alarm_error: ${error.message}`);
    }
  }
  
  // ==========================================================================
  // STATE HANDLERS
  // ==========================================================================
  
  private async handleInitState(): Promise<void> {
    if (!this.conversation) return;
    
    console.log(`[DO:${this.state.id}] INIT state: Sending to DeepSeek`);
    
    // Send initial prompt to DeepSeek
    const deepseekResult = await callDeepSeek(
      this.env.DEEPSEEK_API_KEY,
      this.conversation.initial_user_prompt,
      {
        repository: this.conversation.repository,
        branch: this.conversation.branch,
        iteration: this.conversation.iteration,
        max_iterations: this.conversation.max_iterations
      }
    );
    
    if (!deepseekResult.success) {
      await this.stopConversation(`deepseek_failed: ${deepseekResult.error}`);
      return;
    }
    
    // Check for stop condition
    if (this.checkForDone(deepseekResult.response!)) {
      console.log(`[DO:${this.state.id}] DeepSeek responded with ${STOP_TOKEN}, stopping`);
      await this.stopConversation('deepseek_done');
      return;
    }
    
    this.conversation.last_deepseek_response = deepseekResult.response;
    this.conversation.iteration++;
    
    // Create OpenHands conversation with DeepSeek response
    const openhandsResult = await createOpenHandsConversation(
      this.env.OPENHANDS_API_URL,
      deepseekResult.response!,
      this.conversation.repository,
      this.conversation.branch
    );
    
    if (!openhandsResult.success) {
      await this.stopConversation(`openhands_create_failed: ${openhandsResult.error}`);
      return;
    }
    
    this.conversation.openhands_conversation_id = openhandsResult.conversationId;
    this.conversation.state = 'WAITING_OPENHANDS';
    
    // Schedule next alarm to check OpenHands status
    await this.state.storage.setAlarm(Date.now() + ALARM_DELAY_WAITING);
    console.log(`[DO:${this.state.id}] OpenHands conversation created: ${openhandsResult.conversationId}, next alarm in ${ALARM_DELAY_WAITING}ms`);
  }
  
  private async handleWaitingOpenHandsState(): Promise<void> {
    if (!this.conversation || !this.conversation.openhands_conversation_id) {
      await this.stopConversation('missing_openhands_conversation_id');
      return;
    }
    
    // Check max iterations
    if (this.conversation.iteration >= this.conversation.max_iterations) {
      console.log(`[DO:${this.state.id}] Max iterations reached: ${this.conversation.iteration}`);
      await this.stopConversation('max_iterations_reached');
      return;
    }
    
    console.log(`[DO:${this.state.id}] WAITING_OPENHANDS: Checking conversation ${this.conversation.openhands_conversation_id}`);
    
    // Get OpenHands conversation status
    const openhandsStatus = await getOpenHandsConversation(
      this.env.OPENHANDS_API_URL,
      this.conversation.openhands_conversation_id
    );
    
    if (!openhandsStatus.success) {
      await this.stopConversation(`openhands_status_failed: ${openhandsStatus.error}`);
      return;
    }
    
    // Check if OpenHands is awaiting user input
    if (openhandsStatus.agent_state !== 'awaiting_user_input') {
      console.log(`[DO:${this.state.id}] OpenHands not ready (agent_state: ${openhandsStatus.agent_state}), rescheduling alarm`);
      // Reschedule alarm
      await this.state.storage.setAlarm(Date.now() + ALARM_DELAY_WAITING);
      return;
    }
    
    // Find latest agent message with id > last_sent_to_deepseek_id
    const latestMessage = this.findLatestAgentMessage(
      openhandsStatus.messages || [],
      this.conversation.last_sent_to_deepseek_id
    );
    
    if (!latestMessage) {
      console.log(`[DO:${this.state.id}] No new agent messages found`);
      // Reschedule alarm
      await this.state.storage.setAlarm(Date.now() + ALARM_DELAY_WAITING);
      return;
    }
    
    console.log(`[DO:${this.state.id}] Found new agent message: ${latestMessage.id}`);
    this.conversation.last_openhands_response = latestMessage.content;
    this.conversation.last_sent_to_deepseek_id = latestMessage.id;
    
    // Send OpenHands response to DeepSeek
    const deepseekResult = await callDeepSeek(
      this.env.DEEPSEEK_API_KEY,
      latestMessage.content,
      {
        repository: this.conversation.repository,
        branch: this.conversation.branch,
        iteration: this.conversation.iteration,
        max_iterations: this.conversation.max_iterations
      }
    );
    
    if (!deepseekResult.success) {
      await this.stopConversation(`deepseek_failed: ${deepseekResult.error}`);
      return;
    }
    
    // Check for stop condition
    if (this.checkForDone(deepseekResult.response!)) {
      console.log(`[DO:${this.state.id}] DeepSeek responded with ${STOP_TOKEN}, stopping`);
      await this.stopConversation('deepseek_done');
      return;
    }
    
    this.conversation.last_deepseek_response = deepseekResult.response;
    this.conversation.iteration++;
    
    // Inject DeepSeek response back to OpenHands
    const injectResult = await injectMessageToOpenHands(
      this.env.OPENHANDS_API_URL,
      this.conversation.openhands_conversation_id,
      deepseekResult.response!
    );
    
    if (!injectResult.success) {
      await this.stopConversation(`openhands_inject_failed: ${injectResult.error}`);
      return;
    }
    
    console.log(`[DO:${this.state.id}] Message injected to OpenHands, iteration: ${this.conversation.iteration}`);
    
    // Schedule next alarm to check OpenHands status
    await this.state.storage.setAlarm(Date.now() + ALARM_DELAY_WAITING);
  }
  
  // ==========================================================================
  // HELPER METHODS
  // ==========================================================================
  
  private async stopConversation(reason: string): Promise<void> {
    console.log(`[DO:${this.state.id}] Stopping conversation: ${reason}`);
    
    if (this.conversation) {
      this.conversation.state = 'DONE';
      this.conversation.status = 'stopped';
      this.conversation.error_message = reason;
      this.conversation.updated_at = Date.now();
      
      await this.state.storage.put('conversation', this.conversation);
    }
    
    // Cancel any pending alarms
    try {
      await this.state.storage.deleteAlarm();
    } catch (error) {
      // Ignore errors if no alarm exists
    }
  }
  
  private findLatestAgentMessage(messages: OpenHandsMessage[], lastSentId?: string): OpenHandsMessage | null {
    // Filter for agent messages (assistant role)
    const agentMessages = messages.filter(msg => msg.role === 'assistant');
    
    if (agentMessages.length === 0) {
      return null;
    }
    
    // Sort by timestamp descending (newest first)
    agentMessages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    
    // If no lastSentId, return the newest agent message
    if (!lastSentId) {
      return agentMessages[0];
    }
    
    // Find the newest agent message with id > lastSentId
    for (const msg of agentMessages) {
      if (msg.id > lastSentId) {
        return msg;
      }
    }
    
    return null;
  }
  
  private checkForDone(response: string): boolean {
    return response.includes(STOP_TOKEN);
  }
}