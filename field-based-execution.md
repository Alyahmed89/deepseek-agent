# Field-Based Execution Examples (No step_type)

## 1. COMMAND STEP (has `command` field)
```json
{
  "id": "step_1",
  "command": "send_email",
  "payload": {
    "to": "user@example.com",
    "subject": "Welcome",
    "body": "Welcome to our platform!"
  },
  "title": "Send Email"
}
```
**Execution:** Looks up `send_email` in endpoints map and calls it

## 2. API STEP (has `api` or `url` field)
```json
{
  "id": "step_2",
  "api": {
    "url": "https://api.example.com/users",
    "method": "POST",
    "body": {
      "name": "John Doe",
      "email": "john@example.com"
    }
  },
  "title": "Create User"
}
```
**OR**
```json
{
  "id": "step_3",
  "url": "https://api.example.com/users/search",
  "method": "GET",
  "title": "Search Users"
}
```
**Execution:** Makes HTTP request to specified URL

## 3. INSTRUCTION STEP (has `instructions` field)
```json
{
  "id": "step_4",
  "instructions": "Send welcome email to new user",
  "title": "Send Welcome Email"
}
```
**Execution:** Returns instruction text

## 4. AI-GENERATED STEP (mixed fields)
```json
{
  "id": "step_5",
  "instructions": "Create user account",
  "api": {
    "url": "https://api.example.com/users",
    "method": "POST",
    "body": {
      "name": "{{user_name}}",
      "email": "{{user_email}}"
    }
  },
  "title": "Create User Account"
}
```
**Execution:** Uses `api` field (takes precedence over `instructions`)

## FIELD PRIORITY:
1. `command` → Execute command from endpoints map
2. `api` or `url` → Make HTTP request
3. `instructions` → Return instruction text
