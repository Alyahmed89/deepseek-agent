// Data extraction service for OpenHands responses
// Flexible extraction system that adapts to any project, API, payload structure, and retrieval filters

import { OpenHandsEvent } from '../types';

// Types for extracted data
export interface ExtractedDataItem {
  key: string;
  value: any; // Flexible value that can be any structure
  dataType: string;
  source: 'openhands_response' | 'deepseek_response' | 'event' | 'manual';
  tags?: string[];
  priority?: number;
  confidence?: number;
  metadata?: Record<string, any>;
}

export interface ExtractionRule {
  id: string;
  name: string;
  description?: string;
  matchPattern: (event: OpenHandsEvent) => boolean;
  extractData: (event: OpenHandsEvent) => ExtractedDataItem | ExtractedDataItem[] | null;
  priority?: number;
}

export interface ExtractionContext {
  projectId: string;
  repository: string;
  branch?: string;
  conversationId?: string;
  flowRunId?: string;
  iterationNumber?: number;
}

// Default extraction rules
const defaultExtractionRules: ExtractionRule[] = [
  // Rule 1: Extract tasks from action events
  {
    id: 'extract_tasks_from_actions',
    name: 'Extract Tasks from Actions',
    description: 'Extract task information from OpenHands action events',
    matchPattern: (event: OpenHandsEvent) => 
      !!(event.action && 
      event.action !== 'agent_state_changed' && 
      event.action !== 'message' &&
      !event.observation),
    extractData: (event: OpenHandsEvent): ExtractedDataItem => {
      const taskDescription = event.message || event.content || `Action: ${event.action}`;
      return {
        key: 'task',
        value: {
          action: event.action,
          description: taskDescription,
          tool_call_id: event.args?.tool_call_id,
          timestamp: event.timestamp,
          args: event.args
        },
        dataType: 'task',
        source: 'event',
        tags: ['action', event.action],
        priority: 5,
        confidence: 0.9
      };
    },
    priority: 10
  },

  // Rule 2: Extract errors from observation events
  {
    id: 'extract_errors_from_observations',
    name: 'Extract Errors from Observations',
    description: 'Extract error information from OpenHands observation events',
    matchPattern: (event: OpenHandsEvent) => 
      !!(event.observation === 'error' || 
      (event.message && event.message.toLowerCase().includes('error')) ||
      (event.content && event.content.toLowerCase().includes('error'))),
    extractData: (event: OpenHandsEvent): ExtractedDataItem => {
      const errorMessage = event.message || event.content || `Error in ${event.action}`;
      return {
        key: 'error',
        value: {
          type: event.observation || 'unknown',
          message: errorMessage,
          action: event.action,
          timestamp: event.timestamp,
          context: event.args
        },
        dataType: 'error',
        source: 'event',
        tags: ['error', event.observation || 'unknown'],
        priority: 8, // High priority for errors
        confidence: 0.85
      };
    },
    priority: 9
  },

  // Rule 3: Extract test-related information
  {
    id: 'extract_test_info',
    name: 'Extract Test Information',
    description: 'Extract test-related information from events',
    matchPattern: (event: OpenHandsEvent) => {
      const content = (event.message || event.content || '').toLowerCase();
      return content.includes('test') || 
             content.includes('check') || 
             content.includes('verify') ||
             event.action === 'run_tests' ||
             event.observation === 'test_completed';
    },
    extractData: (event: OpenHandsEvent): ExtractedDataItem => {
      return {
        key: 'test_checklist',
        value: {
          description: event.message || event.content || `Test: ${event.action}`,
          type: event.observation || event.action,
          timestamp: event.timestamp,
          status: event.observation === 'test_completed' ? 'completed' : 'pending'
        },
        dataType: 'test_checklist',
        source: 'event',
        tags: ['test', 'validation'],
        priority: 6,
        confidence: 0.8
      };
    },
    priority: 7
  },

  // Rule 4: Extract code snippets
  {
    id: 'extract_code_snippets',
    name: 'Extract Code Snippets',
    description: 'Extract code snippets from events',
    matchPattern: (event: OpenHandsEvent) => {
      const content = event.message || event.content || '';
      // Look for code blocks or file operations
      return content.includes('```') || 
             event.action === 'edit_file' ||
             event.action === 'create_file' ||
             event.action === 'read_file';
    },
    extractData: (event: OpenHandsEvent): ExtractedDataItem | null => {
      const content = event.message || event.content || '';
      
      // Try to extract code from code blocks
      const codeBlockRegex = /```(?:\w+)?\n([\s\S]*?)\n```/g;
      const matches = [...content.matchAll(codeBlockRegex)];
      
      if (matches.length > 0) {
        return {
          key: 'code_snippet',
          value: {
            code: matches[0][1],
            language: content.match(/```(\w+)?/)?.[1] || 'unknown',
            source: event.action,
            timestamp: event.timestamp,
            context: event.args
          },
          dataType: 'code_snippet',
          source: 'event',
          tags: ['code', 'snippet'],
          priority: 4,
          confidence: 0.95
        };
      }
      
      // For file operations, extract file content from args
      if (event.args?.content) {
        return {
          key: 'code_snippet',
          value: {
            code: event.args.content,
            language: 'file_content',
            source: event.action,
            timestamp: event.timestamp,
            filename: event.args.filename || event.args.path || 'unknown'
          },
          dataType: 'code_snippet',
          source: 'event',
          tags: ['code', 'file'],
          priority: 4,
          confidence: 0.9
        };
      }
      
      return null;
    },
    priority: 5
  },

  // Rule 5: Extract configuration information
  {
    id: 'extract_configuration',
    name: 'Extract Configuration',
    description: 'Extract configuration and setup information',
    matchPattern: (event: OpenHandsEvent) => {
      const content = (event.message || event.content || '').toLowerCase();
      return content.includes('config') || 
             content.includes('setup') || 
             content.includes('install') ||
             content.includes('dependency');
    },
    extractData: (event: OpenHandsEvent): ExtractedDataItem => {
      return {
        key: 'configuration',
        value: {
          description: event.message || event.content || `Config: ${event.action}`,
          type: 'configuration',
          timestamp: event.timestamp,
          details: event.args
        },
        dataType: 'configuration',
        source: 'event',
        tags: ['config', 'setup'],
        priority: 3,
        confidence: 0.75
      };
    },
    priority: 4
  }
];

/**
 * Data extraction service
 */
export class DataExtractionService {
  private extractionRules: ExtractionRule[];
  
  constructor(customRules: ExtractionRule[] = []) {
    // Combine default rules with custom rules
    // Custom rules override default rules with same ID
    const ruleMap = new Map<string, ExtractionRule>();
    
    // Add default rules
    defaultExtractionRules.forEach(rule => ruleMap.set(rule.id, rule));
    
    // Add/override with custom rules
    customRules.forEach(rule => ruleMap.set(rule.id, rule));
    
    // Sort by priority (higher priority first)
    this.extractionRules = Array.from(ruleMap.values())
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }
  
  /**
   * Extract data from OpenHands events
   */
  extractFromEvents(
    events: OpenHandsEvent[], 
    context: ExtractionContext
  ): ExtractedDataItem[] {
    const extractedItems: ExtractedDataItem[] = [];
    
    for (const event of events) {
      for (const rule of this.extractionRules) {
        if (rule.matchPattern(event)) {
          try {
            const result = rule.extractData(event);
            
            if (result) {
              if (Array.isArray(result)) {
                // Add context to each item
                result.forEach(item => {
                  extractedItems.push(this.addContextToItem(item, context, event));
                });
              } else {
                extractedItems.push(this.addContextToItem(result, context, event));
              }
              
              // Break after first matching rule (unless we want multiple extractions per event)
              break;
            }
          } catch (error) {
            console.error(`Error applying extraction rule ${rule.id}:`, error);
          }
        }
      }
    }
    
    return extractedItems;
  }
  
  /**
   * Extract data from raw text (for DeepSeek responses, etc.)
   */
  extractFromText(
    text: string,
    sourceType: 'deepseek_response' | 'openhands_response' | 'manual',
    context: ExtractionContext
  ): ExtractedDataItem[] {
    const extractedItems: ExtractedDataItem[] = [];
    
    // Simple pattern-based extraction from text
    const patterns = [
      {
        regex: /task:\s*(.+?)(?=\n|$)/gi,
        key: 'task',
        dataType: 'task',
        tags: ['text_extraction']
      },
      {
        regex: /error:\s*(.+?)(?=\n|$)/gi,
        key: 'error',
        dataType: 'error',
        tags: ['text_extraction']
      },
      {
        regex: /test:\s*(.+?)(?=\n|$)/gi,
        key: 'test_checklist',
        dataType: 'test_checklist',
        tags: ['text_extraction']
      },
      {
        regex: /TODO:\s*(.+?)(?=\n|$)/gi,
        key: 'task',
        dataType: 'task',
        tags: ['todo', 'text_extraction']
      },
      {
        regex: /FIXME:\s*(.+?)(?=\n|$)/gi,
        key: 'error',
        dataType: 'error',
        tags: ['fixme', 'text_extraction']
      }
    ];
    
    for (const pattern of patterns) {
      const matches = [...text.matchAll(pattern.regex)];
      for (const match of matches) {
        extractedItems.push({
          key: pattern.key,
          value: {
            description: match[1].trim(),
            extracted_from: 'text_pattern',
            pattern: pattern.regex.source
          },
          dataType: pattern.dataType,
          source: sourceType,
          tags: pattern.tags,
          priority: 2,
          confidence: 0.6,
          metadata: {
            match: match[0],
            context: context
          }
        });
      }
    }
    
    return extractedItems;
  }
  
  /**
   * Add context to extracted data item
   */
  private addContextToItem(
    item: ExtractedDataItem, 
    context: ExtractionContext,
    event?: OpenHandsEvent
  ): ExtractedDataItem {
    return {
      ...item,
      metadata: {
        ...item.metadata,
        extraction_context: {
          projectId: context.projectId,
          repository: context.repository,
          branch: context.branch,
          conversationId: context.conversationId,
          flowRunId: context.flowRunId,
          iterationNumber: context.iterationNumber,
          eventId: event?.id,
          eventTimestamp: event?.timestamp,
          eventAction: event?.action,
          eventObservation: event?.observation
        }
      }
    };
  }
  
  /**
   * Get extraction rules (for inspection or modification)
   */
  getExtractionRules(): ExtractionRule[] {
    return [...this.extractionRules];
  }
  
  /**
   * Add or update an extraction rule
   */
  addExtractionRule(rule: ExtractionRule): void {
    const existingIndex = this.extractionRules.findIndex(r => r.id === rule.id);
    
    if (existingIndex >= 0) {
      this.extractionRules[existingIndex] = rule;
    } else {
      this.extractionRules.push(rule);
    }
    
    // Re-sort by priority
    this.extractionRules.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }
  
  /**
   * Remove an extraction rule
   */
  removeExtractionRule(ruleId: string): boolean {
    const initialLength = this.extractionRules.length;
    this.extractionRules = this.extractionRules.filter(rule => rule.id !== ruleId);
    return this.extractionRules.length < initialLength;
  }
  
  /**
   * Create a custom extraction rule from a template
   */
  createCustomRule(
    id: string,
    name: string,
    matchPattern: string | RegExp | ((event: OpenHandsEvent) => boolean),
    extractTemplate: Record<string, any>,
    options: {
      description?: string;
      dataType?: string;
      key?: string;
      priority?: number;
      tags?: string[];
    } = {}
  ): ExtractionRule {
    let matchPatternFn: (event: OpenHandsEvent) => boolean;
    
    if (typeof matchPattern === 'string') {
      // String pattern - check if event content contains the string
      const patternStr = matchPattern.toLowerCase();
      matchPatternFn = (event: OpenHandsEvent) => {
        const content = (event.message || event.content || '').toLowerCase();
        return content.includes(patternStr);
      };
    } else if (matchPattern instanceof RegExp) {
      // Regex pattern
      matchPatternFn = (event: OpenHandsEvent) => {
        const content = event.message || event.content || '';
        return matchPattern.test(content);
      };
    } else {
      // Function pattern
      matchPatternFn = matchPattern;
    }
    
    const extractDataFn = (event: OpenHandsEvent): ExtractedDataItem => {
      // Apply template with event data
      const value = this.applyTemplate(extractTemplate, event);
      
      return {
        key: options.key || 'custom',
        value,
        dataType: options.dataType || 'custom',
        source: 'event',
        tags: options.tags || ['custom'],
        priority: options.priority || 1,
        confidence: 0.7,
        metadata: {
          rule_id: id,
          template_applied: true
        }
      };
    };
    
    return {
      id,
      name,
      description: options.description,
      matchPattern: matchPatternFn,
      extractData: extractDataFn,
      priority: options.priority || 1
    };
  }
  
  /**
   * Apply template to event data
   */
  private applyTemplate(template: Record<string, any>, event: OpenHandsEvent): any {
    const result: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(template)) {
      if (typeof value === 'string' && value.startsWith('$event.')) {
        // Template variable - extract from event
        const path = value.substring(7); // Remove "$event."
        result[key] = this.getNestedValue(event, path);
      } else if (typeof value === 'object' && value !== null) {
        // Recursive template
        result[key] = this.applyTemplate(value, event);
      } else {
        // Static value
        result[key] = value;
      }
    }
    
    return result;
  }
  
  /**
   * Get nested value from object using dot notation
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : null;
    }, obj);
  }
}

// Singleton instance for convenience
let defaultInstance: DataExtractionService | null = null;

export function getDefaultDataExtractionService(): DataExtractionService {
  if (!defaultInstance) {
    defaultInstance = new DataExtractionService();
  }
  return defaultInstance;
}