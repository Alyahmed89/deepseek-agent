# DeepSeek Agent Structure Verification

## File Structure ✅
```
src/
 ├─ index.ts                # Hono HTTP API only (NO logic) ✅
 ├─ durable/
 │   └─ ConversationDO.ts   # ALL orchestration + alarms ✅
 ├─ services/
 │   ├─ deepseek.ts         # DeepSeek API (pure, stateless) ✅
 │   └─ openhands.ts        # OpenHands API (pure, stateless) ✅
 ├─ types.ts                # Shared types / enums ✅
 └─ constants.ts            # MAX_ITERATIONS, STOP_TOKEN, etc ✅
```

## Hard Separation Rules Check

### 1. index.ts = HTTP only (NO business logic, NO API calls) ✅
- Only Hono routes
- Only calls to Durable Object via fetch()
- No direct API calls to DeepSeek or OpenHands
- Returns immediately from /start

### 2. ConversationDO.ts = ONLY place with state, alarms, orchestration ✅
- All state management (storage.get/put)
- All alarm scheduling (setAlarm/deleteAlarm)
- State machine (INIT → WAITING_OPENHANDS → DONE)
- Calls services for API calls

### 3. services/* = pure API wrappers (stateless, no loops, no state) ✅
- deepseek.ts: callDeepSeek() only
- openhands.ts: createConversation(), getConversation(), postMessage() only
- No state storage
- No orchestration logic

### 4. DeepSeek speaks first ✅
- INIT state sends to DeepSeek first
- OpenHands never receives raw user input

### 5. OpenHands NEVER receives raw user input ✅
- OpenHands conversation seeded with DeepSeek response
- Only DeepSeek responses go to OpenHands

### 6. Strict alternation: DeepSeek → OpenHands → DeepSeek ✅
- INIT: DeepSeek → OpenHands
- WAITING_OPENHANDS: OpenHands → DeepSeek → OpenHands

### 7. NO simulated responses ✅
- Real API calls to DeepSeek and OpenHands
- No mock data

### 8. STOP immediately on ANY stop condition ✅
- <<DONE>> token detection
- Max iterations check
- API error handling
- Invalid state detection

## State Machine Diagram

```
INIT
  ↓
DeepSeek (initial_user_prompt)
  ↓
Check for <<DONE>> → STOP if found
  ↓
Create OpenHands conversation (DeepSeek response)
  ↓
WAITING_OPENHANDS
  ↓
Check OpenHands status
  ↓
If not awaiting_user_input → Reschedule alarm
  ↓
Find new agent messages
  ↓
If none → Reschedule alarm
  ↓
DeepSeek (agent message)
  ↓
Check for <<DONE>> → STOP if found
  ↓
Inject to OpenHands (DeepSeek response)
  ↓
iteration++ → Check max iterations → STOP if reached
  ↓
Reschedule alarm
```

## Alarm Pseudocode

```typescript
handleAlarm():
  if no conversation: return
  
  update timestamp
  
  try:
    switch(state):
      case INIT:
        // DeepSeek speaks first
        deepseekResult = callDeepSeek(initial_user_prompt)
        if error or <<DONE>>: stop
        create OpenHands with DeepSeek response
        state = WAITING_OPENHANDS
        setAlarm(5s)
        
      case WAITING_OPENHANDS:
        // Check OpenHands
        status = getOpenHandsConversation()
        if error: stop
        if not awaiting_user_input: reschedule alarm
        find new agent message
        if none: reschedule alarm
        
        // DeepSeek responds
        deepseekResult = callDeepSeek(agent_message)
        if error or <<DONE>>: stop
        
        // Inject back to OpenHands
        injectMessageToOpenHands(deepseek_response)
        iteration++
        if max iterations: stop
        setAlarm(5s)
        
      case DONE:
        return
        
  catch error:
    stop with error
```

## Hono Binding Config (wrangler.toml) ✅
```toml
name = "deepseek-agent"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
DEEPSEEK_API_KEY = "sk-..."
OPENHANDS_API_URL = "https://openhands.anyapp.cfd/api"

[[durable_objects.bindings]]
name = "CONVERSATIONS"
class_name = "ConversationDO"
```

## Testing Requirements

1. ✅ POST /start → returns immediately
2. ✅ Logs show DeepSeek called FIRST  
3. ✅ OpenHands conversation seeded with DeepSeek text
4. ✅ Alarm loop runs
5. ✅ REAL OpenHands agent messages forwarded
6. ✅ "<<DONE>>" cancels alarms
7. ✅ Any API failure → DONE state

## Implementation Complete ✅

All requirements met with strict file separation and hard rules enforcement.