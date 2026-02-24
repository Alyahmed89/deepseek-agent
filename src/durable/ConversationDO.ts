// Durable Object for conversation orchestration
// ALL state management and alarm-driven logic lives here
import { callDeepSeek, buildInitialMessages } from '../services/deepseek';
import { createOpenHandsConversation, getOpenHandsConversation, injectMessageToOpenHands } from '../services/openhands';
import { parseDoneResponse, extractPromptsAndResponses } from '../utils/parsing';
import { saveFlowRun, updateFlowRunStatus, saveIteration, generateFlowRunId, getTaskData, getFirstPendingTask } from '../services/database';
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
import { CloudflareBindings, ConversationData, ConversationState, OpenHandsEvent, DoneResponseData, ProjectFact, StepData, TaskData } from '../types';

export class ConversationOrchestratorDO_2026A {
  private state: DurableObjectState;
  private env: CloudflareBindings;
  private conversation: ConversationData | null = null;
  private flowRunId: string | null = null;
  private flowStepsCache: StepData[] | null = null; // Cache for flow steps
  private flowStepsCacheTime: number = 0; // When cache was last updated
  private readonly FLOW_STEPS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache TTL

  constructor(state: DurableObjectState, env: CloudflareBindings) {
    this.state = state;
    this.env = env;
    
    // NO async work in constructor - load state lazily in fetch handlers
    this.conversation = null;
    this.flowStepsCache = null;
    this.flowStepsCacheTime = 0;
  }
  
  /**
   * Lazily load conversation state from storage
   */
  private async loadConversationState(): Promise<void> {
    if (this.conversation === null) {
      this.conversation = await this.state.storage.get('conversation') || null;
    }
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
    
    // Initialize a new flow execution
    if (path === '/initialize-flow' && request.method === 'POST') {
      return this.handleInitializeFlow(request);
    }
    
    // Ultra-minimal flow execution (NEW)
    if (path === '/start-flow' && request.method === 'POST') {
      return this.handleStartFlow(request);
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
    
    // Trigger next iteration (after task completion)
    if (path === '/trigger-next-iteration' && request.method === 'POST') {
      return this.handleTriggerNextIteration();
    }
    
    // OpenHands response webhook (for flow execution)
    if (path === '/openhands-response' && request.method === 'POST') {
      return this.handleOpenHandsResponse(request);
    }
    
    return new Response(JSON.stringify({
      error: 'Not found',
      available_endpoints: ['POST /initialize', 'POST /initialize-flow', 'POST /attach', 'GET /get-state', 'POST /stop', 'POST /delete', 'POST /trigger-next-iteration', 'POST /openhands-response']
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // ==========================================================================
  // HTTP HANDLERS
  // ==========================================================================
  
  /**
   * Handle OpenHands response webhook (for flow execution)
   */
  private async handleOpenHandsResponse(request: Request): Promise<Response> {
    try {
      await this.loadConversationState();
      
      if (!this.conversation) {
        return new Response(JSON.stringify({ error: 'Conversation not initialized' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Check if this is a flow execution
      if (!this.conversation.flow_steps || this.conversation.flow_steps.length === 0) {
        return new Response(JSON.stringify({ error: 'Not a flow execution' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Check if we're waiting for OpenHands response
      if (this.conversation.state !== 'WAITING_OPENHANDS') {
        return new Response(JSON.stringify({ 
          error: 'Not waiting for OpenHands response',
          current_state: this.conversation.state,
          note: 'Only accept responses when in WAITING_OPENHANDS state'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const body = await request.json() as { response: string };
      console.log(`[DO:${this.state.id}] Received OpenHands response for flow execution`);
      
      // Store the response for conditional branching
      this.conversation.last_step_response = body.response;
      console.log(`[DO:${this.state.id}] Stored response (${body.response.length} chars) for conditional branching`);
      
      // Send output if enabled for current step
      if (this.conversation.current_step) {
        await this.sendStepOutputIfEnabled(this.conversation.current_step, body.response);
      }
      
      // For flow execution, we just need to move to next step
      // Check if we have more steps
      const currentStepIndex = this.conversation.current_step_index || 0;
      const nextStepIndex = currentStepIndex + 1;
      
      if (nextStepIndex >= this.conversation.flow_steps.length) {
        // All steps completed (next index would be past the end)
        console.log(`[DO:${this.state.id}] All ${this.conversation.flow_steps.length} steps completed`);
        this.conversation.state = 'DONE';
        this.conversation.status = 'completed';
        this.conversation.updated_at = Date.now();
        
        await this.state.storage.put('conversation', this.conversation);
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Flow execution completed',
          steps_completed: this.conversation.flow_steps.length
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        // More steps to execute
        console.log(`[DO:${this.state.id}] Moving to next step (${nextStepIndex + 1}/${this.conversation.flow_steps.length})`);
        
        // Cancel any pending alarm
        try {
          await this.state.storage.deleteAlarm();
        } catch (error) {
          // Ignore if no alarm scheduled
        }
        
        // Increment step index since current step has completed
        // This ensures we move to the next step in sequential execution
        // For conditional branching, getNextStep() will handle updating current_step_index
        await this.incrementStepIndex();
        
        // Process next step immediately
        this.conversation.state = 'SENDING_STEP';
        this.conversation.updated_at = Date.now();
        
        await this.state.storage.put('conversation', this.conversation);
        await this.handleSendingStepState();
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Moving to next step',
          current_step: nextStepIndex, // Return incremented index
          total_steps: this.conversation.flow_steps.length
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] OpenHands response error: ${error.message}`);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  /**
   * Load and cache flow steps from D1 database
   * @param flowId The flow ID to load steps for
   * @returns Array of flow steps or null if not configured
   */
  private async loadFlowSteps(flowId: string): Promise<StepData[] | null> {
    if (!this.env.FLOW_RUNS_DB) {
      console.log(`[DO:${this.state.id}] FLOW_RUNS_DB not configured, cannot load flow steps`);
      return null;
    }
    
    // Check cache first
    const now = Date.now();
    if (this.flowStepsCache && 
        (now - this.flowStepsCacheTime) < this.FLOW_STEPS_CACHE_TTL &&
        this.conversation?.flow_id === flowId) {
      console.log(`[DO:${this.state.id}] Using cached flow steps for ${flowId}`);
      return this.flowStepsCache;
    }
    
    try {
      console.log(`[DO:${this.state.id}] Loading flow steps for ${flowId} from database`);
      const { getFlowSteps } = await import('../services/database');
      const steps = await getFlowSteps(this.env.FLOW_RUNS_DB, flowId);
      
      // Update cache
      this.flowStepsCache = steps;
      this.flowStepsCacheTime = now;
      console.log(`[DO:${this.state.id}] Cached ${steps.length} flow steps for ${flowId}`);
      
      return steps;
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Error loading flow steps: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Get next step for current flow using cache
   * @returns Next step or null if no more steps
   */
  private async getNextStep(): Promise<StepData | null> {
    if (!this.conversation?.flow_id) {
      console.log(`[DO:${this.state.id}] No flow_id in conversation`);
      return null;
    }
    
    const flowId = this.conversation.flow_id;
    
    // Check if we have a response from the previous step for conditional branching
    if (this.conversation.last_step_response && this.conversation.current_step) {
      console.log(`[DO:${this.state.id}] Checking conditional branching for flow ${flowId}`);
      console.log(`[DO:${this.state.id}] Current step: ${this.conversation.current_step.step_id}, Response length: ${this.conversation.last_step_response.length}`);
      
      // Use the new conditional branching logic
      const { getNextStepBasedOnConditions } = await import('../services/database');
      const nextStep = await getNextStepBasedOnConditions(
        this.env.FLOW_RUNS_DB,
        flowId,
        this.conversation.current_step.step_id,
        this.conversation.last_step_response
      );
      
      if (nextStep) {
        console.log(`[DO:${this.state.id}] Conditional branching selected step: ${nextStep.title} (order_index: ${nextStep.order_index})`);
        
        // Update current_step_index to match the new step's order_index
        // Note: order_index is 1-based in database, but we store as 0-based index
        this.conversation.current_step_index = nextStep.order_index - 1;
        console.log(`[DO:${this.state.id}] Updated current_step_index to ${this.conversation.current_step_index} based on conditional branching`);
        
        return nextStep;
      } else {
        console.log(`[DO:${this.state.id}] No conditional branching match, using sequential order`);
      }
    }
    
    // Fall back to sequential steps if no conditional branching
    const steps = await this.loadFlowSteps(flowId);
    
    if (!steps || steps.length === 0) {
      console.log(`[DO:${this.state.id}] No steps found for flow ${flowId}`);
      return null;
    }
    
    // Get current step index from conversation state
    const currentStepIndex = this.conversation.current_step_index || 0;
    
    if (currentStepIndex >= steps.length) {
      console.log(`[DO:${this.state.id}] All ${steps.length} steps completed for flow ${flowId}`);
      return null;
    }
    
    const nextStep = steps[currentStepIndex];
    console.log(`[DO:${this.state.id}] Next step for flow ${flowId}: ${nextStep.title} (index ${currentStepIndex + 1}/${steps.length})`);
    
    return nextStep;
  }
  
  /**
   * Increment step index and save to conversation state
   */
  private async incrementStepIndex(): Promise<void> {
    if (!this.conversation) return;
    
    const currentIndex = this.conversation.current_step_index || 0;
    this.conversation.current_step_index = currentIndex + 1;
    this.conversation.updated_at = Date.now();
    
    await this.state.storage.put('conversation', this.conversation);
    console.log(`[DO:${this.state.id}] Incremented step index to ${this.conversation.current_step_index}`);
  }
  
  /**
   * Load project facts from D1 database
   * @returns Array of project facts or empty array if not configured
   */
  private async loadProjectFacts(): Promise<ProjectFact[]> {
    // project_facts table doesn't exist in our database setup
    // Return empty array for compatibility
    return [];
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

  private async handleInitializeFlow(request: Request): Promise<Response> {
    try {
      console.log(`[DO:${this.state.id}] handleInitializeFlow called`);
      
      const body = await request.json() as {
        flow_id: string;
        repository?: string;
        branch?: string;
        initial_user_prompt?: string;
        max_iterations?: number;
        deepseek_system?: string;
      };
      const { flow_id, repository, branch, initial_user_prompt, max_iterations, deepseek_system } = body;
      
      console.log(`[DO:${this.state.id}] Parsed request: flow_id=${flow_id}`);
      
      if (!flow_id) {
        return new Response(JSON.stringify({ error: 'Need flow_id' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      let currentStep: StepData | null = null;
      
      // Ensure reasonable minimum iterations
      let effectiveMaxIterations = max_iterations && max_iterations >= 10 ? max_iterations : MAX_ITERATIONS;
      
      // Generate flow run ID
      this.flowRunId = generateFlowRunId();
      console.log(`[DO:${this.state.id}] Generated flow run ID: ${this.flowRunId}`);
      
      // Load flow context from database (if available)
      let flowContext = null;
      let flowDefinition = null;
      let taskPrompt = initial_user_prompt || `Execute flow: ${flow_id}`;
      
      // Variables that might be overridden by flow definition
      let effectiveRepository = repository;
      let effectiveBranch = branch;
      let effectiveDeepseekSystem = deepseek_system;
      
      if (this.env.FLOW_RUNS_DB) {
        console.log(`[DO:${this.state.id}] FLOW_RUNS_DB is available`);
        try {
          // Import the database functions
          console.log(`[DO:${this.state.id}] Attempting to import database functions...`);
          const { getFlowContext, getNextStepForFlow, startTaskExecution } = await import('../services/database');
          console.log(`[DO:${this.state.id}] Database functions imported successfully`);
          
          // Load flow context from database
          flowContext = await getFlowContext(this.env.FLOW_RUNS_DB, flow_id);
          console.log(`[DO:${this.state.id}] Flow context loaded: ${flowContext ? 'yes' : 'no'}`);
          
          if (flowContext) {
            flowDefinition = flowContext.definition;
            console.log(`[DO:${this.state.id}] Loaded flow context for ${flow_id}: ${flowDefinition.name}`);
            
            // Use flow definition values if not provided in request
            effectiveRepository = repository || flowDefinition.repository;
            effectiveBranch = branch || flowDefinition.branch;
            effectiveDeepseekSystem = deepseek_system || flowDefinition.deepseek_system;
            const effectiveFlowMaxIterations = flowDefinition.max_iterations;
            
            // Use flow max iterations if not specified in request
            if (!max_iterations && effectiveFlowMaxIterations > 0) {
              effectiveMaxIterations = Math.max(effectiveFlowMaxIterations, effectiveMaxIterations);
            }
            
            // Use flow's first_prompt (stored as description) for initial task prompt
            if (flowDefinition.description) {
              taskPrompt = flowDefinition.description;
              console.log(`[DO:${this.state.id}] Using flow first_prompt: ${taskPrompt.substring(0, 100)}...`);
            }
          } else {
            console.log(`[DO:${this.state.id}] No flow context found for ${flow_id}, using request parameters`);
          }
          
          // Load first step directly from database (bypass getNextStep which needs conversation)
          const { getFlowSteps } = await import('../services/database');
          const steps = await getFlowSteps(this.env.FLOW_RUNS_DB, flow_id);
          currentStep = steps && steps.length > 0 ? steps[0] : null;
          console.log(`[DO:${this.state.id}] First step loaded: ${currentStep ? currentStep.title : 'none'}`);
          
          if (currentStep) {
            // Fetch task data if task_id is present OR if requires_task is true
            let taskData = null;
            let dynamicTaskId = null;
            
            // First try static task_id (only if non-empty string)
            if (currentStep.task_id && currentStep.task_id.trim() && this.env.FLOW_RUNS_DB) {
              try {
                taskData = await getTaskData(this.env.FLOW_RUNS_DB, currentStep.task_id);
                if (taskData) {
                  console.log(`[DO:${this.state.id}] Loaded task data for task: ${currentStep.task_id}`);
                } else {
                  console.log(`[DO:${this.state.id}] Task not found in FLOW_RUNS_DB: ${currentStep.task_id}`);
                  // Clear taskData so we can try requires_task if set
                  taskData = null;
                }
              } catch (error) {
                console.error(`[DO:${this.state.id}] Error loading task data from FLOW_RUNS_DB: ${error}`);
              }
            }
            
            // If no task data from task_id, try requires_task
            // Convert requires_task to boolean explicitly (database returns 0/1 as number or string)
            const requiresTask = this.convertRequiresTaskToBoolean(currentStep.requires_task);
            console.log(`[DO:${this.state.id}] Task injection debug (other): taskData=${!!taskData}, requiresTask=${requiresTask}, flow_id=${flow_id}, FLOW_RUNS_DB=${!!this.env.FLOW_RUNS_DB}`);
            if (!taskData && requiresTask && this.env.FLOW_RUNS_DB) {
              // Dynamic task assignment - get first pending task for this flow
              console.log(`[DO:${this.state.id}] Step requires dynamic task, fetching first pending task for flow: ${flow_id}`);
              try {
                const pendingTask = await getFirstPendingTask(this.env.FLOW_RUNS_DB, flow_id);
                if (pendingTask) {
                  taskData = {
                    title: pendingTask.title,
                    description: pendingTask.description,
                    payload: pendingTask.payload
                  };
                  dynamicTaskId = pendingTask.id;
                  console.log(`[DO:${this.state.id}] Loaded first pending task: ${pendingTask.id} - ${pendingTask.title}`);
                } else {
                  console.log(`[DO:${this.state.id}] No pending tasks found for flow: ${flow_id}`);
                }
              } catch (error) {
                console.error(`[DO:${this.state.id}] Error loading first pending task: ${error}`);
              }
            }
            
            // For ALL steps (including first step), use the step instructions
            // The step instructions contain the exact command to execute
            taskPrompt = `Execute step: ${currentStep.title}`;
            
            // Inject task data if available
            if (taskData) {
              taskPrompt += `\n\n=== TASK ===`;
              // Include task ID if available (from dynamicTaskId or currentStep.task_id)
              const taskId = dynamicTaskId || currentStep.task_id;
              if (taskId) {
                taskPrompt += `\nTask ID: ${taskId}`;
              }
              if (taskData.title) {
                taskPrompt += `\nTitle: ${taskData.title}`;
              }
              if (taskData.description) {
                taskPrompt += `\nDescription: ${taskData.description}`;
              }
              // Add payload if it's JSON and contains additional metadata
              if (taskData.payload && taskData.payload.trim().startsWith('{') && taskData.payload.trim().endsWith('}')) {
                try {
                  const payloadObj = JSON.parse(taskData.payload);
                  // Add non-instruction fields from payload
                  const metadataFields = Object.entries(payloadObj)
                    .filter(([key, value]) => key !== 'instructions' && typeof value === 'string')
                    .map(([key, value]) => `${key}: ${value}`);
                  
                  if (metadataFields.length > 0) {
                    taskPrompt += `\nAdditional Details:`;
                    metadataFields.forEach(field => {
                      taskPrompt += `\n- ${field}`;
                    });
                  }
                } catch (e) {
                  // Not valid JSON, skip
                  console.log(`[DO:${this.state.id}] Task payload is not valid JSON: ${e.message}`);
                }
              }
              taskPrompt += `\n=== END TASK ===\n`;
              // REMOVED: Instructions to mark task as complete
              // Task completion is handled automatically by the system
              
              // Store dynamic task ID if we fetched one
              if (dynamicTaskId) {
                // We could store this for tracking, but for now just log it
                console.log(`[DO:${this.state.id}] Using dynamic task ID: ${dynamicTaskId}`);
              }
            }
            
            if (currentStep.description) {
              taskPrompt += `\n${currentStep.description}`;
            }
            // Note: Step instructions are in the description field (aliased from 'instructions' in SQL)
            
            // REMOVED: Step Type metadata - not needed for OpenHands
            // taskPrompt += `\n\nStep Type: ${currentStep.step_type}`;
            
            if (currentStep.page_key) {
              taskPrompt += `\nPage: ${currentStep.page_key}`;
            }
            if (currentStep.blocking === false) {
              taskPrompt += `\nNote: This step is non-blocking - flow can continue even if this step fails`;
            }
            
            console.log(`[DO:${this.state.id}] Loaded step for flow ${flow_id}: ${currentStep.title} (${currentStep.step_type})`);
            
            // Start tracking step execution (using task_execution_steps table for now)
            try {
              const executionResult = await startTaskExecution(
                this.env.FLOW_RUNS_DB, 
                this.flowRunId!,
                currentStep.step_id
              );
              
              if (executionResult.success) {
                console.log(`[DO:${this.state.id}] Started tracking step execution: ${executionResult.execution_step_id}`);
                // Store execution step ID for later completion
                this.conversation!.current_execution_step_id = executionResult.execution_step_id;
                // Store step data for reference
                this.conversation!.current_step = currentStep;
                // Set current step index to 0 (first step)
                this.conversation!.current_step_index = 0;
              }
            } catch (trackingError: any) {
              console.error(`[DO:${this.state.id}] Error tracking step execution: ${trackingError.message}`);
              // Continue even if tracking fails
            }
          } else {
            console.log(`[DO:${this.state.id}] No steps found for flow ${flow_id}`);
          }
        } catch (error: any) {
          console.error(`[DO:${this.state.id}] Error loading flow context for ${flow_id}: ${error.message}`);
          console.error(`[DO:${this.state.id}] Error stack: ${error.stack}`);
          // Continue without flow context if database error occurs
        }
      } else {
        console.log(`[DO:${this.state.id}] FLOW_RUNS_DB not available, proceeding without flow context loading`);
      }
      
      // Initialize conversation for flow execution
      this.conversation = {
        state: 'INIT',
        initial_user_prompt: taskPrompt,
        iteration: 0,
        repository: effectiveRepository || 'flow/execution',
        branch: effectiveBranch || 'main',
        max_iterations: effectiveMaxIterations,
        status: 'active',
        created_at: Date.now(),
        updated_at: Date.now(),
        deepseek_system: effectiveDeepseekSystem || 'You are a flow execution assistant. Follow the flow steps precisely. Return structured JSON when asked.',
        project_facts: [], // Empty array instead of database query
        flow_id: flow_id, // Store flow ID for flow execution
        flow_execution_mode: true, // Flag to indicate flow execution mode
        
        // Store flow context for reference
        flow_context: flowContext ? {
          definition: flowDefinition,
          has_project_context: flowContext.project_context.length > 0,
          has_testing_priorities: flowContext.testing_priorities.length > 0,
          has_api_commands: flowContext.api_commands.length > 0
        } : undefined,
        
        // Task-based execution fields
        task_execution_mode: currentStep !== null,
        current_task_id: currentStep?.step_id,
        current_task_title: currentStep?.title,
        current_task_description: currentStep?.description || undefined
      };
      
      await this.state.storage.put('conversation', this.conversation);
      
      // Schedule first alarm immediately
      await this.scheduleNextAlarm(ALARM_DELAY_INIT);
      
      console.log(`[DO:${this.state.id}] Initialized flow execution for flow: ${flow_id}, alarm scheduled`);
      
      const responseData: any = {
        success: true,
        conversation_id: this.state.id.toString(),
        flow_id: flow_id,
        state: 'INIT',
        message: 'Flow execution initialized. First alarm scheduled.',
        note: 'Flow execution: DeepSeek → OpenHands → API validation → Next step'
      };
      
      // Task info not available in flow execution mode - using currentStep instead
      
      return new Response(JSON.stringify(responseData), {
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

  // Ultra-minimal flow execution handler
  private async handleStartFlow(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { flow_id: string };
      const { flow_id } = body;
      
      if (!flow_id) {
        return new Response(JSON.stringify({ error: 'Need flow_id' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      console.log(`[DO:${this.state.id}] Starting ultra-minimal flow: ${flow_id}`);
      
      // Load flow definition from database
      let flowDefinition = null;
      let effectiveRepository = '[FLOW]';
      let effectiveBranch = '[FLOW]';
      let effectiveDeepseekSystem = 'You are OpenHands. Execute exactly what is asked.';
      let effectiveMaxIterations = 20; // Default
      let databaseAvailable = false;
      
      if (this.env.FLOW_RUNS_DB) {
        try {
          // Import database functions
          const { getFlowDefinition } = await import('../services/database');
          flowDefinition = await getFlowDefinition(this.env.FLOW_RUNS_DB, flow_id);
          
          if (flowDefinition) {
            console.log(`[DO:${this.state.id}] Loaded flow definition for ${flow_id}: ${flowDefinition.name}`);
            databaseAvailable = true;
            
            // Use flow definition values
            effectiveRepository = flowDefinition.repository || '[FLOW]';
            effectiveBranch = flowDefinition.branch || '[FLOW]';
            effectiveDeepseekSystem = flowDefinition.deepseek_system || 'You are OpenHands. Execute exactly what is asked.';
            
            // Use flow max iterations if available
            if (flowDefinition.max_iterations && flowDefinition.max_iterations > 0) {
              effectiveMaxIterations = flowDefinition.max_iterations;
            }
            
            console.log(`[DO:${this.state.id}] Using repository from database: ${effectiveRepository}, branch: ${effectiveBranch}`);
            
            // Warn if repository is placeholder
            if (effectiveRepository === '[FLOW]') {
              console.warn(`[DO:${this.state.id}] WARNING: Repository is placeholder '[FLOW]'. OpenHands conversation will be created but may not work correctly.`);
            }
          } else {
            console.warn(`[DO:${this.state.id}] No flow definition found for ${flow_id} in database. Using placeholder values.`);
            console.warn(`[DO:${this.state.id}] To fix: Ensure 'flows' or 'flow_definitions' table exists with repository and branch columns.`);
          }
        } catch (error: any) {
          console.error(`[DO:${this.state.id}] Error loading flow definition: ${error.message}`);
          console.error(`[DO:${this.state.id}] Database error details: ${error.message}`);
          console.error(`[DO:${this.state.id}] Using placeholder values. Check if tables exist: 'flows' (with repo, branch columns) or 'flow_definitions'.`);
        }
      } else {
        console.warn(`[DO:${this.state.id}] FLOW_RUNS_DB not configured. Using placeholder values for repository and branch.`);
      }
      
      // Load steps from database
      const steps = await this.loadFlowStepsFromDB(flow_id);
      
      if (!steps || steps.length === 0) {
        return new Response(JSON.stringify({ error: `No steps found for flow: ${flow_id}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Adjust max iterations based on number of steps if not set by flow definition
      if (effectiveMaxIterations === 20) {
        effectiveMaxIterations = steps.length * 2; // Enough for all steps
      }
      
      // Create ultra-minimal conversation with values from flow definition
      this.conversation = {
        state: 'SENDING_STEP',
        initial_user_prompt: `Execute flow: ${flow_id}`,
        iteration: 0,
        repository: effectiveRepository,
        branch: effectiveBranch,
        max_iterations: effectiveMaxIterations,
        status: 'active',
        created_at: Date.now(),
        updated_at: Date.now(),
        deepseek_system: effectiveDeepseekSystem,
        project_facts: [],
        flow_id: flow_id,
        flow_steps: steps,
        current_step_index: 0
      };
      
      await this.state.storage.put('conversation', this.conversation);
      
      // Schedule alarm to send first step
      await this.state.storage.setAlarm(Date.now() + 1000);
      
      console.log(`[DO:${this.state.id}] Ultra-minimal flow initialized with ${steps.length} steps, repository: ${effectiveRepository}, branch: ${effectiveBranch}`);
      
      return new Response(JSON.stringify({
        success: true,
        flow_id: flow_id,
        repository: effectiveRepository,
        branch: effectiveBranch,
        steps_count: steps.length,
        database_available: databaseAvailable,
        repository_source: databaseAvailable && flowDefinition ? 'database' : 'placeholder',
        message: databaseAvailable && flowDefinition 
          ? 'Ultra-minimal flow execution started with repository and branch from database' 
          : 'Ultra-minimal flow execution started with placeholder repository and branch (database not available or flow definition not found)',
        warning: effectiveRepository === '[FLOW]' 
          ? 'Repository is placeholder "[FLOW]". OpenHands conversation may not work correctly without a valid repository.' 
          : undefined,
        conversation_id: this.state.id.toString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Start flow error: ${error.message}`);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // Helper to convert requires_task value to boolean (handles 0, 1, "0", "1", true, false)
  private convertRequiresTaskToBoolean(requiresTaskValue: any): boolean {
    if (requiresTaskValue === true || requiresTaskValue === 1 || requiresTaskValue === "1" || requiresTaskValue === "true") {
      return true;
    }
    return false; // Handles false, 0, "0", "false", null, undefined, etc.
  }

  // Helper to convert output value to boolean (handles 0, 1, "0", "1", true, false)
  private convertOutputToBoolean(outputValue: any): boolean {
    if (outputValue === true || outputValue === 1 || outputValue === "1" || outputValue === "true") {
      return true;
    }
    return false; // Handles false, 0, "0", "false", null, undefined, etc.
  }

  // Helper to send step response to output_url if output is enabled
  private async sendStepOutputIfEnabled(step: any, response: any): Promise<void> {
    if (!step) {
      console.log(`[DO:${this.state.id}] No step provided for output sending`);
      return;
    }

    // Check if output is enabled for this step
    const outputEnabled = this.convertOutputToBoolean(step.output);
    if (!outputEnabled) {
      console.log(`[DO:${this.state.id}] Output not enabled for step: ${step.title}`);
      return;
    }

    // Check if output_url is provided
    if (!step.output_url || !step.output_url.trim()) {
      console.log(`[DO:${this.state.id}] Output enabled but no output_url provided for step: ${step.title}`);
      return;
    }

    console.log(`[DO:${this.state.id}] Sending output for step "${step.title}" to: ${step.output_url}`);

    try {
      // Prepare headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Add Authorization header if output_auth_token is provided
      if (step.output_auth_token && step.output_auth_token.trim()) {
        headers['Authorization'] = `Bearer ${step.output_auth_token.trim()}`;
        console.log(`[DO:${this.state.id}] Added Authorization header for step "${step.title}"`);
      }

      // Check if this is a Cloudflare D1 API endpoint
      const isCloudflareD1Endpoint = step.output_url.includes('cloudflare.com/client/v4/accounts') && 
                                     step.output_url.includes('/d1/database/') && 
                                     step.output_url.includes('/query');
      
      let requestBody: string;
      
      // Try to parse response as JSON to determine if we should send it directly
      let parsedResponse: any = null;
      let responseString: string;
      let isJsonObject = false;
      
      // Convert response to string for logging and fallback
      if (typeof response === 'string') {
        responseString = response;
        try {
          parsedResponse = JSON.parse(response);
          console.log(`[DO:${this.state.id}] Successfully parsed string response as JSON`);
          // Check if it's a JSON object (not array, not primitive)
          isJsonObject = parsedResponse && typeof parsedResponse === 'object' && !Array.isArray(parsedResponse);
        } catch (parseError) {
          parsedResponse = null;
          console.log(`[DO:${this.state.id}] String response is not valid JSON: ${parseError.message}`);
        }
      } else if (typeof response === 'object' && response !== null) {
        // Response is already an object
        parsedResponse = response;
        responseString = JSON.stringify(response);
        console.log(`[DO:${this.state.id}] Response is already an object`);
        // Check if it's a JSON object (not array)
        isJsonObject = !Array.isArray(parsedResponse);
      } else {
        // Response is some other type (number, boolean, etc.)
        responseString = String(response);
        parsedResponse = null;
        console.log(`[DO:${this.state.id}] Response is not string or object, converting to string: ${typeof response}`);
      }
      
      // Determine if we should send the response directly or wrap it
      let sendDirectly = false;
      
      if (isCloudflareD1Endpoint) {
        // For Cloudflare D1 API, send directly only if it has a sql field
        if (parsedResponse && typeof parsedResponse === 'object' && parsedResponse.sql) {
          sendDirectly = true;
          console.log(`[DO:${this.state.id}] Sending direct SQL to Cloudflare D1 API: ${parsedResponse.sql.substring(0, 100)}...`);
        } else {
          console.log(`[DO:${this.state.id}] D1 endpoint but response doesn't contain 'sql' field or isn't valid JSON object`);
          if (parsedResponse) {
            console.log(`[DO:${this.state.id}] Parsed response type: ${typeof parsedResponse}, is object: ${typeof parsedResponse === 'object'}, keys: ${parsedResponse ? Object.keys(parsedResponse).join(', ') : 'none'}`);
          }
        }
      } else {
        // For non-D1 endpoints, send directly if it's a JSON object
        if (isJsonObject) {
          sendDirectly = true;
          console.log(`[DO:${this.state.id}] Sending JSON object directly to endpoint`);
          if (parsedResponse) {
            console.log(`[DO:${this.state.id}] JSON object keys: ${Object.keys(parsedResponse).join(', ')}`);
          }
        } else {
          console.log(`[DO:${this.state.id}] Response is not a JSON object (or is array/primitive), using wrapped format`);
        }
      }
      
      if (sendDirectly && parsedResponse) {
        // Send the parsed JSON object directly
        requestBody = JSON.stringify(parsedResponse);
      } else {
        // Wrap the response in metadata format
        requestBody = JSON.stringify({
          step_id: step.step_id,
          step_title: step.title,
          step_key: step.step_key,
          response: responseString,
          timestamp: Date.now(),
          flow_id: this.conversation?.flow_id,
          conversation_id: this.state.id.toString()
        });
      }

      // Send the POST request to output_url
      const fetchResponse = await fetch(step.output_url, {
        method: 'POST',
        headers: headers,
        body: requestBody
      });

      if (fetchResponse.ok) {
        console.log(`[DO:${this.state.id}] Successfully sent output for step "${step.title}"`);
      } else {
        console.error(`[DO:${this.state.id}] Failed to send output for step "${step.title}": ${fetchResponse.status} ${fetchResponse.statusText}`);
        const errorText = await fetchResponse.text();
        console.error(`[DO:${this.state.id}] Error response: ${errorText.substring(0, 500)}`);
      }
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Error sending output for step "${step.title}": ${error.message}`);
    }
  }

  // Helper to load flow steps from database
  private async loadFlowStepsFromDB(flowId: string): Promise<any[]> {
    if (!this.env.FLOW_RUNS_DB) {
      console.log(`[DO:${this.state.id}] FLOW_RUNS_DB not configured`);
      return [];
    }
    
    try {
      const result = await this.env.FLOW_RUNS_DB.prepare(
        'SELECT id as step_id, step_key, title, instructions as description, step_type, order_index, page_key, blocking, auto_fail_on_error, retryable, task_id, requires_task, CASE WHEN output_url IS NOT NULL AND output_url != \'\' THEN 1 ELSE 0 END as output, output_url, output_auth_token FROM flow_steps WHERE flow_id = ? ORDER BY order_index'
      ).bind(flowId).all();
      
      return result.results || [];
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Error loading steps: ${error.message}`);
      return [];
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

  private async handleTriggerNextIteration(): Promise<Response> {
    console.log(`[DO:${this.state.id}] Triggering next iteration`);
    
    try {
      // Only proceed if we have a conversation and it's in task execution mode
      if (!this.conversation || !this.conversation.task_execution_mode || !this.conversation.flow_id) {
        return new Response(JSON.stringify({
          error: 'Not in task execution mode or no flow_id',
          note: 'This endpoint only works for task-based flow execution'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const flowId = this.conversation.flow_id;
      
      // Load next task for the flow
      if (!this.env.FLOW_RUNS_DB) {
        return new Response(JSON.stringify({
          error: 'Database not configured',
          note: 'FLOW_RUNS_DB binding is required for task loading'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const { startTaskExecution } = await import('../services/database');
      const nextStep = await this.getNextStep();
      
      if (!nextStep) {
        // NO MORE STEPS - FLOW TERMINATION
        console.log(`[DO:${this.state.id}] No more steps for flow ${flowId}, terminating flow`);
        
        // Mark flow as completed in database
        try {
          const { updateFlowRunStatus } = await import('../services/database');
          await updateFlowRunStatus(this.env.FLOW_RUNS_DB, this.flowRunId!, 'completed');
        } catch (error: any) {
          console.error(`[DO:${this.state.id}] Error updating flow run status: ${error.message}`);
        }
        
        // Cancel alarms
        try {
          await this.state.storage.deleteAlarm();
        } catch (error) {
          // Ignore errors if no alarm exists
        }
        
        // Update conversation state
        this.conversation.state = 'DONE';
        this.conversation.status = 'stopped';
        this.conversation.updated_at = Date.now();
        await this.state.storage.put('conversation', this.conversation);
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Flow terminated - no more steps',
          flow_id: flowId,
          flow_run_id: this.flowRunId,
          state: 'DONE',
          note: 'All steps completed. Alarms cancelled. No further prompts.'
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // NEXT STEP EXISTS - INJECT AND CONTINUE
      console.log(`[DO:${this.state.id}] Loaded next step for flow ${flowId}: ${nextStep.title} (${nextStep.step_type})`);
      
      // Fetch task data if task_id is present OR if requires_task is true
      let taskData = null;
      let dynamicTaskId = null;
      
      // First try static task_id (only if non-empty string)
      if (nextStep.task_id && nextStep.task_id.trim() && this.env.FLOW_RUNS_DB) {
        try {
          taskData = await getTaskData(this.env.FLOW_RUNS_DB, nextStep.task_id);
          if (taskData) {
            console.log(`[DO:${this.state.id}] Loaded task data for task: ${nextStep.task_id}`);
          } else {
            console.log(`[DO:${this.state.id}] Task not found in FLOW_RUNS_DB: ${nextStep.task_id}`);
            // Clear taskData so we can try requires_task if set
            taskData = null;
          }
        } catch (error) {
          console.error(`[DO:${this.state.id}] Error loading task data from FLOW_RUNS_DB: ${error}`);
        }
      }
      
      // If no task data from task_id, try requires_task
      // Convert requires_task to boolean explicitly (database returns 0/1 as number or string)
      const requiresTask = this.convertRequiresTaskToBoolean(nextStep.requires_task);
      console.log(`[DO:${this.state.id}] Task injection debug (handleInitState): taskData=${!!taskData}, requiresTask=${requiresTask}, flowId=${flowId}, FLOW_RUNS_DB=${!!this.env.FLOW_RUNS_DB}`);
      if (!taskData && requiresTask && this.env.FLOW_RUNS_DB) {
        // Dynamic task assignment - get first pending task for this flow
        console.log(`[DO:${this.state.id}] Step requires dynamic task, fetching first pending task for flow: ${flowId}`);
        try {
          const pendingTask = await getFirstPendingTask(this.env.FLOW_RUNS_DB, flowId);
          if (pendingTask) {
            taskData = {
              title: pendingTask.title,
              description: pendingTask.description,
              payload: pendingTask.payload
            };
            dynamicTaskId = pendingTask.id;
            console.log(`[DO:${this.state.id}] Loaded first pending task: ${pendingTask.id} - ${pendingTask.title}`);
          } else {
            console.log(`[DO:${this.state.id}] No pending tasks found for flow: ${flowId}`);
          }
        } catch (error) {
          console.error(`[DO:${this.state.id}] Error loading first pending task: ${error}`);
        }
      }
      
      // Start tracking step execution (minimal observability)
      let executionStepId = null;
      try {
        const executionResult = await startTaskExecution(
          this.env.FLOW_RUNS_DB, 
          this.flowRunId!,
          nextStep.step_id
        );
        
        if (executionResult.success) {
          console.log(`[DO:${this.state.id}] Started tracking step execution: ${executionResult.execution_step_id}`);
          executionStepId = executionResult.execution_step_id;
          // Increment step index for next iteration
          await this.incrementStepIndex();
        }
      } catch (trackingError: any) {
        console.error(`[DO:${this.state.id}] Error tracking step execution: ${trackingError.message}`);
        // Continue even if tracking fails
      }
      
      // Build step prompt with step details
      let taskPrompt = `Execute step: ${nextStep.title}`;
      
      // Inject task data if available
      if (taskData) {
        taskPrompt += `\n\n=== TASK ===`;
        // Include task ID if available (from dynamicTaskId or nextStep.task_id)
        const taskId = dynamicTaskId || nextStep.task_id;
        if (taskId) {
          taskPrompt += `\nTask ID: ${taskId}`;
        }
        if (taskData.title) {
          taskPrompt += `\nTitle: ${taskData.title}`;
        }
        if (taskData.description) {
          taskPrompt += `\nDescription: ${taskData.description}`;
        }
        // Add payload if it's JSON and contains additional metadata
        if (taskData.payload && taskData.payload.trim().startsWith('{') && taskData.payload.trim().endsWith('}')) {
          try {
            const payloadObj = JSON.parse(taskData.payload);
            // Add non-instruction fields from payload
            const metadataFields = Object.entries(payloadObj)
              .filter(([key, value]) => key !== 'instructions' && typeof value === 'string')
              .map(([key, value]) => `${key}: ${value}`);
            
            if (metadataFields.length > 0) {
              taskPrompt += `\nAdditional Details:`;
              metadataFields.forEach(field => {
                taskPrompt += `\n- ${field}`;
              });
            }
          } catch (e) {
            // Not valid JSON, skip
            console.log(`[DO:${this.state.id}] Task payload is not valid JSON: ${e.message}`);
          }
        }
        taskPrompt += `\n=== END TASK ===\n`;
        // REMOVED: Instructions to mark task as complete
        // Task completion is handled automatically by the system
        
        // Store dynamic task ID if we fetched one
        if (dynamicTaskId) {
          // We could store this for tracking, but for now just log it
          console.log(`[DO:${this.state.id}] Using dynamic task ID: ${dynamicTaskId}`);
        }
      }
      
      if (nextStep.description) {
        taskPrompt += `\n${nextStep.description}`;
      }
      
      // Add step metadata for context
      taskPrompt += `\n\nStep Type: ${nextStep.step_type}`;
      if (nextStep.page_key) {
        taskPrompt += `\nPage: ${nextStep.page_key}`;
      }
      if (nextStep.blocking === false) {
        taskPrompt += `\nNote: This step is non-blocking - flow can continue even if this step fails`;
      }
      
      // Update conversation with new step
      this.conversation.current_task_id = nextStep.step_id;
      this.conversation.current_task_title = nextStep.title;
      this.conversation.current_task_description = nextStep.description || undefined;
      this.conversation.current_execution_step_id = executionStepId || undefined;
      this.conversation.current_step = nextStep;
      this.conversation.initial_user_prompt = taskPrompt;
      this.conversation.state = 'INIT';
      this.conversation.iteration = 0;
      this.conversation.updated_at = Date.now();
      
      await this.state.storage.put('conversation', this.conversation);
      
      // Schedule alarm to start execution
      await this.scheduleNextAlarm(ALARM_DELAY_INIT);
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Next step loaded and execution scheduled',
        flow_id: flowId,
        step: {
          step_id: nextStep.step_id,
          step_key: nextStep.step_key,
          title: nextStep.title,
          description: nextStep.description,
          step_type: nextStep.step_type
        },
        state: 'INIT',
        note: 'Step injected into prompt. Alarm scheduled for execution.'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error: any) {
      console.error(`[DO:${this.state.id}] Error triggering next iteration: ${error.message}`);
      return new Response(JSON.stringify({
        error: error.message,
        note: 'Failed to trigger next iteration'
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
          
        case 'SENDING_STEP':
          await this.handleSendingStepState();
          break;
          
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
    
    // Check if this is a flow execution and we should bypass DeepSeek
    if (this.conversation.flow_execution_mode && this.conversation.current_step) {
      // For flow execution, check if this is a decision step (Step 7)
      const isDecisionStep = this.conversation.current_step.step_key === 'gap_analysis';
      
      if (!isDecisionStep) {
        // For non-decision steps, send directly to OpenHands
        console.log(`[DO:${this.state.id}] ====== ROUTING VALIDATION ======`);
        console.log(`[DO:${this.state.id}] Step: ${(this.conversation.current_step_index || 0) + 1}`);
        console.log(`[DO:${this.state.id}] Step Key: ${this.conversation.current_step.step_key}`);
        console.log(`[DO:${this.state.id}] DeepSeek called: false (bypassing for execution step)`);
        console.log(`[DO:${this.state.id}] Payload to OpenHands (first 500 chars): ${this.conversation.initial_user_prompt.substring(0, 500)}...`);
        console.log(`[DO:${this.state.id}] ====== END VALIDATION ======`);
        
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
        
        // For flow execution mode, we need to send the command as if DeepSeek said it
        // Remove the user message (created by buildInitialMessages) and replace with assistant message
        // OpenHands expects: Assistant (DeepSeek) gives command → User (OpenHands) executes
        this.conversation.conversation_messages = [
          ...initialMessages.filter(m => m.role !== 'user'), // Keep system message if any
          {
            role: 'assistant',
            content: this.conversation.initial_user_prompt // This contains the exact command from DB
          }
        ];
        
        this.conversation.last_deepseek_response = this.conversation.initial_user_prompt;
        this.conversation.deepseek_response_pending = false;
        
        // Transition to WAITING_OPENHANDS state
        this.conversation.state = 'WAITING_OPENHANDS';
        console.log(`[DO:${this.state.id}] Transitioned to WAITING_OPENHANDS for flow step execution`);
        return;
      } else {
        // This is a decision step (Step 7) - log that we're sending to DeepSeek
        console.log(`[DO:${this.state.id}] ====== ROUTING VALIDATION ======`);
        console.log(`[DO:${this.state.id}] Step: 7 (gap_analysis)`);
        console.log(`[DO:${this.state.id}] DeepSeek called: true (decision step)`);
        console.log(`[DO:${this.state.id}] ====== END VALIDATION ======`);
      }
    }
    
    // Normal flow: send to DeepSeek
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
    
    // Complete if either AI says done OR external verification passes
    if (doneData.done || verificationResult.shouldComplete) {
      const reason = doneData.done ? 'deepseek_done' : `external_verification: ${verificationResult.completionReason}`;
      console.log(`[DO:${this.state.id}] Completion triggered: ${reason}`);
      console.log(`[DO:${this.state.id}] Verification details: ${JSON.stringify(verificationResult.verificationResult)}`);
      
      await this.handleDoneResponse(deepseekResult.response!, reason);
      await this.stopConversation(reason);
      return;
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
    // For flow execution mode, we don't need contentToSend - just need to know agent is done
    const isFlowExecution = this.conversation.flow_steps && this.conversation.flow_steps.length > 0;
    
    if (agentAwaitingInput && (contentToSend || isFlowExecution)) {
      iterationCompleted = true;
      console.log(`[DO:${this.state.id}] Iteration ${this.conversation.iteration} completed! Agent awaiting input${contentToSend ? ` with content (${contentToSend.length} chars)` : ' (flow execution mode)'}`);
      
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
    
    // Safety check: Only process if we're actually in ITERATION_COMPLETE state
    // This prevents duplicate processing if webhook retries
    if (this.conversation.state !== 'ITERATION_COMPLETE') {
      console.log(`[DO:${this.state.id}] Not in ITERATION_COMPLETE state (current: ${this.conversation.state}), skipping`);
      return;
    }
    
    // Check if this is ultra-minimal flow mode
    if (this.conversation.flow_steps && (this.conversation.current_step_index !== undefined && this.conversation.current_step_index !== null)) {
      // Ultra-minimal flow mode: Go to next step
      console.log(`[DO:${this.state.id}] Ultra-minimal flow mode: Moving to next step`);
      
      // Extract response from pending_event_content for conditional branching
      if (this.conversation.pending_event_content) {
        try {
          // Try to parse as JSON to extract status
          const content = this.conversation.pending_event_content.trim();
          if (content.startsWith('{') && content.endsWith('}')) {
            const parsed = JSON.parse(content);
            // Extract status field if present
            if (parsed.status) {
              this.conversation.last_step_response = `Status: ${parsed.status}`;
              console.log(`[DO:${this.state.id}] Extracted status from response: ${parsed.status}`);
              // Send output if enabled for current step
              if (this.conversation.current_step) {
                await this.sendStepOutputIfEnabled(this.conversation.current_step, `Status: ${parsed.status}`);
              }
            } else {
              // Use the full content as response
              this.conversation.last_step_response = content;
              console.log(`[DO:${this.state.id}] Using full content as step response (${content.length} chars)`);
              // Send output if enabled for current step
              if (this.conversation.current_step) {
                await this.sendStepOutputIfEnabled(this.conversation.current_step, content);
              }
            }
          } else {
            // Not JSON, use as-is
            this.conversation.last_step_response = content;
            console.log(`[DO:${this.state.id}] Using non-JSON content as step response (${content.length} chars)`);
            // Send output if enabled for current step
            if (this.conversation.current_step) {
              await this.sendStepOutputIfEnabled(this.conversation.current_step, content);
            }
          }
        } catch (error) {
          // If JSON parsing fails, use as-is
          console.log(`[DO:${this.state.id}] Failed to parse JSON, using content as-is: ${error}`);
          this.conversation.last_step_response = this.conversation.pending_event_content;
          // Send output if enabled for current step
          if (this.conversation.current_step && this.conversation.pending_event_content) {
            await this.sendStepOutputIfEnabled(this.conversation.current_step, this.conversation.pending_event_content);
          }
        }
      }
      
      // Clear pending event content (not needed for ultra-minimal flow)
      this.conversation.pending_event_content = undefined;
      
      // Increment step index since current step has completed
      // This ensures we move to the next step in sequential execution
      // For conditional branching, getNextStep() already updated current_step_index to the target step
      // So incrementing here moves us to the step after the conditional target
      await this.incrementStepIndex();
      
      this.conversation.state = 'SENDING_STEP';
      
      // Save state
      await this.state.storage.put('conversation', this.conversation);
      
      // Process immediately
      await this.handleSendingStepState();
    } else {
      // Regular mode: Go to DeepSeek for next instructions
      this.conversation.state = 'AWAITING_NEXT_ITERATION';
      
      // Save state
      await this.state.storage.put('conversation', this.conversation);
      
      // Process immediately
      await this.handleAwaitingNextIterationState();
    }
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
    
    // Check if this is flow execution mode
    if (this.conversation.flow_execution_mode) {
      console.log(`[DO:${this.state.id}] Flow execution mode: Getting next step for flow ${this.conversation.flow_id}`);
      
      // Get next step from database
      const nextStep = await this.getNextStep();
      
      if (!nextStep) {
        console.log(`[DO:${this.state.id}] No more steps in flow, completing flow execution`);
        await this.stopConversation('flow_completed');
        return;
      }
      
      // Check if this is a decision step (Step 7 - gap_analysis)
      const isDecisionStep = nextStep.step_key === 'gap_analysis';
      
      if (!isDecisionStep) {
        // EXECUTION STEP: Send directly to OpenHands
        console.log(`[DO:${this.state.id}] ====== ROUTING VALIDATION ======`);
        console.log(`[DO:${this.state.id}] Step: ${(this.conversation.current_step_index || 0) + 1}`);
        console.log(`[DO:${this.state.id}] Step Key: ${nextStep.step_key}`);
        console.log(`[DO:${this.state.id}] DeepSeek called: false (bypassing for execution step)`);
        console.log(`[DO:${this.state.id}] Payload to OpenHands (first 500 chars): ${nextStep.description ? nextStep.description.substring(0, 500) : 'No description'}...`);
        console.log(`[DO:${this.state.id}] ====== END VALIDATION ======`);
        
        // Build step command
        let stepCommand = `Execute step: ${nextStep.title}`;
        if (nextStep.description) {
          stepCommand += `\n${nextStep.description}`;
        }
        stepCommand += `\n\nStep Type: ${nextStep.step_type}`;
        if (nextStep.page_key) {
          stepCommand += `\nPage: ${nextStep.page_key}`;
        }
        if (nextStep.blocking === false) {
          stepCommand += `\nNote: This step is non-blocking - flow can continue even if this step fails`;
        }
        
        // Check for task injection (similar to handleSendingStepState logic)
        // Priority: 1. Static task_id, 2. Dynamic requires_task
        let taskInjected = false;
        
        // Only check task_id if it's a non-empty string (truthy)
        if (nextStep.task_id && nextStep.task_id.trim() && this.env.FLOW_RUNS_DB) {
          console.log(`[DO:${this.state.id}] Step has static task_id: ${nextStep.task_id}`);
          try {
            const { getTaskData } = await import('../services/database');
            const taskData = await getTaskData(this.env.FLOW_RUNS_DB, nextStep.task_id);
            if (taskData) {
              stepCommand += `\n\n=== TASK ===`;
              stepCommand += `\nTask ID: ${nextStep.task_id}`;
              stepCommand += `\nTitle: ${taskData.title}`;
              if (taskData.description) {
                stepCommand += `\nDescription: ${taskData.description}`;
              }
              // Add payload if it's JSON and contains additional metadata
              if (taskData.payload && taskData.payload.trim().startsWith('{') && taskData.payload.trim().endsWith('}')) {
                try {
                  const payloadObj = JSON.parse(taskData.payload);
                  // Add non-instruction fields from payload
                  const metadataFields = Object.entries(payloadObj)
                    .filter(([key, value]) => key !== 'instructions' && typeof value === 'string')
                    .map(([key, value]) => `${key}: ${value}`);
                  
                  if (metadataFields.length > 0) {
                    stepCommand += `\nAdditional Details:`;
                    metadataFields.forEach(field => {
                      stepCommand += `\n- ${field}`;
                    });
                  }
                } catch (e) {
                  // Not valid JSON, skip
                  console.log(`[DO:${this.state.id}] Task payload is not valid JSON: ${e.message}`);
                }
              }
              stepCommand += `\n=== END TASK ===\n`;
              // REMOVED: Instructions to mark task as complete
              // Task completion is handled automatically by the system
              console.log(`[DO:${this.state.id}] Injected task: ${taskData.title} (ID: ${nextStep.task_id})`);
              taskInjected = true;
            }
          } catch (error: any) {
            console.error(`[DO:${this.state.id}] Error fetching task data: ${error.message}`);
          }
        }
        
        // If task_id didn't work or wasn't set, try requires_task
        // Convert requires_task to boolean explicitly (database returns 0/1 as number or string)
        const requiresTask = this.convertRequiresTaskToBoolean(nextStep.requires_task);
        console.log(`[DO:${this.state.id}] Task injection debug (handleAwaitingNextIterationState): taskInjected=${taskInjected}, requiresTask=${requiresTask}, flow_id=${this.conversation.flow_id}, FLOW_RUNS_DB=${!!this.env.FLOW_RUNS_DB}`);
        if (!taskInjected && requiresTask && this.conversation.flow_id && this.env.FLOW_RUNS_DB) {
          console.log(`[DO:${this.state.id}] Step requires dynamic task, fetching first pending task for flow: ${this.conversation.flow_id}`);
          try {
            const { getFirstPendingTask } = await import('../services/database');
            const pendingTask = await getFirstPendingTask(this.env.FLOW_RUNS_DB, this.conversation.flow_id);
            if (pendingTask) {
              stepCommand += `\n\n=== TASK ===`;
              stepCommand += `\nTask ID: ${pendingTask.id}`;
              stepCommand += `\nTitle: ${pendingTask.title}`;
              if (pendingTask.description) {
                stepCommand += `\nDescription: ${pendingTask.description}`;
              }
              // Add payload if it's JSON and contains additional metadata
              if (pendingTask.payload && pendingTask.payload.trim().startsWith('{') && pendingTask.payload.trim().endsWith('}')) {
                try {
                  const payloadObj = JSON.parse(pendingTask.payload);
                  // Add non-instruction fields from payload
                  const metadataFields = Object.entries(payloadObj)
                    .filter(([key, value]) => key !== 'instructions' && typeof value === 'string')
                    .map(([key, value]) => `${key}: ${value}`);
                  
                  if (metadataFields.length > 0) {
                    stepCommand += `\nAdditional Details:`;
                    metadataFields.forEach(field => {
                      stepCommand += `\n- ${field}`;
                    });
                  }
                } catch (e) {
                  // Not valid JSON, skip
                  console.log(`[DO:${this.state.id}] Task payload is not valid JSON: ${e.message}`);
                }
              }
              stepCommand += `\n=== END TASK ===\n`;
              // REMOVED: Instructions to mark task as complete
              // Task completion is handled automatically by the system
              console.log(`[DO:${this.state.id}] Injected task: ${pendingTask.title} (ID: ${pendingTask.id})`);
              taskInjected = true;
            } else {
              console.log(`[DO:${this.state.id}] No pending tasks found for flow: ${this.conversation.flow_id}`);
            }
          } catch (error: any) {
            console.error(`[DO:${this.state.id}] Error fetching pending task: ${error.message}`);
          }
        }
        
        // Store step in conversation for reference
        this.conversation.current_step = nextStep;
        
        // Start tracking step execution
        try {
          const { startTaskExecution } = await import('../services/database');
          const executionResult = await startTaskExecution(
            this.env.FLOW_RUNS_DB, 
            this.flowRunId!,
            nextStep.step_id
          );
          
          if (executionResult.success) {
            console.log(`[DO:${this.state.id}] Started tracking step execution: ${executionResult.execution_step_id}`);
            this.conversation.current_execution_step_id = executionResult.execution_step_id;
          }
        } catch (trackingError: any) {
          console.error(`[DO:${this.state.id}] Error tracking step execution: ${trackingError.message}`);
          // Continue even if tracking fails
        }
        
        // Increment step index for next iteration
        await this.incrementStepIndex();
        
        // Send step command directly to OpenHands (bypassing DeepSeek)
        // Add to conversation messages as if DeepSeek sent it
        this.conversation.conversation_messages!.push({
          role: 'assistant',
          content: stepCommand
        });
        
        this.conversation.last_deepseek_response = stepCommand;
        this.conversation.deepseek_response_pending = false;
        
        // Transition to WAITING_OPENHANDS state
        this.conversation.state = 'WAITING_OPENHANDS';
        console.log(`[DO:${this.state.id}] Transitioned to WAITING_OPENHANDS for execution step ${nextStep.step_key}`);
        return;
      } else {
        // DECISION STEP: Get OpenHands report and send to DeepSeek
        console.log(`[DO:${this.state.id}] ====== ROUTING VALIDATION ======`);
        console.log(`[DO:${this.state.id}] Step: 7 (gap_analysis)`);
        console.log(`[DO:${this.state.id}] DeepSeek called: true (decision step)`);
        console.log(`[DO:${this.state.id}] Getting OpenHands report for decision analysis`);
        console.log(`[DO:${this.state.id}] ====== END VALIDATION ======`);
        
        // Get OpenHands conversation to find the last message (report)
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
        // Find the agent's last message (report)
        let reportContent = '';
        const chronologicalEvents = [...events].reverse();
        
        for (let i = 0; i < chronologicalEvents.length; i++) {
          const event = chronologicalEvents[i];
          if (event.observation === 'agent_state_changed' && event.extras?.agent_state === 'awaiting_user_input') {
            if (i > 0) {
              const prevEvent = chronologicalEvents[i - 1];
              reportContent = prevEvent.message || prevEvent.args?.content || prevEvent.content || '';
              if (reportContent) break;
            }
            break;
          }
        }
        
        if (reportContent) {
          console.log(`[DO:${this.state.id}] Found OpenHands report (${reportContent.length} chars), sending to DeepSeek for decision`);
          console.log(`[DO:${this.state.id}] Report preview (first 300 chars): ${reportContent.substring(0, 300)}...`);
          
          // Store step in conversation for reference
          this.conversation.current_step = nextStep;
          
          // Send report to DeepSeek for decision
          await this.sendToDeepSeek(reportContent);
        } else {
          console.log(`[DO:${this.state.id}] No OpenHands report found, sending generic message to DeepSeek`);
          await this.sendToDeepSeek(`OpenHands completed previous step. Please analyze and decide next action for step: ${nextStep.title}`);
        }
        return;
      }
    }
    
    // NON-FLOW MODE: Original logic - always send to DeepSeek
    console.log(`[DO:${this.state.id}] Non-flow mode: Getting OpenHands response to send to DeepSeek`);
    
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
    
    // Complete if either AI says done OR external verification passes
    if (doneData.done || verificationResult.shouldComplete) {
      const reason = doneData.done ? 'deepseek_done' : `external_verification: ${verificationResult.completionReason}`;
      console.log(`[DO:${this.state.id}] Completion triggered: ${reason}`);
      console.log(`[DO:${this.state.id}] Verification details: ${JSON.stringify(verificationResult.verificationResult)}`);
      
      await this.handleDoneResponse(deepseekResult.response!, reason);
      await this.stopConversation(reason);
      return;
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

  // Ultra-minimal flow execution: Send step directly to OpenHands
  private async handleSendingStepState(): Promise<void> {
    if (!this.conversation) return;
    
    console.log(`[DO:${this.state.id}] SENDING_STEP: Sending step to OpenHands`);
    
    // Check if we have flow steps
    if (!this.conversation.flow_steps || this.conversation.flow_steps.length === 0) {
      console.log(`[DO:${this.state.id}] No flow steps available`);
      await this.stopConversation('no_flow_steps');
      return;
    }
    
    // Get next step using conditional branching logic
    const step = await this.getNextStep();
    
    if (!step) {
      console.log(`[DO:${this.state.id}] No more steps in flow`);
      await this.stopConversation('flow_completed');
      return;
    }
    
    console.log(`[DO:${this.state.id}] Sending step: ${step.title} (order_index: ${step.order_index})`);
    
    // Update current_step to track which step is being executed
    this.conversation.current_step = step;
    
    // Build the prompt with step instructions
    let prompt = `Execute step: ${step.title}`;
    
    // Check for task injection
    // Priority: 1. Static task_id, 2. Dynamic requires_task
    let taskInjected = false;
    
    // Only check task_id if it's a non-empty string (truthy)
    if (step.task_id && step.task_id.trim() && this.env.FLOW_RUNS_DB) {
      console.log(`[DO:${this.state.id}] Step has static task_id: ${step.task_id}`);
      try {
        const { getTaskData } = await import('../services/database');
        const taskData = await getTaskData(this.env.FLOW_RUNS_DB, step.task_id);
        if (taskData) {
          prompt += `\n\n=== TASK ===`;
          prompt += `\nTask ID: ${step.task_id}`;
          prompt += `\nTitle: ${taskData.title}`;
          if (taskData.description) {
            prompt += `\nDescription: ${taskData.description}`;
          }
          // Add payload if it's JSON and contains additional metadata
          if (taskData.payload && taskData.payload.trim().startsWith('{') && taskData.payload.trim().endsWith('}')) {
            try {
              const payloadObj = JSON.parse(taskData.payload);
              // Add non-instruction fields from payload
              const metadataFields = Object.entries(payloadObj)
                .filter(([key, value]) => key !== 'instructions' && typeof value === 'string')
                .map(([key, value]) => `${key}: ${value}`);
              
              if (metadataFields.length > 0) {
                prompt += `\nAdditional Details:`;
                metadataFields.forEach(field => {
                  prompt += `\n- ${field}`;
                });
              }
            } catch (e) {
              // Not valid JSON, skip
              console.log(`[DO:${this.state.id}] Task payload is not valid JSON: ${e.message}`);
            }
          }
          prompt += `\n=== END TASK ===\n`;
          // REMOVED: Instructions to mark task as complete
          // Task completion is handled automatically by the system
          console.log(`[DO:${this.state.id}] Injected task: ${taskData.title} (ID: ${step.task_id})`);
          taskInjected = true;
        } else {
          console.log(`[DO:${this.state.id}] Task not found with ID: ${step.task_id}, will try requires_task if set`);
        }
      } catch (error: any) {
        console.error(`[DO:${this.state.id}] Error fetching task data: ${error.message}`);
      }
    }
    
    // If task_id didn't work or wasn't set, try requires_task
    // Convert requires_task to boolean explicitly (database returns 0/1 as number or string)
    console.log(`[DO:${this.state.id}] Step requires_task value: ${step.requires_task} (type: ${typeof step.requires_task})`);
    console.log(`[DO:${this.state.id}] Step object keys: ${Object.keys(step).join(', ')}`);
    
    // FALLBACK: If step doesn't have requires_task, check flow_steps array
    let effectiveRequiresTask = step.requires_task;
    if (effectiveRequiresTask === undefined && this.conversation.flow_steps && this.conversation.current_step_index !== undefined) {
      const flowStep = this.conversation.flow_steps[this.conversation.current_step_index];
      if (flowStep && flowStep.requires_task !== undefined) {
        console.log(`[DO:${this.state.id}] Using requires_task from flow_steps array: ${flowStep.requires_task}`);
        effectiveRequiresTask = flowStep.requires_task;
      }
    }
    
    const requiresTask = this.convertRequiresTaskToBoolean(effectiveRequiresTask);
    console.log(`[DO:${this.state.id}] Task injection debug: taskInjected=${taskInjected}, requiresTask=${requiresTask}, flow_id=${this.conversation.flow_id}, FLOW_RUNS_DB=${!!this.env.FLOW_RUNS_DB}`);
    
    // Declare pendingTask variable outside the if block for debug storage
    let pendingTask: any = null;
    
    if (!taskInjected && requiresTask && this.conversation.flow_id && this.env.FLOW_RUNS_DB) {
      console.log(`[DO:${this.state.id}] Step requires dynamic task, fetching first pending task for flow: "${this.conversation.flow_id}"`);
      try {
        const { getFirstPendingTask } = await import('../services/database');
        console.log(`[DO:${this.state.id}] Calling getFirstPendingTask with flow_id: "${this.conversation.flow_id}"`);
        pendingTask = await getFirstPendingTask(this.env.FLOW_RUNS_DB, this.conversation.flow_id);
        console.log(`[DO:${this.state.id}] getFirstPendingTask returned:`, pendingTask);
        console.log(`[DO:${this.state.id}] Task object details:`, pendingTask ? {
          id: pendingTask.id,
          title: pendingTask.title,
          descriptionLength: pendingTask.description?.length || 0,
          payloadLength: pendingTask.payload?.length || 0
        } : 'No task');
        if (pendingTask) {
          prompt += `\n\n=== TASK ===`;
          prompt += `\nTask ID: ${pendingTask.id}`;
          prompt += `\nTitle: ${pendingTask.title}`;
          if (pendingTask.description) {
            prompt += `\nDescription: ${pendingTask.description}`;
          }
          // Add payload if it's JSON and contains additional metadata
          if (pendingTask.payload && pendingTask.payload.trim().startsWith('{') && pendingTask.payload.trim().endsWith('}')) {
            try {
              const payloadObj = JSON.parse(pendingTask.payload);
              // Add non-instruction fields from payload
              const metadataFields = Object.entries(payloadObj)
                .filter(([key, value]) => key !== 'instructions' && typeof value === 'string')
                .map(([key, value]) => `${key}: ${value}`);
              
              if (metadataFields.length > 0) {
                prompt += `\nAdditional Details:`;
                metadataFields.forEach(field => {
                  prompt += `\n- ${field}`;
                });
              }
            } catch (e) {
              // Not valid JSON, skip
              console.log(`[DO:${this.state.id}] Task payload is not valid JSON: ${e.message}`);
            }
          }
          prompt += `\n=== END TASK ===\n`;
          // REMOVED: Instructions to mark task as complete
          // Task completion is handled automatically by the system
          console.log(`[DO:${this.state.id}] Injected task: ${pendingTask.title} (ID: ${pendingTask.id})`);
          taskInjected = true;
        } else {
          console.log(`[DO:${this.state.id}] No pending tasks found for flow: ${this.conversation.flow_id}`);
        }
      } catch (error: any) {
        console.error(`[DO:${this.state.id}] Error fetching pending task: ${error.message}`);
      }
    }
    
    // Add step instructions
    // Note: StepData interface has 'description' field, not 'instructions'
    console.log(`[DO:${this.state.id}] Step description length: ${step.description?.length || 0} chars`);
    if (step.description) {
      prompt += `\n\n${step.description}`;
    }
    
    console.log(`[DO:${this.state.id}] Final prompt length: ${prompt.length} chars`);
    console.log(`[DO:${this.state.id}] Final prompt preview: ${prompt.substring(0, 200)}...`);
    
    // Store debug information for observability
    this.conversation.last_step_debug = {
      step_id: step.step_id,
      step_title: step.title,
      requires_task: effectiveRequiresTask,
      requires_task_converted: requiresTask,
      task_injected: taskInjected,
      task_found: !!pendingTask,
      task_id: pendingTask?.id,
      task_title: pendingTask?.title,
      prompt_preview: prompt.substring(0, 500),
      prompt_length: prompt.length,
      timestamp: Date.now()
    };
    
    // Create OpenHands conversation if needed
    if (!this.conversation.openhands_conversation_id) {
      console.log(`[DO:${this.state.id}] Creating new OpenHands conversation`);
      const createResult = await createOpenHandsConversation(
        this.env.OPENHANDS_API_URL,
        prompt,
        this.conversation.repository,
        this.conversation.branch
      );
      
      if (!createResult.success) {
        console.error(`[DO:${this.state.id}] Failed to create OpenHands conversation: ${createResult.error}`);
        await this.scheduleNextAlarm(10000); // Retry in 10 seconds
        return;
      }
      
      this.conversation.openhands_conversation_id = createResult.conversationId;
      console.log(`[DO:${this.state.id}] Created OpenHands conversation: ${this.conversation.openhands_conversation_id}`);
    } else {
      // Inject message to existing conversation
      console.log(`[DO:${this.state.id}] Injecting message to existing OpenHands conversation: ${this.conversation.openhands_conversation_id}`);
      const injectResult = await injectMessageToOpenHands(
        this.env.OPENHANDS_API_URL,
        this.conversation.openhands_conversation_id,
        prompt
      );
      
      if (!injectResult.success) {
        console.error(`[DO:${this.state.id}] Failed to inject message: ${injectResult.error}`);
        await this.scheduleNextAlarm(10000); // Retry in 10 seconds
        return;
      }
    }
    
    // Update state to wait for OpenHands response
    this.conversation.state = 'WAITING_OPENHANDS';
    this.conversation.iteration = (this.conversation.iteration || 0) + 1;
    // Note: current_step_index is already updated by getNextStep() based on conditional branching
    console.log(`[DO:${this.state.id}] Step sent, waiting for OpenHands response. Current step index: ${this.conversation.current_step_index}`);
    
    // Schedule next alarm to check for response
    // Use shorter interval for flow execution (5 seconds) vs regular (30 seconds)
    const pollInterval = this.conversation.flow_steps ? 5000 : 30000;
    await this.scheduleNextAlarm(pollInterval); // Check in 5 seconds for flow, 30 seconds for regular
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