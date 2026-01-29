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

    // Try to start the conversation first
    let openhandsResponse = {}
    try {
      const startUrl = `${c.env.OPENHANDS_API_URL}/conversations/${conversation_id}/start`
      const startRes = await fetch(startUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers_set: null })
      })
      
      if (startRes.ok) {
        openhandsResponse = { start: await startRes.json(), start_status: startRes.status }
        
        // Wait a bit for conversation to start
        await new Promise(resolve => setTimeout(resolve, 1000))
        
        // Then send the task as an event
        try {
          const eventUrl = `${c.env.OPENHANDS_API_URL}/conversations/${conversation_id}/events`
          const eventRes = await fetch(eventUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'user_message',
              content: task,
              metadata: { source: 'deepseek_agent', task_type: 'initial' }
            })
          })
          if (eventRes.ok) {
            openhandsResponse = { ...openhandsResponse, event_sent: true, event_response: await eventRes.json(), event_status: eventRes.status }
          } else {
            openhandsResponse = { ...openhandsResponse, event_sent: false, event_error: `Failed to send event: ${eventRes.status}`, event_response_text: await eventRes.text() }
          }
        } catch (e) {
          openhandsResponse = { ...openhandsResponse, event_sent: false, event_error: e.message }
        }
      } else {
        openhandsResponse = { start_error: `Failed to start: ${startRes.status}`, start_response: await startRes.text() }
      }
    } catch (e) {
      openhandsResponse = { error: e.message }
    }

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
        headers: { 'Content-Type': 'application/json' },
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
          headers: { 'Content-Type': 'application/json' },
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
}