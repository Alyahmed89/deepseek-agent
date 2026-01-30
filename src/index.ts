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

    // 1. Send first_prompt to DeepSeek to get initial response
    console.log(`Sending first_prompt to DeepSeek: "${first_prompt.substring(0, 50)}..."`)
    
    const initialDeepseekPrompt = `You are DeepSeek agent helping with OpenHands. A user has requested help with their repository.

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
        messages: [{ role: 'user', content: initialDeepseekPrompt }],
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
    const initialDeepseekResponse = deepseekData.choices[0].message.content
    console.log(`DeepSeek initial response received: ${initialDeepseekResponse.substring(0, 100)}...`)

    // 2. Create OpenHands conversation with DeepSeek's response as initial message
    let openhandsInfo: { status: string, conversation_id: string | null, title: string | null, runtime_status?: string } = { status: 'unknown', conversation_id: null, title: null }
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
        initial_user_msg: initialDeepseekResponse, // Use DeepSeek's response as initial message
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

    // 3. Poll OpenHands conversation status to check when it's done
    let finalDeepseekResponse = initialDeepseekResponse
    let followupAnalysis = null
    
    if (openhandsInfo.conversation_id) {
      console.log(`Polling OpenHands conversation status: ${openhandsInfo.conversation_id}`)
      
      // Poll for up to 30 seconds (6 attempts with 5 second delay)
      for (let i = 0; i < 6; i++) {
        try {
          const statusUrl = c.env.OPENHANDS_API_URL.endsWith('/') 
            ? `${c.env.OPENHANDS_API_URL}conversations/${openhandsInfo.conversation_id}`
            : `${c.env.OPENHANDS_API_URL}/conversations/${openhandsInfo.conversation_id}`
          
          const statusController = new AbortController()
          const statusTimeoutId = setTimeout(() => statusController.abort(), 3000)
          const statusRes = await fetch(statusUrl, { signal: statusController.signal })
          clearTimeout(statusTimeoutId)
          
          if (statusRes.ok) {
            const statusData = await statusRes.json() as any
            console.log(`Poll ${i + 1}: status=${statusData.status}, runtime_status=${statusData.runtime_status}`)
            
            openhandsInfo.status = statusData.status
            openhandsInfo.runtime_status = statusData.runtime_status
            
            // Check if conversation is no longer running
            if (statusData.status !== 'RUNNING' || statusData.runtime_status === 'STATUS$READY') {
              console.log(`OpenHands conversation appears to be done or waiting. Getting follow-up from DeepSeek...`)
              
              // 4. Get follow-up analysis from DeepSeek
              const followupPrompt = `You are DeepSeek agent monitoring an OpenHands conversation.

Initial Task: Help with repository ${repository}${branch ? ` (branch: ${branch})` : ''}
User's Original Request: "${first_prompt}"

Your Initial Response to OpenHands: "${initialDeepseekResponse.substring(0, 200)}..."

OpenHands Conversation Status: ${statusData.status}
Runtime Status: ${statusData.runtime_status}

OpenHands has processed your initial instructions. Based on the task and your initial guidance, what should be done next? Provide analysis, suggestions, or next steps.`

              const followupController = new AbortController()
              const followupTimeoutId = setTimeout(() => followupController.abort(), 10000)
              
              const followupRes = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${c.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                  model: 'deepseek-chat', 
                  messages: [{ role: 'user', content: followupPrompt }],
                  temperature: 0.7
                }),
                signal: followupController.signal
              })
              
              clearTimeout(followupTimeoutId)
              
              if (followupRes.ok) {
                const followupData = await followupRes.json() as any
                followupAnalysis = followupData.choices[0].message.content
                finalDeepseekResponse = followupAnalysis
                console.log(`DeepSeek follow-up analysis received: ${followupAnalysis.substring(0, 100)}...`)
                actions.push({ type: 'deepseek_followup', result: 'success', analysis_length: followupAnalysis.length })
              } else {
                console.log(`DeepSeek follow-up error: ${followupRes.status}`)
                followupAnalysis = `(Failed to get follow-up analysis: ${followupRes.status})`
              }
              
              break // Stop polling
            }
          }
        } catch (e: any) {
          console.log(`Poll ${i + 1} error: ${e.message}`)
        }
        
        // Wait 5 seconds before next poll (unless last iteration)
        if (i < 5) {
          await new Promise(resolve => setTimeout(resolve, 5000))
        }
      }
    }

    // 5. Return the result
    return c.json({
      status: 'completed',
      conversation_id: openhandsInfo.conversation_id,
      repository,
      branch,
      first_prompt,
      openhands_info: openhandsInfo,
      last_response_from_openhands: lastResponse,
      deepseek_response: finalDeepseekResponse,
      deepseek_followup_analysis: followupAnalysis,
      actions_taken: actions.length > 0 ? actions : 'No actions taken',
      note: `First prompt sent to DeepSeek. DeepSeek's response sent to OpenHands as initial message.
      
OpenHands conversation created with ID: ${openhandsInfo.conversation_id}
OpenHands status: ${openhandsInfo.status}${openhandsInfo.runtime_status ? ` (runtime: ${openhandsInfo.runtime_status})` : ''}
${followupAnalysis ? 'DeepSeek provided follow-up analysis after OpenHands processing.' : 'No follow-up analysis (OpenHands may still be running).'}

Polling checked OpenHands status for completion. When OpenHands is done/waiting, DeepSeek provides follow-up analysis.`
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