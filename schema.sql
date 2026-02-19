-- Database schema for tasks and related artifacts
-- Required tables: 3

-- tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- doc_artifacts table
CREATE TABLE IF NOT EXISTS doc_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    content TEXT,
    type TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- doc_task_links table (links tasks → artifacts)
CREATE TABLE IF NOT EXISTS doc_task_links (
    task_id INTEGER NOT NULL,
    artifact_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (task_id, artifact_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (artifact_id) REFERENCES doc_artifacts(id) ON DELETE CASCADE
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_doc_artifacts_path ON doc_artifacts(path);
CREATE INDEX IF NOT EXISTS idx_doc_artifacts_type ON doc_artifacts(type);
CREATE INDEX IF NOT EXISTS idx_doc_task_links_task_id ON doc_task_links(task_id);
CREATE INDEX IF NOT EXISTS idx_doc_task_links_artifact_id ON doc_task_links(artifact_id);