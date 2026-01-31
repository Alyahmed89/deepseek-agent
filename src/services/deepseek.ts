// DeepSeek API service - pure, stateless wrapper
import { DEEPSEEK_TIMEOUT, STOP_TOKEN } from '../constants';
import { DeepSeekResult } from '../types';

/**
 * Call DeepSeek API with a prompt
 * @param apiKey DeepSeek API key
 * @param prompt The prompt to send
 * @param context Additional context (repository, iteration, etc.)
 * @returns DeepSeekResult with response or error
 */
export async function callDeepSeek(
  apiKey: string,
  prompt: string,
  context: {
    repository: string;
    branch?: string;
    iteration: number;
    max_iterations: number;
  }
): Promise<DeepSeekResult> {
  try {
    const deepseekPrompt = `You are DeepSeek, an AI assistant working with OpenHands.
    
Repository: ${context.repository}${context.branch ? ` (branch: ${context.branch})` : ''}
Iteration: ${context.iteration + 1} of ${context.max_iterations}

IMPORTANT: If you're done with the task, include ${STOP_TOKEN} in your response. 
Otherwise, provide clear instructions for OpenHands.

${prompt}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEEPSEEK_TIMEOUT);

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: deepseekPrompt }],
        temperature: 0.7,
        max_tokens: 2000
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const result = data.choices[0].message.content;

    return {
      success: true,
      response: result
    };

  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Unknown DeepSeek API error'
    };
  }
}