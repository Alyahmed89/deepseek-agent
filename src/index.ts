// Hono HTTP API only - NO business logic, NO API calls
import { Hono } from 'hono';
import { CloudflareBindings } from './types';
import { ConversationOrchestratorDO_2026A } from './durable/ConversationDO';

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Rate limiting middleware with token bucket algorithm
const rateLimitMiddleware = async (c: any, next: any) => {
  // Skip rate limiting for health checks
  if (c.req.path === '/health') {
    return next();
  }
  
  // Get client IP (using CF-Connecting-IP header in Cloudflare Workers)
  const clientIp = c.req.header('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  
  // Rate limiting configuration
  const RATE_LIMIT_WINDOW = 60000; // 1 minute window
  const MAX_REQUESTS_PER_MINUTE = 60; // 60 requests per minute per IP
  const MAX_CONCURRENT_CONVERSATIONS = 20; // Global limit (reduced from 50 for 24-hour operation)
  
  // Check if KV is available
  if (!c.env.RATE_LIMIT_KV) {
    console.log(`[RATE_LIMIT] KV not available, skipping rate limiting for ${clientIp} to ${c.req.path}`);
    return next();
  }
  
  const kv = c.env.RATE_LIMIT_KV;
  
  // ==========================================================================
  // 1. Check global concurrent conversation limit
  // ==========================================================================
  if (c.req.path === '/start' || c.req.path === '/attach') {
    try {
      const activeConversationsKey = 'global:active_conversations';
      const activeConversations = await kv.get(activeConversationsKey);
      const currentCount = parseInt(activeConversations || '0');
      
      if (currentCount >= MAX_CONCURRENT_CONVERSATIONS) {
        console.log(`[RATE_LIMIT] Global conversation limit reached: ${currentCount}/${MAX_CONCURRENT_CONVERSATIONS}`);
        return c.json({
          error: 'Too many active conversations. Please try again later.',
          limit: MAX_CONCURRENT_CONVERSATIONS,
          current: currentCount
        }, 429);
      }
    } catch (error) {
      console.error(`[RATE_LIMIT] Error checking global limit: ${error}`);
      // Continue if KV fails
    }
  }
  
  // ==========================================================================
  // 2. Check per-IP rate limit using token bucket algorithm
  // ==========================================================================
  const bucketKey = `rate_limit:${clientIp}`;
  
  try {
    // Get current bucket state
    const bucketData = await kv.get(bucketKey, 'json');
    let tokens = MAX_REQUESTS_PER_MINUTE;
    let lastRefill = now;
    
    if (bucketData) {
      tokens = bucketData.tokens;
      lastRefill = bucketData.lastRefill;
      
      // Refill tokens based on time passed
      const timePassed = now - lastRefill;
      const refillAmount = Math.floor(timePassed / RATE_LIMIT_WINDOW) * MAX_REQUESTS_PER_MINUTE;
      
      if (refillAmount > 0) {
        tokens = Math.min(MAX_REQUESTS_PER_MINUTE, tokens + refillAmount);
        lastRefill = now;
      }
    }
    
    // Check if we have tokens
    if (tokens <= 0) {
      console.log(`[RATE_LIMIT] Rate limit exceeded for ${clientIp}: ${tokens} tokens remaining`);
      
      // Calculate retry-after time
      const timeUntilNextToken = RATE_LIMIT_WINDOW - (now - lastRefill);
      const retryAfterSeconds = Math.ceil(timeUntilNextToken / 1000);
      
      return c.json({
        error: 'Rate limit exceeded. Please try again later.',
        retry_after: retryAfterSeconds,
        limit: MAX_REQUESTS_PER_MINUTE,
        window: '1 minute'
      }, 429);
    }
    
    // Consume one token
    tokens -= 1;
    
    // Update bucket state with 1 minute expiration
    await kv.put(bucketKey, JSON.stringify({
      tokens,
      lastRefill
    }), { expirationTtl: 120 }); // 2 minutes TTL
    
    console.log(`[RATE_LIMIT] Request from ${clientIp} to ${c.req.path} - ${tokens} tokens remaining`);
    
  } catch (error) {
    console.error(`[RATE_LIMIT] Error processing rate limit for ${clientIp}: ${error}`);
    // If KV fails, allow the request to proceed
  }
  
  return next();
};

// Apply rate limiting middleware to all routes
// app.use('*', rateLimitMiddleware); // Temporarily disabled for testing

// Root endpoint - documentation only
app.get('/', (c) => {
  return c.json({ 
    message: 'DeepSeek Agent for OpenHands - Durable Object Controller',
    endpoints: [
      'POST /start - Start new conversation (creates new OpenHands conversation)',
      'POST /attach - Attach to existing OpenHands conversation',
      'GET /status/:id - Check conversation status',
      'POST /stop/:id - Force stop a conversation',
      'POST /api/conversations/:conversation_id/stop - API: Stop conversation',
      'GET /health - Health check with database connection test'
    ],
    flow: 'User → /start → DO alarm: DeepSeek → OpenHands → DO alarm: DeepSeek → ...',
    rules: [
      'NO simulated OpenHands responses',
      'NO resending same messages',
      'STRICT alternation',
      'HARD STOP on ANY error or [END_FLOW]',
      'MAX 500 iterations by default (configurable via max_iterations parameter)'
    ]
  });
});

// Health check endpoint with database test
app.get('/health', async (c) => {
  // TEMPORARY: Return simple response without touching DB or DO
  // To debug server hanging issue
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    note: 'Health check simplified for debugging - no DB/DO access'
  });
});

// Start endpoint - MUST return immediately (no awaits to external APIs)
app.post('/start', async (c) => {
  try {
    const body = await c.req.json() as {
      repository?: string;
      branch?: string;
      initial_user_prompt?: string;
      max_iterations?: number;
      deepseek_system?: string;
      flow?: string; // New: flow ID for flow-based execution
      flow_id?: string; // Alternative name for flow
    };
    
    const { repository, branch, initial_user_prompt, max_iterations, deepseek_system, flow, flow_id } = body;
    
    // Check if this is a flow-based execution
    const targetFlowId = flow || flow_id;
    
    if (targetFlowId) {
      // FLOW-BASED EXECUTION
      console.log(`[HTTP:START:FLOW] Starting flow execution: ${targetFlowId}`);
      
      // Create a new Durable Object for this flow execution
      const id = c.env.CONVERSATIONS.newUniqueId();
      const conversationDo = c.env.CONVERSATIONS.get(id);
      
      // Initialize the Durable Object for flow execution - NO AWAIT to external APIs
      const initResponse = await conversationDo.fetch('http://placeholder/initialize-flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          flow_id: targetFlowId,
          repository: repository, // Don't provide default - let flow definition determine it
          branch: branch, // Don't provide default - let flow definition determine it
          initial_user_prompt: initial_user_prompt || `Execute flow: ${targetFlowId}`,
          max_iterations: max_iterations || 20,
          deepseek_system: deepseek_system // Don't provide default - let flow definition determine it
        })
      });
      
      if (!initResponse.ok) {
        const errorText = await initResponse.text();
        console.error(`[HTTP:START:FLOW] Durable Object init failed: ${initResponse.status} - ${errorText}`);
        return c.json({ error: `Failed to start flow execution: ${initResponse.status}` }, 500);
      }
      
      // Track active conversation count
      try {
        if (c.env.RATE_LIMIT_KV) {
          const activeConversationsKey = 'global:active_conversations';
          const currentCount = await c.env.RATE_LIMIT_KV.get(activeConversationsKey);
          const newCount = parseInt(currentCount || '0') + 1;
          await c.env.RATE_LIMIT_KV.put(activeConversationsKey, newCount.toString(), { expirationTtl: 3600 }); // 1 hour TTL
          console.log(`[RATE_LIMIT] Active conversations: ${newCount}`);
        }
      } catch (error) {
        console.error(`[RATE_LIMIT] Error tracking active conversation: ${error}`);
      }
      
      // Return IMMEDIATELY - work happens in alarms
      return c.json({
        success: true,
        message: 'Flow execution started. Work will happen in background via alarms.',
        conversation_id: id.toString(),
        flow_id: targetFlowId,
        note: 'Flow execution: DeepSeek → OpenHands → API validation → Next step',
        check_status_url: `${new URL(c.req.url).origin}/status/${id.toString()}`
      });
      
    } else {
      // ORIGINAL REPOSITORY-BASED CONVERSATION
      // Validate required fields
      if (!repository || !initial_user_prompt) {
        return c.json({ error: 'Need repository and initial_user_prompt (branch is optional), or provide flow ID' }, 400);
      }

      console.log(`[HTTP:START] Creating conversation for repository: ${repository}`);
      
      // Create a new Durable Object for this conversation
      const id = c.env.CONVERSATIONS.newUniqueId();
      const conversationDo = c.env.CONVERSATIONS.get(id);
      
      // Initialize the Durable Object - NO AWAIT to external APIs
      const initResponse = await conversationDo.fetch('http://placeholder/initialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          repository, 
          branch: branch || 'main', 
          initial_user_prompt,
          max_iterations: max_iterations || 20,
          deepseek_system
        })
      });
      
      if (!initResponse.ok) {
        const errorText = await initResponse.text();
        console.error(`[HTTP:START] Durable Object init failed: ${initResponse.status} - ${errorText}`);
        return c.json({ error: `Failed to start conversation: ${initResponse.status}` }, 500);
      }
      
      // Track active conversation count
      try {
        if (c.env.RATE_LIMIT_KV) {
          const activeConversationsKey = 'global:active_conversations';
          const currentCount = await c.env.RATE_LIMIT_KV.get(activeConversationsKey);
          const newCount = parseInt(currentCount || '0') + 1;
          await c.env.RATE_LIMIT_KV.put(activeConversationsKey, newCount.toString(), { expirationTtl: 3600 }); // 1 hour TTL
          console.log(`[RATE_LIMIT] Active conversations: ${newCount}`);
        }
      } catch (error) {
        console.error(`[RATE_LIMIT] Error tracking active conversation: ${error}`);
      }
      
      // Return IMMEDIATELY - work happens in alarms
      return c.json({
        success: true,
        message: 'Conversation started. Work will happen in background via alarms.',
        conversation_id: id.toString(),
        note: 'DeepSeek will process first, then OpenHands, then back to DeepSeek, etc.',
        check_status_url: `${new URL(c.req.url).origin}/status/${id.toString()}`
      });
    }
    
  } catch (error: any) {
    console.error(`[HTTP:START] Endpoint error: ${error.message}`);
    return c.json({ error: error.message }, 500);
  }
});

// Attach to existing OpenHands conversation
app.post('/attach', async (c) => {
  try {
    const body = await c.req.json() as {
      openhands_conversation_id: string;
      deepseek_system?: string;
      max_iterations?: number;
    };
    const { openhands_conversation_id, deepseek_system, max_iterations } = body;
    
    // Validate required field
    if (!openhands_conversation_id) {
      return c.json({ error: 'Need openhands_conversation_id' }, 400);
    }

    console.log(`[HTTP:ATTACH] Attaching to existing OpenHands conversation: ${openhands_conversation_id}`);
    
    // Create a new Durable Object for this attachment
    const id = c.env.CONVERSATIONS.newUniqueId();
    const conversationDo = c.env.CONVERSATIONS.get(id);
    
    // Initialize with existing OpenHands conversation ID
    const initResponse = await conversationDo.fetch('http://placeholder/attach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        openhands_conversation_id,
        max_iterations: max_iterations || 20,
        deepseek_system
      })
    });
    
    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      console.error(`[HTTP:ATTACH] Durable Object attach failed: ${initResponse.status} - ${errorText}`);
      return c.json({ error: `Failed to attach to conversation: ${initResponse.status}` }, 500);
    }
    
    // Track active conversation count
    try {
      if (c.env.RATE_LIMIT_KV) {
        const activeConversationsKey = 'global:active_conversations';
        const currentCount = await c.env.RATE_LIMIT_KV.get(activeConversationsKey);
        const newCount = parseInt(currentCount || '0') + 1;
        await c.env.RATE_LIMIT_KV.put(activeConversationsKey, newCount.toString(), { expirationTtl: 3600 }); // 1 hour TTL
        console.log(`[RATE_LIMIT] Active conversations: ${newCount}`);
      }
    } catch (error) {
      console.error(`[RATE_LIMIT] Error tracking active conversation: ${error}`);
    }
    
    // Return immediately - monitoring happens in alarms
    return c.json({
      success: true,
      message: 'Attached to existing OpenHands conversation. DeepSeek will monitor and respond.',
      conversation_id: id.toString(),
      openhands_conversation_id: openhands_conversation_id,
      check_status_url: `${new URL(c.req.url).origin}/status/${id.toString()}`
    });
    
  } catch (error: any) {
    console.error(`[HTTP:ATTACH] Endpoint error: ${error.message}`);
    return c.json({ error: error.message }, 500);
  }
});

// Ultra-minimal flow execution endpoint
app.post('/start-flow', async (c) => {
  try {
    const body = await c.req.json() as { flow?: string; flow_id?: string };
    const flowId = body.flow || body.flow_id;
    
    if (!flowId) {
      return c.json({ error: 'Need flow or flow_id parameter' }, 400);
    }
    
    console.log(`[HTTP:START-FLOW] Starting ultra-minimal flow: ${flowId}`);
    
    // Create Durable Object
    const id = c.env.CONVERSATIONS.newUniqueId();
    const doObj = c.env.CONVERSATIONS.get(id);
    
    // Initialize flow
    const response = await doObj.fetch('http://placeholder/start-flow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow_id: flowId })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[HTTP:START-FLOW] Durable Object init failed: ${response.status} - ${errorText}`);
      return c.json({ error: `Failed to start flow: ${response.status}` }, 500);
    }
    
    return c.json({
      success: true,
      flow_id: flowId,
      conversation_id: id.toString(),
      message: 'Ultra-minimal flow execution started',
      check_status_url: `${new URL(c.req.url).origin}/status/${id.toString()}`
    });
    
  } catch (error: any) {
    console.error(`[HTTP:START-FLOW] Error: ${error.message}`);
    return c.json({ error: error.message }, 500);
  }
});

// Check conversation status
app.get('/status/:id', async (c) => {
  try {
    const id = c.req.param('id');
    
    // Get the Durable Object
    const conversationDo = c.env.CONVERSATIONS.get(c.env.CONVERSATIONS.idFromString(id));
    
    // Get conversation state
    const stateResponse = await conversationDo.fetch('http://placeholder/get-state', {
      method: 'GET'
    });
    
    if (!stateResponse.ok) {
      return c.json({ error: 'Failed to get conversation state' }, 500);
    }
    
    const stateData = await stateResponse.json() as any;
    
    return c.json({
      success: true,
      conversation: stateData.conversation
    });
    
  } catch (error: any) {
    console.error(`[HTTP:STATUS] Endpoint error: ${error.message}`);
    return c.json({ error: error.message }, 500);
  }
});

// Force stop a conversation
app.post('/stop/:id', async (c) => {
  try {
    const id = c.req.param('id');
    
    // Get the Durable Object
    const conversationDo = c.env.CONVERSATIONS.get(c.env.CONVERSATIONS.idFromString(id));
    
    // Stop the conversation
    const stopResponse = await conversationDo.fetch('http://placeholder/stop', {
      method: 'POST'
    });
    
    if (!stopResponse.ok) {
      return c.json({ error: 'Failed to stop conversation' }, 500);
    }
    
    const stopData = await stopResponse.json() as any;
    
    return c.json({
      success: true,
      message: stopData.message
    });
    
  } catch (error: any) {
    console.error(`[HTTP:STOP] Endpoint error: ${error.message}`);
    return c.json({ error: error.message }, 500);
  }
});

// Delete a specific Durable Object
app.post('/delete/:id', async (c) => {
  try {
    const id = c.req.param('id');
    
    // Get the Durable Object
    const conversationDo = c.env.CONVERSATIONS.get(c.env.CONVERSATIONS.idFromString(id));
    
    // Delete the Durable Object
    const deleteResponse = await conversationDo.fetch('http://placeholder/delete', {
      method: 'POST'
    });
    
    if (!deleteResponse.ok) {
      return c.json({ error: 'Failed to delete Durable Object' }, 500);
    }
    
    const deleteData = await deleteResponse.json() as any;
    
    return c.json({
      success: true,
      message: deleteData.message,
      id: deleteData.id
    });
    
  } catch (error: any) {
    console.error(`[HTTP:DELETE] Endpoint error: ${error.message}`);
    return c.json({ error: error.message }, 500);
  }
});

// OpenHands response webhook for flow execution
app.post('/response/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json() as { response: string };
    
    // Get the Durable Object
    const conversationDo = c.env.CONVERSATIONS.get(c.env.CONVERSATIONS.idFromString(id));
    
    // Forward to Durable Object
    const response = await conversationDo.fetch('http://placeholder/openhands-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[HTTP:RESPONSE] Durable Object response failed: ${response.status} - ${errorText}`);
      return c.json({ error: `Failed to process response: ${response.status}` }, 500);
    }
    
    return c.json(await response.json());
    
  } catch (error: any) {
    console.error(`[HTTP:RESPONSE] Endpoint error: ${error.message}`);
    return c.json({ error: error.message }, 500);
  }
});

// API namespace: Stop conversation
app.post('/api/conversations/:conversation_id/stop', async (c) => {
  try {
    const conversationId = c.req.param('conversation_id');
    
    // Get the Durable Object
    const conversationDo = c.env.CONVERSATIONS.get(c.env.CONVERSATIONS.idFromString(conversationId));
    
    // Stop the conversation
    const stopResponse = await conversationDo.fetch('http://placeholder/stop', {
      method: 'POST'
    });
    
    if (!stopResponse.ok) {
      return c.json({ error: 'Failed to stop conversation' }, 500);
    }
    
    const stopData = await stopResponse.json() as any;
    
    return c.json({
      success: true,
      message: stopData.message,
      conversation_id: conversationId,
      stopped_at: new Date().toISOString()
    });
    
  } catch (error: any) {
    console.error(`[HTTP:API_STOP] Endpoint error: ${error.message}`);
    return c.json({ 
      error: error.message,
      conversation_id: c.req.param('conversation_id')
    }, 500);
  }
});

// Task completion API - SINGLE SOURCE OF TRUTH for task completion
app.post('/tasks/:id/complete', async (c) => {
  try {
    const taskId = c.req.param('id');
    const body = await c.req.json() as {
      conversation_id?: string; // Optional: ConversationDO to ping after completion
    };
    const conversationId = body.conversation_id;
    
    // Validate database is available
    if (!c.env.FLOW_RUNS_DB) {
      return c.json({ 
        error: 'Database not configured',
        note: 'FLOW_RUNS_DB binding is required for task completion'
      }, 500);
    }
    
    console.log(`[HTTP:TASK_COMPLETE] Marking task ${taskId} as DONE${conversationId ? ` (will ping conversation ${conversationId})` : ''}`);
    
    // Update task status to DONE - NO SIDE EFFECTS, NO LOGIC
    const db = c.env.FLOW_RUNS_DB;
    
    // Try to update in tasks table first
    let result = await db.prepare(
      'UPDATE tasks SET status = ? WHERE id = ? AND status = ?'
    ).bind('DONE', taskId, 'PENDING').run();
    
    // If no rows affected in tasks table, try task_followups
    if (result.meta.changes === 0) {
      result = await db.prepare(
        'UPDATE task_followups SET status = ? WHERE id = ? AND status = ?'
      ).bind('DONE', taskId, 'PENDING').run();
    }
    
    if (result.meta.changes === 0) {
      return c.json({ 
        error: 'Task not found or already completed',
        task_id: taskId,
        note: 'Task must exist and be in PENDING status'
      }, 404);
    }
    
    console.log(`[HTTP:TASK_COMPLETE] Task ${taskId} marked as DONE (${result.meta.changes} rows updated)`);
    
    // Also complete any pending task execution tracking for this task
    try {
      // Find the most recent PENDING execution step for this task
      const executionStepResult = await db.prepare(`
        SELECT id FROM task_execution_steps 
        WHERE task_id = ? AND status = 'PENDING'
        ORDER BY started_at DESC
        LIMIT 1
      `).bind(taskId).first();
      
      if (executionStepResult) {
        const executionStepId = (executionStepResult as any).id;
        await db.prepare(`
          UPDATE task_execution_steps 
          SET finished_at = ?, status = 'DONE', updated_at = ?
          WHERE id = ?
        `).bind(Date.now(), Date.now(), executionStepId).run();
        
        console.log(`[HTTP:TASK_COMPLETE] Also completed task execution tracking: ${executionStepId}`);
      }
    } catch (trackingError: any) {
      console.error(`[HTTP:TASK_COMPLETE] Error completing task execution tracking: ${trackingError.message}`);
      // Continue even if tracking update fails
    }
    
    // Ping ConversationDO if conversation_id provided
    let pingResult = null;
    if (conversationId && c.env.CONVERSATIONS) {
      try {
        const conversationDo = c.env.CONVERSATIONS.get(c.env.CONVERSATIONS.idFromString(conversationId));
        const pingResponse = await conversationDo.fetch('http://placeholder/trigger-next-iteration', {
          method: 'POST'
        });
        
        if (pingResponse.ok) {
          pingResult = await pingResponse.json();
          console.log(`[HTTP:TASK_COMPLETE] Successfully pinged ConversationDO ${conversationId}`);
        } else {
          console.error(`[HTTP:TASK_COMPLETE] Failed to ping ConversationDO ${conversationId}: ${pingResponse.status}`);
        }
      } catch (pingError: any) {
        console.error(`[HTTP:TASK_COMPLETE] Error pinging ConversationDO ${conversationId}: ${pingError.message}`);
      }
    }
    
    // Return response
    const response: any = {
      success: true,
      task_id: taskId,
      status: 'DONE',
      updated_at: new Date().toISOString(),
      note: 'Task marked as DONE. This is the ONLY way tasks move to DONE.'
    };
    
    if (conversationId) {
      response.conversation_id = conversationId;
      response.ping_sent = pingResult !== null;
      if (pingResult) {
        response.ping_result = pingResult;
      }
    } else {
      response.note += ' No ConversationDO pinged. External system must manually trigger next iteration.';
    }
    
    return c.json(response);
    
  } catch (error: any) {
    console.error(`[HTTP:TASK_COMPLETE] Endpoint error: ${error.message}`);
    return c.json({ 
      error: error.message,
      task_id: c.req.param('id')
    }, 500);
  }
});

export default app;
export { ConversationOrchestratorDO_2026A };
// Export old class names for reference (not used)
export { ConversationOrchestratorDO_2026A as ConversationDO_v2 };
export { ConversationOrchestratorDO_2026A as ConversationDO };