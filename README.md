# DeepSeek Agent for OpenHands

**Simple transfer agent**: Gets OpenHands conversation, sends to DeepSeek, returns DeepSeek's response.

## What it does

1. **Simple transfer**: One endpoint that does everything
2. **Get OpenHands info**: Fetches conversation details and last response
3. **Send to DeepSeek**: Sends everything to DeepSeek for analysis
4. **Execute actions**: DeepSeek can stop OpenHands or call APIs
5. **Return response**: Returns DeepSeek's analysis for you to use

## API Endpoint

### `POST /start`
Simple transfer endpoint.

```json
{
  "conversation_id": "your-openhands-id",
  "first_prompt": "Task and rules for DeepSeek"
}
```

**What happens:**
1. Gets OpenHands conversation info
2. Sends to DeepSeek with your `first_prompt`
3. DeepSeek analyzes and can:
   - Stop OpenHands if needed
   - Call OpenHands APIs
   - Return analysis/feedback
4. Returns DeepSeek's response

**Response includes:**
- OpenHands conversation info
- Last response from OpenHands
- DeepSeek's analysis
- Any actions taken (STOP, API calls)

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
# Simple test
curl -X POST https://deepseek-agent.alghamdimo89.workers.dev/start \
  -H "Content-Type: application/json" \
  -d '{
    "conversation_id": "your-openhands-id",
    "first_prompt": "Task: Create web server. Rules: Monitor for security issues."
  }'
```

Or use the test script:
```bash
chmod +x test_simple.sh
./test_simple.sh
```

## How to Use

1. **Create OpenHands conversation** (in OpenHands UI)
2. **Write your prompt** in OpenHands UI
3. **Get OpenHands response**
4. **Call DeepSeek agent:**
   ```bash
   curl -X POST https://deepseek-agent.alghamdimo89.workers.dev/start \
     -H "Content-Type: application/json" \
     -d '{
       "conversation_id": "YOUR_ID",
       "first_prompt": "Task and rules for DeepSeek"
     }'
   ```
5. **Get DeepSeek's response** in the API response
6. **Copy DeepSeek's response** to OpenHands if needed

## Files

- `src/index.ts` - Main Cloudflare Worker (simple 150-line implementation)
- `package.json` - Minimal dependencies
- `wrangler.toml` - Cloudflare config with DeepSeek API key
- `test_simple.sh` - Simple test script
- `test_manual_events.py` - Python script for manual testing

## License

MIT