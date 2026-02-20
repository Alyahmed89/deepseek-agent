export interface Task {
  id: number;
  type: string;
  payload: string;
  status: 'pending' | 'done';
  priority: number;
  success_criteria?: string;
  created_at?: string;
  updated_at?: string;
}

export interface DocArtifact {
  id: number;
  path: string;
  content: string;
  type: string;
  created_at?: string;
}

export interface DocTaskLink {
  task_id: number;
  artifact_id: number;
}

export class Database {
  // In a real Cloudflare Worker, you would use D1, KV, or R2
  // For this example, we'll use an in-memory simulation
  
  private tasks: Task[] = [
    {
      id: 1,
      type: 'process_document',
      payload: '{"document_id": "doc1", "action": "summarize"}',
      status: 'pending',
      priority: 10,
      success_criteria: 'summary_length > 100'
    },
    {
      id: 2,
      type: 'extract_data',
      payload: '{"document_id": "doc2", "fields": ["title", "author"]}',
      status: 'pending',
      priority: 5,
      success_criteria: 'all_fields_extracted = true'
    },
    {
      id: 3,
      type: 'validate_schema',
      payload: '{"schema": "invoice", "document_id": "doc3"}',
      status: 'done',
      priority: 8,
      success_criteria: 'validation_passed = true'
    }
  ];
  
  private artifacts: DocArtifact[] = [
    {
      id: 1,
      path: '/documents/report.pdf',
      content: 'Annual financial report 2024',
      type: 'pdf'
    },
    {
      id: 2,
      path: '/documents/contract.docx',
      content: 'Service agreement contract',
      type: 'docx'
    }
  ];
  
  private links: DocTaskLink[] = [
    { task_id: 1, artifact_id: 1 },
    { task_id: 2, artifact_id: 2 }
  ];
  
  // Flow contract query: SELECT * FROM tasks WHERE status='pending' ORDER BY priority DESC LIMIT 1
  getNextTask(): Task | null {
    const pendingTasks = this.tasks.filter(task => task.status === 'pending');
    if (pendingTasks.length === 0) {
      return null;
    }
    
    // Sort by priority descending (higher number = higher priority)
    pendingTasks.sort((a, b) => b.priority - a.priority);
    
    return pendingTasks[0];
  }
  
  getAllTasks(): Task[] {
    return this.tasks;
  }
  
  getTaskById(id: number): Task | null {
    return this.tasks.find(task => task.id === id) || null;
  }
  
  updateTaskStatus(id: number, status: 'pending' | 'done'): boolean {
    const taskIndex = this.tasks.findIndex(task => task.id === id);
    if (taskIndex === -1) {
      return false;
    }
    
    this.tasks[taskIndex].status = status;
    this.tasks[taskIndex].updated_at = new Date().toISOString();
    return true;
  }
  
  createTask(task: Omit<Task, 'id' | 'created_at' | 'updated_at'>): Task {
    const newId = Math.max(0, ...this.tasks.map(t => t.id)) + 1;
    const newTask: Task = {
      ...task,
      id: newId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    this.tasks.push(newTask);
    return newTask;
  }
  
  getAllArtifacts(): DocArtifact[] {
    return this.artifacts;
  }
  
  getArtifactsForTask(taskId: number): DocArtifact[] {
    const artifactIds = this.links
      .filter(link => link.task_id === taskId)
      .map(link => link.artifact_id);
    
    return this.artifacts.filter(artifact => 
      artifactIds.includes(artifact.id)
    );
  }
  
  getTasksForArtifact(artifactId: number): Task[] {
    const taskIds = this.links
      .filter(link => link.artifact_id === artifactId)
      .map(link => link.task_id);
    
    return this.tasks.filter(task => 
      taskIds.includes(task.id)
    );
  }
  
  executeFlowContract(): { task: Task | null, message: string } {
    const nextTask = this.getNextTask();
    
    if (!nextTask) {
      return { task: null, message: 'No pending tasks available' };
    }
    
    // Simulate task execution
    console.log(`Executing task ${nextTask.id}: ${nextTask.type}`);
    console.log(`Payload: ${nextTask.payload}`);
    
    // Simulate testing against success criteria
    const testPassed = Math.random() > 0.3; // 70% success rate for demo
    
    if (testPassed) {
      this.updateTaskStatus(nextTask.id, 'done');
      return { 
        task: nextTask, 
        message: `Task ${nextTask.id} executed successfully and marked as done` 
      };
    } else {
      return { 
        task: nextTask, 
        message: `Task ${nextTask.id} executed but tests failed (keeping as pending)` 
      };
    }
  }
}