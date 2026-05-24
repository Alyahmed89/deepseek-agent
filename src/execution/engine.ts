import { randomUUID } from 'crypto';
import { getSupabase } from '../supabase';
import { callLlm } from './llm';
import { compileProgram } from '../rules/compiler';

const PROLOG_URL = process.env.PROLOG_URL || 'https://prolog.anyapp.cfd';

// getAllKnowledge — fetch all active knowledge clauses
async function getAllKnowledge(): Promise<any[]> {
  const { data, error } = await getSupabase()
    .from('knowledge')
    .select('id, name, namespace, prolog, readable, context, tags')
    .eq('is_active', true)
    .order('namespace', { ascending: true });
  if (error) { console.error('[getAllKnowledge] error:', error); return []; }
  return data || [];
}

// getMemory — fetch all memory for an execution
async function getMemory(executionId: string): Promise<Record<string, any>> {
  const { data } = await getSupabase()
    .from('memory')
    .select('key, value')
    .eq('execution_id', executionId);
  const mem: Record<string, any> = {};
  for (const row of data || []) mem[row.key] = row.value;
  return mem;
}

// storeMemory — write key/value to memory table
export async function storeMemory(executionId: string, key: string, value: any, scope: string = 'step'): Promise<void> {
  const strValue = typeof value === 'string' ? value : JSON.stringify(value);
  const { error } = await getSupabase()
    .from('memory')
    .upsert({ id: randomUUID(), execution_id: executionId, key, value: strValue, scope }, { onConflict: 'execution_id,key' });
  if (error) console.error('[storeMemory] error:', error);
}

// emitEvent — write to events table
async function emitEvent(executionId: string, eventType: string, payload: Record<string, any>): Promise<void> {
  const { error } = await getSupabase()
    .from('events')
    .insert({ id: randomUUID(), execution_id: executionId, event_type: eventType, payload });
  if (error) console.error('[emitEvent] error:', error);
}

// pro_check — compile knowledge, call /evaluate, return next_step_id or null
async function pro_check(output: any, flowExecutionId: string, stepRunId: string): Promise<string | null> {
  try {
    const knowledge = await getAllKnowledge();
    const routingClauses = knowledge.filter(k => k.namespace === 'routing');
    const program = compileProgram(routingClauses);
    const outputFacts = Object.entries(output || {}).map(([k, v]) =>
      `step_output('${stepRunId}', '${k}', '${String(v).replace(/'/g, "\'")}').`
    ).join('\n');
    const fullProgram = outputFacts ? outputFacts + '\n' + program : program;
    const resp = await fetch(`${PROLOG_URL}/api/v1/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prolog_program: fullProgram,
        response: output,
        memory: await getMemory(flowExecutionId),
        step_context: { step_run_id: stepRunId, flow_run_id: flowExecutionId },
      }),
    });
    if (!resp.ok) { console.error('[pro_check] HTTP', resp.status); return null; }
    const result = await resp.json();
    console.log(`[pro_check] next_step_id=${result?.next_step_id}`);
    return result?.next_step_id || null;
  } catch (err) { console.error('[pro_check] error:', err); return null; }
}

// buildContext — resolve [[var:key]] from memory
async function buildContext(flowExecutionId: string, stepExecutionId: string): Promise<Record<string, any>> {
  const mem = await getMemory(flowExecutionId);
  return { flow_run_id: flowExecutionId, step_run_id: stepExecutionId, ...mem };
}

// resolveVariables — replace [[var:key]] with memory values
async function resolveVariables(input: any, context: Record<string, any>): Promise<any> {
  if (typeof input === 'string') return input.replace(/\[\[var:([^\]]+)\]\]/g, (_m: string, key: string) => {
    const val = context[key] ?? '';
    return typeof val === 'object' ? JSON.stringify(val) : String(val);
  });
  if (Array.isArray(input)) return Promise.all(input.map(i => resolveVariables(i, context)));
  if (input && typeof input === 'object') {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(input)) result[k] = await resolveVariables(v, context);
    return result;
  }
  return input;
}

// extractStepOrder — parse step_order(N, X) from prolog field
function extractStepOrder(kn: any): number {
  const m = kn.prolog?.match(/step_order\(\w+,\s*(\d+)\)/);
  return m ? parseInt(m[1], 10) : 99;
}

// runFlow — main loop: runStep → pro_check → advance or pause
export async function runFlow(flowExecutionId: string): Promise<void> {
  console.log(`[engine] runFlow start flowExecutionId=${flowExecutionId}`);
  try {
    const flowExec = await getExecution(flowExecutionId);
    if (!flowExec?.flow_id) throw new Error(`Execution ${flowExecutionId} has no flow_id`);
    await updateExecution(flowExecutionId, { status: 'running' });
    await emitEvent(flowExecutionId, 'flow.start', { flow_id: flowExec.flow_id });

    // find first step from knowledge
    const knowledge = await getAllKnowledge();
    const steps = knowledge
      .filter(k => k.namespace === 'step')
      .sort((a, b) => (extractStepOrder(a) ?? 99) - (extractStepOrder(b) ?? 99));

    // get paused step or first step
    const pausedStepId = flowExec.input?.paused_at_step_id;
    let currentStepKnowledge = pausedStepId
      ? steps.find(s => s.context?.step_id === pausedStepId) || steps[0]
      : steps[0];

    if (!currentStepKnowledge) throw new Error(`No steps found in knowledge for flow ${flowExec.flow_id}`);

    while (currentStepKnowledge) {
      const stepResult = await runStep(currentStepKnowledge, flowExecutionId, flowExec);

      // paused — wait for resume
      if (stepResult?.status === 'paused') {
        await updateExecution(flowExecutionId, {
          status: 'paused',
          input: { ...flowExec.input, paused_at_step_id: currentStepKnowledge.context?.step_id }
        });
        await emitEvent(flowExecutionId, 'flow.paused', { step_id: currentStepKnowledge.context?.step_id });
        console.log(`[engine] flow paused at step ${currentStepKnowledge.name}`);
        return;
      }

      const nextStepId = await pro_check(stepResult, flowExecutionId, stepResult?.step_execution_id);
      if (!nextStepId || nextStepId === '__fallback__') break;

      currentStepKnowledge = steps.find(s => s.context?.step_id === nextStepId) || null;
      if (!currentStepKnowledge) {
        console.log(`[engine] no knowledge found for step_id=${nextStepId}`);
        break;
      }
    }

    await updateExecution(flowExecutionId, { status: 'completed' });
    await emitEvent(flowExecutionId, 'flow.completed', {});
    console.log(`[engine] runFlow completed flowExecutionId=${flowExecutionId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[engine] runFlow error:`, msg);
    await updateExecution(flowExecutionId, { status: 'failed' });
    throw err;
  }
}

// stepNeedsPause — check if a pause step has all required input from memory
async function stepNeedsPause(stepKnowledge: any, context: Record<string, any>, expectedResponse: any) {
  const props = expectedResponse?.properties || expectedResponse || {};
  const inputKey = Object.keys(props).find(k => k !== 'chat_message');
  return !(inputKey && context[inputKey] != null && context[inputKey] !== 'null');
}

// runStep — execute one step: resolve vars → LLM or API → store memory → return output
export async function runStep(stepKnowledge: any, flowExecutionId: string, flowExec: any): Promise<any> {
  const stepExecutionId = randomUUID();
  const stepId = stepKnowledge.context?.step_id || stepKnowledge.name;

  // create step execution row
  await getSupabase().from('executions').insert({
    id: stepExecutionId,
    type: 'step',
    parent_id: flowExecutionId,
    flow_id: flowExec.flow_id,
    step_id: stepId,
    status: 'running',
    name: stepKnowledge.readable || stepKnowledge.name,
  });

  await emitEvent(flowExecutionId, 'step.start', { step_id: stepId, name: stepKnowledge.name });

  const mem = await getMemory(flowExecutionId);
  const context = { flow_run_id: flowExecutionId, step_run_id: stepExecutionId, ...flowExec?.input, ...mem };
  const expectedResponse = stepKnowledge.context?.expected_response || {};
  const instructions = await resolveVariables(stepKnowledge.context?.instruction || stepKnowledge.readable || 'Proceed.', context);

  // check if step is pause-for-input
  const isPauseStep = (stepKnowledge.tags || []).includes('pause');
  if (isPauseStep) {
    // check if user already provided input via memory
    const needsPause = await stepNeedsPause(stepKnowledge, context, expectedResponse);
    if (needsPause) {
      await getSupabase().from('executions').update({ status: 'paused' }).eq('id', stepExecutionId);
      return { status: 'paused', step_execution_id: stepExecutionId };
    }
  }

  // build previous messages from context (for resume flow)
  const prevMsgs: Array<{ role: string; content: string }> = [];
  if (isPauseStep && !(await stepNeedsPause(stepKnowledge, context, expectedResponse))) {
    // user input exists in memory — pass it as context
    for (const [k, v] of Object.entries(context)) {
      if (k !== 'flow_run_id' && k !== 'step_run_id' && typeof v === 'string' && v.length > 0) {
        prevMsgs.push({ role: 'user', content: `${k}: ${v}` });
      }
    }
  }

  // action step handler
  const tags: string[] = stepKnowledge.tags || [];
  if (tags.includes("action")) {
    const ctx = stepKnowledge.context || {};
    const endpointId = ctx.endpoint_id as string;
    let ep = ctx;
    if (endpointId) {
      const { data: epData } = await getSupabase().from("knowledge").select("context").eq("id", endpointId).single();
      if (epData?.context) ep = { ...epData.context, ...ctx };
    }
    const url = ep.url as string;
    const method = (ep.method as string || "POST").toUpperCase();
    const rawPayload = ctx.payload || ep.payload || {};
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawPayload)) { payload[k] = typeof v === 'string' ? await resolveVariables(v, context) : v; }
    const baseUrl = process.env.BACKEND_URL || "https://ai.anyapp.cfd";
    const fullUrl = url.startsWith("http") ? url : baseUrl + url;
    const actionResp = await fetch(fullUrl, { method, headers: { "Content-Type": "application/json" }, body: method !== "GET" ? JSON.stringify(payload) : undefined });
    const actionResult = await actionResp.json().catch(() => ({}));
    const output = Array.isArray(actionResult) ? { rows: actionResult } : actionResult;
    for (const [key, value] of Object.entries(output)) { await storeMemory(flowExecutionId, key, typeof value === "string" ? value : JSON.stringify(value), "flow"); }
    await getSupabase().from("executions").update({ status: "completed", output, updated_at: new Date().toISOString() }).eq("id", stepExecutionId);
    await emitEvent(flowExecutionId, "step.completed", { step_id: ctx.step_id, output });
    return { ...output, step_execution_id: stepExecutionId };
  }
  // call LLM
  const llmResult = await callLlm(
    'You are a helpful assistant that responds in JSON matching the expected response schema.',
    instructions,
    prevMsgs.length > 0 ? prevMsgs : undefined,
    expectedResponse,
  );

  const output = typeof llmResult === 'string' ? (() => { try { return JSON.parse(llmResult); } catch { return { response: llmResult }; } })() : llmResult;

  // store each output key as memory
  if (output && typeof output === 'object') {
    for (const [key, value] of Object.entries(output)) {
      if (key !== 'chat_message') {
        await storeMemory(flowExecutionId, key, value, 'flow');
      }
    }
  }

  await getSupabase().from('executions').update({ status: 'completed', output }).eq('id', stepExecutionId);
  await emitEvent(flowExecutionId, 'step.completed', { step_id: stepId, output });

  return { ...output, step_execution_id: stepExecutionId };
}

// getExecution
export async function getExecution(executionId: string): Promise<any> {
  const { data, error } = await getSupabase().from('executions').select('*').eq('id', executionId).single();
  if (error) { console.error('[getExecution] error:', error); return null; }
  return data;
}

// updateExecution
async function updateExecution(executionId: string, data: any): Promise<void> {
  const { error } = await getSupabase().from('executions').update(data).eq('id', executionId);
  if (error) console.error('[updateExecution] error:', error);
}

// createExecution — creates a flow execution row
export async function createExecution(flowId: string, name?: string, input?: Record<string, any>): Promise<string> {
  const id = randomUUID();
  const { error } = await getSupabase().from('executions').insert({
    id, type: 'flow', flow_id: flowId, status: 'pending',
    name: name || `run-${Date.now()}`,
    input: input || {},
  });
  if (error) { console.error('[createExecution] error:', error); throw error; }
  return id;
}

// legacy aliases — keep until controllers updated
export async function getFlowRun(id: string) { return getExecution(id); }
export async function createFlowRun(flowId: string, input?: Record<string, any>, name?: string) { return createExecution(flowId, name, input); }
export async function getStepById(stepId: string) {
  const { data } = await getSupabase().from('steps').select('*').eq('id', stepId).single();
  return data || null;
}
