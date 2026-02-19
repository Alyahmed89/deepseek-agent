# Database Schema for Tasks and Artifacts

## Required Tables

### 1. `tasks` table
- `id` - Primary key
- `type` - Task type (text)
- `payload` - Task data/payload (text)
- `status` - Task status (text)
- `priority` - Task priority (integer)

### 2. `doc_artifacts` table
- `id` - Primary key
- `path` - File path or location (text)
- `content` - Content or pointer to content (text)
- `type` - Artifact type (text)

### 3. `doc_task_links` table
- `task_id` - Foreign key to tasks.id
- `artifact_id` - Foreign key to doc_artifacts.id
- Composite primary key: (task_id, artifact_id)

## Schema Options

1. **Minimal Schema** (`schema_minimal.sql`):
   - Exactly matches the required structure
   - No additional columns
   - Most minimal implementation

2. **Enhanced Schema** (`schema.sql`):
   - Includes `created_at` and `updated_at` timestamps
   - Includes indexes for better performance
   - More production-ready

## Usage

1. Initialize the database with minimal schema:
```bash
python -c "
import sqlite3
conn = sqlite3.connect('tasks.db')
with open('schema_minimal.sql', 'r') as f:
    conn.executescript(f.read())
conn.close()
print('Database initialized with minimal schema')
"
```

2. Or use the enhanced schema:
```bash
python -c "
import sqlite3
conn = sqlite3.connect('tasks.db')
with open('schema.sql', 'r') as f:
    conn.executescript(f.read())
conn.close()
print('Database initialized with enhanced schema')
"
```

3. The `database.py` file provides a simple Python interface for working with the tables.

## Minimal Changes

The implementation follows your requirements:
- Only 3 required tables
- All tables in the same database
- Simple, minimal schema
- Provides foreign key relationships between tasks and artifacts

## Database Compatibility

The schema uses standard SQL that should work with:
- SQLite (as shown in the example)
- PostgreSQL
- MySQL/MariaDB
- Other SQL databases with minor adjustments