// R3 verifier (IMPLEMENTATION-SCOPE §4 "Actions and success criteria" + "Verification"): after execution, read the
// recovery back from FRESH observed snapshots, operation by operation, attach the evidence to each succeeded action
// (verify_action) and persist a durable operator handoff in the workflow state.
//
// Rules (SCOPE §4, CONTRACTS §0.13 #7):
//   - Ledger success is never sufficient: every operation has its own postcondition read-back.
//   - If sim time did not advance, the clock is paused, relevant GPU evidence is older than MAX_EVIDENCE_AGE_SIM_MS or a
//     postcondition is missing -> unverified -> "needs operator review". Never a false green.
//   - A cordoned / failed GPU or a degraded pump is never "repaired" by a workload action; unresolved infrastructure is
//     listed separately as human work.
//   - An acknowledged escalation is a handoff, not a recovered job.
//   - Everything here is deterministic code (actor `code`); nothing is presented as a model conclusion.

import type { ActionCommand, Incident, ObservedSnapshot } from '@dcos/contracts';
import type { CommandOutcome, ExecutablePlan, ExecutionResult } from './coordinator.js';
import type { EventPublisher } from './events.js';
import { CLOCKS_EVENT_SW_POWER_CAP, type DbPort, type PhysicsPort, type ToolCallSummary, type WorkflowStage } from './ports.js';

export const MAX_HANDOFF_CHARS = 600;
/** Two observed samples at least this far apart are needed for any progress claim (SCOPE §2 "GPU evidence maximum age"). */
export const DEFAULT_PROGRESS_WINDOW_SIM_MS = 10_000;
/** GPU readings older than this (sim_time - last_seen) are stale for verification (SCOPE §2). */
export const MAX_EVIDENCE_AGE_SIM_MS = 10_000;
/** Required destination thermal margin over the predictive window (SCOPE §2 numeric model contract). */
export const REQUIRED_DEST_THERMAL_MARGIN_C = 5;
export const HANDOFF_VERSION = 1 as const;
/** Lists inside the persisted handoff are capped so the workflow state stays small. */
const MAX_HANDOFF_LIST = 8;

/** Operations whose verification needs two samples over the progress window. */
const WINDOW_OPS: ReadonlySet<ActionCommand['operation']> = new Set(['migrate_restart', 'power_cap', 'keep_running']);

/**
 * Safety codes that still apply to a job ALREADY placed on its destination (predictive thermal/power headroom, GPU
 * health, freshness, compatibility). Everything else the request-time validator emits is placement-scoped (own
 * allocation reads as busy/leased, versions and epoch moved because of our own commands, a checkpoint is already
 * consumed, the job is "running" instead of "queued") and is filtered out: the phase-aware read of R1 semantics.
 */
const PREDICTIVE_CODES: ReadonlySet<string> = new Set([
  'DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT',
  'DEST_POWER_HEADROOM_INSUFFICIENT',
  'DEST_GPU_UNHEALTHY',
  'DEST_NOT_COMPATIBLE',
  'REAL_GPU_NOT_ALLOCATABLE',
  'EVIDENCE_STALE',
]);

// ----------------------------------------------------------------------------------------------------- types

export interface VerifyDeps {
  db: DbPort;
  events: EventPublisher;
  /** Phase-aware predictive headroom re-check of a completed move (optional; snapshot headroom is always checked). */
  physics?: PhysicsPort;
  /** Wait for `simMs` of simulated time between the two progress snapshots (default: poll the snapshot clock). */
  waitSim?: (simMs: number) => Promise<void>;
  /** Persist the final workflow stage; pass `coordinator.updateStage`. Omitted -> not persisted. */
  persist?: (stage: WorkflowStage, patch: Record<string, unknown>) => Promise<unknown>;
  progressWindowSimMs?: number;
  maxEvidenceAgeSimMs?: number;
}

export interface VerifyInput {
  workflowId: string;
  plan: ExecutablePlan;
  result: ExecutionResult;
}

export interface CommandCheck {
  command_key: string;
  operation: ActionCommand['operation'];
  job_id?: string;
  ok: boolean;
  /** One plain-English fact, used in the handoff. */
  note: string;
  /** Why the check is unverified (empty when ok). */
  problems: string[];
  evidence: Record<string, unknown>;
}

export type HandoffOutcome = 'recovered' | 'handed_off' | 'operator_review';

/**
 * Durable operator handoff persisted as `workflow.state.verification` (SCOPE §5 "Durable handoff"). Readable by a fresh
 * agent connection through `readHandoff`. The first four fields keep the pre-R3 shape for existing readers.
 */
export interface OperatorHandoff {
  [k: string]: unknown;
  verified: boolean;
  escalate: boolean;
  /** Bounded human summary (<= MAX_HANDOFF_CHARS). */
  handoff: string;
  as_of_sim_time_ms: number;
  version: typeof HANDOFF_VERSION;
  /** Deterministic verifier, never a model conclusion. */
  source: 'code';
  outcome: HandoffOutcome;
  /** [first sample, second sample] sim times the evidence comes from. */
  verification_interval_sim_ms: [number, number];
  evidence: {
    incident_ids: string[];
    /** `incident_id: title — hypothesis` for each incident of the workflow. */
    hypotheses: string[];
    decision_epoch: number;
    max_gpu_evidence_age_sim_ms: number | null;
  };
  affected_jobs: Array<{
    job_id: string;
    status: string;
    progress_work_units: number;
    durable_work_units: number;
    racks: string[];
  }>;
  actions: {
    completed: string[];
    verified: string[];
    unverified: string[];
    blocked: Array<{ command_key: string; violations: string[] }>;
    failed: Array<{ command_key: string; reason_code: string }>;
    not_run: string[];
  };
  checkpoint_outcome: Array<{ job_id: string; checkpoint_id: string; status: string; accessible: boolean; progress_work_units: number }>;
  placement_outcome: Array<{ job_id: string; gpu_ids: string[]; racks: string[] }>;
  /** Pump / GPU conditions that still need a human (never claimed repaired). */
  unresolved_infrastructure: string[];
  remaining_risk: string;
  next_human_action: string;
  checks: Array<{ command_key: string; operation: string; ok: boolean; note: string }>;
}

export interface VerificationReport {
  workflow_id: string;
  plan_id: string;
  checks: CommandCheck[];
  /** Every succeeded command verified, nothing blocked/failed/skipped/aborted, and no escalation. */
  verified: boolean;
  escalate: boolean;
  outcome: HandoffOutcome;
  stage: 'done' | 'escalated';
  handoff: string;
  persisted: OperatorHandoff;
  /** Snapshot sim times used as evidence. */
  as_of_sim_time_ms: [number, number];
}

export const REQUIRED_HANDOFF_FIELDS = [
  'version',
  'source',
  'verified',
  'escalate',
  'outcome',
  'handoff',
  'as_of_sim_time_ms',
  'verification_interval_sim_ms',
  'evidence',
  'affected_jobs',
  'actions',
  'checkpoint_outcome',
  'placement_outcome',
  'unresolved_infrastructure',
  'remaining_risk',
  'next_human_action',
  'checks',
] as const;

// ----------------------------------------------------------------------------------------------------- helpers

type Gpu = ObservedSnapshot['gpus'][number];
type Job = ObservedSnapshot['job_states'][number];

const destOf = (cmd: ActionCommand): string[] =>
  Array.isArray(cmd.arguments.destination_gpu_ids) ? (cmd.arguments.destination_gpu_ids as string[]) : [];

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));
const subjectOf = (cmd: ActionCommand): string => cmd.job_id ?? cmd.target_resource_id;
const gpuOf = (snap: ObservedSnapshot, id: string): Gpu | undefined => snap.gpus.find((g) => g.resource_id === id);
const jobOf = (snap: ObservedSnapshot, id: string | null | undefined): Job | undefined => (id ? snap.job_states.find((j) => j.job_id === id) : undefined);
const rackOfGpu = (snap: ObservedSnapshot, id: string): string | undefined =>
  snap.nodes.find((n) => n.resource_id === gpuOf(snap, id)?.node_id)?.rack_id;
const racksOf = (snap: ObservedSnapshot, ids: readonly string[]): string[] =>
  [...new Set(ids.map((g) => rackOfGpu(snap, g)).filter((r): r is string => !!r))].sort();
const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
const capList = (xs: readonly string[]): string[] =>
  xs.length <= MAX_HANDOFF_LIST ? [...xs] : [...xs.slice(0, MAX_HANDOFF_LIST), `+${xs.length - MAX_HANDOFF_LIST} more`];

const evidenceAge = (snap: ObservedSnapshot, g: Gpu): number => snap.clock.sim_time_ms - g.last_seen_sim_ms;

/** GPUs whose readings in `snap` are missing or older than `maxAge`, as problem strings. */
function staleProblems(snap: ObservedSnapshot, ids: readonly string[], maxAge: number, label: string): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const g = gpuOf(snap, id);
    if (!g) {
      out.push(`${id} missing from ${label}`);
      continue;
    }
    const age = evidenceAge(snap, g);
    if (age > maxAge) out.push(`EVIDENCE_STALE: ${id} last seen ${age} sim-ms ago in ${label}`);
  }
  return out;
}

function maxAge(snap: ObservedSnapshot, ids: readonly string[]): number | null {
  const ages = ids.map((id) => gpuOf(snap, id)).filter((g): g is Gpu => !!g).map((g) => evidenceAge(snap, g));
  return ages.length ? Math.max(...ages) : null;
}

/** Why the two samples cannot support a progress claim (paused clock, no time passed, window too short). */
function clockProblems(s1: ObservedSnapshot, s2: ObservedSnapshot, windowMs: number, needWindow: boolean): string[] {
  const out: string[] = [];
  if (s2.clock.paused) out.push('sim clock paused');
  if (!needWindow) return out;
  const d = s2.clock.sim_time_ms - s1.clock.sim_time_ms;
  if (d <= 0) out.push('sim time did not advance between samples');
  else if (d < windowMs) out.push(`observed window ${d} sim-ms < ${windowMs} sim-ms`);
  return out;
}

/** Problems with "the job keeps working": running with advancing progress over the window, or completed. */
function progressProblems(j1: Job | undefined, j2: Job | undefined, s1: ObservedSnapshot, s2: ObservedSnapshot, windowMs: number): string[] {
  if (!j2) return ['job missing from snapshot'];
  if (j2.status === 'completed') return [];
  const out: string[] = [];
  if (j2.status !== 'running') out.push(`status ${j2.status}`);
  out.push(...clockProblems(s1, s2, windowMs, true));
  if (!j1 || j2.progress_work_units <= j1.progress_work_units) out.push('progress not increasing');
  return out;
}

const fmtProgress = (j1: Job | undefined, j2: Job | undefined): string => `${j1?.progress_work_units ?? '?'}→${j2?.progress_work_units ?? '?'} wu`;

interface CheckCtx {
  physics?: PhysicsPort;
  windowMs: number;
  maxAgeMs: number;
  result: ExecutionResult;
}

function check(cmd: ActionCommand, problems: string[], okNote: string, evidence: Record<string, unknown>): CommandCheck {
  const ok = problems.length === 0;
  const out: CommandCheck = {
    command_key: cmd.command_key,
    operation: cmd.operation,
    ok,
    note: ok ? okNote : `${cmd.operation} ${subjectOf(cmd)} unverified (${problems.join('; ')})`,
    problems,
    evidence,
  };
  if (cmd.job_id) out.job_id = cmd.job_id;
  return out;
}

// ----------------------------------------------------------------------------------------------------- per-operation

/** Checkpoint: a complete, accessible row for THIS command key and protected work. Re-verification is idempotent. */
function checkCheckpoint(cmd: ActionCommand, snap: ObservedSnapshot, ctx: CheckCtx): CommandCheck {
  const jobId = subjectOf(cmd);
  const job = jobOf(snap, jobId);
  const cp = snap.checkpoints.find((c) => c.command_key === cmd.command_key && c.job_id === jobId);
  const before = ctx.result.baseline?.durable_work_units[jobId];
  const problems: string[] = [];
  if (snap.clock.paused) problems.push('sim clock paused');
  if (!job) problems.push('job missing from snapshot');
  if (!cp) problems.push(`no checkpoint row for command key`);
  else {
    if (cp.status !== 'complete') problems.push(`checkpoint ${cp.checkpoint_id} is ${cp.status}, not complete`);
    if (!cp.accessible) problems.push(`checkpoint ${cp.checkpoint_id} not accessible (storage ${cp.storage_resource_id})`);
    if (cp.status === 'complete' && cp.complete_sim_time_ms === null) problems.push('complete checkpoint without completion time');
    if (job && job.durable_work_units < cp.progress_work_units) problems.push(`durable ${job.durable_work_units} < checkpoint ${cp.progress_work_units} wu`);
  }
  // Protected work: durable never went below what the plan started from. A second verification of the same complete
  // checkpoint does NOT need durable to rise again (idempotent re-verify).
  if (job && before !== undefined && job.durable_work_units < before) problems.push(`durable fell ${before}→${job.durable_work_units} wu`);
  const note = `${jobId} checkpoint ${cp?.checkpoint_id} complete+accessible, durable ${before ?? '?'}→${job?.durable_work_units} wu`;
  return check(cmd, problems, note, {
    checkpoint_id: cp?.checkpoint_id ?? null,
    checkpoint_status: cp?.status ?? null,
    accessible: cp?.accessible ?? null,
    checkpoint_work_units: cp?.progress_work_units ?? null,
    durable_before: before ?? null,
    durable_after: job?.durable_work_units ?? null,
    sim_time_ms: snap.clock.sim_time_ms,
  });
}

/**
 * Migration: two fresh samples over the window, the EXACT destination, advancing (or completed) work, healthy destination
 * GPUs, and predictive headroom (snapshot projection with the required margin + the phase-aware physics re-check).
 */
function checkMigrate(cmd: ActionCommand, s1: ObservedSnapshot, s2: ObservedSnapshot, ctx: CheckCtx): CommandCheck {
  const jobId = subjectOf(cmd);
  const dest = destOf(cmd);
  const j1 = jobOf(s1, jobId);
  const j2 = jobOf(s2, jobId);
  const problems: string[] = [];

  if (!j2) problems.push('job missing from snapshot');
  else if (!sameSet(j2.allocated_gpu_ids, dest)) problems.push('not on planned destination GPUs');
  const foreign = s2.allocations.filter((a) => dest.includes(a.gpu_id) && a.job_id !== jobId).map((a) => `${a.gpu_id}→${a.job_id}`);
  if (foreign.length) problems.push(`destination also allocated to ${foreign.slice(0, 3).join(', ')}`);
  problems.push(...progressProblems(j1, j2, s1, s2, ctx.windowMs));

  // Destination health, fresh in BOTH samples.
  for (const id of dest) {
    const g = gpuOf(s2, id);
    if (!g) continue; // reported by staleProblems
    if (g.availability !== 'ready') problems.push(`${id} ${g.availability}`);
    if (g.last_xid_code !== null && g.last_xid_code !== undefined) problems.push(`${id} XID ${g.last_xid_code}`);
  }
  problems.push(...staleProblems(s1, dest, ctx.maxAgeMs, 'sample 1'), ...staleProblems(s2, dest, ctx.maxAgeMs, 'sample 2'));

  // Predictive headroom from the snapshot projection (SCOPE §2: projected headroom; 5 C required margin).
  const nodeIds = uniq(dest.map((g) => gpuOf(s2, g)?.node_id).filter((x): x is string => !!x));
  const headroom: Record<string, { thermal_c: number; power_w: number }> = {};
  if (nodeIds.length === 0) problems.push('destination nodes unknown');
  for (const id of nodeIds) {
    const n = s2.nodes.find((x) => x.resource_id === id);
    if (!n) {
      problems.push(`${id} missing from snapshot`);
      continue;
    }
    headroom[n.rack_id] = { thermal_c: n.thermal_headroom_c, power_w: n.power_headroom_w };
    if (n.thermal_headroom_c < REQUIRED_DEST_THERMAL_MARGIN_C) problems.push(`${n.rack_id} thermal headroom ${n.thermal_headroom_c} C < ${REQUIRED_DEST_THERMAL_MARGIN_C} C`);
    if (n.power_headroom_w < 0) problems.push(`${n.rack_id} power headroom ${n.power_headroom_w} W < 0`);
  }

  // Phase-aware physics re-check: the job's own placement is recognised (placement-scoped codes filtered out).
  let predictive: string[] | null = null;
  if (ctx.physics) {
    try {
      const probe: ActionCommand = { ...cmd, expected_decision_epoch: s2.clock.decision_epoch, expected_resource_versions: {}, depends_on_command_keys: [] };
      const d = ctx.physics.evaluateSafety(s2, probe, { decision_epoch: s2.clock.decision_epoch, leased_resource_ids: [] });
      predictive = d.violations.filter((v) => PREDICTIVE_CODES.has(v));
      if (predictive.length) problems.push(`predictive check: ${predictive.join(', ')}`);
    } catch (e) {
      problems.push(`predictive check unavailable: ${(e as Error).message}`);
    }
  }

  const racks = Object.keys(headroom).sort();
  const minHead = racks.length ? Math.min(...racks.map((r) => headroom[r]?.thermal_c ?? 0)) : NaN;
  const window = s2.clock.sim_time_ms - s1.clock.sim_time_ms;
  const note =
    j2?.status === 'completed'
      ? `${jobId} completed on ${dest.length} GPUs in ${racks.join(',')}`
      : `${jobId} running on ${dest.length} GPUs in ${racks.join(',')}; progress ${fmtProgress(j1, j2)} over ${window} sim-ms; headroom ≥${minHead} C`;
  return check(cmd, problems, note, {
    destination_gpu_ids: dest,
    allocated_gpu_ids: j2?.allocated_gpu_ids ?? [],
    job_status: j2?.status ?? null,
    progress_work_units: [j1?.progress_work_units ?? null, j2?.progress_work_units ?? null],
    sim_time_ms: [s1.clock.sim_time_ms, s2.clock.sim_time_ms],
    max_evidence_age_sim_ms: maxAge(s2, dest),
    dest_headroom: headroom,
    required_thermal_margin_c: REQUIRED_DEST_THERMAL_MARGIN_C,
    predictive_violations: predictive,
  });
}

/** GPUs a power_cap acts on: the job's GPUs, else the target GPU, else the GPUs of the target node. */
function cappedGpus(cmd: ActionCommand, snap: ObservedSnapshot): string[] {
  const job = jobOf(snap, cmd.job_id);
  if (job) return [...job.allocated_gpu_ids];
  const t = cmd.target_resource_id;
  if (gpuOf(snap, t)) return [t];
  return snap.gpus.filter((g) => g.node_id === t).map((g) => g.resource_id);
}

/** Power cap: limit applied on every targeted GPU (fresh), a modeled draw/clock effect, and continued progress. */
function checkPowerCap(cmd: ActionCommand, s1: ObservedSnapshot, s2: ObservedSnapshot, ctx: CheckCtx): CommandCheck {
  const limit = typeof cmd.arguments.power_limit_w === 'number' ? cmd.arguments.power_limit_w : null;
  const gpus = cappedGpus(cmd, s2);
  const problems: string[] = [];
  if (limit === null) problems.push('no power_limit_w in command');
  if (gpus.length === 0) problems.push('no targeted GPUs');
  problems.push(...staleProblems(s2, gpus, ctx.maxAgeMs, 'sample 2'));
  const readings: Array<{ gpu_id: string; power_limit_w: number; power_w: number; sm_clock_mhz: number; cap_bit: boolean }> = [];
  for (const id of gpus) {
    const g = gpuOf(s2, id);
    if (!g || limit === null) continue;
    const capBit = (g.clocks_event_reasons & CLOCKS_EVENT_SW_POWER_CAP) !== 0;
    readings.push({ gpu_id: id, power_limit_w: g.power_limit_w, power_w: g.power_w, sm_clock_mhz: g.sm_clock_mhz, cap_bit: capBit });
    if (g.power_limit_w > limit) problems.push(`limit not applied on ${id} (${g.power_limit_w} W > ${limit} W)`);
    else if (!capBit && g.power_w > g.power_limit_w) problems.push(`no modeled draw/clock effect on ${id} (draw ${g.power_w} W > limit, no cap flag)`);
  }
  const j1 = jobOf(s1, cmd.job_id);
  const j2 = jobOf(s2, cmd.job_id);
  if (cmd.job_id) problems.push(...progressProblems(j1, j2, s1, s2, ctx.windowMs));
  else problems.push(...clockProblems(s1, s2, ctx.windowMs, true));
  const maxDraw = readings.length ? Math.max(...readings.map((r) => r.power_w)) : null;
  const note = `${subjectOf(cmd)} capped at ${limit} W on ${gpus.length} GPUs (limit applied, draw ≤${maxDraw} W)${cmd.job_id ? `; progress ${fmtProgress(j1, j2)}` : ''}; cooling fault unchanged`;
  return check(cmd, problems, note, {
    power_limit_w: limit,
    gpus: readings.slice(0, MAX_HANDOFF_LIST),
    job_status: j2?.status ?? null,
    progress_work_units: [j1?.progress_work_units ?? null, j2?.progress_work_units ?? null],
    sim_time_ms: [s1.clock.sim_time_ms, s2.clock.sim_time_ms],
    max_evidence_age_sim_ms: maxAge(s2, gpus),
    pump_repaired: false,
  });
}

/** Pause: the job is observed paused and its durable work is preserved (pause writes no checkpoint). */
function checkPause(cmd: ActionCommand, snap: ObservedSnapshot, ctx: CheckCtx): CommandCheck {
  const jobId = subjectOf(cmd);
  const job = jobOf(snap, jobId);
  const before = ctx.result.baseline?.durable_work_units[jobId];
  const problems: string[] = [];
  if (snap.clock.paused) problems.push('sim clock paused');
  if (!job) problems.push('job missing from snapshot');
  else {
    if (job.status !== 'paused') problems.push(`status ${job.status}, not paused`);
    if (before !== undefined && job.durable_work_units < before) problems.push(`durable fell ${before}→${job.durable_work_units} wu`);
  }
  const note = `${jobId} paused; durable ${job?.durable_work_units} wu preserved (pause creates no checkpoint)`;
  return check(cmd, problems, note, {
    job_status: job?.status ?? null,
    durable_before: before ?? null,
    durable_after: job?.durable_work_units ?? null,
    allocated_gpu_ids: job?.allocated_gpu_ids ?? [],
    sim_time_ms: snap.clock.sim_time_ms,
  });
}

/** Keep running: observed ongoing (advancing) or completed work with fresh evidence from its GPUs. */
function checkKeep(cmd: ActionCommand, s1: ObservedSnapshot, s2: ObservedSnapshot, ctx: CheckCtx): CommandCheck {
  const jobId = subjectOf(cmd);
  const j1 = jobOf(s1, jobId);
  const j2 = jobOf(s2, jobId);
  const problems = progressProblems(j1, j2, s1, s2, ctx.windowMs);
  const gpus = j2?.allocated_gpu_ids ?? [];
  problems.push(...staleProblems(s2, gpus, ctx.maxAgeMs, 'sample 2'));
  const window = s2.clock.sim_time_ms - s1.clock.sim_time_ms;
  const note =
    j2?.status === 'completed' ? `${jobId} completed` : `${jobId} still running on ${gpus.length} GPUs; progress ${fmtProgress(j1, j2)} over ${window} sim-ms`;
  return check(cmd, problems, note, {
    job_status: j2?.status ?? null,
    progress_work_units: [j1?.progress_work_units ?? null, j2?.progress_work_units ?? null],
    sim_time_ms: [s1.clock.sim_time_ms, s2.clock.sim_time_ms],
    max_evidence_age_sim_ms: maxAge(s2, gpus),
  });
}

/** Cordon: new placement prevented, failure status preserved; never a repair. */
function checkCordon(cmd: ActionCommand, snap: ObservedSnapshot): CommandCheck {
  const gpuId = cmd.target_resource_id;
  const g = gpuOf(snap, gpuId);
  const allocated = snap.allocations.some((a) => a.gpu_id === gpuId);
  const problems: string[] = [];
  if (!g) problems.push(`${gpuId} missing from snapshot`);
  else if (g.availability === 'ready') problems.push(`${gpuId} back to ready (cordon not holding)`);
  if (allocated) problems.push(`${gpuId} still allocated`);
  const note = `${gpuId} still ${g?.availability} (not repaired), no jobs on it`;
  return check(cmd, problems, note, { gpu_id: gpuId, availability: g?.availability ?? null, allocated, last_xid_code: g?.last_xid_code ?? null, repaired: false });
}

/** Escalate: the handoff is acknowledged; that is NOT a recovered job. */
function checkEscalate(cmd: ActionCommand, snap: ObservedSnapshot): CommandCheck {
  const reason = typeof cmd.arguments.reason === 'string' ? cmd.arguments.reason : '';
  const note = `${subjectOf(cmd)} escalation acknowledged (${reason || 'no reason given'}): handed to operator, not a recovered job`;
  return check(cmd, [], note, { handed_off: true, recovered: false, reason, sim_time_ms: snap.clock.sim_time_ms });
}

function checkOther(cmd: ActionCommand, snap: ObservedSnapshot): CommandCheck {
  return check(cmd, [`no read-back defined for ${cmd.operation}`], '', { sim_time_ms: snap.clock.sim_time_ms });
}

function runCheck(cmd: ActionCommand, s1: ObservedSnapshot, s2: ObservedSnapshot, ctx: CheckCtx): CommandCheck {
  switch (cmd.operation) {
    case 'checkpoint':
      return checkCheckpoint(cmd, s2, ctx);
    case 'migrate_restart':
      return checkMigrate(cmd, s1, s2, ctx);
    case 'power_cap':
      return checkPowerCap(cmd, s1, s2, ctx);
    case 'pause_job':
      return checkPause(cmd, s2, ctx);
    case 'keep_running':
      return checkKeep(cmd, s1, s2, ctx);
    case 'cordon_gpu':
      return checkCordon(cmd, s2);
    case 'escalate':
      return checkEscalate(cmd, s2);
    default:
      return checkOther(cmd, s2);
  }
}

// ----------------------------------------------------------------------------------------------------- handoff

interface InfraState {
  /** Pumps not in `normal` state (loop rows mirror pumps and are not listed twice). */
  pumps: string[];
  /** GPUs with a latched failure / unreachable / cordoned: hardware service, never repaired by workload actions. */
  hardwareGpus: string[];
  /** GPUs merely in thermal slowdown (degraded, no XID): the cooling fault's symptom, not a hardware ticket. */
  throttledGpus: string[];
  lines: string[];
}

/** Pumps / GPUs that still need a human after the workload actions. Never phrased as repaired. */
function infraState(snap: ObservedSnapshot): InfraState {
  const kind = new Map(snap.resources.map((r) => [r.resource_id, r.kind]));
  const lines: string[] = [];
  const pumps: string[] = [];
  for (const c of snap.cooling) {
    if (c.operating_state === 'normal') continue;
    const k = kind.get(c.resource_id);
    if (k === 'cooling_loop' || (k === undefined && c.resource_id.startsWith('loop-'))) continue;
    const cap = c.observed_capacity_estimate_w !== null ? ` (est. ${Math.round(c.observed_capacity_estimate_w)}/${Math.round(c.nominal_capacity_w)} W)` : '';
    pumps.push(c.resource_id);
    lines.push(`${c.resource_id} ${c.operating_state}${cap}: needs human service`);
  }
  const hardware = snap.gpus.filter((g) => g.availability !== 'ready' && (g.last_xid_code !== null || g.availability !== 'degraded'));
  const throttled = snap.gpus.filter((g) => g.availability === 'degraded' && g.last_xid_code === null);
  for (const g of capList(hardware.map((g) => `${g.resource_id} ${g.availability}${g.last_xid_code !== null ? ` (XID ${g.last_xid_code})` : ''}: needs hardware service`))) lines.push(g);
  if (throttled.length) {
    const racks = racksOf(snap, throttled.map((g) => g.resource_id));
    lines.push(`${throttled.length} GPU(s) in thermal slowdown on ${racks.join(',')} (cooling symptom, clears with the pump)`);
  }
  return { pumps, hardwareGpus: hardware.map((g) => g.resource_id), throttledGpus: throttled.map((g) => g.resource_id), lines };
}

export const unresolvedInfrastructure = (snap: ObservedSnapshot): string[] => infraState(snap).lines;

/** GPUs the plan touched that are cordoned and not already covered by a cordon check. */
function cordonedNotes(plan: ExecutablePlan, snap: ObservedSnapshot, already: Set<string>): string[] {
  const ids = new Set<string>();
  for (const c of plan.commands) {
    ids.add(c.target_resource_id);
    for (const d of destOf(c)) ids.add(d);
  }
  return snap.gpus
    .filter((g) => ids.has(g.resource_id) && g.availability === 'cordoned' && !already.has(g.resource_id))
    .map((g) => `${g.resource_id} remains cordoned (not repaired)`);
}

const describeNotOk = (o: CommandOutcome): string => {
  const why = o.violations?.length ? o.violations.join(',') : (o.reason_code ?? o.status);
  return `${o.operation} ${o.job_id ?? ''} ${o.status} (${why}) [${o.command_key}]`.replace(/\s+/g, ' ');
};

function remainingRisk(snap: ObservedSnapshot, jobIds: readonly string[], checks: readonly CommandCheck[], notOk: readonly CommandOutcome[]): string {
  const parts: string[] = [];
  const unverified = checks.filter((c) => !c.ok).map((c) => c.command_key);
  if (unverified.length) parts.push(`unverified: ${capList(unverified).join(', ')}`);
  if (notOk.length) parts.push(`not completed: ${capList(notOk.map((o) => `${o.operation} ${o.job_id ?? o.command_key} ${o.status}`)).join(', ')}`);
  for (const id of jobIds) {
    const j = jobOf(snap, id);
    if (!j || (j.status !== 'running' && j.status !== 'checkpointing')) continue;
    for (const rack of racksOf(snap, j.allocated_gpu_ids)) {
      const n = snap.nodes.find((x) => x.rack_id === rack);
      if (n && n.thermal_headroom_c < REQUIRED_DEST_THERMAL_MARGIN_C) parts.push(`${id} on ${rack} with thermal headroom ${n.thermal_headroom_c} C`);
    }
  }
  if (parts.length === 0) parts.push('forecast assumes the observed degradation persists and no hidden faults');
  return parts.join('; ');
}

function nextHumanAction(outcome: HandoffOutcome, infra: InfraState, checks: readonly CommandCheck[], notOk: readonly CommandOutcome[], reason?: string): string {
  const parts: string[] = [];
  if (outcome !== 'recovered') {
    const items = [...checks.filter((c) => !c.ok).map((c) => c.command_key), ...notOk.map((o) => o.command_key)];
    parts.push(items.length ? `review ${items.length} unverified/blocked action(s): ${capList(items).join(', ')}` : (reason ?? 'review the escalation'));
  }
  if (infra.pumps.length) parts.push(`service ${infra.pumps.join(', ')}`);
  if (infra.hardwareGpus.length) parts.push(`inspect/replace ${capList(infra.hardwareGpus).join(', ')}`);
  if (parts.length === 0) parts.push('none pending from the agent; keep monitoring');
  return parts.join('; ');
}

export interface HandoffBuildInput {
  snapshot: ObservedSnapshot;
  incidents: readonly Incident[];
  incidentIds: readonly string[];
  checks: readonly CommandCheck[];
  outcomes: readonly CommandOutcome[];
  aborted: boolean;
  jobIds: readonly string[];
  interval: [number, number];
  outcome: HandoffOutcome;
  /** Leading sentence(s) of the human summary; the default is derived from `outcome`. */
  headline?: string;
  /** Escalation / no-action reason shown when there are no checks. */
  reason?: string;
  /** Extra sentences for the human summary (e.g. "x remains cordoned"). */
  extra?: readonly string[];
}

const HEADLINES: Record<HandoffOutcome, string> = {
  recovered: 'Recovery verified.',
  handed_off: 'Handed off to operator (not a recovered job).',
  operator_review: 'Needs operator review.',
};

/** Pure builder of the durable handoff; also used by the agent loop for no-action and escalation closes. */
export function buildOperatorHandoff(input: HandoffBuildInput): OperatorHandoff {
  const { snapshot: snap, checks, outcomes, outcome } = input;
  const notOk = outcomes.filter((o) => o.status !== 'succeeded');
  const infra = infraState(snap);
  const unresolved = infra.lines;
  const verified = outcome === 'recovered';
  const escalate = !verified;

  const parts: string[] = [];
  for (const c of checks) parts.push(`${c.note} [${c.command_key}]`);
  for (const o of notOk) parts.push(describeNotOk(o));
  if (input.aborted && notOk.length === 0) parts.push('execution aborted before completion');
  if (checks.length === 0 && input.reason) parts.push(input.reason);
  parts.push(...(input.extra ?? []));
  const next = nextHumanAction(outcome, infra, checks, notOk, input.reason);
  const head = input.headline ?? HEADLINES[outcome];
  const hasCordon = checks.some((c) => c.operation === 'cordon_gpu') || (input.extra?.length ?? 0) > 0;
  const tail = `${hasCordon ? ' Cordoned GPUs still need hardware service.' : ''}${unresolved.length ? ` Still open: ${capList(unresolved).slice(0, 3).join('; ')}.` : ''} Next: ${next}.`;
  let text = `${head} ${parts.join('. ')}.${tail}`.replace(/\.\.+/g, '.').replace(/\s+/g, ' ').trim();
  if (text.length > MAX_HANDOFF_CHARS) text = `${text.slice(0, MAX_HANDOFF_CHARS - 1)}…`;

  const jobIds = uniq([...input.jobIds, ...checks.map((c) => c.job_id).filter((j): j is string => !!j)]);
  const inc = input.incidents.filter((i) => input.incidentIds.includes(i.incident_id));
  const byStatus = (s: CommandOutcome['status']) => outcomes.filter((o) => o.status === s);
  return {
    verified,
    escalate,
    handoff: text,
    as_of_sim_time_ms: input.interval[1],
    version: HANDOFF_VERSION,
    source: 'code',
    outcome,
    verification_interval_sim_ms: input.interval,
    evidence: {
      incident_ids: [...input.incidentIds],
      hypotheses: inc.map((i) => `${i.incident_id}: ${i.title}${i.hypothesis ? ` — ${i.hypothesis}` : ''}`),
      decision_epoch: snap.clock.decision_epoch,
      max_gpu_evidence_age_sim_ms: maxAge(
        snap,
        jobIds.flatMap((id) => jobOf(snap, id)?.allocated_gpu_ids ?? []),
      ),
    },
    affected_jobs: jobIds.map((id) => {
      const j = jobOf(snap, id);
      return {
        job_id: id,
        status: j?.status ?? 'unknown',
        progress_work_units: j?.progress_work_units ?? 0,
        durable_work_units: j?.durable_work_units ?? 0,
        racks: j ? racksOf(snap, j.allocated_gpu_ids) : [],
      };
    }),
    actions: {
      completed: byStatus('succeeded').map((o) => o.command_key),
      verified: checks.filter((c) => c.ok && c.operation !== 'escalate').map((c) => c.command_key),
      unverified: checks.filter((c) => !c.ok).map((c) => c.command_key),
      blocked: byStatus('blocked').map((o) => ({ command_key: o.command_key, violations: o.violations ?? [] })),
      failed: [...byStatus('failed'), ...byStatus('cancelled')].map((o) => ({ command_key: o.command_key, reason_code: o.reason_code ?? o.status })),
      not_run: [...byStatus('skipped'), ...byStatus('aborted')].map((o) => o.command_key),
    },
    checkpoint_outcome: snap.checkpoints
      .filter((c) => jobIds.includes(c.job_id) && outcomes.some((o) => o.command_key === c.command_key))
      .map((c) => ({ job_id: c.job_id, checkpoint_id: c.checkpoint_id, status: c.status, accessible: c.accessible, progress_work_units: c.progress_work_units })),
    placement_outcome: jobIds
      .map((id) => jobOf(snap, id))
      .filter((j): j is Job => !!j)
      .map((j) => ({ job_id: j.job_id, gpu_ids: [...j.allocated_gpu_ids], racks: racksOf(snap, j.allocated_gpu_ids) })),
    unresolved_infrastructure: unresolved,
    remaining_risk: remainingRisk(snap, jobIds, checks, notOk),
    next_human_action: next,
    checks: checks.map((c) => ({ command_key: c.command_key, operation: c.operation, ok: c.ok, note: c.note })),
  };
}

/** Required handoff fields missing from `v` (empty = a complete OperatorHandoff). */
export function handoffMissingFields(v: unknown): string[] {
  if (!v || typeof v !== 'object') return [...REQUIRED_HANDOFF_FIELDS];
  const o = v as Record<string, unknown>;
  return REQUIRED_HANDOFF_FIELDS.filter((f) => o[f] === undefined || o[f] === null);
}

export const isOperatorHandoff = (v: unknown): v is OperatorHandoff =>
  handoffMissingFields(v).length === 0 && (v as OperatorHandoff).source === 'code' && (v as OperatorHandoff).version === HANDOFF_VERSION;

/** The persisted handoff of a workflow as a fresh connection sees it (`workflow.state.verification`), or null. */
export async function readHandoff(db: Pick<DbPort, 'getWorkflow'>, workflowId: string): Promise<OperatorHandoff | null> {
  const wf = await db.getWorkflow(workflowId);
  const v = wf?.state.verification;
  return isOperatorHandoff(v) ? v : null;
}

// ----------------------------------------------------------------------------------------------------- entry point

function defaultWaitSim(db: DbPort): (simMs: number) => Promise<void> {
  return async (simMs) => {
    const start = (await db.getObservedSnapshot()).clock.sim_time_ms;
    const deadline = Date.now() + Math.max(5_000, simMs * 3);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      if ((await db.getObservedSnapshot()).clock.sim_time_ms >= start + simMs) return;
    }
  };
}

export async function verifyRecovery(deps: VerifyDeps, input: VerifyInput): Promise<VerificationReport> {
  const { db, events } = deps;
  const { workflowId, plan, result } = input;
  const waitSim = deps.waitSim ?? defaultWaitSim(db);
  const windowMs = deps.progressWindowSimMs ?? DEFAULT_PROGRESS_WINDOW_SIM_MS;
  const maxAgeMs = deps.maxEvidenceAgeSimMs ?? MAX_EVIDENCE_AGE_SIM_MS;
  const byKey = new Map(plan.commands.map((c) => [c.command_key, c]));
  const succeeded = result.outcomes.filter((o) => o.status === 'succeeded');
  const notOk = result.outcomes.filter((o) => o.status !== 'succeeded');

  // Two samples: the second one only after the progress window when any check needs observed progress.
  const s1 = await db.getObservedSnapshot();
  const needsWindow = succeeded.some((o) => WINDOW_OPS.has(o.operation));
  if (needsWindow) await waitSim(windowMs);
  const s2 = needsWindow ? await db.getObservedSnapshot() : s1;

  const ctx: CheckCtx = { windowMs, maxAgeMs, result, ...(deps.physics ? { physics: deps.physics } : {}) };
  const checks: CommandCheck[] = [];
  for (const o of succeeded) {
    const cmd = byKey.get(o.command_key);
    if (cmd) checks.push(runCheck(cmd, s1, s2, ctx));
  }

  const toolCalls: ToolCallSummary[] = [];
  let ledgerOk = true;
  for (const c of checks) {
    try {
      await db.verifyAction(c.command_key, { verified: c.ok, note: c.note, problems: c.problems, verified_by: 'code', ...c.evidence });
      toolCalls.push({ tool: 'verify_action', args_summary: c.command_key, result_summary: c.ok ? 'verified' : `unverified: ${c.problems.join('; ')}`, actor: 'code' });
    } catch (e) {
      ledgerOk = false;
      toolCalls.push({ tool: 'verify_action', args_summary: c.command_key, result_summary: `error: ${(e as Error).message}`, actor: 'code' });
    }
  }

  const cordonedChecked = new Set(checks.filter((c) => c.operation === 'cordon_gpu').map((c) => String(c.evidence.gpu_id)));
  const extra = cordonedNotes(plan, s2, cordonedChecked);
  const allOk = ledgerOk && notOk.length === 0 && !result.aborted && checks.length > 0 && checks.every((c) => c.ok);
  const handedOff = checks.some((c) => c.operation === 'escalate');
  const outcome: HandoffOutcome = allOk ? (handedOff ? 'handed_off' : 'recovered') : 'operator_review';
  const verified = outcome === 'recovered';
  const escalate = !verified;
  const stage: VerificationReport['stage'] = escalate ? 'escalated' : 'done';

  const incidents = await db.listIncidents().catch(() => [] as Incident[]);
  const persisted = buildOperatorHandoff({
    snapshot: s2,
    incidents,
    incidentIds: plan.plan.incident_ids,
    checks,
    outcomes: result.outcomes,
    aborted: result.aborted,
    jobIds: plan.commands.map((c) => c.job_id).filter((j): j is string => !!j),
    interval: [s1.clock.sim_time_ms, s2.clock.sim_time_ms],
    outcome,
    extra,
  });

  await events.emit('verify', {
    workflowId,
    incidentId: plan.plan.incident_ids[0],
    summary: `${escalate ? 'needs operator review' : 'verified'}: ${checks.filter((c) => c.ok).length}/${checks.length} checks passed over ${s2.clock.sim_time_ms - s1.clock.sim_time_ms} sim-ms${
      persisted.unresolved_infrastructure.length ? `; still open: ${persisted.unresolved_infrastructure[0]}` : ''
    }`,
    actor: 'code',
    toolCalls,
  });
  await deps.persist?.(stage, { verification: persisted });

  return {
    workflow_id: workflowId,
    plan_id: plan.plan.plan_id,
    checks,
    verified,
    escalate,
    outcome,
    stage,
    handoff: persisted.handoff,
    persisted,
    as_of_sim_time_ms: [s1.clock.sim_time_ms, s2.clock.sim_time_ms],
  };
}
