// P3-9: the Nemotron incident-orchestration agent as a pure evaluation Policy (CONTRACTS §0.6).
// obs -> in-memory snapshot-db -> runTriage -> planIncidents -> ordered ActionCommand[].
// Never executes anything. Nemotron responses are cached on disk so evaluation reruns are
// reproducible; cache hits are counted so the scoreboard can disclose them (ARCHITECTURE §9).

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ObservedSnapshot, SignalEvent } from '@dcos/contracts';
import { loadConfig } from './config.js';
import { createNimLlm } from './llm.js';
import { planIncidents } from './planner.js';
import type { LlmChatRequest, LlmChatResponse, LlmPort, PhysicsPort, Policy } from './ports.js';
import { createSnapshotDb } from './snapshot-db.js';
import { SYMPTOM_BUCKET_MS, runTriage } from './triage.js';

export interface PolicyStats {
  /** Policy invocations. */
  calls: number;
  /** Nemotron responses served from the disk cache. */
  cacheHits: number;
  /** Policy invocations that fell back to the deterministic path (no LLM, LLM error, or unusable reply). */
  llmFailures: number;
  /** Requests that reached the (cached or live) LLM port; cacheHits <= llmRequests. */
  llmRequests: number;
}

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
}

export type NemotronPolicy = Policy & { stats(): PolicyStats };

export const DEFAULT_CACHE_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)), '.cache', 'llm');

/** Deterministic workflow id: same run + same sim-time bucket => same id (and command keys). */
export const policyWorkflowId = (runId: string, simTimeMs: number): string =>
  `wf-policy-${runId}-t${Math.floor(simTimeMs / SYMPTOM_BUCKET_MS)}`;

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
  counts: { requests: number; hits: number };
}

function withDiskCache(inner: LlmPort, dir: string, model: string): CachedLlm {
  const counts = { requests: 0, hits: 0 };
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

export function createNemotronPolicy(deps: NemotronPolicyDeps): NemotronPolicy {
  const stats = { calls: 0, llmFailures: 0, uncachedRequests: 0 };
  const cached =
    deps.llm && (deps.cache ?? true) ? withDiskCache(deps.llm, deps.cacheDir ?? DEFAULT_CACHE_DIR, deps.model ?? 'unknown') : null;
  const inner = deps.llm;
  const llm: LlmPort | null = cached
    ? cached.port
    : inner
      ? {
          async chat(req) {
            stats.uncachedRequests += 1;
            return inner.chat(req);
          },
        }
      : null;

  const policy: Policy = async (obs, ctx) => {
    stats.calls += 1;
    const runId = deps.runId ?? obs.run_id;
    const signals = typeof deps.signals === 'function' ? deps.signals(obs) : (deps.signals ?? []);
    const db = createSnapshotDb(obs, signals);
    const triage = await runTriage({ db, llm, now: () => ctx.sim_time_ms }, { signals });
    if (triage.incidents.length === 0) return [];
    const result = await planIncidents(
      {
        db,
        physics: deps.physics,
        llm: llm ?? unavailableLlm,
        workflowId: policyWorkflowId(runId, ctx.sim_time_ms),
        runId,
        attempt: 1,
      },
      { incidents: triage.incidents },
    );
    if (!result.used_llm) stats.llmFailures += 1;
    return result.commands;
  };

  return Object.assign(policy, {
    stats: (): PolicyStats => ({
      calls: stats.calls,
      cacheHits: cached?.counts.hits ?? 0,
      llmFailures: stats.llmFailures,
      llmRequests: cached ? cached.counts.requests : stats.uncachedRequests,
    }),
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

const EMPTY_STATS: PolicyStats = { calls: 0, cacheHits: 0, llmFailures: 0, llmRequests: 0 };

/** Default policy; call `configureDefaultNemotronPolicy(physics)` once before use. */
export const nemotronPolicy: NemotronPolicy = Object.assign(
  (async (obs, ctx) => {
    if (!defaultPolicy) throw new Error('nemotronPolicy: call configureDefaultNemotronPolicy(physics) first');
    return defaultPolicy(obs, ctx);
  }) as Policy,
  { stats: (): PolicyStats => defaultPolicy?.stats() ?? EMPTY_STATS },
);

export function describePolicy(): string {
  const model = defaultModel ?? loadConfig().NIM_MODEL ?? 'unconfigured';
  return `Nemotron (model ${model}) via NIM; deterministic fallback when unavailable; cache hits disclosed`;
}
