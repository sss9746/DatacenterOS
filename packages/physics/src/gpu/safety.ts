// evaluateSafety(obs, cmd, ctx) (P1-6, CONTRACTS §0.6 / §0.7, ARCHITECTURE §5): the hard safety check that runs
// before every request_action. Pure and deterministic. It reads ONLY the ObservedSnapshot (never the private world)
// plus the caller's ctx, and returns a SafetyDecision that carries every violated §0.7 code, not just the first.
//
// DECISION RULE (one rule, in this precedence):
//   1. deny               any violation other than the staleness / evidence codes below. Retrying will not fix it.
//   2. retry_new_snapshot only STALE_DECISION_EPOCH and/or STALE_RESOURCE_VERSION (± EVIDENCE_STALE): the check ran
//                         against state that is no longer current; re-read the snapshot, re-plan, re-evaluate.
//   3. needs_approval     EVIDENCE_STALE (ARCHITECTURE §5: stale evidence → human), or an approval reason with no
//                         violation: a DISRUPTIVE operation on a job with priority ≥ APPROVAL_PRIORITY_THRESHOLD
//                         (pause_job, or migrate_restart of a job that has not already failed). Approval reasons are
//                         not §0.7 codes, so they go in evidence.approval_reasons and violations stays empty.
//   4. allow              nothing above.
//   `escalate` has no physical effect and is always allowed (never blocked by staleness), so a human is never locked out.
//
// FRESHNESS: STALE_DECISION_EPOCH unless obs.clock.decision_epoch, ctx.decision_epoch (the caller's current
//   run.decision_epoch) and cmd.expected_decision_epoch are all equal. STALE_RESOURCE_VERSION for every
//   expected_resource_versions key whose versioned row (GPU / node / cooling / job state) has another version, or that
//   names no resource or job at all. Resources with no version in the snapshot (racks, loops, stores…) are skipped and
//   listed in evidence.unversioned_resource_ids.
//
// LEASES: ctx.leased_resource_ids = resources reserved by OTHER actions. A destination GPU or destination node in it
//   → DEST_GPU_LEASED. The job, its current GPUs / nodes, or the target in it → CONFLICTING_ACTION, except that a
//   command with depends_on_command_keys tolerates leases on its own job closure (assumed held by its predecessor,
//   e.g. the checkpoint it waits for; claim_action re-checks the full lock set). A job already checkpointing /
//   restarting is also a CONFLICTING_ACTION for checkpoint / pause_job / migrate_restart, unless the checkpoint it is
//   writing is one of this command's dependencies.
//
// CHECKPOINT RULE (migrate_restart): a voluntary move (job not `failed`) needs the latest checkpoint `complete`, OR a
//   dependency that is the plan's checkpoint step: a depends_on key that matches a non-failed checkpoint row of this
//   job, or that matches no checkpoint row yet (the checkpoint command was requested but not started; assumed to be
//   the checkpoint step when the job supports checkpoints). A failed job already fell back to durable work, so
//   restarting it loses nothing and needs no new checkpoint (but if it has a latest checkpoint, it must be complete and
//   readable, as actions.ts requires). The checkpoint the restart will read (the dependency's store, else the latest
//   checkpoint) must be accessible, else CHECKPOINT_NOT_ACCESSIBLE.
//   Store accessibility from observations only: the store resource exists and is enabled, and no non-failed
//   checkpoint row on it reports accessible=false (step() sets that flag from the storage's reachability).
//
// THERMAL HEADROOM (DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT), per destination rack, over SAFETY_LOOKAHEAD_S = 120 s:
//   - Rack inlet is not observed, so it is INFERRED from the rack's reachable GPUs by inverting step()'s model
//     (GPU temp = inlet + 35 °C × power/700 W): inlet ≈ max over GPUs of (temp_c − 35 × power_w / 700). The max keeps
//     the hottest GPU's seeded offset (conservative). No reachable GPU → loop estimate + rack inlet_offset_c.
//   - Loop coolant now ≈ max over its racks of (inferred inlet − inlet_offset_c), never below the supply setpoint.
//   - Heat into the loop AFTER the move = Σ projected GPU power: destination GPUs at full load
//     (min(700 W, power_limit_w)), the job's old GPUs idle (70 W; 0 W if unreachable), every other GPU at its
//     observed power_w. Capacity = Σ the loop's pumps' observed_capacity_estimate_w (0 if failed / maintenance;
//     nominal if the estimate is missing and the pump is normal, else 0).
//   - Same Euler step as step(): loop(+120 s) = max(supply, now + 120 × (heat − capacity) / (1000 × Σ rack mass kJ/°C)).
//     The model is linear, so the worst point of the window is max(now, +120 s): rise = max(0, loop(+120) − now).
//   - Projected rack GPU temps: destination GPUs = inlet + rise + 35 × min(700, limit)/700; the job's old GPUs on the
//     rack = inlet + rise + 35 × 0.1; every other reachable GPU = temp_c + rise.
//   - available_headroom_c = 85 °C slowdown − max projected rack GPU temp; violation if < REQUIRED_THERMAL_HEADROOM_C.
//
// POWER HEADROOM (DEST_POWER_HEADROOM_INSUFFICIENT): per destination node, the extra draw of its destination GPUs
//   (Σ max(0, min(700, limit) − power_w)) must fit nodes[].power_headroom_w. Optional budgets: a rack or power_domain
//   resource whose config has a numeric `power_budget_w` must fit the projected draw of its GPUs (the preset sets none).
//
// Copied logic (no edits elsewhere): the destination pick for destination_node_ids mirrors actions.ts
// destinationGpus() (first free ready GPUs on those nodes, in snapshot order; free = not allocated to another job);
// the thermal step mirrors step.ts. buildTopology (world.ts) is imported: it only indexes observable resources.
import type { ActionCommand, CoolingCurrent, GpuCurrent, JobSpec, JobState, ObservedSnapshot, SafetyDecision } from '@dcos/contracts';
import { GPU_TEMP_RISE_C_PER_LOAD, IDLE_LOAD, LOOP_SUPPLY_C, POWER_LIMIT_W, SLOWDOWN_C, WIRE_SCHEMA_VERSION, round1 } from './constants.js';
import { buildTopology, type Topology } from './world.js';

// ---- safety constants (all SIMULATED, configurable) -----------------------------------------------

/** CONTRACTS §0.7 reason codes, in their frozen order (violations are always reported in this order). */
export const SAFETY_REASON_CODES = [
  'DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT',
  'DEST_POWER_HEADROOM_INSUFFICIENT',
  'DEST_GPU_UNHEALTHY',
  'DEST_GPU_BUSY',
  'DEST_GPU_LEASED',
  'DEST_GPU_COUNT_INSUFFICIENT',
  'DEST_NOT_COMPATIBLE',
  'CHECKPOINT_NOT_ACCESSIBLE',
  'NO_COMPLETED_CHECKPOINT',
  'JOB_NOT_PREEMPTIBLE',
  'CHECKPOINT_UNSUPPORTED',
  'STALE_DECISION_EPOCH',
  'STALE_RESOURCE_VERSION',
  'CONFLICTING_ACTION',
  'EVIDENCE_STALE',
  'UNSUPPORTED_OPERATION',
  'CORDON_IS_NOT_REPAIR',
  'REAL_GPU_NOT_ALLOCATABLE',
] as const;
export type SafetyReasonCode = (typeof SAFETY_REASON_CODES)[number];

/** Simulated thermal look-ahead window, s. */
export const SAFETY_LOOKAHEAD_S = 120;
/** Simulated required margin between the projected destination rack GPU temperature and the 85 °C slowdown, °C. */
export const REQUIRED_THERMAL_HEADROOM_C = 5;
/** Simulated max age of a reachable GPU's telemetry the decision relies on, ms (older → EVIDENCE_STALE). */
export const EVIDENCE_MAX_AGE_MS = 10_000;
/** Simulated: disruptive operations on jobs with priority ≥ this need human approval. */
export const APPROVAL_PRIORITY_THRESHOLD = 80;

const RETRY_CODES: ReadonlySet<SafetyReasonCode> = new Set(['STALE_DECISION_EPOCH', 'STALE_RESOURCE_VERSION']);
const APPROVAL_CODES: ReadonlySet<SafetyReasonCode> = new Set(['EVIDENCE_STALE']);
const KNOWN_OPERATIONS: ReadonlySet<string> = new Set([
  'keep_running', 'power_cap', 'checkpoint', 'pause_job', 'cordon_gpu', 'migrate_restart', 'uncordon_gpu', 'escalate',
]);
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export interface SafetyContext {
  /** The caller's current run.decision_epoch. */
  decision_epoch: number;
  /** Resources reserved by other actions (resource_lease rows not owned by this command). */
  leased_resource_ids: string[];
}

// ---- evaluation state -----------------------------------------------------------------------------

interface Eval {
  obs: ObservedSnapshot;
  cmd: ActionCommand;
  topo: Topology;
  gpu: Map<string, GpuCurrent>;
  owner: Map<string, string>;
  leased: Set<string>;
  violations: Set<SafetyReasonCode>;
  checked: Set<string>;
  evidence: Record<string, unknown>;
  approval: string[];
}

const add = (e: Eval, code: SafetyReasonCode) => e.violations.add(code);
const see = (e: Eval, ...ids: (string | null | undefined)[]) => {
  for (const id of ids) if (typeof id === 'string' && id.length > 0) e.checked.add(id);
};

const stringList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/** Full-load power a GPU would draw for a job, W (power cap respected). */
const fullPowerW = (g: GpuCurrent) => Math.min(POWER_LIMIT_W, g.power_limit_w);
const idlePowerW = (g: GpuCurrent) => (g.availability === 'unreachable' ? 0 : Math.min(POWER_LIMIT_W * IDLE_LOAD, g.power_limit_w));

function rackGpus(e: Eval, rack: string): GpuCurrent[] {
  return e.obs.gpus.filter((g) => e.topo.gpuRack.get(g.resource_id) === rack);
}

/** Inferred rack inlet, °C: max over reachable GPUs of temp − 35 × power/700 (inverse of step()'s GPU model). */
function inferInletC(e: Eval, rack: string): number | null {
  const live = rackGpus(e, rack).filter((g) => g.availability !== 'unreachable');
  if (live.length === 0) return null;
  return Math.max(...live.map((g) => g.temp_c - (GPU_TEMP_RISE_C_PER_LOAD * g.power_w) / POWER_LIMIT_W));
}

function pumpCapacityW(c: CoolingCurrent | undefined): number {
  if (!c || c.operating_state === 'failed' || c.operating_state === 'maintenance') return 0;
  if (typeof c.observed_capacity_estimate_w === 'number') return c.observed_capacity_estimate_w;
  return c.operating_state === 'normal' ? c.nominal_capacity_w : 0;
}

function storeAccessible(e: Eval, storeId: string): boolean {
  const res = e.topo.resources.get(storeId);
  if (!res || res.kind !== 'checkpoint_store' || !res.enabled) return false;
  return !e.obs.checkpoints.some((c) => c.storage_resource_id === storeId && c.status !== 'failed' && !c.accessible);
}

function versionOf(e: Eval, id: string): number | null {
  const row =
    e.gpu.get(id) ?? e.obs.nodes.find((n) => n.resource_id === id) ?? e.obs.cooling.find((c) => c.resource_id === id)
    ?? e.obs.job_states.find((j) => j.job_id === id);
  return row ? row.version : null;
}

// ---- common checks --------------------------------------------------------------------------------

function checkFreshness(e: Eval, ctx: SafetyContext): void {
  const snap = e.obs.clock.decision_epoch;
  e.evidence.decision_epoch = { snapshot: snap, current: ctx.decision_epoch, expected: e.cmd.expected_decision_epoch };
  if (snap !== ctx.decision_epoch || e.cmd.expected_decision_epoch !== ctx.decision_epoch) add(e, 'STALE_DECISION_EPOCH');

  const stale: { resource_id: string; expected: number; observed: number | null }[] = [];
  const unversioned: string[] = [];
  for (const id of Object.keys(e.cmd.expected_resource_versions).sort()) {
    const expected = e.cmd.expected_resource_versions[id]!;
    see(e, id);
    const observed = versionOf(e, id);
    if (observed === null) {
      if (e.topo.resources.has(id)) unversioned.push(id);
      else stale.push({ resource_id: id, expected, observed: null });
    } else if (observed !== expected) {
      stale.push({ resource_id: id, expected, observed });
    }
  }
  if (stale.length > 0) {
    add(e, 'STALE_RESOURCE_VERSION');
    e.evidence.stale_resource_versions = stale;
  }
  if (unversioned.length > 0) e.evidence.unversioned_resource_ids = unversioned;
}

/** Leases on the target / job closure held by other actions → CONFLICTING_ACTION. */
function checkLeases(e: Eval, job: JobState | null): void {
  const closure = new Set<string>();
  if (job) {
    closure.add(job.job_id);
    for (const g of job.allocated_gpu_ids) {
      closure.add(g);
      const n = e.topo.gpuNode.get(g);
      if (n) closure.add(n);
    }
  }
  const tolerate = e.cmd.depends_on_command_keys.length > 0;
  const hits = uniq([e.cmd.target_resource_id, ...closure])
    .filter((id) => e.leased.has(id) && !(tolerate && closure.has(id)));
  if (hits.length > 0) {
    add(e, 'CONFLICTING_ACTION');
    e.evidence.conflicting_leases = hits;
  }
}

/** Job already checkpointing / restarting → CONFLICTING_ACTION (unless it is writing a checkpoint we depend on). */
function checkJobBusy(e: Eval, job: JobState): boolean {
  if (job.status !== 'checkpointing' && job.status !== 'restarting') return false;
  const deps = new Set(e.cmd.depends_on_command_keys);
  const ownCheckpoint = job.status === 'checkpointing' && e.obs.checkpoints.some(
    (c) => c.job_id === job.job_id && (c.status === 'writing' || c.status === 'requested') && deps.has(c.command_key),
  );
  if (!ownCheckpoint) {
    add(e, 'CONFLICTING_ACTION');
    e.evidence.job_in_flight_status = job.status;
  }
  return true;
}

function resolveJob(e: Eval): { job: JobState; spec: JobSpec } | null {
  const id = e.cmd.job_id ?? e.cmd.target_resource_id;
  see(e, id);
  const job = e.obs.job_states.find((j) => j.job_id === id);
  const spec = e.obs.job_specs.find((s) => s.job_id === id);
  if (!job || !spec) {
    add(e, 'UNSUPPORTED_OPERATION');
    e.evidence.unknown_job_id = id;
    return null;
  }
  see(e, ...job.allocated_gpu_ids);
  return { job, spec };
}

/** Is the target a GPU resource that is not an allocatable simulated GPU (e.g. gpu-real-0)? */
function isRealGpu(e: Eval, id: string): boolean {
  const res = e.topo.resources.get(id);
  return res?.kind === 'gpu' && (!e.gpu.has(id) || res.config.allocatable === false);
}

function staleIds(e: Eval, gpus: GpuCurrent[]): string[] {
  const now = e.obs.clock.sim_time_ms;
  return gpus.filter((g) => g.availability !== 'unreachable' && now - g.last_seen_sim_ms > EVIDENCE_MAX_AGE_MS).map((g) => g.resource_id);
}

function noteStaleEvidence(e: Eval, gpus: GpuCurrent[]): void {
  const ids = uniq(staleIds(e, gpus));
  if (ids.length === 0) return;
  add(e, 'EVIDENCE_STALE');
  e.evidence.stale_evidence_ids = ids;
  e.evidence.evidence_max_age_ms = EVIDENCE_MAX_AGE_MS;
}

// ---- per-operation checks -------------------------------------------------------------------------

function checkCheckpoint(e: Eval): void {
  const r = resolveJob(e);
  if (!r) return;
  const { job, spec } = r;
  checkLeases(e, job);
  if (!spec.checkpoint_supported || !spec.checkpoint_storage_id) add(e, 'CHECKPOINT_UNSUPPORTED');
  if (!checkJobBusy(e, job) && job.status !== 'running' && job.status !== 'paused') {
    add(e, 'UNSUPPORTED_OPERATION');
    e.evidence.job_status = job.status;
  }
  if (spec.checkpoint_storage_id) {
    see(e, spec.checkpoint_storage_id);
    if (!storeAccessible(e, spec.checkpoint_storage_id)) add(e, 'CHECKPOINT_NOT_ACCESSIBLE');
  }
}

function checkPause(e: Eval): void {
  const r = resolveJob(e);
  if (!r) return;
  const { job, spec } = r;
  checkLeases(e, job);
  if (!spec.preemptible) add(e, 'JOB_NOT_PREEMPTIBLE');
  if (!checkJobBusy(e, job) && job.status !== 'running') {
    add(e, 'UNSUPPORTED_OPERATION');
    e.evidence.job_status = job.status;
  }
  if (spec.priority >= APPROVAL_PRIORITY_THRESHOLD) e.approval.push('HIGH_PRIORITY_JOB_DISRUPTION');
}

/** GPUs a power_cap acts on (same rule as actions.ts targetGpus). null = handled (violation added). */
function powerCapTargets(e: Eval): string[] | null {
  if (e.cmd.job_id) {
    const r = resolveJob(e);
    return r ? r.job.allocated_gpu_ids : null;
  }
  const t = e.cmd.target_resource_id;
  see(e, t);
  if (e.gpu.has(t)) return [t];
  const nodeGpus = e.topo.nodeGpus.get(t);
  if (nodeGpus) return nodeGpus;
  if (isRealGpu(e, t)) {
    add(e, 'REAL_GPU_NOT_ALLOCATABLE');
    return null;
  }
  const job = e.obs.job_states.find((j) => j.job_id === t);
  if (job) return job.allocated_gpu_ids;
  add(e, 'UNSUPPORTED_OPERATION');
  return null;
}

function checkPowerCap(e: Eval): void {
  const limit = e.cmd.arguments.power_limit_w;
  if (limit !== undefined && !(typeof limit === 'number' && limit > 0 && limit <= POWER_LIMIT_W)) {
    add(e, 'UNSUPPORTED_OPERATION');
    e.evidence.invalid_power_limit_w = typeof limit === 'number' ? limit : String(limit);
  }
  const gpus = powerCapTargets(e);
  if (gpus) {
    see(e, ...gpus);
    if (gpus.length === 0) add(e, 'UNSUPPORTED_OPERATION');
    const job = e.cmd.job_id ? e.obs.job_states.find((j) => j.job_id === e.cmd.job_id) ?? null : null;
    checkLeases(e, job);
  }
}

function checkCordon(e: Eval, uncordon: boolean): void {
  const t = e.cmd.target_resource_id;
  see(e, t);
  checkLeases(e, null);
  const g = e.gpu.get(t);
  if (!g) {
    add(e, isRealGpu(e, t) ? 'REAL_GPU_NOT_ALLOCATABLE' : 'UNSUPPORTED_OPERATION');
    return;
  }
  see(e, g.node_id);
  if (!uncordon) return; // cordon only stops new placements: always safe, never a repair
  // returning a GPU to service: a latched failure stays failed; cordon / uncordon never repairs it
  if (g.availability === 'unreachable' || g.availability === 'degraded' || g.last_xid_code !== null) {
    add(e, 'CORDON_IS_NOT_REPAIR');
    e.evidence.gpu_condition = { availability: g.availability, last_xid_code: g.last_xid_code };
  }
  noteStaleEvidence(e, [g]);
}

function checkKeepRunning(e: Eval): void {
  if (e.cmd.job_id) {
    const r = resolveJob(e);
    if (r) checkLeases(e, r.job);
  } else {
    see(e, e.cmd.target_resource_id);
  }
}

// ---- migrate_restart ------------------------------------------------------------------------------

/** Destination GPUs: explicit set, or first free ready GPUs on the nodes (actions.ts rule), padded for diagnosis. */
function resolveDestinations(e: Eval, job: JobState, need: number): string[] {
  const explicit = stringList(e.cmd.arguments.destination_gpu_ids);
  if (explicit) {
    e.evidence.destination_mode = 'destination_gpu_ids';
    if (explicit.length !== need || new Set(explicit).size !== explicit.length) add(e, 'DEST_GPU_COUNT_INSUFFICIENT');
    return uniq(explicit);
  }
  const nodes = stringList(e.cmd.arguments.destination_node_ids);
  if (!nodes || nodes.length === 0) {
    add(e, 'DEST_GPU_COUNT_INSUFFICIENT');
    e.evidence.destination_mode = 'none';
    return [];
  }
  e.evidence.destination_mode = 'destination_node_ids';
  for (const n of uniq(nodes)) {
    see(e, n);
    if (!e.topo.nodeGpus.has(n)) add(e, 'DEST_NOT_COMPATIBLE');
  }
  const onNodes = uniq(nodes.flatMap((n) => e.topo.nodeGpus.get(n) ?? []));
  const isFree = (g: string) => {
    const o = e.owner.get(g);
    return (o === undefined || o === job.job_id) && e.gpu.get(g)?.availability === 'ready';
  };
  const free = onNodes.filter(isFree);
  if (free.length >= need) return free.slice(0, need);
  add(e, 'DEST_GPU_COUNT_INSUFFICIENT');
  e.evidence.free_gpus_on_destination_nodes = free.length;
  // pad with the non-free GPUs so the per-GPU / thermal checks report why the nodes do not fit
  return [...free, ...onNodes.filter((g) => !isFree(g))].slice(0, need);
}

interface LoopProjection {
  loop_id: string;
  coolant_now_c: number;
  coolant_after_lookahead_c: number;
  rise_c: number;
  heat_after_move_w: number;
  capacity_w: number;
}

function projectedPowerW(g: GpuCurrent, dest: Set<string>, oldGpus: Set<string>): number {
  if (dest.has(g.resource_id)) return fullPowerW(g);
  if (oldGpus.has(g.resource_id)) return idlePowerW(g);
  return g.power_w;
}

function projectLoop(e: Eval, loop: string, dest: Set<string>, oldGpus: Set<string>): LoopProjection {
  const t = e.topo;
  const racks = t.loopRacks.get(loop) ?? [];
  const supply = t.loopSupplyC.get(loop) ?? LOOP_SUPPLY_C;
  let now = supply;
  for (const r of racks) {
    const inlet = inferInletC(e, r);
    if (inlet !== null) now = Math.max(now, inlet - (t.rackOffsetC.get(r) ?? 0));
  }
  const rackSet = new Set(racks);
  const heat = e.obs.gpus
    .filter((g) => rackSet.has(t.gpuRack.get(g.resource_id) ?? ''))
    .reduce((s, g) => s + projectedPowerW(g, dest, oldGpus), 0);
  const pumps = t.loopPumps.get(loop) ?? [];
  const capacity = pumps.reduce((s, p) => s + pumpCapacityW(e.obs.cooling.find((c) => c.resource_id === p)), 0);
  const massKj = racks.reduce((s, r) => s + (t.rackMassKjPerC.get(r) ?? 0), 0);
  const after = massKj > 0 ? Math.max(supply, now + (SAFETY_LOOKAHEAD_S * (heat - capacity)) / 1000 / massKj) : now;
  see(e, loop, ...pumps);
  return {
    loop_id: loop, coolant_now_c: round1(now), coolant_after_lookahead_c: round1(after),
    rise_c: Math.max(0, after - now), heat_after_move_w: Math.round(heat), capacity_w: Math.round(capacity),
  };
}

function checkThermal(e: Eval, dest: GpuCurrent[], oldGpus: Set<string>): void {
  const destSet = new Set(dest.map((g) => g.resource_id));
  const racks = uniq(dest.map((g) => e.topo.gpuRack.get(g.resource_id)).filter((r): r is string => !!r));
  const loops = new Map<string, LoopProjection>();
  const perRack: Record<string, unknown>[] = [];
  let worst = Infinity;
  for (const rack of racks) {
    see(e, rack);
    const loop = e.topo.rackLoop.get(rack);
    const proj = loop ? (loops.get(loop) ?? projectLoop(e, loop, destSet, oldGpus)) : null;
    if (loop && proj) loops.set(loop, proj);
    const rise = proj?.rise_c ?? 0;
    const inferred = inferInletC(e, rack);
    const inletNow = inferred ?? (proj?.coolant_now_c ?? LOOP_SUPPLY_C) + (e.topo.rackOffsetC.get(rack) ?? 0);
    const inletProj = inletNow + rise;
    const temps = rackGpus(e, rack)
      .filter((g) => g.availability !== 'unreachable' || destSet.has(g.resource_id))
      .map((g) => {
        if (destSet.has(g.resource_id)) return inletProj + (GPU_TEMP_RISE_C_PER_LOAD * fullPowerW(g)) / POWER_LIMIT_W;
        if (oldGpus.has(g.resource_id)) return inletProj + GPU_TEMP_RISE_C_PER_LOAD * IDLE_LOAD;
        return g.temp_c + rise;
      });
    const maxTemp = temps.length > 0 ? Math.max(...temps) : inletProj;
    const headroom = SLOWDOWN_C - maxTemp;
    worst = Math.min(worst, headroom);
    if (headroom < REQUIRED_THERMAL_HEADROOM_C) add(e, 'DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT');
    perRack.push({
      rack_id: rack, loop_id: loop ?? null, inlet_inferred: inferred !== null, inlet_now_c: round1(inletNow),
      inlet_projected_c: round1(inletProj), projected_max_gpu_temp_c: round1(maxTemp),
      available_headroom_c: round1(headroom), required_headroom_c: REQUIRED_THERMAL_HEADROOM_C,
    });
  }
  if (racks.length === 0) return;
  e.evidence.required_headroom_c = REQUIRED_THERMAL_HEADROOM_C;
  e.evidence.available_headroom_c = round1(worst);
  e.evidence.slowdown_c = SLOWDOWN_C;
  e.evidence.lookahead_s = SAFETY_LOOKAHEAD_S;
  e.evidence.thermal = perRack;
  e.evidence.cooling_loops = [...loops.values()].map((p) => ({ ...p, rise_c: round1(p.rise_c) }));
}

function checkPower(e: Eval, dest: GpuCurrent[], oldGpus: Set<string>): void {
  const destSet = new Set(dest.map((g) => g.resource_id));
  const out: Record<string, unknown>[] = [];
  let short = false;
  for (const node of uniq(dest.map((g) => g.node_id))) {
    const row = e.obs.nodes.find((n) => n.resource_id === node);
    const required = dest.filter((g) => g.node_id === node).reduce((s, g) => s + Math.max(0, fullPowerW(g) - g.power_w), 0);
    const available = row ? row.power_headroom_w : 0;
    if (required > available) short = true;
    out.push({ resource_id: node, required_w: Math.round(required), available_w: Math.round(available) });
  }
  // optional budgets on racks / power domains (config.power_budget_w)
  const racks = uniq(dest.map((g) => e.topo.gpuRack.get(g.resource_id)).filter((r): r is string => !!r));
  const domains = uniq(racks.map((r) => e.topo.resources.get(r)?.config.power_domain_id).filter((d): d is string => typeof d === 'string'));
  for (const id of [...racks, ...domains]) {
    const budget = e.topo.resources.get(id)?.config.power_budget_w;
    if (typeof budget !== 'number') continue;
    see(e, id);
    const inScope = (g: GpuCurrent) => {
      const rack = e.topo.gpuRack.get(g.resource_id) ?? '';
      return rack === id || e.topo.resources.get(rack)?.config.power_domain_id === id;
    };
    const draw = e.obs.gpus.filter(inScope).reduce((s, g) => s + projectedPowerW(g, destSet, oldGpus), 0);
    if (draw > budget) short = true;
    out.push({ resource_id: id, projected_draw_w: Math.round(draw), budget_w: budget });
  }
  if (short) add(e, 'DEST_POWER_HEADROOM_INSUFFICIENT');
  e.evidence.power = out;
}

function checkMigrateCheckpoint(e: Eval, job: JobState, spec: JobSpec, voluntary: boolean): void {
  const latest = job.latest_checkpoint_id ? e.obs.checkpoints.find((c) => c.checkpoint_id === job.latest_checkpoint_id) : undefined;
  see(e, job.latest_checkpoint_id);
  let depKey: string | null = null;
  for (const k of e.cmd.depends_on_command_keys) {
    const row = e.obs.checkpoints.find((c) => c.command_key === k);
    if (row ? row.job_id === job.job_id && row.status !== 'failed' : spec.checkpoint_supported && !!spec.checkpoint_storage_id) {
      depKey = k;
      break;
    }
  }
  const complete = latest?.status === 'complete';
  if (voluntary && !spec.checkpoint_supported) add(e, 'CHECKPOINT_UNSUPPORTED');
  if (!depKey && ((voluntary && !complete) || (job.latest_checkpoint_id !== null && !complete))) add(e, 'NO_COMPLETED_CHECKPOINT');
  const readStore = depKey ? spec.checkpoint_storage_id : complete ? latest!.storage_resource_id : null;
  see(e, readStore);
  if (readStore && (!storeAccessible(e, readStore) || (!depKey && latest && !latest.accessible))) add(e, 'CHECKPOINT_NOT_ACCESSIBLE');
  e.evidence.checkpoint = {
    latest_checkpoint_id: job.latest_checkpoint_id, latest_status: latest?.status ?? null,
    latest_accessible: latest?.accessible ?? null, satisfied_by_dependency: depKey, storage_resource_id: readStore,
  };
}

function checkMigrate(e: Eval): void {
  const r = resolveJob(e);
  if (!r) return;
  const { job, spec } = r;
  checkLeases(e, job);
  const voluntary = job.status !== 'failed';
  checkJobBusy(e, job);
  if (job.status === 'completed') {
    add(e, 'UNSUPPORTED_OPERATION');
    e.evidence.job_status = job.status;
  }
  if (voluntary && !spec.preemptible) add(e, 'JOB_NOT_PREEMPTIBLE');
  checkMigrateCheckpoint(e, job, spec, voluntary);

  const destIds = resolveDestinations(e, job, spec.gpus_required);
  const dest: GpuCurrent[] = [];
  const leasedDest: string[] = [];
  for (const id of destIds) {
    see(e, id);
    if (isRealGpu(e, id)) {
      add(e, 'REAL_GPU_NOT_ALLOCATABLE');
      continue;
    }
    const res = e.topo.resources.get(id);
    const g = e.gpu.get(id);
    if (!res || res.kind !== 'gpu' || !g) {
      add(e, 'DEST_NOT_COMPATIBLE');
      continue;
    }
    dest.push(g);
    const node = e.obs.nodes.find((n) => n.resource_id === g.node_id);
    see(e, g.node_id);
    if (!spec.compatible_node_ids.includes(g.node_id) || res.profile !== spec.gpu_profile || !res.enabled) add(e, 'DEST_NOT_COMPATIBLE');
    if (g.availability !== 'ready' || (node && node.availability !== 'ready')) add(e, 'DEST_GPU_UNHEALTHY');
    const o = e.owner.get(id);
    if (o !== undefined && o !== job.job_id) add(e, 'DEST_GPU_BUSY');
    if (e.leased.has(id)) leasedDest.push(id);
    if (e.leased.has(g.node_id)) leasedDest.push(g.node_id);
  }
  if (leasedDest.length > 0) {
    add(e, 'DEST_GPU_LEASED');
    e.evidence.leased_destinations = uniq(leasedDest);
  }
  if (spec.placement_policy === 'same_node' && new Set(dest.map((g) => g.node_id)).size > 1) add(e, 'DEST_NOT_COMPATIBLE');
  e.evidence.destination_gpu_ids = destIds.filter((id) => IDENTIFIER_RE.test(id));

  const oldGpus = new Set(job.allocated_gpu_ids.filter((g) => !dest.some((d) => d.resource_id === g)));
  checkThermal(e, dest, oldGpus);
  checkPower(e, dest, oldGpus);
  const destRacks = new Set(dest.map((g) => e.topo.gpuRack.get(g.resource_id)));
  noteStaleEvidence(e, e.obs.gpus.filter((g) => destRacks.has(e.topo.gpuRack.get(g.resource_id))));
  if (voluntary && spec.priority >= APPROVAL_PRIORITY_THRESHOLD) e.approval.push('HIGH_PRIORITY_JOB_DISRUPTION');
}

// ---- entry point ----------------------------------------------------------------------------------

export function evaluateSafety(obs: ObservedSnapshot, cmd: ActionCommand, ctx: SafetyContext): SafetyDecision {
  const topo = buildTopology(obs.resources, obs.gpus);
  const owner = new Map<string, string>();
  for (const j of obs.job_states) for (const g of j.allocated_gpu_ids) owner.set(g, j.job_id);
  for (const a of obs.allocations) owner.set(a.gpu_id, a.job_id);
  const e: Eval = {
    obs, cmd, topo, gpu: new Map(obs.gpus.map((g) => [g.resource_id, g])), owner,
    leased: new Set(ctx.leased_resource_ids), violations: new Set(), checked: new Set(), evidence: {}, approval: [],
  };
  const op = cmd.operation as string;
  e.evidence.operation = op;

  if (op !== 'escalate') checkFreshness(e, ctx);
  switch (op) {
    case 'migrate_restart': checkMigrate(e); break;
    case 'checkpoint': checkCheckpoint(e); break;
    case 'pause_job': checkPause(e); break;
    case 'power_cap': checkPowerCap(e); break;
    case 'cordon_gpu': checkCordon(e, false); break;
    case 'uncordon_gpu': checkCordon(e, true); break;
    case 'keep_running': checkKeepRunning(e); break;
    case 'escalate': see(e, cmd.target_resource_id); break;
    default:
      see(e, cmd.target_resource_id);
      add(e, 'UNSUPPORTED_OPERATION');
      if (!KNOWN_OPERATIONS.has(op)) e.evidence.unknown_operation = true;
  }

  const violations = SAFETY_REASON_CODES.filter((c) => e.violations.has(c));
  const hard = violations.some((c) => !RETRY_CODES.has(c) && !APPROVAL_CODES.has(c));
  const decision: SafetyDecision['decision'] = hard
    ? 'deny'
    : violations.some((c) => RETRY_CODES.has(c))
      ? 'retry_new_snapshot'
      : violations.length > 0 || e.approval.length > 0
        ? 'needs_approval'
        : 'allow';
  if (e.approval.length > 0) e.evidence.approval_reasons = uniq(e.approval);

  return {
    schema_version: WIRE_SCHEMA_VERSION,
    run_id: obs.run_id,
    plan_id: cmd.plan_id,
    action_id: cmd.action_id,
    decision,
    checked_decision_epoch: obs.clock.decision_epoch,
    violations: [...violations],
    checked_resource_ids: [...e.checked].filter((id) => IDENTIFIER_RE.test(id) && id.length <= 128),
    evidence: e.evidence,
  };
}
