# Backend Response Examples (Fixed)

## 1. Normal Step Execution
```json
{
  "success": true,
  "step_id": "step_123",
  "output": {
    "reasoning": "Executed step with fields: instructions",
    "actions": [],
    "next_step": null,
    "variables": {
      "step_step_123": "Send welcome email to new user"
    }
  },
  "next_step_id": "step_456",
  "next_flow_id": null,
  "variables": {
    "step_step_123": "Send welcome email to new user",
    "user_email": "john@example.com"
  }
}
```

## 2. Cross-Flow Transition
```json
{
  "success": true,
  "step_id": "step_789",
  "output": {
    "reasoning": "Executed step with fields: command",
    "actions": [],
    "next_step": null,
    "variables": {
      "step_step_789": { "status": "email_sent" }
    }
  },
  "next_step_id": null,
  "next_flow_id": "flow_onboarding_complete",
  "variables": {
    "step_step_789": { "status": "email_sent" },
    "user_status": "verified"
  }
}
```

## 3. Flow Completion (No more steps)
```json
{
  "success": true,
  "step_id": null,
  "output": {
    "message": "Flow completed"
  },
  "next_step_id": null,
  "next_flow_id": null,
  "variables": {
    "step_step_final": "Task completed",
    "result": "success"
  }
}
```

## Frontend Loop Logic:
```javascript
while (true) {
  const res = await runStep(flow_run_id);
  
  // handle cross-flow
  if (res.next_flow_id) {
    await runFlow(res.next_flow_id, {});
    return;
  }
  
  // stop when no next step
  if (!res.next_step_id) {
    break;
  }
}
```
