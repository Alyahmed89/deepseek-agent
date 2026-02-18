/**
 * OpenHands Response Keyword Parser for ETAFlow
 * 
 * This service parses OpenHands responses to detect specific keywords
 * that determine the next step in the ETAFlow workflow.
 * 
 * Database: Cloudflare D1 (PROJECT_FACTS_DB)
 * Table: flow_step_conditions
 */

export interface FlowStepCondition {
  id: string;
  flow_step_id: string;
  condition_type: string;
  condition_value: string;
  condition_operator: string;
  next_step: number;
  created_at: number;
  updated_at: number;
}

export interface ParsingResult {
  flow_step_id: string;
  response_text: string;
  conditions_checked: Array<{
    condition_type: string;
    condition_value: string;
    condition_operator: string;
    next_step: number;
    is_met: boolean;
  }>;
  matched_condition: FlowStepCondition | null;
  next_step: number | null;
  default_next_step_used: boolean;
  error?: string;
}

export class OpenHandsKeywordParser {
  private conditionsCache: Map<string, FlowStepCondition[]> = new Map();
  
  constructor(
    private db: D1Database,
    private flowId: string = 'etaflow'
  ) {}
  
  /**
   * Get all conditions for a specific flow step
   */
  async getConditionsForStep(flowStepId: string): Promise<FlowStepCondition[]> {
    // Check cache first
    if (this.conditionsCache.has(flowStepId)) {
      return this.conditionsCache.get(flowStepId)!;
    }
    
    try {
      const query = `
        SELECT * FROM flow_step_conditions 
        WHERE flow_step_id = ? 
        ORDER BY created_at
      `;
      
      const result = await this.db.prepare(query).bind(flowStepId).all();
      const conditions = result.results as unknown as FlowStepCondition[];
      
      // Cache the results
      this.conditionsCache.set(flowStepId, conditions);
      
      return conditions;
    } catch (error) {
      console.error(`[KEYWORD_PARSER] Error getting conditions for step ${flowStepId}:`, error);
      return [];
    }
  }
  
  /**
   * Evaluate if a condition is met based on response text
   */
  evaluateCondition(condition: FlowStepCondition, responseText: string): boolean {
    const responseLower = responseText.toLowerCase();
    const valueLower = condition.condition_value.toLowerCase();
    
    switch (condition.condition_type) {
      case 'response_contains':
        switch (condition.condition_operator) {
          case 'contains':
            return responseLower.includes(valueLower);
          case 'equals':
            return responseLower === valueLower;
          case 'starts_with':
            return responseLower.startsWith(valueLower);
          case 'ends_with':
            return responseLower.endsWith(valueLower);
          default:
            // Default to contains
            return responseLower.includes(valueLower);
        }
      
      case 'response_matches':
        // Simple exact match (case-insensitive)
        return responseLower === valueLower;
      
      case 'response_starts_with':
        return responseLower.startsWith(valueLower);
      
      case 'response_ends_with':
        return responseLower.endsWith(valueLower);
      
      default:
        console.warn(`[KEYWORD_PARSER] Unknown condition type: ${condition.condition_type}`);
        return false;
    }
  }
  
  /**
   * Parse an OpenHands response and determine the next step
   */
  async parseResponse(
    flowStepId: string, 
    responseText: string
  ): Promise<ParsingResult> {
    const result: ParsingResult = {
      flow_step_id: flowStepId,
      response_text: responseText,
      conditions_checked: [],
      matched_condition: null,
      next_step: null,
      default_next_step_used: false
    };
    
    try {
      // Get conditions for this step
      const conditions = await this.getConditionsForStep(flowStepId);
      
      // Check each condition
      for (const condition of conditions) {
        const isMet = this.evaluateCondition(condition, responseText);
        
        result.conditions_checked.push({
          condition_type: condition.condition_type,
          condition_value: condition.condition_value,
          condition_operator: condition.condition_operator,
          next_step: condition.next_step,
          is_met: isMet
        });
        
        // First matching condition determines next step
        if (isMet && result.matched_condition === null) {
          result.matched_condition = condition;
          result.next_step = condition.next_step;
        }
      }
      
      // If no condition matched, check for default next step
      if (result.next_step === null) {
        const defaultStep = await this.getDefaultNextStep(flowStepId);
        if (defaultStep !== null) {
          result.next_step = defaultStep;
          result.default_next_step_used = true;
        }
      }
      
    } catch (error: any) {
      result.error = error.message;
      console.error(`[KEYWORD_PARSER] Error parsing response:`, error);
    }
    
    return result;
  }
  
  /**
   * Get default next step from flow_steps table
   */
  async getDefaultNextStep(flowStepId: string): Promise<number | null> {
    try {
      const query = `
        SELECT default_next_step 
        FROM flow_steps 
        WHERE id = ? AND flow_id = ?
      `;
      
      const result = await this.db.prepare(query).bind(flowStepId, this.flowId).first();
      
      if (result && result.default_next_step !== null) {
        return result.default_next_step as number;
      }
      
      return null;
    } catch (error) {
      console.error(`[KEYWORD_PARSER] Error getting default next step:`, error);
      return null;
    }
  }
  
  /**
   * Get all conditions for the entire flow (for debugging/display)
   */
  async getAllConditions(): Promise<FlowStepCondition[]> {
    try {
      // First get all step IDs for this flow
      const stepQuery = `
        SELECT id FROM flow_steps WHERE flow_id = ?
      `;
      
      const stepResult = await this.db.prepare(stepQuery).bind(this.flowId).all();
      const stepIds = stepResult.results.map((row: any) => row.id);
      
      if (stepIds.length === 0) {
        return [];
      }
      
      // Get conditions for all steps
      const placeholders = stepIds.map(() => '?').join(',');
      const conditionsQuery = `
        SELECT * FROM flow_step_conditions 
        WHERE flow_step_id IN (${placeholders})
        ORDER BY flow_step_id, next_step
      `;
      
      const conditionsResult = await this.db.prepare(conditionsQuery).bind(...stepIds).all();
      return conditionsResult.results as unknown as FlowStepCondition[];
      
    } catch (error) {
      console.error(`[KEYWORD_PARSER] Error getting all conditions:`, error);
      return [];
    }
  }
  
  /**
   * Clear the conditions cache
   */
  clearCache(): void {
    this.conditionsCache.clear();
  }
}

/**
 * Example usage in a Cloudflare Worker:
 * 
 * ```typescript
 * // In your Worker
 * import { OpenHandsKeywordParser } from './services/openhands_keyword_parser';
 * 
 * export default {
 *   async fetch(request, env) {
 *     const parser = new OpenHandsKeywordParser(env.PROJECT_FACTS_DB);
 *     
 *     // Parse a response
 *     const result = await parser.parseResponse(
 *       'step1',
 *       'Status: Success - Deployment completed successfully'
 *     );
 *     
 *     if (result.next_step) {
 *       // Proceed to next step
 *       return new Response(JSON.stringify({
 *         next_step: result.next_step,
 *         action: `Proceed to step${result.next_step}`
 *       }));
 *     }
 *     
 *     return new Response(JSON.stringify({
 *       action: 'Wait for more information'
 *     }));
 *   }
 * }
 * ```
 */