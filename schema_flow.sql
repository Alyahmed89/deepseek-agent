-- Database schema for tasks with flow contract support
-- Includes success_criteria for task validation

-- tasks table with success_criteria
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
    priority INTEGER DEFAULT 0,
    success_criteria TEXT  -- JSON or text describing success criteria
);

-- doc_artifacts table
CREATE TABLE IF NOT EXISTS doc_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    content TEXT,
    type TEXT NOT NULL
);

-- doc_task_links table (links tasks → artifacts)
CREATE TABLE IF NOT EXISTS doc_task_links (
    task_id INTEGER NOT NULL,
    artifact_id INTEGER NOT NULL,
    PRIMARY KEY (task_id, artifact_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (artifact_id) REFERENCES doc_artifacts(id) ON DELETE CASCADE
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);