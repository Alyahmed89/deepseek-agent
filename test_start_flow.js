// Test the new /start-flow endpoint

async function testStartFlow() {
  console.log('Testing /start-flow endpoint...');
  
  // Test with flow name
  const startResponse = await fetch('https://deepseek-agent.alghamdimo89.workers.dev/start-flow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      flow: 'etaflow'
    })
  });
  
  const startData = await startResponse.json();
  console.log('Start response:', JSON.stringify(startData, null, 2));
  
  if (!startData.success) {
    console.error('Failed to start flow');
    return null;
  }
  
  const conversationId = startData.conversation_id;
  console.log(`\nConversation ID: ${conversationId}`);
  
  // Check status every 5 seconds for 60 seconds
  for (let i = 0; i < 12; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const statusResponse = await fetch(`https://deepseek-agent.alghamdimo89.workers.dev/status/${conversationId}`);
    const statusData = await statusResponse.json();
    
    console.log(`\nCheck ${i + 1} (${(i+1)*5}s):`);
    console.log(`State: ${statusData.conversation?.state}`);
    console.log(`Iteration: ${statusData.conversation?.iteration}`);
    console.log(`Flow ID: ${statusData.conversation?.flow_id}`);
    console.log(`Current step index: ${statusData.conversation?.current_step_index}`);
    console.log(`Total steps: ${statusData.conversation?.flow_steps?.length || 0}`);
    
    if (statusData.conversation?.openhands_conversation_id) {
      console.log(`OpenHands conversation ID: ${statusData.conversation.openhands_conversation_id}`);
    }
    
    if (statusData.conversation?.error_message) {
      console.log(`Error: ${statusData.conversation.error_message}`);
    }
    
    if (statusData.conversation?.state === 'DONE') {
      console.log('Flow completed');
      break;
    }
  }
  
  return conversationId;
}

testStartFlow().catch(console.error);