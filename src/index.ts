// Hono HTTP API only - NO business logic, NO API calls
import { Hono } from 'hono';
import { CloudflareBindings } from './types';
import { ConversationOrchestratorDO_2026A } from './durable/ConversationDO';

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Root endpoint - documentation only
app.get('/', (c) => {
  return c.json({ 
    message: 'DeepSeek Agent for OpenHands - Durable Object Controller',
    endpoints: [
      'POST /start - Start conversation (returns immediately, work happens in alarms)',
      'GET /status/:id - Check conversation status',
      'POST /stop/:id - Force stop a conversation'
    ],
    flow: 'User → /start → DO alarm: DeepSeek → OpenHands → DO alarm: DeepSeek → ...',
    rules: [
      'NO simulated OpenHands responses',
      'NO resending same messages',
      'STRICT alternation',
      'HARD STOP on ANY error or <<DONE>>',
      'MAX 10 iterations by default'
    ]
  });
});

// Start endpoint - MUST return immediately (no awaits to external APIs)
app.post('/start', async (c) => {
  try {
    const body = await c.req.json() as {
      repository: string;
      branch?: string;
      initial_user_prompt: string;
    };
    const { repository, branch, initial_user_prompt } = body;
    
    // Validate required fields
    if (!repository || !initial_user_prompt) {
      return c.json({ error: 'Need repository and initial_user_prompt (branch is optional)' }, 400);
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
        max_iterations: 10
      })
    });
    
    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      console.error(`[HTTP:START] Durable Object init failed: ${initResponse.status} - ${errorText}`);
      return c.json({ error: `Failed to start conversation: ${initResponse.status}` }, 500);
    }
    
    // Return IMMEDIATELY - work happens in alarms
    return c.json({
      success: true,
      message: 'Conversation started. Work will happen in background via alarms.',
      conversation_id: id.toString(),
      note: 'DeepSeek will process first, then OpenHands, then back to DeepSeek, etc.',
      check_status_url: `${new URL(c.req.url).origin}/status/${id.toString()}`
    });
    
  } catch (error: any) {
    console.error(`[HTTP:START] Endpoint error: ${error.message}`);
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

export default app;
export { ConversationOrchestratorDO_2026A };
// Export old class names for reference (not used)
export { ConversationOrchestratorDO_2026A as ConversationDO_v2 };
export { ConversationOrchestratorDO_2026A as ConversationDO };