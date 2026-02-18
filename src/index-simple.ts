// Ultra-minimal flow execution API
import { Hono } from 'hono';

interface CloudflareBindings {
  CONVERSATIONS: DurableObjectNamespace;
  PROJECT_FACTS_DB: D1Database;
}

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Start flow execution
app.post('/start', async (c) => {
  try {
    const body = await c.req.json() as { flow?: string; flow_id?: string };
    const flowId = body.flow || body.flow_id;
    
    if (!flowId) {
      return c.json({ error: 'Need flow or flow_id parameter' }, 400);
    }
    
    console.log(`[HTTP] Starting flow: ${flowId}`);
    
    // Create Durable Object
    const id = c.env.CONVERSATIONS.newUniqueId();
    const doObj = c.env.CONVERSATIONS.get(id);
    
    // Initialize flow
    const response = await doObj.fetch('http://placeholder/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow_id: flowId })
    });
    
    if (!response.ok) {
      return c.json({ error: 'Failed to start flow' }, 500);
    }
    
    return c.json({
      success: true,
      flow_id: flowId,
      conversation_id: id.toString(),
      message: 'Flow execution started'
    });
    
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// OpenHands sends responses here
app.post('/response/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json() as { response: string };
    
    const doObj = c.env.CONVERSATIONS.get(c.env.CONVERSATIONS.idFromString(id));
    
    const response = await doObj.fetch('http://placeholder/openhands-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      return c.json({ error: 'Failed to process response' }, 500);
    }
    
    return c.json(await response.json());
    
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Get status
app.get('/status/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const doObj = c.env.CONVERSATIONS.get(c.env.CONVERSATIONS.idFromString(id));
    
    const response = await doObj.fetch('http://placeholder/status');
    
    if (!response.ok) {
      return c.json({ error: 'Not found' }, 404);
    }
    
    return c.json(await response.json());
    
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;