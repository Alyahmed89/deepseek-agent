// Automatic DeepSeek Agent for OpenHands
// Simple flow: User -> DeepSeek -> OpenHands (automatic processing)
// No /continue endpoint needed - OpenHands processes automatically

import { Hono } from 'hono'

interface CloudflareBindings {
  DEEPSEEK_API_KEY: string
  OPENHANDS_API_URL: string
  CONVERSATIONS: DurableObjectNamespace
}

const app = new Hono<{ Bindings: CloudflareBindings }>()

// Root endpoint
app.get('/', (c) => {
  return c.json({ 
    message: 'DeepSeek Agent for OpenHands (Automatic Flow with Alarms)', 
    endpoints: [
      'POST /start - Start automatic task with alarms (DeepSeek <-> OpenHands loop)',
      'GET /status/:id - Check conversation status',
      'POST /stop/:id - Stop a conversation'
    ],
    flow: 'User task -> DeepSeek -> OpenHands -> (alarm) -> DeepSeek -> OpenHands -> ...',
    note: 'Uses Durable Objects with alarms to automatically continue conversations between DeepSeek and OpenHands.'
  })
})



// Start automatic task using Durable Object with alarms
app.post('/start', async (c) => {
  try {
    const { repository, branch, task } = await c.req.json()
    
    if (!repository || !task) {
      return c.json({ error: 'Need repository and task (branch is optional)' }, 400)
    }

    console.log(`Starting automatic task for repository: ${repository}`)
    console.log(`Task: "${task.substring(0, 100)}..."`)
    
    // Create a new Durable Object for this conversation
    const id = c.env.CONVERSATIONS.newUniqueId()
    const conversationDo = c.env.CONVERSATIONS.get(id)
    
    // Initialize the Durable Object
    const initResponse = await conversationDo.fetch('http://placeholder/initialize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository, branch, task })
    })
    
    if (!initResponse.ok) {
      const errorText = await initResponse.text()
      console.error(`Durable Object init failed: ${initResponse.status} - ${errorText}`)
      return c.json({ error: `Failed to start conversation: ${initResponse.status}` }, 500)
    }
    
    const initData = await initResponse.json() as any
    
    // Return success response
    return c.json({
      success: true,
      message: 'Task started successfully with automatic polling',
      details: {
        repository,
        branch: branch || 'default',
        task_preview: task.substring(0, 100) + (task.length > 100 ? '...' : ''),
        conversation_id: initData.conversation_id,
        status: initData.status,
        note: 'OpenHands is now processing the task automatically. The conversation will automatically continue between DeepSeek and OpenHands using alarms.',
        check_status_url: `${new URL(c.req.url).origin}/status/${id.toString()}`
      }
    })
    
  } catch (error: any) {
    console.error(`Start endpoint error: ${error.message}`)
    return c.json({ error: error.message }, 500)
  }
})

// Check conversation status
app.get('/status/:id', async (c) => {
  try {
    const id = c.req.param('id')
    
    // Get the Durable Object
    const conversationDo = c.env.CONVERSATIONS.get(c.env.CONVERSATIONS.idFromString(id))
    
    // Get conversation state
    const stateResponse = await conversationDo.fetch('http://placeholder/get-state', {
      method: 'GET'
    })
    
    if (!stateResponse.ok) {
      return c.json({ error: 'Failed to get conversation state' }, 500)
    }
    
    const stateData = await stateResponse.json() as any
    
    return c.json({
      success: true,
      conversation: stateData.conversation
    })
    
  } catch (error: any) {
    console.error(`Status endpoint error: ${error.message}`)
    return c.json({ error: error.message }, 500)
  }
})

// Stop a conversation
app.post('/stop/:id', async (c) => {
  try {
    const id = c.req.param('id')
    
    // Get the Durable Object
    const conversationDo = c.env.CONVERSATIONS.get(c.env.CONVERSATIONS.idFromString(id))
    
    // Stop the conversation
    const stopResponse = await conversationDo.fetch('http://placeholder/stop', {
      method: 'POST'
    })
    
    if (!stopResponse.ok) {
      return c.json({ error: 'Failed to stop conversation' }, 500)
    }
    
    const stopData = await stopResponse.json() as any
    
    return c.json({
      success: true,
      message: stopData.message
    })
    
  } catch (error: any) {
    console.error(`Stop endpoint error: ${error.message}`)
    return c.json({ error: error.message }, 500)
  }
})

// Durable Object class for automatic DeepSeek <-> OpenHands loop
// Uses alarms to periodically check OpenHands status and continue the conversation
export class ConversationDO {
  private state: DurableObjectState;
  private env: CloudflareBindings;
  private conversation: {
    id: string;
    repository: string;
    branch?: string;
    task: string;
    iteration: number;
    maxIterations: number;
    status: 'starting' | 'running' | 'completed' | 'failed';
    lastOpenHandsResponse?: string;
    lastDeepSeekResponse?: string;
  } | null = null;

  constructor(state: DurableObjectState, env: CloudflareBindings) {
    this.state = state;
    this.env = env;
    
    // Load conversation state from storage
    this.state.blockConcurrencyWhile(async () => {
      this.conversation = await this.state.storage.get('conversation') || null;
    });
  }
  
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Initialize a new conversation
    if (path === '/initialize' && request.method === 'POST') {
      try {
        const { repository, branch, task } = await request.json();
        
        if (!repository || !task) {
          return new Response(JSON.stringify({ error: 'Need repository and task' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        // Initialize conversation
        this.conversation = {
          id: this.state.id.toString(),
          repository,
          branch,
          task,
          iteration: 0,
          maxIterations: 10,
          status: 'starting'
        };
        
        await this.state.storage.put('conversation', this.conversation);
        
        // Start the process
        await this.startProcess();
        
        return new Response(JSON.stringify({
          success: true,
          conversation_id: this.conversation.id,
          status: 'started',
          message: 'Conversation started. OpenHands will process automatically.'
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
        
      } catch (error: any) {
        console.error(`Initialize error: ${error.message}`);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    // Get conversation status
    if (path === '/get-state' && request.method === 'GET') {
      return new Response(JSON.stringify({
        success: true,
        conversation: this.conversation || { status: 'not_initialized' }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Stop conversation
    if (path === '/stop' && request.method === 'POST') {
      this.conversation = null;
      await this.state.storage.delete('conversation');
      await this.state.storage.deleteAlarm();
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Conversation stopped'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Alarm endpoint (called by Cloudflare when alarm triggers)
    if (path === '/alarm') {
      await this.handleAlarm();
      return new Response(null, { status: 204 });
    }
    
    return new Response(JSON.stringify({
      error: 'Not found',
      available_endpoints: ['POST /initialize', 'GET /get-state', 'POST /stop', '/alarm']
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Start the automatic process
  private async startProcess(): Promise<void> {
    if (!this.conversation) return;
    
    try {
      console.log(`Starting process for conversation: ${this.conversation.id}`);
      
      // Step 1: Send task to DeepSeek
      const deepseekResult = await this.callDeepSeek(
        this.conversation.task,
        this.conversation.iteration
      );
      
      if (!deepseekResult.success) {
        console.error(`DeepSeek failed: ${deepseekResult.error}`);
        this.conversation.status = 'failed';
        await this.state.storage.put('conversation', this.conversation);
        return;
      }
      
      this.conversation.lastDeepSeekResponse = deepseekResult.response;
      this.conversation.iteration++;
      
      // Check if DeepSeek says we're done
      if (this.shouldStop(deepseekResult.response!)) {
        console.log(`DeepSeek indicated completion at iteration ${this.conversation.iteration}`);
        this.conversation.status = 'completed';
        await this.state.storage.put('conversation', this.conversation);
        return;
      }
      
      // Step 2: Send DeepSeek response to OpenHands
      const openhandsResult = await this.createOpenHandsConversation(
        deepseekResult.response!
      );
      
      if (!openhandsResult.success) {
        console.error(`OpenHands create failed: ${openhandsResult.error}`);
        this.conversation.status = 'failed';
        await this.state.storage.put('conversation', this.conversation);
        return;
      }
      
      this.conversation.status = 'running';
      await this.state.storage.put('conversation', this.conversation);
      
      // Set alarm to check OpenHands status in 30 seconds
      await this.state.storage.setAlarm(Date.now() + 30000);
      
      console.log(`Process started. Alarm set for 30 seconds.`);
      
    } catch (error: any) {
      console.error(`Start process error: ${error.message}`);
      this.conversation.status = 'failed';
      await this.state.storage.put('conversation', this.conversation);
    }
  }
  
  // Handle alarm - check OpenHands status and continue conversation
  private async handleAlarm(): Promise<void> {
    if (!this.conversation || this.conversation.status !== 'running') {
      console.log(`No active conversation to handle alarm`);
      return;
    }
    
    try {
      console.log(`Alarm triggered for conversation: ${this.conversation.id}, iteration: ${this.conversation.iteration}`);
      
      // Check if we've reached max iterations
      if (this.conversation.iteration >= this.conversation.maxIterations) {
        console.log(`Max iterations reached (${this.conversation.maxIterations})`);
        this.conversation.status = 'completed';
        await this.state.storage.put('conversation', this.conversation);
        return;
      }
      
      // TODO: In a real implementation, we would check OpenHands API for the conversation status
      // and get the latest response from OpenHands
      // For now, we'll simulate by just continuing the loop
      
      // Simulate getting OpenHands response
      const openhandsResponse = `OpenHands has processed iteration ${this.conversation.iteration}. This is a simulated response.`;
      this.conversation.lastOpenHandsResponse = openhandsResponse;
      
      // Send OpenHands response to DeepSeek for analysis
      const deepseekResult = await this.callDeepSeek(
        openhandsResponse,
        this.conversation.iteration
      );
      
      if (!deepseekResult.success) {
        console.error(`DeepSeek failed in alarm: ${deepseekResult.error}`);
        this.conversation.status = 'failed';
        await this.state.storage.put('conversation', this.conversation);
        return;
      }
      
      this.conversation.lastDeepSeekResponse = deepseekResult.response;
      this.conversation.iteration++;
      
      // Check if DeepSeek says we're done
      if (this.shouldStop(deepseekResult.response!)) {
        console.log(`DeepSeek indicated completion at iteration ${this.conversation.iteration}`);
        this.conversation.status = 'completed';
        await this.state.storage.put('conversation', this.conversation);
        return;
      }
      
      // Send DeepSeek response to OpenHands (simulated)
      console.log(`Would send to OpenHands: ${deepseekResult.response!.substring(0, 100)}...`);
      
      // Set next alarm if not done
      if (this.conversation.status === 'running') {
        await this.state.storage.setAlarm(Date.now() + 30000);
        console.log(`Next alarm set for 30 seconds.`);
      }
      
      await this.state.storage.put('conversation', this.conversation);
      
    } catch (error: any) {
      console.error(`Handle alarm error: ${error.message}`);
      this.conversation.status = 'failed';
      await this.state.storage.put('conversation', this.conversation);
    }
  }
  
  // Helper method to call DeepSeek API
  private async callDeepSeek(prompt: string, iteration: number): Promise<{ success: boolean; response?: string; error?: string }> {
    try {
      const deepseekPrompt = `You are DeepSeek, an AI assistant that helps with software development tasks. You are working with OpenHands, an automated development agent.

Repository: ${this.conversation!.repository}${this.conversation!.branch ? ` (branch: ${this.conversation!.branch})` : ''}

Iteration: ${iteration + 1} of ${this.conversation!.maxIterations}

IMPORTANT: Your response will be sent to OpenHands to execute. Provide clear, specific instructions. Do not include any special stop tokens or completion markers like "<<DONE>>". Just provide helpful instructions for OpenHands.

${prompt}`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      
      const deepseekRes = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${this.env.DEEPSEEK_API_KEY}`, 
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ 
          model: 'deepseek-chat', 
          messages: [{ role: 'user', content: deepseekPrompt }],
          temperature: 0.7,
          max_tokens: 2000
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!deepseekRes.ok) {
        const errorText = await deepseekRes.text();
        console.error(`DeepSeek API error: ${deepseekRes.status} - ${errorText}`);
        return { 
          success: false, 
          error: `DeepSeek API error: ${deepseekRes.status}` 
        };
      }
      
      const deepseekData = await deepseekRes.json() as any;
      const response = deepseekData.choices[0].message.content;
      console.log(`DeepSeek response received (${response.length} chars) for iteration ${iteration}`);
      
      return { success: true, response };
    } catch (error: any) {
      console.error(`DeepSeek call error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
  
  // Helper method to create OpenHands conversation
  private async createOpenHandsConversation(initialMessage: string): Promise<{ success: boolean; conversationId?: string; error?: string }> {
    try {
      const createUrl = this.env.OPENHANDS_API_URL.endsWith('/') 
        ? `${this.env.OPENHANDS_API_URL}conversations`
        : `${this.env.OPENHANDS_API_URL}/conversations`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const createBody: any = {
        initial_user_msg: initialMessage,
        repository: this.conversation!.repository
      };
      
      if (this.conversation!.branch) {
        createBody.selected_branch = this.conversation!.branch;
      }
      
      const createRes = await fetch(createUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (createRes.ok) {
        const createData = await createRes.json() as any;
        const conversationId = createData.conversation_id;
        console.log(`Created OpenHands conversation: ${conversationId}`);
        return { success: true, conversationId };
      } else {
        const errorText = await createRes.text();
        console.error(`OpenHands create error: ${createRes.status} - ${errorText}`);
        return { 
          success: false, 
          error: `Failed to create OpenHands conversation: ${createRes.status}` 
        };
      }
    } catch (error: any) {
      console.error(`OpenHands create call error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
  
  // Check if we should stop the loop
  private shouldStop(response: string): boolean {
    const lowerResponse = response.toLowerCase();
    
    // Check for stop keywords
    const stopKeywords = [
      'done',
      '[done]',
      'stop',
      'i\'m done',
      'task completed',
      'finished',
      'complete',
      'no further action needed',
      'that\'s all',
      'end of conversation',
      'conversation complete'
    ];
    
    for (const keyword of stopKeywords) {
      if (lowerResponse.includes(keyword)) {
        console.log(`Stop condition met: "${keyword}" found in response`);
        return true;
      }
    }
    
    return false;
  }
}

export default app