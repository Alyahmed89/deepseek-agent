-- Migration 0002: Create conversations table (replaces Durable Objects)
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'INIT', -- 'INIT', 'WAITING_OPENHANDS', 'ITERATION_COMPLETE', 'AWAITING_NEXT_ITERATION', 'DONE'
  initial_user_prompt TEXT NOT NULL,
  openhands_conversation_id TEXT,
  iteration INTEGER NOT NULL DEFAULT 0,
  repository TEXT NOT NULL,
  branch TEXT DEFAULT 'main',
  max_iterations INTEGER DEFAULT 20,
  status TEXT DEFAULT 'active', -- 'active', 'stopped', 'error'
  error_message TEXT,
  last_deepseek_response TEXT,
  last_openhands_response TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_process_at INTEGER, -- When to process next (timestamp)
  alarm_scheduled BOOLEAN DEFAULT FALSE,
  
  -- Cooldown tracking for event processing
  pending_event_content TEXT,
  pending_event_id INTEGER,
  last_event_seen_at INTEGER,
  cooldown_started_at INTEGER,
  
  -- Error tracking for OpenHands API
  openhands_error_count INTEGER DEFAULT 0,
  
  -- DeepSeek system message (optional, set via API)
  deepseek_system TEXT,
  
  -- DeepSeek conversation history (maintains context across iterations)
  conversation_messages TEXT, -- JSON string
  
  -- Project facts for authoritative command/URL/path enforcement
  project_facts TEXT, -- JSON string
  
  -- Iteration completion tracking
  pending_actions TEXT, -- JSON string
  iteration_started_at INTEGER,
  last_iteration_summary TEXT,
  
  -- Aggressive mode tracking
  restart_count INTEGER DEFAULT 0,
  
  -- DeepSeek response tracking
  last_deepseek_request_at INTEGER,
  deepseek_response_pending BOOLEAN DEFAULT FALSE
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_conversations_state ON conversations(state);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_next_process ON conversations(next_process_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at);