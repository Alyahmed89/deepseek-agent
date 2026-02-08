// Hono HTTP API with D1 database (no Durable Objects)
import { Hono } from 'hono';
import { CloudflareBindings, ConversationData, ConversationState } from './types';
import { callDeepSeek, buildInitialMessages } from './services/deepseek';
import { createOpenHandsConversation, getOpenHandsConversation, injectMessageToOpenHands } from './services/openhands';
import { parseDoneResponse, extractPromptsAndResponses } from './utils/parsing';
import { shouldCompleteTask } from './services/verification';
import { validateFactUsage, resolveFactPlaceholders } from './utils/factValidation';
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
  CHECKING_PROMPT
} from './constants';

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Root endpoint - documentation only
app.get('/', (c) => {
  return c.json({ 
    message: 'DeepSeek Agent for OpenHands - D1 Database Version (No Durable Objects)',
    endpoints: [
      'POST /start - Start new conversation',
      'POST /attach - Attach to existing OpenHands conversation',
      'GET /status/:id - Check conversation status',
      'POST /stop/:id - Force stop a conversation',
      'GET /health - Health check'
    ],
    architecture: 'D1 database + scheduled cron jobs (every 2 seconds)',
    note: 'All conversation state stored in D1 database, processed by scheduled worker'
  });
});

// Health check endpoint
app.get('/health', async (c) => {
  try {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      checks: {
        database: 'pending'
      }
    };
    
    // Test database connection
    try {
      const db = c.env.FLOW_RUNS_DB;
      const result = await db.prepare('SELECT 1 as test').first();
      health.checks.database = result ? 'connected' : 'query_failed';
    } catch (error: any) {
      health.checks.database = `error: ${error.message}`;
      health.status = 'degraded';
    }
    
    return c.json(health);
    
  } catch (error: any) {
    console.error(`[HTTP:HEALTH] Endpoint error: ${error.message}`);
    return c.json({ error: error.message }, 500);
  }
});

// Helper function to generate unique ID
function generateId(): string {
  return crypto.randomUUID();
}

// Helper function to save conversation to D1
async function saveConversation(db: D1Database, conversation: ConversationData): Promise<boolean> {
  try {
    const now = Date.now();
    conversation.updated_at = now;
    
    // Check if conversation exists
    const existing = await db.prepare('SELECT id FROM conversations WHERE id = ?').bind(conversation.id).first();
    
    if (existing) {
      // Update existing
      await db.prepare(`
        UPDATE conversations SET
          state = ?,
          iteration = ?,
          openhands_conversation_id = ?,
          status = ?,
          error_message = ?,
          last_deepseek_response = ?,
          last_openhands_response = ?,
          updated_at = ?,
          next_process_at = ?,
          pending_event_content = ?,
          pending_event_id = ?,
          last_event_seen_at = ?,
          cooldown_started_at = ?,
          openhands_error_count = ?,
          deepseek_system = ?,
          conversation_messages = ?,
          project_facts = ?,
          pending_actions = ?,
          iteration_started_at = ?,
          last_iteration_summary = ?,
          restart_count = ?,
          last_deepseek_request_at = ?,
          deepseek_response_pending = ?
        WHERE id = ?
      `).bind(
        conversation.state,
        conversation.iteration,
        conversation.openhands_conversation_id || null,
        conversation.status,
        conversation.error_message || null,
        conversation.last_deepseek_response || null,
        conversation.last_openhands_response || null,
        conversation.updated_at,
        conversation.next_process_at || null,
        conversation.pending_event_content || null,
        conversation.pending_event_id || null,
        conversation.last_event_seen_at || null,
        conversation.cooldown_started_at || null,
        conversation.openhands_error_count || 0,
        conversation.deepseek_system || null,
        conversation.conversation_messages ? JSON.stringify(conversation.conversation_messages) : null,
        conversation.project_facts ? JSON.stringify(conversation.project_facts) : null,
        conversation.pending_actions ? JSON.stringify(conversation.pending_actions) : null,
        conversation.iteration_started_at || null,
        conversation.last_iteration_summary || null,
        conversation.restart_count || 0,
        conversation.last_deepseek_request_at || null,
        conversation.deepseek_response_pending ? 1 : 0,
        conversation.id
      ).run();
    } else {
      // Insert new
      await db.prepare(`
        INSERT INTO conversations (
          id, state, initial_user_prompt, iteration, repository, branch,
          max_iterations, status, created_at, updated_at, next_process_at,
          openhands_conversation_id, deepseek_system, conversation_messages,
          project_facts, restart_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        conversation.id,
        conversation.state,
        conversation.initial_user_prompt,
        conversation.iteration,
        conversation.repository,
        conversation.branch || 'main',
        conversation.max_iterations,
        conversation.status,
        conversation.created_at,
        conversation.updated_at,
        conversation.next_process_at || null,
        conversation.openhands_conversation_id || null,
        conversation.deepseek_system || null,
        conversation.conversation_messages ? JSON.stringify(conversation.conversation_messages) : null,
        conversation.project_facts ? JSON.stringify(conversation.project_facts) : null,
        conversation.restart_count || 0
      ).run();
    }
    
    return true;
  } catch (error: any) {
    console.error(`[DB:SAVE] Error saving conversation ${conversation.id}: ${error.message}`);
    return false;
  }
}

// Helper function to load conversation from D1
async function loadConversation(db: D1Database, id: string): Promise<ConversationData | null> {
  try {
    const row = await db.prepare(`
      SELECT * FROM conversations WHERE id = ?
    `).bind(id).first();
    
    if (!row) return null;
    
    return {
      id: row.id as string,
      state: row.state as ConversationState,
      initial_user_prompt: row.initial_user_prompt as string,
      openhands_conversation_id: row.openhands_conversation_id as string | undefined,
      iteration: row.iteration as number,
      repository: row.repository as string,
      branch: row.branch as string | undefined,
      max_iterations: row.max_iterations as number,
      status: row.status as 'active' | 'stopped' | 'error',
      error_message: row.error_message as string | undefined,
      last_deepseek_response: row.last_deepseek_response as string | undefined,
      last_openhands_response: row.last_openhands_response as string | undefined,
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
      next_process_at: row.next_process_at as number | undefined,
      pending_event_content: row.pending_event_content as string | undefined,
      pending_event_id: row.pending_event_id as number | undefined,
      last_event_seen_at: row.last_event_seen_at as number | undefined,
      cooldown_started_at: row.cooldown_started_at as number | undefined,
      openhands_error_count: row.openhands_error_count as number | undefined,
      deepseek_system: row.deepseek_system as string | undefined,
      conversation_messages: row.conversation_messages ? JSON.parse(row.conversation_messages as string) : undefined,
      project_facts: row.project_facts ? JSON.parse(row.project_facts as string) : undefined,
      pending_actions: row.pending_actions ? JSON.parse(row.pending_actions as string) : undefined,
      iteration_started_at: row.iteration_started_at as number | undefined,
      last_iteration_summary: row.last_iteration_summary as string | undefined,
      restart_count: row.restart_count as number | undefined,
      last_deepseek_request_at: row.last_deepseek_request_at as number | undefined,
      deepseek_response_pending: row.deepseek_response_pending === 1
    };
  } catch (error: any) {
    console.error(`[DB:LOAD] Error loading conversation ${id}: ${error.message}`);
    return null;
  }
}