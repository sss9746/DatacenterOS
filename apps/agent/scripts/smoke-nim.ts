// P3-0 NIM smoke test: `pnpm --filter agent smoke`.
// Checks /models for NIM_MODEL + NIM_FALLBACK_MODEL, then sends one get_job_state tool request per model
// with thinking disabled and enabled. Exit 0 only if the primary returned a valid tool call.
// Exit 2 = missing config (no network calls made). Never prints the API key.

import { ConfigError, loadConfig, redactString, type AgentConfig } from '../src/config.js';
import { createNimLlm, validateToolArgs, type NimLlmEvent, type ThinkingMode } from '../src/llm.js';
import type { LlmChatRequest } from '../src/ports.js';

const REQUEST: LlmChatRequest = {
  messages: [
    { role: 'system', content: 'You are a GPU-cluster incident engineer. Use tools to answer; never guess state.' },
    { role: 'user', content: 'What is the state of job-a?' },
  ],
  tools: [
    {
      name: 'get_job_state',
      description: 'Return the current state of the given training jobs.',
      parameters: {
        type: 'object',
        properties: { job_ids: { type: 'array', items: { type: 'string' } } },
        required: ['job_ids'],
      },
    },
  ],
  toolChoice: 'auto',
  maxTokens: 512,
};

interface Target {
  label: 'primary' | 'fallback';
  baseURL: string;
  model: string;
}

interface Trial {
  thinking: ThinkingMode;
  latencyMs: number;
  ok: boolean;
  toolCall: boolean;
  args?: unknown;
  flagRejected: boolean;
  note: string;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function loadOrExit(): AgentConfig {
  try {
    return loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) fail(`smoke-nim: ${e.message}`);
    throw e;
  }
}

async function listModels(cfg: AgentConfig, baseURL: string): Promise<string[] | string> {
  try {
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${cfg.NIM_API_KEY}` },
      signal: AbortSignal.timeout(cfg.LLM_TIMEOUT_MS),
    });
    if (!res.ok) return `HTTP ${res.status}`;
    const body = (await res.json()) as { data?: { id?: string }[] };
    return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
  } catch (e) {
    return redactString(`error: ${(e as Error).message}`, cfg);
  }
}

async function trial(cfg: AgentConfig, t: Target, thinking: ThinkingMode): Promise<Trial> {
  let flagRejected = false;
  const onEvent = (e: NimLlmEvent) => {
    if (e.type === 'thinking_flag_rejected') flagRejected = true;
  };
  const single: AgentConfig = { ...cfg, NIM_BASE_URL: t.baseURL, NIM_MODEL: t.model, NIM_FALLBACK_MODEL: undefined };
  const llm = createNimLlm(single, { thinking, maxRetries: 0, useFallback: false, onEvent });
  const t0 = performance.now();
  try {
    const res = await llm.chat(REQUEST);
    const latencyMs = Math.round(performance.now() - t0);
    const call = res.toolCalls.find((c) => c.name === 'get_job_state');
    const valid = call !== undefined && validateToolArgs([call]).length === 0;
    return {
      thinking,
      latencyMs,
      ok: true,
      toolCall: valid,
      args: valid ? JSON.parse(call.argumentsJson) : undefined,
      flagRejected,
      note: valid
        ? `finish=${res.finishReason ?? '?'} model=${res.model}`
        : `no valid tool call (finish=${res.finishReason ?? '?'}, content=${JSON.stringify((res.content ?? '').slice(0, 120))})`,
    };
  } catch (e) {
    return {
      thinking,
      latencyMs: Math.round(performance.now() - t0),
      ok: false,
      toolCall: false,
      flagRejected,
      note: redactString((e as Error).message, cfg),
    };
  }
}

async function main(): Promise<void> {
  const cfg = loadOrExit();
  if (!cfg.NIM_API_KEY) {
    fail(
      'smoke-nim: NIM_API_KEY is not set. Get an nvapi- key at build.nvidia.com (see apps/agent/NIM-SETUP.md) ' +
        'and put NIM_API_KEY / NIM_MODEL in the repo-root .env.local. No requests were sent.',
    );
  }
  if (!cfg.NIM_MODEL) fail('smoke-nim: NIM_MODEL is not set (e.g. nvidia/nemotron-3-super-120b-a12b). No requests were sent.');

  const targets: Target[] = [{ label: 'primary', baseURL: cfg.NIM_BASE_URL ?? cfg.NIM_FALLBACK_BASE_URL, model: cfg.NIM_MODEL }];
  if (cfg.NIM_FALLBACK_MODEL) targets.push({ label: 'fallback', baseURL: cfg.NIM_FALLBACK_BASE_URL, model: cfg.NIM_FALLBACK_MODEL });

  console.log(`smoke-nim: timeout ${cfg.LLM_TIMEOUT_MS} ms, max_tokens cap ${cfg.LLM_MAX_TOKENS}`);

  // 1. /models
  const modelLists = new Map<string, string[] | string>();
  for (const t of targets) {
    if (!modelLists.has(t.baseURL)) modelLists.set(t.baseURL, await listModels(cfg, t.baseURL));
    const list = modelLists.get(t.baseURL)!;
    const status = typeof list === 'string' ? `could not list (${list})` : list.includes(t.model) ? 'listed' : 'NOT listed';
    console.log(`[models] ${t.label} ${t.model} @ ${t.baseURL}: ${status}`);
    if (typeof list !== 'string' && !list.includes(t.model)) {
      const nemotron = list.filter((id) => /nemotron/i.test(id)).slice(0, 10);
      if (nemotron.length) console.log(`         nemotron ids available: ${nemotron.join(', ')}`);
    }
  }

  // 2. Tool-call trials
  const results = new Map<string, Trial[]>();
  for (const t of targets) {
    const trials: Trial[] = [];
    for (const thinking of ['disabled', 'enabled'] as const) {
      const r = await trial(cfg, t, thinking);
      trials.push(r);
      const flag = r.flagRejected ? ' (thinking flag rejected by server; sent without it)' : '';
      console.log(
        `[chat] ${t.label} ${t.model} thinking=${thinking}: ${r.latencyMs} ms, tool_call=${r.toolCall ? 'yes' : 'no'}` +
          (r.toolCall ? ` args=${JSON.stringify(r.args)}` : '') +
          ` | ${r.note}${flag}`,
      );
      if (r.flagRejected) break; // enabled vs disabled is meaningless if the server ignores the flag
    }
    results.set(t.label, trials);
  }

  // 3. Recommendation
  const best = (label: string) =>
    (results.get(label) ?? []).filter((r) => r.toolCall).sort((a, b) => a.latencyMs - b.latencyMs)[0];
  const p = best('primary');
  const f = best('fallback');
  const mode = (r: Trial) => (r.flagRejected ? 'flag unsupported' : r.thinking);
  const primaryModel = targets[0]!.model;
  const fallbackModel = targets[1]?.model;
  let rec: string;
  if (p && f) {
    rec =
      f.latencyMs < p.latencyMs * 0.5
        ? `both work; ${fallbackModel} is >2x faster (${f.latencyMs} vs ${p.latencyMs} ms), consider it as primary for the loop`
        : `use ${primaryModel} as primary (thinking=${mode(p)}, ${p.latencyMs} ms), ${fallbackModel} as fallback`;
  } else if (p) {
    rec = `use ${primaryModel} as primary (thinking=${mode(p)}, ${p.latencyMs} ms); fallback ${fallbackModel ?? '(unset)'} did not return a valid tool call`;
  } else if (f) {
    rec = `primary ${primaryModel} failed; swap: set NIM_MODEL=${fallbackModel} (thinking=${mode(f)}, ${f.latencyMs} ms)`;
  } else {
    rec = 'no model returned a valid tool call; check the key, model ids (/models above) and tool-calling support';
  }
  console.log(`RECOMMENDATION: ${rec}`);
  process.exit(p ? 0 : 1);
}

main().catch((e: unknown) => {
  const msg = (e as Error)?.message ?? String(e);
  let safe = msg;
  try {
    safe = redactString(msg, loadConfig());
  } catch {
    /* config already failed; message came from it */
  }
  console.error(`smoke-nim: ${safe}`);
  process.exit(1);
});
