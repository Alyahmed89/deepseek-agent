import { randomUUID } from "crypto";
import { getSupabase } from "../supabase";
import { callLlm } from "./llm";
import { z } from "zod";

const PROLOG_URL = process.env.PROLOG_URL || "https://prolog.anyapp.cfd";
const runningFlows = new Set<string>();

async function getAllKnowledge(): Promise<any[]> {
  const { data, error } = await getSupabase().from("knowledge").select("id, prolog");
  if (error) { console.error("[getAllKnowledge] error:", error); return []; }
  return data || [];
}

export async function logToKnowledge(flowRunId: string, stepRunId: string, type: string, message: string, details: any): Promise<void> {
  try {
    const id = `log_${randomUUID().replace(/-/g, "")}`;
    const det = JSON.stringify(details).replace(/'/g, "''");
    const msg = message.replace(/'/g, "''");
    const prolog = `log('${id}', '${flowRunId}', '${stepRunId}', '${type}', '${msg}', '${det}').`;
    await getSupabase().from("knowledge").insert({ id, prolog });
  } catch(e) { console.error("[logToKnowledge] failed:", e); }
}

export async function createExecution(flowId: string, name?: string, input?: Record<string, any>): Promise<string> {
  const id = randomUUID();
  const now = Math.floor(Date.now()/1000);
  const prolog = `execution('${id}', '${flowId}').\nexecution_status('${id}', 'pending').\nexecution_created('${id}', ${now}).`;
  await getSupabase().from("knowledge").insert({ id, prolog });
  return id;
}

async function getExecution(executionId: string): Promise<any> {
  const { data, error } = await getSupabase().from("knowledge").select("id, prolog").eq("id", executionId).single();
  if (error) { console.error("[getExecution] error:", error); return null; }
  const prolog = data?.prolog || "";
  const flowIdMatch = prolog.match(/execution\('[^']+',\s*'([^']+)'\)/);
  const statusMatch = prolog.match(/execution_status\([^,]+,\s*'?([^')]+)'?\)/);
  const pausedMatch = prolog.match(/paused_at_step\([^,]+,\s*'?([^')]+)'?\)/);
  return { id: executionId, flow_id: flowIdMatch?.[1], status: statusMatch?.[1], paused_at_step_id: pausedMatch?.[1], prolog };
}

async function updateExecution(executionId: string, updates: Record<string, any>): Promise<void> {
  const current = await getExecution(executionId);
  let prolog = current?.prolog || "";
  for (const [key, val] of Object.entries(updates)) {
    const escaped = String(val).replace(/'/g, "''");
    const fact = `${key}('${executionId}', '${escaped}').`;
    const existingRe = new RegExp(`${key}\\('${executionId}',[^)]+\\)\\.`);
    if (existingRe.test(prolog)) { prolog = prolog.replace(existingRe, fact); }
    else { prolog += `\n${fact}`; }
  }
  await getSupabase().from("knowledge").update({ prolog }).eq("id", executionId);
}

async function resolveTags(text: string, execId: string, allKnowledge: any[]): Promise<string> {
  const tagRe = /\[\[(\w+):([^\]]+)\]\]/g;
  let result = text;
  const matches = [...text.matchAll(tagRe)];
  for (const match of matches) {
    const [full, tagType, key] = match;
    let resolved = "";
    if (tagType === "input") {
      const row = allKnowledge.find((k: any) => (k.prolog || "").includes(`input('${execId}', '${key}'`));
      if (row) {
        const m = row.prolog.match(new RegExp(`input\\('[^']+',\\s*'${key}',\\s*'([^']+)'\\)`));
        resolved = m?.[1] || "";
      }
    } else if (tagType === "store") {
      const row = allKnowledge.find((k: any) => (k.prolog || "").includes(`store('${execId}', '${key}'`));
      if (row) {
        const m = row.prolog.match(new RegExp(`store\\('[^']+',\\s*'${key}',\\s*'([^']+)'\\)`));
        resolved = m?.[1] || "";
      }
    } else if (tagType === "fact") {
      const row = allKnowledge.find((k: any) => (k.prolog || "").includes(`${key}(`));
      if (row) {
        const m = row.prolog.match(new RegExp(`${key}\\([^)]+\\)`));
        resolved = m?.[0] || "";
      }
    }
    result = result.replace(full, resolved);
  }
  return result;
}

function findStepById(stepKnowledge: any, stepId: string): boolean {
  return (stepKnowledge.prolog || "").includes(`'${stepId}'`);
}

export async function runFlow(flowExecutionId: string): Promise<void> {
  if (runningFlows.has(flowExecutionId)) {
    console.log(`[engine] already running ${flowExecutionId}, skipping`);
    return;
  }
  runningFlows.add(flowExecutionId);
  console.log(`[engine] runFlow start ${flowExecutionId}`);
  try {
    const flowExec = await getExecution(flowExecutionId);
    if (!flowExec?.flow_id) throw new Error(`Execution ${flowExecutionId} has no flow_id`);
    await updateExecution(flowExecutionId, { status: "running" });
    await logToKnowledge(flowExecutionId, "engine", "engine", "Flow started", { flow_id: flowExec.flow_id });

    const knowledge = await getAllKnowledge();
    const steps = knowledge.filter((o: any) => {
      const facts = o.prolog || "";
      return facts.includes("step_type(") || facts.includes("step_id(");
    });

    const execProlog = flowExec.prolog || "";
    const firstStepMatch = execProlog.match(/next_step\(start,\s*'?([^')]+)'?\)/);
    const firstStepId = flowExec.paused_at_step_id || firstStepMatch?.[1] || "step-0-wait";
    let currentStep = steps.find((s: any) => findStepById(s, firstStepId)) || steps[0] || null;

    while (currentStep) {
      const facts = currentStep.prolog || "";
      const stepIdMatch = facts.match(/step_id\([^,]+,\s*'?([^')]+)'?\)/);
      const stepId = stepIdMatch?.[1] || "unknown";
      const stepRunId = `sr_${randomUUID().replace(/-/g, "")}`;
      const stepTypeMatch = facts.match(/step_type\([^,]+,\s*'?(\w+)'?\)/);
      const stepType = stepTypeMatch?.[1] || "llm";

      await logToKnowledge(flowExecutionId, stepRunId, "step_start", `Starting ${stepId} type=${stepType}`, { step_id: stepId, step_type: stepType, step_run_id: stepRunId });

      const freshKnowledge = await getAllKnowledge();
      const stepResult = await runStep(currentStep, flowExecutionId, flowExec, freshKnowledge, stepRunId);

      if (stepResult?.status === "paused") {
        await logToKnowledge(flowExecutionId, stepRunId, "pause_wait", `Paused at ${stepId}`, { step_id: stepId, step_run_id: stepRunId });
        await updateExecution(flowExecutionId, { status: "paused", paused_at_step: stepId });
        return;
      }

      const nextStepId = stepResult?.next_step_id || null;
      await logToKnowledge(flowExecutionId, stepRunId, "step_complete", `${stepId} done, next=${nextStepId || "end"}`, { step_id: stepId, next_step_id: nextStepId, step_run_id: stepRunId });

      if (nextStepId && nextStepId !== "__end__") {
        await logToKnowledge(flowExecutionId, stepRunId, "step_transition", `${stepId} -> ${nextStepId}`, { from: stepId, to: nextStepId });
      }

      if (!nextStepId || nextStepId === "__end__") break;
      currentStep = steps.find((s: any) => findStepById(s, nextStepId)) || null;
    }

    await updateExecution(flowExecutionId, { status: "completed" });
    await logToKnowledge(flowExecutionId, "engine", "flow_end", "Flow completed", {});
  } catch (err) {
    await logToKnowledge(flowExecutionId, "engine", "flow_error", String(err), {});
    await updateExecution(flowExecutionId, { status: "failed" });
  } finally {
    runningFlows.delete(flowExecutionId);
  }
}

export async function runStep(stepKnowledge: any, flowExecutionId: string, flowExec: any, allKnowledge: any[], stepRunId: string): Promise<any> {
  const facts = stepKnowledge.prolog || "";
  const typeMatch = facts.match(/step_type\([^,]+,\s*'?(\w+)'?\)/);
  const stepType = typeMatch ? typeMatch[1] : "llm";
  const stepId = facts.match(/step_id\([^,]+,\s*'?([^')]+)'?\)/)?.[1] || "unknown";

  await logToKnowledge(flowExecutionId, stepRunId, "run_step", `Running ${stepType} step ${stepId}`, { step_type: stepType, step_id: stepId });

  if (stepType === "pause") {
    const inputFact = allKnowledge.find((k: any) => (k.prolog || "").includes(`input('${flowExecutionId}'`));
    if (!inputFact) {
      await logToKnowledge(flowExecutionId, stepRunId, "pause_wait", "No input found, pausing", {});
      return { status: "paused" };
    }
    const promptMatch = inputFact.prolog.match(/input\('[^']+',\s*'[^']+',\s*'([^']+)'\)/);
    const prompt = promptMatch?.[1] || "";
    const nextMatch = facts.match(/step_output_next\([^,]+,\s*'?([^')]+)'?\)/);
    const nextStepId = nextMatch?.[1] || null;
    await logToKnowledge(flowExecutionId, stepRunId, "pause_proceed", `Input found: ${prompt}`, { prompt, next_step_id: nextStepId });
    // Delete the input fact so next pause actually waits
    await getSupabase().from("knowledge").delete().eq("id", inputFact.id);
    return { prompt, next_step_id: nextStepId };
  }

  if (stepType === "action") {
    const urlMatch = facts.match(/action_url\([^,]+,\s*'([^']+)'\)/);
    const methodMatch = facts.match(/action_method\([^,]+,\s*'([^']+)'\)/);
    const bodyMatch = facts.match(/action_body\([^,]+,\s*'([^']+)'\)/);
    const url = urlMatch?.[1] || `${PROLOG_URL}/api/query`;
    const method = methodMatch?.[1] || "POST";
    const rawBody = bodyMatch?.[1] || "{}";
    const resolvedBody = await resolveTags(rawBody, flowExecutionId, allKnowledge);
    await logToKnowledge(flowExecutionId, stepRunId, "action_start", `Calling ${method} ${url}`, { url, method, body: resolvedBody });
    const actionResp = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: resolvedBody });
    const output = await actionResp.json().catch(() => ({}));
    const expectedMatch = facts.match(/expected_response\([^,]+,\s*'([^']+)'\)/);
    if (expectedMatch?.[1]) {
      try {
        const schema = z.object(JSON.parse(expectedMatch[1]));
        const result = schema.safeParse(output);
        await logToKnowledge(flowExecutionId, stepRunId, "zod_validation", result.success ? "Validation passed" : `Validation failed: ${JSON.stringify(result.error?.errors)}`, { success: result.success });
      } catch(e) { await logToKnowledge(flowExecutionId, stepRunId, "zod_error", `Schema parse error: ${e}`, {}); }
    }
    await logToKnowledge(flowExecutionId, stepRunId, "action_complete", "Action done", { output });
    const nextMatch = facts.match(/step_output_next\([^,]+,\s*'?([^')]+)'?\)/);
    return { ...(Array.isArray(output) ? { rows: output } : output), next_step_id: nextMatch?.[1] || null };
  }

  const instructionMatch = facts.match(/instruction\([^,]+,\s*'([^']+)'\)/);
  const rawInstruction = instructionMatch ? instructionMatch[1] : "Proceed.";
  const instruction = await resolveTags(rawInstruction, flowExecutionId, allKnowledge);
  const inputFacts = allKnowledge.filter((k: any) => (k.prolog || "").includes(`input('${flowExecutionId}'`));
  const inputContext = inputFacts.map((k: any) => k.prolog).join("\n");
  const system = `You are Jas. Respond in JSON. Context facts:\n${inputContext}`;
  const llmResult = await callLlm(system, instruction, undefined, {});
  const output = typeof llmResult === "string" ? (() => { try { return JSON.parse(llmResult); } catch { return { response: llmResult }; } })() : llmResult;
  const expectedMatch = facts.match(/expected_response\([^,]+,\s*'([^']+)'\)/);
  if (expectedMatch?.[1]) {
    try {
      const schema = z.object(JSON.parse(expectedMatch[1]));
      const result = schema.safeParse(output);
      await logToKnowledge(flowExecutionId, stepRunId, "zod_validation", result.success ? "Validation passed" : `Validation failed: ${JSON.stringify(result.error?.errors)}`, { success: result.success });
    } catch(e) { await logToKnowledge(flowExecutionId, stepRunId, "zod_error", `Schema parse error: ${e}`, {}); }
  }
  await logToKnowledge(flowExecutionId, stepRunId, "llm_complete", "LLM done", { output });
  const nextMatch = facts.match(/step_output_next\([^,]+,\s*'?([^')]+)'?\)/);
  return { ...output, next_step_id: nextMatch?.[1] || null };
}
