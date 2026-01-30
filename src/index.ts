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

    // 1. First create an empty OpenHands conversation
    let openhandsInfo: { status: string, conversation_id: string | null, title: string | null } = { status: 'unknown', conversation_id: null, title: null }
    let lastResponse = { note: 'Creating new OpenHands conversation' }
    const actions: any[] = []
    
    try {
      // Ensure we don't have double slashes in the URL
      const createUrl = c.env.OPENHANDS_API_URL.endsWith('/') 
        ? `${c.env.OPENHANDS_API_URL}conversations`
        : `${c.env.OPENHANDS_API_URL}/conversations`
      console.log(`Creating OpenHands conversation: ${createUrl}`)
      
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000) // 5 second timeout
      
      const createBody: any = {
        initial_user_msg: '', // Empty initial message - DeepSeek will provide the first message
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
        
        lastResponse = { note: `Conversation created with ID: ${createData.conversation_id}` }
        actions.push({ type: 'create_conversation', result: 'success', conversation_id: createData.conversation_id })
      } else {
        console.log(`OpenHands create API returned ${createRes.status}: ${await createRes.text()}`)
        return c.json({ error: `Failed to create OpenHands conversation: ${createRes.status}` }, 500)
      }
    } catch (e: any) {
      console.log(`OpenHands create error: ${e.message}`)
      return c.json({ error: `Failed to create OpenHands conversation: ${e.message}` }, 500)
    }

    // 2. Send first_prompt to DeepSeek with conversation context
    console.log(`Sending first_prompt to DeepSeek: "${first_prompt.substring(0, 50)}..."`)
    
    const deepseekPrompt = `OpenHands Conversation ID: ${openhandsInfo.conversation_id}
Repository: ${repository}${branch ? ` (branch: ${branch})` : ''}

User Request: ${first_prompt}

You are DeepSeek agent helping with OpenHands. The OpenHands conversation has been created but has no initial message yet.
Please provide your response to the user's request. Your response will be sent as the first message to OpenHands.

Respond with: *[ENDPOINT:POST:/tasks/${openhandsInfo.conversation_id}/messages]* {json}
Where {json} contains your message in the format: {"content": "your response here", "role": "assistant"}`

    const deepseekController = new AbortController()
    const deepseekTimeoutId = setTimeout(() => deepseekController.abort(), 10000) // 10 second timeout
    
    const deepseekRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        model: 'deepseek-chat', 
        messages: [{ role: 'user', content: deepseekPrompt }],
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
    console.log(`DeepSeek response received: ${deepseekResponse.substring(0, 100)}...`)

    // 3. Execute any endpoint calls from DeepSeek's response
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
        lastResponse = { note: `Message sent to OpenHands via endpoint: ${endpointMatch[2]}` }
      } catch (e: any) {
        actions.push({ type: 'endpoint', error: e.message, endpoint: endpointMatch[2] })
      }
    }

    // 4. Return the result
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
      note: 'OpenHands conversation created. First prompt sent to DeepSeek. DeepSeek response sent to OpenHands as first message.'
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