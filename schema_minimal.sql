-- Minimal database schema for tasks and related artifacts
-- Exactly matches the required structure

-- tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL,
    priority INTEGER DEFAULT 0
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