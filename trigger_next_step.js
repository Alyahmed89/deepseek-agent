const OPENHANDS_API_URL = "https://openhands.anyapp.cfd/api";
const FLOW_ID = "6e79a2168649cd78af49885b088fcf2b9ec02ef219555257103f0d8d32f4e782";
const OPENHANDS_CONV_ID = "57b59e888009493ea11d324e06bdb14b";

async function triggerNextStep() {
  // 1. Get events from OpenHands
  const eventsRes = await fetch(`${OPENHANDS_API_URL}/conversations/${OPENHANDS_CONV_ID}/events?reverse=true&limit=10`);
  const eventsData = await eventsRes.json();
  
  // 2. Find agent response
  const agentEvent = eventsData.events?.find(e => e.source === 'agent' && e.content);
  if (!agentEvent) {
    console.log("No agent response found");
    return;
  }
  
  console.log("Found agent response:", agentEvent.content.substring(0, 100));
  
  // 3. Call webhook with response
  const webhookRes = await fetch(`https://deepseek-agent.alghamdimo89.workers.dev/response/${FLOW_ID}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      events: [agentEvent],
      conversation_id: OPENHANDS_CONV_ID
    })
  });
  
  const result = await webhookRes.text();
  console.log("Webhook result:", result);
  
  // 4. Check status
  const statusRes = await fetch(`https://deepseek-agent.alghamdimo89.workers.dev/status/${FLOW_ID}`);
  const status = await statusRes.json();
  console.log("Flow status:", status.conversation?.state, "Step:", status.conversation?.current_step);
}

triggerNextStep().catch(console.error);
