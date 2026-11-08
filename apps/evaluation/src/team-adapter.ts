// Checked-in team adapter (R6): binds P1's trusted offline runner and P3's observable-only Nemotron policy to the
// EvaluationAdapter interface. It delegates all computation (never duplicates the simulator) and adds provenance
// (CONTRACTS 0.14): usage counters captured before each fresh Nemotron instance is disposed, unfinished/failed job ids
// read from runScenarioDetailed().details, and the sha256 of the saved canonical command trace.
//
// Workspace imports are relative on purpose: apps/evaluation has no workspace dependency on physics/agent, and adding
// one would change the lockfile. Physics is read from source (no build needed), the agent from its source tree.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvaluationResult } from '@dcos/contracts';
import {
  evaluateSafety, loadScenarios, reactivePolicy, runScenarioDetailed, simulatePlan, thresholdPolicy,
  type Scenario, type ScenarioRunDetails,
} from '../../../packages/physics/src/gpu/index.js';
import { loadConfig } from '../../agent/src/config.js';
import { createNimLlm } from '../../agent/src/llm.js';
import { createNemotronPolicy, EVENT_DRIVEN_CADENCE, type NemotronPolicy } from '../../agent/src/policy.js';
import type { LlmPort, PhysicsPort } from '../../agent/src/ports.js';
import type { EvaluationAdapter, Policy, ScenarioIdentity } from './runner.js';
import { modeLabel } from './report.js';

export const FIXED_12_PREFIXES = ['sc01', 'sc03', 'sc04', 'sc05', 'sc07', 'sc08', 'sc09', 'sc10', 'sc11', 'sc13', 'sc14', 'sc17'] as const;
export const PHYSICS_PROFILE_VERSION = 'dcos-gpu-physics@0.1.0';
export const LATENCY_MODEL = 'zero_simulated_decision_latency' as const;
export const DELAY_LABEL = 'job_completion_delay_s is a finite-horizon work deficit (lower bound truncated at the case horizon), not measured wall completion time.';
const AGENT_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent', 'src');

export type PolicyName = EvaluationResult['policy'];
export type DetailedRunner = (s: Scenario, policy: Policy, opts: { policy_name: PolicyName; run_id: string }) => Promise<ScenarioRunDetails>;
export type Provenance = NonNullable<EvaluationResult['provenance']>;

export interface NemotronHandle {
  policy: NemotronPolicy;
  model_id: string | null;
  model_enabled: boolean;
}

export interface TeamAdapterOptions {
  batchId: string;
  codeRevision: string;
  /** Directory that receives traces/<case>.trace.json. */
  outDir: string;
  /** Full scenario ids (from selectCases); default = the fixed 12. */
  caseIds?: string[];
  /** Deterministic-only: Nemotron policy built with llm = null, labelled model_enabled false. */
  noLlm: boolean;
  /** Cap on requests that reach the live LLM port (cache hits are free). Default 60. */
  maxLiveCalls?: number;
  /** Test seams. */
  scenarios?: Scenario[];
  runDetailed?: DetailedRunner;
  createNemotron?: (scenario: Scenario) => NemotronHandle;
}

export interface CaseRecord {
  scenario_id: string;
  seed: number;
  horizon_s: number;
  run_id: string;
  rows: Record<string, { trace_file: string; trace_sha256: string; mode: string }>;
}

export interface TeamAdapter extends EvaluationAdapter {
  readonly cases: CaseRecord[];
  manifest(): Record<string, unknown>;
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export function selectCases(all: readonly Scenario[], which: 'fixed12' | 'all'): Scenario[] {
  if (which === 'all') return [...all];
  return FIXED_12_PREFIXES.map((prefix) => {
    const hits = all.filter((s) => s.scenario_id === prefix || s.scenario_id.startsWith(`${prefix}-`));
    if (hits.length !== 1) throw new Error(`fixed12: expected exactly one scenario for ${prefix}, found ${hits.length}.`);
    return hits[0]!;
  });
}

/** Stable hash of the prompt sources, so cache-relevant prompt changes show up in provenance. */
export function promptVersion(): string {
  const h = createHash('sha256');
  for (const f of ['planner.ts', 'triage.ts']) h.update(readFileSync(resolve(AGENT_SRC, 'prompts', f)));
  return `prompts-${h.digest('hex').slice(0, 12)}`;
}

/** Visible label derived from provenance, never from the policy name alone (shared with the scoreboard). */
export { modeLabel } from './report.js';

function physicsPort(): PhysicsPort {
  return {
    simulatePlan: (obs, plan, opts) => simulatePlan(obs, plan, opts),
    evaluateSafety: (obs, cmd, ctx) => evaluateSafety(obs, cmd, ctx),
    thresholdPolicy: (obs) => thresholdPolicy(obs),
  };
}

function defaultNemotronFactory(opts: TeamAdapterOptions): (s: Scenario) => NemotronHandle {
  const physics = physicsPort();
  let live: (LlmPort & { used(): number }) | null = null;
  let model: string | null = null;
  if (!opts.noLlm) {
    const cfg = loadConfig();
    if (!cfg.NIM_API_KEY || !cfg.NIM_MODEL) throw new Error('Live run needs NIM_API_KEY and NIM_MODEL (or pass --no-llm for a deterministic-only run).');
    model = cfg.NIM_MODEL;
    const inner = createNimLlm(cfg);
    const max = opts.maxLiveCalls ?? 60;
    let used = 0;
    // The cap sits under the disk cache, so cache hits do not consume it; beyond it the policy falls back (counted).
    live = { used: () => used, async chat(req) { if (used >= max) throw new Error('live LLM call budget exhausted'); used += 1; return inner.chat(req); } };
  }
  return () => ({
    policy: createNemotronPolicy({ llm: live, physics, model: model ?? 'none', cache: live !== null }),
    model_id: model,
    model_enabled: live !== null,
  });
}

function requireJobIds(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) {
    throw new Error(`runScenarioDetailed().details.${what} is missing; refusing to zero-fill unfinished/failed jobs.`);
  }
  return [...value];
}

function writeAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
}

export function createTeamAdapter(opts: TeamAdapterOptions): TeamAdapter {
  if (!opts.codeRevision) throw new Error('codeRevision (git HEAD) must be passed in by the CLI.');
  const all = opts.scenarios ?? loadScenarios();
  const selected = opts.caseIds ? all.filter((s) => opts.caseIds!.includes(s.scenario_id)) : selectCases(all, 'fixed12');
  if (opts.caseIds && selected.length !== opts.caseIds.length) throw new Error('Some requested case ids are not in loadScenarios().');
  const runDetailed: DetailedRunner = opts.runDetailed ?? ((s, p, o) => runScenarioDetailed(s, p as never, o));
  const makeNemotron = opts.createNemotron ?? defaultNemotronFactory(opts);
  const prompt = opts.createNemotron ? 'prompts-test' : promptVersion();
  const cases: CaseRecord[] = [];
  const stats = { cacheHits: 0, llmFailures: 0, llmRequests: 0 };
  let current: NemotronHandle | null = null;
  let wallMs = 0;

  const timed = (fn: (obs: never, ctx: never) => unknown): Policy => async (obs, ctx) => {
    const t0 = performance.now();
    try { return await (fn as Policy)(obs, ctx); } finally { wallMs += performance.now() - t0; }
  };
  const policies: Record<PolicyName, Policy> = {
    reactive: timed(reactivePolicy as never),
    threshold: timed(thresholdPolicy as never),
    nemotron: (obs, ctx) => {
      if (!current) throw new Error('nemotron policy invoked outside runScenario (no fresh instance).');
      return current.policy(obs, ctx);
    },
  };
  const revisionTag = opts.codeRevision.slice(0, 12);
  const policyVersions: Record<PolicyName, string> = {
    reactive: `reactive-rules@${revisionTag}`,
    threshold: `threshold-rules@${revisionTag}`,
    nemotron: `nemotron-policy(${opts.noLlm ? 'deterministic-only' : 'nim'};event-driven)@${revisionTag}`,
  };

  const adapter: TeamAdapter = {
    cases,
    loadScenarios: () => selected.map((s) => ({ scenario_id: s.scenario_id, seed: s.seed })),
    policies,
    provenance: { physics_profile_version: PHYSICS_PROFILE_VERSION, policy_versions: policyVersions },
    getPolicyStats: () => ({ ...stats }),
    async runScenario(identity: ScenarioIdentity, policy: Policy, name: PolicyName) {
      const scenario = selected.find((s) => s.scenario_id === identity.scenario_id && s.seed === identity.seed);
      if (!scenario) throw new Error(`Unknown scenario/seed ${identity.scenario_id}/${identity.seed}.`);
      if (!Number.isInteger(scenario.horizon_s) || scenario.horizon_s <= 0) throw new Error(`${scenario.scenario_id}: horizon_s must be a positive integer.`);
      // One comparison run_id across all three policies, overriding P1's per-policy default.
      const runId = `${opts.batchId}-${scenario.scenario_id}-s${scenario.seed}`;
      let handle: NemotronHandle | null = null;
      if (name === 'nemotron') { handle = makeNemotron(scenario); current = handle; }
      wallMs = 0;
      let details: ScenarioRunDetails;
      let usage: ReturnType<NemotronPolicy['usage']> | null = null;
      try {
        details = await runDetailed(structuredClone(scenario), policy, { policy_name: name, run_id: runId });
      } finally {
        // Capture counters BEFORE disposal; reset() would not clear them, dropping the instance would lose them.
        if (handle) {
          usage = handle.policy.usage();
          const s = handle.policy.stats();
          stats.cacheHits += s.cacheHits; stats.llmFailures += s.llmFailures; stats.llmRequests += s.llmRequests;
        }
        current = null;
      }
      const unfinished = requireJobIds(details.unfinished_job_ids, 'unfinished_job_ids');
      const failed = requireJobIds(details.failed_job_ids, 'failed_job_ids');

      const trace = JSON.stringify({
        kind: 'dcos-command-trace', batch_id: opts.batchId, run_id: runId, scenario_id: scenario.scenario_id, seed: scenario.seed,
        policy: name, horizon_sim_s: scenario.horizon_s, gate: details.gate, ticks: details.ticks,
        start_sim_time_ms: details.start_sim_time_ms, end_sim_time_ms: details.end_sim_time_ms,
        duplicate_commands_ignored: details.duplicate_commands_ignored, retry_dropped: details.retry_dropped, commands: details.commands,
      }, null, 2) + '\n';
      const traceFile = `traces/${scenario.scenario_id}-s${scenario.seed}-${name}.trace.json`;
      writeAtomic(resolve(opts.outDir, traceFile), trace);

      const provenance: Provenance = {
        batch_id: opts.batchId,
        code_revision: opts.codeRevision,
        physics_profile_version: PHYSICS_PROFILE_VERSION,
        policy_version: policyVersions[name],
        model_id: handle?.model_enabled ? handle.model_id : null,
        prompt_version: handle ? prompt : null,
        model_enabled: handle?.model_enabled ?? false,
        model_requests: usage?.model_requests ?? 0,
        live_model_responses: usage?.live_model_responses ?? 0,
        cache_hits: usage?.cache_hits ?? 0,
        fallback_decisions: usage?.fallback_decisions ?? 0,
        decision_wall_time_ms: Math.round((usage ? usage.decision_wall_time_ms : wallMs) * 1000) / 1000,
        horizon_sim_s: scenario.horizon_s,
        latency_model: LATENCY_MODEL,
        unfinished_job_ids: unfinished,
        failed_job_ids: failed,
        trace_sha256: sha256(trace),
      };
      let record = cases.find((c) => c.run_id === runId);
      if (!record) { record = { scenario_id: scenario.scenario_id, seed: scenario.seed, horizon_s: scenario.horizon_s, run_id: runId, rows: {} }; cases.push(record); }
      record.rows[name] = { trace_file: traceFile, trace_sha256: provenance.trace_sha256, mode: modeLabel(provenance) };
      return { ...details.result, provenance } satisfies EvaluationResult;
    },
    manifest() {
      return {
        kind: 'dcos-evaluation-manifest',
        batch_id: opts.batchId,
        code_revision: opts.codeRevision,
        physics_profile_version: PHYSICS_PROFILE_VERSION,
        policy_versions: policyVersions,
        prompt_version: prompt,
        model: opts.noLlm ? { enabled: false, id: null, label: 'deterministic-only (--no-llm); cannot substantiate a Nemotron performance claim' } : { enabled: true, max_live_calls: opts.maxLiveCalls ?? 60 },
        cadence: EVENT_DRIVEN_CADENCE,
        latency_model: LATENCY_MODEL,
        horizons_sim_s: Object.fromEntries(selected.map((s) => [s.scenario_id, s.horizon_s])),
        delay_label: DELAY_LABEL,
        policy_stats: { ...stats },
        case_ids: selected.map((s) => s.scenario_id),
        cases,
      };
    },
  };
  return adapter;
}
