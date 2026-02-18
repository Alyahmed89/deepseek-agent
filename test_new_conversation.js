const conversationId = "c3e58b410e2e53147cf9c7dc452c3145467c9c2bb943493fa05eccc4afdf33d1";

async function checkStatus() {
  const response = await fetch(`https://deepseek-agent.alghamdimo89.workers.dev/status/${conversationId}`);
  const data = await response.json();
  console.log(`State: ${data.conversation.state}, Iteration: ${data.conversation.iteration}`);
  
  if (data.conversation.state === 'WAITING_OPENHANDS' && data.conversation.openhands_conversation_id) {
    console.log(`OpenHands conversation ID: ${data.conversation.openhands_conversation_id}`);
  }
  
  if (data.conversation.state === 'DONE') {
    console.log(`Conversation finished: ${data.conversation.error_message || 'completed'}`);
    clearInterval(interval);
  }
}

console.log(`Monitoring conversation: ${conversationId}`);
console.log(`Checking every 5 seconds...\n`);

checkStatus();
const interval = setInterval(checkStatus, 5000);
