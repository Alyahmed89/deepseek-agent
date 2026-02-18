#!/bin/bash
echo "Test DeepSeek Agent"
echo "=================="

echo ""
echo "1. Start monitoring:"
echo 'curl -X POST http://localhost:8787/start \'
echo '  -H "Content-Type: application/json" \'
echo '  -d '\''{
  "conversation_id": "test-123",
  "task": "Create a simple web server",
  "rules": "Monitor for security issues. Stop if insecure code."
}'\'''

echo ""
echo "2. Forward an event:"
echo 'curl -X POST http://localhost:8787/events \'
echo '  -H "Content-Type: application/json" \'
echo '  -d '\''{
  "conversation_id": "test-123",
  "event": {
    "type": "code_written",
    "content": "const password = process.env.PASSWORD;",
    "source": "agent"
  }
}'\'''