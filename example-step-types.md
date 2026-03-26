# Example Step Types for Universal Executor

## 1. INSTRUCTION STEP
```json
{
  "id": "step_1",
  "step_type": "instruction",
  "instructions": "Send welcome email to new user",
  "title": "Send Welcome Email"
}
```

## 2. API STEP
```json
{
  "id": "step_2",
  "step_type": "api",
  "url": "https://api.example.com/users",
  "method": "POST",
  "body": {
    "name": "John Doe",
    "email": "john@example.com"
  },
  "title": "Create User"
}
```

## 3. QUERY STEP
```json
{
  "id": "step_3",
  "step_type": "query",
  "url": "https://api.example.com/users/search",
  "method": "GET",
  "title": "Search Users"
}
```

## 4. COMMAND STEP
```json
{
  "id": "step_4",
  "step_type": "command",
  "command": "send_email",
  "payload": {
    "to": "user@example.com",
    "subject": "Welcome",
    "body": "Welcome to our platform!"
  },
  "title": "Send Email Command"
}
```

## How it works:
1. **Instruction step**: Returns the instruction text
2. **API/Query step**: Makes HTTP request to specified URL
3. **Command step**: Looks up endpoint in `endpoints` map and calls it
4. **Result storage**: All results stored in variables as `step_{id}`
5. **API logging**: All executions logged to `api_logs` table
