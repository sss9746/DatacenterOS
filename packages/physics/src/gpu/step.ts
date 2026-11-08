// step(input): one deterministic GPU-cluster tick, t0 → t1 = t0 + step_ms. The same code runs in the DB tick,
// the evaluation harness and simulatePlan. Pure: the input is never mutated; no clock, randomness or I/O.
//
// Order within a tick (ARCHITECTURE §3; documented and stable):
//   1. Integrate [t0, t1] with the state at t0 (explicit Euler): loop coolant temperature from the per-loop
//      cooling balance, dT/dt = (heat − capacity) / thermal mass (the v0 rack formula without its passive term,
//      clamped at the loop supply setpoint); job progress = Σ GPU work rate × clock factor for running jobs.
//   2. Faults: expire ended ones, then apply the faults due by t1 FIRST (XID → GPU unavailable → non-elastic job
//      fails back to durable_work_units).
//   3. Commands (actions.ts): in-flight commands due by t1 complete (revalidated after the faults), then newly
//      requested commands start. A command never completes on the tick it starts.
//   4. Derive the observed rows at t1: GPU temp = rack inlet + 35 °C × load; ≥ 85 °C throttles (SM clock −30%,
//      clocks_event_reasons HW thermal bit 0x40); ≥ 92 °C latches a thermal shutdown (GPU unavailable, job fails).
//   5. Versions and material_change from observable, safety-relevant fields only; material_change bumps
//      decision_epoch by one.
//   6. Telemetry (≤ 1 sample per (resource, metric)) and signals, then the clock advances.
import type { JobState, PhysicsTickResult, SimulationTickInput } from '@dcos/contracts';
import { MAX_OBSERVATION_EVENT_IDS, WIRE_SCHEMA_VERSION as V } from './constants.js';
import { processCommands } from './actions.js';
import { applyDueFaults, expireFaults, latchFailure } from './faults.js';
import { failJobsOnDeadGpus, releaseJob, type TickCtx } from './jobs.js';
import { buildSignals, emitTelemetry } from './telemetry.js';
import {
  UNREACHABLE_FAILURES,
  buildTopology,
  cloneJson,
  coolingMaterialKey,
  deriveCooling,
  deriveGpus,
  deriveNodes,
  faultConditions,
  gpuJobMap,
  gpuMaterialKey,
  gpuPhysics,
  gpuLoad,
  hiddenOf,
  isShutdownTemp,
  jobMaterialKey,
  loopCapacityW,
  loopHeatW,
  nodeMaterialKey,
  specOf,
  type GpuPhysics,
} from './world.js';

/** Bump `version` on rows whose material key changed since the tick started. Returns whether any did. */
function bumpVersions<T extends { version: number }>(
  before: readonly T[], after: T[], id: (x: T) => string, key: (x: T) => string,
): boolean {
  const prev = new Map(before.map((x) => [id(x), x]));
  let changed = false;
  for (const x of after) {
    const p = prev.get(id(x));
    if (!p) {
      changed = true;
      continue;
    }
    if (key(p) !== key(x)) {
      x.version = p.version + 1;
      changed = true;
    }
  }
  return changed || before.length !== after.length;
}

const checkpointKey = (c: { checkpoint_id: string; status: string; accessible: boolean }) =>
  `${c.checkpoint_id}|${c.status}|${c.accessible}`;

export function step(input: SimulationTickInput): PhysicsTickResult {
  const before = input.world.observable;
  const world = cloneJson(input.world);
  const obs = world.observable;
  const h = hiddenOf(world);
  const result = (material: boolean, ctx: TickCtx | null, telemetry: PhysicsTickResult['telemetry'], signals: PhysicsTickResult['signals']): PhysicsTickResult => ({
    schema_version: V, run_id: world.run_id, world_after: world, telemetry, signals, material_change: material,
    completed_command_keys: ctx?.completed ?? [], failed_command_keys: ctx?.failed ?? [],
  });
  if (obs.clock.paused) return result(false, null, [], []);

  const dtMs = input.step_ms;
  const dtS = dtMs / 1000;
  const ctx: TickCtx = {
    t0: obs.clock.sim_time_ms, t1: obs.clock.sim_time_ms + dtMs, tick: obs.clock.tick_index + 1,
    completed: [], failed: [], signals: [],
  };
  const topo = buildTopology(obs.resources, obs.gpus);
  const gpuIds = obs.gpus.map((g) => g.resource_id);

  // 1. integrate [t0, t1] with the state at t0
  const cond0 = faultConditions(world.active_faults_private, topo);
  const jobs0 = gpuJobMap(obs.job_states);
  const phys0 = new Map<string, GpuPhysics>();
  for (const g of obs.gpus) {
    const f = h.gpu_failure[g.resource_id];
    if (f && UNREACHABLE_FAILURES.has(f)) continue;
    phys0.set(g.resource_id, gpuPhysics(g, gpuLoad(g.resource_id, jobs0), h, topo, cond0));
  }
  for (const loop of topo.loops) {
    const supply = topo.loopSupplyC.get(loop)!;
    const massKj = (topo.loopRacks.get(loop) ?? []).reduce((s, r) => s + (topo.rackMassKjPerC.get(r) ?? 0), 0);
    if (massKj <= 0) continue;
    const heat = loopHeatW(loop, gpuIds, phys0, topo);
    const cap = loopCapacityW(loop, topo, cond0);
    const temp = h.loop_temp_c[loop] ?? supply;
    h.loop_temp_c[loop] = Math.max(supply, temp + (dtS * (heat - cap)) / 1000 / massKj);
  }
  for (const job of obs.job_states) {
    if (job.status !== 'running') continue;
    const spec = specOf(world, job.job_id);
    if (!spec) continue;
    const rate = job.allocated_gpu_ids.reduce((s, g) => s + spec.work_rate_per_gpu_per_sim_s * (phys0.get(g)?.clock_factor ?? 0), 0);
    job.progress_work_units += rate * dtS;
    if (job.progress_work_units >= spec.total_work_units) {
      job.progress_work_units = spec.total_work_units;
      job.status = 'completed';
      releaseJob(world, job);
    }
  }

  // 2. faults due now apply first
  expireFaults(world, h, topo, ctx);
  applyDueFaults(world, h, topo, ctx, input.due_faults_private);
  failJobsOnDeadGpus(world, h, ctx);

  // 3. commands: completions (revalidated after the faults), then starts
  processCommands(world, h, topo, ctx, input.requested_action_ids);

  // 4. observed rows at t1, with thermal shutdown (latches, fails the job, re-derives)
  const cond1 = faultConditions(world.active_faults_private, topo);
  let derived = deriveGpus(obs.gpus, gpuJobMap(obs.job_states), h, topo, cond1, ctx.t1);
  const shutdown = [...derived.physics].filter(([, p]) => isShutdownTemp(p.temp_c));
  if (shutdown.length > 0) {
    const rows = new Map(derived.gpus.map((g) => [g.resource_id, g]));
    for (const [id, p] of shutdown) {
      if (!latchFailure(h, id, 'thermal_shutdown')) continue;
      const row = rows.get(id)!;
      row.temp_c = p.temp_c; // last reading before it powered off
      row.last_seen_sim_ms = ctx.t1;
      ctx.signals.push({ kind: 'thermal_shutdown', gpu_id: id, temp_c: p.temp_c });
    }
    failJobsOnDeadGpus(world, h, ctx);
    derived = deriveGpus(derived.gpus, gpuJobMap(obs.job_states), h, topo, cond1, ctx.t1);
  }
  obs.gpus = derived.gpus;
  obs.nodes = deriveNodes(obs.nodes, obs.gpus, h, topo);
  obs.cooling = deriveCooling(obs.cooling, topo, cond1);
  for (const c of obs.checkpoints) c.accessible = !cond1.storageDown.has(c.storage_resource_id);
  for (const job of obs.job_states) job.last_update_sim_time_ms = ctx.t1;

  // 5. versions + material change (observable, safety-relevant fields only)
  let material = false;
  material = bumpVersions(before.gpus, obs.gpus, (g) => g.resource_id, gpuMaterialKey) || material;
  material = bumpVersions(before.nodes, obs.nodes, (n) => n.resource_id, nodeMaterialKey) || material;
  material = bumpVersions(before.cooling, obs.cooling, (c) => c.resource_id, coolingMaterialKey) || material;
  material = bumpVersions<JobState>(before.job_states, obs.job_states, (j) => j.job_id, jobMaterialKey) || material;
  const ckBefore = before.checkpoints.map(checkpointKey).join(';');
  if (obs.checkpoints.map(checkpointKey).join(';') !== ckBefore) material = true;

  // 6. observations, clock
  const telemetry = emitTelemetry(world, h, topo, cond1, ctx);
  const signals = buildSignals(world, topo, ctx);
  obs.observation_event_ids = [...obs.observation_event_ids, ...signals.map((s) => s.event_id)].slice(-MAX_OBSERVATION_EVENT_IDS);
  obs.clock = {
    ...obs.clock,
    sim_time_ms: ctx.t1,
    tick_index: ctx.tick,
    step_ms: dtMs,
    decision_epoch: obs.clock.decision_epoch + (material ? 1 : 0),
  };
  return result(material, ctx, telemetry, signals);
}
