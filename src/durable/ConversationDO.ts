// Durable Object for conversation orchestration
// ALL state management and alarm-driven logic lives here
import { callDeepSeek, buildInitialMessages } from '../services/deepseek';
import { createOpenHandsConversation, getOpenHandsConversation, injectMessageToOpenHands } from '../services/openhands';
import { parseDoneResponse, extractPromptsAndResponses } from '../utils/parsing';
import { saveFlowRun, updateFlowRunStatus, saveIteration, generateFlowRunId, getProjectFacts } from '../services/database';
import { shouldCompleteTask } from '../services/verification';
import { validateFactUsage, resolveFactPlaceholders } from '../utils/factValidation';
import { 
  MAX_ITERATIONS, 
  END_FLOW_TOKEN, 
  END_FLOW_EARLY_TOKEN, 
  ALARM_DELAY_INIT, 
  ALARM_DELAY_WAITING, 
  ALARM_DELAY_ACTIVE,
  OPENHANDS_TIMEOUT, 
  NO_EVENT_TIMEOUT,
  AGGRESSIVE_MODE,
  AGGRESSIVE_NO_EVENT_TIMEOUT,
  AGGRESSIVE_OPENHANDS_TIMEOUT,
  STATIC_PROMPT_MODE,
  STATIC_PROMPTS,
  FORCE_END_FLOW_AFTER_TIMEOUT,
  AUTO_RESTART_CONVERSATION,
  RESTART_DELAY,
  MAX_RESTARTS,
  DEEPSEEK_RESPONSE_TIMEOUT,
  CHECKING_PROMPT,
  ADAPTIVE_POLLING_ENABLED,
  MIN_POLL_INTERVAL,
  MAX_POLL_INTERVAL,
  POLL_INTERVAL_INCREMENT,
  POLL_INTERVAL_RESET,
  ENABLE_REQUEST_CACHING,
  CACHE_TTL,
  MAX_CONCURRENT_CONVERSATIONS,
  MAX_DO_LIFETIME,
  IDLE_TIMEOUT,
  COMPLETED_CLEANUP_DELAY
} from '../constants';
import { CloudflareBindings, ConversationData, ConversationState, OpenHandsEvent, DoneResponseData, ProjectFact } from '../types';

export class ConversationOrchestratorDO_2026A {
  private state: DurableObjectState;
  private env: CloudflareBindings;
  private conversation: ConversationData | null = null;
  private flowRunId: string | null = null;

  constructor(state: DurableObjectState, env: CloudflareBindings) {
    this.state = state;
    this.env = env;
    
    // Load conversation state from storage
    this.state.blockConcurrencyWhile(async () => {
      this.conversation = await this.state.storage.get('conversation') || null;
    });
  }
  
  /**
   * Get next poll interval using adaptive polling logic
   */
  private getNextPollInterval(): number {
    if (!ADAPTIVE_POLLING_ENABLED || !this.conversation) {
      return ALARM_DELAY_WAITING;
    }
    
    // Initialize adaptive polling fields if not set
    if (this.conversation.current_poll_interval === undefined) {
      this.conversation.current_poll_interval = POLL_INTERVAL_RESET;
    }
    if (this.conversation.consecutive_idle_checks === undefined) {
      this.conversation.consecutive_idle_checks = 0;
    }
    if (this.conversation.last_activity_at === undefined) {
      this.conversation.last_activity_at = Date.now();
    }
    
    const timeSinceLastActivity = Date.now() - this.conversation.last_activity_at;
    const isActive = timeSinceLastActivity < 30000; // 30 seconds since last activity
    
    if (isActive) {
      // Reset to base interval when active
      this.conversation.current_poll_interval = POLL_INTERVAL_RESET;
      this.conversation.consecutive_idle_checks = 0;
      console.log(`[DO:${this.state.id}] Active conversation, reset poll interval to ${POLL_INTERVAL_RESET}ms`);
    } else {
      // Increase interval when idle
      this.conversation.consecutive_idle_checks = (this.conversation.consecutive_idle_checks || 0) + 1;
      this.conversation.current_poll_interval = Math.min(
        this.conversation.current_poll_interval! + POLL_INTERVAL_INCREMENT,
        MAX_POLL_INTERVAL
      );
      console.log(`[DO:${this.state.id}] Idle conversation (${this.conversation.consecutive_idle_checks} checks), increased poll interval to ${this.conversation.current_poll_interval}ms`);
    }
    
    return Math.max(MIN_POLL_INTERVAL, Math.min(MAX_POLL_INTERVAL, this.conversation.current_poll_interval));
  }
  
  /**
   * Update activity tracking
   */
  private updateActivityTracking(): void {
    if (!this.conversation) return;
    
    this.conversation.last_activity_at = Date.now();
    this.conversation.consecutive_idle_checks = 0;
    
    // Reset poll interval on activity if adaptive polling is enabled
    if (ADAPTIVE_POLLING_ENABLED) {
      this.conversation.current_poll_interval = POLL_INTERVAL_RESET;
    }
  }
  
  /**
   * Schedule next alarm with adaptive interval
   */
  private async scheduleNextAlarm(interval?: number): Promise<void> {
    const nextInterval = interval || this.getNextPollInterval();
    await this.state.storage.setAlarm(Date.now() + nextInterval);
    console.log(`[DO:${this.state.id}] Next alarm scheduled in ${nextInterval}ms`);
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
    
    // Attach to existing OpenHands conversation
    if (path === '/attach' && request.method === 'POST') {
      return this.handleAttach(request);
    }
    
    // Get conversation state
    if (path === '/get-state' && request.method === 'GET') {
      return this.handleGetState();
    }
    
    // Stop conversation
    if (path === '/stop' && request.method === 'POST') {
      return this.handleStop();
    }
    
    // Delete this Durable Object (cleanup)
    if (path === '/delete' && request.method === 'POST') {
      return this.handleDelete();
    }
    
    return new Response(JSON.stringify({
      error: 'Not found',
      available_endpoints: ['POST /initialize', 'POST /attach', 'GET /get-state', 'POST /stop', 'POST /delete']
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // ==========================================================================
  // HTTP HANDLERS
  // ==========================================================================
  
  /**
   * Load project facts from D1 database
   * @returns Array of project facts or empty array if not configured
   */
  private async loadProjectFacts(): Promise<ProjectFact[]> {
    if (!this.env.PROJECT_FACTS_DB) {
      console.log(`[DO:${this.state.id}] PROJECT_FACTS_DB not configured, using empty facts`);
      return [];
    }
    
    try {
      const facts = await getProjectFacts(this.env.PROJECT_FACTS_DB);
      console.log(`[DO:${this.state.id}] Loaded ${facts.length} project facts`);
      return facts;
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Error loading project facts: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Validate DeepSeek response uses facts correctly and resolve placeholders
   * @param response DeepSeek response text
   * @returns Validation and resolution result
   */
  private validateAndResolveDeepSeekResponse(response: string): {
    valid: boolean;
    error?: string;
    resolvedText: string;
  } {
    if (!this.conversation?.project_facts || this.conversation.project_facts.length === 0) {
      // No facts configured, pass through unchanged
      return { valid: true, resolvedText: response };
    }
    
    // Validate fact usage
    const validation = validateFactUsage(response, this.conversation.project_facts);
    if (!validation.valid) {
      return { valid: false, error: validation.error, resolvedText: response };
    }
    
    // Resolve placeholders
    const { resolvedText, unresolvedTags } = resolveFactPlaceholders(response, this.conversation.project_facts);
    
    if (unresolvedTags.length > 0) {
      return {
        valid: false,
        error: `Unresolved fact tags: ${unresolvedTags.join(', ')}`,
        resolvedText: response
      };
    }
    
    return { valid: true, resolvedText };
  }
  
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
      
      // Ensure reasonable minimum iterations
      const effectiveMaxIterations = max_iterations && max_iterations >= 10 ? max_iterations : MAX_ITERATIONS;
      
      // Generate flow run ID
      this.flowRunId = generateFlowRunId();
      
      // Initialize conversation - SIMPLIFIED: No database dependencies
      this.conversation = {
        state: 'INIT',
        initial_user_prompt,
        iteration: 0,
        repository,
        branch,
        max_iterations: effectiveMaxIterations,
        status: 'active',
        created_at: Date.now(),
        updated_at: Date.now(),
        deepseek_system,
        project_facts: [] // Empty array instead of database query
      };
      
      await this.state.storage.put('conversation', this.conversation);
      
      // Schedule first alarm immediately
      await this.scheduleNextAlarm(ALARM_DELAY_INIT);
      
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

  private async handleAttach(request: Request): Promise<Response> {
    try {
      const body = await request.json() as {
        openhands_conversation_id: string;
        max_iterations?: number;
        deepseek_system?: string;
      };
      const { openhands_conversation_id, max_iterations, deepseek_system } = body;
      
      if (!openhands_conversation_id) {
        return new Response(JSON.stringify({ error: 'Need openhands_conversation_id' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Ensure reasonable minimum iterations
      const effectiveMaxIterations = max_iterations && max_iterations >= 10 ? max_iterations : MAX_ITERATIONS;
      
      // Generate flow run ID
      this.flowRunId = generateFlowRunId();
      
      // Load project facts from database
      const projectFacts = await this.loadProjectFacts();
      
      // Initialize conversation with existing OpenHands ID
      this.conversation = {
        state: 'WAITING_OPENHANDS', // Start by monitoring the existing conversation
        initial_user_prompt: '[ATTACHED TO EXISTING CONVERSATION]',
        iteration: 0,
        repository: '[EXISTING]',
        branch: '[EXISTING]',
        max_iterations: effectiveMaxIterations,
        status: 'active',
        created_at: Date.now(),
        updated_at: Date.now(),
        deepseek_system: deepseek_system || 'You are an AI assistant that coordinates between OpenHands and DeepSeek. When OpenHands completes a task and asks "Proceed?", you should analyze the results and provide the next instruction. Always be concise and focused on the task.',
        project_facts: projectFacts,
        openhands_conversation_id: openhands_conversation_id
      };
      
      await this.state.storage.put('conversation', this.conversation);
      
      // Save initial flow run to database - DISABLED for simplicity
      // await this.saveInitialFlowRunToDatabase();
      
      // Schedule first alarm immediately to start monitoring
      await this.scheduleNextAlarm(ALARM_DELAY_INIT);
      
      console.log(`[DO:${this.state.id}] Attached to existing OpenHands conversation: ${openhands_conversation_id}, alarm scheduled`);
      
      return new Response(JSON.stringify({
        success: true,
        conversation_id: this.state.id.toString(),
        openhands_conversation_id: openhands_conversation_id,
        state: 'WAITING_OPENHANDS',
        message: 'Attached to existing OpenHands conversation. Monitoring started.'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Attach error: ${error.message}`);
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

  private async handleDelete(): Promise<Response> {
    console.log(`[DO:${this.state.id}] Deleting Durable Object`);
    
    try {
      // Clear all storage
      await this.state.storage.deleteAll();
      
      // Cancel any pending alarms
      try {
        await this.state.storage.deleteAlarm();
      } catch (error) {
        // Ignore errors if no alarm exists
      }
      
      console.log(`[DO:${this.state.id}] Durable Object storage cleared, will auto-delete when idle`);
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Durable Object marked for deletion',
        id: this.state.id.toString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Error deleting Durable Object: ${error.message}`);
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
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
    
    // ==========================================================================
    // LIFECYCLE MANAGEMENT CHECKS
    // ==========================================================================
    
    // 1. Check maximum lifetime (1 hour)
    const conversationAge = Date.now() - this.conversation.created_at;
    if (conversationAge > MAX_DO_LIFETIME) {
      console.log(`[DO:${this.state.id}] Maximum lifetime exceeded (${conversationAge}ms > ${MAX_DO_LIFETIME}ms), cleaning up to free resources`);
      await this.cleanupStorage();
      return;
    }
    
    // 2. Check idle timeout (30 minutes since last update)
    const timeSinceUpdate = Date.now() - this.conversation.updated_at;
    if (timeSinceUpdate > IDLE_TIMEOUT) {
      console.log(`[DO:${this.state.id}] Conversation idle for too long (${timeSinceUpdate}ms > ${IDLE_TIMEOUT}ms), deleting to free resources`);
      await this.cleanupStorage();
      return;
    }
    
    // 3. Check if conversation is completed and should be cleaned up
    if (this.conversation.state === 'DONE' || this.conversation.status === 'stopped') {
      const timeSinceCompletion = Date.now() - this.conversation.updated_at;
      if (timeSinceCompletion > COMPLETED_CLEANUP_DELAY) {
        console.log(`[DO:${this.state.id}] Conversation completed ${timeSinceCompletion}ms ago, cleaning up to free resources`);
        await this.cleanupStorage();
        return;
      }
    }
    
    // Update timestamp
    this.conversation.updated_at = Date.now();
    
    // In aggressive mode, check if conversation has been stuck for too long
    // COMMENTED OUT: Too aggressive for complex tasks (20 minutes)
    // if (AGGRESSIVE_MODE && FORCE_END_FLOW_AFTER_TIMEOUT) {
    //   const aggressiveConversationAge = Date.now() - this.conversation.created_at;
    //   const maxConversationAge = AGGRESSIVE_OPENHANDS_TIMEOUT * 2; // 20 minutes
    //   
    //   if (aggressiveConversationAge > maxConversationAge) {
    //     console.log(`[DO:${this.state.id}] Conversation too old (${aggressiveConversationAge}ms > ${maxConversationAge}ms), force ending`);
    //     await this.forceEndAndRestartConversation(`conversation_too_old: ${aggressiveConversationAge}ms`);
    //     return;
    //   }
    // }
    
    // Check if DeepSeek is taking too long to respond (2 minutes max)
    if (this.conversation.deepseek_response_pending && this.conversation.last_deepseek_request_at) {
      const timeSinceRequest = Date.now() - this.conversation.last_deepseek_request_at;
      
      if (timeSinceRequest > DEEPSEEK_RESPONSE_TIMEOUT) {
        console.log(`[DO:${this.state.id}] DeepSeek response timeout (${timeSinceRequest}ms > ${DEEPSEEK_RESPONSE_TIMEOUT}ms), sending checking prompt`);
        
        // Send checking prompt to DeepSeek
        await this.sendCheckingPrompt();
        return;
      }
    }
    
    try {
      // State machine
      switch (this.conversation.state) {
        case 'INIT':
          await this.handleInitState();
          break;
          
        case 'WAITING_OPENHANDS':
          await this.handleWaitingOpenHandsState();
          break;
          
        case 'ITERATION_COMPLETE':
          await this.handleIterationCompleteState();
          break;
          
        case 'AWAITING_NEXT_ITERATION':
          await this.handleAwaitingNextIterationState();
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
      this.conversation.conversation_messages!
    );
    
    if (!deepseekResult.success) {
      await this.stopConversation(`deepseek_failed: ${deepseekResult.error}`);
      return;
    }
    
    // Update activity tracking for adaptive polling
    this.updateActivityTracking();
    
    // Check for stop condition
    const doneData = this.checkForDone(deepseekResult.response!);
    
    // Check deterministic completion via external verification
    const verificationResult = await shouldCompleteTask(
      this.conversation.repository,
      this.conversation.branch || 'main',
      this.conversation.iteration,
      deepseekResult.response!
    );
    
    // Complete only if external verification passes (NOT if AI says done)
    if (verificationResult.shouldComplete) {
      const reason = `external_verification: ${verificationResult.completionReason}`;
      console.log(`[DO:${this.state.id}] Completion triggered: ${reason}`);
      console.log(`[DO:${this.state.id}] Verification details: ${JSON.stringify(verificationResult.verificationResult)}`);
      
      await this.handleDoneResponse(deepseekResult.response!, reason);
      await this.stopConversation(reason);
      return;
    }
    
    // If DeepSeek says it's done but external verification doesn't agree, continue anyway
    if (doneData.done) {
      console.log(`[DO:${this.state.id}] DeepSeek indicated completion but continuing per configuration`);
      // Don't stop the conversation, just log and continue
    }
    
    // Add DeepSeek response to conversation history
    this.conversation.conversation_messages!.push({
      role: 'assistant',
      content: deepseekResult.response!
    });
    
    this.conversation.last_deepseek_response = deepseekResult.response;
    
    // Clear DeepSeek response pending flag since we got a response
    this.conversation.deepseek_response_pending = false;
    
    // Save initial iteration (iteration 0) - DISABLED to avoid database writes
    // await this.saveIterationToDatabase(
    //   this.conversation.initial_user_prompt,
    //   deepseekResult.response!
    // );
    
    this.conversation.iteration++;
    
    // Validate DeepSeek response uses facts correctly
    const validationResult = this.validateAndResolveDeepSeekResponse(deepseekResult.response!);
    if (!validationResult.valid) {
      console.log(`[DO:${this.state.id}] Fact validation failed: ${validationResult.error}`);
      await this.stopConversation(`FACT_VIOLATION: ${validationResult.error}`);
      return;
    }
    
    console.log(`[DO:${this.state.id}] Fact validation passed, resolved text: ${validationResult.resolvedText ? validationResult.resolvedText.substring(0, 100) + "..." : "EMPTY"}...`);
    
    // TEST: Simulate OpenHands API failure
    const TEST_OPENHANDS_FAILURE = false; // Set to true to test failure
    if (TEST_OPENHANDS_FAILURE) {
      await this.stopConversation(`openhands_create_failed: TEST_SIMULATED_ERROR`);
      return;
    }
    
    // Create OpenHands conversation with RESOLVED DeepSeek response
    const openhandsResult = await createOpenHandsConversation(
      this.env.OPENHANDS_API_URL,
      validationResult.resolvedText,
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
    await this.scheduleNextAlarm();
    console.log(`[DO:${this.state.id}] OpenHands conversation created: ${openhandsResult.conversationId}, next alarm scheduled`);
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
    
    // Get OpenHands conversation events FIRST (before checking timeout)
    // We need events to extract content even if we timeout
    const openhandsStatus = await getOpenHandsConversation(
      this.env.OPENHANDS_API_URL,
      this.conversation.openhands_conversation_id
    );
    
    if (!openhandsStatus.success) {
      // Track consecutive errors instead of stopping immediately
      this.conversation.openhands_error_count = (this.conversation.openhands_error_count || 0) + 1;
      console.log(`[DO:${this.state.id}] OpenHands API error (${this.conversation.openhands_error_count} consecutive): ${openhandsStatus.error}`);
      
      // Only stop after 5 consecutive errors
      if (this.conversation.openhands_error_count >= 5) {
        await this.stopConversation(`openhands_status_failed_after_${this.conversation.openhands_error_count}_attempts: ${openhandsStatus.error}`);
        return;
      }
      
      // Wait longer before retrying (exponential backoff: 10s, 20s, 40s, etc.)
      const backoffTime = Math.min(10000 * Math.pow(2, this.conversation.openhands_error_count - 1), 120000); // Max 2 minutes
      console.log(`[DO:${this.state.id}] Backing off for ${backoffTime/1000}s before retry`);
      await this.scheduleNextAlarm(backoffTime);
      return;
    }
    
    // Reset error count on success
    this.conversation.openhands_error_count = 0;
    
    const events = openhandsStatus.events || [];
    console.log(`[DO:${this.state.id}] Got ${events.length} events`);
    
    // Initialize pending actions if not exists
    if (!this.conversation.pending_actions) {
      this.conversation.pending_actions = [];
    }
    
    // Initialize iteration start time if not set
    if (!this.conversation.iteration_started_at) {
      this.conversation.iteration_started_at = Date.now();
      // Also initialize last event time
      this.conversation.last_event_seen_at = Date.now();
    }
    
    // Filter events to only process NEW events since last processed
    const lastProcessedEventId = this.conversation.last_sent_event_id || 0;
    const newEvents = events.filter(event => event.id > lastProcessedEventId);
    
    if (newEvents.length === 0) {
      console.log(`[DO:${this.state.id}] No new events since last processed event ID ${lastProcessedEventId}`);
    } else {
      console.log(`[DO:${this.state.id}] Processing ${newEvents.length} new events (since ID ${lastProcessedEventId})`);
      // Update last event time when we see new events
      this.conversation.last_event_seen_at = Date.now();
      // Update activity tracking for adaptive polling
      this.updateActivityTracking();
    }
    
    // Process events to track pending actions
    const newPendingActions = [...this.conversation.pending_actions];
    let iterationCompleted = false;
    let agentAwaitingInput = false;
    let contentToSend = '';
    
    // Process events in chronological order (oldest first)
    // Events come with ?reverse=true (newest first), so reverse them back
    const chronologicalEvents = [...newEvents].reverse();
    
    for (const event of chronologicalEvents) {
      console.log(`[DO:${this.state.id}] Processing event ${event.id}: action=${event.action}, observation=${event.observation}, tool_call_id=${event.args?.tool_call_id}`);
      
      // Check for ActionEvent (agent started a tool call)
      // EXCLUDE 'message' actions from pending actions - they're not actions that need completion
      if (event.action && event.action !== 'agent_state_changed' && event.action !== 'message') {
        // Try to get tool_call_id from args, or generate one from event ID
        const tool_call_id = event.args?.tool_call_id || `event_${event.id}`;
        
        // Check if this action is already tracked
        const existingIndex = newPendingActions.findIndex(a => a.tool_call_id === tool_call_id);
        if (existingIndex === -1) {
          // New action - add to pending list
          newPendingActions.push({
            tool_call_id: tool_call_id,
            action_type: event.action,
            started_at: Date.now(),
            event_id: event.id,
            description: event.message || event.content
          });
          console.log(`[DO:${this.state.id}] Added pending action: ${event.action} (tool_call_id: ${tool_call_id})`);
        }
      }
      
      // Check for ObservationEvent (tool execution completed)
      if (event.observation) {
        // Try to match observation to action
        // First try tool_call_id from args
        if (event.args?.tool_call_id) {
          const actionIndex = newPendingActions.findIndex(a => a.tool_call_id === event.args!.tool_call_id);
          if (actionIndex !== -1) {
            const completedAction = newPendingActions[actionIndex];
            console.log(`[DO:${this.state.id}] Action completed: ${completedAction.action_type} (tool_call_id: ${event.args!.tool_call_id})`);
            newPendingActions.splice(actionIndex, 1);
          }
        } else {
          // No tool_call_id - try to match by action type
          // Look for most recent pending action of the same type
          for (let i = newPendingActions.length - 1; i >= 0; i--) {
            const action = newPendingActions[i];
            if (action.action_type === event.observation) {
              console.log(`[DO:${this.state.id}] Action completed (type match): ${action.action_type} (event_id: ${action.event_id})`);
              newPendingActions.splice(i, 1);
              break;
            }
          }
        }
      }
      
      // Check for agent_state_changed to awaiting_user_input
      if (event.observation === 'agent_state_changed' && event.extras?.agent_state === 'awaiting_user_input') {
        agentAwaitingInput = true;
        console.log(`[DO:${this.state.id}] Agent is awaiting user input`);
        
        // SIMPLE RULE: Get the event right before this one
        // Events are in chronological order (oldest first) in chronologicalEvents
        const eventIndex = chronologicalEvents.findIndex(e => e.id === event.id);
        if (eventIndex > 0) {
          // Get the event right before awaiting_user_input
          const prevEvent = chronologicalEvents[eventIndex - 1];
          
          // Use message field first, then args.content, then content
          contentToSend = prevEvent.message || prevEvent.args?.content || prevEvent.content || '';
          
          if (contentToSend) {
            console.log(`[DO:${this.state.id}] Found content from previous event (ID: ${prevEvent.id}, Action: ${prevEvent.action}): ${contentToSend.length} chars`);
          } else {
            // Try one more event back if needed
            if (eventIndex > 1) {
              const prevPrevEvent = chronologicalEvents[eventIndex - 2];
              contentToSend = prevPrevEvent.message || prevPrevEvent.args?.content || prevPrevEvent.content || '';
              if (contentToSend) {
                console.log(`[DO:${this.state.id}] Found content from event before previous (ID: ${prevPrevEvent.id}, Action: ${prevPrevEvent.action}): ${contentToSend.length} chars`);
              }
            }
          }
        }
        
        if (!contentToSend) {
          console.log(`[DO:${this.state.id}] No content found in event before awaiting_user_input`);
        }
      }
      
      // INSTANT DETECTION: Check for agent message with wait_for_response: true
      // This happens BEFORE agent_state_changed, so we can detect it instantly
      if (event.source === 'agent' && event.action === 'message' && event.args?.wait_for_response === true) {
        agentAwaitingInput = true;
        console.log(`[DO:${this.state.id}] INSTANT DETECTION: Agent message with wait_for_response=true`);
        
        // Use this event's content directly
        contentToSend = event.args?.content || event.message || event.content || '';
        console.log(`[DO:${this.state.id}] Using content from wait_for_response message (${contentToSend.length} chars)`);
      }
    }
    
    // Update pending actions
    this.conversation.pending_actions = newPendingActions;
    
    // Update last processed event ID (track highest event ID processed)
    if (newEvents.length > 0) {
      const maxEventId = Math.max(...newEvents.map(e => e.id));
      this.conversation.last_sent_event_id = maxEventId;
      console.log(`[DO:${this.state.id}] Updated last processed event ID to ${maxEventId}`);
    }
    
    // Check if iteration is complete (agent is awaiting input)
    // When agent is awaiting_user_input, we should respond immediately regardless of pending actions
    // The agent is DONE and waiting for our response
    if (agentAwaitingInput && contentToSend) {
      iterationCompleted = true;
      console.log(`[DO:${this.state.id}] Iteration ${this.conversation.iteration} completed! Agent awaiting input with content (${contentToSend.length} chars)`);
      
      // Generate iteration summary
      const iterationDuration = Date.now() - (this.conversation.iteration_started_at || Date.now());
      this.conversation.last_iteration_summary = `Iteration ${this.conversation.iteration} completed in ${iterationDuration}ms. Agent is awaiting next instructions.`;
      
      // Move to ITERATION_COMPLETE state and process immediately
      this.conversation.state = 'ITERATION_COMPLETE';
      this.conversation.pending_event_content = contentToSend;
      this.conversation.iteration_started_at = undefined; // Reset for next iteration
      
      // Save state
      await this.state.storage.put('conversation', this.conversation);
      
      // Process immediately instead of scheduling alarm
      await this.handleIterationCompleteState();
      return;
    }
    
    // If we get here, iteration is not complete yet
    console.log(`[DO:${this.state.id}] Iteration not complete. Pending actions: ${newPendingActions.length}, Agent awaiting input: ${agentAwaitingInput}`);
    
    // Check for "no new events" timeout (use aggressive timeout if enabled)
    if (this.conversation.last_event_seen_at) {
      const timeoutToUse = AGGRESSIVE_MODE ? AGGRESSIVE_NO_EVENT_TIMEOUT : NO_EVENT_TIMEOUT;
      const timeSinceLastEvent = Date.now() - this.conversation.last_event_seen_at;
      if (timeSinceLastEvent > timeoutToUse) {
        console.log(`[DO:${this.state.id}] No new events for ${timeSinceLastEvent}ms (> ${timeoutToUse}ms), assuming OH is stuck. Forcing completion.`);
        
        // Try to find any content in existing events to send to DeepSeek
        let fallbackContent = '';
        if (newEvents.length > 0) {
          // Look for the most recent message in new events
          const chronologicalEvents = [...newEvents].reverse(); // Oldest first
          let mostRecentMessage = null;
          
          for (const event of chronologicalEvents) {
            if (event.args?.content || event.message || event.content) {
              const content = event.args?.content || event.message || event.content || '';
              if (content) {
                mostRecentMessage = {
                  id: event.id,
                  content: content
                };
                // Keep going to find the MOST recent (last one in chronological order)
              }
            }
          }
          
          if (mostRecentMessage) {
            fallbackContent = mostRecentMessage.content;
            console.log(`[DO:${this.state.id}] Found most recent message in events (ID: ${mostRecentMessage.id}, ${fallbackContent.length} chars)`);
            
            // Add timeout context
            fallbackContent = `[OpenHands timed out after ${Math.round(timeSinceLastEvent/1000)}s without new events, last available response:]\n\n${fallbackContent}`;
          }
        }
        
        // Store any found content for next iteration
        if (fallbackContent) {
          this.conversation.pending_event_content = fallbackContent;
        }
        
        // Force move to next iteration and process immediately
        this.conversation.state = 'ITERATION_COMPLETE';
        this.conversation.last_iteration_summary = `Iteration ${this.conversation.iteration} forced completion - no new events for ${Math.round(timeSinceLastEvent/1000)}s.`;
        this.conversation.iteration_started_at = undefined;
        this.conversation.last_event_seen_at = undefined;
        
        await this.state.storage.put('conversation', this.conversation);
        await this.handleIterationCompleteState();
        return;
      }
    }
    
    // Check if iteration has timed out (general timeout check)
    const openhandsTimeoutToUse = AGGRESSIVE_MODE ? AGGRESSIVE_OPENHANDS_TIMEOUT : OPENHANDS_TIMEOUT;
    if (this.conversation.iteration_started_at && 
        Date.now() - this.conversation.iteration_started_at > openhandsTimeoutToUse) {
      console.log(`[DO:${this.state.id}] Iteration ${this.conversation.iteration} timed out after ${openhandsTimeoutToUse}ms. Forcing completion.`);
      
      // Try to find the MOST RECENT agent message content in NEW events
      let fallbackContent = '';
      
      // Process events in chronological order (oldest to newest) to find the most recent
      const chronologicalEvents = [...newEvents].reverse(); // Oldest first
      let mostRecentMessage = null;
      
      for (const event of chronologicalEvents) {
        if (event.args?.content || event.message || event.content) {
          const content = event.args?.content || event.message || event.content || '';
          if (content) {
            mostRecentMessage = {
              id: event.id,
              content: content
            };
            // Keep going to find the MOST recent (last one in chronological order)
          }
        }
      }
      
      if (mostRecentMessage) {
        fallbackContent = mostRecentMessage.content;
        console.log(`[DO:${this.state.id}] Found most recent agent message (ID: ${mostRecentMessage.id}, ${fallbackContent.length} chars)`);
        
        // Add timeout context
        fallbackContent = `[OpenHands timed out after ${OPENHANDS_TIMEOUT}ms, partial response:]\n\n${fallbackContent}`;
      }
      
      // Store any found content for next iteration
      if (fallbackContent) {
        this.conversation.pending_event_content = fallbackContent;
      }
      
      // Force move to next iteration and process immediately
      this.conversation.state = 'ITERATION_COMPLETE';
      this.conversation.last_iteration_summary = `Iteration ${this.conversation.iteration} forced completion after timeout (${OPENHANDS_TIMEOUT}ms).`;
      this.conversation.iteration_started_at = undefined;
      
      await this.state.storage.put('conversation', this.conversation);
      await this.handleIterationCompleteState();
      return;
    }
    
    // ADAPTIVE POLLING: Poll faster as we approach expected completion
    const iterationDuration = Date.now() - this.conversation.iteration_started_at!;
    let nextCheckDelay = ALARM_DELAY_WAITING; // Default 50ms
    
    // If we just started (first 5 seconds), poll less frequently
    if (iterationDuration < 5000) {
      nextCheckDelay = 1000; // 1 second for long operations
    } 
    // If we're in the middle (5-30 seconds), poll moderately
    else if (iterationDuration < 30000) {
      nextCheckDelay = 500; // 500ms for medium operations
    }
    // If we're past 30 seconds, poll very frequently (expecting completion soon)
    else if (iterationDuration < 60000) {
      nextCheckDelay = 100; // 100ms for operations nearing completion
    }
    // After 1 minute, poll extremely frequently
    else {
      nextCheckDelay = ALARM_DELAY_ACTIVE; // 10ms for immediate detection
    }
    
    console.log(`[DO:${this.state.id}] Next check in ${nextCheckDelay}ms (iteration duration: ${iterationDuration}ms)`);
    await this.scheduleNextAlarm(nextCheckDelay);
  }
  
  // ==========================================================================
  // NEW STATE HANDLERS
  // ==========================================================================
  
  private async handleIterationCompleteState(): Promise<void> {
    if (!this.conversation) return;
    
    console.log(`[DO:${this.state.id}] ITERATION_COMPLETE: Iteration ${this.conversation.iteration} completed`);
    
    // Check if we should continue or stop
    // For now, always continue to next iteration
    // In the future, we could add logic to decide based on iteration summary
    
    // Move to AWAITING_NEXT_ITERATION state and process immediately
    this.conversation.state = 'AWAITING_NEXT_ITERATION';
    
    // Save state
    await this.state.storage.put('conversation', this.conversation);
    
    // Process immediately instead of scheduling alarm
    await this.handleAwaitingNextIterationState();
  }
  
  private async handleAwaitingNextIterationState(): Promise<void> {
    if (!this.conversation) return;
    
    console.log(`[DO:${this.state.id}] AWAITING_NEXT_ITERATION: Deciding next step for iteration ${this.conversation.iteration}`);
    
    // Check if we have pending event content from timeout or previous iteration
    if (this.conversation.pending_event_content) {
      console.log(`[DO:${this.state.id}] Using pending event content (${this.conversation.pending_event_content.length} chars)`);
      const contentToSend = this.conversation.pending_event_content;
      this.conversation.pending_event_content = undefined; // Clear after use
      await this.state.storage.put('conversation', this.conversation);
      await this.sendToDeepSeek(contentToSend);
      return;
    }
    
    // In aggressive mode with static prompts, use a static prompt instead of getting content from OpenHands
    if (AGGRESSIVE_MODE && STATIC_PROMPT_MODE) {
      console.log(`[DO:${this.state.id}] Using static prompt mode for iteration ${this.conversation.iteration}`);
      
      // Get the appropriate static prompt based on iteration
      const promptIndex = (this.conversation.iteration - 1) % STATIC_PROMPTS.length;
      const staticPrompt = STATIC_PROMPTS[promptIndex];
      
      console.log(`[DO:${this.state.id}] Using static prompt ${promptIndex + 1}/${STATIC_PROMPTS.length}: ${staticPrompt ? staticPrompt.substring(0, 100) + "..." : "EMPTY"}`);
      
      // Send the static prompt to DeepSeek
      await this.sendToDeepSeek(staticPrompt);
      return;
    }
    
    // For now, always send to DeepSeek to get next instructions
    // We need to get the last OpenHands response to send to DeepSeek
    
    // Get OpenHands conversation to find the last message
    const openhandsStatus = await getOpenHandsConversation(
      this.env.OPENHANDS_API_URL,
      this.conversation.openhands_conversation_id!
    );
    
    if (!openhandsStatus.success) {
      console.log(`[DO:${this.state.id}] Failed to get OpenHands conversation: ${openhandsStatus.error}`);
      // Retry in 10 seconds
      await this.scheduleNextAlarm(10000);
      return;
    }
    
    const events = openhandsStatus.events || [];
    // Events come with ?reverse=true (newest first), search in that order
    // Find the agent's last message (before awaiting_user_input)
    let contentToSend = '';
    
    // Reverse events to chronological order (oldest first) for easier processing
    const chronologicalEvents = [...events].reverse();
    
    for (let i = 0; i < chronologicalEvents.length; i++) {
      const event = chronologicalEvents[i];
      if (event.observation === 'agent_state_changed' && event.extras?.agent_state === 'awaiting_user_input') {
        // Get the event right before this one (if exists)
        if (i > 0) {
          const prevEvent = chronologicalEvents[i - 1];
          // Use message field first, then args.content, then content
          contentToSend = prevEvent.message || prevEvent.args?.content || prevEvent.content || '';
          
          if (contentToSend) {
            console.log(`[DO:${this.state.id}] Found content from event before awaiting_user_input (ID: ${prevEvent.id}, Action: ${prevEvent.action}): ${contentToSend.length} chars`);
            break;
          }
          
          // Try one more event back if needed
          if (i > 1 && !contentToSend) {
            const prevPrevEvent = chronologicalEvents[i - 2];
            contentToSend = prevPrevEvent.message || prevPrevEvent.args?.content || prevPrevEvent.content || '';
            if (contentToSend) {
              console.log(`[DO:${this.state.id}] Found content from event before previous (ID: ${prevPrevEvent.id}, Action: ${prevPrevEvent.action}): ${contentToSend.length} chars`);
              break;
            }
          }
        }
        
        if (!contentToSend) {
          console.log(`[DO:${this.state.id}] No content found in event before awaiting_user_input`);
        }
        break;
      }
    }
    
    if (contentToSend) {
      console.log(`[DO:${this.state.id}] Found content to send to DeepSeek (${contentToSend.length} chars)`);
      
      // Send to DeepSeek for next instructions
      await this.sendToDeepSeek(contentToSend);
    } else {
      console.log(`[DO:${this.state.id}] No content found to send to DeepSeek`);
      
      // If we have a last iteration summary (e.g., from timeout), use that
      if (this.conversation.last_iteration_summary) {
        console.log(`[DO:${this.state.id}] Using last iteration summary as fallback content`);
        const timeoutMessage = `OpenHands timed out or didn't provide a response. ${this.conversation.last_iteration_summary}`;
        await this.sendToDeepSeek(timeoutMessage);
      } else {
        // No content and no summary - send a generic message
        console.log(`[DO:${this.state.id}] No content or summary available, sending generic timeout message`);
        const timeoutMessage = `OpenHands didn't provide a response for iteration ${this.conversation.iteration}. Please provide simpler instructions or check if OpenHands is working.`;
        await this.sendToDeepSeek(timeoutMessage);
      }
    }
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
      
      // In aggressive mode with auto-restart, schedule a new conversation
      if (AGGRESSIVE_MODE && AUTO_RESTART_CONVERSATION) {
        const restartCount = this.conversation.restart_count || 0;
        if (restartCount < MAX_RESTARTS) {
          console.log(`[DO:${this.state.id}] Scheduling auto-restart in ${RESTART_DELAY}ms (restart ${restartCount + 1}/${MAX_RESTARTS})`);
          
          // Store restart count
          this.conversation.restart_count = restartCount + 1;
          await this.state.storage.put('conversation', this.conversation);
          
          // Schedule restart alarm
          await this.scheduleNextAlarm(RESTART_DELAY);
        } else {
          console.log(`[DO:${this.state.id}] Max restarts reached (${MAX_RESTARTS}), not auto-restarting`);
          // After max restarts, delete storage to free resources
          await this.cleanupStorage();
        }
      } else {
        // If not auto-restarting, delete storage to free resources
        await this.cleanupStorage();
      }
    }
    
    // Cancel any pending alarms
    try {
      await this.state.storage.deleteAlarm();
    } catch (error) {
      // Ignore errors if no alarm exists
    }
  }
  
  private async cleanupStorage(): Promise<void> {
    try {
      console.log(`[DO:${this.state.id}] Cleaning up storage to free resources`);
      
      // Decrement active conversation count in KV
      try {
        if (this.env.RATE_LIMIT_KV) {
          const activeConversationsKey = 'global:active_conversations';
          const currentCount = await this.env.RATE_LIMIT_KV.get(activeConversationsKey);
          if (currentCount) {
            const newCount = Math.max(0, parseInt(currentCount) - 1);
            await this.env.RATE_LIMIT_KV.put(activeConversationsKey, newCount.toString(), { expirationTtl: 3600 });
            console.log(`[DO:${this.state.id}] Decremented active conversations to ${newCount}`);
          }
        }
      } catch (kvError) {
        console.error(`[DO:${this.state.id}] Error updating active conversation count: ${kvError}`);
      }
      
      // Delete all storage to reduce Durable Object usage
      await this.state.storage.deleteAll();
      console.log(`[DO:${this.state.id}] Storage cleaned up successfully`);
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Error cleaning up storage: ${error.message}`);
    }
  }
  
  private async forceEndAndRestartConversation(reason: string): Promise<void> {
    console.log(`[DO:${this.state.id}] Force ending and restarting conversation: ${reason}`);
    
    // First, stop the current conversation
    await this.stopConversation(`force_ended: ${reason}`);
    
    // The stopConversation method will handle auto-restart if enabled
  }
  
  /**
   * Process a pending event that has passed the cooldown period
   * This sends the event content to DeepSeek and continues the loop
   */
  private async sendToDeepSeek(messageContent: string): Promise<void> {
    if (!this.conversation) {
      console.log(`[DO:${this.state.id}] No conversation to send to DeepSeek`);
      return;
    }
    
    console.log(`[DO:${this.state.id}] Sending to DeepSeek: ${messageContent.length} chars`);
    
    // Track DeepSeek request time and mark response as pending
    this.conversation.last_deepseek_request_at = Date.now();
    this.conversation.deepseek_response_pending = true;
    
    // Add OpenHands response to conversation history as user message
    if (!this.conversation.conversation_messages) {
      // This should never happen - conversation_messages should be initialized in handleInitState
      console.error(`[DO:${this.state.id}] conversation_messages is undefined!`);
      this.conversation.conversation_messages = [];
    }
    
    // Add iteration context to OpenHands response
    const messageContentWithContext = `[Iteration ${this.conversation.iteration + 1} of ${this.conversation.max_iterations}]
${messageContent}`;
    
    this.conversation.conversation_messages!.push({
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
    
    // Update activity tracking for adaptive polling
    this.updateActivityTracking();
    
    // Check for stop condition
    const doneData = this.checkForDone(deepseekResult.response!);
    
    // Check deterministic completion via external verification
    const verificationResult = await shouldCompleteTask(
      this.conversation.repository,
      this.conversation.branch || 'main',
      this.conversation.iteration,
      deepseekResult.response!
    );
    
    // Complete only if external verification passes (NOT if AI says done)
    if (verificationResult.shouldComplete) {
      const reason = `external_verification: ${verificationResult.completionReason}`;
      console.log(`[DO:${this.state.id}] Completion triggered: ${reason}`);
      console.log(`[DO:${this.state.id}] Verification details: ${JSON.stringify(verificationResult.verificationResult)}`);
      
      await this.handleDoneResponse(deepseekResult.response!, reason);
      await this.stopConversation(reason);
      return;
    }
    
    // If DeepSeek says it's done but external verification doesn't agree, continue anyway
    if (doneData.done) {
      console.log(`[DO:${this.state.id}] DeepSeek indicated completion but continuing per configuration`);
      // Don't stop the conversation, just log and continue
    }
    
    // Add DeepSeek response to conversation history
    this.conversation.conversation_messages!.push({
      role: 'assistant',
      content: deepseekResult.response!
    });
    
    this.conversation.last_deepseek_response = deepseekResult.response;
    
    // Clear DeepSeek response pending flag since we got a response
    this.conversation.deepseek_response_pending = false;
    
    // Save iteration with OpenHands response as prompt and DeepSeek response - DISABLED to avoid database writes
    // await this.saveIterationToDatabase(
    //   messageContent, // Original OpenHands response (without iteration context)
    //   deepseekResult.response!
    // );
    
    this.conversation.iteration++;
    
    // Validate DeepSeek response uses facts correctly
    const validationResult = this.validateAndResolveDeepSeekResponse(deepseekResult.response!);
    if (!validationResult.valid) {
      console.log(`[DO:${this.state.id}] Fact validation failed: ${validationResult.error}`);
      await this.stopConversation(`FACT_VIOLATION: ${validationResult.error}`);
      return;
    }
    
    console.log(`[DO:${this.state.id}] Fact validation passed, resolved text: ${validationResult.resolvedText ? validationResult.resolvedText.substring(0, 100) + "..." : "EMPTY"}...`);
    
    // Inject RESOLVED DeepSeek response back to OpenHands
    const injectResult = await injectMessageToOpenHands(
      this.env.OPENHANDS_API_URL,
      this.conversation.openhands_conversation_id!,
      validationResult.resolvedText
    );
    
    if (!injectResult.success) {
      await this.stopConversation(`openhands_inject_failed: ${injectResult.error}`);
      return;
    }
    
    console.log(`[DO:${this.state.id}] Message injected to OpenHands, iteration: ${this.conversation.iteration}`);
    
    // Update activity tracking for adaptive polling
    this.updateActivityTracking();
    
    // Stay in WAITING_OPENHANDS state to wait for next agent response
    // (We just injected a task, now wait for agent to execute it)
    this.conversation.state = 'WAITING_OPENHANDS';
    await this.state.storage.put('conversation', this.conversation);
    
    // After sending new instruction, wait for OH to start execution
    // Use standard check interval (no special timing for different commands)
    console.log(`[DO:${this.state.id}] After sending instruction, waiting for OH to start`);
    await this.scheduleNextAlarm();
  }
  
  /**
   * Send a checking prompt to DeepSeek when response is taking too long
   */
  private async sendCheckingPrompt(): Promise<void> {
    if (!this.conversation) {
      console.log(`[DO:${this.state.id}] No conversation to send checking prompt`);
      return;
    }
    
    console.log(`[DO:${this.state.id}] Sending checking prompt to DeepSeek`);
    
    // Update last DeepSeek request time to prevent immediate re-check
    this.conversation.last_deepseek_request_at = Date.now();
    
    // Add checking prompt to conversation history
    if (!this.conversation.conversation_messages) {
      this.conversation.conversation_messages = [];
    }
    
    this.conversation.conversation_messages!.push({
      role: 'user',
      content: CHECKING_PROMPT
    });
    
    // Send checking prompt to DeepSeek
    const deepseekResult = await callDeepSeek(
      this.env.DEEPSEEK_API_KEY,
      this.conversation.conversation_messages
    );
    
    if (!deepseekResult.success) {
      console.error(`[DO:${this.state.id}] Checking prompt failed: ${deepseekResult.error}`);
      // Don't stop conversation on checking prompt failure
      return;
    }
    
    // Update activity tracking for adaptive polling
    this.updateActivityTracking();
    
    // Add DeepSeek response to conversation history
    this.conversation.conversation_messages!.push({
      role: 'assistant',
      content: deepseekResult.response!
    });
    
    this.conversation.last_deepseek_response = deepseekResult.response;
    
    // Clear DeepSeek response pending flag
    this.conversation.deepseek_response_pending = false;
    
    // Save checking prompt iteration - DISABLED to avoid database writes
    // await this.saveIterationToDatabase(
    //   CHECKING_PROMPT,
    //   deepseekResult.response!
    // );
    
    console.log(`[DO:${this.state.id}] Checking prompt sent and response received`);
    
    // Save state
    await this.state.storage.put('conversation', this.conversation);
    
    // Set alarm for next check
    await this.scheduleNextAlarm();
  }
  
  private checkForDone(response: string): DoneResponseData {
    return parseDoneResponse(response);
  }

  /**
   * Handle a [END_FLOW] or [END_FLOW_EARLY] response by saving flow run and closing conversation
   * @param response The DeepSeek response containing [END_FLOW] or [END_FLOW_EARLY]
   * @param reason Reason for stopping
   */
  private async handleDoneResponse(response: string, reason: string): Promise<void> {
    if (!this.conversation) return;

    // Parse the done response
    const doneData = this.checkForDone(response);
    
    if (!doneData.done) {
      return;
    }

    // Determine the final stop reason
    let finalStopReason = reason;
    let flowStatus: 'completed' | 'stopped' | 'new_flow_started' = 'completed';
    
    if (doneData.is_end_flow_early) {
      // END_FLOW_EARLY: Stop without starting new flow
      finalStopReason = `end_flow_early: ${doneData.stop_reason || 'no_reason_provided'}`;
      flowStatus = 'stopped';
      console.log(`[DO:${this.state.id}] END_FLOW_EARLY detected: ${doneData.stop_reason}`);
    } else if (doneData.new_prompt) {
      // END_FLOW with new prompt: Start new flow
      finalStopReason = `end_flow_with_new_prompt: ${doneData.new_prompt ? doneData.new_prompt.substring(0, 50) + "..." : "EMPTY"}`;
      flowStatus = 'new_flow_started';
      console.log(`[DO:${this.state.id}] END_FLOW with new prompt detected, starting new flow`);
    } else {
      // END_FLOW without new prompt: Just stop
      finalStopReason = 'end_flow_no_new_prompt';
      flowStatus = 'completed';
      console.log(`[DO:${this.state.id}] END_FLOW without new prompt detected`);
    }

    // Save the current flow run to database with appropriate status - DISABLED to avoid database writes
    // await this.saveFlowRunToDatabase(finalStopReason, flowStatus);

    // If there's a new prompt and it's not END_FLOW_EARLY, start a new flow
    if (doneData.new_prompt && !doneData.is_end_flow_early) {
      await this.startNextFlow(doneData);
    }
  }

  /**
   * Start a new flow when [END_FLOW] contains a new prompt
   * @param doneData Parsed done response data
   */
  private async startNextFlow(doneData: DoneResponseData): Promise<void> {
    if (!doneData.new_prompt) return;

    console.log(`[DO:${this.state.id}] Starting next flow with prompt: ${doneData.new_prompt ? doneData.new_prompt.substring(0, 50) + "..." : "EMPTY"}`);

    // Generate a new conversation ID
    const newConversationId = crypto.randomUUID();
    
    // Prepare the request body for the new flow
    const requestBody = {
      repository: this.conversation!.repository, // Use same repository
      branch: doneData.new_branch || this.conversation!.branch || 'main',
      initial_user_prompt: doneData.new_prompt,
      max_iterations: this.conversation!.max_iterations, // Use same max iterations
      deepseek_system: doneData.new_deepseek_system || this.conversation!.deepseek_system
    };

    try {
      // We need to make an HTTP request to the worker's /start endpoint
      // But we don't have the worker URL in the Durable Object
      // For now, we'll create a new Durable Object directly
      const newConversationIdObj = this.env.CONVERSATIONS.idFromName(newConversationId);
      const newConversationStub = this.env.CONVERSATIONS.get(newConversationIdObj);

      // Initialize the new Durable Object
      const initResponse = await newConversationStub.fetch('http://placeholder/initialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!initResponse.ok) {
        const errorText = await initResponse.text();
        console.error(`[DO:${this.state.id}] Failed to initialize next flow: ${initResponse.status} - ${errorText}`);
        return;
      }

      console.log(`[DO:${this.state.id}] Next flow started with ID: ${newConversationId}`);
      
      // Update current flow run with next_flow_id if database is available
      if (this.env.FLOW_RUNS_DB && this.flowRunId) {
        await this.env.FLOW_RUNS_DB.prepare(
          'UPDATE flow_runs SET next_flow_id = ? WHERE id = ?'
        ).bind(newConversationId, this.flowRunId).run();
      }
    } catch (error) {
      console.error(`[DO:${this.state.id}] Failed to start next flow:`, error);
    }
  }

  /**
   * Save initial flow run to database when conversation starts
   */
  private async saveInitialFlowRunToDatabase(): Promise<void> {
    if (!this.conversation || !this.flowRunId) return;
    
    // Check if database is configured
    if (!this.env.FLOW_RUNS_DB) {
      console.log(`[DO:${this.state.id}] Database not configured, skipping initial flow run save`);
      return;
    }

    // Prepare initial flow run data
    const flowRunData = {
      id: this.flowRunId,
      conversation_id: this.state.id.toString(),
      initial_prompt: this.conversation.initial_user_prompt,
      deepseek_system: this.conversation.deepseek_system,
      repository: this.conversation.repository,
      branch: this.conversation.branch || 'main',
      max_iterations: this.conversation.max_iterations,
      actual_iterations: 0,
      status: 'active' as const,
      stop_reason: undefined,
      prompts_and_responses: JSON.stringify([]),
      created_at: this.conversation.created_at,
      updated_at: this.conversation.updated_at,
      ended_at: undefined,
      next_flow_id: undefined,
      task_type: undefined,
      success_score: undefined,
      quality_metrics: undefined,
      deployment_id: undefined,
      improvement_suggestions: undefined
    };

    // Save to database
    const result = await saveFlowRun(this.env.FLOW_RUNS_DB, flowRunData);
    if (!result.success) {
      console.error(`[DO:${this.state.id}] Failed to save initial flow run to database: ${result.error}`);
    } else {
      console.log(`[DO:${this.state.id}] Initial flow run saved to database: ${this.flowRunId}`);
    }
  }

  /**
   * Save current flow run to database
   * @param stopReason Reason for stopping
   */
  private async saveFlowRunToDatabase(stopReason: string, status: 'completed' | 'stopped' | 'new_flow_started' = 'completed'): Promise<void> {
    if (!this.conversation || !this.flowRunId) return;
    
    // Check if database is configured
    if (!this.env.FLOW_RUNS_DB) {
      console.log(`[DO:${this.state.id}] Database not configured, skipping flow run save`);
      return;
    }

    // Extract prompts and responses
    const promptsAndResponses = this.conversation.conversation_messages 
      ? extractPromptsAndResponses(this.conversation.conversation_messages)
      : JSON.stringify([]);

    // Prepare flow run data
    const flowRunData = {
      id: this.flowRunId,
      conversation_id: this.state.id.toString(),
      initial_prompt: this.conversation.initial_user_prompt,
      deepseek_system: this.conversation.deepseek_system,
      repository: this.conversation.repository,
      branch: this.conversation.branch || 'main',
      max_iterations: this.conversation.max_iterations,
      actual_iterations: this.conversation.iteration,
      status: status,
      stop_reason: stopReason,
      prompts_and_responses: promptsAndResponses,
      created_at: this.conversation.created_at,
      updated_at: Date.now(),
      ended_at: Date.now()
    };

    // Save to database
    const result = await saveFlowRun(this.env.FLOW_RUNS_DB, flowRunData);
    if (!result.success) {
      console.error(`[DO:${this.state.id}] Failed to save flow run to database: ${result.error}`);
    } else {
      console.log(`[DO:${this.state.id}] Flow run saved to database: ${this.flowRunId} with status: ${status}`);
    }
  }

  /**
   * Save an iteration to the database
   * @param prompt Prompt sent to DeepSeek
   * @param response DeepSeek response
   * @param openhandsResponse OpenHands response (if any)
   */
  private async saveIterationToDatabase(
    prompt: string,
    response: string,
    openhandsResponse?: string
  ): Promise<void> {
    if (!this.conversation || !this.flowRunId) return;
    
    // Check if database is configured
    if (!this.env.FLOW_RUNS_DB) {
      console.log(`[DO:${this.state.id}] Database not configured, skipping iteration save`);
      return;
    }

    // Prepare iteration data
    const iterationData = {
      flow_run_id: this.flowRunId,
      iteration_number: this.conversation.iteration,
      prompt,
      response,
      openhands_response: openhandsResponse,
      timestamp: Date.now(),
      metadata: JSON.stringify({
        repository: this.conversation.repository,
        branch: this.conversation.branch,
        iteration: this.conversation.iteration,
        max_iterations: this.conversation.max_iterations
      })
    };

    // Save to database
    const result = await saveIteration(this.env.FLOW_RUNS_DB, iterationData);
    if (!result.success) {
      console.error(`[DO:${this.state.id}] Failed to save iteration to database: ${result.error}`);
    } else {
      console.log(`[DO:${this.state.id}] Iteration ${this.conversation.iteration} saved to database`);
    }
  }
}