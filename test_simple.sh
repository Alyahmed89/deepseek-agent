#!/bin/bash

echo "Testing simple DeepSeek agent for OpenHands"
echo "=========================================="

# Test the simple endpoint
echo ""
echo "1. Testing /start endpoint:"
echo "--------------------------"

curl -X POST "https://deepseek-agent.alghamdimo89.workers.dev/start" \
  -H "Content-Type: application/json" \
  -d '{
    "conversation_id": "eab8a588bc934889b21b652a0197d12a",
    "first_prompt": "Create a simple web server with Node.js. Monitor for security issues."
  }' | jq '.'

echo ""
echo "=========================================="
echo "How it works:"
echo "1. Gets OpenHands conversation info"
echo "2. Sends to DeepSeek with your first_prompt"
echo "3. DeepSeek analyzes and can:"
echo "   - Stop OpenHands with *[STOP]*"
echo "   - Call OpenHands APIs with *[ENDPOINT:METHOD:/path]*"
echo "   - Return analysis/feedback"
echo "4. Returns DeepSeek's response"
echo ""
echo "Copy the 'deepseek_response' field to OpenHands if needed."