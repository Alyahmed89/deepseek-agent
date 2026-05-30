import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getSupabase } from '../supabase';
import { callLlm } from './llm';

/**
 * Fetch active routing rules from Supabase to include in pro_check requests.
 * This makes prolog stateless — it doesn't need to cache or refresh rules.
 */
async function getActiveRoutingRules(): Promise<any[]> {
  try {
    const { data } = await getSupabase()
      .from('rules')
      .select('*')
      .eq('namespace', 'routing')
      .eq('is_active', true);
    return data || [];
  } catch (err) {
    console.warn('[engine] failed to fetch active routing rules:', err);
    return [];
  }
}

/**
 * Validate that a rule's content is valid Prolog syntax before sending to prolog.
 * Returns { valid, errors, warnings }.
 */
function validateRuleContent(content: string): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const trimmed = content.trim();

  // Must end with a period
  if (!trimmed.endsWith('.')) {
    errors.push('Rule must end with a period (.)');
  }

  // Must contain :- (implication operator)
  if (!trimmed.includes(':-')) {
    errors.push('Rule must contain the implication operator (:-)');
  }

  // Must start with a lowercase prolog predicate (not a plain English sentence)
  if (!/^[a-z][a-zA-Z0-9_]*\(/.test(trimmed)) {
    warnings.push('Rule does not start with a valid Prolog predicate — may be ignored by prolog');
  }

  // Heuristic: if the rule has more than 8 consecutive alphabetic words without Prolog syntax,
  // it's likely plain English text
  const words = trimmed.split(/\s+/);
  let maxEnglishRun = 0;
  let currentRun = 0;
  for (const w of words) {
    if (/^[a-zA-Z]{3,}$/.test(w) && !w.includes('_') && !w.includes('(') && !w.includes(')')) {
      currentRun++;
      maxEnglishRun = Math.max(maxEnglishRun, currentRun);
    } else {
      currentRun = 0;
    }
  }
  if (maxEnglishRun > 8) {
    errors.push('Rule contains too many consecutive English words — this looks like natural language, not Prolog');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Filter active routing rules, removing invalid ones and logging warnings.
 * Returns only valid rules.
 */
async function getValidRoutingRules(): Promise<{ valid: any[]; invalid: any[] }> {
  const allRules = await getActiveRoutingRules();
  const valid: any[] = [];
  const invalid: any[] = [];
  for (const rule of allRules) {
    const result = validateRuleContent(rule.content || '');
    if (result.valid) {
      valid.push(rule);
    } else {
      console.warn(`[engine] invalid rule ${rule.rule_id} (${(rule.name || 'unnamed')}): ${result.errors.join('; ')}`);
      invalid.push(rule);
    }
  }
  if (invalid.length > 0) {
    console.warn(`[engine] filtered ${invalid.length} invalid rules from pro_check request`);
  }
  return { valid, invalid };
}

/**
 * Fetch all step IDs for a flow, used to validate pro_check routing targets.
 */
async function getFlowStepIds(flowId: string): Promise<string[]> {
  try {
    const { data } = await getSupabase()
      .from('steps')
      .select('id')
      .eq('flow_id', flowId);
    return (data || []).map(s => s.id);
  } catch (err) {
    console.warn('[engine] failed to fetch flow step IDs:', err);
    return [];
  }
}

/** Insert a variable (or array of variables) while stripping columns kong's table doesn't have. */
async function insertVariable(data: Record<string, any> | Record<string, any>[]): Promise<void> {
  if (Array.isArray(data)) {
    const cleaned = data.map(({ scope, ...rest }) => rest); // kong's variables table lacks scope
    const { error } = await getSupabase().from('variables').insert(cleaned).maybeSingle();
    if (error) console.warn('[engine] batch insertVariable error:', error.message);
  } else {
    const { scope, ...rest } = data;
    const { error } = await getSupabase().from('variables').insert(rest).maybeSingle();
    if (error) console.warn('[engine] insertVariable error:', error.message);
  }
}

const STEP_TIMEOUT_MS = 60000;

/**
 * Emit an execution event for the frontend trace display.
 * Events are stored in the execution_events table and can be
 * polled by the UI to show real-time progress.
 */
async function emitEvent(
  flowRunId: string,
  stepRunId: string | null,
  eventType: string,
  payload: Record<string, any>,
): Promise<void> {
  try {
    await getSupabase().from('execution_events').insert({
      id: randomUUID(),
      flow_run_id: flowRunId,
      step_run_id: stepRunId,
      event_type: eventType,
      payload,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    // Swallow errors so event emission never breaks the main flow
    console.warn('[engine] failed to emit event:', err);
  }
}

/**
 * Call pro_check on the given output, store request/response in step run result,
 * and if "stop", pause the step and flow run (do NOT fail, do NOT auto-start correction).
 * Returns 'continue' or 'paused'.
 */
async function callProCheckOnOutput(
  stepRun: any,
  output: any,
  rules: string[],
  plans: string[],
): Promise<'continue' | 'paused'> {
  const prologUrl = process.env.PROLOG_URL || 'https://prolog.anyapp.cfd';

  // --- Local validation before Prolog call ---
  const validationErrors: string[] = [];
  const step = await getStepById(stepRun.step_id).catch(() => null);

  // 1. Check for unresolved refs
  if (output.refs && Array.isArray(output.refs)) {
    for (const ref of output.refs) {
      const { data: existingRef } = await getSupabase()
        .from('refs')
        .select('id')
        .eq('id', ref)
        .maybeSingle();
      if (!existingRef) {
        validationErrors.push(`Unresolved ref: ${ref}`);
      }
    }
  }

  // 3. Check for invalid symbolic task references
  if (output.task_ids && Array.isArray(output.task_ids)) {
    for (const taskId of output.task_ids) {
      const { data: term } = await getSupabase()
        .from('terms')
        .select('id')
        .eq('name', taskId)
        .maybeSingle();
      if (!term) {
        validationErrors.push(`Invalid symbolic task: ${taskId} not found in terms`);
      }
    }
  }

  // 4. Check for illegal self-transitions
  if (output.next_step_id && step) {
    if (output.next_step_id === step.id) {
      validationErrors.push('Illegal transition: next_step_id points to self');
    }
    // Verify target step exists
    const { data: targetStep } = await getSupabase()
      .from('steps')
      .select('id')
      .eq('id', output.next_step_id)
      .maybeSingle();
    if (!targetStep) {
      validationErrors.push(`Illegal transition: next_step_id ${output.next_step_id} does not exist`);
    }
  }

  // 5. Check for invalid flow routing
  if (output.next_flow_id) {
    const { data: targetFlow } = await getSupabase()
      .from('flows')
      .select('id')
      .eq('id', output.next_flow_id)
      .maybeSingle();
    if (!targetFlow) {
      validationErrors.push(`Invalid flow routing: next_flow_id ${output.next_flow_id} does not exist`);
    }
  }

  // 6. Check for invalid variable mutations (AI cannot write to reserved prefixes)
  if (output.variables && typeof output.variables === 'object') {
    for (const varKey of Object.keys(output.variables)) {
      if (varKey.startsWith('input_') || varKey.startsWith('memory.')) {
        validationErrors.push(`Invalid variable mutation: AI cannot write to reserved prefix "${varKey}"`);
      }
    }
  }

  // 7. Include contract failures from earlier validation
  if (output.contract_failures && Array.isArray(output.contract_failures)) {
    validationErrors.push(...output.contract_failures.map((f: string) => `Contract failure: ${f}`));
  }

  // Collect normalized variables from the step run context for pro_check visibility
  const normalizedVars: Record<string, any> = {};
  if (stepRun.result?.resolved_variables) {
    const ctx = stepRun.result.resolved_variables;
    for (const k of Object.keys(ctx)) {
      if (k.startsWith('input_') || k.startsWith('memory.') || k === 'normalized_input' || k === 'matched_terms' || k === 'selected_plan_name' || k === 'task_ids' || k === 'selected_task_id') {
        normalizedVars[k] = ctx[k];
      }
    }
  }

  // Fetch previous step output for context (most recent completed step before current)
  let previous_step_output: any = null;
  try {
    const { data: prevSteps } = await getSupabase()
      .from('step_runs')
      .select('ai_response, step_id')
      .eq('flow_run_id', stepRun.flow_run_id)
      .order('created_at', { ascending: false })
      .limit(2);
    if (prevSteps && prevSteps.length > 1) {
      previous_step_output = prevSteps[1]?.ai_response || null;
      if (typeof previous_step_output === 'string') {
        try { previous_step_output = JSON.parse(previous_step_output); } catch {}
      }
    }
  } catch {
    // Gracefully degrade if fetch fails
  }

  // Ensure step_run_id is never empty — prolog scoring depends on it
  const proCheckStepRunId = stepRun?.id;
  if (!proCheckStepRunId) {
    console.warn('[engine] pro_check called without a valid step_run.id, using step_run_id from stepRun');
  }

  // Fetch active routing rules and flow step IDs so prolog is stateless
  // Validate rules before sending to prevent bad rules from killing prolog
  const { valid: activeRules, invalid: _invalidRules } = await getValidRoutingRules();
  // Try to get flow_id for step validation
  let allStepIds: string[] = [];
  try {
    const flowId = step?.flow_id;
    if (flowId) {
      allStepIds = await getFlowStepIds(flowId);
    }
  } catch {
    // non-critical, continue without step IDs
  }

  const proCheckRequest = {
    response: output,
    rules: activeRules.map(r => r.content),
    plans: [],
    flow_run_id: stepRun.flow_run_id,
    step_run_id: proCheckStepRunId,
    validation_errors: validationErrors,
    contract_failures: output.contract_failures || [],
    required_inputs: step?.required_inputs || [],
    normalized_vars: normalizedVars,
    step_contracts: {
      required_inputs: step?.required_inputs,
    },
    previous_step_output,
    expected_response: step?.expected_response || null,
    resolved_variables: (stepRun as any).resolved_variables || stepRun.result?.resolved_variables || null,
    step_title: step?.title || null,
    step_order: step?.order_index ?? null,
    all_step_ids: allStepIds,
    flow_input: null,
    current_step_id: stepRun.step_id,
  };

  // ----- STORE REQUEST IMMEDIATELY -----
  const baseResult = stepRun.result && typeof stepRun.result === 'object' ? stepRun.result : {};
  const resultWithRequest = {
    ...baseResult,
    pro_check_request: proCheckRequest,
  };
  await updateStepRun(stepRun.id, { result: resultWithRequest });
  stepRun.result = resultWithRequest; // keep in-memory copy consistent

  // ----- CALL PROLOG -----
  let proCheckResponse: any = { status: 'pass' };
  let prologReachable = true;
  try {
    const prologRes = await fetch(`${prologUrl}/api/v1/pro_check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proCheckRequest),
    });
    if (prologRes.ok) {
      proCheckResponse = await prologRes.json();
    } else {
      prologReachable = false;
    }
  } catch (err: any) {
    console.warn('[engine] pro_check call failed:', err?.message || err, 'status:', (err as any)?.status);
    prologReachable = false;
    // Store error in step run result
    const resultWithError = {
      ...stepRun.result,
      pro_check_error: { message: err.message, stack: err.stack },
    };
    await updateStepRun(stepRun.id, { result: resultWithError });
    stepRun.result = resultWithError;
  }

  // ----- STORE RESPONSE IMMEDIATELY -----
  const resultWithResponse = {
    ...stepRun.result,
    pro_check: proCheckResponse,
  };
  await updateStepRun(stepRun.id, { result: resultWithResponse });
  stepRun.result = resultWithResponse;

  // ----- HANDLE SCORE EVENT -----
  if (proCheckResponse.score !== undefined && proCheckResponse.score !== null) {
    await emitEvent(stepRun.flow_run_id, stepRun.id, 'procheck.score', {
      score: proCheckResponse.score,
      score_reason: proCheckResponse.score_reason || null,
      quarantined: proCheckResponse.quarantined || false,
    });
  }

  // ----- HANDLE QUARANTINED FLAG -----
  // Do NOT stop the flow — just emit the event for monitoring
  if (proCheckResponse.quarantined === true) {
    await emitEvent(stepRun.flow_run_id, stepRun.id, 'procheck.quarantined', {
      score: proCheckResponse.score,
      score_reason: proCheckResponse.score_reason || null,
    });
  }

  // ----- HANDLE PROVIDED VARIABLES -----
  if (proCheckResponse.provided_variables && Array.isArray(proCheckResponse.provided_variables)) {
    for (const v of proCheckResponse.provided_variables) {
      if (v.key && v.value !== undefined && v.value !== null) {
        await insertVariable({
          id: randomUUID(),
          flow_run_id: stepRun.flow_run_id,
          step_run_id: stepRun.id,
          key: v.key,
          value: typeof v.value === 'string' ? v.value : JSON.stringify(v.value),
          scope: 'flow_run',
          created_at: new Date().toISOString(),
        });
      }
    }
  }

  // ----- ROUTING VIA PRO_CHECK -----
  // If pro_check returned a next_step_id, store it on the step run result
  // so the main loop routes there (pro_check owns all routing).
  // This MUST run BEFORE any pause/stop check so the route is persisted
  // even when the step pauses.
  if (proCheckResponse.next_step_id && typeof proCheckResponse.next_step_id === 'string' && proCheckResponse.next_step_id.trim() !== '') {
    const resultWithProCheckNext = {
      ...stepRun.result,
      procheck_next_step_id: proCheckResponse.next_step_id,
    };
    await updateStepRun(stepRun.id, { result: resultWithProCheckNext });
    stepRun.result = resultWithProCheckNext;
  }

  // ----- STORE MATCHED RULES IN CONTEXT -----
  // Make matched_rules and winning_rule available to the next step's AI
  // via the variables table so [[var:previous_matched_rules]] resolves.
  const matchedRules = proCheckResponse.matched_rules;
  const winningRule = proCheckResponse.winning_rule;
  if (matchedRules && Array.isArray(matchedRules) && matchedRules.length > 0) {
    await insertVariable({
      id: randomUUID(),
      flow_run_id: stepRun.flow_run_id,
      step_run_id: stepRun.id,
      key: 'previous_matched_rules',
      value: JSON.stringify(matchedRules.map((r: any) => ({
        rule_id: r.rule_id,
        target: r.target,
        specificity: r.specificity,
        pro_map: r.pro_map,
        context: r.context,
      }))),
      scope: 'flow_run',
      created_at: new Date().toISOString(),
    });
  }
  if (winningRule && typeof winningRule === 'object') {
    await insertVariable({
      id: randomUUID(),
      flow_run_id: stepRun.flow_run_id,
      step_run_id: stepRun.id,
      key: 'previous_winning_rule',
      value: JSON.stringify({
        rule_id: winningRule.rule_id,
        target: winningRule.target,
        specificity: winningRule.specificity,
        pro_map: winningRule.pro_map,
        context: winningRule.context,
      }),
      scope: 'flow_run',
      created_at: new Date().toISOString(),
    });
  }

  // ----- HANDLE PAUSE -----
  if (proCheckResponse.status === 'pause') {
    await updateStepRun(stepRun.id, { status: 'paused' });
    await updateFlowRun(stepRun.flow_run_id, {
      status: 'paused',
      paused_at_step_id: stepRun.step_id,
    });
    return 'paused';
  }

  if (!prologReachable) {
    // Prolog unreachable — warn but continue (graceful degradation)
    console.warn(`[engine] prolog unreachable, continuing without pro_check`);
    proCheckResponse = { status: 'pass', plans: [], rules: [] };
  }

  // ----- CHECK FOR input_ PREFIXED VARIABLES WITH NULL VALUES -----
  // Any variable whose name starts with "input_" and has a null/empty value
  // triggers a pause so the user can fill it in via /resume.
  const inputVars = findInputVarsWithNullValue(output);
  if (inputVars.length > 0) {
    console.log(`[engine] input_ variables with null value detected: ${inputVars.join(', ')}, pausing`);
    await updateStepRun(stepRun.id, { status: 'paused' });
    await updateFlowRun(stepRun.flow_run_id, {
      status: 'paused',
      paused_at_step_id: stepRun.step_id,
    });
    return 'paused';
  }

  return 'continue';
}

/**
 * Recursively search the output object for any key starting with "input_"
 * whose value is null, undefined, or empty string.
 */
function findInputVarsWithNullValue(obj: any, prefix = ''): string[] {
  const results: string[] = [];
  if (!obj || typeof obj !== 'object') return results;
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (key.startsWith('input_') && (value === null || value === undefined || value === '' || value === 'null')) {
      results.push(fullKey);
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      results.push(...findInputVarsWithNullValue(value, fullKey));
    }
  }
  return results;
}

async function handleApiFailure(
  responseBody: string,
  statusCode: number,
  url: string,
  context: Record<string, any>,
  stepRunId: string,
  flowRunId: string,
  step: any,
): Promise<'continue' | 'paused'> {
  const errorMsg = `API ${statusCode}: ${(responseBody || '').slice(0, 500)}`;
  const apiError = { api_error: { statusCode, body: responseBody, url } };

  // Store API error details in the step run so the UI displays them
  // Merge with any existing result (e.g. from a previous partial write)
  const { data: existingStepRun } = await getSupabase()
    .from('step_runs')
    .select('*')
    .eq('id', stepRunId)
    .maybeSingle();
  if (!existingStepRun) return 'continue';
  // Kong stores result data in output column
  if (existingStepRun.output && !existingStepRun.result) existingStepRun.result = existingStepRun.output;
  const existingResult = existingStepRun.result && typeof existingStepRun.result === 'object' ? existingStepRun.result : {};
  await updateStepRun(stepRunId, {
    error: errorMsg,
    result: { ...existingResult, ...apiError },
  });
  existingStepRun.result = { ...existingResult, ...apiError };

  // Attach resolved_variables since it's not persisted in DB
  (existingStepRun as any).resolved_variables = context;

  // Let pro_check decide if the step should pause or fail
  return callProCheckOnOutput(existingStepRun, apiError, [], []);
}

function buildExpectedResponseSchema(stepExpectedResponse: any): z.ZodObject<any> {
  // Build the schema solely from step.expected_response as stored in the database.
  // The DB is the only source of truth — no hardcoded fields are merged.
  if (!stepExpectedResponse || typeof stepExpectedResponse !== 'object') {
    return z.object({}).passthrough();
  }

  let shape: Record<string, z.ZodTypeAny> = {};
  if (stepExpectedResponse.type === 'object' && stepExpectedResponse.properties) {
    for (const [key, prop] of Object.entries<any>(stepExpectedResponse.properties)) {
      let fieldSchema: z.ZodTypeAny;
      switch (prop.type) {
        case 'string': fieldSchema = z.string(); break;
        case 'number': fieldSchema = z.number(); break;
        case 'boolean': fieldSchema = z.boolean(); break;
        case 'integer': fieldSchema = z.number().int(); break;
        case 'array': fieldSchema = z.array(z.any()); break;
        case 'object': fieldSchema = z.record(z.any()); break;
        default: fieldSchema = z.any(); break;
      }
      // Fields starting with "input_" accept null so the AI can signal
      // that user input is needed (the engine pauses and waits for /resume).
      if (key.startsWith('input_')) {
        fieldSchema = fieldSchema.nullable();
      }
      shape[key] = fieldSchema;
    }
    if (stepExpectedResponse.required) {
      const requiredSet = new Set(stepExpectedResponse.required);
      const optionalShape: Record<string, z.ZodTypeAny> = {};
      for (const key of Object.keys(shape)) {
        optionalShape[key] = requiredSet.has(key) ? shape[key] : shape[key].optional();
      }
      shape = optionalShape;
    }
  }

  const schema = z.object(shape);
  return schema.passthrough();
}

export async function runFlow(flowRunId: string, userInput?: Record<string, any>): Promise<void> {
  console.log(`[engine] runFlow start flowRunId=${flowRunId} userInput=${JSON.stringify(userInput)}`);
  try {
    const flowRun = await getFlowRun(flowRunId);
    console.log(`[engine] runFlow flowRun status=${flowRun?.status} paused_at_step_id=${flowRun?.paused_at_step_id || flowRun?.input?.paused_at_step_id}`);
    if (!flowRun?.flow_id) throw new Error(`Flow run ${flowRunId} has no flow_id`);

    // If resuming from paused state, apply user_input and find resume step
    let currentStep: any;
    // Kong stores paused_at_step_id in the input JSONB field
    const pausedStepId = flowRun.paused_at_step_id || (flowRun.input?.paused_at_step_id);
    if (flowRun.status === 'paused' && pausedStepId) {
      flowRun.paused_at_step_id = pausedStepId; // normalize for downstream
      console.log(`[engine] resuming from paused step ${pausedStepId}`);
      await emitEvent(flowRunId, null, 'flow.resume', {
        paused_at_step_id: pausedStepId,
        has_user_input: userInput != null,
      });

      // Find the step after paused_at_step_id
      const pausedStep = await getStepById(flowRun.paused_at_step_id);
      if (!pausedStep) throw new Error(`Paused step ${flowRun.paused_at_step_id} not found`);

      // Determine variable key from paused step's expected_response schema
      let varKey = 'user_input';
      const er = pausedStep.expected_response;
      if (er) {
        // Helper to find the first field starting with "input_" in a required list
        const findInputVar = (reqList: string[], props: Record<string, any>): string | null => {
          for (const field of reqList) {
            if (field.startsWith('input_')) return field;
            // Check nested in memory
            if (field === 'memory' && props?.memory?.properties) {
              const memReq = props.memory.required;
              if (Array.isArray(memReq)) {
                for (const mf of memReq) {
                  if (mf.startsWith('input_')) return mf;
                }
              }
            }
          }
          return null;
        };

        // Priority 1: input_ prefixed field at top level
        const topInput = Array.isArray(er.required) ? findInputVar(er.required, er.properties) : null;
        if (topInput) {
          varKey = topInput;
        }
        // Priority 2: input_ prefixed field inside memory
        // Prefix with "memory." so the variable is stored as memory.input_user_input,
        // matching what [[var:memory.input_user_input]] expects in step instructions.
        else if (Array.isArray(er.required) && er.required.includes('memory') && er.properties?.memory?.required?.length > 0) {
          const memInput = er.properties.memory.required.find((f: string) => f.startsWith('input_'));
          const rawKey = memInput || er.properties.memory.required[0];
          varKey = `memory.${rawKey}`;
        }
        // Priority 3: first required field at top level
        else if (Array.isArray(er.required) && er.required.length > 0) {
          varKey = er.required[0];
        }
      }

      // Store user input as flow_run.input (legacy) AND as individual
      // variables in the variables table so [[var:key:key=key]] resolves
      // via buildContext (same pattern as the test variable flow).
      if (userInput != null) {
        const currentInput = flowRun.input && typeof flowRun.input === 'object' ? flowRun.input : {};
        await updateFlowRun(flowRunId, { input: { ...currentInput, user_input: userInput } });
        // Normalize: if userInput is a plain string, wrap with detected varKey
        const vars = typeof userInput === 'string' ? { [varKey]: userInput } : userInput;
        // Insert each key as a variable so buildContext picks it up.
        // Remap generic "user_input" key to the schema-detected varKey when they differ.
        for (const [k, v] of Object.entries(vars)) {
          const effectiveKey = k === 'user_input' && varKey !== 'user_input' ? varKey : k;
          await insertVariable({
            id: randomUUID(),
            flow_run_id: flowRunId,
            step_run_id: null,
            key: effectiveKey,
            value: typeof v === 'string' ? v : JSON.stringify(v),
            scope: 'flow_run',
            created_at: new Date().toISOString(),
          });
        }
      }

      // On resume, determine next step from pro_check or stored routing.
      // Prolog server caches rules at startup and ignores the rules: [] field,
      // so the fresh pro_check often returns stale results. Strategy:
      //   - If user provided meaningful input (not empty {}), re-call pro_check.
      //   - Otherwise, use the stored procheck_next_step_id from the step's
      //     original execution (which used the engine's validated rules).
      const { data: pausedStepRun } = await getSupabase()
        .from('step_runs')
        .select('id, step_id, output, ai_response')
        .eq('flow_run_id', flowRunId)
        .eq('step_id', pausedStepId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const hasUserInput = userInput != null && typeof userInput === 'object' && Object.keys(userInput).length > 0;
      let nextAfterPaused: any = null;

      // Only re-call pro_check if there's actual new input
      if (hasUserInput && pausedStepRun?.output) {
        try {
          const pausedOutput = typeof pausedStepRun.output === 'string'
            ? JSON.parse(pausedStepRun.output) : pausedStepRun.output;
          const pausedAi = typeof pausedStepRun.ai_response === 'string'
            ? JSON.parse(pausedStepRun.ai_response) : (pausedStepRun.ai_response || {});
          const updatedOutput = { ...pausedAi, ...pausedOutput, ...(userInput || {}) };
          const { valid: activeRules } = await getValidRoutingRules();
          let allStepIds: string[] = [];
          try {
            const flowId = pausedStep?.flow_id;
            if (flowId) {
              allStepIds = await getFlowStepIds(flowId);
            }
          } catch { /* non-critical */ }
          const prologUrl = process.env.PROLOG_URL || 'https://prolog.anyapp.cfd';
          const prologRes = await fetch(`${prologUrl}/api/v1/pro_check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              response: updatedOutput,
              flow_run_id: flowRunId,
              step_run_id: pausedStepRun.id,
              rules: activeRules.map(r => r.content),
              plans: [],
              validation_errors: [],
              contract_failures: updatedOutput.contract_failures || [],
              required_inputs: pausedStep?.required_inputs || [],
              normalized_vars: {},
              step_contracts: { required_inputs: pausedStep?.required_inputs },
              previous_step_output: null,
              expected_response: pausedStep?.expected_response || null,
              resolved_variables: null,
              step_title: pausedStep?.title || null,
              step_order: pausedStep?.order_index ?? null,
              all_step_ids: allStepIds,
              current_step_id: pausedStepRun.step_id,
            }),
          });
          if (prologRes.ok) {
            const freshProCheck = await prologRes.json();
            const freshNext = freshProCheck.next_step_id;
            if (freshNext && typeof freshNext === 'string' && freshNext !== pausedStepId) {
              const candidateStep = await getStepById(freshNext).catch(() => null);
              if (candidateStep) {
                nextAfterPaused = candidateStep;
              }
            }
          }
        } catch {
          // pro_check call failed — fall through to stored route
        }
      }
      if (!nextAfterPaused) {
        // Use the stored procheck_next_step_id from the step's original execution
        // (or from the fresh pro_check if it returned one but step didn't validate)
        const storedOutput = pausedStepRun?.output
          ? (typeof pausedStepRun.output === 'string'
            ? JSON.parse(pausedStepRun.output) : pausedStepRun.output)
          : null;
        const storedNext = storedOutput?.procheck_next_step_id || storedOutput?.pro_check?.next_step_id;
        console.log(`[engine] resume: using stored route, storedNext=${storedNext} pausedStepId=${pausedStepId} hasUserInput=${hasUserInput}`);
        if (storedNext && typeof storedNext === 'string' && storedNext !== pausedStepId) {
          const candidateStep = await getStepById(storedNext).catch(() => null);
          if (candidateStep) {
            console.log(`[engine] resume: using stored procheck_next_step_id=${storedNext}`);
            nextAfterPaused = candidateStep;
          }
        }
        if (!nextAfterPaused) {
          console.log(`[engine] no valid route from pro_check after resume, completing flow`);
          await updateFlowRun(flowRunId, { status: 'completed' });
          return;
        }
      }
      // Small delay to ensure DB write propagates before buildContext reads
      await new Promise(resolve => setTimeout(resolve, 500));
      currentStep = nextAfterPaused;
      await updateFlowRun(flowRunId, { status: 'running', paused_at_step_id: null });
    } else {
      // Fresh start
      await updateFlowRun(flowRunId, { status: 'running' });

      // Normalize user input if present (Phase 3).
      // User language is translated into canonical symbolic language before execution.
      if (flowRun.input_variables?.raw_input) {
        console.log(`[engine] normalizing user input: ${flowRun.input_variables.raw_input}`);
        await emitEvent(flowRunId, null, 'normalization.start', {
          raw_input: flowRun.input_variables.raw_input,
        });
        const normalized = await normalizeUserInput(flowRun.input_variables.raw_input, flowRunId);
        for (const [key, value] of Object.entries(normalized.variables)) {
          await insertVariable({
            id: randomUUID(),
            flow_run_id: flowRunId,
            step_run_id: null,
            key,
            value,
            scope: 'flow_run',
            created_at: new Date().toISOString(),
          });
        }
        console.log(`[engine] normalized input: canonical="${normalized.canonical}" terms=[${normalized.matchedTerms.join(',')}]`);
        await emitEvent(flowRunId, null, 'normalization.complete', {
          canonical: normalized.canonical,
          symbolic: normalized.symbolic,
          matched_terms: normalized.matchedTerms,
        });
      }

      const firstStep = await getFirstStep(flowRun.flow_id);
      if (!firstStep) throw new Error(`No steps found for flow ${flowRun.flow_id}`);
      console.log(`[engine] firstStep id=${firstStep.id} ref=${firstStep.ref}`);
      await emitEvent(flowRunId, null, 'flow.start', {
        flow_id: flowRun.flow_id,
        first_step_id: firstStep.id,
        first_step_ref: firstStep.ref,
      });
      currentStep = firstStep;
    }

    const visited = new Set<string>();
    const stepHistory: string[] = [];
    const maxSteps = 50;
    let stepCount = 0;

    while (currentStep) {
      if (stepCount >= maxSteps) throw new Error('Max steps exceeded');

      // --- Check if flow was paused externally (e.g. via interrupt endpoint) ---
      const { data: currentFr } = await getSupabase()
        .from('flow_runs')
        .select('status')
        .eq('id', flowRunId)
        .maybeSingle();
      if (currentFr?.status === 'paused') {
        console.log(`[engine] flow ${flowRunId} is paused, halting iteration`);
        await emitEvent(flowRunId, null, 'flow.paused', { reason: 'external_interrupt', step_id: currentStep.id });
        return;
      }

      // --- Adaptive loop detection ---
      stepHistory.push(currentStep.id);
      if (stepHistory.length >= 6) {
        const last3 = stepHistory.slice(-3);
        const prev3 = stepHistory.slice(-6, -3);
        if (last3[0] === prev3[0] && last3[1] === prev3[1] && last3[2] === prev3[2]) {
          console.log(`[engine] adaptive loop detected: ${last3.join(' → ')}, pausing flow`);
          await emitEvent(flowRunId, null, 'flow.loop_detected', {
            pattern: last3.join(' → '),
            type: '3-step-repeat',
            step_id: currentStep.id,
          });
          await updateFlowRun(flowRunId, { status: 'paused', paused_at_step_id: currentStep.id });
          return;
        }
        // Check for alternating 2-step pattern (A, B, A, B, A, B)
        const last6 = stepHistory.slice(-6);
        if (last6[0] === last6[2] && last6[2] === last6[4] &&
            last6[1] === last6[3] && last6[3] === last6[5] &&
            last6[0] !== last6[1]) {
          console.log(`[engine] alternating 2-step loop detected: ${last6[0]} ↔ ${last6[1]}, pausing flow`);
          await emitEvent(flowRunId, null, 'flow.loop_detected', {
            pattern: `${last6[0]} ↔ ${last6[1]}`,
            type: '2-step-alternating',
            step_id: currentStep.id,
          });
          await updateFlowRun(flowRunId, { status: 'paused', paused_at_step_id: currentStep.id });
          return;
        }
      }

      if (visited.has(currentStep.id)) throw new Error('Cycle detected');
      visited.add(currentStep.id);
      stepCount++;

      console.log(`[engine] executing step stepCount=${stepCount} stepId=${currentStep.id} ref=${currentStep.ref}`);
      await emitEvent(flowRunId, null, 'step.start', {
        step_id: currentStep.id,
        step_ref: currentStep.ref,
        step_title: currentStep.title,
        step_count: stepCount,
      });
      const stepResult = await runStep(currentStep, flowRunId, flowRun);
      console.log(`[engine] step done ref=${currentStep.ref} stepResult=${JSON.stringify(stepResult)}`);

      // Handle paused signal (from pro_check stop/pause, input_ null, or API failure)
      // Always pause regardless of stored procheck_next_step_id.
      // The resume flow will re-evaluate pro_check with user input merged in.
      if (stepResult && typeof stepResult === 'object' && 'status' in stepResult && stepResult.status === 'paused') {
        console.log(`[engine] flow paused at step ${currentStep.id}`);
        await emitEvent(flowRunId, null, 'flow.paused', { reason: 'step_paused', step_id: currentStep.id });
        return;
      }

      if (stepResult === '__PAUSED__') {
        // Check if pro_check already stored a valid route — if so, follow it
        const { data: pausedStepRun } = await getSupabase()
          .from('step_runs')
          .select('id, output, step_id')
          .eq('flow_run_id', flowRunId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (pausedStepRun) {
          const stepOutput = (pausedStepRun.output as any) || {};
          const procheckNext = stepOutput.procheck_next_step_id || stepOutput.pro_check?.next_step_id;
          console.log(`[engine] __PAUSED__ check: step=${currentStep.id} procheckNext=${procheckNext} step_id=${pausedStepRun.step_id}`);
          if (procheckNext && typeof procheckNext === 'string' && procheckNext.length > 0 && procheckNext !== pausedStepRun.step_id) {
            const next = await getStepById(procheckNext).catch(() => null);
            if (next) {
              console.log(`[engine] __PAUSED__ auto-continue: step ${currentStep.id} -> ${procheckNext}`);
              currentStep = next;
              await updateFlowRun(flowRunId, { status: 'running', paused_at_step_id: null });
              continue;
            }
          }
        }
        // No valid route — pause for resume
        console.log(`[engine] flow paused at step ${currentStep.id}`);
        await emitEvent(flowRunId, null, 'flow.paused', { reason: 'step_paused', step_id: currentStep.id });
        return;
      }

      // Plain string step ID returned from runStep — route directly
      if (typeof stepResult === 'string' && stepResult !== '__PAUSED__' && stepResult.length > 0) {
        const nextStep = await getStepById(stepResult).catch(() => null);
        if (nextStep) {
          await emitEvent(flowRunId, null, 'routing.procheck', {
            from_step_id: currentStep.id,
            to_step_id: nextStep.id,
            to_step_title: nextStep.title,
            reason: 'procheck_next_step_id',
          });
          currentStep = nextStep;
          continue;
        }
      }

      if (!stepResult) break;

      // Fetch the step run to read routing signals
      // Note: updateStepRun maps result→output for Kong schema
      const { data: stepRun } = await getSupabase()
        .from('step_runs')
        .select('id, output, step_id')
        .eq('flow_run_id', flowRunId)
        .eq('step_id', currentStep.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const stepRunId = stepRun?.id;

      // Pro_check routing takes priority — if pro_check specified a next step, use it
      // Check both procheck_next_step_id (stored by callProCheckOnOutput)
      // and pro_check.next_step_id (direct read from stored pro_check response)
      const stepOutput = (stepRun?.output as any) || {};
      const procheckNext = stepOutput.procheck_next_step_id || stepOutput.pro_check?.next_step_id;
      if (procheckNext && typeof procheckNext === 'string' && procheckNext.length > 0 && procheckNext !== stepRun?.step_id) {
        try {
          const next = await getStepById(procheckNext);
          if (next) {
            // Store the matched rules' accumulated context (from prolog API)
            // as a flow variable so the destination step reads and executes its actions
            const proCheckResult = stepOutput.pro_check || {};
            const accumulatedCtx = proCheckResult.accumulated_context;
            if (accumulatedCtx) {
              const ctxVal = typeof accumulatedCtx === 'string' ? accumulatedCtx : JSON.stringify(accumulatedCtx);
              await insertVariable({
                id: randomUUID(),
                flow_run_id: flowRunId,
                step_run_id: stepRunId || currentStep.id,
                key: 'routing_rule_context',
                value: ctxVal,
                scope: 'flow_run',
                created_at: new Date().toISOString(),
              });
            }

            visited.delete(procheckNext);
            await emitEvent(flowRunId, stepRunId, 'routing.procheck', {
              from_step_id: currentStep.id,
              from_step_ref: currentStep.ref,
              to_step_id: procheckNext,
              to_step_ref: next.ref,
              to_step_title: next.title,
              reason: 'procheck_next_step_id',
            });
            currentStep = next;
            continue;
          }
        } catch (err: any) {
          console.warn(`[engine] procheck_next_step_id ${procheckNext} not found, falling through to AI routing`);
        }
      }

      // Follow the AI's next_step_id if present
      const aiNext = (stepRun?.output as any)?.next_step_id;
      if (aiNext && typeof aiNext === 'string' && aiNext.length > 0 && aiNext !== stepRun?.step_id) {
        try {
          const next = await getStepById(aiNext);
          if (next) {
            visited.delete(aiNext);
            await emitEvent(flowRunId, stepRunId, 'routing.ai', {
              from_step_id: currentStep.id,
              from_step_ref: currentStep.ref,
              to_step_id: aiNext,
              to_step_ref: next.ref,
              to_step_title: next.title,
              reason: 'ai_next_step_id',
            });
            currentStep = next;
            continue;
          }
        } catch (err: any) {
          // Step UUID not found — store as error variable and use step's own fallback
          const errorPayload = { type: 'routing_error', message: `No step found with id ${aiNext}`, step_id: currentStep.id, bad_next_step_id: aiNext };
          await insertVariable({
            id: randomUUID(),
            flow_run_id: flowRunId,
            step_run_id: stepRunId || currentStep.id,
            key: 'engine_error',
            value: JSON.stringify(errorPayload),
            scope: 'flow_run',
            created_at: new Date().toISOString(),
          });
          await insertVariable({
            id: randomUUID(),
            flow_run_id: flowRunId,
            step_run_id: stepRunId || currentStep.id,
            key: 'routing_error',
            value: JSON.stringify(errorPayload),
            scope: 'flow_run',
            created_at: new Date().toISOString(),
          });
          console.warn(`[engine] ${errorPayload.message}, using step fallback`);
          await emitEvent(flowRunId, stepRunId, 'routing.error', {
            from_step_id: currentStep.id,
            bad_next_step_id: aiNext,
            error: errorPayload.message,
            fallback: 'expected_response_next_const',
          });
          // Use the current step's expected_response.next.const as fallback
          const fallbackNext = currentStep.expected_response?.properties?.next?.const;
          if (fallbackNext && fallbackNext !== currentStep.id) {
            const fallbackStep = await getStepById(fallbackNext).catch(() => null);
            if (fallbackStep) {
              visited.delete(fallbackNext);
              currentStep = fallbackStep;
              continue;
            }
          }
        }
      }

      // No procheck or AI route — complete the flow.
      // order_index advancement is removed: pro_check is the sole routing authority.
      console.log(`[engine] no routing signal for step ${currentStep.id}, completing flow`);
      await emitEvent(flowRunId, null, 'flow.complete', { reason: 'no_routing_signal', step_id: currentStep.id });
      break;
    }

    await updateFlowRun(flowRunId, { status: 'completed' });
    console.log(`[engine] runFlow completed flowRunId=${flowRunId}`);
    await emitEvent(flowRunId, null, 'flow.complete', { reason: 'normal_completion' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[engine] runFlow error flowRunId=${flowRunId}:`, msg);
    await emitEvent(flowRunId, null, 'flow.error', { error: msg });
    try {
      await updateFlowRun(flowRunId, { status: 'failed', error: msg });
    } catch (updateErr) {
      console.error(`[engine] failed to update flow run status:`, updateErr);
    }
    throw err;
  }
}

export async function runStep(step: any, flowRunId: string, flowRun: any): Promise<string | null | { status: 'paused' | 'failed'; stepRunId: string }> {
  console.log(`[engine] runStep start stepRef=${step.ref} flowRunId=${flowRunId}`);
  const stepRunId = await createStepRun(flowRunId, step.id);
  console.log(`[engine] runStep stepRunId=${stepRunId}`);

  // Build variable context
  if (flowRun && flowRun.input && flowRun.input.user_input) { flowRun.input_variables = { ...flowRun.input_variables, ...flowRun.input.user_input }; }
  const context = await buildContext(flowRunId, stepRunId, flowRun);

  // Apply canonical variable normalization if step has aliases.
  // This ensures different variable names (e.g. input_selected_plan_name,
  // memory.selected_plan_name, selected_plan_name) all resolve to the
  // canonical name (selected_plan_name) internally.
  if (step.variable_aliases && typeof step.variable_aliases === 'object') {
    const beforeKeys = Object.keys(context).sort().join(',');
    Object.assign(context, normalizeCanonicalVariables(context, step.variable_aliases));
    const afterKeys = Object.keys(context).sort().join(',');
    console.log(`[engine] canonical normalization: keys before=${beforeKeys} after=${afterKeys}`);
    await emitEvent(flowRunId, stepRunId, 'normalization.aliases', {
      before: beforeKeys,
      after: afterKeys,
      aliases: step.variable_aliases,
    });
  }

  // Step 0.5 — Contract validation
  // Check required_inputs before proceeding
  if (Array.isArray(step.required_inputs)) {
    const missing = step.required_inputs.filter(
      (key: string) => context[key] === undefined || context[key] === null || context[key] === ''
    );
    if (missing.length > 0) {
      console.log(`[engine] missing required inputs: ${missing.join(', ')}, pausing`);
      await emitEvent(flowRunId, stepRunId, 'contract.missing_inputs', {
        missing,
        required: step.required_inputs,
        step_id: step.id,
      });
      await updateStepRun(stepRunId, {
        status: 'paused',
        result: { pause_reason: 'missing_required_inputs', missing_variables: missing },
      });
      await updateFlowRun(flowRunId, {
        status: 'paused',
        paused_at_step_id: step.id,
      });
      return { status: 'paused', stepRunId };
    }
  }

  // Step 1 — Resolve variables in instructions
  let renderedInstructions: string | null = null;
  try {
    renderedInstructions = step.instructions ? await resolveVariables(step.instructions, context) : null;
  } catch (err: any) {
    console.warn(`[engine] warning: failed to resolve variables in instructions: ${err.message}. Using raw instructions.`);
    renderedInstructions = step.instructions || null;
  }
  console.log(`[engine] rendered_instructions:`, renderedInstructions);

  // Step 2 — Build LLM prompt with endpoint samples
  const schemaJson = JSON.stringify(step.expected_response, null, 2);

  // Collect endpoint samples referenced in expected_response actions
  let endpointSamples = '';
  if (step.expected_response?.actions) {
    const endpointNames = step.expected_response.actions
      .filter((a: any) => a.type === 'api' && a.endpoint)
      .map((a: any) => a.endpoint);
    if (endpointNames.length > 0) {
      const { data: endpoints } = await getSupabase()
        .from('endpoint_registry')
        .select('id, url, method, headers, sample_request, sample_response')
        .in('id', endpointNames);
      if (endpoints) {
        endpointSamples = '\n\nAvailable endpoint samples:\n' + JSON.stringify(endpoints, null, 2);
        endpointSamples += '\n\nFor each action, use the endpoint sample_request as a guide for the payload shape. Fill in the actual values for the keys you decide. The engine will merge your payload with the endpoint defaults.';
      }
    }
  }

  const userPrompt = `${renderedInstructions || ''}${endpointSamples}\n\nReturn ONLY valid JSON matching this schema:\n${schemaJson}`;

  // Emit LLM call event
  await emitEvent(flowRunId, stepRunId, 'llm.call', {
    step_id: step.id,
    step_ref: step.ref,
    user_prompt: userPrompt,
    schema: step.expected_response,
  });

  // Skip LLM when:
  // 1. All input_ fields in expected_response.required already have non-null
  //    values in context (the user already provided them via resume), OR
  // 2. The step has no input_ fields, no actions, AND no required output fields.
  let skipLlm = false;
  let skipReason = '';
  const inputFields = Array.isArray(step.expected_response?.required)
    ? step.expected_response.required.filter((f: string) => f.startsWith('input_'))
    : [];
  if (inputFields.length > 0) {
    const allResolved = inputFields.every(
      (f: string) => context[f] !== undefined && context[f] !== null && context[f] !== ''
    );
    if (allResolved) {
      skipLlm = true;
      skipReason = 'all_input_fields_already_resolved';
      console.log(`[engine] step=${step.ref} all input_ fields already resolved in context, skipping LLM`);
    }
  }
  if (!skipLlm) {
    const hasActions = Array.isArray(step.expected_response?.actions) &&
      step.expected_response.actions.length > 0;
    const hasOutputFields = Array.isArray(step.expected_response?.required) &&
      step.expected_response.required.length > 0;
    if (inputFields.length === 0 && !hasOutputFields) {
      skipLlm = true;
      skipReason = skipReason || 'no_input_output_fields_no_actions';
      console.log(`[engine] step=${step.ref} has no input_/output fields, skipping LLM call`);
    }
  }
  if (skipLlm) {
    await emitEvent(flowRunId, stepRunId, 'llm.skip', {
      step_id: step.id,
      step_ref: step.ref,
      reason: skipReason,
    });
  }

  // Wrap AI call + action execution + post-processing in a timeout race
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Step execution timed out after 60s')), STEP_TIMEOUT_MS);
  });

  const executionPromise = (async (): Promise<string | { status: 'paused' | 'failed'; stepRunId: string } | null> => {
    let aiResponse: any;
    let llmError: string | null = null;
    try {
      if (skipLlm) {
        // Build a synthetic response: use context values for input_ fields,
        // empty strings for other required fields.  Inherit actions from
        // the step config so action-only steps execute their actions.
        aiResponse = {};
        if (Array.isArray(step.expected_response?.required)) {
          for (const field of step.expected_response.required) {
            if (field.startsWith('input_') && context[field] !== undefined) {
              aiResponse[field] = context[field];
            } else {
              aiResponse[field] = '';
            }
          }
        }
        if (Array.isArray(step.expected_response?.actions)) {
          aiResponse.actions = step.expected_response.actions;
        }
      } else {
        aiResponse = await callLlm(null, userPrompt);
      }
      await emitEvent(flowRunId, stepRunId, 'llm.response', {
        step_id: step.id,
        step_ref: step.ref,
        response: aiResponse,
      });
    } catch (err) {
      llmError = err instanceof Error ? err.message : String(err);
      const isTimeoutOrAbort = err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError');
      const errorType = isTimeoutOrAbort ? 'timeout_error' : 'llm_error';
      console.error(`[engine] LLM call failed:`, llmError);
      await emitEvent(flowRunId, stepRunId, 'llm.error', {
        step_id: step.id,
        step_ref: step.ref,
        error: llmError,
        error_type: errorType,
      });

      // Store error as flow_run variable
      const errorPayload = { type: errorType, message: llmError, step_id: step.id, details: err instanceof Error ? err.stack : null };
      await insertVariable({
        id: randomUUID(),
        flow_run_id: flowRunId,
        step_run_id: stepRunId,
        key: 'engine_error',
        value: JSON.stringify(errorPayload),
        scope: 'flow_run',
        created_at: new Date().toISOString(),
      });
      await insertVariable({
        id: randomUUID(),
        flow_run_id: flowRunId,
        step_run_id: stepRunId,
        key: errorType,
        value: JSON.stringify(errorPayload),
        scope: 'flow_run',
        created_at: new Date().toISOString(),
      });
      context.engine_error = errorPayload;
      context[errorType] = errorPayload;

      // Build synthetic response routing to assistant_summarize
      const fallbackNext = step.expected_response?.properties?.next?.const
        || step.expected_response?.properties?.next_step_id?.const
        || '3eeba100-50eb-4826-8faf-07aa4b64fca4';
      aiResponse = { next: fallbackNext, next_step_id: fallbackNext, chat_message: 'An error occurred. Please try again.' };
    }

    // Step 3 — Zod validate ai_response against expected_response schema
    const schema = buildExpectedResponseSchema(step.expected_response);
    let zodResult = schema.safeParse(aiResponse);
    console.log(`[engine] zod validation:`, JSON.stringify(zodResult, null, 2));

    if (!zodResult.success) {
      const zodError = zodResult.error.flatten();
      console.error(`[engine] zod validation FAILED:`, JSON.stringify(zodError, null, 2));

      // Store the Zod error as a flow_run variable
      const errorPayload = { type: 'zod_error', message: 'Zod validation failed', step_id: step.id, details: zodError };
      await insertVariable({
        id: randomUUID(),
        flow_run_id: flowRunId,
        step_run_id: stepRunId,
        key: 'engine_error',
        value: JSON.stringify(errorPayload),
        scope: 'flow_run',
        created_at: new Date().toISOString(),
      });
      await insertVariable({
        id: randomUUID(),
        flow_run_id: flowRunId,
        step_run_id: stepRunId,
        key: 'zod_error',
        value: JSON.stringify(zodError),
        scope: 'flow_run',
        created_at: new Date().toISOString(),
      });
      await insertVariable({
        id: randomUUID(),
        flow_run_id: flowRunId,
        step_run_id: stepRunId,
        key: 'zod_ai_response',
        value: JSON.stringify(aiResponse),
        scope: 'flow_run',
        created_at: new Date().toISOString(),
      });
      context.engine_error = errorPayload;
      context.zod_error = zodError;

      // Mark step run with validation error
      await updateStepRun(stepRunId, {
        validation_errors: [zodError],
      });

      // Do NOT build synthetic response. Do NOT continue normally.
      // Route to pro_check with the validation failure so it can decide:
      // pause (for correction) or stop (if unrecoverable).
      const zodFailureOutput = {
        ...aiResponse,
        zod_validation_error: zodError,
        contract_failures: [`Zod validation failed: ${JSON.stringify(zodError)}`],
      };

      // Persist the failed response
      await updateStepRun(stepRunId, {
        ai_response: normalizeValue(zodFailureOutput),
        ai_response_valid: false,
        rendered_instructions: renderedInstructions,
        resolved_variables: context,
        result: { zod_error: zodError },
      });

      // Send to pro_check for correction routing
      const { data: stepRunForProCheck } = await getSupabase()
        .from('step_runs')
        .select('*')
        .eq('id', stepRunId)
        .maybeSingle();
      if (stepRunForProCheck) {
        // Attach resolved_variables since it's not persisted in DB
        (stepRunForProCheck as any).resolved_variables = context;
        const proCheckResult = await callProCheckOnOutput(stepRunForProCheck, zodFailureOutput, [], []);
        if (proCheckResult === 'paused') return { status: 'paused', stepRunId };
      }

      // If pro_check didn't pause, pause anyway — never continue from zod failure
      await updateStepRun(stepRunId, { status: 'paused' });
      await updateFlowRun(flowRunId, {
        status: 'paused',
        paused_at_step_id: step.id,
      });
      return { status: 'paused', stepRunId };
    }

    const validated = zodResult.data!;
    const next = validated.next ?? null;
    const actions = Array.isArray(validated.actions) ? validated.actions : [];

    const contractFailures: string[] = [];

    // Auto-store all fields from AI response as flow_run variables.
    // Every key the AI returns is stored as a flow_run variable.
    const autoStore = async (obj: Record<string, any>, prefix?: string, isRecursive?: boolean) => {
      for (const [key, value] of Object.entries(obj)) {
        if (key === 'next' || key === 'actions' || key === 'pro_check' || key === 'chat_message') continue;
        const varKey = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          await insertVariable({
            id: randomUUID(),
            flow_run_id: flowRunId,
            step_run_id: stepRunId,
            key: varKey,
            value: String(value),
            scope: 'flow_run',
            created_at: new Date().toISOString(),
          });
          context[varKey] = value;
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          // Nested object — store as JSON and also recurse for direct access
          await insertVariable({
            id: randomUUID(),
            flow_run_id: flowRunId,
            step_run_id: stepRunId,
            key: varKey,
            value: JSON.stringify(value),
            scope: 'flow_run',
            created_at: new Date().toISOString(),
          });
          context[varKey] = value;
          // Recurse with isRecursive=true so nested keys are NOT filtered again
          await autoStore(value, varKey, true);
        } else {
          // Array or other — store as JSON string
          await insertVariable({
            id: randomUUID(),
            flow_run_id: flowRunId,
            step_run_id: stepRunId,
            key: varKey,
            value: JSON.stringify(value),
            scope: 'flow_run',
            created_at: new Date().toISOString(),
          });
          context[varKey] = value;
        }
      }
    };
    await autoStore(validated);

        // Step 5 — Execute actions (before pro_check so results are included)
    const actionResults: Record<string, any> = {};
    let actionError: any = null;
    for (const action of actions) {
      // Auto-fill type, method, and path from endpoint registry before any checks.
      // This allows actions with just {"endpoint":"prolog_rules","output_var":"rules"}.
      if (action.endpoint && (!action.type || !action.method || !action.path)) {
        const { data: endpoint } = await getSupabase()
          .from('endpoint_registry')
          .select('*')
          .eq('id', action.endpoint)
          .maybeSingle();
        if (endpoint) {
          if (!action.type) action.type = 'api';
          if (!action.method) action.method = endpoint.method || 'GET';
          if (!action.path) action.path = endpoint.url;
        }
      }

      if (action.type !== 'api') continue;

      // --- Validation phase (all checks before any network call) ---

      // Validate required fields (type and endpoint are always required)
      if (!action.type) {
        const errorMsg = `Invalid action: missing required field 'type'`;
        console.error(`[engine] ${errorMsg}`, action);
        actionError = { type: 'action_error', message: errorMsg, action, stack: new Error(errorMsg).stack };
        break;
      }
      if (!action.endpoint) {
        const errorMsg = `Invalid action: missing required field 'endpoint'`;
        console.error(`[engine] ${errorMsg}`, action);
        actionError = { type: 'action_error', message: errorMsg, action, stack: new Error(errorMsg).stack };
        break;
      }

      // Look up endpoint in registry (again if not already fetched above)
      const { data: endpoint } = await getSupabase()
        .from('endpoint_registry')
        .select('*')
        .eq('id', action.endpoint)
        .maybeSingle();

      if (!endpoint) {
        // Endpoint not in registry — require explicit path
        if (!action.path) {
          const errorMsg = `Invalid action: missing required field 'path' (endpoint '${action.endpoint}' not found in registry)`;
          console.error(`[engine] ${errorMsg}`, action);
          actionError = { type: 'action_error', message: errorMsg, action, stack: new Error(errorMsg).stack };
          break;
        }
      } else {
        // Auto-fill method from registry if not specified
        if (!action.method) {
          action.method = endpoint.method || 'GET';
        }
        // Auto-fill path from registry URL if not specified
        if (!action.path) {
          action.path = endpoint.url;
        }
      }

      // Resolve method (default to GET if still missing)
      const actionMethod = (action.method || 'GET').toUpperCase();

      // If endpoint was found, validate method and path
      if (endpoint) {
        const endpointMethod = (endpoint.method || 'GET').toUpperCase();
        if (actionMethod !== endpointMethod) {
          const errorMsg = `Method mismatch for endpoint '${action.endpoint}': action uses '${actionMethod}', endpoint expects '${endpointMethod}'`;
          console.error(`[engine] ${errorMsg}`);
          actionError = { type: 'action_error', message: errorMsg, action, stack: new Error(errorMsg).stack };
          break;
        }

        // Skip path validation for endpoints with template variables (e.g. [[var:table]])
        // The registered URL contains placeholders that won't match the resolved action path
        if (endpoint.url.includes('[[var:')) {
          // Dynamic endpoint — skip path validation
        } else {
          // Validate path: accept relative paths (starting with endpoint base path)
          // or full URLs that match the registered endpoint URL (ignoring query string)
          const endpointBasePath = extractBasePath(endpoint.url);
          const resolvedActionPath = await resolveVariables(action.path, context);
          const actionPathNoQuery = resolvedActionPath.split('?')[0];
          const endpointUrlNoQuery = endpoint.url.split('?')[0];
          const isRelativeMatch = resolvedActionPath.startsWith(endpointBasePath);
          const isFullUrlMatch = actionPathNoQuery === endpointUrlNoQuery;
          if (!isRelativeMatch && !isFullUrlMatch) {
            const errorMsg = `Path mismatch for endpoint '${action.endpoint}': action path '${resolvedActionPath}' does not start with endpoint base path '${endpointBasePath}' nor match endpoint URL '${endpoint.url}'`;
            console.error(`[engine] ${errorMsg}`);
            actionError = { type: 'action_error', message: errorMsg, action, stack: new Error(errorMsg).stack };
            break;
          }
        }
      }

      // Validate output_var if present
      if (action.output_var && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(action.output_var)) {
        const errorMsg = `Invalid output_var '${action.output_var}' for endpoint '${action.endpoint}': must be a valid identifier`;
        console.error(`[engine] ${errorMsg}`);
        actionError = { type: 'action_error', message: errorMsg, action, stack: new Error(errorMsg).stack };
        break;
      }

      // Validate payload against endpoint sample_request schema
      if (endpoint.sample_request != null) {
        try {
          const payloadSchema = zodSchemaFromSample(endpoint.sample_request);
          if (action.payload) {
            const resolvedPayload = await resolveVariables(action.payload, context);
            payloadSchema.parse(resolvedPayload);
          } else if (actionMethod !== 'GET' && actionMethod !== 'HEAD') {
            const errorMsg = `Missing payload for endpoint '${action.endpoint}': expected payload matching sample_request`;
            console.error(`[engine] ${errorMsg}`);
            actionError = { type: 'action_error', message: errorMsg, action, stack: new Error(errorMsg).stack };
            break;
          }
        } catch (err: any) {
          if (err instanceof z.ZodError) {
            const details = err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
            const errorMsg = `Invalid payload for endpoint '${action.endpoint}': ${details}`;
            console.error(`[engine] ${errorMsg}`);
            actionError = { type: 'action_error', message: errorMsg, action, stack: new Error(errorMsg).stack };
            break;
          }
          throw err;
        }
      }

      // --- Execution phase ---

      // Resolve variables just before each action so subsequent actions
      // can use variables set by previous actions in the same step
      let url = normalizeValue(await resolveVariables(action.endpoint, context));
      let headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...normalizeValue(await resolveVariables(action.headers || {}, context)),
      };

      if (endpoint) {
        url = normalizeValue(await resolveVariables(endpoint.url, context));
        headers = { ...(endpoint.headers || {}), ...headers };
      }

      const httpMethod = actionMethod;
      let mergedPayload: any = undefined;

      // Only build payload for methods that accept a body
      if (httpMethod !== 'GET' && httpMethod !== 'HEAD') {
        // Start from endpoint default (if exists)
        if (endpoint?.sample_request) {
          mergedPayload = { ...endpoint.sample_request };
        }

        // Apply AI payload (override defaults)
        if (action.payload) {
          const resolvedPayload = normalizeValue(await resolveVariables(action.payload, context));
          mergedPayload = mergedPayload
            ? deepMerge(mergedPayload, resolvedPayload)
            : resolvedPayload;
        }
      }

      console.log(`[engine] executing action: ${httpMethod} ${url}`);
      await emitEvent(flowRunId, stepRunId, 'api.call', {
        step_id: step.id,
        step_ref: step.ref,
        endpoint: action.endpoint,
        method: httpMethod,
        url,
        headers,
        payload: mergedPayload,
      });

      // Wrap fetch + response parsing + non-ok handling in a single try/catch
      try {
        let res: Response;
        let responseBody: string | null = null;
        try {
          res = await fetch(url, {
            method: httpMethod,
            headers,
            body: mergedPayload ? JSON.stringify(mergedPayload) : undefined,
          });
          try {
            responseBody = await res.text();
          } catch {
            // ignore read errors
          }
        } catch (err: any) {
          // Fetch-level error (network, DNS, etc.)
          const errorMsg = err?.message || String(err);
          actionError = { type: 'action_error', message: errorMsg, action, stack: err?.stack };
          await emitEvent(flowRunId, stepRunId, 'api.error', {
            step_id: step.id,
            step_ref: step.ref,
            endpoint: action.endpoint,
            error: errorMsg,
          });
          break;
        }

        // Persist to api_calls table
        await getSupabase().from('api_calls').insert({
          id: randomUUID(),
          flow_run_id: flowRunId,
          step_run_id: stepRunId,
          endpoint_name: url,
          http_method: httpMethod,
          request_url: url,
          request_headers: headers,
          request_body: mergedPayload,
          response_status: res.status,
          response_body: responseBody,
          success: res.ok,
          error: res.ok ? null : `HTTP ${res.status}`,
          created_at: new Date().toISOString(),
        });

        // Auto-store response as variable for subsequent steps
        if (res.ok && responseBody) {
          try {
            const parsed = JSON.parse(responseBody);
            const varName = `api_response_${action.endpoint}`;
            await insertVariable({
              id: randomUUID(),
              flow_run_id: flowRunId,
              step_run_id: stepRunId,
              key: varName,
              value: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
              scope: 'step_run',
              created_at: new Date().toISOString(),
            });
            // Also add to running context so subsequent actions in same step can use it
            context[varName] = parsed;
            // Store in actionResults for pro_check
            actionResults[action.endpoint] = parsed;

            // If the action has an output_var, also store the result under that key
            // as a flow_run-scoped variable so subsequent steps can reference it
            if (action.output_var) {
              await insertVariable({
                id: randomUUID(),
                flow_run_id: flowRunId,
                step_run_id: stepRunId,
                key: action.output_var,
                value: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
                scope: 'flow_run',
                created_at: new Date().toISOString(),
              });
              // Inject into running context immediately
              context[action.output_var] = parsed;
            }
          } catch {
            // response is not JSON, skip auto-store
          }
        }

        if (!res.ok) {
          const bodyStr = responseBody || '';
          const shouldPause = await handleApiFailure(bodyStr, res.status, url, context, stepRunId, flowRunId, step);
          if (shouldPause === 'paused') {
            // Signal pause to outer runFlow without throwing
            await emitEvent(flowRunId, stepRunId, 'api.paused', {
              step_id: step.id,
              step_ref: step.ref,
              endpoint: action.endpoint,
              status: res.status,
            });
            return { status: 'paused', stepRunId };
          }
          // pro_check passed despite API error — record error and continue
          actionError = { type: 'action_error', statusCode: res.status, body: bodyStr, url };
          await emitEvent(flowRunId, stepRunId, 'api.error', {
            step_id: step.id,
            step_ref: step.ref,
            endpoint: action.endpoint,
            status: res.status,
            body: bodyStr,
          });
          break;
        }
        console.log(`[engine] action completed: ${url} ${res.status}`);
        await emitEvent(flowRunId, stepRunId, 'api.complete', {
          step_id: step.id,
          step_ref: step.ref,
          endpoint: action.endpoint,
          status: res.status,
          response: responseBody ? tryParseJson(responseBody) : null,
        });
      } catch (err: any) {
        // Catch any unexpected error from the action block
        const errorMsg = err?.message || String(err);
        actionError = { type: 'action_error', message: errorMsg, action, stack: err?.stack };
        await emitEvent(flowRunId, stepRunId, 'api.error', {
          step_id: step.id,
          step_ref: step.ref,
          endpoint: action.endpoint,
          error: errorMsg,
        });
        break;
      }
    }

    // Store action error as flow_run variable if present
    if (actionError) {
      const errorPayload = { type: 'action_error', message: actionError.message || 'Action failed', step_id: step.id, details: actionError };
      await insertVariable({
        id: randomUUID(),
        flow_run_id: flowRunId,
        step_run_id: stepRunId,
        key: 'engine_error',
        value: JSON.stringify(errorPayload),
        scope: 'flow_run',
        created_at: new Date().toISOString(),
      });
      await insertVariable({
        id: randomUUID(),
        flow_run_id: flowRunId,
        step_run_id: stepRunId,
        key: 'action_error',
        value: JSON.stringify(errorPayload),
        scope: 'flow_run',
        created_at: new Date().toISOString(),
      });
      context.engine_error = errorPayload;
      context.action_error = errorPayload;
    }

    // Step 6 — Persist ai_response and resolved_variables BEFORE pro_check,
    // so the frontend can read them for chat mode even if the step pauses.
    const validatedNorm = normalizeValue(validated);
    const nextStepIdFromOutput = validatedNorm?.next_step_id;
    const resultData: Record<string, any> = {};
    if (nextStepIdFromOutput && typeof nextStepIdFromOutput === 'string' && nextStepIdFromOutput.trim() !== '') {
      resultData.next_step_id = nextStepIdFromOutput;
    }

    // Merge in all current flow_run variables so resume-stored values
    // (e.g. input_user_prompt) appear in resolved_variables of the step run.
    const { data: allFlowVars } = await getSupabase()
      .from('variables')
      .select('key, value')
      .eq('flow_run_id', flowRunId);
    if (allFlowVars) {
      for (const v of allFlowVars) {
        if (!(v.key in context)) {
          context[v.key] = v.value;
        }
      }
    }

    await updateStepRun(stepRunId, {
      ai_response: validatedNorm,
      ai_response_valid: true,
      rendered_instructions: renderedInstructions,
      resolved_variables: context,
      result: resultData,
    });

    // Step 7 — Call pro_check on merged output (AI response + action results + any error + contract failures)
    const mergedOutput = actionError
      ? { ...validated, action_results: actionResults, action_error: actionError, contract_failures: contractFailures }
      : { ...validated, action_results: actionResults, contract_failures: contractFailures };
    const { data: stepRunForProCheck } = await getSupabase()
      .from('step_runs')
      .select('*')
      .eq('id', stepRunId)
      .maybeSingle();
    if (stepRunForProCheck) {
      // Attach resolved_variables since it's not persisted in DB
      (stepRunForProCheck as any).resolved_variables = context;
      const proCheckResult = await callProCheckOnOutput(stepRunForProCheck, mergedOutput, [], []);
      if (proCheckResult === 'paused') return { status: 'paused', stepRunId };
    }

    // Step 8 — Mark step completed
    await updateStepRun(stepRunId, {
      status: 'completed',
    });

    // Write refs entries for rules and plans from pro_check response
    const stepRules: string[] = [];
    const stepPlans: string[] = [];
    if (validated.pro_check?.rules) stepRules.push(...validated.pro_check.rules);
    if (validated.pro_check?.plans) stepPlans.push(...validated.pro_check.plans);
    for (const ruleId of stepRules) {
      await getSupabase().from('refs').insert({
        id: randomUUID(),
        flow_run_id: flowRunId,
        step_run_id: stepRunId,
        rule_id: ruleId,
        key: 'rule',
        value: ruleId,
        source: 'pro_check',
        created_at: new Date().toISOString(),
      });
    }
    for (const planId of stepPlans) {
      await getSupabase().from('refs').insert({
        id: randomUUID(),
        flow_run_id: flowRunId,
        step_run_id: stepRunId,
        rule_id: planId,
        key: 'plan',
        value: 'referenced',
        source: 'pro_check',
        created_at: new Date().toISOString(),
      });
    }

    // Step 9 — Conditions override
    const conditionResult = await evaluateConditions(step.id, validated);
    if (conditionResult === '__PAUSED__') {
      // Condition matched but had no next_step_id or next_flow_id — pause for Mo
      console.log(`[engine] step=${step.ref} condition matched, pausing for Mo`);
      await updateFlowRun(flowRunId, {
        status: 'paused',
        paused_at_step_id: step.id,
      });
      return '__PAUSED__';
    }
    if (conditionResult) {
      console.log(`[engine] step=${step.ref} next=${conditionResult} (condition)`);
      return conditionResult;
    }

    // Step 10 — Direct transition via AI-suggested next step
    if (next) {
      console.log(`[engine] step=${step.ref} next=${next}`);
      return next;
    }

    // Terminal step — no outgoing edge, pause for Mo
    console.log(`[engine] step=${step.ref} is terminal, pausing for Mo`);
    await updateFlowRun(flowRunId, {
      status: 'paused',
      paused_at_step_id: step.id,
    });
    return '__PAUSED__';
  })();

  let executionResult: any;
  try {
    executionResult = await Promise.race([executionPromise, timeoutPromise]);
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('timed out after 60s');
    console.error(`[engine] step execution error:`, msg);

    // Store error as flow_run variable
    const errorType = isTimeout ? 'timeout_error' : 'execution_error';
    const errorPayload = { type: errorType, message: msg, step_id: step.id, details: err instanceof Error ? err.stack : null };
    await insertVariable({
      id: randomUUID(),
      flow_run_id: flowRunId,
      step_run_id: stepRunId,
      key: 'engine_error',
      value: JSON.stringify(errorPayload),
      scope: 'flow_run',
      created_at: new Date().toISOString(),
    });
    await insertVariable({
      id: randomUUID(),
      flow_run_id: flowRunId,
      step_run_id: stepRunId,
      key: errorType,
      value: JSON.stringify(errorPayload),
      scope: 'flow_run',
      created_at: new Date().toISOString(),
    });

    // Mark step_run as failed so it's never left "running" on error
    const { data: sr } = await getSupabase()
      .from('step_runs')
      .select('*')
      .eq('id', stepRunId)
      .maybeSingle();
    if (sr) {
      // Kong stores result data in output column
      if (sr.output && !sr.result) sr.result = sr.output;
      const existingResult = sr.result && typeof sr.result === 'object' ? sr.result : {};
      // Preserve next_step_id from ai_response so the flow loop can continue
      const savedNextStepId = sr.ai_response?.next_step_id;
      await updateStepRun(stepRunId, {
        status: 'failed',
        error: msg,
        result: { ...existingResult, api_error: { message: msg } },
      });
      sr.result = { ...existingResult, api_error: { message: msg } };
      // Re-inject next_step_id into result so it survives for the flow loop
      if (savedNextStepId) {
        await updateStepRun(stepRunId, {
          result: { ...sr.result, next_step_id: savedNextStepId },
        });
        sr.result = { ...sr.result, next_step_id: savedNextStepId };
      }
      // Trigger pro_check so correction flow can be started
      await callProCheckOnOutput(sr, { type: errorType, message: msg }, [], []);
    }

    if (isTimeout) {
      return { status: 'paused', stepRunId };
    }

    // Re-throw non-timeout errors
    throw err;
  }

  // Propagate result from execution promise
  return executionResult;
}

export async function getFlowRun(flowRunId: string): Promise<any> {
  const { data, error } = await getSupabase()
    .from('flow_runs')
    .select('*')
    .eq('id', flowRunId)
    .single();
  if (error) throw new Error(`Failed to get flow run: ${error.message}`);
  return data;
}

/** Kong stores expected_response as TEXT — parse to object if needed */
function normalizeStep(step: any): any {
  if (!step) return step;
  if (typeof step.expected_response === 'string') {
    try { step.expected_response = JSON.parse(step.expected_response); } catch { /* keep as-is */ }
  }
  return step;
}

async function getFirstStep(flowId: string): Promise<any> {
  const { data, error } = await getSupabase()
    .from('steps')
    .select('*')
    .eq('flow_id', flowId)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to get first step: ${error.message}`);
  return normalizeStep(data);
}

async function getStepByFlowAndRef(flowId: string, ref: string): Promise<any> {
  const { data, error } = await getSupabase()
    .from('steps')
    .select('*')
    .eq('flow_id', flowId)
    .eq('ref', ref)
    .single();
  if (error) throw new Error(`Step ref "${ref}" not found in flow ${flowId}`);
  return normalizeStep(data);
}

export async function getStepById(stepId: string): Promise<any> {
  const { data, error } = await getSupabase()
    .from('steps')
    .select('*')
    .eq('id', stepId)
    .single();
  if (error) throw new Error(`Step not found by id ${stepId}: ${error.message}`);
  return normalizeStep(data);
}

async function createStepRun(flowRunId: string, stepId: string): Promise<string> {
  const id = randomUUID();
  const { data, error } = await getSupabase()
    .from('step_runs')
    .insert({
      id,
      flow_run_id: flowRunId,
      step_id: stepId,
      status: 'running',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw new Error(`Failed to create step run: ${error.message}`);
  return data.id;
}

async function updateStepRun(stepRunId: string, data: any): Promise<void> {
  // Map to kong schema: result→output, drop non-existent columns
  const mapped: any = { updated_at: new Date().toISOString() };
  for (const [k, v] of Object.entries(data)) {
    if (k === 'result') {
      mapped.output = v;
    } else if (k === 'ai_response_valid' || k === 'resolved_variables' || k === 'validation_errors') {
      // These columns don't exist on kong — store in validation/input elsewhere
      if (k === 'ai_response_valid') {
        mapped.validation = { valid: v };
      }
    } else if (v !== undefined) {
      mapped[k] = v;
    }
  }
  const { error } = await getSupabase()
    .from('step_runs')
    .update(mapped)
    .eq('id', stepRunId);
  if (error) throw new Error(`Failed to update step run: ${error.message}`);
}

export async function createFlowRun(flowId: string, inputVariables?: Record<string, any>): Promise<string> {
  const id = randomUUID();
  const { error } = await getSupabase()
    .from('flow_runs')
    .insert({
      id,
      flow_id: flowId,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  if (error) throw new Error(`Failed to create flow run: ${error.message}`);

  // Store input variables as flow_run-scoped variable records
  if (inputVariables && typeof inputVariables === 'object') {
    for (const [key, value] of Object.entries(inputVariables)) {
      await insertVariable({
        id: randomUUID(),
        flow_run_id: id,
        step_run_id: null,
        key,
        value: typeof value === 'string' ? value : JSON.stringify(value),
        created_at: new Date().toISOString(),
      });
    }
  }

  return id;
}

async function updateFlowRun(flowRunId: string, data: any): Promise<void> {
  // Kong's flow_runs lacks error & paused_at_step_id columns.
  // Store them in the input JSONB field instead.
  const mapped: any = { updated_at: new Date().toISOString() };
  // Read existing input to preserve metadata
  const { data: existing } = await getSupabase()
    .from('flow_runs')
    .select('input')
    .eq('id', flowRunId)
    .maybeSingle();
  const meta: Record<string, any> = (existing?.input && typeof existing.input === 'object' ? existing.input : {}) as Record<string, any>;
  let metaChanged = false;
  for (const [k, v] of Object.entries(data)) {
    if (k === 'error' || k === 'paused_at_step_id') {
      meta[k] = v;
      metaChanged = true;
    } else if (v !== undefined) {
      mapped[k] = v;
    }
  }
  if (metaChanged) mapped.input = meta;
  const { error } = await getSupabase()
    .from('flow_runs')
    .update(mapped)
    .eq('id', flowRunId);
  if (error) throw new Error(`Failed to update flow run: ${error.message}`);
}

async function evaluateConditions(stepId: string, expected: any): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from('step_conditions')
    .select('*')
    .eq('step_id', stepId);

  if (error) throw new Error(`Failed to get conditions: ${error.message}`);
  if (!data || data.length === 0) return null;

  for (const c of data) {
    // c.type is the field name in the AI response to check (e.g. "var_plan_id")
    if (!(c.type in expected)) continue;

    if (expected[c.type] === c.value) {
      // next_flow_id takes priority — jump to another flow
      if (c.next_flow_id) {
        const firstStep = await getFirstStep(c.next_flow_id);
        if (!firstStep) throw new Error(`No steps found in target flow ${c.next_flow_id}`);
        return firstStep.ref;
      }

      // next_step_id — continue in the same flow
      if (c.next_step_id) {
        const step = await getStepById(c.next_step_id);
        if (!step?.ref) {
          throw new Error(`Step ${c.next_step_id} has no ref`);
        }
        return step.ref;
      }

      // No next_step_id or next_flow_id — pause for Mo intervention.
      // If resume_step_id is set, store it so resume knows where to go.
      if (c.resume_step_id) {
        // The caller (runStep) will handle the pause; we signal by returning '__PAUSED__'
        // and the resume_step_id is stored on the condition for the resume logic to use.
        return '__PAUSED__';
      }

      // No next edge at all — pause
      return '__PAUSED__';
    }
  }

  return null;
}

// ── Variable Resolution ──────────────────────────────────────────────

async function buildContext(flowRunId: string, stepRunId: string, flowRun: any): Promise<Record<string, any>> {
  const context: Record<string, any> = {};

  // auto-inject identifiers
  context['flow_run_id'] = flowRunId;
  context['step_run_id'] = stepRunId;

  // flow_run level
  if (flowRun?.input_variables) {
    Object.assign(context, flowRun.input_variables);
  }

  // Fetch step_runs for this flow run so we know which step runs exist.
  // Variables are prioritized by created_at (most recent wins), not by
  // step run order, so resume-stored values always take precedence.
  const { data: stepRuns } = await getSupabase()
    .from('step_runs')
    .select('id, created_at')
    .eq('flow_run_id', flowRunId)
    .order('created_at', { ascending: true });

  const stepRunOrder = new Map<string, number>();
  if (stepRuns) {
    stepRuns.forEach((sr: any, idx: number) => {
      stepRunOrder.set(sr.id, idx);
    });
  }

  // Fetch all variables for this flow run (plus globals).
  const { data: vars } = await getSupabase()
    .from('variables')
    .select('*')
    .or(`flow_run_id.eq.${flowRunId},scope.eq.global`)
    .order('created_at', { ascending: false });

  if (vars) {
    // Group variables by key.
    // For each key, we want the value from the "most recent" step_run.
    // Resume artifacts (step_run_id = null) are used as fallback only
    // when no step_run has set that key.
    const grouped: Record<string, any[]> = {};
    for (const v of vars) {
      if (!grouped[v.key]) grouped[v.key] = [];
      grouped[v.key].push(v);
    }

    for (const [key, entries] of Object.entries(grouped)) {
      if (key in context) continue; // flow_run.input_variables takes priority

      // Separate step-run-scoped entries from resume artifacts
      const stepRunEntries = entries.filter(e => e.step_run_id != null);
      const resumeEntries = entries.filter(e => e.step_run_id == null);

      let chosen = null;

      // First pass: find a valid (non-null, non-"null", non-empty) value
      // across ALL entries regardless of step_run_id scope.  Prefer the
      // most recent valid entry.  This ensures a resume-stored value like
      // "saudi is a country" always wins over an older "null" string even
      // when both share the same step_run_id.
      const isValid = (v: any) =>
        v !== null && v !== undefined && v !== 'null' && v !== '';
      const allSorted = [...entries].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      const validEntry = allSorted.find(e => isValid(e.value));
      if (validEntry) {
        chosen = validEntry;
      } else if (stepRunEntries.length > 0) {
        // No valid value exists — use most recent step-run entry (even if null)
        stepRunEntries.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        chosen = stepRunEntries[0];
      } else if (resumeEntries.length > 0) {
        resumeEntries.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        chosen = resumeEntries[0];
      }

      if (chosen) {
        context[key] = chosen.value;
      }
    }
  }

  // Create top-level aliases for memory.* keys so that
  // [[var:intent]] resolves the same as [[var:memory.intent]].
  // This keeps step instructions simpler and maintains backward compatibility.
  const memoryKeys = Object.keys(context).filter(k => k.startsWith('memory.'));
  for (const mk of memoryKeys) {
    const shortKey = mk.slice('memory.'.length);
    if (!(shortKey in context)) {
      context[shortKey] = context[mk];
    }
  }

  return context;
}

/**
 * Retrieve refs by key, rule_id, or flow_run_id.
 * Refs support shell commands, tool references, documentation,
 * execution hints, rendering hints, and symbolic mappings.
 * The value field is treated as a structured payload (JSON), not plain text.
 */
async function getRefs(options: {
  flow_run_id?: string;
  key?: string;
  rule_id?: string;
  source?: string;
}): Promise<any[]> {
  let query = getSupabase().from('refs').select('*');
  if (options.flow_run_id) query = query.eq('flow_run_id', options.flow_run_id);
  if (options.key) query = query.eq('key', options.key);
  if (options.rule_id) query = query.eq('rule_id', options.rule_id);
  if (options.source) query = query.eq('source', options.source);
  const { data } = await query.order('created_at', { ascending: false });
  return data || [];
}

/**
 * Normalize variable aliases into canonical names.
 * Given a context with potentially multiple names for the same variable,
 * this ensures downstream steps only see canonical names.
 * Canonical values always win; aliases only fill missing canonical values.
 * Never overwrites a non-empty canonical value.
 */
function normalizeCanonicalVariables(
  context: Record<string, any>,
  aliases: Record<string, string[]>
): Record<string, any> {
  const normalized = { ...context };
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    // Skip if canonical already has a non-empty value
    const existing = normalized[canonical];
    if (existing !== undefined && existing !== null && existing !== '') {
      continue;
    }
    // Find first alias that has a non-empty value
    for (const alias of aliasList) {
      const value = normalized[alias];
      if (value !== undefined && value !== null && value !== '') {
        normalized[canonical] = value;
        break;
      }
    }
  }
  return normalized;
}

/**
 * Normalize raw user input against active terms.
 * Pipeline: raw input → alias matching → canonical symbolic replacement → variable extraction.
 * Preserves raw_input, normalized_input, and symbolic_input separately.
 * Never mutates original raw input. No embeddings, no vector logic.
 *
 * Architecture:
 *   User Prompt → normalization → canonical symbolic terms → step contracts → execution
 *   User language is just translated into canonical symbolic language.
 */
export async function normalizeUserInput(
  input: string,
  flowRunId: string
): Promise<{ canonical: string; symbolic: string; matchedTerms: string[]; variables: Record<string, string> }> {
  const matchedTerms: string[] = [];
  let symbolic = input;

  // Fetch active terms
  const { data: terms } = await getSupabase()
    .from('terms')
    .select('name, aliases')
    .eq('is_active', true);

  if (terms) {
    for (const term of terms) {
      const aliases: string[] = [term.name, ...(term.aliases || [])];
      for (const alias of aliases) {
        if (!alias || typeof alias !== 'string') continue;
        const idx = symbolic.toLowerCase().indexOf(alias.toLowerCase());
        if (idx !== -1) {
          matchedTerms.push(term.name);
          // Replace with canonical name (preserve case of canonical)
          symbolic = symbolic.slice(0, idx) + term.name + symbolic.slice(idx + alias.length);
          break;
        }
      }
    }
  }

  // Deduplicate matched terms
  const uniqueTerms = [...new Set(matchedTerms)];

  const variables: Record<string, string> = {
    raw_input: input,
    normalized_input: symbolic,
    symbolic_input: symbolic,
    matched_terms: JSON.stringify(uniqueTerms),
  };

  return { canonical: symbolic, symbolic, matchedTerms: uniqueTerms, variables };
}

/**
 * Parse a [[var:key:param=value:...]] tag string into its parts.
 * Returns { key, params } where params is a record of filter key→value pairs.
 */
function parseVarTag(tag: string): { key: string; params: Record<string, string> } {
  const parts = tag.split(':').map(s => s.trim());
  const key = parts[0];
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eqIdx = parts[i].indexOf('=');
    if (eqIdx > 0) {
      params[parts[i].slice(0, eqIdx)] = parts[i].slice(eqIdx + 1);
    }
  }
  return { key, params };
}

/**
 * Resolve [[var:key]] and [[var:key:filter=value]] tags.
 *
 * Simple tags (no filters) are resolved from the in-memory context.
 * Parameterised tags that are NOT in context are resolved by querying
 * the Supabase `variables` table with the supplied filter pairs.
 * Falls back to leaving the tag literal if nothing is found.
 */
async function resolveVariables(input: any, context: Record<string, any>): Promise<any> {
  if (typeof input === 'string') {
    // ---- First pass: extract all tags, resolve from context or collect DB queries ----
    const regex = /\[\[var:([^\]]+)\]\]/g;
    const segments: string[] = [];
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    interface DbQuery { tag: string; key: string; params: Record<string, string>; segIdx: number }
    const dbQueries: DbQuery[] = [];

    while ((m = regex.exec(input)) !== null) {
      segments.push(input.slice(lastIdx, m.index));
      const fullMatch = m[0];
      const { key, params } = parseVarTag(m[1]);

      if (key in context) {
        const val = context[key];
        segments.push(typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val));
      } else if (Object.keys(params).length > 0) {
        // Has filters — resolve via Supabase
        dbQueries.push({ tag: fullMatch, key, params, segIdx: segments.length });
        segments.push(''); // placeholder
      } else {
        // Simple tag not in context — leave literal
        segments.push(fullMatch);
      }
      lastIdx = regex.lastIndex;
    }
    segments.push(input.slice(lastIdx));

    // ---- Second pass: resolve all DB queries in parallel ----
    if (dbQueries.length > 0) {
      const results = await Promise.all(
        dbQueries.map(async ({ key, params }) => {
          try {
            let query = getSupabase().from('variables').select('value').eq('key', key);
            for (const [k, v] of Object.entries(params)) {
              query = query.eq(k, v);
            }
            const { data } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
            return data?.value ?? null;
          } catch {
            return null;
          }
        }),
      );

      for (let i = 0; i < dbQueries.length; i++) {
        if (results[i] !== null && results[i] !== undefined) {
          segments[dbQueries[i].segIdx] = String(results[i]);
        } else {
          // Query returned nothing — leave original tag literal
          segments[dbQueries[i].segIdx] = dbQueries[i].tag;
        }
      }
    }

    return segments.join('');
  }

  if (Array.isArray(input)) {
    return Promise.all(input.map(item => resolveVariables(item, context)));
  }

  if (input && typeof input === 'object') {
    const result: Record<string, any> = {};
    await Promise.all(
      Object.entries(input).map(async ([k, v]) => {
        result[k] = await resolveVariables(v, context);
      }),
    );
    return result;
  }

  return input;
}

function normalizeValue(value: any): any {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeValue).filter(v => v !== undefined);
  }

  if (value && typeof value === 'object') {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      result[k] = normalizeValue(v);
    }
    return result;
  }

  return value;
}

function deepMerge(base: any, override: any): any {
  if (typeof base !== 'object' || base === null) return override;
  if (typeof override !== 'object' || override === null) return override;
  if (Array.isArray(base) || Array.isArray(override)) return override;

  const result: Record<string, any> = { ...base };

  for (const key of Object.keys(override)) {
    result[key] = deepMerge(base[key], override[key]);
  }

  return result;
}

/**
 * Safely attempt to parse a string as JSON.
 * Returns the parsed object on success, or null on failure.
 */
function tryParseJson(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// --- Action validation helpers ---

async function fetchStepRun(stepRunId: string): Promise<any> {
  const { data } = await getSupabase()
    .from('step_runs')
    .select('*')
    .eq('id', stepRunId)
    .maybeSingle();
  // Kong stores result data in output column
  if (data && data.output && !data.result) {
    data.result = data.output;
  }
  return data;
}

function getResult(stepRun: any): Record<string, any> {
  const r = stepRun.result || stepRun.output;
  return r && typeof r === 'object' ? r : {};
}

async function failStepRun(stepRunId: string, error: string, result: any): Promise<void> {
  await updateStepRun(stepRunId, { status: 'failed', error, result });
}

function getRulesAndPlans(step: any, context: Record<string, any>): string[] {
  const items: string[] = [];
  if (context.plan_id) items.push(context.plan_id);
  return items;
}

/**
 * Extract the base path from a URL (the pathname up to the first dynamic segment).
 * e.g. "https://ai.anyapp.cfd/api/step-runs/[[var:var_failed_step_run_id]]" -> "/api/step-runs/"
 * e.g. "https://prolog.anyapp.cfd/api/v1/query" -> "/api/v1/query"
 */
function extractBasePath(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    // Strip trailing dynamic segments ([[var:...]])
    const base = pathname.replace(/\/\[\[var:[^\]]+\]\](\/.*)?$/, '/');
    return base || '/';
  } catch {
    // If URL parsing fails, use the raw string
    return url;
  }
}

/**
 * Generate a Zod schema from a sample_request object.
 * For each key in the sample, creates a corresponding Zod validator.
 * Supports nested objects and arrays.
 */
function zodSchemaFromSample(sample: any): z.ZodTypeAny {
  if (sample === null || sample === undefined) {
    return z.any();
  }
  if (typeof sample === 'string') {
    return z.string();
  }
  if (typeof sample === 'number') {
    return z.number();
  }
  if (typeof sample === 'boolean') {
    return z.boolean();
  }
  if (Array.isArray(sample)) {
    if (sample.length > 0) {
      return z.array(zodSchemaFromSample(sample[0]));
    }
    return z.array(z.any());
  }
  if (typeof sample === 'object') {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(sample)) {
      shape[key] = zodSchemaFromSample(value);
    }
    return z.object(shape);
  }
  return z.any();
}

/**
 * Execute a single API action.
 * Looks up the endpoint in the registry, validates, executes the HTTP request,
 * stores the result as a variable, and returns structured result.
 */
async function executeAction(
  action: any,
  context: Record<string, any>,
  stepRunId: string,
  flowRunId: string,
  step: any,
): Promise<{ data?: any; error?: any; status?: string }> {
  // Auto-fill type, method, and path from endpoint registry
  if (action.endpoint && (!action.type || !action.method || !action.path)) {
    const { data: endpoint } = await getSupabase()
      .from('endpoint_registry')
      .select('*')
      .eq('id', action.endpoint)
      .maybeSingle();
    if (endpoint) {
      if (!action.type) action.type = 'api';
      if (!action.method) action.method = endpoint.method || 'GET';
      if (!action.path) action.path = endpoint.url;
    }
  }

  if (action.type !== 'api') return { data: null };

  // Validate required fields
  if (!action.endpoint) {
    return { error: { message: `Invalid action: missing required field 'endpoint'`, action } };
  }

  // Look up endpoint in registry
  const { data: endpoint } = await getSupabase()
    .from('endpoint_registry')
    .select('*')
    .eq('id', action.endpoint)
    .maybeSingle();

  if (!endpoint && !action.path) {
    return { error: { message: `Invalid action: missing required field 'path' (endpoint '${action.endpoint}' not found in registry)`, action } };
  }
  if (endpoint) {
    if (!action.method) action.method = endpoint.method || 'GET';
    if (!action.path) action.path = endpoint.url;
  }

  const actionMethod = (action.method || 'GET').toUpperCase();

  if (endpoint) {
    const endpointMethod = (endpoint.method || 'GET').toUpperCase();
    if (actionMethod !== endpointMethod) {
      return { error: { message: `Method mismatch for endpoint '${action.endpoint}': action uses '${actionMethod}', endpoint expects '${endpointMethod}'`, action } };
    }
    if (!endpoint.url.includes('[[var:') && action.path) {
      const endpointBasePath = extractBasePath(endpoint.url);
      const resolvedActionPath = await resolveVariables(action.path, context);
      const actionPathNoQuery = resolvedActionPath.split('?')[0];
      const endpointUrlNoQuery = endpoint.url.split('?')[0];
      const isRelativeMatch = resolvedActionPath.startsWith(endpointBasePath);
      const isFullUrlMatch = actionPathNoQuery === endpointUrlNoQuery;
      if (!isRelativeMatch && !isFullUrlMatch) {
        return { error: { message: `Path mismatch for endpoint '${action.endpoint}': action path '${resolvedActionPath}' does not start with endpoint base path '${endpointBasePath}'`, action } };
      }
    }
  }

  // Validate output_var
  if (action.output_var && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(action.output_var)) {
    return { error: { message: `Invalid output_var '${action.output_var}' for endpoint '${action.endpoint}': must be a valid identifier`, action } };
  }

  // Validate payload against endpoint sample_request schema
  if (endpoint?.sample_request != null) {
    try {
      const payloadSchema = zodSchemaFromSample(endpoint.sample_request);
      if (action.payload) {
        const resolvedPayload = await resolveVariables(action.payload, context);
        payloadSchema.parse(resolvedPayload);
      } else if (actionMethod !== 'GET' && actionMethod !== 'HEAD') {
        return { error: { message: `Missing payload for endpoint '${action.endpoint}': expected payload matching sample_request`, action } };
      }
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        const details = err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
        return { error: { message: `Invalid payload for endpoint '${action.endpoint}': ${details}`, action } };
      }
      throw err;
    }
  }

  // Resolve URL and headers
  let url = normalizeValue(await resolveVariables(action.endpoint, context));
  let headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...normalizeValue(await resolveVariables(action.headers || {}, context)),
  };

  if (endpoint) {
    url = normalizeValue(await resolveVariables(endpoint.url, context));
    headers = { ...(endpoint.headers || {}), ...headers };
  }

  const httpMethod = actionMethod;
  let mergedPayload: any = undefined;

  if (httpMethod !== 'GET' && httpMethod !== 'HEAD') {
    if (endpoint?.sample_request) {
      mergedPayload = { ...endpoint.sample_request };
    }
    if (action.payload) {
      const resolvedPayload = normalizeValue(await resolveVariables(action.payload, context));
      mergedPayload = mergedPayload ? deepMerge(mergedPayload, resolvedPayload) : resolvedPayload;
    }
  }

  console.log(`[engine] executing action: ${httpMethod} ${url}`);

  try {
    let res: Response;
    let responseBody: string | null = null;
    try {
      res = await fetch(url, {
        method: httpMethod,
        headers,
        body: mergedPayload ? JSON.stringify(mergedPayload) : undefined,
      });
      try { responseBody = await res.text(); } catch { /* ignore read errors */ }
    } catch (err: any) {
      return { error: { message: err?.message || String(err), action, stack: err?.stack } };
    }

    // Persist to api_calls table
    await getSupabase().from('api_calls').insert({
      id: randomUUID(),
      flow_run_id: flowRunId,
      step_run_id: stepRunId,
      endpoint_name: url,
      http_method: httpMethod,
      request_url: url,
      request_headers: headers,
      request_body: mergedPayload,
      response_status: res.status,
      response_body: responseBody,
      success: res.ok,
      error: res.ok ? null : `HTTP ${res.status}`,
      created_at: new Date().toISOString(),
    });

    if (res.ok && responseBody) {
      try {
        const parsed = JSON.parse(responseBody);
        const varName = `api_response_${action.endpoint}`;
        await insertVariable({
          id: randomUUID(),
          flow_run_id: flowRunId,
          step_run_id: stepRunId,
          key: varName,
          value: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
          scope: 'step_run',
          created_at: new Date().toISOString(),
        });
        context[varName] = parsed;

        if (action.output_var) {
          await insertVariable({
            id: randomUUID(),
            flow_run_id: flowRunId,
            step_run_id: stepRunId,
            key: action.output_var,
            value: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
            scope: 'flow_run',
            created_at: new Date().toISOString(),
          });
          context[action.output_var] = parsed;
        }

        return { data: parsed };
      } catch {
        return { data: responseBody };
      }
    }

    if (!res.ok) {
      const bodyStr = responseBody || '';
      const shouldPause = await handleApiFailure(bodyStr, res.status, url, context, stepRunId, flowRunId, step);
      if (shouldPause === 'paused') {
        return { status: 'paused' };
      }
      return { error: { statusCode: res.status, body: bodyStr, url } };
    }

    return { data: null };
  } catch (err: any) {
    return { error: { message: err?.message || String(err), action, stack: err?.stack } };
  }
}
export async function createExecution(flowId: string, _name?: string, inputVariables?: Record<string, any>): Promise<string> {
  return createFlowRun(flowId, inputVariables);
}
