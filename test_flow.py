#!/usr/bin/env python3
"""
Test the DeepSeek Agent flow manually
This simulates what the Cloudflare Worker should do
"""

import requests
import json
import time

# Configuration
DEEPSEEK_API_KEY = "sk-57370a37c79f4b7db9dbd1e253c25b8b"
OPENHANDS_API_URL = "https://openhands.anyapp.cfd/api/"

def create_openhands_conversation(repository, branch, first_prompt):
    """Create a new OpenHands conversation with initial message"""
    url = f"{OPENHANDS_API_URL}conversations"
    
    payload = {
        "repository": repository,
        "initial_user_msg": first_prompt
    }
    
    print(f"Creating OpenHands conversation...")
    print(f"Repository: {repository}")
    print(f"Initial message: {first_prompt[:100]}...")
    
    response = requests.post(url, json=payload)
    
    if response.status_code == 200:
        data = response.json()
        conversation_id = data.get("conversation_id")
        print(f"✓ Conversation created: {conversation_id}")
        return conversation_id
    else:
        print(f"✗ Failed to create conversation: {response.status_code}")
        print(f"Response: {response.text}")
        return None

def get_conversation_status(conversation_id):
    """Get the status of a conversation"""
    url = f"{OPENHANDS_API_URL}conversations/{conversation_id}"
    
    response = requests.get(url)
    
    if response.status_code == 200:
        data = response.json()
        status = data.get("status")
        print(f"Conversation status: {status}")
        return status, data
    else:
        print(f"✗ Failed to get conversation status: {response.status_code}")
        return None, None

def send_to_deepseek(prompt):
    """Send prompt to DeepSeek API"""
    url = "https://api.deepseek.com/chat/completions"
    
    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": "deepseek-chat",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant that can interact with OpenHands. You can use special commands like *[STOP]* CONTEXT: \"reason\" to stop the OpenHands agent and provide corrections."},
            {"role": "user", "content": prompt}
        ],
        "stream": False
    }
    
    print(f"Sending to DeepSeek...")
    
    response = requests.post(url, headers=headers, json=payload)
    
    if response.status_code == 200:
        data = response.json()
        content = data["choices"][0]["message"]["content"]
        print(f"✓ DeepSeek response received ({len(content)} chars)")
        return content
    else:
        print(f"✗ DeepSeek API error: {response.status_code}")
        print(f"Response: {response.text}")
        return None

def test_flow():
    """Test the complete flow"""
    print("=" * 60)
    print("Testing DeepSeek Agent Flow")
    print("=" * 60)
    
    # Test parameters
    repository = "Alyahmed89/eta"
    branch = "fix-eslint-unused-params"
    first_prompt = "Create a simple web server with Node.js. Monitor for security issues."
    
    # Step 1: Create OpenHands conversation
    conversation_id = create_openhands_conversation(repository, branch, first_prompt)
    
    if not conversation_id:
        print("Failed to create conversation. Exiting.")
        return
    
    # Step 2: Wait for conversation to be ready
    print("\nWaiting for conversation to process...")
    for i in range(10):
        status, data = get_conversation_status(conversation_id)
        
        if status == "READY":
            print("✓ Conversation is ready!")
            break
        elif status == "ERROR":
            print("✗ Conversation failed")
            return
        
        print(f"Waiting... ({i+1}/10)")
        time.sleep(2)
    
    # Step 3: Get conversation details to send to DeepSeek
    if status == "READY":
        # In a real scenario, we'd get the conversation history
        # For now, just send the initial prompt
        deepseek_response = send_to_deepseek(first_prompt)
        
        if deepseek_response:
            print("\n" + "=" * 60)
            print("DeepSeek Response:")
            print("=" * 60)
            print(deepseek_response[:500] + "..." if len(deepseek_response) > 500 else deepseek_response)
            
            # Check for STOP command
            if "*[STOP]*" in deepseek_response:
                print("\n⚠️  STOP command detected in response!")
                # Parse STOP command
                import re
                stop_match = re.search(r'\*\[STOP\]\*\s*CONTEXT:\s*"([^"]+)"\s*([\s\S]+)', deepseek_response)
                if stop_match:
                    context = stop_match.group(1)
                    message = stop_match.group(2)
                    print(f"Context: {context}")
                    print(f"Message: {message[:200]}...")
    
    print("\n" + "=" * 60)
    print("Test complete!")
    print("=" * 60)

if __name__ == "__main__":
    test_flow()