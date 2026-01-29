#!/usr/bin/env python3
"""
Test script for manually forwarding OpenHands events to DeepSeek agent.

Usage:
1. Start OpenHands conversation manually in UI
2. Write prompt in OpenHands UI
3. Copy the event data from OpenHands
4. Run this script to forward to DeepSeek
"""

import json
import requests

# Configuration
WORKER_URL = "https://deepseek-agent.alghamdimo89.workers.dev"
CONVERSATION_ID = "your-conversation-id-here"  # Replace with your OpenHands conversation ID

def test_start_monitoring():
    """Start monitoring an existing OpenHands conversation"""
    print("=== Starting DeepSeek Monitoring ===")
    
    data = {
        "conversation_id": CONVERSATION_ID,
        "task": "Task that OpenHands is working on",
        "rules": "Monitor for security issues. Stop if insecure code is written."
    }
    
    response = requests.post(f"{WORKER_URL}/start", json=data)
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2)}")
    return response.json()

def test_forward_event(event_data):
    """Forward an OpenHands event to DeepSeek"""
    print("\n=== Forwarding Event to DeepSeek ===")
    
    data = {
        "conversation_id": CONVERSATION_ID,
        "event": event_data
    }
    
    response = requests.post(f"{WORKER_URL}/events", json=data)
    print(f"Status: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2)}")
    return response.json()

# Example event from OpenHands (you would get this from OpenHands UI)
EXAMPLE_EVENT = {
    "type": "code_written",
    "content": "const fs = require('fs');\nfs.readFileSync('/etc/passwd');",
    "source": "agent",
    "metadata": {
        "file": "server.js",
        "line": 10
    }
}

if __name__ == "__main__":
    print("DeepSeek Agent Manual Testing")
    print("=" * 50)
    
    # Step 1: Start monitoring
    # result = test_start_monitoring()
    
    # Step 2: Forward an event (after OpenHands does something)
    print("\nExample: Forwarding a code event to DeepSeek")
    result = test_forward_event(EXAMPLE_EVENT)
    
    print("\n" + "=" * 50)
    print("How to get real events from OpenHands:")
    print("1. Open OpenHands UI")
    print("2. Start a conversation")
    print("3. When agent writes code or takes action")
    print("4. Copy the event data (type, content, source)")
    print("5. Update EXAMPLE_EVENT with real data")
    print("6. Run this script again")