import { ExecutionContext } from './execution-context'

// Simple in-memory endpoint map
const endpoints = {
  send_email: { url: "https://api.example.com/email", method: "POST" },
  search_user: { url: "https://api.example.com/users/search", method: "GET" },
  create_task: { url: "https://api.example.com/tasks", method: "POST" },
  get_tasks: { url: "https://api.example.com/tasks", method: "GET" }
}

// Simple variable injection (no parsing layers)
function inject(value: any, variables: Record<string, any>): any {
  if (typeof value === 'string' && value.startsWith('{{') && value.endsWith('}}')) {
    const varName = value.slice(2, -2).trim()
    return variables[varName] || value
  }
  return value
}

// Universal executor function (field presence based)
async function runStepAction(step: any, variables: Record<string, any>): Promise<any> {
  // COMMAND
  if (step.command) {
    const endpoint = endpoints[step.command]
    if (!endpoint) throw new Error(`Unknown command: ${step.command}`)

    const res = await fetch(endpoint.url, {
      method: endpoint.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(step.payload || {})
    })

    return await res.json()
  }

  // API
  if (step.api || step.url) {
    const config = step.api || step

    const body = inject(config.body, variables)

    const res = await fetch(config.url, {
      method: config.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    })

    return await res.json()
  }

  // INSTRUCTION
  return step.instructions || null
}

export class StepExecutor {
  constructor(private env: any) {}

  async executeStep(
    context: ExecutionContext,
    step: any,
    agent: string
  ): Promise<ExecutionContext> {

    // Use universal executor for step actions
    const result = await runStepAction(step, context.variables || {})

    // Store result in context
    context.ai_output = {
      reasoning: `Executed step with fields: ${Object.keys(step).filter(k => ['command', 'api', 'url', 'instructions'].includes(k)).join(', ') || 'none'}`,
      actions: [],
      next_step: null,
      variables: {
        ...(context.variables || {}),
        [`step_${step.id}`]: result
      }
    }
    
    context.ai_timestamp = Date.now()
    context.step_id = step.id
    context.step_count++

    return context
  }
}