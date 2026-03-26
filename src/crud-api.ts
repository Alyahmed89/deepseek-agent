// Simplified CRUD API for Cloudflare D1 database
import { Hono } from 'hono';
import { CloudflareBindings } from './types';

// Create CRUD API router
export const crudApi = new Hono<{ Bindings: CloudflareBindings }>();

// Get flow definitions
crudApi.get('/flow-definitions', async (c) => {
  try {
    const db = c.env.FLOW_RUNS_DB;
    const result = await db.prepare(`
      SELECT id, name, description, created_at
      FROM flow_definitions
      ORDER BY created_at DESC
    `).all();
    
    return c.json({
      success: true,
      data: result.results
    });
  } catch (error: any) {
    console.error('Error getting flow definitions:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Get flow steps
crudApi.get('/flow-steps/:flow_id', async (c) => {
  try {
    const flowId = c.req.param('flow_id');
    const db = c.env.FLOW_RUNS_DB;
    
    const result = await db.prepare(`
      SELECT id, flow_id, step_id, title, description, instructions, agent, created_at
      FROM flow_steps
      WHERE flow_id = ?
      ORDER BY step_id ASC
    `).bind(flowId).all();
    
    return c.json({
      success: true,
      data: result.results
    });
  } catch (error: any) {
    console.error('Error getting flow steps:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Get flow runs
crudApi.get('/flow-runs', async (c) => {
  try {
    const db = c.env.FLOW_RUNS_DB;
    const result = await db.prepare(`
      SELECT id, flow_id, conversation_id, status, started_at, completed_at, created_at
      FROM flow_runs
      ORDER BY created_at DESC
      LIMIT 50
    `).all();
    
    return c.json({
      success: true,
      data: result.results
    });
  } catch (error: any) {
    console.error('Error getting flow runs:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Get API logs for a flow run
crudApi.get('/api-logs/:flow_run_id', async (c) => {
  try {
    const flowRunId = c.req.param('flow_run_id');
    const db = c.env.FLOW_RUNS_DB;
    
    const result = await db.prepare(`
      SELECT id, flow_run_id, step_id, type, request, response, status_code, duration_ms, created_at
      FROM api_logs
      WHERE flow_run_id = ?
      ORDER BY created_at ASC
    `).bind(flowRunId).all();
    
    return c.json({
      success: true,
      data: result.results.map((row: any) => ({
        ...row,
        request: row.request ? JSON.parse(row.request) : null,
        response: row.response ? JSON.parse(row.response) : null
      }))
    });
  } catch (error: any) {
    console.error('Error getting API logs:', error);
    return c.json({ error: error.message }, 500);
  }
});
