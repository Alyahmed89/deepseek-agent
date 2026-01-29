#!/usr/bin/env python3
import requests
import json
import time

def test_endpoint():
    url = "http://localhost:8787/start"
    data = {
        "conversation_id": "test123",
        "first_prompt": "Test prompt for DeepSeek"
    }
    
    print(f"Testing endpoint: {url}")
    print(f"Data: {json.dumps(data, indent=2)}")
    print("-" * 50)
    
    try:
        response = requests.post(url, json=data, timeout=30)
        print(f"Status: {response.status_code}")
        print(f"Response: {json.dumps(response.json(), indent=2)}")
    except requests.exceptions.Timeout:
        print("Request timed out after 30 seconds")
    except requests.exceptions.RequestException as e:
        print(f"Request error: {e}")
    except json.JSONDecodeError as e:
        print(f"JSON decode error: {e}")
        print(f"Raw response: {response.text}")

if __name__ == "__main__":
    print("Waiting for server to be ready...")
    time.sleep(3)
    test_endpoint()