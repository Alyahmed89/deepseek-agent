import sqlite3
import json
from typing import Optional, Dict, Any, List

class FlowContract:
    def __init__(self, db_path="tasks.db"):
        self.db_path = db_path
        self.conn = None
        self.cursor = None
        
    def connect(self):
        """Connect to the database"""
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row  # Return rows as dictionaries
        self.cursor = self.conn.cursor()
        return self
    
    def close(self):
        """Close the database connection"""
        if self.conn:
            self.conn.close()
    
    def initialize(self):
        """Initialize the database with flow contract schema"""
        with open('schema_flow.sql', 'r') as f:
            schema = f.read()
        
        self.cursor.executescript(schema)
        self.conn.commit()
        print("Database initialized with flow contract schema")
    
    def create_task(self, task_type: str, payload: str, priority: int = 0, 
                   success_criteria: Optional[Dict] = None) -> int:
        """Create a new task with success criteria"""
        criteria_json = json.dumps(success_criteria) if success_criteria else None
        query = """
        INSERT INTO tasks (type, payload, status, priority, success_criteria)
        VALUES (?, ?, 'pending', ?, ?)
        """
        self.cursor.execute(query, (task_type, payload, priority, criteria_json))
        self.conn.commit()
        return self.cursor.lastrowid
    
    def get_next_pending_task(self) -> Optional[Dict]:
        """Get the highest priority pending task according to flow contract"""
        query = """
        SELECT * FROM tasks 
        WHERE status='pending' 
        ORDER BY priority DESC 
        LIMIT 1
        """
        self.cursor.execute(query)
        row = self.cursor.fetchone()
        if row:
            task = dict(row)
            # Parse success_criteria JSON if it exists
            if task['success_criteria']:
                try:
                    task['success_criteria'] = json.loads(task['success_criteria'])
                except json.JSONDecodeError:
                    task['success_criteria'] = None
            return task
        return None
    
    def execute_task(self, task_id: int) -> Dict[str, Any]:
        """Execute a task and return execution results"""
        # Get task details
        query = "SELECT * FROM tasks WHERE id = ?"
        self.cursor.execute(query, (task_id,))
        task = dict(self.cursor.fetchone())
        
        # Parse success_criteria
        criteria = None
        if task['success_criteria']:
            try:
                criteria = json.loads(task['success_criteria'])
            except json.JSONDecodeError:
                criteria = None
        
        # Simulate task execution
        # In a real implementation, this would execute the actual task logic
        execution_result = {
            'task_id': task_id,
            'task_type': task['type'],
            'payload': task['payload'],
            'executed': True,
            'results': f"Executed task {task_id}: {task['type']} with payload: {task['payload']}",
            'criteria_passed': []
        }
        
        # Test against success criteria if they exist
        if criteria:
            execution_result['criteria_passed'] = self._test_success_criteria(
                task_id, criteria, execution_result
            )
        
        return execution_result
    
    def _test_success_criteria(self, task_id: int, criteria: Dict, 
                              execution_result: Dict) -> List[bool]:
        """Test execution results against success criteria"""
        passed = []
        
        # Simple criteria testing logic
        # In a real implementation, this would be more sophisticated
        for criterion_name, criterion_value in criteria.items():
            if criterion_name == 'min_length':
                # Example: Check if payload meets minimum length
                payload = execution_result.get('payload', '')
                passed.append(len(payload) >= criterion_value)
            elif criterion_name == 'contains':
                # Example: Check if payload contains certain text
                payload = execution_result.get('payload', '')
                passed.append(criterion_value in payload)
            elif criterion_name == 'has_artifact':
                # Example: Check if task has linked artifacts
                query = """
                SELECT COUNT(*) as count FROM doc_task_links 
                WHERE task_id = ?
                """
                self.cursor.execute(query, (task_id,))
                count = self.cursor.fetchone()['count']
                passed.append(count >= criterion_value)
            else:
                # Default: assume criterion passes
                passed.append(True)
        
        return passed
    
    def update_task_status(self, task_id: int, status: str) -> bool:
        """Update task status (only 'pending' or 'done' allowed)"""
        if status not in ['pending', 'done']:
            raise ValueError("Status must be either 'pending' or 'done'")
        
        query = """
        UPDATE tasks 
        SET status = ?
        WHERE id = ?
        """
        self.cursor.execute(query, (status, task_id))
        self.conn.commit()
        return self.cursor.rowcount > 0
    
    def run_flow(self) -> Optional[Dict]:
        """
        Run the complete flow contract:
        1. Get highest priority pending task
        2. Execute it
        3. Test against success criteria
        4. If ALL pass → mark as 'done'
        5. Stop flow (return after processing one task)
        """
        # Step 1: Get highest priority pending task
        task = self.get_next_pending_task()
        if not task:
            print("No pending tasks found")
            return None
        
        print(f"Processing task {task['id']}: {task['type']} (Priority: {task['priority']})")
        
        # Step 2: Execute the task
        execution_result = self.execute_task(task['id'])
        print(f"Execution result: {execution_result['results']}")
        
        # Step 3: Test against success criteria
        criteria_passed = execution_result['criteria_passed']
        
        if criteria_passed:
            print(f"Success criteria tests: {criteria_passed}")
            
            # Step 4: If ALL pass → mark as 'done'
            if all(criteria_passed):
                self.update_task_status(task['id'], 'done')
                print(f"Task {task['id']} marked as 'done'")
            else:
                print(f"Task {task['id']} did not pass all success criteria")
        else:
            print("No success criteria to test")
        
        # Step 5: Stop flow (return after processing one task)
        return {
            'task': task,
            'execution_result': execution_result,
            'all_criteria_passed': all(criteria_passed) if criteria_passed else None,
            'new_status': 'done' if (criteria_passed and all(criteria_passed)) else 'pending'
        }
    
    def get_task_status(self, task_id: int) -> Optional[str]:
        """Get current status of a task"""
        query = "SELECT status FROM tasks WHERE id = ?"
        self.cursor.execute(query, (task_id,))
        row = self.cursor.fetchone()
        return row['status'] if row else None
    
    def __enter__(self):
        self.connect()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

# Example usage and demonstration
if __name__ == "__main__":
    # Initialize database with flow contract
    flow = FlowContract()
    flow.connect()
    flow.initialize()
    
    # Clear any existing data
    flow.cursor.execute("DELETE FROM tasks")
    flow.cursor.execute("DELETE FROM doc_artifacts")
    flow.cursor.execute("DELETE FROM doc_task_links")
    flow.conn.commit()
    
    print("=== Flow Contract Demonstration ===\n")
    
    # Create tasks with different priorities and success criteria
    task1_id = flow.create_task(
        task_type="validate_document",
        payload="This is a test document with sufficient content",
        priority=3,
        success_criteria={
            "min_length": 20,  # Document must be at least 20 chars
            "contains": "test"  # Must contain the word "test"
        }
    )
    
    task2_id = flow.create_task(
        task_type="process_data",
        payload="Quick data",
        priority=5,  # Higher priority than task1
        success_criteria={
            "min_length": 10  # Must be at least 10 chars
        }
    )
    
    task3_id = flow.create_task(
        task_type="analyze_results",
        payload="Analysis of experimental data",
        priority=1,  # Lower priority
        success_criteria={
            "contains": "experimental"
        }
    )
    
    # Create some artifacts and link them
    artifact1_id = flow.cursor.execute(
        "INSERT INTO doc_artifacts (path, content, type) VALUES (?, ?, ?)",
        ("/docs/report.pdf", "Report content", "pdf")
    ).lastrowid
    
    flow.cursor.execute(
        "INSERT INTO doc_task_links (task_id, artifact_id) VALUES (?, ?)",
        (task1_id, artifact1_id)
    )
    
    flow.conn.commit()
    
    # Show all tasks
    print("All tasks in database:")
    flow.cursor.execute("SELECT id, type, status, priority FROM tasks ORDER BY priority DESC")
    for row in flow.cursor.fetchall():
        print(f"  Task {row['id']}: {row['type']} - {row['status']} (Priority: {row['priority']})")
    
    print("\n" + "="*50 + "\n")
    
    # Run the flow contract
    print("Running flow contract...")
    result = flow.run_flow()
    
    print("\n" + "="*50 + "\n")
    
    # Show task statuses after flow
    print("Task statuses after flow execution:")
    flow.cursor.execute("SELECT id, type, status, priority FROM tasks ORDER BY priority DESC")
    for row in flow.cursor.fetchall():
        print(f"  Task {row['id']}: {row['type']} - {row['status']} (Priority: {row['priority']})")
    
    print("\n" + "="*50 + "\n")
    
    # Run flow again to process next task
    print("Running flow contract again...")
    result = flow.run_flow()
    
    flow.close()