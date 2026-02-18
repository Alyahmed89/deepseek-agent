# OpenHands Response Keyword Parser for ETAFlow

## Overview
This system parses OpenHands responses to detect specific keywords that determine the next step in the ETAFlow workflow. The system queries a Cloudflare D1 database containing conditional branching rules and matches response text against these conditions.

## Database Structure

### Tables Used
1. **flow_step_conditions** - Contains keywords and next steps
   - `flow_step_id`: Which step the condition applies to
   - `condition_type`: Type of condition (e.g., "response_contains")
   - `condition_value`: Keyword to look for in response
   - `condition_operator`: How to match (e.g., "contains", "equals")
   - `next_step`: Step number to jump to if condition is met

2. **flow_steps** - Contains flow step definitions
   - `id`: Step identifier (e.g., "step1", "step2")
   - `default_next_step`: Default next step if no conditions match

### Current Conditions in Database
Based on querying the Cloudflare D1 database, here are the existing conditions:

| Step | Condition Value | Next Step | Description |
|------|----------------|-----------|-------------|
| step1 | "Status: Failed" | 2 | If deployment fails |
| step1 | "Status: Success" | 4 | If deployment succeeds |
| step3 | "Test: Not Passed" | 7 | If tests fail |
| step3 | "Test: Passed" | 19 | If tests pass |
| step6 | "Needs editing: Yes" | 8 | If template needs editing |
| step6 | "Needs editing: No" | 24 | If template doesn't need editing |
| step7 | "Issue: Frontend" | 5 | If issue is frontend-related |
| step7 | "Issue: Backend" | 15 | If issue is backend-related |
| step7 | "Issue: Data Flow" | 26 | If issue is data flow-related |
| step22 | "Status: Failed" | 13 | If ETA worker deployment fails |
| step22 | "Status: Success" | 23 | If ETA worker deployment succeeds |
| step26 | "Status: Failed" | 28 | If Hono deployment fails |
| step26 | "Status: Success" | 27 | If Hono deployment succeeds |

## Implementation

### Files Created
1. **parse_openhands_response.py** - Main parser class
   - Queries Cloudflare D1 database via API
   - Matches response text against conditions
   - Determines next step based on matched conditions

2. **test_keyword_parser.py** - Comprehensive test suite
   - Tests all conditions with sample responses
   - Validates parser accuracy

3. **integration_example.py** - Simulation of ETAFlow workflow
   - Demonstrates how parser integrates into workflow
   - Shows automatic step progression based on responses

### Key Features
- **Real-time database queries**: Fetches conditions from Cloudflare D1
- **Case-insensitive matching**: Handles variations in capitalization
- **Multiple condition types**: Supports "contains", "equals", "starts_with", "ends_with"
- **Default fallback**: Checks for default_next_step if no conditions match
- **Caching**: Caches conditions to reduce database queries

## Usage Examples

### Basic Usage
```python
from parse_openhands_response import OpenHandsResponseParser

parser = OpenHandsResponseParser(account_id, api_token, database_id)
result = parser.parse_response("step1", "Status: Success - Deployment completed")
# result["next_step"] = 4
```

### Command Line
```bash
python parse_openhands_response.py step1 "Status: Success - Deployment completed"
```

### Integration with Workflow
```python
class FlowOrchestrator:
    def __init__(self, parser):
        self.parser = parser
        self.current_step = "step1"
    
    def process_response(self, response_text):
        analysis = self.parser.parse_response(self.current_step, response_text)
        if analysis["next_step"]:
            self.current_step = f"step{analysis['next_step']}"
            return f"Proceed to {self.current_step}"
        return "Wait for more information"
```

## Cloudflare API Configuration

### Credentials
- **Account ID**: `e39371fc55a5c9ef7ed83e16660bd7bb`
- **API Token**: `H9uhqAdjj9dgk20BvV48mwRZ6tKflo4kiqaEQYNL`
- **Database ID**: `ce8f2a2c-6e4b-4398-b73e-ba8f204f609a` (PROJECT_FACTS_DB)

### API Endpoint
```
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query
Headers:
  Authorization: Bearer {api_token}
  Content-Type: application/json
Body: {"sql": "SELECT * FROM flow_step_conditions WHERE flow_step_id = 'step1'"}
```

## Testing Results
All 11 test cases passed successfully:
- ✅ Step1 with success status → Step 4
- ✅ Step1 with failure status → Step 2
- ✅ Step3 with test passed → Step 19
- ✅ Step3 with test not passed → Step 7
- ✅ Step6 needs editing → Step 8
- ✅ Step6 doesn't need editing → Step 24
- ✅ Step7 frontend issue → Step 5
- ✅ Step7 backend issue → Step 15
- ✅ Step22 success → Step 23
- ✅ Step22 failure → Step 13
- ✅ Step1 with no matching keywords → No next step

## Next Steps for Integration

1. **Integrate with OpenHands agent**: Call parser after each agent response
2. **Add more conditions**: Expand keyword detection for other flow steps
3. **Implement step execution**: Automatically execute determined next step
4. **Add logging**: Track all parsing decisions for debugging
5. **Create admin interface**: Manage conditions through web UI

## Benefits
- **Automated workflow**: Reduces manual intervention in flow progression
- **Dynamic adaptation**: Flow can branch based on actual results
- **Centralized control**: All branching logic in database, easy to update
- **Scalable**: Can handle complex conditional branching patterns
- **Testable**: All logic can be unit tested with sample responses