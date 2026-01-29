# DeepSeek Agent for OpenHands

Minimal Cloudflare Worker that integrates DeepSeek with OpenHands for bidirectional monitoring.

## What it does

1. **Shared context**: Both OpenHands and DeepSeek see the same task
2. **DeepSeek monitoring**: DeepSeek gets additional rules for monitoring
3. **Automatic actions**: DeepSeek can stop OpenHands or call any OpenHands API
4. **Bidirectional**: OpenHands events are forwarded to DeepSeek for analysis

## API Endpoints

### 1. `POST /start`
Start everything in one flow.

```json
{
  "conversation_id": "your-id",
  "task": "Shared task for OpenHands",
  "rules": "Rules for DeepSeek monitoring"
}
```

**Response:**
- Starts OpenHands conversation
- Asks DeepSeek for initial plan
- Executes any actions DeepSeek specifies
- Returns results

### 2. `POST /events`
Forward OpenHands events to DeepSeek.

```json
{
  "conversation_id": "your-id",
  "event": {
    "type": "code_written",
    "content": "const x = 5;",
    "source": "agent"
  }
}
```

**Response:**
- DeepSeek analyzes the event
- Executes STOP or endpoint calls automatically
- Returns results

## DeepSeek Communication Format

DeepSeek uses these exact formats:

### Stop OpenHands
```
*[STOP]* CONTEXT: "security issue" The agent is writing insecure code.
```

### Call any OpenHands API
```
*[ENDPOINT:POST:/conversations/123/stop]* {"message": "Stopping"}
*[ENDPOINT:GET:/conversations/123]* {}
*[ENDPOINT:POST:/conversations/123/events]* {"type": "feedback", "content": "Good job"}
```

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   # No API key needed for OpenHands
   # DeepSeek API key is already in wrangler.toml
   ```

3. **Run locally:**
   ```bash
   npm run dev
   ```

4. **Deploy to Cloudflare:**
   ```bash
   npm run deploy
   ```

## Test

```bash
# Start monitoring
curl -X POST http://localhost:8787/start \
  -H "Content-Type: application/json" \
  -d '{
    "conversation_id": "test-123",
    "task": "Create a simple web server",
    "rules": "Monitor for security issues. Stop if insecure code."
  }'

# Forward an event
curl -X POST http://localhost:8787/events \
  -H "Content-Type: application/json" \
  -d '{
    "conversation_id": "test-123",
    "event": {
      "type": "code_written",
      "content": "const password = process.env.PASSWORD;",
      "source": "agent"
    }
  }'
```

## Manual Event Forwarding

Since OpenHands doesn't automatically send events to external services, you need to manually forward events:

### Option 1: Use the Python script
```bash
# Edit test_manual_events.py with your conversation ID
python test_manual_events.py
```

### Option 2: Manual curl commands
1. **Start monitoring an existing conversation:**
```bash
curl -X POST https://deepseek-agent.alghamdimo89.workers.dev/start \
  -H "Content-Type: application/json" \
  -d '{
    "conversation_id": "YOUR_OPENHANDS_ID",
    "task": "Task description",
    "rules": "Monitoring rules"
  }'
```

2. **When OpenHands does something, forward the event:**
```bash
curl -X POST https://deepseek-agent.alghamdimo89.workers.dev/events \
  -H "Content-Type: application/json" \
  -d '{
    "conversation_id": "YOUR_OPENHANDS_ID",
    "event": {
      "type": "code_written",
      "content": "Code that OpenHands wrote",
      "source": "agent"
    }
  }'
```

### Option 3: Automate with browser extension
You could create a browser extension that:
1. Listens to OpenHands events in the browser
2. Automatically forwards them to the DeepSeek agent
3. Shows DeepSeek's responses

## Event Types to Forward

Forward these OpenHands events:
- `code_written` - When agent writes code
- `command_executed` - When agent runs commands
- `file_created` - When agent creates files
- `git_operation` - When agent uses git
- `error` - When agent encounters errors
- `user_message` - User messages to agent
- `agent_response` - Agent responses to user

## Files

- `src/index.ts` - Main Cloudflare Worker (only 150 lines)
- `package.json` - Minimal dependencies
- `wrangler.toml` - Cloudflare config with DeepSeek API key
- `test.sh` - Simple test commands

## License

MIT