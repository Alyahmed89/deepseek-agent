// OpenHands API service - pure, stateless wrapper
import { OPENHANDS_TIMEOUT } from '../constants';
import { OpenHandsCreateResult, OpenHandsStatusResult, OpenHandsInjectResult } from '../types';

/**
 * Create a new OpenHands conversation
 * @param apiUrl OpenHands API base URL
 * @param initialMessage Initial message to seed the conversation
 * @param repository Repository to work on
 * @param branch Optional branch
 * @returns OpenHandsCreateResult with conversation ID or error
 */
export async function createOpenHandsConversation(
  apiUrl: string,
  initialMessage: string,
  repository: string,
  branch?: string
): Promise<OpenHandsCreateResult> {
  try {
    const createUrl = apiUrl.endsWith('/') 
      ? `${apiUrl}conversations`
      : `${apiUrl}/conversations`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPENHANDS_TIMEOUT);

    const body: any = {
      initial_user_msg: initialMessage,
      repository: repository
    };

    if (branch) {
      body.selected_branch = branch;
    }

    const response = await fetch(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenHands create error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as any;
    const conversationId = data.conversation_id;

    return {
      success: true,
      conversationId
    };

  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Unknown OpenHands create error'
    };
  }
}

/**
 * Get OpenHands conversation status
 * @param apiUrl OpenHands API base URL
 * @param conversationId Conversation ID to check
 * @returns OpenHandsStatusResult with agent state and messages or error
 */
export async function getOpenHandsConversation(
  apiUrl: string,
  conversationId: string
): Promise<OpenHandsStatusResult> {
  try {
    const statusUrl = apiUrl.endsWith('/') 
      ? `${apiUrl}conversations/${conversationId}`
      : `${apiUrl}/conversations/${conversationId}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPENHANDS_TIMEOUT);

    const response = await fetch(statusUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenHands status error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as any;

    return {
      success: true,
      agent_state: data.agent_state,
      messages: data.messages
    };

  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Unknown OpenHands status error'
    };
  }
}

/**
 * Inject a message into an OpenHands conversation
 * @param apiUrl OpenHands API base URL
 * @param conversationId Conversation ID
 * @param message Message to inject
 * @returns OpenHandsInjectResult with success or error
 */
export async function injectMessageToOpenHands(
  apiUrl: string,
  conversationId: string,
  message: string
): Promise<OpenHandsInjectResult> {
  try {
    const injectUrl = apiUrl.endsWith('/') 
      ? `${apiUrl}conversations/${conversationId}/messages`
      : `${apiUrl}/conversations/${conversationId}/messages`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPENHANDS_TIMEOUT);

    const response = await fetch(injectUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenHands inject error: ${response.status} - ${errorText}`);
    }

    return {
      success: true
    };

  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Unknown OpenHands inject error'
    };
  }
}