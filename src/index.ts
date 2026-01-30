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

    // 1. Send first_prompt to DeepSeek
    console.log(`Sending first_prompt to DeepSeek: "${first_prompt.substring(0, 50)}..."`)
    
    const deepseekPrompt = `You are DeepSeek agent helping with OpenHands. A user has requested help with their repository.

Repository: ${repository}${branch ? ` (branch: ${branch})` : ''}

User Request: ${first_prompt}

Please provide a helpful response to the user's request. Your response will be used as the initial message in an OpenHands conversation.`

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

    // 2. Create OpenHands conversation with DeepSeek's response as initial message
    let openhandsInfo: { status: string, conversation_id: string | null, title: string | null } = { status: 'unknown', conversation_id: null, title: null }
    let lastResponse = { note: 'Creating OpenHands conversation with DeepSeek response' }
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
        initial_user_msg: deepseekResponse, // Use DeepSeek's response as initial message
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
        
        lastResponse = { note: `Conversation created with ID: ${createData.conversation_id}. DeepSeek's response used as initial message.` }
        actions.push({ type: 'create_conversation', result: 'success', conversation_id: createData.conversation_id })
      } else {
        console.log(`OpenHands create API returned ${createRes.status}: ${await createRes.text()}`)
        return c.json({ error: `Failed to create OpenHands conversation: ${createRes.status}` }, 500)
      }
    } catch (e: any) {
      console.log(`OpenHands create error: ${e.message}`)
      return c.json({ error: `Failed to create OpenHands conversation: ${e.message}` }, 500)
    }

    // 3. Return the result
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
      note: 'First prompt sent to DeepSeek. DeepSeek response used as initial message for OpenHands conversation.'
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