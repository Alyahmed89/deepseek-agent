// Minimal flow execution API
import { Hono } from 'hono';

interface CloudflareBindings {
  CONVERSATIONS: DurableObjectNamespace;
  PROJECT_FACTS_DB: D1Database;
}

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Start flow execution - accepts {"flow": "etaflow"} or {"flow_id": "etaflow"}
app.post('/start-flow', async (c) => {
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
      const error = await response.text();
      return c.json({ error: `Failed to start flow: ${error}` }, 500);
    }
    
    return c.json({
      success: true,
      flow_id: flowId,
      conversation_id: id.toString(),
      message: 'Flow execution started',
      endpoints: {
        status: `/status/${id.toString()}`,
        response: `/response/${id.toString()}`,
        trigger: `/trigger-api-call/${id.toString()}`
      }
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

// External trigger API calls
app.post('/trigger-api-call/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    
    const doObj = c.env.CONVERSATIONS.get(c.env.CONVERSATIONS.idFromString(id));
    
    const response = await doObj.fetch('http://placeholder/trigger-api-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      return c.json({ error: 'Failed to process trigger' }, 500);
    }
    
    return c.json(await response.json());
    
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Health check
app.get('/', (c) => {
  return c.json({
    name: 'DeepSeek Agent Flow',
    version: '1.0.0',
    endpoints: [
      'POST /start-flow - Start flow execution',
      'POST /response/:id - Send OpenHands response',
      'GET /status/:id - Get flow status',
      'POST /trigger-api-call/:id - External trigger API calls'
    ]
  });
});

export default app;