// Planner (LANE-P3 P3-4). "How the agent decides":
//   1. deterministic code enumerates concrete options per affected job
//   2. jobs are planned SEQUENTIALLY in priority order (conditional / marginal planning): job 1's options are
//      scored with every other job left in place; job 2's options are scored with job 1's chosen commands already
//      applied (simulatePlan on the combined command list), and so on. Every command is checked with
//      physics.evaluateSafety on the observed snapshot.
//   3. options are ranked per ARCHITECTURE §5 (no unsafe -> least irreversible work loss -> lower failure-risk
//      tier -> no needless preemption -> least completion delay -> least GPU-busy waste -> fewest preemptions;
//      ties -> fewer commands -> option_id). The risk tier is the job's own (marginal) risk, so a power cap that
//      leaves a job on a degraded cooling loop does not beat a move to a healthy loop just because it is quicker,
//      and a move whose gain over keep_running (under the higher-priority jobs' plan) is within tolerance loses
//      to keep / cap: a job is never moved just because a hotter neighbour was still in place.
//   4. Nemotron chooses among the top eligible options and explains (one choose_options call for all jobs; it
//      sees the conditional metrics plus the marginal deltas vs keep_running); code rejects any choice that is not
//      an eligible option and falls back to rank 1. If Nemotron departs from the rank-1 option a lower-priority
//      job was conditioned on, every later job is re-scored under the real context before its choice is applied.
//   5. the result is persisted as a PlanCandidate proposal (db.submitPlan). Nothing is executed here.

import { validatePayload, type ActionCommand, type Checkpoint, type Incident, type PlanCandidate, type SafetyDecision } from '@dcos/contracts';
import { z } from 'zod';
import { summarizeToolCall } from './events.js';
import type { AgentActor, DbPort, Evidence, LlmChatResponse, LlmPort, PhysicsPort, PlanMetrics, ToolCallSummary } from './ports.js';
import { CHOOSE_OPTIONS_TOOL, CHOOSE_OPTIONS_TOOL_NAME, PLANNER_MAX_TOKENS, PLANNER_SYSTEM_PROMPT, buildPlannerUserMessage } from './prompts/planner.js';
import { buildCommand, commandKey, type PartialCommand } from './tools/command.js';
import { placementCandidates } from './tools/placement-tool.js';
import { GPU_THROTTLE_TEMP_C, indexSnapshot, type SnapshotIndex } from './tools/snapshot-index.js';
import { CLOCKS_EVENT_SW_THERMAL } from './ports.js';

// ---------------------------------------------------------------------------------------------- public API

export interface RankedOption {
  option_id: string;
  label: string;
  job_id: string;
  commands: ActionCommand[];
  metrics: PlanMetrics;
  safety: SafetyDecision[];
  rank: number;
  /** Failure risk attributable to this option's job (job-scoped simulatePlan), 0..1. Drives the risk tier. */
  job_risk: number;
  excluded_reason?: string;
  /** keep_running only: set when a hold rule put it first. */
  hold?: KeepHold;
  /** Set on the synthetic `<job>:keep` fallback of resolveConflicts: metrics/safety are copied, never simulated. */
  not_simulated?: boolean;
}

export interface JobPlan {
  job_id: string;
  chosen: RankedOption;
  alternatives: RankedOption[];
  decided_by: 'nemotron' | 'deterministic';
  needs_approval: boolean;
  explanation: string;
}

export interface PlanResult {
  plan: PlanCandidate;
  commands: ActionCommand[];
  job_plans: JobPlan[];
  tool_calls: ToolCallSummary[];
  used_llm: boolean;
  /** F-NV1: the one-sentence plan-stage event summary (Nemotron's own conclusion, or `deterministic: ...`). */
  summary?: string;
  /** F-NV1: `nemotron` only when at least one final job decision came from the LLM. */
  actor?: AgentActor;
  /** R3b: the options the planner evaluated per job, in the persisted `state.candidates` shape (chosen first). */
  candidates?: PersistedCandidate[];
  /** Set when a job's mitigation was deferred (rule (b)): the caller must re-plan within this many sim seconds. */
  recheck_after_s?: number;
}

export interface PlannerDeps {
  db: DbPort;
  physics: PhysicsPort;
  llm: LlmPort;
  workflowId: string;
  runId: string;
  attempt?: number;
  /** GPUs held by still-running actions: treated as occupied, so no option may target them. */
  reservedGpuIds?: string[];
  /** A completed checkpoint younger than this (sim seconds) is reused instead of taking a new one. Default 60. */
  freshCheckpointMaxAgeS?: number;
  /**
   * Set only by a caller that GUARANTEES a re-plan within this many sim seconds even when nothing observable changes
   * (the evaluation policy). Enables rule (b) of RANKING_ASSUMPTION: mitigations of a running job whose keep outlook
   * is clean for its whole lead time are deferred. Unset (the agent loop): act now.
   */
  recheckAfterS?: number;
}

/** Why keep_running was put first for a job (RANKING_ASSUMPTION rule (a) / (b)). */
export interface KeepHold {
  kind: 'completes_first' | 'deferred';
  /** Sim seconds over which the keep outlook was checked clean. */
  window_s: number;
  /** `deferred` only: re-plan within this many sim seconds (>= recheckAfterS). */
  recheck_s?: number;
}

export const FRESH_CHECKPOINT_MAX_AGE_S = 60;
export const PLANNER_HORIZON_S = 600;
export const PLANNER_HORIZON_ASSUMPTION = `planner horizon ${PLANNER_HORIZON_S} s`;
/** Migrate options per job (best placement candidates first). */
export const TOP_PLACEMENTS = 3;
/** Eligible options per job shown to Nemotron. */
export const LLM_TOP_OPTIONS = 3;
export const LLM_PAYLOAD_MAX_BYTES = 6_000;
export const POWER_CAP_W = 500;
/** A GPU this close to the throttle temperature makes power_cap worth enumerating. */
export const NEAR_THROTTLE_MARGIN_C = 5;
/** Loss differences below this share of the avoidable loss are ties (estimates aren't that precise). */
export const LOSS_TIE_FRACTION = 0.05;
/** Failure-risk tier width: risks within the same 0.1 bucket tie (estimates are coarse). */
export const RISK_TIER_WIDTH = 0.1;
/**
 * Residual failure risk a job tolerates without paying for a move: (100 - priority) / 100. A priority-80 job
 * tolerates 0.2 (so a power cap that leaves it at ~0.25 on a degraded loop loses to a move to a healthy loop);
 * a priority-60 job tolerates 0.4 (a cap is good enough, no restart).
 */
export const riskTolerance = (priority: number): number => Math.min(1, Math.max(0, (100 - priority) / 100));
export const EVIDENCE_WINDOW_MS = 600_000;
export const DETERMINISTIC_EXPLANATION = 'deterministic ranking (LLM unavailable)';
/** A keep_running outlook is "clean" with no expected lost work and a failure risk below this. */
export const CLEAN_OUTLOOK_MAX_RISK = 0.01;
export const RANKING_ASSUMPTION =
  'ranking: jobs planned sequentially in priority order, each scored with the higher-priority jobs’ chosen commands already ' +
  'applied (conditional/marginal, not every-other-job-in-place); unsafe excluded; keep_running first when the running job’s own ' +
  `keep outlook is clean (no lost work, failure risk < ${CLEAN_OUTLOOK_MAX_RISK * 100}%) until (a) it completes (a job that finishes ` +
  'before it can fail gains nothing from a checkpoint, cap or move, which only add delay) or, when the caller re-plans on a ' +
  'schedule, (b) the last moment a mitigation can still be started and finished (checkpoint + restart + re-check interval; ' +
  'acting earlier only pays for a fault that may still clear, and the re-check acts once the outlook within that lead time is ' +
  'no longer clean); otherwise lost work within max(one restart of the job, ' +
  `5% of avoidable loss) of the best counts as a tie; then the job's own marginal failure risk in ${RISK_TIER_WIDTH} tiers, risk up ` +
  'to (100 - priority)% tolerated (staying on a degraded cooling loop or hot GPUs is riskier than moving to a healthy one); a ' +
  'migrate/pause that beats keep_running on neither lost work nor risk tier is a needless preemption and ranks below keep/cap; ' +
  'then completion delay, GPU-busy waste, preemptions, command count';

const MAX_EXPLANATION_CHARS = 200;
const PLAN_EXPLANATION_MAX = 2_000;
const MAX_ASSUMPTIONS = 50;

// ---------------------------------------------------------------------------------------------- affected jobs

export interface AffectedJob {
  job_id: string;
  incident_ids: [string, ...string[]];
  priority: number;
}

/** All providers reachable from `id` along dependency edges (consumer -> provider), plus `id` itself. */
function providerClosure(ix: SnapshotIndex, id: string, maxDepth = 6): Set<string> {
  const seen = new Set<string>([id]);
  let frontier = [id];
  for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const e of ix.snap.dependencies) {
      if (frontier.includes(e.consumer_id) && !seen.has(e.provider_id)) {
        seen.add(e.provider_id);
        next.push(e.provider_id);
      }
    }
    frontier = next;
  }
  return seen;
}

function linkedResourcesByIncident(incidents: Incident[], evidence: Evidence | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>(incidents.map((i) => [i.incident_id, new Set<string>()]));
  if (!evidence) return out;
  const symptomResource = new Map(evidence.symptoms.map((s) => [s.symptom_id, s.resource_id]));
  for (const l of evidence.links) {
    const set = out.get(l.incident_id);
    if (!set) continue;
    if (l.link_kind === 'resource') set.add(l.linked_id);
    if (l.link_kind === 'symptom') {
      const r = symptomResource.get(l.linked_id);
      if (r) set.add(r);
    }
  }
  return out;
}

function degradedLoopUnder(ix: SnapshotIndex, gpuId: string): boolean {
  const nodeId = ix.gpu.get(gpuId)?.node_id;
  const rackId = nodeId ? ix.node.get(nodeId)?.rack_id : undefined;
  const loop = rackId ? ix.loopOfRack.get(rackId) : undefined;
  const state = loop ? ix.cooling.get(loop)?.operating_state : undefined;
  return state !== undefined && state !== 'normal';
}

/** Jobs with an allocated GPU linked to an incident (directly or via its dependency path) or under a degraded loop. */
export function findAffectedJobs(ix: SnapshotIndex, incidents: Incident[], evidence: Evidence | null): AffectedJob[] {
  const linked = linkedResourcesByIncident(incidents, evidence);
  const allIds = incidents.map((i) => i.incident_id) as [string, ...string[]];
  const out: AffectedJob[] = [];
  for (const state of ix.snap.job_states) {
    if (state.status === 'failed') {
      // A failed job (it lost its GPUs) during an open incident is always affected: its options are a recovery
      // restart from durable work vs staying failed / escalating.
      out.push({ job_id: state.job_id, incident_ids: allIds, priority: ix.jobSpec.get(state.job_id)?.priority ?? 0 });
      continue;
    }
    if (state.status === 'completed' || state.allocated_gpu_ids.length === 0) continue;
    const reach = new Set<string>([state.job_id]);
    for (const g of state.allocated_gpu_ids) for (const p of providerClosure(ix, g)) reach.add(p);
    const hits = [...linked].filter(([, res]) => [...res].some((r) => reach.has(r))).map(([id]) => id);
    const degraded = state.allocated_gpu_ids.some((g) => degradedLoopUnder(ix, g));
    if (hits.length === 0 && !degraded) continue;
    out.push({
      job_id: state.job_id,
      incident_ids: (hits.length > 0 ? hits.sort() : allIds) as [string, ...string[]],
      priority: ix.jobSpec.get(state.job_id)?.priority ?? 0,
    });
  }
  return out.sort((a, b) => b.priority - a.priority || a.job_id.localeCompare(b.job_id));
}

// ---------------------------------------------------------------------------------------------- enumerate

interface DraftOption {
  option_id: string;
  label: string;
  job_id: string;
  commands: ActionCommand[];
}

const rackShort = (ix: SnapshotIndex, gpuId: string): string => {
  const node = ix.gpu.get(gpuId)?.node_id;
  return (node && ix.node.get(node)?.rack_id.replace('rack-', '')) || gpuId;
};

function jobRunsHot(ix: SnapshotIndex, gpuIds: string[]): boolean {
  return gpuIds.some((id) => {
    const g = ix.gpu.get(id);
    return g !== undefined && (g.temp_c >= GPU_THROTTLE_TEMP_C - NEAR_THROTTLE_MARGIN_C || (g.clocks_event_reasons & CLOCKS_EVENT_SW_THERMAL) !== 0);
  });
}

/** Latest complete, accessible checkpoint of the job if it is younger than `maxAgeS` sim seconds. */
export function freshCheckpointOf(ix: SnapshotIndex, jobId: string, maxAgeS: number): Checkpoint | null {
  let best: Checkpoint | null = null;
  for (const c of ix.snap.checkpoints) {
    if (c.job_id !== jobId || c.status !== 'complete' || !c.accessible || c.complete_sim_time_ms === null) continue;
    const newer = best === null || c.complete_sim_time_ms > best.complete_sim_time_ms!;
    const tieWins = best !== null && c.complete_sim_time_ms === best.complete_sim_time_ms && c.checkpoint_id > best.checkpoint_id;
    if (newer || tieWins) best = c;
  }
  return best !== null && (ix.snap.clock.sim_time_ms - best.complete_sim_time_ms!) / 1000 < maxAgeS ? best : null;
}

/**
 * The checkpoint the job is writing right now (job `checkpointing`, row `writing`/`requested`), newest first, or
 * null. Its command_key is what a migrate / pause must depend on (real safety tolerates exactly that).
 */
export function inFlightCheckpointOf(ix: SnapshotIndex, jobId: string): Checkpoint | null {
  if (ix.jobState.get(jobId)?.status !== 'checkpointing') return null;
  const rows = ix.snap.checkpoints.filter((c) => c.job_id === jobId && (c.status === 'writing' || c.status === 'requested'));
  rows.sort((a, b) => b.requested_sim_time_ms - a.requested_sim_time_ms || b.checkpoint_id.localeCompare(a.checkpoint_id));
  return rows[0] ?? null;
}

export function enumerateOptions(
  ix: SnapshotIndex,
  job: AffectedJob,
  ctx: { runId: string; workflowId: string; attempt: number; planId: string; freshCheckpointMaxAgeS?: number },
): DraftOption[] {
  const spec = ix.jobSpec.get(job.job_id);
  const state = ix.jobState.get(job.job_id);
  if (!spec || !state) return [];
  const cmdCtx = { runId: ctx.runId, workflowId: ctx.workflowId, n: ctx.attempt, incidentIds: job.incident_ids, planId: ctx.planId };
  const build = (p: Omit<PartialCommand, 'target_resource_id' | 'job_id'>) =>
    buildCommand({ ...p, target_resource_id: job.job_id, job_id: job.job_id }, ix.snap, cmdCtx);
  const id = (suffix: string) => `${job.job_id}:${suffix}`;
  const out: DraftOption[] = [{ option_id: id('keep'), label: `${job.job_id} keep running`, job_id: job.job_id, commands: [] }];
  const escalate = (): DraftOption => ({
    option_id: id('escalate'),
    label: `${job.job_id} escalate to operator`,
    job_id: job.job_id,
    commands: [build({ operation: 'escalate', arguments: { reason: `no automatic mitigation chosen for ${job.job_id}` } })],
  });

  if (state.status === 'failed') {
    // Recovery: restart from durable work on healthy GPUs (a failed job needs no new checkpoint; it can't take one).
    out[0] = { ...out[0]!, label: `${job.job_id} leave failed` };
    for (const cand of placementCandidates(ix, job.job_id).slice(0, TOP_PLACEMENTS)) {
      const racks = [...new Set(cand.destination_gpu_ids.map((g) => rackShort(ix, g)))].join('+');
      out.push({
        option_id: id(`restart:${racks}`),
        label: `${job.job_id} restart from its last checkpoint on ${racks}`,
        job_id: job.job_id,
        commands: [build({ operation: 'migrate_restart', arguments: { destination_gpu_ids: cand.destination_gpu_ids } })],
      });
    }
    out.push(escalate());
    return out;
  }

  if (jobRunsHot(ix, state.allocated_gpu_ids)) {
    out.push({
      option_id: id('cap'),
      label: `${job.job_id} power cap ${POWER_CAP_W} W`,
      job_id: job.job_id,
      commands: [build({ operation: 'power_cap', arguments: { power_limit_w: POWER_CAP_W } })],
    });
  }
  // A checkpoint already writing counts as the pending checkpoint step: never propose a second one (real safety
  // rejects it with CONFLICTING_ACTION); moves / pause wait for the in-flight one instead.
  const inflight = spec.checkpoint_supported ? inFlightCheckpointOf(ix, job.job_id) : null;
  const fresh =
    spec.checkpoint_supported && !inflight ? freshCheckpointOf(ix, job.job_id, ctx.freshCheckpointMaxAgeS ?? FRESH_CHECKPOINT_MAX_AGE_S) : null;
  const ckpt = spec.checkpoint_supported && !fresh && !inflight ? build({ operation: 'checkpoint' }) : null;
  const reuse = inflight
    ? ` (after in-flight checkpoint ${inflight.command_key})`
    : fresh
      ? ` (reusing fresh checkpoint ${fresh.checkpoint_id})`
      : '';
  const prefix = ckpt ? 'ckpt+' : inflight ? 'ckpt-inflight+' : fresh ? 'ckpt-reuse+' : '';
  const deps = ckpt ? [ckpt.command_key] : inflight ? [inflight.command_key] : [];
  if (ckpt) out.push({ option_id: id('ckpt'), label: `${job.job_id} checkpoint`, job_id: job.job_id, commands: [ckpt] });

  if (spec.preemptible) {
    for (const cand of placementCandidates(ix, job.job_id).slice(0, TOP_PLACEMENTS)) {
      const racks = [...new Set(cand.destination_gpu_ids.map((g) => rackShort(ix, g)))].join('+');
      const move = build({
        operation: 'migrate_restart',
        arguments: { destination_gpu_ids: cand.destination_gpu_ids },
        depends_on_command_keys: deps,
      });
      out.push({
        option_id: id(`${prefix}move:${racks}`),
        label: `${job.job_id} ${ckpt ? 'checkpoint then ' : ''}move to ${racks}${reuse}`,
        job_id: job.job_id,
        commands: ckpt ? [ckpt, move] : [move],
      });
    }
  }
  const pause = build({ operation: 'pause_job', depends_on_command_keys: deps });
  out.push({
    option_id: id(`${prefix}pause`),
    label: `${job.job_id} ${ckpt ? 'checkpoint then ' : ''}pause${reuse}`,
    job_id: job.job_id,
    commands: ckpt ? [ckpt, pause] : [pause],
  });
  out.push(escalate());
  return out;
}

// ---------------------------------------------------------------------------------------------- score + rank

interface Scored extends DraftOption {
  metrics: PlanMetrics;
  safety: SafetyDecision[];
  violations: string[];
  job_risk: number;
}

/**
 * Planning context for one job (sequential conditional planning): the commands already chosen for the
 * higher-priority jobs. Every option of this job is simulated AFTER them, on the combined command list.
 */
export interface PlanContext {
  commands: ActionCommand[];
  /** Jobs those commands belong to (kept in the job-scoped risk view). */
  job_ids: string[];
  /** GPUs claimed as migrate destinations by those commands (no later job may target them). */
  claimed_gpu_ids: string[];
  /** option_ids chosen so far, in priority order (tool-call trace / LLM payload). */
  option_ids: string[];
}

export const EMPTY_CONTEXT: PlanContext = { commands: [], job_ids: [], claimed_gpu_ids: [], option_ids: [] };

export const extendContext = (ctx: PlanContext, chosen: RankedOption): PlanContext => ({
  commands: [...ctx.commands, ...chosen.commands],
  job_ids: [...ctx.job_ids, chosen.job_id],
  claimed_gpu_ids: [...new Set([...ctx.claimed_gpu_ids, ...destinations(chosen)])],
  option_ids: [...ctx.option_ids, chosen.option_id],
});

/** What the context alone does (computed once per job): its whole-cluster metrics and its own jobs' risk. */
interface ContextBaseline {
  metrics: PlanMetrics | null;
  risk: number;
}

const NO_BASELINE: ContextBaseline = { metrics: null, risk: 0 };
const clamp01 = (r: number): number => (Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0);

/** The snapshot restricted to `jobIds` (specs + states). Other jobs' load is still in the observed telemetry. */
function jobView(snap: SnapshotIndex['snap'], jobIds: Set<string>): SnapshotIndex['snap'] {
  return {
    ...snap,
    job_states: snap.job_states.filter((j) => jobIds.has(j.job_id)),
    job_specs: snap.job_specs.filter((j) => jobIds.has(j.job_id)),
  };
}

function viewRisk(physics: PhysicsPort, snap: SnapshotIndex['snap'], jobIds: Set<string>, commands: ActionCommand[]): number | null {
  try {
    return clamp01(physics.simulatePlan(jobView(snap, jobIds), { commands }, { horizon_s: PLANNER_HORIZON_S }).failure_risk_estimate);
  } catch {
    return null;
  }
}

function contextBaseline(physics: PhysicsPort, ix: SnapshotIndex, ctx: PlanContext): ContextBaseline {
  if (ctx.job_ids.length === 0) return NO_BASELINE;
  const metrics = physics.simulatePlan(ix.snap, { commands: ctx.commands }, { horizon_s: PLANNER_HORIZON_S });
  return { metrics, risk: viewRisk(physics, ix.snap, new Set(ctx.job_ids), ctx.commands) ?? 0 };
}

/**
 * The cluster-wide failure_risk_estimate is dominated by the riskiest job anywhere, so it cannot tell two
 * options of ONE job apart. Score the option on a view holding only this job plus the already-planned
 * (higher-priority) jobs with their chosen commands applied, and factor the context's own risk out:
 * job_risk = 1 - (1 - r_view) / (1 - r_context). Approximation: other jobs' load is still in the observed telemetry.
 */
function jobScopedRisk(physics: PhysicsPort, ix: SnapshotIndex, d: DraftOption, ctx: PlanContext, base: ContextBaseline): number {
  const r = viewRisk(physics, ix.snap, new Set([...ctx.job_ids, d.job_id]), [...ctx.commands, ...d.commands]);
  if (r === null) return 0; // no job-scoped estimate: the risk tier then ties and delay decides
  if (ctx.job_ids.length === 0 || base.risk >= 1 - 1e-9) return r;
  return clamp01(1 - (1 - r) / (1 - base.risk));
}

/** Multiset difference: the combined run's violations minus those the context alone already produces. */
function ownViolations(all: string[], context: string[]): string[] {
  const left = new Map<string, number>();
  for (const v of context) left.set(v, (left.get(v) ?? 0) + 1);
  return all.filter((v) => {
    const n = left.get(v) ?? 0;
    if (n === 0) return true;
    left.set(v, n - 1);
    return false;
  });
}

function scoreOption(
  physics: PhysicsPort,
  ix: SnapshotIndex,
  d: DraftOption,
  calls: ToolCallSummary[],
  ctx: PlanContext = EMPTY_CONTEXT,
  base: ContextBaseline = NO_BASELINE,
): Scored {
  const snap = ix.snap;
  const combined =
    d.commands.length === 0 && base.metrics
      ? base.metrics // keep_running in context = the context alone
      : physics.simulatePlan(snap, { commands: [...ctx.commands, ...d.commands] }, { horizon_s: PLANNER_HORIZON_S });
  const metrics: PlanMetrics = { ...combined, violations: ownViolations(combined.violations, base.metrics?.violations ?? []) };
  const job_risk = jobScopedRisk(physics, ix, d, ctx, base);
  const safety = d.commands.map((c) =>
    physics.evaluateSafety(snap, c, { decision_epoch: snap.clock.decision_epoch, leased_resource_ids: [] }),
  );
  const violations = [
    ...new Set([...safety.filter((s) => s.decision === 'deny').flatMap((s) => (s.violations.length ? s.violations : ['SAFETY_DENIED'])), ...metrics.violations]),
  ];
  // Conditional context first (summarized as "after <option ids>→job: op ..." in the event trace).
  const after = ctx.option_ids.length > 0 ? [{ operation: `after ${ctx.option_ids.join(',')}` }] : [];
  const own = d.commands.length
    ? d.commands.map((c) => ({
        operation: c.operation,
        job_id: c.job_id,
        dest_rack_id:
          c.operation === 'migrate_restart'
            ? [...new Set((c.arguments.destination_gpu_ids as string[]).map((g) => rackShort(ix, g)))].join('+')
            : '',
      }))
    : [{ operation: 'keep_running', job_id: d.job_id }];
  const argsSummary = { commands: [...after, ...own] };
  calls.push(summarizeToolCall('simulate_plan', argsSummary, metrics, 'code'));
  calls.push(summarizeToolCall('evaluate_safety', { option_id: d.option_id }, { allowed: violations.length === 0, violations }, 'code'));
  return { ...d, metrics, safety, violations, job_risk };
}

/** Coarse risk bucket (0.1 wide), 0 when within the job's tolerance; the epsilon absorbs float error. */
export const riskTier = (risk: number, tolerance = 0): number => (risk <= tolerance + 1e-9 ? 0 : Math.floor(risk / RISK_TIER_WIDTH + 1e-9));

const preemptions = (o: Scored): number =>
  o.commands.filter((c) => c.operation === 'migrate_restart' || c.operation === 'pause_job').length;

/**
 * Rank per ARCHITECTURE §5. Eligible options get ranks 1..k, excluded ones k+1.. with `excluded_reason`.
 * Metrics are conditional on the context the options were scored in, so comparing with keep_running measures
 * the marginal gain of acting on THIS job given the higher-priority jobs' plan.
 */
export function rankOptions(ix: SnapshotIndex, jobId: string, scored: Scored[], hold: KeepHold | null = null): RankedOption[] {
  const eligible = scored.filter((o) => o.violations.length === 0);
  const excluded = scored.filter((o) => o.violations.length > 0);
  const spec = ix.jobSpec.get(jobId);
  const restartCost = spec ? spec.gpus_required * spec.work_rate_per_gpu_per_sim_s * (spec.restart_duration_ms / 1000) : 0;
  const keep = eligible.find((o) => o.commands.length === 0);
  const keepLost = scored.find((o) => o.commands.length === 0)?.metrics.expected_lost_work_units;
  const bestLost = Math.min(...eligible.map((o) => o.metrics.expected_lost_work_units));
  const avoidable = keepLost !== undefined ? Math.max(0, keepLost - bestLost) : 0;
  const tol = Math.max(restartCost, LOSS_TIE_FRACTION * avoidable);
  const tolerance = riskTolerance(spec?.priority ?? 0);
  const lossTier = (o: Scored) => (o.metrics.expected_lost_work_units <= bestLost + tol ? -1 : o.metrics.expected_lost_work_units);
  const rTier = (o: Scored) => riskTier(o.job_risk, tolerance);
  // A migrate / pause must buy something over keep_running in this context: less lost work (beyond the tie
  // tolerance) or a lower risk tier. Otherwise it is a needless preemption and ranks below keep / cap.
  // Restarting a FAILED job is a recovery, not a preemption (delay then decides).
  const failed = ix.jobState.get(jobId)?.status === 'failed';
  const needless = (o: Scored): number =>
    !failed && keep !== undefined && preemptions(o) > 0 && lossTier(o) >= lossTier(keep) && rTier(o) >= rTier(keep) ? 1 : 0;
  // Rules (a)/(b): a clean keep outlook (checked by keepHold) puts keep_running ahead of every option with commands.
  const held = (o: Scored): number => (hold && keep !== undefined && o.commands.length > 0 ? 1 : 0);
  eligible.sort(
    (a, b) =>
      held(a) - held(b) ||
      lossTier(a) - lossTier(b) ||
      rTier(a) - rTier(b) ||
      needless(a) - needless(b) ||
      a.metrics.expected_completion_delay_sim_s - b.metrics.expected_completion_delay_sim_s ||
      a.metrics.expected_gpu_busy_waste_s - b.metrics.expected_gpu_busy_waste_s ||
      preemptions(a) - preemptions(b) ||
      a.commands.length - b.commands.length ||
      a.option_id.localeCompare(b.option_id),
  );
  excluded.sort((a, b) => a.option_id.localeCompare(b.option_id));
  const strip = ({ violations: _v, ...o }: Scored) => o;
  const withHold = (o: Scored): Omit<RankedOption, 'rank'> =>
    hold && o.commands.length === 0 ? { ...strip(o), label: `${o.label} (${holdText(hold)})`, hold } : strip(o);
  return [
    ...eligible.map((o, i) => ({ ...withHold(o), rank: i + 1 })),
    ...excluded.map((o, i) => ({ ...strip(o), rank: eligible.length + i + 1, excluded_reason: o.violations.join(',') })),
  ];
}

const holdText = (h: KeepHold): string =>
  h.kind === 'completes_first'
    ? `outlook clean until it completes in ~${Math.round(h.window_s)} s`
    : `deferred: outlook clean for the ${Math.round(h.window_s)} s mitigation lead time; re-check scheduled`;

/**
 * RANKING_ASSUMPTION rules (a) and (b) for a RUNNING job: is its keep_running outlook clean (no expected lost work,
 * failure risk < CLEAN_OUTLOOK_MAX_RISK) on a view holding only this job (other jobs' load stays in the observed
 * telemetry, so ignoring the context's mitigations is conservative: they only remove heat)?
 *  (a) clean over the whole horizon and the job completes within it: nothing to mitigate.
 *  (b) only with `recheckAfterS` (the caller re-plans on a schedule): clean over the lead time a mitigation needs
 *      (checkpoint if supported + restart if preemptible + the re-check interval), capped at the job's remaining time.
 */
export function keepHold(physics: PhysicsPort, ix: SnapshotIndex, jobId: string, recheckAfterS?: number): KeepHold | null {
  const state = ix.jobState.get(jobId);
  const spec = ix.jobSpec.get(jobId);
  if (!state || !spec || state.status !== 'running') return null;
  const rate = spec.gpus_required * spec.work_rate_per_gpu_per_sim_s;
  const remainingS = rate > 0 ? Math.max(0, spec.total_work_units - state.progress_work_units) / rate : Infinity;
  const clean = (horizonS: number): boolean => {
    try {
      const m = physics.simulatePlan(jobView(ix.snap, new Set([jobId])), { commands: [] }, { horizon_s: horizonS });
      return m.expected_lost_work_units <= 1e-6 && clamp01(m.failure_risk_estimate) < CLEAN_OUTLOOK_MAX_RISK;
    } catch {
      return false; // no estimate: never hold
    }
  };
  if (remainingS <= PLANNER_HORIZON_S && clean(PLANNER_HORIZON_S)) return { kind: 'completes_first', window_s: remainingS };
  if (recheckAfterS === undefined || !(recheckAfterS > 0)) return null;
  const leadS =
    (spec.checkpoint_supported ? spec.checkpoint_duration_ms / 1000 : 0) + (spec.preemptible ? spec.restart_duration_ms / 1000 : 0) + recheckAfterS;
  const windowS = Math.min(leadS, remainingS, PLANNER_HORIZON_S);
  if (!clean(windowS)) return null;
  // Next re-check: the outlook is known clean through windowS (or the whole horizon), and the mitigation needs leadS
  // from the moment it is decided, so re-planning after (clean span - leadS) is still in time; never before recheckAfterS.
  const cleanSpanS = windowS < PLANNER_HORIZON_S && clean(PLANNER_HORIZON_S) ? PLANNER_HORIZON_S : windowS;
  return { kind: 'deferred', window_s: windowS, recheck_s: Math.max(recheckAfterS, cleanSpanS - leadS + recheckAfterS) };
}

type EnumerateCtx = Parameters<typeof enumerateOptions>[2];

/** Enumerate, score (conditional on `ctx`) and rank one job's options. GPUs claimed by `ctx` are never offered. */
export function rankJobInContext(
  physics: PhysicsPort,
  ix: SnapshotIndex,
  job: AffectedJob,
  ctx: PlanContext,
  enumCtx: EnumerateCtx,
  calls: ToolCallSummary[],
  recheckAfterS?: number,
): RankedOption[] {
  const jix: SnapshotIndex =
    ctx.claimed_gpu_ids.length > 0 ? { ...ix, allocatedGpus: new Set([...ix.allocatedGpus, ...ctx.claimed_gpu_ids]) } : ix;
  const base = contextBaseline(physics, ix, ctx);
  const drafts = enumerateOptions(jix, job, enumCtx);
  const hold = keepHold(physics, ix, job.job_id, recheckAfterS);
  return rankOptions(jix, job.job_id, drafts.map((d) => scoreOption(physics, jix, d, calls, ctx, base)), hold);
}

/** The option deterministic planning takes: rank 1, else keep_running (no commands), else anything. */
export const deterministicTop = (opts: RankedOption[]): RankedOption =>
  opts.find((o) => !o.excluded_reason) ?? opts.find((o) => o.commands.length === 0) ?? opts[0]!;

// ---------------------------------------------------------------------------------------------- Nemotron choice

const choiceItemSchema = z.object({
  job_id: z.string().min(1),
  option_id: z.string().min(1),
  needs_approval: z.boolean(),
  explanation: z.string().min(1),
});
const choiceSchema = z.object({ choices: z.array(z.unknown()).min(1) });
type Choice = z.infer<typeof choiceItemSchema>;

/**
 * Collapse every choose_options call into one choice list (Nemotron sometimes repeats the call): each call is
 * parsed, invalid calls / items are dropped individually, and per job_id the first valid choice wins. Same rule
 * as triage's collectAssessmentItems.
 */
export function collectChoices(calls: readonly { name: string; argumentsJson: string }[]): Choice[] {
  const byJob = new Map<string, Choice>();
  for (const call of calls) {
    if (call.name !== CHOOSE_OPTIONS_TOOL_NAME) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(call.argumentsJson);
    } catch {
      continue;
    }
    const parsed = choiceSchema.safeParse(raw);
    if (!parsed.success) continue;
    for (const item of parsed.data.choices) {
      const c = choiceItemSchema.safeParse(item);
      if (c.success && !byJob.has(c.data.job_id)) byJob.set(c.data.job_id, c.data);
    }
  }
  return [...byJob.values()];
}

const round = (n: number) => Math.round(n * 10) / 10;
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function buildLlmPayload(ix: SnapshotIndex, incidents: Incident[], ranked: Map<string, RankedOption[]>, topN: number): string {
  const order = [...ranked.keys()];
  const jobs = [...ranked].map(([jobId, opts], i) => {
    const spec = ix.jobSpec.get(jobId);
    const st = ix.jobState.get(jobId);
    const keep = opts.find((o) => o.commands.length === 0);
    const vs = (o: RankedOption) =>
      keep
        ? {
            lost_wu: round(o.metrics.expected_lost_work_units - keep.metrics.expected_lost_work_units),
            delay_s: round(o.metrics.expected_completion_delay_sim_s - keep.metrics.expected_completion_delay_sim_s),
            risk: Math.round((o.job_risk - keep.job_risk) * 100) / 100,
          }
        : undefined;
    return {
      job_id: jobId,
      // metrics below assume these higher-priority jobs take their rank-1 option first (sequential planning)
      after_jobs: order.slice(0, i),
      priority: spec?.priority,
      risk_tolerance: spec ? riskTolerance(spec.priority) : undefined,
      preemptible: spec?.preemptible,
      checkpoint_supported: spec?.checkpoint_supported,
      unsaved_work_units: st ? st.progress_work_units - st.durable_work_units : undefined,
      options: opts
        .filter((o) => !o.excluded_reason)
        .slice(0, topN)
        .map((o) => ({
          option_id: o.option_id,
          rank: o.rank,
          label: o.label,
          lost_wu: round(o.metrics.expected_lost_work_units),
          delay_s: round(o.metrics.expected_completion_delay_sim_s),
          waste_s: round(o.metrics.expected_gpu_busy_waste_s),
          risk: Math.round(o.job_risk * 100) / 100,
          ...(o.commands.length > 0 && keep ? { vs_keep: vs(o) } : {}),
        })),
      excluded: opts.filter((o) => o.excluded_reason).slice(0, 4).map((o) => ({ option_id: o.option_id, reason: o.excluded_reason })),
    };
  });
  return JSON.stringify({
    decision_epoch: ix.snap.clock.decision_epoch,
    sim_time_ms: ix.snap.clock.sim_time_ms,
    horizon_s: PLANNER_HORIZON_S,
    incidents: incidents.map((i) => ({ incident_id: i.incident_id, title: i.title, hypothesis: i.hypothesis, evidence_ids: ix.snap.observation_event_ids.slice(0, 8) })),
    jobs,
  });
}

async function askNemotron(
  llm: LlmPort,
  ix: SnapshotIndex,
  incidents: Incident[],
  ranked: Map<string, RankedOption[]>,
  calls: ToolCallSummary[],
): Promise<Choice[] | null> {
  let payload = buildLlmPayload(ix, incidents, ranked, LLM_TOP_OPTIONS);
  if (payload.length > LLM_PAYLOAD_MAX_BYTES) payload = buildLlmPayload(ix, incidents, ranked, 2);
  let res: LlmChatResponse;
  try {
    res = await llm.chat({
      messages: [
        { role: 'system', content: PLANNER_SYSTEM_PROMPT },
        { role: 'user', content: buildPlannerUserMessage(payload) },
      ],
      tools: [CHOOSE_OPTIONS_TOOL],
      toolChoice: 'required',
      maxTokens: PLANNER_MAX_TOKENS,
    });
  } catch (e) {
    calls.push(summarizeToolCall(CHOOSE_OPTIONS_TOOL_NAME, { jobs: ranked.size }, `LLM unavailable: ${e instanceof Error ? e.name : 'error'}`, 'code'));
    return null;
  }
  const choices = collectChoices(res.toolCalls);
  if (choices.length === 0) {
    calls.push(summarizeToolCall(CHOOSE_OPTIONS_TOOL_NAME, { jobs: ranked.size }, 'invalid or missing choose_options call', 'code'));
    return null;
  }
  calls.push(
    summarizeToolCall(
      CHOOSE_OPTIONS_TOOL_NAME,
      { jobs: ranked.size },
      choices.map((c) => `${c.option_id}${c.needs_approval ? ' (approval)' : ''}`).join(', '),
      'nemotron',
    ),
  );
  return choices;
}

// ---------------------------------------------------------------------------------------------- decide

const destinations = (o: RankedOption): string[] =>
  o.commands.flatMap((c) => (c.operation === 'migrate_restart' ? (c.arguments.destination_gpu_ids as string[]) : []));

const requiresApproval = (o: RankedOption): boolean =>
  o.commands.some((c) => c.operation === 'escalate') || o.safety.some((s) => s.decision === 'needs_approval');

function decideJob(opts: RankedOption[], choice: Choice | undefined, llmUp: boolean): Omit<JobPlan, 'alternatives'> & { chosen: RankedOption } {
  const eligible = opts.filter((o) => !o.excluded_reason);
  // keep_running has no commands, so it can never execute an unsafe action; it is the floor when nothing is eligible.
  const top = eligible[0] ?? opts.find((o) => o.commands.length === 0) ?? opts[0]!;
  const jobId = top.job_id;
  if (eligible.length === 0) {
    return { job_id: jobId, chosen: top, decided_by: 'deterministic', needs_approval: true, explanation: 'no safe option; keep running and escalate to an operator' };
  }
  if (!llmUp) {
    return {
      job_id: jobId,
      chosen: top,
      decided_by: 'deterministic',
      needs_approval: top.commands.length > 0,
      explanation: `${DETERMINISTIC_EXPLANATION}: ${top.label}`,
    };
  }
  const picked = choice ? eligible.find((o) => o.option_id === choice.option_id) : undefined;
  if (!choice || !picked) {
    const why = !choice
      ? 'Nemotron gave no choice for this job'
      : `Nemotron chose ${clip(choice.option_id, 60)}, which is ${opts.some((o) => o.option_id === choice.option_id) ? 'excluded by safety' : 'not a listed option'}`;
    return {
      job_id: jobId,
      chosen: top,
      decided_by: 'deterministic',
      needs_approval: (choice?.needs_approval ?? false) || requiresApproval(top),
      explanation: `${why}; overridden to rank-1 ${top.label}`,
    };
  }
  return {
    job_id: jobId,
    chosen: picked,
    decided_by: 'nemotron',
    needs_approval: choice.needs_approval || requiresApproval(picked) || eligible.length === 0,
    explanation: clip(choice.explanation.replace(/\s+/g, ' ').trim(), MAX_EXPLANATION_CHARS),
  };
}

const isOp = (o: RankedOption, op: ActionCommand['operation']): boolean => o.commands.some((c) => c.operation === op);

/**
 * No two jobs may move onto the same GPUs: lower-priority jobs fall back to their next non-conflicting safe
 * option. If none is left, the job never takes a clashing choice: it falls back to keep_running (no commands),
 * else pause, else escalate, flagged needs_approval with the reason in the explanation.
 */
export function resolveConflicts(plans: JobPlan[], ranked: Map<string, RankedOption[]>): JobPlan[] {
  const claimed = new Set<string>();
  return plans.map((p) => {
    const clash = (o: RankedOption) => destinations(o).some((g) => claimed.has(g));
    const opts = ranked.get(p.job_id) ?? [p.chosen, ...p.alternatives];
    let jp = p;
    if (clash(p.chosen)) {
      const alt = opts.find((o) => !o.excluded_reason && !clash(o));
      if (alt) {
        jp = {
          ...p,
          chosen: alt,
          decided_by: 'deterministic',
          needs_approval: p.needs_approval || requiresApproval(alt),
          explanation: `${p.chosen.label} conflicts with a higher-priority job's destination; using ${alt.label}`,
        };
      } else {
        const floor =
          opts.find((o) => o.commands.length === 0) ??
          opts.find((o) => isOp(o, 'pause_job') && !clash(o)) ??
          opts.find((o) => isOp(o, 'escalate') && !clash(o));
        const chosen: RankedOption = floor ?? { ...p.chosen, option_id: `${p.job_id}:keep`, label: `${p.job_id} keep running`, commands: [], not_simulated: true };
        jp = {
          ...p,
          chosen,
          decided_by: 'deterministic',
          needs_approval: true,
          explanation: `${p.chosen.label} conflicts with a higher-priority job's destination and no safe non-conflicting option is left; ${chosen.label}, operator approval needed`,
        };
      }
    }
    for (const g of destinations(jp.chosen)) claimed.add(g);
    return { ...jp, alternatives: (ranked.get(p.job_id) ?? []).filter((o) => o.option_id !== jp.chosen.option_id) };
  });
}

// ---------------------------------------------------------------------------------------------- entry point

export async function planIncidents(deps: PlannerDeps, input: { incidents: Incident[] }): Promise<PlanResult> {
  const { db, physics, llm, workflowId, runId } = deps;
  const attempt = deps.attempt ?? 1;
  if (input.incidents.length === 0) throw new Error('planIncidents: at least one incident is required');
  const incidents = [...input.incidents].sort((a, b) => a.incident_id.localeCompare(b.incident_id));
  const incidentIds = incidents.map((i) => i.incident_id) as [string, ...string[]];

  const snap = await db.getObservedSnapshot();
  const base = indexSnapshot(snap);
  const reserved = deps.reservedGpuIds ?? [];
  const ix: SnapshotIndex = reserved.length > 0 ? { ...base, allocatedGpus: new Set([...base.allocatedGpus, ...reserved]) } : base;
  const epoch = snap.clock.decision_epoch;
  const planId = `plan-${workflowId}-a${attempt}-e${epoch}`;
  let evidence: Evidence | null = null;
  try {
    evidence = await db.getEvidence(incidentIds, EVIDENCE_WINDOW_MS);
  } catch {
    evidence = null; // affected jobs then come from degraded cooling only
  }

  const toolCalls: ToolCallSummary[] = [];
  const enumCtx: EnumerateCtx = { runId, workflowId, attempt, planId, freshCheckpointMaxAgeS: deps.freshCheckpointMaxAgeS };
  const jobs = findAffectedJobs(ix, incidents, evidence);

  // Pass 1 (sequential conditional planning, priority order): each job is scored with the higher-priority jobs'
  // rank-1 commands already applied. `assumed` records the option each later job was conditioned on.
  const ranked = new Map<string, RankedOption[]>();
  const assumed = new Map<string, string>();
  let ctx = EMPTY_CONTEXT;
  for (const job of jobs) {
    const opts = rankJobInContext(physics, ix, job, ctx, enumCtx, toolCalls, deps.recheckAfterS);
    ranked.set(job.job_id, opts);
    const top = deterministicTop(opts);
    assumed.set(job.job_id, top.option_id);
    ctx = extendContext(ctx, top);
  }

  const choices = ranked.size > 0 ? await askNemotron(llm, ix, incidents, ranked, toolCalls) : null;
  const llmUp = choices !== null;
  const byJob = new Map((choices ?? []).map((c) => [c.job_id, c]));

  // Pass 2: apply the choices in priority order. Once a job's final option departs from the one later jobs were
  // conditioned on, every later job is re-scored under the real context (its choice is re-validated there).
  const decided: JobPlan[] = [];
  let finalCtx = EMPTY_CONTEXT;
  let diverged = false;
  for (const job of jobs) {
    let opts = ranked.get(job.job_id)!;
    if (diverged) {
      opts = rankJobInContext(physics, ix, job, finalCtx, enumCtx, toolCalls, deps.recheckAfterS);
      ranked.set(job.job_id, opts);
    }
    const d = decideJob(opts, byJob.get(job.job_id), llmUp);
    if (d.chosen.option_id !== assumed.get(job.job_id)) diverged = true;
    finalCtx = extendContext(finalCtx, d.chosen);
    decided.push({ ...d, alternatives: [] });
  }
  const jobPlans = resolveConflicts(decided, ranked);

  const commands = jobPlans.flatMap((p) => p.chosen.commands);
  const plan = await buildPlan({ physics, ix, planId, runId, workflowId, attempt, incidentIds, jobPlans, commands, llmUp, toolCalls });
  await db.submitPlan(plan);
  const rechecks = [...ranked.values()].flatMap((opts) => opts.flatMap((o) => (o.hold?.kind === 'deferred' ? [o.hold.recheck_s ?? 0] : [])));
  const recheckAfterS = rechecks.length > 0 && deps.recheckAfterS !== undefined ? Math.max(deps.recheckAfterS, Math.min(...rechecks)) : undefined;
  return {
    plan,
    commands,
    job_plans: jobPlans,
    tool_calls: toolCalls,
    used_llm: llmUp,
    candidates: buildCandidates(jobPlans, ix.snap.clock.decision_epoch, ix.snap.clock.sim_time_ms),
    ...planNarrative(jobPlans, llmUp),
    ...(recheckAfterS !== undefined ? { recheck_after_s: recheckAfterS } : {}),
  };
}

interface BuildPlanArgs {
  physics: PhysicsPort;
  ix: SnapshotIndex;
  planId: string;
  runId: string;
  workflowId: string;
  attempt: number;
  incidentIds: [string, ...string[]];
  jobPlans: JobPlan[];
  commands: ActionCommand[];
  llmUp: boolean;
  toolCalls: ToolCallSummary[];
}

async function buildPlan(a: BuildPlanArgs): Promise<PlanCandidate> {
  // Score the combined plan once: per-option metrics are whole-cluster, so summing them would double count.
  const combined = a.physics.simulatePlan(a.ix.snap, { commands: a.commands }, { horizon_s: PLANNER_HORIZON_S });
  a.toolCalls.push(summarizeToolCall('simulate_plan', { commands: a.commands.map((c) => ({ operation: c.operation, job_id: c.job_id })) }, combined, 'code'));

  // PlanCandidate needs >= 1 command key; an all-keep plan records its (never executed) keep_running keys.
  const keepKeys =
    a.jobPlans.length > 0
      ? a.jobPlans.map((p) => commandKey(a.workflowId, 'keep_running', p.job_id, a.attempt))
      : [commandKey(a.workflowId, 'keep_running', a.incidentIds[0], a.attempt)];
  const keys = (a.commands.length > 0 ? a.commands.map((c) => c.command_key) : keepKeys) as [string, ...string[]];

  const assumptions = [
    ...new Set([
      PLANNER_HORIZON_ASSUMPTION,
      `based on decision_epoch ${a.ix.snap.clock.decision_epoch}`,
      RANKING_ASSUMPTION,
      ...combined.assumptions,
      ...a.jobPlans.flatMap((p) => p.chosen.metrics.assumptions),
      a.llmUp ? 'options chosen by Nemotron among safety-checked candidates' : DETERMINISTIC_EXPLANATION,
    ]),
  ].slice(0, MAX_ASSUMPTIONS);

  const explanation =
    a.jobPlans.length > 0
      ? clip(a.jobPlans.map((p) => `${p.job_id}: ${p.chosen.label}. ${p.explanation}`).join(' '), PLAN_EXPLANATION_MAX)
      : 'no running job is affected by these incidents; keep running';

  const plan: PlanCandidate = {
    schema_version: '1.1.0',
    plan_id: a.planId,
    run_id: a.runId,
    workflow_id: a.workflowId,
    incident_ids: a.incidentIds,
    based_on_decision_epoch: a.ix.snap.clock.decision_epoch,
    assumptions,
    command_keys: keys,
    expected_completion_delay_sim_s: combined.expected_completion_delay_sim_s,
    expected_lost_work_units: combined.expected_lost_work_units,
    expected_gpu_busy_waste_s: combined.expected_gpu_busy_waste_s,
    failure_risk_estimate: Math.min(1, Math.max(0, combined.failure_risk_estimate)),
    explanation,
  };
  const v = validatePayload('PlanCandidate', plan);
  if (!v.ok) throw new Error(`planIncidents: invalid PlanCandidate: ${v.errors.join('; ')}`);
  return plan;
}

/**
 * F-NV1 plan/replan event narrative. Nemotron's own one-sentence explanations when the LLM made at least one final
 * decision (`actor: 'nemotron'`); otherwise a clearly labelled deterministic sentence (`actor: 'code'`).
 */
export function planNarrative(jobPlans: JobPlan[], usedLlm: boolean): { summary: string; actor: AgentActor } {
  const nem = usedLlm ? jobPlans.filter((p) => p.decided_by === 'nemotron') : [];
  if (nem.length > 0) return { summary: clip(nem.map((p) => p.explanation).join(' | '), 200), actor: 'nemotron' };
  const text = jobPlans.length > 0 ? jobPlans.map((p) => `${p.job_id}: ${p.chosen.label}`).join('; ') : 'no running job affected, keep running';
  return { summary: clip(`deterministic: ${text}`, 200), actor: 'code' };
}

// ---------------------------------------------------------------------------------------------- persisted candidates (R3b)

export type CandidateOption =
  | 'keep_running'
  | 'power_cap'
  | 'checkpoint'
  | 'checkpoint_then_migrate'
  | 'migrate_restart'
  | 'pause_job'
  | 'escalate'
  | (string & {});

/** One option the planner evaluated for a job, as persisted in `workflow.state.candidates` for the dashboard. */
export interface PersistedCandidate {
  job_id: string;
  option: CandidateOption;
  commands_summary: string;
  /** From simulatePlan; null when the planner did not compute it (never 0 as a stand-in). */
  predicted_lost_work_units: number | null;
  /** The planner's simulatePlan has no work-deficit metric: always null today. */
  predicted_work_deficit_units: number | null;
  predicted_gpu_busy_waste_s: number | null;
  /** Aggregate of the option's evaluateSafety results; 'not_checked' when it has no command (keep_running). */
  safety: 'allow' | 'needs_approval' | 'deny' | 'not_checked';
  violations: string[];
  chosen: boolean;
  /** <= CANDIDATE_REASON_MAX chars: why chosen / rejected. */
  reason: string;
  decided_by: 'nemotron' | 'code';
  snapshot_epoch: number;
  as_of_sim_time_ms: number;
}

export const CANDIDATE_LIMITS = { per_job: 6, total: 24 } as const;
export const CANDIDATE_REASON_MAX = 160;
const CANDIDATE_SUMMARY_MAX = 120;
const CANDIDATE_VIOLATIONS_MAX = 6;
const CANDIDATE_VIOLATION_CHARS = 60;

const finiteOrNull = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null);

function optionKind(o: RankedOption): CandidateOption {
  const ops = o.commands.map((c) => c.operation);
  if (ops.length === 0) return 'keep_running';
  if (ops.includes('migrate_restart')) return ops.includes('checkpoint') ? 'checkpoint_then_migrate' : 'migrate_restart';
  if (ops.includes('pause_job')) return 'pause_job';
  if (ops.length === 1) return ops[0]!;
  return ops.join('+');
}

function candidateSafety(o: RankedOption): PersistedCandidate['safety'] {
  if (o.not_simulated) return 'not_checked';
  if (o.safety.length === 0) return 'not_checked';
  if (o.safety.some((s) => s.decision === 'deny')) return 'deny';
  if (o.safety.some((s) => s.decision === 'needs_approval')) return 'needs_approval';
  return o.safety.every((s) => s.decision === 'allow') ? 'allow' : 'not_checked';
}

const candidateViolations = (o: RankedOption): string[] =>
  [...new Set([...o.safety.flatMap((s) => s.violations), ...(o.excluded_reason ? o.excluded_reason.split(',') : [])].filter(Boolean))]
    .slice(0, CANDIDATE_VIOLATIONS_MAX)
    .map((v) => clip(v, CANDIDATE_VIOLATION_CHARS));

function candidateReason(o: RankedOption, chosen: RankedOption, isChosen: boolean, explanation: string): string {
  if (o.not_simulated) return clip(`not separately simulated: ${isChosen ? explanation : 'fallback'}`, CANDIDATE_REASON_MAX);
  if (isChosen) return clip(explanation, CANDIDATE_REASON_MAX);
  if (o.excluded_reason) return clip(`rejected by deterministic safety: ${o.excluded_reason}`, CANDIDATE_REASON_MAX);
  const lost = finiteOrNull(o.metrics.expected_lost_work_units);
  const chosenLost = finiteOrNull(chosen.metrics.expected_lost_work_units);
  const cmp = lost !== null && chosenLost !== null ? `lost work ${lost} vs ${chosenLost} wu for ${chosen.option_id}` : `ranked below ${chosen.option_id}`;
  return clip(`safe but not chosen (rank ${o.rank}): ${cmp}`, CANDIDATE_REASON_MAX);
}

/** Sort chosen-first, then least predicted lost work (null last), then a stable tie-break. */
const byChosenThenLoss = (a: PersistedCandidate, b: PersistedCandidate): number =>
  Number(b.chosen) - Number(a.chosen) ||
  (a.predicted_lost_work_units ?? Infinity) - (b.predicted_lost_work_units ?? Infinity) ||
  a.job_id.localeCompare(b.job_id) ||
  a.option.localeCompare(b.option) ||
  a.commands_summary.localeCompare(b.commands_summary);

/** Enforce CANDIDATE_LIMITS: <= per_job per job (the chosen one always survives), <= total overall. Pure. */
export function capCandidates(list: readonly PersistedCandidate[]): PersistedCandidate[] {
  const sorted = [...list].sort(byChosenThenLoss);
  const perJob = new Map<string, number>();
  const kept = sorted.filter((c) => {
    const n = perJob.get(c.job_id) ?? 0;
    perJob.set(c.job_id, n + 1);
    return n < CANDIDATE_LIMITS.per_job;
  });
  return kept.slice(0, CANDIDATE_LIMITS.total);
}

/**
 * Candidates from what the planner actually enumerated and scored: each job's chosen option plus its alternatives.
 * Nothing is invented; a metric the planner did not produce is null.
 */
export function buildCandidates(jobPlans: readonly JobPlan[], snapshotEpoch: number, asOfSimTimeMs: number): PersistedCandidate[] {
  const out: PersistedCandidate[] = [];
  for (const jp of jobPlans) {
    const decidedBy = jp.decided_by === 'nemotron' ? 'nemotron' : 'code';
    for (const o of [jp.chosen, ...jp.alternatives]) {
      const isChosen = o === jp.chosen;
      out.push({
        job_id: jp.job_id,
        option: optionKind(o),
        commands_summary: clip(o.label, CANDIDATE_SUMMARY_MAX),
        predicted_lost_work_units: o.not_simulated ? null : finiteOrNull(o.metrics?.expected_lost_work_units),
        predicted_work_deficit_units: null,
        predicted_gpu_busy_waste_s: o.not_simulated ? null : finiteOrNull(o.metrics?.expected_gpu_busy_waste_s),
        safety: candidateSafety(o),
        violations: o.not_simulated ? [] : candidateViolations(o),
        chosen: isChosen,
        reason: candidateReason(o, jp.chosen, isChosen, jp.explanation),
        decided_by: decidedBy,
        snapshot_epoch: snapshotEpoch,
        as_of_sim_time_ms: asOfSimTimeMs,
      });
    }
  }
  return capCandidates(out);
}

/** A newer plan's candidates replace the older entries of the SAME jobs; other jobs' entries are kept. Capped. */
export function mergeCandidates(previous: unknown, next: readonly PersistedCandidate[]): PersistedCandidate[] {
  const prev = Array.isArray(previous) ? (previous as PersistedCandidate[]) : [];
  const replaced = new Set(next.map((c) => c.job_id));
  return capCandidates([...prev.filter((c) => !replaced.has(c.job_id)), ...next]);
}
