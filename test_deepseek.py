#!/usr/bin/env python3
"""
Test DeepSeek API directly
"""

import requests
import json

DEEPSEEK_API_KEY = "sk-57370a37c79f4b7db9dbd1e253c25b8b"

def test_deepseek():
    """Test DeepSeek API with a simple prompt"""
    url = "https://api.deepseek.com/chat/completions"
    
    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json"
    }
    
    # Test prompt similar to what we'd send
    prompt = """Create a simple web server with Node.js. Monitor for security issues.

I need you to review this task and provide guidance. If you see any issues with the approach or need to stop the OpenHands agent, use the command: *[STOP]* CONTEXT: "reason here" followed by your explanation."""
    
    payload = {
        "model": "deepseek-chat",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant that can interact with OpenHands. You can use special commands like *[STOP]* CONTEXT: \"reason\" to stop the OpenHands agent and provide corrections."},
            {"role": "user", "content": prompt}
        ],
        "stream": False,
        "max_tokens": 500
    }
    
    print("Testing DeepSeek API...")
    print(f"Prompt: {prompt[:100]}...")
    
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=30)
        
        if response.status_code == 200:
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            print(f"✓ Success! Response ({len(content)} chars):")
            print("-" * 60)
            print(content)
            print("-" * 60)
            
            # Check for STOP command
            if "*[STOP]*" in content:
                print("\n⚠️  STOP command detected!")
                import re
                stop_match = re.search(r'\*\[STOP\]\*\s*CONTEXT:\s*"([^"]+)"\s*([\s\S]+)', content)
                if stop_match:
                    context = stop_match.group(1)
                    message = stop_match.group(2)
                    print(f"Context: {context}")
                    print(f"Message: {message[:200]}...")
        else:
            print(f"✗ Error: {response.status_code}")
            print(f"Response: {response.text}")
            
    except Exception as e:
        print(f"✗ Exception: {e}")

if __name__ == "__main__":
    test_deepseek()