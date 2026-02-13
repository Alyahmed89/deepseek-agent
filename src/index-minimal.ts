// Minimal Hono HTTP API for flow execution
import { Hono } from 'hono';

interface CloudflareBindings {
  CONVERSATIONS: DurableObjectNamespace;
  PROJECT_FACTS_DB: D1Database;
  FLOW_RUNS_DB: D1Database;
  RATE_LIMIT_KV?: KVNamespace;
}

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Start flow execution
app.post('/start', async (c) => {
  try {
    const body = await c.req.json() as {
      flow?: string;
      flow_id?: string;
    };
    
    const targetFlowId = flow || flow_id;
    
    if (!targetFlowId) {
      return c.json({ error: 'Need flow or flow_id parameter' }, 400);
    }
    
    console.log(`[HTTP:START] Starting flow execution: ${targetFlowId}`);
    
    // Create a new Durable Object for this flow execution
    const id = c.env.CONVERSATIONS.newUniqueId();
    const conversationDo = c.env.CONVERSATIONS.get(id);
    
    // Initialize the Durable Object for flow execution
    const initResponse = await conversationDo.fetch('http://placeholder/initialize-flow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        flow_id: targetFlowId,
        initial_user_prompt: `Execute flow: ${targetFlowId}`,
        max_iterations: 50
      })
    });
    
    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      console.error(`[HTTP:START] Durable Object init failed: ${initResponse.status} - ${errorText}`);
      return c.json({ error: `Failed to start flow execution: ${initResponse.status}` }, 500);
    }
    
    // Return immediately - work happens in alarms
    return c.json({
      success: true,
      message: 'Flow execution started. Work will happen in background via alarms.',
      conversation_id: id.toString(),
      flow_id: targetFlowId,
      check_status_url: `${new URL(c.req.url).origin}/status/${id.toString()}`
    });
    
  } catch (error: any) {
    console.error(`[HTTP:START] Error: ${error.message}`);
    return c.json({ error: error.message }, 500);
  }
});

// Get conversation status
app.get('/status/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const conversationDo = c.env.CONVERSATIONS.get(c.env.CONVERSATIONS.idFromString(id));
    
    const response = await conversationDo.fetch('http://placeholder/get-state');
    
    if (!response.ok) {
      return c.json({ error: 'Conversation not found' }, 404);
    }
    
    return c.json(await response.json());
  } catch (error: any) {
    console.error(`[HTTP:STATUS] Error: ${error.message}`);
    return c.json({ error: error.message }, 500);
  }
});

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: Date.now() });
});

export default app;