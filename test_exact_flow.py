import sqlite3
import json

# Create a fresh database
conn = sqlite3.connect(':memory:')
conn.row_factory = sqlite3.Row
cursor = conn.cursor()

# Create the schema with flow contract
cursor.executescript("""
CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
    priority INTEGER DEFAULT 0,
    success_criteria TEXT
);

CREATE INDEX idx_tasks_status_priority ON tasks(status, priority DESC);
""")

# Insert test data
test_tasks = [
    ("task_low", "Low priority task", "pending", 1, None),
    ("task_medium", "Medium priority task", "pending", 3, json.dumps({"min_length": 5})),
    ("task_high", "High priority task", "pending", 5, json.dumps({"contains": "important"})),
    ("task_done", "Already done task", "done", 10, None),
    ("task_medium2", "Another medium task", "pending", 3, None),
]

for task in test_tasks:
    cursor.execute(
        "INSERT INTO tasks (type, payload, status, priority, success_criteria) VALUES (?, ?, ?, ?, ?)",
        task
    )

conn.commit()

print("=== Testing Exact Flow Contract Query ===\n")

# Test 1: Show all tasks
print("All tasks in database:")
cursor.execute("SELECT id, type, status, priority FROM tasks ORDER BY priority DESC")
for row in cursor.fetchall():
    print(f"  Task {row['id']}: {row['type']} - {row['status']} (Priority: {row['priority']})")

print("\n" + "="*50 + "\n")

# Test 2: Execute the exact flow contract query
print("Executing flow contract query:")
print("SELECT * FROM tasks WHERE status='pending' ORDER BY priority DESC LIMIT 1")
print()

cursor.execute("SELECT * FROM tasks WHERE status='pending' ORDER BY priority DESC LIMIT 1")
result = cursor.fetchone()

if result:
    print(f"Selected task: Task {result['id']} - {result['type']}")
    print(f"  Priority: {result['priority']}")
    print(f"  Payload: {result['payload']}")
    print(f"  Status: {result['status']}")
    
    if result['success_criteria']:
        criteria = json.loads(result['success_criteria'])
        print(f"  Success Criteria: {criteria}")
    
    print("\nThis is the task that should be executed according to the flow contract.")
    print("Highest priority number (5) is selected first, even though there's a done task with priority 10.")
else:
    print("No pending tasks found")

print("\n" + "="*50 + "\n")

# Test 3: Show what happens after marking as done
print("Simulating task execution and marking as 'done':")
if result:
    # Mark the task as done
    cursor.execute("UPDATE tasks SET status='done' WHERE id=?", (result['id'],))
    conn.commit()
    
    print(f"Task {result['id']} marked as 'done'")
    
    # Run the query again
    print("\nRunning flow contract query again:")
    cursor.execute("SELECT * FROM tasks WHERE status='pending' ORDER BY priority DESC LIMIT 1")
    next_result = cursor.fetchone()
    
    if next_result:
        print(f"Next task: Task {next_result['id']} - {next_result['type']} (Priority: {next_result['priority']})")
        print("\nNote: Now priority 3 tasks are selected (there are two with same priority)")
    else:
        print("No more pending tasks")

print("\n" + "="*50 + "\n")

# Test 4: Show final state
print("Final task states:")
cursor.execute("SELECT id, type, status, priority FROM tasks ORDER BY priority DESC")
for row in cursor.fetchall():
    status_symbol = "✓" if row['status'] == 'done' else "○"
    print(f"  {status_symbol} Task {row['id']}: {row['type']} - {row['status']} (Priority: {row['priority']})")

conn.close()