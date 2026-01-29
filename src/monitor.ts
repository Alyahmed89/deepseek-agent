// Event monitoring system for OpenHands conversations

export interface OpenHandsEvent {
  id: number
  type: string
  content: string
  source: string
  timestamp: string
  metadata?: Record<string, any>
}

export interface ConversationMonitor {
  conversation_id: string
  last_event_id: number
  is_monitoring: boolean
  deepseek_context: string[]
  event_buffer: OpenHandsEvent[]
}

export class MonitoringService {
  private monitors: Map<string, ConversationMonitor> = new Map()
  private readonly MAX_EVENT_BUFFER = 100
  private readonly MONITOR_INTERVAL = 5000 // 5 seconds

  constructor(
    private deepseekApiKey: string,
    private openhandsApiKey: string,
    private openhandsApiUrl: string
  ) {}

  // Start monitoring a conversation
  async startMonitoring(conversation_id: string, first_prompt: string): Promise<ConversationMonitor> {
    const monitor: ConversationMonitor = {
      conversation_id,
      last_event_id: 0,
      is_monitoring: true,
      deepseek_context: [
        `Monitoring conversation: ${conversation_id}`,
        `First prompt: ${first_prompt}`,
        `Started at: ${new Date().toISOString()}`
      ],
      event_buffer: []
    }

    this.monitors.set(conversation_id, monitor)
    
    // Start periodic monitoring
    this.scheduleMonitoring(conversation_id)
    
    return monitor
  }

  // Stop monitoring a conversation
  stopMonitoring(conversation_id: string): void {
    const monitor = this.monitors.get(conversation_id)
    if (monitor) {
      monitor.is_monitoring = false
      this.monitors.delete(conversation_id)
    }
  }

  // Schedule periodic monitoring
  private scheduleMonitoring(conversation_id: string): void {
    const monitor = this.monitors.get(conversation_id)
    if (!monitor || !monitor.is_monitoring) return

    // Schedule next check
    setTimeout(async () => {
      try {
        await this.checkNewEvents(conversation_id)
      } catch (error) {
        console.error(`Error monitoring conversation ${conversation_id}:`, error)
      }
      
      // Reschedule if still monitoring
      if (this.monitors.has(conversation_id) && this.monitors.get(conversation_id)!.is_monitoring) {
        this.scheduleMonitoring(conversation_id)
      }
    }, this.MONITOR_INTERVAL)
  }

  // Check for new events and analyze them
  private async checkNewEvents(conversation_id: string): Promise<void> {
    const monitor = this.monitors.get(conversation_id)
    if (!monitor) return

    try {
      // Fetch new events since last check
      const newEvents = await this.fetchEvents(conversation_id, monitor.last_event_id)
      
      if (newEvents.length > 0) {
        // Update last event ID
        monitor.last_event_id = Math.max(...newEvents.map(e => e.id))
        
        // Add to buffer (keeping only recent events)
        monitor.event_buffer.push(...newEvents)
        if (monitor.event_buffer.length > this.MAX_EVENT_BUFFER) {
          monitor.event_buffer = monitor.event_buffer.slice(-this.MAX_EVENT_BUFFER)
        }

        // Analyze significant events
        const significantEvents = newEvents.filter(event => 
          this.isSignificantEvent(event)
        )

        if (significantEvents.length > 0) {
          await this.analyzeEvents(conversation_id, significantEvents)
        }
      }
    } catch (error) {
      console.error(`Error checking events for ${conversation_id}:`, error)
    }
  }

  // Fetch events from OpenHands API
  private async fetchEvents(conversation_id: string, since_id: number): Promise<OpenHandsEvent[]> {
    const response = await fetch(`${this.openhandsApiUrl}/conversations/${conversation_id}/events/search`, {
      method: 'POST',
      headers: {
        'X-Session-API-Key': this.openhandsApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        start_id: since_id + 1,
        limit: 50,
        exclude_hidden: false
      })
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch events: ${response.status}`)
    }

    return response.json()
  }

  // Determine if an event is significant enough to analyze
  private isSignificantEvent(event: OpenHandsEvent): boolean {
    const significantTypes = [
      'agent_response',
      'agent_action',
      'error',
      'task_completed',
      'task_failed',
      'code_execution',
      'git_operation'
    ]

    return significantTypes.includes(event.type) || 
           event.content.length > 100 || // Longer content might be important
           event.source === 'agent' // Agent actions are always significant
  }

  // Analyze events with DeepSeek
  private async analyzeEvents(conversation_id: string, events: OpenHandsEvent[]): Promise<void> {
    const monitor = this.monitors.get(conversation_id)
    if (!monitor) return

    // Format events for analysis
    const eventSummary = events
      .map(event => `[${event.timestamp}] ${event.type} (${event.source}): ${event.content.substring(0, 300)}${event.content.length > 300 ? '...' : ''}`)
      .join('\n\n')

    // Prepare context for DeepSeek
    const context = monitor.deepseek_context.join('\n')
    
    const analysisPrompt = `Analyze these new events from the OpenHands conversation.

Context:
${context}

New Events:
${eventSummary}

Analysis Guidelines:
1. Is the agent following the correct path?
2. Are there any errors or issues?
3. Should I intervene with a STOP command?
4. If intervention is needed, use: *[STOP]* CONTEXT: "brief context" Your correction message here

Provide your analysis:`

    try {
      const deepseekResponse = await this.callDeepSeek(analysisPrompt)
      
      // Add to context
      monitor.deepseek_context.push(`Analysis at ${new Date().toISOString()}: ${deepseekResponse.substring(0, 200)}...`)
      
      // Keep context manageable
      if (monitor.deepseek_context.length > 10) {
        monitor.deepseek_context = monitor.deepseek_context.slice(-10)
      }

      // Check for STOP command
      const stopMatch = deepseekResponse.match(/\*\[STOP\]\*\s*(?:CONTEXT:\s*"([^"]+)"\s*)?(.*)/i)
      if (stopMatch) {
        await this.handleStopCommand(conversation_id, stopMatch[1] || '', stopMatch[2] || '')
        this.stopMonitoring(conversation_id)
      }

    } catch (error) {
      console.error(`Error analyzing events for ${conversation_id}:`, error)
    }
  }

  // Call DeepSeek API
  private async callDeepSeek(prompt: string): Promise<string> {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.deepseekApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'You are monitoring an OpenHands conversation. Analyze events and provide guidance.' },
          { role: 'user', content: prompt }
        ],
        stream: false
      })
    })

    if (!response.ok) {
      throw new Error(`DeepSeek API error: ${response.status}`)
    }

    const data = await response.json()
    return data.choices[0].message.content
  }

  // Handle STOP command by calling OpenHands API
  private async handleStopCommand(conversation_id: string, context: string, message: string): Promise<void> {
    console.log(`Stopping conversation ${conversation_id}: ${context} - ${message}`)
    
    // Call OpenHands stop endpoint
    await fetch(`${this.openhandsApiUrl}/conversations/${conversation_id}/stop`, {
      method: 'POST',
      headers: {
        'X-Session-API-Key': this.openhandsApiKey,
        'Content-Type': 'application/json'
      }
    })

    // You could also add an event or notification here
  }

  // Get monitor status
  getMonitorStatus(conversation_id: string): ConversationMonitor | null {
    return this.monitors.get(conversation_id) || null
  }

  // Get all active monitors
  getAllMonitors(): ConversationMonitor[] {
    return Array.from(this.monitors.values())
  }
}