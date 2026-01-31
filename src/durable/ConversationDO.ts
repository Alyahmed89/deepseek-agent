// Durable Object for conversation orchestration
// ALL state management and alarm-driven logic lives here
import { callDeepSeek, buildInitialMessages } from '../services/deepseek';
import { createOpenHandsConversation, getOpenHandsConversation, injectMessageToOpenHands } from '../services/openhands';
import { MAX_ITERATIONS, STOP_TOKEN, ALARM_DELAY_INIT, ALARM_DELAY_WAITING, EVENT_COOLDOWN_MS, MAX_COOLDOWN_WAIT_MS, ACTIVE_CHECK_INTERVAL } from '../constants';
import { CloudflareBindings, ConversationData, ConversationState, OpenHandsEvent } from '../types';

export class ConversationOrchestratorDO_2026A {
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
  
  // Alarm handler (called by Cloudflare when alarm triggers)
  async alarm(): Promise<void> {
    console.log(`[DO:${this.state.id}] Alarm triggered`);
    await this.handleAlarm();
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
    
    return new Response(JSON.stringify({
      error: 'Not found',
      available_endpoints: ['POST /initialize', 'GET /get-state', 'POST /stop']
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
        deepseek_system?: string;
      };
      const { repository, branch, initial_user_prompt, max_iterations, deepseek_system } = body;
      
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
        updated_at: Date.now(),
        deepseek_system
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
    
    // Build initial conversation messages
    const initialMessages = buildInitialMessages(
      this.conversation.initial_user_prompt,
      {
        repository: this.conversation.repository,
        branch: this.conversation.branch,
        iteration: this.conversation.iteration,
        max_iterations: this.conversation.max_iterations
      },
      this.conversation.deepseek_system
    );
    
    // Store initial messages in conversation
    this.conversation.conversation_messages = initialMessages;
    
    // Send initial prompt to DeepSeek
    const deepseekResult = await callDeepSeek(
      this.env.DEEPSEEK_API_KEY,
      this.conversation.conversation_messages
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
    
    // Add DeepSeek response to conversation history
    this.conversation.conversation_messages.push({
      role: 'assistant',
      content: deepseekResult.response!
    });
    
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
    
    // Get OpenHands conversation status and events
    const openhandsStatus = await getOpenHandsConversation(
      this.env.OPENHANDS_API_URL,
      this.conversation.openhands_conversation_id
    );
    
    if (!openhandsStatus.success) {
      await this.stopConversation(`openhands_status_failed: ${openhandsStatus.error}`);
      return;
    }
    
    // Check if we have any agent message events
    if (!openhandsStatus.events || openhandsStatus.events.length === 0) {
      console.log(`[DO:${this.state.id}] No agent message events found`);
      
      // Check if we have a pending event that needs processing
      if (this.conversation.pending_event_content && this.conversation.cooldown_started_at) {
        const timeSinceCooldownStart = Date.now() - this.conversation.cooldown_started_at;
        if (timeSinceCooldownStart >= EVENT_COOLDOWN_MS) {
          console.log(`[DO:${this.state.id}] Cooldown period passed (${Math.round(timeSinceCooldownStart/1000)}s with no new events), processing pending event`);
          await this.processPendingEvent();
          return;
        }
      }
      
      // Reschedule alarm
      await this.state.storage.setAlarm(Date.now() + ALARM_DELAY_WAITING);
      return;
    }
    
    // With the new pattern, we only get the latest event (if it's an agent message)
    const latestAgentMessage = openhandsStatus.events[0];
    
    // Check if this is a new event (id > last_sent_event_id)
    if (latestAgentMessage.id <= this.conversation.last_sent_event_id) {
      console.log(`[DO:${this.state.id}] No new agent message events found (latest ID: ${latestAgentMessage.id}, last sent: ${this.conversation.last_sent_event_id})`);
      
      // Check if we have a pending event that needs processing
      if (this.conversation.pending_event_content && this.conversation.cooldown_started_at) {
        const timeSinceLastEvent = Date.now() - (this.conversation.last_event_seen_at || 0);
        const timeSinceCooldownStart = Date.now() - this.conversation.cooldown_started_at;
        
        // Check if cooldown period has passed (2 minutes with no new events)
        if (timeSinceLastEvent >= EVENT_COOLDOWN_MS) {
          console.log(`[DO:${this.state.id}] Cooldown period passed (${Math.round(timeSinceLastEvent/1000)}s with no new events), processing pending event`);
          await this.processPendingEvent();
          return;
        }
        
        // Check if max wait time has been reached (5 minutes total)
        if (timeSinceCooldownStart >= MAX_COOLDOWN_WAIT_MS) {
          console.log(`[DO:${this.state.id}] Max cooldown wait time reached (${Math.round(timeSinceCooldownStart/1000)}s), forcing processing of pending event`);
          await this.processPendingEvent();
          return;
        }
        
        // Still in cooldown period, check again soon
        console.log(`[DO:${this.state.id}] Still in cooldown period (${Math.round(timeSinceLastEvent/1000)}s since last event), checking again in ${ACTIVE_CHECK_INTERVAL/1000}s`);
        await this.state.storage.setAlarm(Date.now() + ACTIVE_CHECK_INTERVAL);
        return;
      }
      
      // No pending event, reschedule normal alarm
      await this.state.storage.setAlarm(Date.now() + ALARM_DELAY_WAITING);
      return;
    }
    
    console.log(`[DO:${this.state.id}] Found new agent message event: ${latestAgentMessage.id}`);
    
    // Get message content: args.content ?? message
    const messageContent = latestAgentMessage.args?.content || latestAgentMessage.message || latestAgentMessage.content || '';
    
    if (!messageContent.trim()) {
      console.log(`[DO:${this.state.id}] Agent message has no content, skipping`);
      // Update last_sent_event_id anyway to avoid infinite loop
      this.conversation.last_sent_event_id = latestAgentMessage.id;
      await this.state.storage.setAlarm(Date.now() + ALARM_DELAY_WAITING);
      return;
    }
    
    // Track last_event_seen_at BEFORE overwriting with new event (first tweak)
    const previousLastEventSeenAt = this.conversation.last_event_seen_at;
    this.conversation.last_event_seen_at = Date.now();
    
    // Store event as pending (don't process immediately)
    this.conversation.pending_event_content = messageContent;
    this.conversation.pending_event_id = latestAgentMessage.id;
    
    // If this is the first event in a sequence, start the cooldown timer
    if (!this.conversation.cooldown_started_at) {
      this.conversation.cooldown_started_at = Date.now();
      console.log(`[DO:${this.state.id}] Starting cooldown timer for event ${latestAgentMessage.id}`);
    } else {
      console.log(`[DO:${this.state.id}] Updated pending event to ${latestAgentMessage.id}, cooldown timer continues`);
    }
    
    // Check if we should process immediately (edge case: first event after long pause)
    if (previousLastEventSeenAt && (Date.now() - previousLastEventSeenAt >= EVENT_COOLDOWN_MS)) {
      console.log(`[DO:${this.state.id}] Previous event was ${Math.round((Date.now() - previousLastEventSeenAt)/1000)}s ago, processing immediately`);
      await this.processPendingEvent();
      return;
    }
    
    // Check if max wait time has been reached (5 minute cap)
    const timeSinceCooldownStart = Date.now() - (this.conversation.cooldown_started_at || Date.now());
    if (timeSinceCooldownStart >= MAX_COOLDOWN_WAIT_MS) {
      console.log(`[DO:${this.state.id}] Max cooldown wait time reached (${Math.round(timeSinceCooldownStart/1000)}s), forcing processing`);
      await this.processPendingEvent();
      return;
    }
    
    // Schedule next check soon (during active event stream)
    console.log(`[DO:${this.state.id}] Event ${latestAgentMessage.id} stored as pending, checking again in ${ACTIVE_CHECK_INTERVAL/1000}s`);
    await this.state.storage.setAlarm(Date.now() + ACTIVE_CHECK_INTERVAL);
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
      
      // Clear any pending event fields
      this.conversation.pending_event_content = undefined;
      this.conversation.pending_event_id = undefined;
      this.conversation.last_event_seen_at = undefined;
      this.conversation.cooldown_started_at = undefined;
      this.conversation.deepseek_system = undefined;
      this.conversation.conversation_messages = undefined;
      
      await this.state.storage.put('conversation', this.conversation);
    }
    
    // Cancel any pending alarms
    try {
      await this.state.storage.deleteAlarm();
    } catch (error) {
      // Ignore errors if no alarm exists
    }
  }
  
  /**
   * Process a pending event that has passed the cooldown period
   * This sends the event content to DeepSeek and continues the loop
   */
  private async processPendingEvent(): Promise<void> {
    if (!this.conversation || !this.conversation.pending_event_content || !this.conversation.pending_event_id) {
      console.log(`[DO:${this.state.id}] No pending event to process`);
      return;
    }
    
    const messageContent = this.conversation.pending_event_content;
    const eventId = this.conversation.pending_event_id;
    
    console.log(`[DO:${this.state.id}] Processing pending event ${eventId} after cooldown`);
    
    // Clear pending event fields
    this.conversation.pending_event_content = undefined;
    this.conversation.pending_event_id = undefined;
    this.conversation.last_event_seen_at = undefined;
    this.conversation.cooldown_started_at = undefined;
    
    // Update last sent event ID
    this.conversation.last_sent_event_id = eventId;
    this.conversation.last_openhands_response = messageContent;
    
    // Add OpenHands response to conversation history as user message
    if (!this.conversation.conversation_messages) {
      // Initialize conversation messages if not already done (shouldn't happen)
      this.conversation.conversation_messages = buildInitialMessages(
        this.conversation.initial_user_prompt,
        {
          repository: this.conversation.repository,
          branch: this.conversation.branch,
          iteration: this.conversation.iteration,
          max_iterations: this.conversation.max_iterations
        },
        this.conversation.deepseek_system
      );
    }
    
    // Add iteration context to OpenHands response
    const messageContentWithContext = `[Iteration ${this.conversation.iteration + 1} of ${this.conversation.max_iterations}]
${messageContent}`;
    
    this.conversation.conversation_messages.push({
      role: 'user',
      content: messageContentWithContext
    });
    
    // Send OpenHands response to DeepSeek with full conversation history
    const deepseekResult = await callDeepSeek(
      this.env.DEEPSEEK_API_KEY,
      this.conversation.conversation_messages
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
    
    // Add DeepSeek response to conversation history
    this.conversation.conversation_messages.push({
      role: 'assistant',
      content: deepseekResult.response!
    });
    
    this.conversation.last_deepseek_response = deepseekResult.response;
    this.conversation.iteration++;
    
    // Inject DeepSeek response back to OpenHands
    const injectResult = await injectMessageToOpenHands(
      this.env.OPENHANDS_API_URL,
      this.conversation.openhands_conversation_id!,
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
  
  private checkForDone(response: string): boolean {
    return response.includes(STOP_TOKEN);
  }
}