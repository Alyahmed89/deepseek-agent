// Simplified DeepSeek Agent for OpenHands
// Continuous loop: DeepSeek <-> OpenHands until "done" or stop condition

import { Hono } from 'hono'

interface CloudflareBindings {
  DEEPSEEK_API_KEY: string
  OPENHANDS_API_URL: string
}

const app = new Hono<{ Bindings: CloudflareBindings }>()

// Root endpoint
app.get('/', (c) => {
  return c.json({ 
    message: 'DeepSeek Agent for OpenHands (Simplified Flow)', 
    endpoints: [
      'POST /start - Start a new conversation loop',
      'POST /continue/:conversation_id - Continue an existing conversation'
    ] 
  })
})

// Helper function to call DeepSeek API
async function callDeepSeek(apiKey: string, prompt: string, context?: string): Promise<{ success: boolean; response?: string; error?: string }> {
  try {
    const deepseekPrompt = context 
      ? `${context}\n\nCurrent prompt: ${prompt}`
      : `You are DeepSeek agent helping with OpenHands. Please respond to the following:\n\n${prompt}`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 30000)
    
    const deepseekRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${apiKey}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ 
        model: 'deepseek-chat', 
        messages: [{ role: 'user', content: deepseekPrompt }],
        temperature: 0.7,
        max_tokens: 2000
      }),
      signal: controller.signal
    })
    
    clearTimeout(timeoutId)
    
    if (!deepseekRes.ok) {
      const errorText = await deepseekRes.text()
      console.error(`DeepSeek API error: ${deepseekRes.status} - ${errorText}`)
      return { 
        success: false, 
        error: `DeepSeek API error: ${deepseekRes.status}` 
      }
    }
    
    const deepseekData = await deepseekRes.json() as any
    const response = deepseekData.choices[0].message.content
    console.log(`DeepSeek response received (${response.length} chars)`)
    
    return { success: true, response }
  } catch (error: any) {
    console.error(`DeepSeek call error: ${error.message}`)
    return { success: false, error: error.message }
  }
}

// Helper function to create OpenHands conversation
async function createOpenHandsConversation(
  apiUrl: string, 
  repository: string, 
  initialMessage: string, 
  branch?: string
): Promise<{ success: boolean; conversationId?: string; error?: string }> {
  try {
    const createUrl = apiUrl.endsWith('/') 
      ? `${apiUrl}conversations`
      : `${apiUrl}/conversations`
    
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)
    
    const createBody: any = {
      initial_user_msg: initialMessage,
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
      const conversationId = createData.conversation_id
      console.log(`Created OpenHands conversation: ${conversationId}`)
      return { success: true, conversationId }
    } else {
      const errorText = await createRes.text()
      console.error(`OpenHands create error: ${createRes.status} - ${errorText}`)
      return { 
        success: false, 
        error: `Failed to create OpenHands conversation: ${createRes.status}` 
      }
    }
  } catch (error: any) {
    console.error(`OpenHands create call error: ${error.message}`)
    return { success: false, error: error.message }
  }
}

// Helper function to send message to existing OpenHands conversation
async function sendToOpenHandsConversation(
  apiUrl: string,
  conversationId: string,
  message: string
): Promise<{ success: boolean; response?: any; error?: string }> {
  try {
    const messageUrl = apiUrl.endsWith('/')
      ? `${apiUrl}conversations/${conversationId}/messages`
      : `${apiUrl}/conversations/${conversationId}/messages`
    
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)
    
    const messageRes = await fetch(messageUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: controller.signal
    })
    
    clearTimeout(timeoutId)
    
    if (messageRes.ok) {
      const responseData = await messageRes.json()
      console.log(`Message sent to OpenHands conversation: ${conversationId}`)
      return { success: true, response: responseData }
    } else {
      const errorText = await messageRes.text()
      console.error(`OpenHands message error: ${messageRes.status} - ${errorText}`)
      return { 
        success: false, 
        error: `Failed to send message to OpenHands: ${messageRes.status}` 
      }
    }
  } catch (error: any) {
    console.error(`OpenHands message call error: ${error.message}`)
    return { success: false, error: error.message }
  }
}

// Helper function to check if we should stop the loop
function shouldStopLoop(response: string): boolean {
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

// Start a new conversation loop
app.post('/start', async (c) => {
  try {
    const { repository, branch, first_prompt } = await c.req.json()
    
    if (!repository || !first_prompt) {
      return c.json({ error: 'Need repository and first_prompt (branch is optional)' }, 400)
    }

    console.log(`Starting new conversation loop for repository: ${repository}`)
    
    // Step 1: Send first prompt to DeepSeek
    console.log(`Sending first prompt to DeepSeek: "${first_prompt.substring(0, 100)}..."`)
    
    const deepseekResult = await callDeepSeek(
      c.env.DEEPSEEK_API_KEY,
      first_prompt,
      `You are DeepSeek agent helping with OpenHands. A user has requested help with their repository.
      
Repository: ${repository}${branch ? ` (branch: ${branch})` : ''}

Please provide a helpful response to the user's request. Your response will be sent to OpenHands to start working on the task.`
    )
    
    if (!deepseekResult.success) {
      return c.json({ error: `DeepSeek API failed: ${deepseekResult.error}` }, 500)
    }
    
    // Check if DeepSeek says "done" already
    if (shouldStopLoop(deepseekResult.response!)) {
      return c.json({
        status: 'completed',
        reason: 'DeepSeek indicated completion in first response',
        deepseek_response: deepseekResult.response,
        note: 'Loop stopped immediately as DeepSeek indicated the task is complete.'
      })
    }
    
    // Step 2: Send DeepSeek response to OpenHands
    console.log(`Creating OpenHands conversation with DeepSeek's response`)
    
    const openhandsCreateResult = await createOpenHandsConversation(
      c.env.OPENHANDS_API_URL,
      repository,
      deepseekResult.response!,
      branch
    )
    
    if (!openhandsCreateResult.success) {
      return c.json({ error: `OpenHands create failed: ${openhandsCreateResult.error}` }, 500)
    }
    
    // Return initial response
    return c.json({
      status: 'loop_started',
      conversation_id: openhandsCreateResult.conversationId,
      deepseek_response: deepseekResult.response,
      note: `Conversation loop started. OpenHands is processing the initial task. Use POST /continue/${openhandsCreateResult.conversationId} to continue the loop when OpenHands responds.`,
      next_steps: [
        'OpenHands will process the initial task',
        'When OpenHands completes, call /continue endpoint with OpenHands response',
        'DeepSeek will analyze the response and provide next steps',
        'Loop continues until DeepSeek says "done"'
      ]
    })
    
  } catch (error: any) {
    console.error(`Start endpoint error: ${error.message}`)
    return c.json({ error: error.message }, 500)
  }
})

// Continue an existing conversation loop
app.post('/continue/:conversation_id', async (c) => {
  try {
    const conversationId = c.req.param('conversation_id')
    const { openhands_response, iteration = 1, max_iterations = 10 } = await c.req.json()
    
    if (!openhands_response) {
      return c.json({ error: 'Need openhands_response' }, 400)
    }
    
    console.log(`Continuing conversation loop: ${conversationId} (iteration ${iteration})`)
    
    // Check max iterations
    if (iteration >= max_iterations) {
      return c.json({
        status: 'completed',
        reason: `Maximum iterations reached (${max_iterations})`,
        note: 'Loop stopped due to maximum iteration limit.'
      })
    }
    
    // Step 1: Send OpenHands response to DeepSeek for analysis
    console.log(`Sending OpenHands response to DeepSeek for analysis`)
    
    const deepseekResult = await callDeepSeek(
      c.env.DEEPSEEK_API_KEY,
      openhands_response,
      `You are DeepSeek agent monitoring an OpenHands conversation.

OpenHands has responded to your previous instructions. Analyze their response and provide next steps or instructions.

If the task is complete or no further action is needed, say "done" or "task completed". Otherwise, provide clear next steps for OpenHands.`
    )
    
    if (!deepseekResult.success) {
      return c.json({ error: `DeepSeek API failed: ${deepseekResult.error}` }, 500)
    }
    
    // Check if DeepSeek says "done"
    if (shouldStopLoop(deepseekResult.response!)) {
      return c.json({
        status: 'completed',
        conversation_id: conversationId,
        iteration: iteration + 1,
        reason: 'DeepSeek indicated completion',
        deepseek_response: deepseekResult.response,
        note: 'Loop completed as DeepSeek indicated the task is complete.'
      })
    }
    
    // Step 2: Send DeepSeek response back to OpenHands
    console.log(`Sending DeepSeek response back to OpenHands`)
    
    const openhandsResult = await sendToOpenHandsConversation(
      c.env.OPENHANDS_API_URL,
      conversationId,
      deepseekResult.response!
    )
    
    if (!openhandsResult.success) {
      return c.json({ error: `Failed to send to OpenHands: ${openhandsResult.error}` }, 500)
    }
    
    // Return continuation response
    return c.json({
      status: 'loop_continuing',
      conversation_id: conversationId,
      iteration: iteration + 1,
      deepseek_response: deepseekResult.response,
      note: `Loop continued. OpenHands is processing the next steps. Call /continue/${conversationId} again when OpenHands responds.`,
      next_steps: [
        'OpenHands will process the new instructions',
        'When OpenHands completes, call this endpoint again with the response',
        `Remaining iterations: ${max_iterations - iteration - 1}`
      ]
    })
    
  } catch (error: any) {
    console.error(`Continue endpoint error: ${error.message}`)
    return c.json({ error: error.message }, 500)
  }
})

export default app