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

## Files

- `src/index.ts` - Main Cloudflare Worker (only 150 lines)
- `package.json` - Minimal dependencies
- `wrangler.toml` - Cloudflare config with DeepSeek API key
- `test.sh` - Simple test commands

## License

MIT