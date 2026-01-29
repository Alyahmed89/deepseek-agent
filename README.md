# DeepSeek Agent for OpenHands

A Cloudflare Worker that acts as an intelligent agent between OpenHands and DeepSeek AI. It creates OpenHands conversations, sends them to DeepSeek for analysis, and can stop/correct OpenHands agents when needed.

## Features

- **Simple Transfer Flow**: `/start` endpoint creates ONE new OpenHands conversation with initial message
- **DeepSeek Integration**: Sends conversation context to DeepSeek API for intelligent analysis
- **STOP Command Detection**: Automatically detects `*[STOP]* CONTEXT: "reason"` commands in DeepSeek responses
- **Endpoint Call Support**: Can trigger OpenHands API endpoints based on DeepSeek instructions
- **Minimal & Efficient**: Small Cloudflare Worker with Hono framework

## API Endpoints

### `GET /`
- Returns basic info about the worker
- Response: `{ "message": "DeepSeek Agent for OpenHands", "endpoints": ["POST /start"] }`

### `POST /start`
- Creates a new OpenHands conversation and sends it to DeepSeek
- **Request Body**:
  ```json
  {
    "repository": "owner/repo",
    "first_prompt": "Your task description here",
    "branch": "optional-branch-name"
  }
  ```
- **Response**: DeepSeek's analysis with potential STOP commands

## How It Works

1. **Create Conversation**: Creates a new OpenHands conversation using `initial_user_msg`
2. **Send to DeepSeek**: Sends the conversation context to DeepSeek API
3. **Analyze Response**: Checks for STOP commands or endpoint calls
4. **Take Action**: If STOP command found, can stop OpenHands agent and provide corrections

## STOP Command Format

DeepSeek can use this format to stop OpenHands agents:
```
*[STOP]* CONTEXT: "Reason for stopping"
Detailed explanation and corrections here...
```

The agent automatically detects this pattern and can trigger appropriate OpenHands API calls.

## Environment Variables

- `DEEPSEEK_API_KEY`: Your DeepSeek API key
- `OPENHANDS_API_URL`: OpenHands API URL (default: `https://openhands.anyapp.cfd/api/`)

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
# Test the flow manually
python3 test_flow.py

# Test DeepSeek API directly
python3 test_deepseek.py
```

## Example Usage

```bash
curl -X POST http://localhost:8787/start \
  -H "Content-Type: application/json" \
  -d '{
    "repository": "Alyahmed89/eta",
    "first_prompt": "Create a simple web server with Node.js. Monitor for security issues."
  }'
```

## Repository Structure

```
├── src/
│   └── index.ts          # Main Cloudflare Worker code
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

## License

MIT