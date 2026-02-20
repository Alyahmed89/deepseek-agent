# Cloudflare Workers Deployment Guide

## Deployment Error Analysis

The deployment failed with error:
```
✘ [ERROR] A request to the Cloudflare API (/accounts/e39371fc55a5c9ef7ed83e16660bd7bb/workers/scripts/deepseek-agent/versions) failed.
```

This indicates missing Cloudflare authentication.

## Required Setup for Deployment

### 1. **Authentication Methods**

Choose ONE of these authentication methods:

#### Option A: Browser Login (Recommended for local development)
```bash
npx wrangler login
```
This will open a browser window to authenticate with Cloudflare.

#### Option B: API Token (Recommended for CI/CD)
1. Create an API token at: https://dash.cloudflare.com/profile/api-tokens
2. Select template: "Edit Cloudflare Workers"
3. Set environment variable:
```bash
export CLOUDFLARE_API_TOKEN="your-api-token-here"
export CLOUDFLARE_ACCOUNT_ID="your-account-id-here"
```

#### Option C: Global API Key (Legacy)
```bash
export CLOUDFLARE_API_KEY="your-global-api-key"
export CLOUDFLARE_EMAIL="your-email@example.com"
export CLOUDFLARE_ACCOUNT_ID="your-account-id-here"
```

### 2. **Update wrangler.jsonc**

Add your Cloudflare account ID to the configuration:

```jsonc
{
  "name": "deepseek-agent",
  "main": "src/index.ts",
  "compatibility_date": "2026-02-19",
  "compatibility_flags": ["nodejs_compat"],
  "observability": {
    "enabled": true
  },
  "account_id": "your-cloudflare-account-id-here"
}
```

### 3. **Deployment Commands**

Once authenticated, deploy with:

```bash
# Test locally first
npx wrangler dev src/index.ts --port 48193 --host 0.0.0.0

# Deploy to Cloudflare
npx wrangler deploy
```

## Current Implementation Status

✅ **COMPLETED:**
- Database tables implemented: `tasks`, `doc_artifacts`, `doc_task_links`
- Flow contract query implemented: `SELECT * FROM tasks WHERE status='pending' ORDER BY priority DESC LIMIT 1`
- TypeScript Cloudflare Worker with full API
- GitHub repository updated (`start-flow` branch)
- All code pushed to remote repository

⚠️ **PENDING:**
- Cloudflare authentication setup
- Account ID configuration
- Successful deployment to Cloudflare Workers

## API Endpoints Available

Once deployed, your Worker will provide these endpoints:

- `GET /health` - Health check
- `GET /tasks` - List all tasks
- `GET /tasks/next` - Get next task (flow contract execution)
- `GET /flow` - Flow contract endpoint
- `GET /artifacts` - List all artifacts
- `POST /tasks` - Create new task
- `PUT /tasks/:id` - Update task status

## Database Schema

The implementation includes all required tables:

1. **tasks** - `id`, `type`, `payload`, `status`, `priority`
2. **doc_artifacts** - `id`, `path`, `content`, `type`
3. **doc_task_links** - `task_id`, `artifact_id`

## Next Steps

1. Set up Cloudflare authentication using one of the methods above
2. Update `wrangler.jsonc` with your account ID
3. Run `npx wrangler deploy` to deploy to Cloudflare Workers
4. Test the deployed API endpoints

## Local Testing

You can test locally without Cloudflare authentication:
```bash
npx wrangler dev src/index.ts --port 48193 --host 0.0.0.0
```

Then test with:
```bash
curl http://localhost:48193/health
curl http://localhost:48193/tasks/next
curl http://localhost:48193/flow
```