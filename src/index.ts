// Minimal DeepSeek Agent for OpenHands
// Simple transfer: Create OpenHands conversation with initial message, send to DeepSeek, return response

import { Hono } from 'hono'

interface CloudflareBindings {
  DEEPSEEK_API_KEY: string
  OPENHANDS_API_URL: string
}

const app = new Hono<{ Bindings: CloudflareBindings }>()

// Root endpoint
app.get('/', (c) => {
  return c.json({ message: 'DeepSeek Agent for OpenHands', endpoints: ['POST /start'] })
})

// Simple transfer endpoint
app.post('/start', async (c) => {
  try {
    const { repository, branch, first_prompt } = await c.req.json()
    
    if (!repository || !first_prompt) {
      return c.json({ error: 'Need repository and first_prompt (branch is optional)' }, 400)
    }

    // 1. Create OpenHands conversation with initial_user_msg
    let openhandsInfo: { status: string, conversation_id: string | null, title: string | null } = { status: 'unknown', conversation_id: null, title: null }
    let lastResponse = { note: 'Creating new OpenHands conversation' }
    
    try {
      // Ensure we don't have double slashes in the URL
      const createUrl = c.env.OPENHANDS_API_URL.endsWith('/') 
        ? `${c.env.OPENHANDS_API_URL}conversations`
        : `${c.env.OPENHANDS_API_URL}/conversations`
      console.log(`Creating OpenHands conversation: ${createUrl}`)
      
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000) // 5 second timeout
      
      const createBody: any = {
        initial_user_msg: first_prompt,
        repository: repository
      }
      
      if (branch) {
        createBody.selected_branch = branch
      }
      
      const createRes = await fetch(createUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
        signal: controller.signal
      })
      
      clearTimeout(timeoutId)
      
      if (createRes.ok) {
        const createData = await createRes.json() as any
        console.log(`Created OpenHands conversation: id=${createData.conversation_id}, status=${createData.conversation_status}`)
        
        openhandsInfo = {
          status: createData.conversation_status || 'unknown',
          conversation_id: createData.conversation_id,
          title: 'New conversation'
        }
        
        // The conversation is created with initial_user_msg, so it should process automatically
        lastResponse = { note: `Conversation created with ID: ${createData.conversation_id}. Initial message sent: "${first_prompt.substring(0, 50)}..."` }
      } else {
        console.log(`OpenHands create API returned ${createRes.status}: ${await createRes.text()}`)
        return c.json({ error: `Failed to create OpenHands conversation: ${createRes.status}` }, 500)
      }
    } catch (e: any) {
      console.log(`OpenHands create error: ${e.message}`)
      return c.json({ error: `Failed to create OpenHands conversation: ${e.message}` }, 500)
    }

    // 2. Send to DeepSeek
    const prompt = `OpenHands Conversation ID: ${openhandsInfo.conversation_id}

Context/Task for DeepSeek: ${first_prompt}

OpenHands Status: ${openhandsInfo.status}

You are DeepSeek agent monitoring OpenHands. Based on the above, what should you do?

You can:
1. STOP OpenHands if needed: *[STOP]* CONTEXT: "reason" message
2. Call any OpenHands API: *[ENDPOINT:METHOD:/path]* {json}
3. Respond with feedback/analysis

What's your response?`
    
    console.log(`Sending to DeepSeek...`)
    
    const deepseekController = new AbortController()
    const deepseekTimeoutId = setTimeout(() => deepseekController.abort(), 10000) // 10 second timeout
    
    const deepseekRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        model: 'deepseek-chat', 
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
      }),
      signal: deepseekController.signal
    })
    
    clearTimeout(deepseekTimeoutId)
    
    if (!deepseekRes.ok) {
      return c.json({ 
        error: `DeepSeek API error: ${deepseekRes.status}`,
        response: await deepseekRes.text()
      }, 500)
    }
    
    const deepseekData = await deepseekRes.json() as any
    const deepseekResponse = deepseekData.choices[0].message.content

    // 3. Execute any actions DeepSeek wants to take
    const actions: any[] = []
    
    // Check for STOP command
    const stopMatch = deepseekResponse.match(/\*\[STOP\]\*\s*CONTEXT:\s*"([^"]+)"\s*([\s\S]+)/)
    if (stopMatch) {
      try {
        // Ensure we don't have double slashes in the URL
        const stopUrl = c.env.OPENHANDS_API_URL.endsWith('/')
          ? `${c.env.OPENHANDS_API_URL}conversations/${openhandsInfo.conversation_id}/stop`
          : `${c.env.OPENHANDS_API_URL}/conversations/${openhandsInfo.conversation_id}/stop`
        const stopRes = await fetch(stopUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: stopMatch[2] })
        })
        const stopData = stopRes.ok ? await stopRes.json() : { error: `Stop failed: ${stopRes.status}` }
        actions.push({ type: 'stop', context: stopMatch[1], message: stopMatch[2], result: stopData })
      } catch (e: any) {
        actions.push({ type: 'stop', error: e.message })
      }
    }
    
    // Check for endpoint calls
    const endpointRegex = /\*\[ENDPOINT:([A-Z]+):([^\]]+)\]\*\s*(?:```(?:json)?\s*)?(\{[\s\S]*?\})(?:\s*```)?/g
    let endpointMatch
    while ((endpointMatch = endpointRegex.exec(deepseekResponse)) !== null) {
      try {
        const params = JSON.parse(endpointMatch[3])
        // Ensure we don't have double slashes in the URL
        const endpointPath = endpointMatch[2].startsWith('/') ? endpointMatch[2].substring(1) : endpointMatch[2]
        const endpointUrl = `${c.env.OPENHANDS_API_URL}/${endpointPath}`
        const endpointRes = await fetch(endpointUrl, {
          method: endpointMatch[1],
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params.body || params)
        })
        const endpointData = endpointRes.ok ? await endpointRes.json() : { error: `Endpoint failed: ${endpointRes.status}` }
        actions.push({ type: 'endpoint', method: endpointMatch[1], endpoint: endpointMatch[2], result: endpointData })
      } catch (e: any) {
        actions.push({ type: 'endpoint', error: e.message, endpoint: endpointMatch[2] })
      }
    }

    // 4. Return DeepSeek's response
    return c.json({
      status: 'completed',
      conversation_id: openhandsInfo.conversation_id,
      repository,
      branch,
      first_prompt,
      openhands_info: openhandsInfo,
      last_response_from_openhands: lastResponse,
      deepseek_response: deepseekResponse,
      actions_taken: actions.length > 0 ? actions : 'No actions taken',
      note: actions.length > 0 
        ? 'OpenHands conversation created. DeepSeek has analyzed it and actions have been executed automatically.'
        : 'OpenHands conversation created with initial message. DeepSeek has analyzed it. No actions were taken from the response.'
    })

  } catch (error: any) {
    return c.json({ error: error.message, stack: error.stack }, 500)
  }
})

export default app

interface CloudflareBindings {
  DEEPSEEK_API_KEY: string
  OPENHANDS_API_URL: string
}