// F-NV1 agent event publisher (P3-6). Emits compact, redacted feed rows: tool calls + a one-line
// summary. NEVER raw chain-of-thought (CONTRACTS §0.8). Publishing failures never crash the agent.

import type { AgentActor, AgentEventInput, AgentStage, DbPort, ToolCallSummary } from './ports.js';

export const MAX_SUMMARY_CHARS = 200;
export const MAX_TOOL_FIELD_CHARS = 160;
export const MAX_EVIDENCE_IDS = 20;
export const MAX_PENDING_EVENTS = 200;

/** Keys whose values are model reasoning; stripped from any object we summarize. */
const FORBIDDEN_KEYS = new Set([
  'reasoning',
  'reasoning_content',
  'thought',
  'thoughts',
  'chain_of_thought',
  'chainofthought',
  'cot',
  'scratchpad',
]);
const SECRET_KEY_RE = /^(api_?key|authorization|token|secret|password)$/i;
const NVAPI_RE = /nvapi-[A-Za-z0-9_-]+/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

export interface EventPublisherDeps {
  db: DbPort;
  runId: string;
  clock: { simTimeMs(): number; unixMs(): number };
  redact: (s: string) => string;
  /** First sequence number to use (resumed agents pass the next unused seq). Default 1. */
  startSeq?: number;
}

export interface EmitInput {
  workflowId?: string | null;
  incidentId?: string | null;
  summary: string;
  evidenceIds?: string[];
  toolCalls?: ToolCallSummary[];
  /** Overrides the derived event actor. */
  actor?: AgentActor;
}

export interface EventPublisher {
  emit(stage: AgentStage, input: EmitInput): Promise<AgentEventInput>;
  /** Number of events buffered because publishing failed. */
  pending(): number;
  /** Next sequence number that will be assigned. */
  nextSeq(): number;
}

const trim = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** Deep copy dropping forbidden keys and masking secret-named keys. */
function sanitize(v: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (Array.isArray(v)) return v.map((x) => sanitize(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) continue;
      out[k] = SECRET_KEY_RE.test(k) ? '***' : sanitize(x, depth + 1);
    }
    return out;
  }
  if (typeof v === 'bigint') return v.toString();
  return v;
}

/** Compact JSON (no spaces) of a sanitized value; strings pass through as-is. */
function compact(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(sanitize(v));
  } catch {
    return String(v);
  }
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const round = (n: number): string => String(Math.round(n * 100) / 100);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Compact human summary of one tool call, e.g.
 * `simulate_plan(job-a: checkpoint→migrate r7)` → `lost 0 wu · delay 150 s`.
 * Output is NOT redacted/trimmed here; the publisher does that on emit.
 */
export function summarizeToolCall(
  name: string,
  args: unknown,
  result: unknown,
  actor?: AgentActor,
): ToolCallSummary {
  const base = { tool: name, args_summary: summarizeArgs(args), result_summary: summarizeResult(result) };
  return actor ? { ...base, actor } : base;
}

function summarizeArgs(args: unknown): string {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : undefined;
  const commands = a?.['commands'];
  if (Array.isArray(commands) && commands.length > 0) {
    const parts = commands.map((c) => {
      const cmd = (c ?? {}) as Record<string, unknown>;
      const op = str(cmd['operation']) || '?';
      const job = str(cmd['job_id']) || str(cmd['target_id']);
      const dest = str(cmd['dest_rack_id']) || str(cmd['destination_id']);
      return `${job ? `${job}: ` : ''}${op}${dest ? ` ${dest}` : ''}`;
    });
    return parts.join('→');
  }
  return compact(args);
}

function summarizeResult(result: unknown): string {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    const lost = num(r['expected_lost_work_units']);
    const delay = num(r['expected_completion_delay_sim_s']);
    if (lost !== undefined || delay !== undefined) {
      const parts: string[] = [];
      if (lost !== undefined) parts.push(`lost ${round(lost)} wu`);
      if (delay !== undefined) parts.push(`delay ${round(delay)} s`);
      const viol = r['violations'];
      if (Array.isArray(viol) && viol.length > 0) parts.push(`violations ${viol.length}`);
      return parts.join(' · ');
    }
    if (typeof r['allowed'] === 'boolean') {
      const v = Array.isArray(r['violations']) ? (r['violations'] as unknown[]).map(String) : [];
      return r['allowed'] ? 'allowed' : `denied${v.length ? `: ${v.join(',')}` : ''}`;
    }
  }
  return compact(result);
}

export function createEventPublisher(deps: EventPublisherDeps): EventPublisher {
  const { db, runId, clock, redact } = deps;
  let seq = Math.max(1, Math.floor(deps.startSeq ?? 1));
  const buffer: AgentEventInput[] = [];
  let chain: Promise<unknown> = Promise.resolve();

  const clean = (s: string, max: number): string => {
    const scrubbed = redact(s).replace(NVAPI_RE, '***').replace(BEARER_RE, 'Bearer ***');
    return trim(scrubbed, max);
  };

  const tryPublish = async (ev: AgentEventInput): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await db.publishAgentEvent(ev);
        return true;
      } catch {
        // retry once, then give up for now
      }
    }
    return false;
  };

  const bufferEvent = (ev: AgentEventInput): void => {
    buffer.push(ev);
    while (buffer.length > MAX_PENDING_EVENTS) buffer.shift();
  };

  const flush = async (): Promise<void> => {
    while (buffer.length > 0) {
      const head = buffer[0] as AgentEventInput;
      if (!(await tryPublish(head))) return;
      buffer.shift();
    }
  };

  const deliver = async (ev: AgentEventInput): Promise<void> => {
    if (buffer.length > 0) {
      // Preserve order: older buffered events go first.
      bufferEvent(ev);
      await flush();
      return;
    }
    if (await tryPublish(ev)) return;
    bufferEvent(ev);
  };

  return {
    emit(stage, input) {
      const toolCalls = input.toolCalls ?? [];
      const ev: AgentEventInput = {
        agent_event_id: `ae-${runId}-${String(seq++).padStart(6, '0')}`,
        run_id: runId,
        workflow_id: input.workflowId ?? null,
        incident_id: input.incidentId ?? null,
        stage,
        summary: clean(input.summary, MAX_SUMMARY_CHARS),
        evidence_ids: [...new Set(input.evidenceIds ?? [])].slice(0, MAX_EVIDENCE_IDS),
        tool_calls: toolCalls.map((t) => ({
          tool: clean(t.tool, 64),
          args_summary: clean(t.args_summary, MAX_TOOL_FIELD_CHARS),
          result_summary: clean(t.result_summary, MAX_TOOL_FIELD_CHARS),
          ...(t.actor ? { actor: t.actor } : {}),
        })),
        actor: input.actor ?? (toolCalls.some((t) => t.actor === 'nemotron') ? 'nemotron' : 'code'),
        sim_time_ms: clock.simTimeMs(),
        observed_unix_ms: clock.unixMs(),
      };
      const run = chain.then(() => deliver(ev));
      chain = run.catch(() => undefined);
      return run.then(() => ev);
    },
    pending: () => buffer.length,
    nextSeq: () => seq,
  };
}
