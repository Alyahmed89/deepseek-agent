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
  // Set CORS headers
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  c.header('Access-Control-Max-Age', '86400');
  
  // Handle preflight requests
  if (c.req.method === 'OPTIONS') {
    return c.text('', 204);
  }
  
  await next();
});

// Mount CRUD API at /api
app.route('/api', crudApi);

// Rate limiting middleware with token bucket algorithm
const rateLimitMiddleware = async (c: any, next: any) => {
  // Skip rate limiting for health checks and CRUD API
  if (c.req.path === '/health' || c.req.path.startsWith('/api/')) {
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
        error: 'Rate limit exceeded',
        retry_after: retryAfterSeconds,
        limit: MAX_REQUESTS_PER_MINUTE,
        window_ms: RATE_LIMIT_WINDOW
      }, 429);
    }
    
    // Consume one token
    tokens -= 1;
    
    // Save updated bucket state
    await kv.put(bucketKey, JSON.stringify({
      tokens,
      lastRefill
    }), { expirationTtl: 120 }); // 2 minute TTL
    
    console.log(`[RATE_LIMIT] ${clientIp} has ${tokens} tokens remaining`);
    
  } catch (error) {
    console.error(`[RATE_LIMIT] Error processing rate limit for ${clientIp}: ${error}`);
    // Continue if KV fails
  }
  
  return next();
};

// Apply rate limiting middleware to all routes except CRUD API
app.use('*', rateLimitMiddleware);

// ============================================================================
// ROOT ENDPOINT - Serve HTML dashboard
// ============================================================================
app.get('/', (c) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DeepSeek Agent Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
      async function fetchDashboardData() {
        try {
          // Fetch API health
          const healthResponse = await fetch('/api/health');
          const healthData = await healthResponse.json();
          
          // Fetch counts
          const [flowsResponse, tasksResponse, flowRunsResponse] = await Promise.all([
            fetch('/api/flows').then(r => r.ok ? r.json() : { data: [] }),
            fetch('/api/tasks').then(r => r.ok ? r.json() : { data: [] }),
            fetch('/api/flow-runs').then(r => r.ok ? r.json() : { data: [] })
          ]);
          
          // Update UI
          document.getElementById('flows-count').textContent = flowsResponse.data?.length || 0;
          document.getElementById('tasks-count').textContent = tasksResponse.data?.length || 0;
          document.getElementById('flow-runs-count').textContent = flowRunsResponse.data?.length || 0;
          document.getElementById('api-status').textContent = healthData.status === 'healthy' ? 'Healthy' : 'Unhealthy';
          document.getElementById('api-status').className = healthData.status === 'healthy' 
            ? 'text-lg font-semibold text-green-600' 
            : 'text-lg font-semibold text-red-600';
          
          // Update database info
          document.getElementById('account-id').textContent = 'e39371fc55a5c9ef7ed83e16660bd7bb';
          document.getElementById('database-id').textContent = 'ce8f2a2c-6e4b-4398-b73e-ba8f204f609a';
          document.getElementById('api-endpoint').textContent = window.location.origin + '/api';
          
        } catch (error) {
          console.error('Error fetching dashboard data:', error);
        }
      }
      
      // Load data on page load
      document.addEventListener('DOMContentLoaded', fetchDashboardData);
    </script>
</head>
<body class="bg-gray-50 min-h-screen">
    <div class="container mx-auto px-4 py-8">
        <div class="mb-8">
            <h1 class="text-3xl font-bold text-gray-800">DeepSeek Agent Dashboard</h1>
            <p class="text-gray-600">Cloudflare Worker with D1 Database Management</p>
        </div>
        
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            <div class="bg-white rounded-lg shadow p-6">
                <div class="flex items-center">
                    <div class="p-3 rounded-lg bg-blue-100 text-blue-600 mr-4">
                        <span class="text-2xl">📊</span>
                    </div>
                    <div>
                        <p class="text-sm text-gray-500">Total Flows</p>
                        <p id="flows-count" class="text-2xl font-semibold">0</p>
                    </div>
                </div>
            </div>
            
            <div class="bg-white rounded-lg shadow p-6">
                <div class="flex items-center">
                    <div class="p-3 rounded-lg bg-green-100 text-green-600 mr-4">
                        <span class="text-2xl">✅</span>
                    </div>
                    <div>
                        <p class="text-sm text-gray-500">Total Tasks</p>
                        <p id="tasks-count" class="text-2xl font-semibold">0</p>
                    </div>
                </div>
            </div>
            
            <div class="bg-white rounded-lg shadow p-6">
                <div class="flex items-center">
                    <div class="p-3 rounded-lg bg-purple-100 text-purple-600 mr-4">
                        <span class="text-2xl">🚀</span>
                    </div>
                    <div>
                        <p class="text-sm text-gray-500">Flow Runs</p>
                        <p id="flow-runs-count" class="text-2xl font-semibold">0</p>
                    </div>
                </div>
            </div>
            
            <div class="bg-white rounded-lg shadow p-6">
                <div class="flex items-center">
                    <div id="api-status-icon" class="p-3 rounded-lg bg-green-100 text-green-600 mr-4">
                        <span class="text-2xl">🔌</span>
                    </div>
                    <div>
                        <p class="text-sm text-gray-500">API Status</p>
                        <p id="api-status" class="text-lg font-semibold text-green-600">Checking...</p>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div class="bg-white rounded-lg shadow p-6">
                <h2 class="text-lg font-semibold text-gray-800 mb-4">Quick Actions</h2>
                <div class="space-y-3">
                    <a href="/data" class="flex items-center p-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors">
                        <span class="mr-3">📋</span>
                        <span>View Data Tables</span>
                        <span class="ml-auto text-gray-400">→</span>
                    </a>
                    <a href="/flows" class="flex items-center p-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors">
                        <span class="mr-3">📊</span>
                        <span>View Flows Table</span>
                        <span class="ml-auto text-gray-400">→</span>
                    </a>
                    <a href="/tasks" class="flex items-center p-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors">
                        <span class="mr-3">✅</span>
                        <span>View Tasks Table</span>
                        <span class="ml-auto text-gray-400">→</span>
                    </a>
                    <button onclick="fetchDashboardData()" class="w-full flex items-center p-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors">
                        <span class="mr-3">🔄</span>
                        <span>Refresh Data</span>
                    </button>
                </div>
            </div>
            
            <div class="bg-white rounded-lg shadow p-6">
                <h2 class="text-lg font-semibold text-gray-800 mb-4">Database Information</h2>
                <div class="space-y-4">
                    <div>
                        <p class="text-sm text-gray-500">Cloudflare Account ID</p>
                        <p id="account-id" class="font-mono text-sm bg-gray-50 p-2 rounded mt-1">e39371fc55a5c9ef7ed83e16660bd7bb</p>
                    </div>
                    <div>
                        <p class="text-sm text-gray-500">Database ID</p>
                        <p id="database-id" class="font-mono text-sm bg-gray-50 p-2 rounded mt-1">ce8f2a2c-6e4b-4398-b73e-ba8f204f609a</p>
                    </div>
                    <div>
                        <p class="text-sm text-gray-500">API Endpoint</p>
                        <p id="api-endpoint" class="font-mono text-sm bg-gray-50 p-2 rounded mt-1">${c.req.url}api</p>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="mt-8 bg-white rounded-lg shadow p-6">
            <h2 class="text-lg font-semibold text-gray-800 mb-4">API Endpoints</h2>
            <div class="space-y-2">
                <div class="flex items-center">
                    <span class="text-green-600 mr-2">✓</span>
                    <code class="text-sm bg-gray-50 px-2 py-1 rounded">POST /start</code>
                    <span class="ml-2 text-gray-600">- Start new conversation</span>
                </div>
                <div class="flex items-center">
                    <span class="text-green-600 mr-2">✓</span>
                    <code class="text-sm bg-gray-50 px-2 py-1 rounded">POST /attach</code>
                    <span class="ml-2 text-gray-600">- Attach to existing conversation</span>
                </div>
                <div class="flex items-center">
                    <span class="text-green-600 mr-2">✓</span>
                    <code class="text-sm bg-gray-50 px-2 py-1 rounded">GET /status/:id</code>
                    <span class="ml-2 text-gray-600">- Check conversation status</span>
                </div>
                <div class="flex items-center">
                    <span class="text-green-600 mr-2">✓</span>
                    <code class="text-sm bg-gray-50 px-2 py-1 rounded">GET /health</code>
                    <span class="ml-2 text-gray-600">- Health check</span>
                </div>
                <div class="flex items-center">
                    <span class="text-blue-600 mr-2">📊</span>
                    <code class="text-sm bg-gray-50 px-2 py-1 rounded">GET /api/flows</code>
                    <span class="ml-2 text-gray-600">- List all flows</span>
                </div>
                <div class="flex items-center">
                    <span class="text-blue-600 mr-2">📊</span>
                    <code class="text-sm bg-gray-50 px-2 py-1 rounded">GET /api/tasks</code>
                    <span class="ml-2 text-gray-600">- List all tasks</span>
                </div>
            </div>
        </div>
    </div>
</body>
</html>
  `;
  
  return c.html(html);
});

// ============================================================================
// MINIMAL TABLE PAGES
// ============================================================================

// Data tables page - Unified UI for all entities
app.get('/data', (c) => {
  const searchParams = c.req.query();
  const initialTable = searchParams.table || 'tasks';
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Data Tables - Unified UI</title>
  <style>
    body { font-family: -apple-system, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
    .container { max-width: 1400px; margin: 0 auto; }
    .header { margin-bottom: 20px; }
    .back-link { color: #0066cc; text-decoration: none; margin-bottom: 10px; display: inline-block; }
    h1 { margin: 0 0 5px 0; }
    .tabs { display: flex; gap: 5px; margin-bottom: 20px; flex-wrap: wrap; }
    .tab { padding: 8px 16px; background: white; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; }
    .tab.active { background: #0066cc; color: white; border-color: #0066cc; }
    .table-container { background: white; border-radius: 8px; overflow: hidden; }
    .table-header { padding: 15px; border-bottom: 1px solid #e5e5e5; display: flex; justify-content: space-between; align-items: center; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f9f9f9; padding: 12px 15px; text-align: left; font-weight: 600; border-bottom: 2px solid #e5e5e5; }
    td { padding: 12px 15px; border-bottom: 1px solid #e5e5e5; }
    .loading, .error, .empty { padding: 40px; text-align: center; color: #666; }
    .error { color: #d00; }
    .action-buttons { display: flex; gap: 8px; }
    .action-btn { padding: 4px 12px; border-radius: 4px; border: 1px solid #ddd; background: white; cursor: pointer; font-size: 13px; }
    .action-btn:hover { background: #f5f5f5; }
    .action-btn.edit { color: #0066cc; border-color: #0066cc; }
    .action-btn.delete { color: #d00; border-color: #d00; }
    .action-btn.add { background: #0066cc; color: white; border-color: #0066cc; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <a href="/" class="back-link">← Back to Dashboard</a>
      <h1>Data Tables - Unified UI</h1>
      <p>Manage all entities in one place with edit/add functionality</p>
    </div>
    
    <div class="tabs">
      <div class="tab ${initialTable === 'tasks' ? 'active' : ''}" onclick="loadTable('tasks', event)">Tasks</div>
      <div class="tab ${initialTable === 'flows' ? 'active' : ''}" onclick="loadTable('flows', event)">Flows</div>
      <div class="tab ${initialTable === 'flow-steps' ? 'active' : ''}" onclick="loadTable('flow-steps', event)">Steps</div>
      <div class="tab ${initialTable === 'flow-conditions' ? 'active' : ''}" onclick="loadTable('flow-conditions', event)">Conditions</div>
      <div class="tab ${initialTable === 'flow-runs' ? 'active' : ''}" onclick="loadTable('flow-runs', event)">Flow Runs</div>
    </div>
    
    <div class="table-container">
      <div class="table-header">
        <div id="table-title">${initialTable.replace('-', ' ')}</div>
        <div>
          <button id="add-btn" class="action-btn add" onclick="showAddModal()">+ Add New</button>
        </div>
      </div>
      <div id="table-content" class="loading">Loading...</div>
    </div>
  </div>
  
  <script>
    let currentTable = '${initialTable}';
    
    async function loadTable(table, event) {
      currentTable = table;
      
      // Update tabs
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      if (event && event.target) {
        event.target.classList.add('active');
      }
      
      // Update URL without page reload
      const url = new URL(window.location);
      url.searchParams.set('table', table);
      window.history.pushState({}, '', url);
      
      // Update title
      document.getElementById('table-title').textContent = table.replace('-', ' ');
      
      // Show loading
      document.getElementById('table-content').className = 'loading';
      document.getElementById('table-content').textContent = 'Loading...';
      
      try {
        const response = await fetch('/api/' + table);
        const data = await response.json();
        
        if (data.error) {
          document.getElementById('table-content').className = 'error';
          document.getElementById('table-content').textContent = 'Error: ' + data.error;
          return;
        }
        
        const items = data.data || data.results || data;
        
        if (!items || items.length === 0) {
          document.getElementById('table-content').className = 'empty';
          document.getElementById('table-content').textContent = 'No data found';
          return;
        }
        
        // Create table
        let html = '<table>';
        
        // Table header
        html += '<thead><tr>';
        const firstItem = items[0];
        for (const key in firstItem) {
          html += '<th>' + key + '</th>';
        }
        html += '<th>Actions</th>';
        html += '</tr></thead>';
        
        // Table body
        html += '<tbody>';
        items.forEach(item => {
          html += '<tr>';
          for (const key in firstItem) {
            let value = item[key];
            if (value === null || value === undefined) value = '';
            if (typeof value === 'object') value = JSON.stringify(value);
            html += '<td>' + value + '</td>';
          }
          html += '<td><div class="action-buttons">';
          html += '<button class="action-btn edit" onclick="editItem(\\'' + item.id + '\\')">Edit</button>';
          html += '<button class="action-btn delete" onclick="deleteItem(\\'' + item.id + '\\')">Delete</button>';
          html += '</div></td>';
          html += '</tr>';
        });
        html += '</tbody></table>';
        
        document.getElementById('table-content').className = '';
        document.getElementById('table-content').innerHTML = html;
        
      } catch (error) {
        document.getElementById('table-content').className = 'error';
        document.getElementById('table-content').textContent = 'Error: ' + error.message;
      }
    }
    
    function editItem(id) {
      alert('Edit functionality for ' + currentTable + ' ID: ' + id + '\\n\\nNote: Full edit functionality requires additional implementation.\\nFor now, use API endpoints directly.');
    }
    
    function deleteItem(id) {
      if (confirm('Are you sure you want to delete this item?')) {
        fetch('/api/' + currentTable + '/' + id, {
          method: 'DELETE'
        })
        .then(response => response.json())
        .then(data => {
          if (data.error) {
            alert('Error: ' + data.error);
          } else {
            alert('Item deleted successfully');
            loadTable(currentTable);
          }
        })
        .catch(error => {
          alert('Error: ' + error.message);
        });
      }
    }
    
    function showAddModal() {
      alert('Add new ' + currentTable + '\\n\\nNote: Full add functionality requires additional implementation.\\nFor now, use API endpoints directly.');
    }
    
    // Load initial table
    document.addEventListener('DOMContentLoaded', () => loadTable('${initialTable}'));
  </script>
</body>
</html>
  `;
  
  return c.html(html);
});

// Flows page - Redirect to unified data page in React frontend
// Note: Flows are now available in the unified /data page with ?table=flows
app.get('/flows', (c) => {
  // Redirect to unified data page with flows table
  return c.redirect('/data?table=flows');
});

// Tasks page - Redirect to unified data page in React frontend
// Note: Tasks are now available in the unified /data page with ?table=tasks
app.get('/tasks', (c) => {
  // Redirect to unified data page with tasks table
  return c.redirect('/data?table=tasks');
});

// ============================================================================
// HEALTH CHECK ENDPOINT
// ============================================================================
app.get('/health', async (c) => {
  const healthChecks: any = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {}
  };
  
  // Check D1 database if available
  if (c.env.FLOW_RUNS_DB) {
    try {
      const result = await c.env.FLOW_RUNS_DB.prepare('SELECT 1 as test').first();
      healthChecks.services.d1_database = 'connected';
      healthChecks.services.d1_test_result = result;
    } catch (error: any) {
      healthChecks.services.d1_database = 'error';
      healthChecks.services.d1_error = error.message;
      healthChecks.status = 'degraded';
    }
  } else {
    healthChecks.services.d1_database = 'not_configured';
  }
  
  // Check KV if available
  if (c.env.RATE_LIMIT_KV) {
    try {
      await c.env.RATE_LIMIT_KV.get('health_test');
      healthChecks.services.kv = 'connected';
    } catch (error: any) {
      healthChecks.services.kv = 'error';
      healthChecks.services.kv_error = error.message;
      healthChecks.status = 'degraded';
    }
  } else {
    healthChecks.services.kv = 'not_configured';
  }
  
  // Check Durable Objects if available
  if (c.env.CONVERSATIONS) {
    healthChecks.services.durable_objects = 'available';
  } else {
    healthChecks.services.durable_objects = 'not_configured';
  }
  
  // Check environment variables
  healthChecks.services.deepseek_api_key = c.env.DEEPSEEK_API_KEY ? 'configured' : 'missing';
  healthChecks.services.openhands_api_url = c.env.OPENHANDS_API_URL ? 'configured' : 'missing';
  
  return c.json(healthChecks);
});

// ============================================================================
// CONVERSATION ENDPOINTS (existing functionality)
// ============================================================================

// Start a new conversation
app.post('/start', async (c) => {
  try {
    const body = await c.req.json();
    const { repository, branch, initial_user_prompt, max_iterations, deepseek_system, flow_id } = body;
    
    // FLOW-BASED EXECUTION
    if (flow_id) {
      console.log(`[HTTP:START:FLOW] Starting flow execution for flow_id: ${flow_id}`);
      
      // Validate flow_id exists in database
      if (c.env.FLOW_RUNS_DB) {
        try {
          const flowResult = await c.env.FLOW_RUNS_DB.prepare('SELECT * FROM flows WHERE id = ?').bind(flow_id).first();
          if (!flowResult) {
            return c.json({ error: `Flow not found: ${flow_id}` }, 404);
          }
          
          // Use flow definition values if not provided in request
          const targetFlowId = flow_id;
          const targetRepository = repository || (flowResult as any).repo;
          const targetBranch = branch || (flowResult as any).branch;
          const targetInitialUserPrompt = initial_user_prompt || (flowResult as any).first_prompt;
          const targetMaxIterations = max_iterations || (flowResult as any).max_iterations;
          const targetDeepseekSystem = deepseek_system || (flowResult as any).deepseek_system;
          
          console.log(`[HTTP:START:FLOW] Using flow definition: ${targetFlowId}, repo: ${targetRepository}, branch: ${targetBranch}`);
          
          // Create a new Durable Object for this conversation
          const id = c.env.CONVERSATIONS.newUniqueId();
          const conversationDo = c.env.CONVERSATIONS.get(id);
          
          // Initialize the Durable Object with flow context
          const initResponse = await conversationDo.fetch('http://placeholder/initialize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              repository: targetRepository,
              branch: targetBranch, // Don't provide default - let flow definition determine it
              initial_user_prompt: targetInitialUserPrompt || `Execute flow: ${targetFlowId}`,
              max_iterations: targetMaxIterations || 20,
              deepseek_system: targetDeepseekSystem // Don't provide default - let flow definition determine it
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
          
        } catch (dbError: any) {
          console.error(`[HTTP:START:FLOW] Database error checking flow: ${dbError.message}`);
          return c.json({ error: `Database error checking flow: ${dbError.message}` }, 500);
        }
      } else {
        return c.json({ error: 'Database not configured for flow execution' }, 500);
      }
      
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
          deepseek_system: deepseek_system || 'You are a helpful assistant.'
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
        note: 'Flow: DeepSeek → OpenHands → DeepSeek → OpenHands → ...',
        check_status_url: `${new URL(c.req.url).origin}/status/${id.toString()}`
      });
    }
    
  } catch (error: any) {
    console.error(`[HTTP:START] Endpoint error: ${error.message}`);
    return c.json({ error: error.message }, 500);
  }
});

// ============================================================================
// STEPS TABLE PAGE
// ============================================================================
// Steps page - Redirect to unified data page in React frontend
// Note: Steps are now available in the unified /data page with ?table=flow-steps
app.get('/steps', (c) => {
  // Redirect to unified data page with steps table
  return c.redirect('/data?table=flow-steps');
});

export default app;
export { ConversationOrchestratorDO_2026A };
// Export old class names for reference (not used)
export { ConversationOrchestratorDO_2026A as ConversationDO_v2 };
export { ConversationOrchestratorDO_2026A as ConversationDO };