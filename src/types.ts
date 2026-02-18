// Shared types for DeepSeek Agent

// Cloudflare bindings
export interface CloudflareBindings {
  DEEPSEEK_API_KEY: string;
  OPENHANDS_API_URL: string;
  CONVERSATIONS: DurableObjectNamespace;
  FLOW_RUNS_DB?: D1Database; // Optional - may not be configured
  RATE_LIMIT_KV?: KVNamespace; // Optional - for rate limiting
}

// Conversation state machine
export type ConversationState = 'INIT' | 'WAITING_OPENHANDS' | 'ITERATION_COMPLETE' | 'AWAITING_NEXT_ITERATION' | 'DONE';

// Conversation data (persisted in Durable Object storage)
export interface ConversationData {
  // Required persisted fields
  state: ConversationState;
  initial_user_prompt: string;
  openhands_conversation_id?: string;
  last_sent_event_id?: number; // Track last sent event ID for idempotency
  iteration: number;
  
  // Additional metadata
  repository: string;
  branch?: string;
  max_iterations: number;
  
  // Current status
  status: 'active' | 'stopped' | 'error';
  error_message?: string;
  
  // Tracking
  last_deepseek_response?: string;
  last_openhands_response?: string;
  created_at: number;
  updated_at: number;
  
  // Cooldown tracking for event processing
  pending_event_content?: string;
  pending_event_id?: number;
  last_event_seen_at?: number; // Timestamp when we last saw an event
  cooldown_started_at?: number; // Timestamp when cooldown period started
  
  // Error tracking for OpenHands API
  openhands_error_count?: number; // Consecutive OpenHands API errors
  
  // DeepSeek system message (optional, set via API)
  deepseek_system?: string;
  
  // DeepSeek conversation history (maintains context across iterations)
  conversation_messages?: DeepSeekMessage[];
  


  // Iteration completion tracking
  pending_actions?: PendingAction[]; // Track ActionEvents waiting for ObservationEvents
  iteration_started_at?: number; // When current iteration started
  last_iteration_summary?: string; // Summary of what was done in last iteration
  
  // Aggressive mode tracking
  restart_count?: number; // Number of times conversation has been auto-restarted
  
  // DeepSeek response tracking
  last_deepseek_request_at?: number; // When we last sent a request to DeepSeek
  deepseek_response_pending?: boolean; // Whether we're waiting for DeepSeek response
  
  // Adaptive polling optimization
  current_poll_interval?: number; // Current polling interval in ms
  last_activity_at?: number; // When we last saw activity
  consecutive_idle_checks?: number; // Number of consecutive checks with no activity

  // Flow execution mode
  flow_id?: string; // Flow ID for flow-based execution
  flow_execution_mode?: boolean; // Flag to indicate flow execution mode
  current_flow_step?: number; // Current step in flow execution
  flow_steps_completed?: number[]; // Array of completed step numbers
  current_step?: StepData; // Current step data for flow execution
  last_step_response?: string; // Response from the last completed step (for conditional branching)

  // Task-based execution (deterministic task system)
  current_task_id?: string; // Current task ID being executed
  current_task_title?: string; // Title of current task (for prompt injection)
  current_task_description?: string; // Description of current task (for prompt injection)
  task_execution_mode?: boolean; // Flag to indicate task-based execution mode
  current_execution_step_id?: string; // ID of current task execution step for tracking
  
  // Flow context from database
  flow_context?: {
    definition?: any;
    has_project_context: boolean;
    has_testing_priorities: boolean;
    has_api_commands: boolean;
  };
}

// OpenHands event types
export interface OpenHandsEvent {
  id: number;
  timestamp: string;
  source: string;
  message: string;
  action: string;
  observation?: string;
  args?: {
    content?: string;
    tool_call_id?: string;
    [key: string]: any;
  };
  content?: string;
  extras?: {
    agent_state?: string;
    [key: string]: any;
  };
}

// Pending action tracking
export interface PendingAction {
  tool_call_id: string;
  action_type: string;
  started_at: number;
  event_id: number;
  description?: string;
}

export interface OpenHandsEventsResponse {
  events: OpenHandsEvent[];
}

// OpenHands message types (deprecated - use events instead)
export interface OpenHandsMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

export interface OpenHandsConversation {
  conversation_id: string;
  status: string;
  agent_state: string;
  messages?: OpenHandsMessage[];
}

// DeepSeek API types
export interface DeepSeekMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface DeepSeekRequest {
  model: string;
  messages: DeepSeekMessage[];
  temperature: number;
  max_tokens: number;
}

export interface DeepSeekResponse {
  id: string;
  choices: Array<{
    message: DeepSeekMessage;
    finish_reason: string;
  }>;
}

// Service result types
export interface DeepSeekResult {
  success: boolean;
  response?: string;
  error?: string;
}

export interface OpenHandsCreateResult {
  success: boolean;
  conversationId?: string;
  error?: string;
}

export interface OpenHandsStatusResult {
  success: boolean;
  events?: OpenHandsEvent[];
  error?: string;
}

export interface OpenHandsInjectResult {
  success: boolean;
  error?: string;
}

// Flow run types for D1 database
export interface FlowRunData {
  id: string;
  conversation_id: string;
  initial_prompt: string;
  deepseek_system?: string;
  repository: string;
  branch?: string;
  max_iterations: number;
  actual_iterations: number;
  status: 'active' | 'completed' | 'failed' | 'stopped' | 'new_flow_started';
  stop_reason?: string;
  prompts_and_responses: string; // JSON string
  created_at: number;
  updated_at: number;
  ended_at?: number;
  next_flow_id?: string;
  // Future AI-determined fields
  task_type?: string;
  success_score?: number;
  quality_metrics?: string; // JSON string
  deployment_id?: string;
  improvement_suggestions?: string;
}

export interface IterationData {
  id?: number;
  flow_run_id: string;
  iteration_number: number;
  prompt: string;
  response: string;
  openhands_response?: string;
  timestamp: number;
  metadata?: string; // JSON string
}

export interface DoneResponseData {
  done: boolean;
  new_prompt?: string;
  new_deepseek_system?: string;
  new_branch?: string;
  is_end_flow_early?: boolean;
  stop_reason?: string;
}



// Task data for deterministic task system
export interface TaskData {
  task_id: string;
  title: string;
  description: string | null;
  task_type: 'TASK' | 'FOLLOWUP';
  parent_task_id: string | null;
}

// Step data for flow execution steps
export interface StepData {
  step_id: string;
  step_key: string;
  title: string;
  description: string | null;
  step_type: string;
  order_index: number;
  page_key: string | null;
  blocking: boolean;
  auto_fail_on_error: boolean;
  retryable: boolean;
  task_id?: string;
  requires_task?: boolean;
}