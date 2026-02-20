import { Database } from './database';

export interface Env {
  // Add bindings here (D1, KV, R2, etc.)
}

// Durable Object classes to maintain compatibility with existing deployment
export class ConversationDO implements DurableObject {
  constructor(state: DurableObjectState, env: Env) {
    // Initialize if needed
  }

  async fetch(request: Request): Promise<Response> {
    return new Response(JSON.stringify({
      message: 'ConversationDO - Compatibility class',
      status: 'active'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export class ConversationDO_v2 implements DurableObject {
  constructor(state: DurableObjectState, env: Env) {
    // Initialize if needed
  }

  async fetch(request: Request): Promise<Response> {
    return new Response(JSON.stringify({
      message: 'ConversationDO_v2 - Compatibility class',
      status: 'active'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export class ConversationOrchestratorDO_2026A implements DurableObject {
  constructor(state: DurableObjectState, env: Env) {
    // Initialize if needed
  }

  async fetch(request: Request): Promise<Response> {
    return new Response(JSON.stringify({
      message: 'ConversationOrchestratorDO_2026A - Compatibility class',
      status: 'active'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export class FlowControllerDO implements DurableObject {
  constructor(state: DurableObjectState, env: Env) {
    // Initialize if needed
  }

  async fetch(request: Request): Promise<Response> {
    return new Response(JSON.stringify({
      message: 'FlowControllerDO - Compatibility class',
      status: 'active'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const db = new Database();
    
    // CORS headers
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }
    
    // API endpoints
    if (url.pathname === '/') {
      return new Response(JSON.stringify({
        message: 'DeepSeek Agent API',
        version: '1.0.0',
        endpoints: {
          '/': 'This info page',
          '/health': 'Health check',
          '/tasks': 'Get all tasks or create new task (GET/POST)',
          '/tasks/next': 'Get next pending task (flow contract)',
          '/tasks/:id': 'Get/update specific task',
          '/artifacts': 'Get all document artifacts',
          '/flow': 'Execute flow contract (process next task)',
          '/flow/execute': 'Execute flow contract and return result',
          '/start-flow': 'Start a new flow with specified type (POST with {"flow": "flow_name"})'
        },
        database: {
          tables: ['tasks', 'doc_artifacts', 'doc_task_links'],
          flow_contract: 'SELECT * FROM tasks WHERE status="pending" ORDER BY priority DESC LIMIT 1',
          status_values: ['pending', 'done']
        }
      }, null, 2), { headers });
    }
    
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        service: 'deepseek-agent'
      }), { headers });
    }
    
    // Tasks endpoints
    if (url.pathname === '/tasks') {
      if (request.method === 'GET') {
        const tasks = db.getAllTasks();
        return new Response(JSON.stringify({ tasks }, null, 2), { headers });
      }
      
      if (request.method === 'POST') {
        try {
          const body = await request.json() as any;
          const newTask = db.createTask({
            type: body.type || 'unknown',
            payload: JSON.stringify(body.payload || {}),
            status: 'pending',
            priority: body.priority || 1,
            success_criteria: body.success_criteria
          });
          return new Response(JSON.stringify({ task: newTask }, null, 2), { 
            headers,
            status: 201 
          });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Invalid request body' }), {
            headers,
            status: 400
          });
        }
      }
    }
    
    if (url.pathname === '/tasks/next') {
      if (request.method === 'GET') {
        const nextTask = db.getNextTask();
        return new Response(JSON.stringify({ 
          task: nextTask,
          query: 'SELECT * FROM tasks WHERE status="pending" ORDER BY priority DESC LIMIT 1'
        }, null, 2), { headers });
      }
    }
    
    // Flow contract execution
    if (url.pathname === '/flow' || url.pathname === '/flow/execute') {
      if (request.method === 'GET' || request.method === 'POST') {
        const result = db.executeFlowContract();
        return new Response(JSON.stringify(result, null, 2), { headers });
      }
    }
    
    // Start flow with specific flow type
    if (url.pathname === '/start-flow') {
      if (request.method === 'POST') {
        try {
          const body = await request.json() as any;
          const flowType = body.flow || 'default';
          
          // Create a new task for the flow
          const flowTask = db.createTask({
            type: `flow_${flowType}`,
            payload: JSON.stringify({ flow: flowType, started_at: new Date().toISOString() }),
            status: 'pending',
            priority: 10,
            success_criteria: 'flow_completed = true'
          });
          
          // Execute the flow contract immediately
          const executionResult = db.executeFlowContract();
          
          return new Response(JSON.stringify({
            message: `Flow '${flowType}' started`,
            flow_task: flowTask,
            execution_result: executionResult
          }, null, 2), { headers });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Invalid request body' }), {
            headers,
            status: 400
          });
        }
      }
    }
    
    // Artifacts endpoints
    if (url.pathname === '/artifacts') {
      if (request.method === 'GET') {
        const artifacts = db.getAllArtifacts();
        return new Response(JSON.stringify({ artifacts }, null, 2), { headers });
      }
    }
    
    // Task by ID
    const taskIdMatch = url.pathname.match(/^\/tasks\/(\d+)$/);
    if (taskIdMatch) {
      const taskId = parseInt(taskIdMatch[1]);
      
      if (request.method === 'GET') {
        const task = db.getTaskById(taskId);
        if (!task) {
          return new Response(JSON.stringify({ error: 'Task not found' }), {
            headers,
            status: 404
          });
        }
        
        const artifacts = db.getArtifactsForTask(taskId);
        return new Response(JSON.stringify({ task, artifacts }, null, 2), { headers });
      }
      
      if (request.method === 'PUT') {
        try {
          const body = await request.json() as any;
          if (body.status && (body.status === 'pending' || body.status === 'done')) {
            const updated = db.updateTaskStatus(taskId, body.status);
            if (!updated) {
              return new Response(JSON.stringify({ error: 'Task not found' }), {
                headers,
                status: 404
              });
            }
            const task = db.getTaskById(taskId);
            return new Response(JSON.stringify({ task }, null, 2), { headers });
          } else {
            return new Response(JSON.stringify({ error: 'Invalid status. Must be "pending" or "done"' }), {
              headers,
              status: 400
            });
          }
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Invalid request body' }), {
            headers,
            status: 400
          });
        }
      }
    }
    
    // Not found
    return new Response(JSON.stringify({ 
      error: 'Not found',
      available_endpoints: [
        'GET /',
        'GET /health',
        'GET /tasks',
        'POST /tasks',
        'GET /tasks/next',
        'GET /tasks/:id',
        'PUT /tasks/:id',
        'GET /artifacts',
        'GET /flow',
        'POST /flow/execute'
      ]
    }), {
      status: 404,
      headers
    });
  }
};