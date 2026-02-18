// Test the flow
const fetch = require('node-fetch');

async function testFlow() {
  console.log('Testing DeepSeek Agent flow...');
  
  // Start a conversation
  const startResponse = await fetch('https://deepseek-agent.alghamdimo89.workers.dev/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repository: 'Alyahmed89/deepseek-agent',
      branch: 'fix-openhands-405-error',
      initial_user_prompt: 'Test the conversation flow',
      max_iterations: 3
    })
  });
  
  const startData = await startResponse.json();
  console.log('Start response:', startData);
  
  if (!startData.success) {
    console.error('Failed to start conversation');
    return;
  }
  
  const conversationId = startData.conversation_id;
  console.log(`Conversation ID: ${conversationId}`);
  
  // Check status every 2 seconds for 30 seconds
  for (let i = 0; i < 15; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const statusResponse = await fetch(`https://deepseek-agent.alghamdimo89.workers.dev/status/${conversationId}`);
    const statusData = await statusResponse.json();
    
    console.log(`\nCheck ${i + 1}:`);
    console.log(`State: ${statusData.conversation?.state}`);
    console.log(`Iteration: ${statusData.conversation?.iteration}`);
    console.log(`Status: ${statusData.conversation?.status}`);
    
    if (statusData.conversation?.error_message) {
      console.log(`Error: ${statusData.conversation.error_message}`);
    }
    
    if (statusData.conversation?.state === 'DONE') {
      console.log('Conversation completed');
      break;
    }
  }
}

testFlow().catch(console.error);