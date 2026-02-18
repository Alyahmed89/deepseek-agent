// Parsing utilities for DeepSeek Agent
import { END_FLOW_TOKEN, END_FLOW_EARLY_TOKEN } from '../constants';
import { DoneResponseData } from '../types';

/**
 * Parse a DeepSeek response to check for [END_FLOW] or [END_FLOW_EARLY]
 * @param response The DeepSeek response string
 * @returns DoneResponseData with parsed information
 */
export function parseDoneResponse(response: string): DoneResponseData {
  // Check which token is present
  const hasEndFlow = response.includes(END_FLOW_TOKEN);
  const hasEndFlowEarly = response.includes(END_FLOW_EARLY_TOKEN);
  
  if (!hasEndFlow && !hasEndFlowEarly) {
    return { done: false };
  }

  // Determine which token was found
  const isEndFlowEarly = hasEndFlowEarly;
  
  // Try to parse the new flow information from the response
  // Expected format: [END_FLOW] prompt: xxx deepseek_system: xxx branch: xxx
  // For [END_FLOW_EARLY]: [END_FLOW_EARLY] reason: xxx
  const lines = response.split('\n');
  let nextPrompt = '';
  let nextDeepseekSystem = '';
  let nextBranch = '';
  let stopReason = '';
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    if (trimmed.startsWith('prompt:')) {
      nextPrompt = trimmed.substring('prompt:'.length).trim();
    } else if (trimmed.startsWith('deepseek_system:')) {
      nextDeepseekSystem = trimmed.substring('deepseek_system:'.length).trim();
    } else if (trimmed.startsWith('branch:')) {
      nextBranch = trimmed.substring('branch:'.length).trim();
    } else if (trimmed.startsWith('reason:')) {
      stopReason = trimmed.substring('reason:'.length).trim();
    }
  }

  // For END_FLOW_EARLY, always stop without starting new flow
  if (isEndFlowEarly) {
    return {
      done: true,
      is_end_flow_early: true,
      stop_reason: stopReason || 'end_flow_early_no_reason'
    };
  }

  // For END_FLOW with next prompt, start new flow
  if (nextPrompt) {
    return {
      done: true,
      new_prompt: nextPrompt,
      new_deepseek_system: nextDeepseekSystem || undefined,
      new_branch: nextBranch || undefined
    };
  }

  // When [END_FLOW] is found without next flow info, just end the flow
  return { done: true };
}

/**
 * Extract conversation history for storage
 * @param conversation_messages Array of conversation messages
 * @returns JSON string of prompts and responses
 */
export function extractPromptsAndResponses(conversation_messages: Array<{role: string; content: string}>): string {
  const history = [];
  
  for (let i = 0; i < conversation_messages.length; i++) {
    const message = conversation_messages[i];
    history.push({
      role: message.role,
      content: message.content,
      timestamp: Date.now() - (conversation_messages.length - i) * 1000 // Simulate timestamps
    });
  }
  
  return JSON.stringify(history);
}