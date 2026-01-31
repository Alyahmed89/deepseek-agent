// Shared types for DeepSeek Agent

// Cloudflare bindings
export interface CloudflareBindings {
  DEEPSEEK_API_KEY: string;
  OPENHANDS_API_URL: string;
  CONVERSATIONS: DurableObjectNamespace;
}

// Conversation state machine
export type ConversationState = 'INIT' | 'WAITING_OPENHANDS' | 'DONE';

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
}

// OpenHands event types
export interface OpenHandsEvent {
  id: number;
  timestamp: string;
  source: string;
  message: string;
  action: string;
  args?: {
    content?: string;
    [key: string]: any;
  };
  content?: string;
  extras?: {
    agent_state?: string;
    [key: string]: any;
  };
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
  agent_state?: string;
  messages?: OpenHandsMessage[];
  events?: OpenHandsEvent[];
  error?: string;
}

export interface OpenHandsInjectResult {
  success: boolean;
  error?: string;
}