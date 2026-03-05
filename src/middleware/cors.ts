// CORS middleware for Hono
import { Context, Next } from 'hono';

export const corsMiddleware = async (c: Context, next: Next) => {
  // Set CORS headers
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  c.header('Access-Control-Max-Age', '86400');
  
  // Handle preflight requests
  if (c.req.method === 'OPTIONS') {
    return c.text('', 204);
  }
  
  await next();
};