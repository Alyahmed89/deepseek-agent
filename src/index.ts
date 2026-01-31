// Automatic DeepSeek Agent for OpenHands
// Simple flow: User -> DeepSeek -> OpenHands (automatic processing)
// No /continue endpoint needed - OpenHands processes automatically

import { Hono } from 'hono'

interface CloudflareBindings {
  DEEPSEEK_API_KEY: string
  OPENHANDS_API_URL: string
}

const app = new Hono<{ Bindings: CloudflareBindings }>()

// Root endpoint
app.get('/', (c) => {
  return c.json({ 
    message: 'DeepSeek Agent for OpenHands (Automatic Flow)', 
    endpoints: [
      'POST /start - Start automatic task (DeepSeek -> OpenHands)'
    ],
    flow: 'User task -> DeepSeek analysis -> OpenHands automatic processing',
    note: 'OpenHands processes tasks automatically after receiving DeepSeek instructions. No manual /continue calls needed.'
  })
})

// Helper function to call DeepSeek API
async function callDeepSeek(apiKey: string, prompt: string, context?: string): Promise<{ success: boolean; response?: string; error?: string }> {
  try {
    const deepseekPrompt = context 
      ? `${context}\n\nCurrent prompt: ${prompt}`
      : `You are DeepSeek, an AI assistant that helps with software development tasks. You are working with OpenHands, an automated development agent.

IMPORTANT: Your response will be sent to OpenHands to execute. Provide clear, specific instructions. Do not include any special stop tokens or completion markers like "<<DONE>>". Just provide helpful instructions for OpenHands.

${prompt}`

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
// (Kept for potential future use, but not used in current automatic flow)
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

// Start automatic task (DeepSeek -> OpenHands)
app.post('/start', async (c) => {
  try {
    const { repository, branch, task } = await c.req.json()
    
    if (!repository || !task) {
      return c.json({ error: 'Need repository and task (branch is optional)' }, 400)
    }

    console.log(`Starting automatic task for repository: ${repository}`)
    console.log(`Task: "${task.substring(0, 100)}..."`)
    
    // Step 1: Send task to DeepSeek for analysis and planning
    const deepseekContext = `You are DeepSeek, an AI assistant that helps with software development tasks. You are working with OpenHands, an automated development agent.

Repository: ${repository}${branch ? ` (branch: ${branch})` : ''}

Your response will be sent to OpenHands to execute. Provide clear, specific instructions. Do not include any special stop tokens or completion markers. Just provide helpful instructions for OpenHands.`
    
    console.log(`Sending task to DeepSeek for analysis`)
    
    const deepseekResult = await callDeepSeek(
      c.env.DEEPSEEK_API_KEY,
      task,
      deepseekContext
    )
    
    if (!deepseekResult.success) {
      return c.json({ error: `DeepSeek API failed: ${deepseekResult.error}` }, 500)
    }
    
    // Step 2: Send DeepSeek instructions to OpenHands
    console.log(`Creating OpenHands conversation with DeepSeek's instructions`)
    
    const openhandsCreateResult = await createOpenHandsConversation(
      c.env.OPENHANDS_API_URL,
      repository,
      deepseekResult.response!,
      branch
    )
    
    if (!openhandsCreateResult.success) {
      return c.json({ error: `OpenHands create failed: ${openhandsCreateResult.error}` }, 500)
    }
    
    // Return success response
    return c.json({
      success: true,
      message: 'Task started successfully',
      details: {
        repository,
        branch: branch || 'default',
        task_preview: task.substring(0, 100) + (task.length > 100 ? '...' : ''),
        deepseek_response_preview: deepseekResult.response!.substring(0, 200) + (deepseekResult.response!.length > 200 ? '...' : ''),
        openhands_conversation_id: openhandsCreateResult.conversationId,
        openhands_status_url: `${c.env.OPENHANDS_API_URL.replace(/\/api\/?$/, '')}/conversations/${openhandsCreateResult.conversationId}`,
        note: 'OpenHands is now processing the task automatically. Check the OpenHands conversation for progress.'
      }
    })
    
  } catch (error: any) {
    console.error(`Start endpoint error: ${error.message}`)
    return c.json({ error: error.message }, 500)
  }
})

export default app