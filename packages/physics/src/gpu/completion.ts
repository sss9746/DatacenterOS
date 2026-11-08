// Phase-aware completion checks for delayed commands (R1, IMPLEMENTATION-SCOPE §4 "Required safety repairs").
//
// A checkpoint (30 s) or migrate_restart (120 s) completes on a later tick than it started, AFTER that tick's faults
// were applied (step.ts order). These checks revalidate the operation against the TRUE post-fault state of this tick:
// latched failures, active fault conditions (pump capacity, storage reachability, extra heat) and the integrated loop
// temperatures. They never read cached pre-fault headroom. Pure: no clock, randomness or I/O; the same code runs in
// the DB tick, runScenario and simulatePlan, so live and offline execution share one semantics.
//
// Request-time safety (safety.ts evaluateSafety) would reject a job that is already restarting as busy, so it is not
// reused unchanged here. The restart check is phase-aware: it recognizes the job's OWN allocations and in-flight
// reservation on the destination, and it ignores decision_epoch / resource versions entirely (an unrelated epoch
// change alone never aborts valid in-flight work). The thermal / power projection mirrors safety.ts (same look-ahead,
// margin, Euler step and load assumptions), computed from truth instead of inferred from observations.
//
// Reason codes are the existing CONTRACTS §0.7 / §0.12 #4 codes. When several conditions fail, the first in this order
// is reported: JOB_STATE_INVALID, DEST_GPU_BUSY, DEST_GPU_UNHEALTHY, CHECKPOINT_NOT_ACCESSIBLE / NO_COMPLETED_CHECKPOINT,
// DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT, DEST_POWER_HEADROOM_INSUFFICIENT, EVIDENCE_STALE.
import type { Checkpoint, GpuCurrent, JobSpec, JobState, PhysicsWorld } from '@dcos/contracts';
import { LOOP_SUPPLY_C, SLOWDOWN_C } from './constants.js';
import { JOB_FATAL_FAILURES } from './jobs.js';
import { EVIDENCE_MAX_AGE_MS, REQUIRED_THERMAL_HEADROOM_C, SAFETY_LOOKAHEAD_S } from './safety.js';
import {
  UNREACHABLE_FAILURES,
  faultConditions,
  gpuJobMap,
  gpuLoad,
  gpuPhysics,
  loopCapacityW,
  type FaultConditions,
  type HiddenState,
  type InFlightCommand,
  type Topology,
} from './world.js';

/** True state of this tick, after its faults: what every completion check reads. */
interface Truth {
  world: PhysicsWorld;
  h: HiddenState;
  topo: Topology;
  cond: FaultConditions;
  jobs: Map<string, JobState>;
  rows: Map<string, GpuCurrent>;
}

function truthOf(world: PhysicsWorld, h: HiddenState, topo: Topology): Truth {
  return {
    world, h, topo, cond: faultConditions(world.active_faults_private, topo),
    jobs: gpuJobMap(world.observable.job_states), rows: new Map(world.observable.gpus.map((g) => [g.resource_id, g])),
  };
}

const isUnreachable = (t: Truth, gpu: string): boolean => {
  const f = t.h.gpu_failure[gpu];
  return f !== undefined && UNREACHABLE_FAILURES.has(f);
};

/** True electrical power of a GPU right now, W (0 when unreachable). */
function powerNowW(t: Truth, g: GpuCurrent): number {
  if (isUnreachable(t, g.resource_id)) return 0;
  return gpuPhysics(g, gpuLoad(g.resource_id, t.jobs), t.h, t.topo, t.cond).power_w;
}

/** Any source GPU of the job carries a job-fatal latched failure (XID 79 / 48, thermal shutdown, node crash). */
export function sourceGpuDead(h: HiddenState, job: JobState): boolean {
  return job.allocated_gpu_ids.some((g) => {
    const f = h.gpu_failure[g];
    return f !== undefined && JOB_FATAL_FAILURES.has(f);
  });
}

// ---- checkpoint ----------------------------------------------------------------------------------

/**
 * Why a checkpoint due on this tick may not become durable, or null. A source fault due on the completion tick (a
 * job-fatal failure latched on a GPU the job holds) prevents new durability; so does storage that is unreachable now.
 * A destination-only fault is irrelevant here: a healthy source checkpoint stays valid.
 */
export function checkpointCompletionProblem(
  world: PhysicsWorld, h: HiddenState, topo: Topology, job: JobState, row: Checkpoint,
): string | null {
  if (job.status !== 'checkpointing') return 'JOB_STATE_INVALID';
  if (sourceGpuDead(h, job)) return 'JOB_FAILED_DURING_OPERATION';
  if (faultConditions(world.active_faults_private, topo).storageDown.has(row.storage_resource_id)) return 'CHECKPOINT_NOT_ACCESSIBLE';
  return null;
}

// ---- migrate_restart -----------------------------------------------------------------------------

/** Placement intact and exclusively the job's own: allocation rows, other jobs' placements and other reservations. */
function ownershipProblem(t: Truth, f: InFlightCommand, job: JobState, dest: string[]): string | null {
  const destSet = new Set(dest);
  const held = new Set(job.allocated_gpu_ids);
  if (held.size !== destSet.size || dest.some((g) => !held.has(g))) return 'JOB_STATE_INVALID'; // partial / foreign placement
  const own = t.world.observable.allocations.filter((a) => a.job_id === job.job_id).map((a) => a.gpu_id);
  if (own.length !== dest.length || dest.some((g) => !own.includes(g))) return 'JOB_STATE_INVALID';
  const foreignAllocation = t.world.observable.allocations.some((a) => a.job_id !== job.job_id && destSet.has(a.gpu_id));
  const foreignPlacement = t.world.observable.job_states.some((j) => j.job_id !== job.job_id && j.allocated_gpu_ids.some((g) => destSet.has(g)));
  const foreignReservation = t.h.in_flight.some((x) => x !== f && x.command.command_key !== f.command.command_key
    && (x.destination_gpu_ids ?? []).some((g) => destSet.has(g)));
  return foreignAllocation || foreignPlacement || foreignReservation ? 'DEST_GPU_BUSY' : null;
}

/** The checkpoint the restart reads (the job's latest) must still be complete on storage that is reachable now. */
function storageProblem(t: Truth, job: JobState): string | null {
  if (job.latest_checkpoint_id === null) return null; // nothing to read: the job restarts from scratch
  const ck = t.world.observable.checkpoints.find((c) => c.checkpoint_id === job.latest_checkpoint_id);
  if (!ck || ck.status !== 'complete') return 'NO_COMPLETED_CHECKPOINT';
  return t.cond.storageDown.has(ck.storage_resource_id) ? 'CHECKPOINT_NOT_ACCESSIBLE' : null;
}

/**
 * Loop coolant rise (°C) over SAFETY_LOOKAHEAD_S once the job runs at full load on the destination (safety.ts
 * projectLoop from truth): heat = destination GPUs at full load + every other reachable GPU at its true power now;
 * capacity = the loop's post-fault pump capacity; same Euler step as step(); the worst point of the linear window is
 * its end.
 */
function projectLoopRise(t: Truth, loop: string, destSet: Set<string>): number {
  const racks = t.topo.loopRacks.get(loop) ?? [];
  const rackSet = new Set(racks);
  const supply = t.topo.loopSupplyC.get(loop) ?? LOOP_SUPPLY_C;
  const now = t.h.loop_temp_c[loop] ?? supply;
  let heat = 0;
  for (const g of t.world.observable.gpus) {
    if (!rackSet.has(t.topo.gpuRack.get(g.resource_id) ?? '')) continue;
    heat += destSet.has(g.resource_id) ? gpuPhysics(g, 1, t.h, t.topo, t.cond).power_w : powerNowW(t, g);
  }
  const capacity = loopCapacityW(loop, t.topo, t.cond);
  const massKj = racks.reduce((s, r) => s + (t.topo.rackMassKjPerC.get(r) ?? 0), 0);
  const after = massKj > 0 ? Math.max(supply, now + (SAFETY_LOOKAHEAD_S * (heat - capacity)) / 1000 / massKj) : now;
  return Math.max(0, after - now);
}

/**
 * Projected destination-rack GPU temperatures with the job at full load (safety.ts checkThermal from truth): every
 * reachable GPU on a destination rack at its true temperature now (+ the extra heat of this tick's faults), the
 * destination GPUs at full load, all raised by the loop's projected rise. Headroom to the 85 °C slowdown must stay
 * ≥ REQUIRED_THERMAL_HEADROOM_C.
 */
function thermalProblem(t: Truth, dest: string[]): string | null {
  const destSet = new Set(dest);
  const racks = [...new Set(dest.map((g) => t.topo.gpuRack.get(g)).filter((r): r is string => !!r))];
  const rises = new Map<string, number>();
  for (const rack of racks) {
    const loop = t.topo.rackLoop.get(rack);
    if (loop && !rises.has(loop)) rises.set(loop, projectLoopRise(t, loop, destSet));
    const rise = loop ? rises.get(loop)! : 0;
    for (const g of t.world.observable.gpus) {
      if (t.topo.gpuRack.get(g.resource_id) !== rack || isUnreachable(t, g.resource_id)) continue;
      const load = destSet.has(g.resource_id) ? 1 : gpuLoad(g.resource_id, t.jobs);
      const temp = gpuPhysics(g, load, t.h, t.topo, t.cond).temp_c + rise;
      if (SLOWDOWN_C - temp < REQUIRED_THERMAL_HEADROOM_C) return 'DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT';
    }
  }
  return null;
}

/**
 * Extra draw of the destination GPUs at full load must fit each destination node's headroom now (Σ limit − power of
 * its reachable GPUs), and any rack / power-domain `power_budget_w` must cover the projected draw (safety.ts checkPower
 * from truth).
 */
function powerProblem(t: Truth, dest: string[]): string | null {
  const destSet = new Set(dest);
  const fullW = (g: GpuCurrent) => gpuPhysics(g, 1, t.h, t.topo, t.cond).power_w;
  const projectedW = (g: GpuCurrent) => (destSet.has(g.resource_id) ? fullW(g) : powerNowW(t, g));
  for (const node of new Set(dest.map((g) => t.topo.gpuNode.get(g) ?? ''))) {
    let required = 0;
    let available = 0;
    for (const id of t.topo.nodeGpus.get(node) ?? []) {
      const g = t.rows.get(id);
      if (!g || isUnreachable(t, id)) continue;
      const now = powerNowW(t, g);
      available += g.power_limit_w - now;
      if (destSet.has(id)) required += Math.max(0, fullW(g) - now);
    }
    if (required > available) return 'DEST_POWER_HEADROOM_INSUFFICIENT';
  }
  const racks = [...new Set(dest.map((g) => t.topo.gpuRack.get(g)).filter((r): r is string => !!r))];
  const domains = [...new Set(racks.map((r) => t.topo.resources.get(r)?.config.power_domain_id).filter((d): d is string => typeof d === 'string'))];
  for (const id of [...racks, ...domains]) {
    const budget = t.topo.resources.get(id)?.config.power_budget_w;
    if (typeof budget !== 'number') continue;
    const inScope = (g: GpuCurrent) => {
      const rack = t.topo.gpuRack.get(g.resource_id) ?? '';
      return rack === id || t.topo.resources.get(rack)?.config.power_domain_id === id;
    };
    const draw = t.world.observable.gpus.filter(inScope).reduce((s, g) => s + projectedW(g), 0);
    if (draw > budget) return 'DEST_POWER_HEADROOM_INSUFFICIENT';
  }
  return null;
}

/**
 * The destination GPUs' observed rows must be fresh: last seen within EVIDENCE_MAX_AGE_MS of the completion time. A
 * stale-sensor fault freezes last_seen_sim_ms, so a destination nobody has heard from for > 10 s is not run on.
 */
function freshnessProblem(t: Truth, nowMs: number, dest: string[]): string | null {
  for (const id of dest) {
    const g = t.rows.get(id);
    if (!g || isUnreachable(t, id)) continue; // unreachable is a health problem, reported by the health check
    if (nowMs - g.last_seen_sim_ms > EVIDENCE_MAX_AGE_MS) return 'EVIDENCE_STALE';
  }
  return null;
}

/**
 * Why a migrate_restart due on this tick may not mark the job running, or null (CONTRACTS §0.13 #6). Runs after this
 * tick's faults, against the actual destination the job holds. A cordon placed during the restart does not fail it:
 * cordon only prevents NEW placement and never evicts a job already holding the GPUs.
 */
export function restartCompletionProblem(
  world: PhysicsWorld, h: HiddenState, topo: Topology, nowMs: number, f: InFlightCommand, job: JobState, spec: JobSpec | undefined,
): string | null {
  if (job.status !== 'restarting' || !spec) return 'JOB_STATE_INVALID';
  const dest = f.destination_gpu_ids ?? job.allocated_gpu_ids;
  if (dest.length !== spec.gpus_required) return 'JOB_STATE_INVALID';
  const t = truthOf(world, h, topo);
  return ownershipProblem(t, f, job, dest)
    ?? (dest.some((g) => h.gpu_failure[g] !== undefined) ? 'DEST_GPU_UNHEALTHY' : null)
    ?? storageProblem(t, job)
    ?? thermalProblem(t, dest)
    ?? powerProblem(t, dest)
    ?? freshnessProblem(t, nowMs, dest);
}
