# Database Schema for Tasks and Artifacts with Flow Contract

## Required Tables

### 1. `tasks` table
- `id` - Primary key
- `type` - Task type (text)
- `payload` - Task data/payload (text)
- `status` - Task status (text, only 'pending' or 'done')
- `priority` - Task priority (integer, higher number = higher priority)
- `success_criteria` - JSON criteria for task validation (optional)

### 2. `doc_artifacts` table
- `id` - Primary key
- `path` - File path or location (text)
- `content` - Content or pointer to content (text)
- `type` - Artifact type (text)

### 3. `doc_task_links` table
- `task_id` - Foreign key to tasks.id
- `artifact_id` - Foreign key to doc_artifacts.id
- Composite primary key: (task_id, artifact_id)

## Flow Contract

The system implements a specific flow contract:

```sql
SELECT * FROM tasks WHERE status='pending' ORDER BY priority DESC LIMIT 1
```

### Flow Contract Steps:
1. **Select**: Get highest priority pending task (higher number = higher priority)
2. **Execute**: Execute the selected task
3. **Test**: Test against stored success_criteria
4. **Update**: If ALL criteria pass → status='done'
5. **Stop**: Process only one task per execution

### Key Rules:
- Only two states: `pending` or `done`
- Highest priority number always processed first
- Tasks only become `done` when all success criteria pass
- One task processed per flow execution

## Schema Options

1. **Minimal Schema** (`schema_minimal.sql`):
   - Exactly matches the basic required structure
   - No additional columns
   - Most minimal implementation

2. **Enhanced Schema** (`schema.sql`):
   - Includes `created_at` and `updated_at` timestamps
   - Includes indexes for better performance
   - More production-ready

3. **Flow Contract Schema** (`schema_flow.sql`):
   - Includes `success_criteria` column
   - Status constraint: only 'pending' or 'done' allowed
   - Optimized indexes for flow contract queries
   - Implements the complete flow contract

## Usage

### Basic Setup:
```bash
# Initialize with flow contract schema
python -c "
import sqlite3
conn = sqlite3.connect('tasks.db')
with open('schema_flow.sql', 'r') as f:
    conn.executescript(f.read())
conn.close()
print('Database initialized with flow contract schema')
"
```

### Run Flow Contract:
```bash
# Execute the flow contract
python flow_contract.py
```

### Test Exact Flow:
```bash
# Test the exact flow contract query
python test_exact_flow.py
```

### Using the FlowContract Class:
```python
from flow_contract import FlowContract

flow = FlowContract("tasks.db")
flow.connect()

# Create task with success criteria
task_id = flow.create_task(
    task_type="process_data",
    payload="Important data to process",
    priority=5,
    success_criteria={
        "min_length": 10,
        "contains": "Important"
    }
)

# Run the flow contract
result = flow.run_flow()
# Processes one task according to the flow contract rules

flow.close()
```

## Implementation Files

- `schema_flow.sql` - Flow contract database schema
- `flow_contract.py` - Main flow contract implementation
- `test_exact_flow.py` - Demonstration of exact flow contract query
- `FLOW_CONTRACT.md` - Detailed flow contract documentation
- `database.py` - Basic database interface (original implementation)
- `schema_minimal.sql` - Minimal schema (original requirements)
- `schema.sql` - Enhanced schema with timestamps

## Minimal Changes

The implementation follows your requirements:
- Only 3 required tables
- All tables in the same database
- Simple, minimal schema
- Provides foreign key relationships between tasks and artifacts
- Implements the exact flow contract specification

## Database Compatibility

The schema uses standard SQL that should work with:
- SQLite (as shown in the example)
- PostgreSQL
- MySQL/MariaDB
- Other SQL databases with minor adjustments