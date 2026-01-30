# Simplified Flow Example

This document demonstrates the simplified flow between DeepSeek and OpenHands.

## Flow Diagram

```
User → POST /start → DeepSeek → OpenHands → User
                    ↑                       ↓
                    ← POST /continue ←──────
```

## Step-by-Step Example

### Step 1: Start the Loop
```bash
curl -X POST http://localhost:8787/start \
  -H "Content-Type: application/json" \
  -d '{
    "repository": "Alyahmed89/eta",
    "first_prompt": "Create a simple web server with Node.js that listens on port 3000",
    "branch": "main",
    "max_iterations": 5
  }'
```

**Expected Response:**
```json
{
  "status": "loop_started",
  "conversation_id": "conv_12345",
  "deepseek_response": "I'll help you create a Node.js web server...",
  "note": "Conversation loop started. OpenHands is processing the initial task...",
  "next_steps": [
    "OpenHands will process the initial task",
    "When OpenHands completes, call /continue endpoint with OpenHands response",
    "DeepSeek will analyze the response and provide next steps",
    "Loop continues until DeepSeek says 'done'"
  ]
}
```

### Step 2: OpenHands Processes Task
OpenHands creates the web server and responds with something like:
```
"I have created a Node.js web server in server.js. It listens on port 3000 and responds with 'Hello World'."
```

### Step 3: Continue the Loop
```bash
curl -X POST http://localhost:8787/continue/conv_12345 \
  -H "Content-Type: application/json" \
  -d '{
    "openhands_response": "I have created a Node.js web server in server.js. It listens on port 3000 and responds with 'Hello World'.",
    "iteration": 1,
    "max_iterations": 5
  }'
```

**Expected Response:**
```json
{
  "status": "loop_continuing",
  "conversation_id": "conv_12345",
  "iteration": 2,
  "deepseek_response": "Great! Now let's add error handling and logging to the server...",
  "note": "Loop continued. OpenHands is processing the next steps...",
  "next_steps": [
    "OpenHands will add error handling and logging",
    "When OpenHands completes, call this endpoint again with the response",
    "Remaining iterations: 3"
  ]
}
```

### Step 4: Loop Continues
The loop continues with OpenHands implementing suggestions and DeepSeek providing analysis until:

1. **DeepSeek says "done"** - Example response: "The web server looks complete with all necessary features. I'm done."
2. **Maximum iterations reached** - After 5 iterations (configurable)
3. **Error occurs** - If any API call fails

### Step 5: Loop Completes
When DeepSeek indicates completion:
```json
{
  "status": "completed",
  "conversation_id": "conv_12345",
  "iteration": 3,
  "reason": "DeepSeek indicated completion",
  "deepseek_response": "The web server looks complete with all necessary features. I'm done.",
  "note": "Loop completed as DeepSeek indicated the task is complete."
}
```

## Key Benefits of Simplified Flow

1. **Simplicity**: Only two endpoints (`/start` and `/continue`)
2. **Explicit Control**: User controls when to continue the loop
3. **Reliable Stop Conditions**: Multiple ways to detect completion
4. **No Complex State Management**: No need for Durable Objects or complex callbacks
5. **Easy Debugging**: Each step is explicit and traceable

## Comparison with Previous Flow

| Aspect | Previous Flow | Simplified Flow |
|--------|---------------|-----------------|
| Endpoints | Complex callback system | Simple `/start` and `/continue` |
| State Management | Durable Objects required | No state management needed |
| Control Flow | Automatic callbacks | User-controlled progression |
| Stop Conditions | Limited | Multiple reliable conditions |
| Complexity | High | Low |

## Implementation Notes

The simplified flow:
- Uses keyword detection for stop conditions (`done`, `stop`, `task completed`, etc.)
- Includes maximum iteration limit to prevent infinite loops
- Provides clear next steps in responses
- Maintains error handling for API failures
- Works with existing OpenHands API without modifications