# DeepSeek Agent for OpenHands (Simplified Flow)

A Cloudflare Worker that acts as an intelligent agent between OpenHands and DeepSeek AI with a simplified continuous loop flow. It creates OpenHands conversations, sends responses to DeepSeek for analysis, and continues the loop until DeepSeek says "done" or a stop condition is met.

## Features

- **Simplified Continuous Loop**: `/start` begins the loop, `/continue` keeps it going
- **DeepSeek Integration**: Sends OpenHands responses to DeepSeek API for intelligent analysis
- **Automatic Stop Detection**: Detects when DeepSeek says "done", "stop", "task completed", etc.
- **Maximum Iterations**: Prevents infinite loops with configurable iteration limits
- **Minimal & Efficient**: Simple Cloudflare Worker with Hono framework

## API Endpoints

### `GET /`
- Returns basic info about the worker
- Response: `{ "message": "DeepSeek Agent for OpenHands (Simplified Flow)", "endpoints": ["POST /start", "POST /continue/:conversation_id"] }`

### `POST /start`
- Starts a new conversation loop
- **Request Body**:
  ```json
  {
    "repository": "owner/repo",
    "first_prompt": "Your task description here",
    "branch": "optional-branch-name",
    "max_iterations": 10
  }
  ```
- **Response**: Initial DeepSeek response and OpenHands conversation ID

### `POST /continue/:conversation_id`
- Continues an existing conversation loop
- **Request Body**:
  ```json
  {
    "openhands_response": "Response from OpenHands",
    "iteration": 1,
    "max_iterations": 10
  }
  ```
- **Response**: DeepSeek's analysis and next steps

## How It Works (Simplified Flow)

1. **Start Loop**: User calls `/start` with repository and first prompt
2. **DeepSeek Analysis**: First prompt sent to DeepSeek for initial response
3. **OpenHands Creation**: DeepSeek's response used to create OpenHands conversation
4. **Continuous Loop**:
   - OpenHands processes task and responds
   - Response sent to DeepSeek via `/continue`
   - DeepSeek analyzes and provides next steps
   - Next steps sent back to OpenHands
   - Repeat until DeepSeek says "done" or max iterations reached

## Stop Conditions

The loop automatically stops when:
- DeepSeek response contains: "done", "stop", "task completed", "finished", etc.
- Maximum iterations reached (default: 10)
- Error occurs in API calls

## Environment Variables

- `DEEPSEEK_API_KEY`: Your DeepSeek API key
- `OPENHANDS_API_URL`: OpenHands API URL (default: `https://openhands.anyapp.cfd/api`)

## Local Development

```bash
# Install dependencies
npm install

# Run locally
npx wrangler dev

# Deploy to Cloudflare
npx wrangler deploy
```

## Testing

```bash
# Test the simplified flow
node test_simplified_flow.js

# Test DeepSeek API directly
python3 test_deepseek.py
```

## Example Usage

```bash
# Start a new conversation loop
curl -X POST http://localhost:8787/start \
  -H "Content-Type: application/json" \
  -d '{
    "repository": "Alyahmed89/eta",
    "first_prompt": "Create a simple web server with Node.js"
  }'

# Continue the loop when OpenHands responds
curl -X POST http://localhost:8787/continue/CONVERSATION_ID \
  -H "Content-Type: application/json" \
  -d '{
    "openhands_response": "I have created the web server. Here are the details...",
    "iteration": 1
  }'
```

## Repository Structure

```
├── src/
│   ├── index.ts          # Main Cloudflare Worker code (simplified flow)
│   ├── simple.ts         # Legacy simple implementation
│   └── test_simple.ts    # Test file
├── test_simplified_flow.js # Test for simplified flow
├── test_flow.py          # Manual flow test
├── test_deepseek.py      # DeepSeek API test
├── wrangler.toml         # Cloudflare Worker config
├── package.json          # Dependencies
└── README.md             # This file
```

## Deployment Notes

1. Update `wrangler.toml` with your Cloudflare account ID
2. Set environment variables in Cloudflare dashboard
3. Run `npx wrangler deploy` to deploy
4. The worker will be available at your Cloudflare Workers URL

## Security Considerations

- API keys are stored as Cloudflare environment variables
- All API calls use HTTPS
- Input validation on all endpoints
- Timeout protection for external API calls
- Maximum iterations prevent infinite loops

## License

MIT