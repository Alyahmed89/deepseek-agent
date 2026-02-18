// OpenHands API service - pure, stateless wrapper
import { OPENHANDS_TIMEOUT, OPENHANDS_POLL_TIMEOUT, ENABLE_REQUEST_CACHING, CACHE_TTL } from '../constants';
import { OpenHandsCreateResult, OpenHandsStatusResult, OpenHandsInjectResult } from '../types';

// Simple in-memory cache for request optimization
interface CacheEntry {
  data: any;
  timestamp: number;
}

const openhandsCache = new Map<string, CacheEntry>();

/**
 * Get cache key for OpenHands conversation status
 */
function getCacheKey(apiUrl: string, conversationId: string): string {
  return `${apiUrl}:${conversationId}`;
}

/**
 * Get cached data if available and not expired
 */
function getFromCache(cacheKey: string): any | null {
  if (!ENABLE_REQUEST_CACHING) {
    return null;
  }
  
  const entry = openhandsCache.get(cacheKey);
  if (!entry) {
    return null;
  }
  
  const now = Date.now();
  if (now - entry.timestamp > CACHE_TTL) {
    openhandsCache.delete(cacheKey);
    return null;
  }
  
  return entry.data;
}

/**
 * Store data in cache
 */
function setInCache(cacheKey: string, data: any): void {
  if (!ENABLE_REQUEST_CACHING) {
    return;
  }
  
  openhandsCache.set(cacheKey, {
    data,
    timestamp: Date.now()
  });
  
  // Clean up old entries periodically (simple cleanup on set)
  if (openhandsCache.size > 1000) {
    const now = Date.now();
    for (const [key, entry] of openhandsCache.entries()) {
      if (now - entry.timestamp > CACHE_TTL * 10) { // 10x TTL for cleanup
        openhandsCache.delete(key);
      }
    }
  }
}

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

    // Add retry logic for create endpoint
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount <= maxRetries) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), OPENHANDS_TIMEOUT);

        const body: any = {
          initial_user_msg: initialMessage,
          repository: repository
        };

        if (branch) {
          body.selected_branch = branch;
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json'
        };
        
        
        const response = await fetch(createUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          // If 500/502 error and we have retries left, retry
          if ((response.status === 500 || response.status === 502) && retryCount < maxRetries) {
            retryCount++;
            const backoffMs = 500 * Math.pow(2, retryCount - 1); // 500ms, 1s, 2s (reduced from 2s, 4s, 8s)
            console.log(`OpenHands create ${response.status} error, retry ${retryCount}/${maxRetries}, waiting ${backoffMs}ms`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue;
          }
          
          const errorText = await response.text();
          throw new Error(`OpenHands create error: ${response.status} - ${errorText}`);
        }

        const data = await response.json() as any;
        const conversationId = data.conversation_id;

        return {
          success: true,
          conversationId
        };
      } catch (error) {
        if (retryCount >= maxRetries) {
          throw error;
        }
        retryCount++;
        const backoffMs = 500 * Math.pow(2, retryCount - 1); // 500ms, 1s, 2s (reduced from 2s, 4s, 8s)
        console.log(`OpenHands create fetch error, retry ${retryCount}/${maxRetries}, waiting ${backoffMs}ms: ${error}`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }

    // This should never be reached due to throw in catch block
    throw new Error('OpenHands create failed after all retries');

  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Unknown OpenHands create error'
    };
  }
}

/**
 * Get OpenHands conversation status and events
 * @param apiUrl OpenHands API base URL
 * @param conversationId Conversation ID to check
 * @param bypassCache Whether to bypass cache (default: false)
 * @returns OpenHandsStatusResult with events or error
 */
export async function getOpenHandsConversation(
  apiUrl: string,
  conversationId: string,
  bypassCache: boolean = false
): Promise<OpenHandsStatusResult> {
  try {
    // Check cache first (unless bypassCache is true)
    if (!bypassCache) {
      const cacheKey = getCacheKey(apiUrl, conversationId);
      const cachedData = getFromCache(cacheKey);
      
      if (cachedData) {
        console.log(`[CACHE HIT] OpenHands conversation ${conversationId}`);
        return {
          success: true,
          events: cachedData.events || []
        };
      }
    }
    
    // Get ALL events to properly track conversation state
    // Use ?reverse=true to get newest events first (better for checking current status)
    const eventsUrl = apiUrl.endsWith('/') 
      ? `${apiUrl}conversations/${conversationId}/events?reverse=true`
      : `${apiUrl}/conversations/${conversationId}/events?reverse=true`;

    // Add retry logic for events endpoint
    let retryCount = 0;
    const maxRetries = 3; // Increased from 2 to 3
    let eventsResponse: Response;
    
    while (retryCount <= maxRetries) {
      try {
        const controller = new AbortController();
        // Use shorter timeout for polling operations (bypassCache=true), longer for other operations
        const timeout = bypassCache ? OPENHANDS_POLL_TIMEOUT : OPENHANDS_TIMEOUT;
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const headers: Record<string, string> = {
          'Content-Type': 'application/json'
        };
        
        
        eventsResponse = await fetch(eventsUrl, {
          method: 'GET',
          headers,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!eventsResponse.ok) {
          // If 500/502 error and we have retries left, retry
          if ((eventsResponse.status === 500 || eventsResponse.status === 502) && retryCount < maxRetries) {
            retryCount++;
            const backoffMs = 500 * Math.pow(2, retryCount - 1); // 500ms, 1s, 2s (reduced from 2s, 4s, 8s)
            console.log(`OpenHands events ${eventsResponse.status} error, retry ${retryCount}/${maxRetries}, waiting ${backoffMs}ms`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue;
          }
          
          const errorText = await eventsResponse.text();
          throw new Error(`OpenHands events error: ${eventsResponse.status} - ${errorText}`);
        }
        
        // Success, break out of retry loop
        break;
      } catch (error) {
        if (retryCount >= maxRetries) {
          throw error;
        }
        retryCount++;
        const backoffMs = 500 * Math.pow(2, retryCount - 1); // 500ms, 1s, 2s (reduced from 2s, 4s, 8s)
        console.log(`OpenHands events fetch error, retry ${retryCount}/${maxRetries}, waiting ${backoffMs}ms: ${error}`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }

    const eventsData = await eventsResponse!.json() as any;
    
    // Cache the successful response
    setInCache(cacheKey, eventsData);
    
    return {
      success: true,
      events: eventsData?.events || []  // Return raw events
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
/**
 * Poll OpenHands for new assistant responses and automatically call webhook
 */
export async function pollAndProcessOpenHandsResponse(
  apiUrl: string,
  conversationId: string,
  webhookUrl: string,
  lastEventId?: number
): Promise<{ success: boolean; newEventId?: number; response?: string; error?: string }> {
  try {
    console.log(`[OPENHANDS_POLL] Polling conversation ${conversationId} for responses, lastEventId: ${lastEventId || 'none'}`);
    
    // Get events from OpenHands
    const eventsResult = await getOpenHandsConversation(apiUrl, conversationId, true);
    if (!eventsResult.success || !eventsResult.events) {
      return { success: false, error: eventsResult.error || 'Failed to get events' };
    }
    
    // Find new assistant responses (source: 'agent', action: 'message')
    const events = eventsResult.events;
    let latestEventId = lastEventId || -1;
    let assistantResponse = null;
    
    for (const event of events) {
      if (event.id > latestEventId) {
        latestEventId = event.id;
      }
      
      // Look for agent message responses that come after our last event
      if (event.id > (lastEventId || -1) && event.source === 'agent' && event.action === 'message') {
        console.log(`[OPENHANDS_POLL] Found new assistant response at event ${event.id}`);
        assistantResponse = event.args?.content || event.message || event.content;
        break;
      }
    }
    
    if (assistantResponse) {
      console.log(`[OPENHANDS_POLL] Sending response to webhook: ${webhookUrl}`);
      console.log(`[OPENHANDS_POLL] Response (${assistantResponse.length} chars): ${assistantResponse.substring(0, 100)}...`);
      
      // Call the webhook with the response
      try {
        const webhookResponse = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response: assistantResponse })
        });
        
        if (!webhookResponse.ok) {
          const errorText = await webhookResponse.text();
          console.error(`[OPENHANDS_POLL] Webhook call failed: ${webhookResponse.status} - ${errorText}`);
          return { 
            success: false, 
            newEventId: latestEventId,
            error: `Webhook failed: ${webhookResponse.status}` 
          };
        }
        
        console.log(`[OPENHANDS_POLL] Successfully sent response to webhook`);
        return { 
          success: true, 
          newEventId: latestEventId,
          response: assistantResponse 
        };
      } catch (webhookError: any) {
        console.error(`[OPENHANDS_POLL] Webhook fetch error: ${webhookError.message}`);
        return { 
          success: false, 
          newEventId: latestEventId,
          error: `Webhook fetch error: ${webhookError.message}` 
        };
      }
    } else {
      console.log(`[OPENHANDS_POLL] No new assistant responses found. Latest event ID: ${latestEventId}`);
      return { 
        success: true, 
        newEventId: latestEventId 
      };
    }
    
  } catch (error: any) {
    console.error(`[OPENHANDS_POLL] Error: ${error.message}`);
    return { 
      success: false, 
      error: error.message 
    };
  }
}

export async function injectMessageToOpenHands(
  apiUrl: string,
  conversationId: string,
  message: string,
  webhookUrl?: string
): Promise<OpenHandsInjectResult> {
  try {
    const injectUrl = apiUrl.endsWith('/') 
      ? `${apiUrl}conversations/${conversationId}/events`
      : `${apiUrl}/conversations/${conversationId}/events`;

    // Add retry logic for inject endpoint
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount <= maxRetries) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), OPENHANDS_TIMEOUT);

        const headers: Record<string, string> = {
          'Content-Type': 'application/json'
        };
        
        
        // If webhookUrl is provided, include it in args so OpenHands can call back
        const args: any = {
          content: message,
          wait_for_response: false,
          file_urls: null,
          image_urls: []
        };
        
        if (webhookUrl) {
          args.webhook_url = webhookUrl;
          args.auto_respond = true;
        }
        
        const response = await fetch(injectUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            source: 'user',
            action: 'message',
            message: message,
            args: args
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          // If 500/502 error and we have retries left, retry
          if ((response.status === 500 || response.status === 502) && retryCount < maxRetries) {
            retryCount++;
            const backoffMs = 500 * Math.pow(2, retryCount - 1); // 500ms, 1s, 2s (reduced from 2s, 4s, 8s)
            console.log(`OpenHands inject ${response.status} error, retry ${retryCount}/${maxRetries}, waiting ${backoffMs}ms`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue;
          }
          
          const errorText = await response.text();
          throw new Error(`OpenHands inject error: ${response.status} - ${errorText}`);
        }

        // Invalidate cache for this conversation since we just changed its state
        const cacheKey = getCacheKey(apiUrl, conversationId);
        openhandsCache.delete(cacheKey);
        
        return {
          success: true
        };
      } catch (error) {
        if (retryCount >= maxRetries) {
          throw error;
        }
        retryCount++;
        const backoffMs = 500 * Math.pow(2, retryCount - 1); // 500ms, 1s, 2s (reduced from 2s, 4s, 8s)
        console.log(`OpenHands inject fetch error, retry ${retryCount}/${maxRetries}, waiting ${backoffMs}ms: ${error}`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }

    // This should never be reached due to throw in catch block
    throw new Error('OpenHands inject failed after all retries');

  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Unknown OpenHands inject error'
    };
  }
}