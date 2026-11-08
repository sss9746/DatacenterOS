// P3-9: the Nemotron incident-orchestration agent as a pure evaluation Policy (CONTRACTS §0.6).
// obs -> in-memory snapshot-db -> runTriage -> planIncidents -> ordered ActionCommand[].
// Never executes anything. Nemotron responses are cached on disk so evaluation reruns are
// reproducible; cache hits are counted so the scoreboard can disclose them (ARCHITECTURE §9).

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActionCommand, ObservedSnapshot, SignalEvent } from '@dcos/contracts';
import { loadConfig } from './config.js';
import { createNimLlm } from './llm.js';
import { planIncidents } from './planner.js';
import type { LlmChatRequest, LlmChatResponse, LlmPort, PhysicsPort, Policy } from './ports.js';
import { createSnapshotDb } from './snapshot-db.js';
import { incidentIdentity, runTriage } from './triage.js';

export interface PolicyStats {
  /** Policy invocations. */
  calls: number;
  /** Nemotron responses served from the disk cache. */
  cacheHits: number;
  /** Policy invocations that fell back to the deterministic path (no LLM, LLM error, or unusable reply). */
  llmFailures: number;
  /** Requests that reached the (cached or live) LLM port; cacheHits <= llmRequests. */
  llmRequests: number;
  /** Event-driven cadence: invocations answered [] because nothing material changed (no triage, no LLM). */
  unchangedSkips: number;
  /** Re-plans forced only by a deferred mitigation's re-check time (the observation itself was unchanged). */
  deferredRechecks: number;
  /** Invocations that ran triage + planning. */
  replans: number;
}

/**
 * `event-driven` (default): the policy is still called on every harness tick, but it re-runs triage + planning only
 * when the observation fingerprint changes (decision_epoch, sorted observation_event_ids, GPU availability / XID,
 * node availability, cooling operating state, job status, signal ids); otherwise it returns [] (no NEW commands;
 * everything it already issued stays queued in the harness / ledger). `every-tick`: CONTRACTS §0.6 literal.
 */
export type PolicyCadence = 'event-driven' | 'every-tick';

/** Re-plan interval while the planner defers a mitigation (planner rule (b), PlannerDeps.recheckAfterS). */
export const DEFER_RECHECK_S = 30;

export const EVENT_DRIVEN_CADENCE =
  'event-driven cadence: called every tick on the same ObservedSnapshot as the baselines; re-plans only when decision_epoch, ' +
  'observation_event_ids, GPU availability/XID, node availability, cooling state, job status or signals change, or when a ' +
  `deferred mitigation's re-check is due (the planner's re-check time, >= ${DEFER_RECHECK_S} sim-s, while one is deferred), else returns [] (no new commands, no LLM call)`;

export interface NemotronPolicyDeps {
  llm: LlmPort | null;
  physics: PhysicsPort;
  runId?: string;
  /** Default: apps/agent/.cache/llm (gitignored). */
  cacheDir?: string;
  /** Default true. */
  cache?: boolean;
  /** Part of the cache key; use the NIM model id. */
  model?: string;
  /** Recent signals for triage (the snapshot carries none). */
  signals?: SignalEvent[] | ((obs: ObservedSnapshot) => SignalEvent[]);
  /** Default 'event-driven'. */
  cadence?: PolicyCadence;
  /**
   * Re-check interval (sim s) handed to the planner as PlannerDeps.recheckAfterS: the policy is called every tick, so
   * it can guarantee the re-plan that lets the planner defer a mitigation to its last responsible moment.
   * Default DEFER_RECHECK_S; `null` disables deferral (act on the first plan, like the agent loop).
   */
  deferRecheckS?: number | null;
}

/**
 * Per-instance usage counters for evaluation provenance (CONTRACTS 0.14). They accumulate over the instance's lifetime
 * and are NOT cleared by reset(); read them (usage()) before the instance is discarded.
 */
export interface PolicyUsage {
  /** Requests attempted through the model/cache port (cache hits included). 0 when no model is configured. */
  model_requests: number;
  /** Successful uncached model responses. */
  live_model_responses: number;
  /** Responses replayed from the disk cache. */
  cache_hits: number;
  /** Planner selections made without a usable model choice (no model configured, model error or unusable reply). */
  fallback_decisions: number;
  /** Total wall time spent inside policy calls, ms. */
  decision_wall_time_ms: number;
}

export type NemotronPolicy = Policy & {
  stats(): PolicyStats;
  /** Provenance counters; survive reset(). */
  usage(): PolicyUsage;
  /** Forget the event-driven memo (call between scenarios; sim time going backwards also resets it). */
  reset(): void;
};

/**
 * Material-change fingerprint of what the policy observes. The open incident set is a pure function of
 * (snapshot, signals) through deterministic triage, so an unchanged fingerprint means an unchanged incident set.
 */
export function observationFingerprint(obs: ObservedSnapshot, signals: SignalEvent[]): string {
  const sorted = (xs: string[]) => [...xs].sort().join(',');
  return [
    obs.run_id,
    obs.clock.decision_epoch,
    sorted(obs.observation_event_ids),
    sorted(obs.gpus.map((g) => `${g.resource_id}=${g.availability}/${g.last_xid_code ?? '-'}`)),
    sorted(obs.nodes.map((n) => `${n.resource_id}=${n.availability}`)),
    sorted(obs.cooling.map((c) => `${c.resource_id}=${c.operating_state}`)),
    sorted(obs.job_states.map((j) => `${j.job_id}=${j.status}`)),
    sorted(signals.map((s) => s.event_id)),
  ].join('|');
}

export const DEFAULT_CACHE_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)), '.cache', 'llm');

/**
 * Deterministic workflow id: same run + same open incident set => same id, hence the same command keys for the same
 * step, however long the plan runs. Incidents are compared by their time-independent identity (incidentIdentity:
 * family + anchor, without the triage bucket suffix): the policy re-triages every snapshot statelessly, so the
 * bucket suffix of the same incident can roll over mid-plan. (The id used to be a 300 s sim-time bucket, which gave a
 * plan spanning a bucket boundary new keys for steps it had already issued: a possible duplicate move.)
 */
export const policyWorkflowId = (runId: string, incidentIds: readonly string[]): string => {
  const set = [...new Set(incidentIds.map(incidentIdentity))].sort().join(',');
  return `wf-policy-${runId}-i${createHash('sha256').update(set).digest('hex').slice(0, 12)}`;
};

const unavailableLlm: LlmPort = {
  async chat(): Promise<LlmChatResponse> {
    throw new Error('no LLM configured; using deterministic path');
  },
};

export const cacheKey = (req: LlmChatRequest, model: string): string =>
  createHash('sha256')
    .update(JSON.stringify({ model, messages: req.messages, tools: req.tools ?? null, toolChoice: req.toolChoice ?? null }))
    .digest('hex');

interface CachedLlm {
  port: LlmPort;
  counts: { requests: number; hits: number; live: number };
}

function withDiskCache(inner: LlmPort, dir: string, model: string): CachedLlm {
  const counts = { requests: 0, hits: 0, live: 0 };
  const port: LlmPort = {
    async chat(req) {
      counts.requests += 1;
      const file = join(dir, `${cacheKey(req, model)}.json`);
      try {
        const hit = JSON.parse(await readFile(file, 'utf8')) as LlmChatResponse;
        counts.hits += 1;
        return hit;
      } catch {
        // miss or unreadable entry: fall through to the live call
      }
      const res = await inner.chat(req); // errors propagate and are never cached
      counts.live += 1;
      try {
        await mkdir(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(res), 'utf8');
        await rename(tmp, file);
      } catch {
        // a cache write failure must not break evaluation
      }
      return res;
    },
  };
  return { port, counts };
}

/**
 * Observable reasons the commands we already issued are superseded (each reported once, by id): a job we acted on
 * is now `failed`, a migrate destination GPU we chose is no longer ready / reported an XID, or a checkpoint we
 * issued failed (its row is `failed`; whatever depended on it was dropped, and re-proposing it under the same key
 * would be ignored as a retry).
 */
export function newSupersedeTriggers(obs: ObservedSnapshot, issued: readonly ActionCommand[], handled: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const c of issued) {
    if (c.job_id && obs.job_states.find((j) => j.job_id === c.job_id)?.status === 'failed') out.add(`failed:${c.job_id}`);
    const dest = c.operation === 'migrate_restart' && Array.isArray(c.arguments.destination_gpu_ids) ? (c.arguments.destination_gpu_ids as string[]) : [];
    for (const g of dest) {
      const gpu = obs.gpus.find((x) => x.resource_id === g);
      if (!gpu || gpu.availability !== 'ready' || gpu.last_xid_code !== null) out.add(`dest:${g}`);
    }
    if (c.operation === 'checkpoint' && obs.checkpoints.some((k) => k.command_key === c.command_key && k.status === 'failed')) {
      out.add(`ckpt-failed:${c.command_key}`);
    }
  }
  return [...out].filter((t) => !handled.has(t)).sort();
}

export function createNemotronPolicy(deps: NemotronPolicyDeps): NemotronPolicy {
  const stats = { calls: 0, llmFailures: 0, uncachedRequests: 0, uncachedResponses: 0, wallMs: 0, unchangedSkips: 0, replans: 0, deferredRechecks: 0 };
  const eventDriven = (deps.cadence ?? 'event-driven') === 'event-driven';
  const recheckS = deps.deferRecheckS === undefined ? DEFER_RECHECK_S : deps.deferRecheckS;
  // recheckAtMs: a deferred mitigation's re-check (planner rule (b)); re-plan then even if nothing observable changed
  let memo: { fingerprint: string; simTimeMs: number; incidentIds: string[]; recheckAtMs: number | null } | null = null;
  // Per-run key state. Command keys are (workflow = open incident set, op, job, attempt): re-proposing the same step keeps its key,
  // so the harness / ledger treats it as a retry (no second effect). The attempt only moves on when something we
  // issued is invalidated (see newSupersedeTriggers), exactly like runReplan's new attempt in the agent loop.
  let lastSimTimeMs: number | null = null;
  let issued: ActionCommand[] = [];
  let handled = new Set<string>();
  let attempt = 1;
  const resetRun = (): void => {
    memo = null;
    issued = [];
    handled = new Set();
    attempt = 1;
  };
  const cached =
    deps.llm && (deps.cache ?? true) ? withDiskCache(deps.llm, deps.cacheDir ?? DEFAULT_CACHE_DIR, deps.model ?? 'unknown') : null;
  const inner = deps.llm;
  const llm: LlmPort | null = cached
    ? cached.port
    : inner
      ? {
          async chat(req) {
            stats.uncachedRequests += 1;
            const res = await inner.chat(req);
            stats.uncachedResponses += 1;
            return res;
          },
        }
      : null;

  const decide: Policy = async (obs, ctx) => {
    stats.calls += 1;
    const runId = deps.runId ?? obs.run_id;
    const signals = typeof deps.signals === 'function' ? deps.signals(obs) : (deps.signals ?? []);
    if (lastSimTimeMs !== null && ctx.sim_time_ms < lastSimTimeMs) resetRun(); // a new run / scenario
    lastSimTimeMs = ctx.sim_time_ms;
    if (eventDriven) {
      const fingerprint = observationFingerprint(obs, signals);
      const recheckDue = memo !== null && memo.recheckAtMs !== null && ctx.sim_time_ms >= memo.recheckAtMs;
      if (memo && memo.fingerprint === fingerprint && !recheckDue) {
        stats.unchangedSkips += 1;
        memo = { ...memo, simTimeMs: ctx.sim_time_ms };
        return [];
      }
      if (memo && memo.fingerprint === fingerprint) stats.deferredRechecks += 1;
      memo = { fingerprint, simTimeMs: ctx.sim_time_ms, incidentIds: [], recheckAtMs: null };
    }
    stats.replans += 1;
    const db = createSnapshotDb(obs, signals);
    const triage = await runTriage({ db, llm, now: () => ctx.sim_time_ms }, { signals });
    if (memo) memo = { ...memo, incidentIds: triage.incidents.map((i) => i.incident_id).sort() };
    if (triage.incidents.length === 0) return [];
    const fresh = newSupersedeTriggers(obs, issued, handled);
    if (fresh.length > 0) {
      // like runReplan's new attempt: what we issued before is invalidated, so the new plan needs new keys
      handled = new Set([...handled, ...fresh]);
      attempt += 1;
    }
    const result = await planIncidents(
      {
        db,
        physics: deps.physics,
        llm: llm ?? unavailableLlm,
        workflowId: policyWorkflowId(runId, triage.incidents.map((i) => i.incident_id)),
        runId,
        attempt,
        ...(recheckS !== null ? { recheckAfterS: recheckS } : {}),
      },
      { incidents: triage.incidents },
    );
    if (!result.used_llm) stats.llmFailures += 1;
    if (memo && result.recheck_after_s !== undefined) memo = { ...memo, recheckAtMs: ctx.sim_time_ms + result.recheck_after_s * 1000 };
    issued = [...issued, ...result.commands.filter((c) => !issued.some((x) => x.command_key === c.command_key))];
    return result.commands;
  };

  const policy: Policy = async (obs, ctx) => {
    const t0 = performance.now();
    try {
      return await decide(obs, ctx);
    } finally {
      stats.wallMs += performance.now() - t0;
    }
  };

  return Object.assign(policy, {
    usage: (): PolicyUsage => ({
      model_requests: cached ? cached.counts.requests : stats.uncachedRequests,
      live_model_responses: cached ? cached.counts.live : stats.uncachedResponses,
      cache_hits: cached?.counts.hits ?? 0,
      fallback_decisions: stats.llmFailures,
      decision_wall_time_ms: stats.wallMs,
    }),
    stats: (): PolicyStats => ({
      calls: stats.calls,
      cacheHits: cached?.counts.hits ?? 0,
      llmFailures: stats.llmFailures,
      llmRequests: cached ? cached.counts.requests : stats.uncachedRequests,
      unchangedSkips: stats.unchangedSkips,
      deferredRechecks: stats.deferredRechecks,
      replans: stats.replans,
    }),
    reset: (): void => {
      resetRun();
      lastSimTimeMs = null;
    },
  });
}

// ---------------------------------------------------------------------------------------- default instance

let defaultPolicy: NemotronPolicy | null = null;
let defaultModel: string | null = null;

/**
 * Build the default instance: NIM when NIM_API_KEY + NIM_MODEL are set, else deterministic (llm = null).
 * Physics is injected by the harness (the real @dcos/physics adapter), so construction is explicit and lazy.
 */
export function configureDefaultNemotronPolicy(physics: PhysicsPort): NemotronPolicy {
  const cfg = loadConfig();
  const llm = cfg.NIM_API_KEY && cfg.NIM_MODEL ? createNimLlm(cfg) : null;
  defaultModel = cfg.NIM_MODEL ?? null;
  defaultPolicy = createNemotronPolicy({ llm, physics, model: cfg.NIM_MODEL });
  return defaultPolicy;
}

const EMPTY_STATS: PolicyStats = { calls: 0, cacheHits: 0, llmFailures: 0, llmRequests: 0, unchangedSkips: 0, replans: 0, deferredRechecks: 0 };

const EMPTY_USAGE: PolicyUsage = { model_requests: 0, live_model_responses: 0, cache_hits: 0, fallback_decisions: 0, decision_wall_time_ms: 0 };

/** Default policy; call `configureDefaultNemotronPolicy(physics)` once before use. */
export const nemotronPolicy: NemotronPolicy = Object.assign(
  (async (obs, ctx) => {
    if (!defaultPolicy) throw new Error('nemotronPolicy: call configureDefaultNemotronPolicy(physics) first');
    return defaultPolicy(obs, ctx);
  }) as Policy,
  {
    stats: (): PolicyStats => defaultPolicy?.stats() ?? EMPTY_STATS,
    usage: (): PolicyUsage => defaultPolicy?.usage() ?? EMPTY_USAGE,
    reset: (): void => defaultPolicy?.reset() },
);

/** Scoreboard disclosure (ARCHITECTURE §9): model, fallback, cache and the event-driven cadence. */
export function describePolicy(): string {
  const model = defaultModel ?? loadConfig().NIM_MODEL ?? 'unconfigured';
  return `Nemotron (model ${model}) via NIM; deterministic fallback when unavailable; cache hits disclosed; ${EVENT_DRIVEN_CADENCE}`;
}
