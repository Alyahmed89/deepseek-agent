# Conditional Branching Implementation for ETAflow

## Overview
This implementation adds conditional branching support to the etaflow, allowing the flow to dynamically route based on OpenHands response content.

## Database Changes

### 1. Schema Updates
- Added `default_next_step` column to `flow_steps` table
- Created `flow_step_conditions` table for conditional branching rules
- Added index for faster condition lookups

### 2. Flow Steps Configuration
- **28 steps total** (1-30, missing steps 18 and 21 as requested)
- Each step has `default_next_step` configured
- **Step30 added**: Close OpenHands Conversation (after step23)

### 3. Conditional Branching Rules (13 rules)

#### Step1: Check Deployment Status D1
- If `"Status: Failed"` → Step2 (error logs)
- If `"Status: Success"` → Step4 (fetch task)

#### Step3: Browse Current State & Test
- If `"Test: Passed"` → Step19 (mark task complete)
- If `"Test: Not Passed"` → Step7 (gap analysis)

#### Step6: View Template (.eta source)
- If `"Needs editing: Yes"` → Step8 (edit template)
- If `"Needs editing: No"` → Step24 (check/edit payload)

#### Step7: Gap Analysis (Root Cause Decision)
- If `"Issue: Frontend"` → Step5 (search generated code)
- If `"Issue: Backend"` → Step15 (search backend code)
- If `"Issue: Data Flow"` → Step26 (Cloudflare API check) **[NEW]**

#### Step22: Verify ETA Worker Deployment
- If `"Status: Success"` → Step23 (start new flow)
- If `"Status: Failed"` → Step13 (ETA error handling)

#### Step26: Verify Hono Deployment
- If `"Status: Success"` → Step27 (test hono endpoint)
- If `"Status: Failed"` → Step28 (hono error handling)

## Key Features Implemented

### 1. Step4 After Step2 When Step1 Succeeds
- Step1 → If success → Step4 (fetch task)
- Step1 → If failure → Step2 (error logs) → Step5

### 2. Step22 Success Triggers New Flow
- Step23: `POST {"flow": "etaflow"}` to `https://deepseek-agent.alghamdimo89.workers.dev/start-flow`
- Step23 → Step30: Close OpenHands conversation

### 3. Enhanced Gap Analysis
- **Data flow check option**: If issue could be data movement/processing → Step26 (Cloudflare API check)
- **Clear decision logic**:
  - If test passed WITHOUT hono changes → Frontend issue
  - If test passed WITH hono changes → Check data flow via Cloudflare API
  - If test not passed → Continue gap analysis

### 4. Payload Customization Emphasis
- **24/28 steps** updated with: "All visible content must come from payload customization, NOT from hardcoded content in eta repo or hono repo."
- Ensures content is dynamically generated from payload rather than static files

## How Conditional Branching Works

### 1. Response Format Requirements
OpenHands must respond with specific strings for conditional branching:
- `"Status: Success"` / `"Status: Failed"`
- `"Test: Passed"` / `"Test: Not Passed"`
- `"Needs editing: Yes"` / `"Needs editing: No"`
- `"Issue: Frontend"` / `"Issue: Backend"` / `"Issue: Data Flow"`

### 2. Condition Evaluation
- `getNextStepBasedOnConditions()` function in `src/services/database.ts`
- Checks `flow_step_conditions` table for matching conditions
- Uses `response_contains` matching (case-insensitive)
- Returns appropriate next step based on conditions
- Falls back to `default_next_step` if no conditions match
- Falls back to sequential order if no default

### 3. Flow Execution
- `ConversationDO.ts`: `getNextStep()` calls `getNextStepBasedOnConditions()`
- Updates `current_step_index` based on returned step
- Continues execution with the new step

## Migration File
- `migrations/0009_conditional_branching.sql`: Contains all database changes
- Can be applied to recreate the conditional branching setup

## Testing
To test the conditional branching:
1. Start a new etaflow via `/start-flow` endpoint
2. OpenHands should respond with the required format strings
3. Verify the flow branches correctly based on responses

## Files Created/Modified
1. `migrations/0009_conditional_branching.sql` - Database migration
2. `test_conditional_branching.md` - Test documentation
3. `CONDITIONAL_BRANCHING_IMPLEMENTATION.md` - This documentation

## Implementation Status
✅ **COMPLETE AND READY FOR USE**
- Database schema updated
- 28 steps configured with conditional branching
- 13 conditional rules implemented
- Payload customization emphasized
- All requirements satisfied