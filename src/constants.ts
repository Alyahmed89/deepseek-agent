// Constants for DeepSeek Agent
export const MAX_ITERATIONS = 500;
export const END_FLOW_TOKEN = '[END_FLOW]';
export const END_FLOW_EARLY_TOKEN = '[END_FLOW_EARLY]';
export const ALARM_DELAY_INIT = 30000; // 30 seconds for initial alarm - Cloudflare reliable minimum
export const ALARM_DELAY_WAITING = 30000; // 30 seconds between checks - Cloudflare reliable minimum
export const ALARM_DELAY_ACTIVE = 30000; // 30 seconds when expecting response - Cloudflare reliable minimum
export const DEEPSEEK_TIMEOUT = 10000; // 10 seconds for DeepSeek API
export const OPENHANDS_TIMEOUT = 180000; // 3 minutes for long operations
export const OPENHANDS_POLL_TIMEOUT = 10000; // 10 seconds for polling operations (much shorter)
export const NO_EVENT_TIMEOUT = 120000; // 2 minutes without new events (increased from 1 minute)

// Aggressive mode constants (for forced conversation management)
export const AGGRESSIVE_MODE = true; // Enable aggressive mode
export const AGGRESSIVE_NO_EVENT_TIMEOUT = 300000; // 5 minutes without new events
export const AGGRESSIVE_OPENHANDS_TIMEOUT = 600000; // 10 minutes for long operations
export const STATIC_PROMPT_MODE = false; // Use static prompts instead of DeepSeek
export const FORCE_END_FLOW_AFTER_TIMEOUT = true; // Force end flow after timeout
export const AUTO_RESTART_CONVERSATION = true; // Auto-restart conversations
export const RESTART_DELAY = 10000; // 10 seconds between restarts
export const MAX_RESTARTS = 10; // Maximum number of auto-restarts

// Static prompts for aggressive mode
export const STATIC_PROMPTS = [
  "Please analyze the repository and provide a summary of the codebase structure.",
  "Identify any critical issues or security vulnerabilities in the code.",
  "Suggest improvements for code quality and performance.",
  "Create a deployment plan for the application.",
  "Generate documentation for the main components."
];

// Force end flow message
export const FORCE_END_FLOW_MESSAGE = '[END_FLOW] prompt: Please continue with the next task. deepseek_system: You are an AI assistant analyzing code repositories. branch: main';

// DeepSeek response timeout and checking prompt
export const DEEPSEEK_RESPONSE_TIMEOUT = 120000; // 2 minutes max for DeepSeek response
export const CHECKING_PROMPT = "Checking in: Are you still processing? Please provide a status update or continue with the analysis.";

// Adaptive polling optimization
export const ADAPTIVE_POLLING_ENABLED = true;
export const MIN_POLL_INTERVAL = 30000; // 30 seconds minimum - Cloudflare reliable minimum
export const MAX_POLL_INTERVAL = 120000; // 120 seconds maximum - More conservative
export const POLL_INTERVAL_INCREMENT = 30000; // 30 seconds increase each time
export const POLL_INTERVAL_RESET = 30000; // 30 seconds reset on activity

// Request optimization
export const ENABLE_REQUEST_CACHING = true;
export const CACHE_TTL = 60000; // 60 seconds cache TTL (6x increase from 10s)
export const MAX_CONCURRENT_CONVERSATIONS = 20; // Limit concurrent conversations (reduced from 50)

// Durable Object lifecycle optimization
export const MAX_DO_LIFETIME = 7200000; // 2 hours maximum lifetime (2x increase from 1 hour)
export const IDLE_TIMEOUT = 3600000; // 1 hour idle timeout (2x increase from 30 minutes)
export const COMPLETED_CLEANUP_DELAY = 600000; // 10 minutes delay before cleaning up completed conversations (2x increase from 5 minutes)