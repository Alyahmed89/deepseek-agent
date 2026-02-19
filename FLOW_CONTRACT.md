# Flow Contract Implementation

## Overview
The flow contract defines a specific workflow for processing tasks:

1. **SELECT * FROM tasks WHERE status='pending' ORDER BY priority DESC LIMIT 1**
2. **Execute** the selected task
3. **Test against stored success_criteria**
4. **If ALL pass → status='done'**
5. **Stop flow** (process only one task per execution)
6. **Only two states: pending, done**
7. **Highest priority number always first**

## Database Schema Updates

### Updated `tasks` table:
```sql
CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
    priority INTEGER DEFAULT 0,
    success_criteria TEXT  -- JSON or text describing success criteria
);
```

### Key Changes:
1. **Status constraint**: Only `'pending'` or `'done'` allowed
2. **success_criteria column**: Stores criteria for task validation (JSON format)
3. **Index**: `idx_tasks_status_priority` for efficient querying

## Flow Contract Query

The core query that implements the flow contract:
```sql
SELECT * FROM tasks WHERE status='pending' ORDER BY priority DESC LIMIT 1
```

### Behavior:
- Selects only `pending` tasks (ignores `done` tasks)
- Orders by `priority DESC` (higher number = higher priority)
- Returns only 1 task (the highest priority pending task)
- If multiple tasks have same priority, one is selected arbitrarily

## Implementation Files

### 1. `schema_flow.sql`
- Complete schema with flow contract support
- Includes success_criteria column
- Adds CHECK constraint for status values
- Creates optimized indexes

### 2. `flow_contract.py`
- Main implementation of the flow contract
- `FlowContract` class with methods:
  - `get_next_pending_task()`: Executes the flow contract query
  - `execute_task()`: Simulates task execution
  - `_test_success_criteria()`: Tests execution against criteria
  - `run_flow()`: Runs the complete flow contract
  - `update_task_status()`: Updates status (only 'pending' or 'done')

### 3. `test_exact_flow.py`
- Demonstrates the exact flow contract query
- Shows task selection logic
- Simulates execution and status updates

## Success Criteria Examples

Success criteria are stored as JSON in the `success_criteria` column:

```python
# Example success criteria
{
    "min_length": 20,           # Payload must be at least 20 chars
    "contains": "important",    # Payload must contain "important"
    "has_artifact": 1           # Task must have at least 1 linked artifact
}
```

## Usage Example

```python
from flow_contract import FlowContract

# Initialize
flow = FlowContract("tasks.db")
flow.connect()
flow.initialize()

# Create task with success criteria
task_id = flow.create_task(
    task_type="validate_document",
    payload="Important document content",
    priority=5,
    success_criteria={
        "min_length": 10,
        "contains": "Important"
    }
)

# Run the flow contract
result = flow.run_flow()
# This will:
# 1. Select the highest priority pending task
# 2. Execute it
# 3. Test against success criteria
# 4. If all pass → mark as 'done'
# 5. Stop (only processes one task)

flow.close()
```

## Key Principles

1. **Single Task Processing**: Each flow execution processes only one task
2. **Priority-Based**: Higher priority numbers are processed first
3. **Binary States**: Tasks are either `pending` or `done`
4. **Criteria-Driven**: Tasks only become `done` when all success criteria pass
5. **Deterministic Selection**: Always selects the highest priority pending task

## Testing the Flow Contract

Run the test to see the flow contract in action:
```bash
python test_exact_flow.py
```

Or run the full demonstration:
```bash
python flow_contract.py
```