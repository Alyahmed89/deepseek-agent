import sqlite3
import os
from datetime import datetime

class TaskDatabase:
    def __init__(self, db_path="tasks.db"):
        self.db_path = db_path
        self.conn = None
        self.cursor = None
        
    def connect(self):
        """Connect to the database"""
        self.conn = sqlite3.connect(self.db_path)
        self.cursor = self.conn.cursor()
        return self
    
    def close(self):
        """Close the database connection"""
        if self.conn:
            self.conn.close()
    
    def initialize(self):
        """Initialize the database with required tables"""
        with open('schema.sql', 'r') as f:
            schema = f.read()
        
        self.cursor.executescript(schema)
        self.conn.commit()
        print("Database initialized with required tables")
    
    def create_task(self, task_type, payload, status="pending", priority=0):
        """Create a new task"""
        query = """
        INSERT INTO tasks (type, payload, status, priority)
        VALUES (?, ?, ?, ?)
        """
        self.cursor.execute(query, (task_type, payload, status, priority))
        self.conn.commit()
        return self.cursor.lastrowid
    
    def create_doc_artifact(self, path, content, artifact_type):
        """Create a new document artifact"""
        query = """
        INSERT INTO doc_artifacts (path, content, type)
        VALUES (?, ?, ?)
        """
        self.cursor.execute(query, (path, content, artifact_type))
        self.conn.commit()
        return self.cursor.lastrowid
    
    def link_task_to_artifact(self, task_id, artifact_id):
        """Link a task to an artifact"""
        query = """
        INSERT OR IGNORE INTO doc_task_links (task_id, artifact_id)
        VALUES (?, ?)
        """
        self.cursor.execute(query, (task_id, artifact_id))
        self.conn.commit()
        return self.cursor.rowcount > 0
    
    def get_tasks_with_artifacts(self):
        """Get all tasks with their linked artifacts"""
        query = """
        SELECT t.id, t.type, t.status, t.priority, 
               GROUP_CONCAT(da.path) as artifact_paths,
               GROUP_CONCAT(da.type) as artifact_types
        FROM tasks t
        LEFT JOIN doc_task_links dtl ON t.id = dtl.task_id
        LEFT JOIN doc_artifacts da ON dtl.artifact_id = da.id
        GROUP BY t.id
        ORDER BY t.priority DESC, t.created_at DESC
        """
        self.cursor.execute(query)
        return self.cursor.fetchall()
    
    def update_task_status(self, task_id, status):
        """Update task status"""
        query = """
        UPDATE tasks 
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """
        self.cursor.execute(query, (status, task_id))
        self.conn.commit()
        return self.cursor.rowcount > 0
    
    def __enter__(self):
        self.connect()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

# Example usage
if __name__ == "__main__":
    # Initialize database
    db = TaskDatabase()
    db.connect()
    db.initialize()
    
    # Create some sample data
    task1_id = db.create_task("process_document", "Process document X", "pending", 1)
    task2_id = db.create_task("analyze_data", "Analyze dataset Y", "in_progress", 2)
    
    artifact1_id = db.create_doc_artifact("/docs/doc1.txt", "Content of document 1", "text")
    artifact2_id = db.create_doc_artifact("/docs/doc2.pdf", "Content of document 2", "pdf")
    artifact3_id = db.create_doc_artifact("/data/dataset.csv", "Dataset content", "csv")
    
    # Link tasks to artifacts
    db.link_task_to_artifact(task1_id, artifact1_id)
    db.link_task_to_artifact(task1_id, artifact2_id)
    db.link_task_to_artifact(task2_id, artifact3_id)
    
    # Get tasks with artifacts
    tasks = db.get_tasks_with_artifacts()
    print("\nTasks with artifacts:")
    for task in tasks:
        print(f"Task {task[0]}: {task[1]} - {task[2]} (Priority: {task[3]})")
        print(f"  Artifacts: {task[4]}")
        print(f"  Types: {task[5]}")
    
    db.close()