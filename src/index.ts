// Minimal DeepSeek Agent for OpenHands
// 2 endpoints: /start and /events

import { Hono } from 'hono'

const app = new Hono<{ Bindings: CloudflareBindings }>()

// Start everything
app.post('/start', async (c) => {
  try {
    const { conversation_id, task, rules } = await c.req.json()
    
    if (!conversation_id || !task || !rules) {
      return c.json({ error: 'Need conversation_id, task, and rules' }, 400)
    }

    // Check conversation status first
    let openhandsResponse = {}
    try {
      // First, get conversation status
      const statusUrl = `${c.env.OPENHANDS_API_URL}/conversations/${conversation_id}`
      const statusRes = await fetch(statusUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      })
      
      if (statusRes.ok) {
        const conversationData = await statusRes.json()
        const conversationStatus = conversationData.status
        
        openhandsResponse = { 
          conversation: conversationData, 
          status: conversationStatus,
          note: 'Conversation found. Will monitor with DeepSeek.' 
        }
        
        // Only try to start if conversation is STOPPED
        if (conversationStatus === 'STOPPED') {
          const startUrl = `${c.env.OPENHANDS_API_URL}/conversations/${conversation_id}/start`
          const startRes = await fetch(startUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ providers_set: null })
          })
          
          if (startRes.ok) {
            const startData = await startRes.json()
            openhandsResponse = { 
              ...openhandsResponse, 
              start: startData, 
              start_status: startRes.status,
              note: 'Conversation started from STOPPED state.' 
            }
          } else {
            openhandsResponse = { 
              ...openhandsResponse, 
              start_error: `Failed to start: ${startRes.status}`, 
              start_response: await startRes.text() 
            }
          }
        }
      } else {
        openhandsResponse = { status_error: `Failed to get status: ${statusRes.status}`, status_response: await statusRes.text() }
      }
    } catch (e) {
      openhandsResponse = { error: e.message }
    }

    // Ask DeepSeek for monitoring plan
    const prompt = `You are monitoring an OpenHands conversation (ID: ${conversation_id}).

OpenHands Task: ${task}

Your Monitoring Rules: ${rules}

You will receive OpenHands events via the /events endpoint. Based on events, you can:

1. STOP OpenHands if it violates rules: *[STOP]* CONTEXT: "reason" message
2. Call any OpenHands API: *[ENDPOINT:METHOD:/path]* {json}
3. Respond with analysis

Available OpenHands APIs (base: ${c.env.OPENHANDS_API_URL}):
- GET /conversations/{id} - Get conversation status
- POST /conversations/{id}/stop - Stop conversation
- POST /conversations/{id}/events - Send event (currently returns 500)

What's your monitoring plan for this task?`
    
    const deepseekRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }] })
    })
    const deepseekData = await deepseekRes.json()
    const deepseekResponse = deepseekData.choices[0].message.content

    // Execute any actions
    const actions = []
    
    // Check STOP
    const stopMatch = deepseekResponse.match(/\*\[STOP\]\*\s*CONTEXT:\s*"([^"]+)"\s*(.*)/i)
    if (stopMatch) {
      await fetch(`${c.env.OPENHANDS_API_URL}/conversations/${conversation_id}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: stopMatch[2] })
      })
      actions.push({ type: 'stop', reason: stopMatch[1] })
    }

    // Check endpoints
    const endpointRegex = /\*\[ENDPOINT:(\w+):([^\]]+)\]\*\s*(\{[\s\S]*?\})/g
    let match
    while ((match = endpointRegex.exec(deepseekResponse)) !== null) {
      try {
        const params = JSON.parse(match[3])
        const endpointRes = await fetch(`${c.env.OPENHANDS_API_URL}${match[2]}`, {
          method: match[1],
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params.body || params)
        })
        const endpointData = await endpointRes.json()
        actions.push({ type: 'endpoint', method: match[1], endpoint: match[2], result: endpointData })
      } catch (e) {}
    }

    return c.json({
      status: 'started',
      conversation_id,
      task,
      rules,
      openhands: openhandsResponse,
      deepseek: deepseekResponse,
      actions,
      next: 'Send OpenHands events to /events endpoint'
    })

  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Forward OpenHands events to DeepSeek
app.post('/events', async (c) => {
  try {
    const { conversation_id, event } = await c.req.json()
    
    if (!conversation_id || !event) {
      return c.json({ error: 'Need conversation_id and event' }, 400)
    }
    
    // Get conversation context first
    let conversationContext = ''
    try {
      const statusRes = await fetch(`${c.env.OPENHANDS_API_URL}/conversations/${conversation_id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      })
      if (statusRes.ok) {
        const conversationData = await statusRes.json()
        conversationContext = `Conversation ${conversation_id} is ${conversationData.status}. `
      }
    } catch (e) {
      // Ignore, use default context
    }
    
    const prompt = `${conversationContext}OpenHands event received:

Event Type: ${event.type || 'unknown'}
Content: ${typeof event.content === 'string' ? event.content : JSON.stringify(event.content, null, 2)}
Source: ${event.source || 'unknown'}
Metadata: ${event.metadata ? JSON.stringify(event.metadata, null, 2) : 'none'}

What should I do? You can:
1. STOP OpenHands if it violates rules: *[STOP]* CONTEXT: "reason" message
2. Call any OpenHands API: *[ENDPOINT:METHOD:/path]* {json}
3. Respond with analysis or feedback

Remember: You're monitoring OpenHands for security issues and rule violations.`
    
    const deepseekRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        model: 'deepseek-chat', 
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3
      })
    })
    
    if (!deepseekRes.ok) {
      return c.json({ 
        error: `DeepSeek API error: ${deepseekRes.status}`,
        status: deepseekRes.status,
        response: await deepseekRes.text()
      }, 500)
    }
    
    const deepseekData = await deepseekRes.json()
    const response = deepseekData.choices[0].message.content

    // Execute actions
    const actions = []
    
    // Check for STOP command
    const stopMatch = response.match(/\*\[STOP\]\*\s*CONTEXT:\s*"([^"]+)"\s*(.+)/s)
    if (stopMatch) {
      try {
        const stopRes = await fetch(`${c.env.OPENHANDS_API_URL}/conversations/${conversation_id}/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: stopMatch[2] })
        })
        const stopData = stopRes.ok ? await stopRes.json() : { error: `Stop failed: ${stopRes.status}` }
        actions.push({ type: 'stop', context: stopMatch[1], message: stopMatch[2], result: stopData })
      } catch (e) {
        actions.push({ type: 'stop', error: e.message })
      }
    }
    
    // Check for endpoint calls
    const endpointRegex = /\*\[ENDPOINT:([A-Z]+):([^\]]+)\]\*\s*(\{.*?\})/gs
    let endpointMatch
    while ((endpointMatch = endpointRegex.exec(response)) !== null) {
      try {
        const params = JSON.parse(endpointMatch[3])
        const endpointRes = await fetch(`${c.env.OPENHANDS_API_URL}${endpointMatch[2]}`, {
          method: endpointMatch[1],
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params.body || params)
        })
        const endpointData = endpointRes.ok ? await endpointRes.json() : { error: `Endpoint failed: ${endpointRes.status}` }
        actions.push({ type: 'endpoint', method: endpointMatch[1], endpoint: endpointMatch[2], result: endpointData })
      } catch (e) {
        actions.push({ type: 'endpoint', error: e.message, endpoint: endpointMatch[2] })
      }
    }

    return c.json({
      status: 'event_processed',
      conversation_id,
      event_received: {
        type: event.type,
        content_preview: typeof event.content === 'string' ? 
          (event.content.length > 100 ? event.content.substring(0, 100) + '...' : event.content) : 
          'object',
        source: event.source
      },
      deepseek_response: response,
      actions_executed: actions.length > 0 ? actions : 'No actions triggered',
      note: 'Event forwarded to DeepSeek. Check actions_executed for automatic actions.'
    })
    
  } catch (error) {
    return c.json({ error: error.message, stack: error.stack }, 500)
  }
})

export default app

interface CloudflareBindings {
  DEEPSEEK_API_KEY: string
  OPENHANDS_API_URL: string
}