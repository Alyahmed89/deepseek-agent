# DeepSeek Agent for OpenHands

A Cloudflare Worker that integrates DeepSeek AI with OpenHands to monitor and guide conversations.

## Features

- **Dual-Prompt System**: Separate prompts for OpenHands agent and DeepSeek monitor
- **Real-time Monitoring**: Periodically checks OpenHands conversation events
- **Intelligent Intervention**: DeepSeek analyzes agent behavior and can issue STOP commands
- **RESTful API**: Simple endpoints for starting, monitoring, and analyzing conversations
- **Cloudflare Worker**: Deployable as a serverless function

## API Endpoints

### `POST /start`
Start monitoring a conversation with dual prompts.

**Request Body:**
```json
{
  "conversation_id": "your-conversation-id",
  "openhands_prompt": "The task for OpenHands agent",
  "deepseek_prompt": "Instructions for DeepSeek monitoring"
}
```

**Response:**
```json
{
  "status": "started",
  "conversation_id": "your-conversation-id",
  "openhands_prompt": "...",
  "deepseek_prompt": "...",
  "deepseek_initial_response": "DeepSeek's initial analysis",
  "openhands_status": { ... },
  "message": "Monitoring started..."
}
```

### `GET /status/:conversation_id`
Get current status and recent events for a conversation.

### `POST /analyze/:conversation_id`
Manually trigger DeepSeek analysis on recent events.

### `GET /health`
Health check endpoint.

## STOP Command Format

DeepSeek can stop the OpenHands agent by including this pattern in its response:

```
*[STOP]* CONTEXT: "Brief context about why" Your detailed correction message here
```

Example:
```
*[STOP]* CONTEXT: "Security vulnerability" The agent is trying to read environment variables without proper validation. This could expose sensitive data. Please implement proper input validation and error handling.
```

## Setup and Deployment

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Set up your Cloudflare Worker secrets:
```bash
# Set your OpenHands API key (get this from your OpenHands instance)
npx wrangler secret put OPENHANDS_API_KEY

# The DeepSeek API key is already in wrangler.toml
# Update it if needed: sk-57370a37c79f4b7db9dbd1e253c25b8b
```

### 3. Local Development
```bash
npm run dev
```

### 4. Deploy to Cloudflare
```bash
npm run deploy
```

## Environment Variables

- `DEEPSEEK_API_KEY`: Your DeepSeek API key
- `OPENHANDS_API_URL`: OpenHands API endpoint (default: https://openhands.anyapp.cfd/api/)
- `OPENHANDS_API_KEY`: Your OpenHands session API key

## Usage Example

1. **Start a conversation in OpenHands** and note the conversation ID
2. **Call the `/start` endpoint** with:
   - `conversation_id`: Your OpenHands conversation ID
   - `openhands_prompt`: The task for OpenHands
   - `deepseek_prompt`: Monitoring instructions for DeepSeek
3. **Monitor the conversation** using `/status/:conversation_id`
4. **DeepSeek will automatically analyze** events and can stop the agent if needed

## Architecture

- **Hono Framework**: Lightweight web framework for Cloudflare Workers
- **Periodic Monitoring**: Checks OpenHands events every 5 seconds
- **Event Buffer**: Keeps recent events for context
- **Intelligent Analysis**: DeepSeek evaluates agent behavior against monitoring instructions

## Security Notes

- API keys are stored as Cloudflare Worker secrets
- All API calls use HTTPS
- The worker only has permission to stop conversations it's monitoring
- No sensitive data is stored persistently