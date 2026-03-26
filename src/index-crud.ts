// Hono HTTP API with CRUD endpoints
import { Hono } from 'hono';
import { CloudflareBindings } from './types';
import { ConversationOrchestratorDO_2026A } from './durable/ConversationDO';
import { crudApi } from './crud-api';

// Dummy FlowControllerDO to satisfy existing binding
export class FlowControllerDO {
  constructor(state: any, env: any) {
    this.state = state;
    this.env = env;
  }
  
  async fetch(request: Request) {
    return new Response('FlowControllerDO: Not implemented', { status: 501 });
  }
  
  state: any;
  env: any;
}

const app = new Hono<{ Bindings: CloudflareBindings }>();

// CORS middleware
app.use('*', async (c, next) => {
  // Handle preflight requests
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { 
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-key',
        'Access-Control-Max-Age': '86400'
      }
    });
  }
  
  // Set CORS headers for other requests
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
  c.header('Access-Control-Max-Age', '86400');
  
  await next();
});

// Mount CRUD API at /api
app.route('/api', crudApi);

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: Date.now() });
});

// Start a new flow
app.post('/start-flow', async (c) => {
  try {
    const body = await c.req.json();
    const { flow_id, inputs = {} } = body;

    if (!flow_id) {
      return c.json({ error: 'flow_id is required' }, 400);
    }

    // Get Durable Object stub
    const id = c.env.CONVERSATION_DO.idFromName(`flow-${flow_id}-${Date.now()}`);
    const stub = c.env.CONVERSATION_DO.get(id);

    // Start flow
    const response = await stub.fetch('http://do.internal/start-flow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow_id, inputs })
    });

    return c.json(await response.json());
  } catch (error: any) {
    console.error('Error starting flow:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Execute next step in a flow
app.post('/step', async (c) => {
  try {
    const body = await c.req.json();
    const { conversation_id } = body;

    if (!conversation_id) {
      return c.json({ error: 'conversation_id is required' }, 400);
    }

    // Get Durable Object stub
    const id = c.env.CONVERSATION_DO.idFromName(conversation_id);
    const stub = c.env.CONVERSATION_DO.get(id);

    // Execute step
    const response = await stub.fetch('http://do.internal/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    return c.json(await response.json());
  } catch (error: any) {
    console.error('Error executing step:', error);
    return c.json({ error: error.message }, 500);
  }
});

// 404 handler
app.all('*', (c) => {
  return c.json({ error: 'Not found' }, 404);
});

export default app;

// Export Durable Objects
export { ConversationOrchestratorDO_2026A, FlowControllerDO };
