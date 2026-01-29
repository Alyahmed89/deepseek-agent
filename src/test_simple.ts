// Test version - doesn't call OpenHands API
import { Hono } from 'hono'

const app = new Hono<{ Bindings: CloudflareBindings }>()

// Simple test endpoint
app.post('/test', async (c) => {
  try {
    const { conversation_id, first_prompt } = await c.req.json()
    
    if (!conversation_id || !first_prompt) {
      return c.json({ error: 'Need conversation_id and first_prompt' }, 400)
    }

    console.log(`Test endpoint called with: ${conversation_id}, ${first_prompt}`)

    // Just send to DeepSeek without OpenHands API
    const prompt = `OpenHands Conversation ID: ${conversation_id}

First Prompt/Context: ${first_prompt}

You are DeepSeek agent monitoring OpenHands. Based on the above, what should you do?

You can:
1. STOP OpenHands if needed: *[STOP]* CONTEXT: "reason" message
2. Call any OpenHands API: *[ENDPOINT:METHOD:/path]* {json}
3. Respond with feedback/analysis

What's your response?`
    
    console.log(`Sending to DeepSeek...`)
    
    const deepseekController = new AbortController()
    const deepseekTimeoutId = setTimeout(() => deepseekController.abort(), 10000)
    
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
    
    const deepseekData = await deepseekRes.json()
    const deepseekResponse = deepseekData.choices[0].message.content

    console.log(`Got DeepSeek response: ${deepseekResponse.substring(0, 100)}...`)

    return c.json({
      status: 'completed',
      conversation_id,
      first_prompt,
      deepseek_response: deepseekResponse,
      note: 'Test successful - DeepSeek responded'
    })

  } catch (error) {
    console.error(`Error: ${error.message}`)
    return c.json({ error: error.message }, 500)
  }
})

export default app

interface CloudflareBindings {
  DEEPSEEK_API_KEY: string
  OPENHANDS_API_URL: string
}