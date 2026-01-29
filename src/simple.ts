// Minimal DeepSeek Agent for OpenHands
// Simple transfer: Get OpenHands conversation, send to DeepSeek, return response

import { Hono } from 'hono'

const app = new Hono<{ Bindings: CloudflareBindings }>()

// Simple transfer endpoint
app.post('/start', async (c) => {
  try {
    const { conversation_id, first_prompt } = await c.req.json()
    
    if (!conversation_id || !first_prompt) {
      return c.json({ error: 'Need conversation_id and first_prompt' }, 400)
    }

    // 1. Get OpenHands conversation info
    let openhandsInfo = {}
    let lastResponse = null
    
    try {
      const conversationUrl = `${c.env.OPENHANDS_API_URL}/conversations/${conversation_id}`
      const conversationRes = await fetch(conversationUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      })
      
      if (conversationRes.ok) {
        const conversationData = await conversationRes.json()
        openhandsInfo = {
          status: conversationData.status,
          conversation: conversationData
        }
        
        // Try to get the last message/response from conversation data
        // This depends on OpenHands API structure
        if (conversationData.last_message) {
          lastResponse = conversationData.last_message
        } else if (conversationData.messages && conversationData.messages.length > 0) {
          lastResponse = conversationData.messages[conversationData.messages.length - 1]
        } else {
          lastResponse = { note: 'No last response found in conversation data' }
        }
      } else {
        openhandsInfo = { error: `Failed to get conversation: ${conversationRes.status}`, response: await conversationRes.text() }
      }
    } catch (e) {
      openhandsInfo = { error: e.message }
    }

    // 2. Send to DeepSeek
    const prompt = `OpenHands Conversation ID: ${conversation_id}

First Prompt/Context: ${first_prompt}

OpenHands Conversation Info: ${JSON.stringify(openhandsInfo, null, 2)}

Last Response from OpenHands: ${JSON.stringify(lastResponse, null, 2)}

You are DeepSeek agent monitoring OpenHands. Based on the above, what should you do?

You can:
1. STOP OpenHands if needed: *[STOP]* CONTEXT: "reason" message
2. Call any OpenHands API: *[ENDPOINT:METHOD:/path]* {json}
3. Respond with feedback/analysis

What's your response?`
    
    const deepseekRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        model: 'deepseek-chat', 
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
      })
    })
    
    if (!deepseekRes.ok) {
      return c.json({ 
        error: `DeepSeek API error: ${deepseekRes.status}`,
        response: await deepseekRes.text()
      }, 500)
    }
    
    const deepseekData = await deepseekRes.json()
    const deepseekResponse = deepseekData.choices[0].message.content

    // 3. Execute any actions DeepSeek wants to take
    const actions = []
    
    // Check for STOP command
    const stopMatch = deepseekResponse.match(/\*\[STOP\]\*\s*CONTEXT:\s*"([^"]+)"\s*(.+)/s)
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
    while ((endpointMatch = endpointRegex.exec(deepseekResponse)) !== null) {
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

    // 4. Return DeepSeek's response
    return c.json({
      status: 'completed',
      conversation_id,
      first_prompt,
      openhands_info: openhandsInfo,
      last_response_from_openhands: lastResponse,
      deepseek_response: deepseekResponse,
      actions_taken: actions.length > 0 ? actions : 'No actions taken',
      note: 'DeepSeek has analyzed the OpenHands conversation. Copy the deepseek_response to OpenHands if needed.'
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