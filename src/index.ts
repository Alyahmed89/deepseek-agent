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

    // Start OpenHands
    const openhandsRes = await fetch(`${c.env.OPENHANDS_API_URL}/conversations/${conversation_id}/start`, {
      method: 'POST',
      headers: { 'X-Session-API-Key': c.env.OPENHANDS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers_set: null })
    })
    const openhandsData = await openhandsRes.json()

    // Ask DeepSeek
    const prompt = `Task for OpenHands: ${task}\n\nYour rules: ${rules}\n\nYou can:\n1. Stop: *[STOP]* CONTEXT: "reason" message\n2. Call API: *[ENDPOINT:METHOD:/path]* {json}\n3. Respond\n\nYour plan?`
    
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
        headers: { 'X-Session-API-Key': c.env.OPENHANDS_API_KEY, 'Content-Type': 'application/json' },
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
          headers: { 'X-Session-API-Key': c.env.OPENHANDS_API_KEY, 'Content-Type': 'application/json' },
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
      openhands: openhandsData,
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
    
    const prompt = `OpenHands event:\n${JSON.stringify(event, null, 2)}\n\nWhat to do?`
    
    const deepseekRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }] })
    })
    const deepseekData = await deepseekRes.json()
    const response = deepseekData.choices[0].message.content

    // Execute actions
    const actions = []
    
    const stopMatch = response.match(/\*\[STOP\]\*\s*CONTEXT:\s*"([^"]+)"\s*(.*)/i)
    if (stopMatch) {
      await fetch(`${c.env.OPENHANDS_API_URL}/conversations/${conversation_id}/stop`, {
        method: 'POST',
        headers: { 'X-Session-API-Key': c.env.OPENHANDS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: stopMatch[2] })
      })
      actions.push({ type: 'stop', reason: stopMatch[1] })
    }

    const endpointRegex = /\*\[ENDPOINT:(\w+):([^\]]+)\]\*\s*(\{[\s\S]*?\})/g
    let match
    while ((match = endpointRegex.exec(response)) !== null) {
      try {
        const params = JSON.parse(match[3])
        const endpointRes = await fetch(`${c.env.OPENHANDS_API_URL}${match[2]}`, {
          method: match[1],
          headers: { 'X-Session-API-Key': c.env.OPENHANDS_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(params.body || params)
        })
        const endpointData = await endpointRes.json()
        actions.push({ type: 'endpoint', method: match[1], endpoint: match[2], result: endpointData })
      } catch (e) {}
    }

    return c.json({
      status: 'processed',
      deepseek_response: response,
      actions
    })

  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

export default app

interface CloudflareBindings {
  DEEPSEEK_API_KEY: string
  OPENHANDS_API_URL: string
  OPENHANDS_API_KEY: string
}