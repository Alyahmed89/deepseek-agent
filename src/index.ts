import { Hono } from 'hono'
import { cors } from 'hono/cors'

// Types
interface StartRequest {
  conversation_id: string
  openhands_prompt: string
  deepseek_prompt: string
}

interface DeepSeekMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface DeepSeekRequest {
  model: string
  messages: DeepSeekMessage[]
  stream?: boolean
}

interface OpenHandsEvent {
  id: number
  type: string
  content: string
  source: string
  timestamp: string
}

interface ConversationStatus {
  status: string
  conversation_id: string
  message?: string
  conversation_status?: string
}

// Create Hono app
const app = new Hono<{ Bindings: CloudflareBindings }>()

// Add CORS middleware
app.use('*', cors())

// Helper function to call DeepSeek API
async function callDeepSeekAPI(apiKey: string, messages: DeepSeekMessage[], env: any): Promise<string> {
  const requestBody: DeepSeekRequest = {
    model: 'deepseek-chat',
    messages: messages,
    stream: false
  }

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody)
  })

  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()
  return data.choices[0].message.content
}

// Helper function to call OpenHands API
async function callOpenHandsAPI(
  endpoint: string,
  method: string,
  apiKey: string,
  baseUrl: string,
  body?: any,
  params?: Record<string, string>
): Promise<any> {
  let url = `${baseUrl}${endpoint}`
  
  if (params) {
    const queryParams = new URLSearchParams(params)
    url += `?${queryParams.toString()}`
  }

  const headers: Record<string, string> = {
    'X-Session-API-Key': apiKey,
    'Content-Type': 'application/json'
  }

  const options: RequestInit = {
    method,
    headers
  }

  if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
    options.body = JSON.stringify(body)
  }

  const response = await fetch(url, options)
  
  if (!response.ok) {
    throw new Error(`OpenHands API error: ${response.status} ${response.statusText}`)
  }

  return response.json()
}

// Helper function to parse STOP command
function parseStopCommand(content: string): { context: string; command: string } | null {
  const stopPattern = /\*\[STOP\]\*\s*(?:CONTEXT:\s*"([^"]+)"\s*)?(.*)/i
  const match = content.match(stopPattern)
  
  if (match) {
    return {
      context: match[1] || '',
      command: match[2] || ''
    }
  }
  return null
}

// Main endpoint to start monitoring
app.post('/start', async (c) => {
  try {
    const { conversation_id, openhands_prompt, deepseek_prompt } = await c.req.json<StartRequest>()
    
    if (!conversation_id || !openhands_prompt || !deepseek_prompt) {
      return c.json({ error: 'conversation_id, openhands_prompt, and deepseek_prompt are required' }, 400)
    }

    // Start conversation with OpenHands
    const startResponse = await callOpenHandsAPI(
      `/conversations/${conversation_id}/start`,
      'POST',
      c.env.OPENHANDS_API_KEY,
      c.env.OPENHANDS_API_URL,
      { providers_set: null }
    )

    // Create initial message for DeepSeek with custom prompt
    const systemPrompt = `You are monitoring an OpenHands conversation. Your task is to analyze the conversation and provide guidance.
    
Rules:
1. Monitor the OpenHands agent's actions and responses
2. If you see the agent making errors or going off track, use the STOP command
3. To stop the agent and provide correction, use: *[STOP]* CONTEXT: "brief context" Your correction message here
4. Only use STOP when absolutely necessary
5. Provide helpful guidance and corrections

Your specific monitoring instructions: ${deepseek_prompt}

OpenHands is working on: ${openhands_prompt}`

    const initialMessages: DeepSeekMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `I've started monitoring conversation ${conversation_id}. OpenHands prompt: "${openhands_prompt}". I'll now begin monitoring events with your specific instructions: "${deepseek_prompt}".` }
    ]

    // Get initial DeepSeek response
    const deepseekResponse = await callDeepSeekAPI(c.env.DEEPSEEK_API_KEY, initialMessages, c.env)

    // Check if initial response contains STOP command
    const stopCommand = parseStopCommand(deepseekResponse)
    if (stopCommand) {
      // Stop the conversation if DeepSeek says to stop immediately
      await callOpenHandsAPI(
        `/conversations/${conversation_id}/stop`,
        'POST',
        c.env.OPENHANDS_API_KEY,
        c.env.OPENHANDS_API_URL
      )
      
      return c.json({
        status: 'started_with_stop',
        conversation_id,
        openhands_prompt,
        deepseek_prompt,
        deepseek_response: deepseekResponse,
        stop_command: stopCommand,
        message: 'Conversation started but immediately stopped by DeepSeek guidance'
      })
    }

    // Start monitoring in background (simplified for now)
    // In a real implementation, you would use Durable Objects or queues for background processing
    
    return c.json({
      status: 'started',
      conversation_id,
      openhands_prompt,
      deepseek_prompt,
      deepseek_initial_response: deepseekResponse,
      openhands_status: startResponse,
      message: 'Monitoring started. DeepSeek will analyze conversation events.'
    })

  } catch (error) {
    console.error('Error starting monitoring:', error)
    return c.json({ error: error.message }, 500)
  }
})

// Endpoint to check conversation status and get latest events
app.get('/status/:conversation_id', async (c) => {
  try {
    const conversation_id = c.req.param('conversation_id')
    
    // Get conversation status
    const conversationStatus = await callOpenHandsAPI(
      `/conversations/${conversation_id}`,
      'GET',
      c.env.OPENHANDS_API_KEY,
      c.env.OPENHANDS_API_URL
    )

    // Get recent events
    const events = await callOpenHandsAPI(
      `/conversations/${conversation_id}/events/search`,
      'POST',
      c.env.OPENHANDS_API_KEY,
      c.env.OPENHANDS_API_URL,
      {
        exclude_hidden: false,
        limit: 50,
        reverse: true
      }
    )

    return c.json({
      conversation_id,
      status: conversationStatus,
      recent_events: events,
      timestamp: new Date().toISOString()
    })

  } catch (error) {
    console.error('Error getting status:', error)
    return c.json({ error: error.message }, 500)
  }
})

// Endpoint to manually trigger DeepSeek analysis on current events
app.post('/analyze/:conversation_id', async (c) => {
  try {
    const conversation_id = c.req.param('conversation_id')
    
    // Get recent events
    const events = await callOpenHandsAPI(
      `/conversations/${conversation_id}/events/search`,
      'POST',
      c.env.OPENHANDS_API_KEY,
      c.env.OPENHANDS_API_URL,
      {
        exclude_hidden: false,
        limit: 100,
        reverse: true
      }
    )

    // Format events for DeepSeek
    const eventSummary = events
      .slice(0, 20) // Limit to most recent 20 events
      .map((event: OpenHandsEvent) => 
        `[${event.timestamp}] ${event.type}: ${event.content.substring(0, 200)}${event.content.length > 200 ? '...' : ''}`
      )
      .join('\n')

    const analysisPrompt = `Analyze these recent events from the OpenHands conversation. Provide guidance or corrections if needed.

Recent Events:
${eventSummary}

Should I stop the agent? If yes, use: *[STOP]* CONTEXT: "brief context" Your correction message here`

    const messages: DeepSeekMessage[] = [
      { role: 'system', content: 'You are monitoring an OpenHands conversation. Analyze events and provide guidance.' },
      { role: 'user', content: analysisPrompt }
    ]

    const deepseekResponse = await callDeepSeekAPI(c.env.DEEPSEEK_API_KEY, messages, c.env)
    
    // Check for STOP command
    const stopCommand = parseStopCommand(deepseekResponse)
    if (stopCommand) {
      // Stop the conversation
      await callOpenHandsAPI(
        `/conversations/${conversation_id}/stop`,
        'POST',
        c.env.OPENHANDS_API_KEY,
        c.env.OPENHANDS_API_URL
      )
      
      return c.json({
        status: 'stopped',
        conversation_id,
        analysis: deepseekResponse,
        stop_command: stopCommand,
        message: 'Conversation stopped based on DeepSeek analysis'
      })
    }

    return c.json({
      status: 'analyzed',
      conversation_id,
      analysis: deepseekResponse,
      message: 'Analysis complete. No stop command detected.'
    })

  } catch (error) {
    console.error('Error analyzing conversation:', error)
    return c.json({ error: error.message }, 500)
  }
})

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      deepseek: 'configured',
      openhands: 'configured'
    }
  })
})

export default app

// Type definitions for Cloudflare Bindings
interface CloudflareBindings {
  DEEPSEEK_API_KEY: string
  OPENHANDS_API_URL: string
  OPENHANDS_API_KEY: string
}