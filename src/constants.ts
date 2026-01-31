// Constants for DeepSeek Agent
export const MAX_ITERATIONS = 10;
export const STOP_TOKEN = '<<DONE>>';
export const ALARM_DELAY_INIT = 1000; // 1 second for initial alarm
export const ALARM_DELAY_WAITING = 5000; // 5 seconds between checks
export const DEEPSEEK_TIMEOUT = 30000; // 30 seconds
export const OPENHANDS_TIMEOUT = 30000; // 30 seconds (increased from 10s due to large event responses)

// Cooldown constants for event processing
export const EVENT_COOLDOWN_MS = 120000; // Wait 2 minutes (120 seconds) with no new events before processing
export const MAX_COOLDOWN_WAIT_MS = 300000; // Maximum 5 minutes (300 seconds) to wait even if events keep coming
export const ACTIVE_CHECK_INTERVAL = 10000; // Check every 10 seconds during cooldown period