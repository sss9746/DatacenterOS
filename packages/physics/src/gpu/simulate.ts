// simulatePlan(obs, plan, opts): the counterfactual planner (ARCHITECTURE §5, CONTRACTS §0.6, P1-7).
//
// 1. estimateWorld(obs, seed) builds an ESTIMATED PhysicsWorld from the ObservedSnapshot only (CONTRACTS §A: private
//    truth never reaches the planner). No private faults are copied, because there are none in the input. Observed
//    degradation persists: a pump runs at its observed_capacity_estimate_w, unreachable / degraded GPUs keep that state,
//    cordons stay, and an inaccessible checkpoint store stays inaccessible. No new faults happen.
// 2. The plan's commands are enqueued (enqueueCommands) and requested in plan order. A command whose
//    depends_on_command_keys are not all completed yet waits. If one of them failed, the dependent never runs and
//    counts as failed (DEPENDENCY_FAILED).
// 3. The same step() as the live tick runs at STEP_MS over the horizon (default PLANNER_HORIZON_S = 600 s) with
//    due_faults_private = [], and the metrics below are accumulated.
//
// Pure and deterministic: the input obs is never mutated; no clock, randomness or I/O. Only `import type` from
// @dcos/contracts.
import type { ActionCommand, FaultInjection, JobState, ObservedSnapshot, PhysicsWorld, PlanCandidate } from '@dcos/contracts';
import {
  GPU_MODEL_VERSION,
  GPU_TEMP_RISE_C_PER_LOAD,
  LOOP_SUPPLY_C,
  PLANNER_HORIZON_S,
  POWER_LIMIT_W,
  SHUTDOWN_C,
  SLOWDOWN_C,
  STEP_MS,
  WIRE_SCHEMA_VERSION as V,
} from './constants.js';
import { commandOutcome, enqueueCommands } from './actions.js';
import { ACTIVE_STATUSES } from './jobs.js';
import { toObserved } from './observe.js';
import { rngFromSeed } from './rng.js';
import { step } from './step.js';
import {
  UNREACHABLE_FAILURES,
  buildTopology,
  faultConditions,
  gpuPhysics,
  hiddenOf,
  specOf,
  type GpuFailure,
  type HiddenState,
  type InFlightCommand,
} from './world.js';

/**
 * Result of one simulated plan (CONTRACTS §0.6). Not a wire-schema type; the four numbers validate the way the
 * matching PlanCandidate fields do (all ≥ 0, failure_risk_estimate in [0, 1]). Never contains private fields or
 * fault truth: everything below is computed from the estimated world.
 *
 * - expected_completion_delay_sim_s: Σ over jobs not completed at the start of (ideal work − simulated work) /
 *   ideal rate, each term clamped at ≥ 0. ideal rate = gpus_required × work_rate_per_gpu_per_sim_s (nominal clock);
 *   ideal work = min(ideal rate × simulated horizon, total − progress at start). simulated work = progress at the
 *   end − progress at the start, so it goes negative after a rollback: the delay includes the time to redo
 *   rolled-back work. A job that is failed / queued at the start and stays that way accrues the whole horizon.
 * - expected_lost_work_units: Σ work rolled back: on every tick a job's progress ends below
 *   (progress at t0 + the work it gained this tick), the difference is lost. That covers a job failure (back to
 *   durable_work_units) and a migrate_restart from an older checkpoint (progress since it is discarded).
 * - expected_gpu_busy_waste_s: GPU-seconds allocated to a job without full progress. Per tick, per allocated GPU:
 *   (1 − clock factor) × dt when the job is running (thermal throttle −30% and power cap −15% count fractionally),
 *   and the whole dt when the job holds the GPU but makes no progress (checkpointing, restarting, paused).
 * - failure_risk_estimate: 1 − Π_jobs (1 − p_job) over every job that held GPUs during the horizon. p_job = 1 when
 *   the job failed during the simulation; otherwise p_job = clamp((T_max − SLOWDOWN_C) / (SHUTDOWN_C − SLOWDOWN_C),
 *   0, 1), with T_max the hottest observed temperature of a GPU while it was allocated to that job (85 °C → 0,
 *   92 °C → 1). The simulation itself is deterministic; this maps "how close to a job loss" onto [0, 1].
 * - violations: `${reason_code}` of every plan command that failed inside physics (commandOutcome), plus
 *   DEPENDENCY_FAILED / DEPENDENCY_NOT_FOUND for commands that were never requested because of a dependency.
 * - assumptions: human-readable list (observed degradation persists, no new faults, horizon, seed, estimates made).
 */
export type PlanMetrics = Pick<
  PlanCandidate,
  'expected_completion_delay_sim_s' | 'expected_lost_work_units' | 'expected_gpu_busy_waste_s' | 'failure_risk_estimate'
> & { violations: string[]; assumptions: string[] };

export interface SimulatePlanOptions {
  /** Horizon, sim-seconds (default PLANNER_HORIZON_S = 600). */
  horizon_s?: number;
  /** Seed stamped on the estimated world and every tick input (default 0). The GPU model draws no randomness. */
  seed?: number;
}

// ---- estimated world -----------------------------------------------------------------------------

/** Prefix of every synthetic id the estimate invents (fault ids, in-flight command ids). */
export const ESTIMATED_PREFIX = 'estimated.';

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Latched failure that reproduces an observed GPU availability (no fault truth: inferred from the observed row). */
function inferredFailure(
  availability: string, lastXid: number | null, nodeUnreachable: boolean, tempC: number,
): GpuFailure | null {
  if (availability === 'unreachable') {
    if (nodeUnreachable) return 'node_crash';
    if (lastXid === 79) return 'xid_79';
    if (tempC >= SHUTDOWN_C) return 'thermal_shutdown';
    return 'xid_79';
  }
  if (availability === 'degraded' || availability === 'cordoned') {
    if (lastXid === 48) return 'xid_48';
    if (lastXid === 74) return 'xid_74';
    return availability === 'degraded' ? 'xid_74' : null; // degraded with no XID: a non-fatal latched degradation
  }
  return null;
}

function syntheticCommand(obs: ObservedSnapshot, key: string, operation: ActionCommand['operation'], job: JobState, atMs: number): ActionCommand {
  return {
    schema_version: V, run_id: obs.run_id, action_id: `${ESTIMATED_PREFIX}${key}`, command_key: key,
    workflow_id: `${ESTIMATED_PREFIX}workflow`, plan_id: `${ESTIMATED_PREFIX}plan`, incident_ids: [`${ESTIMATED_PREFIX}incident`],
    operation, target_resource_id: job.job_id, job_id: job.job_id, arguments: {}, depends_on_command_keys: [],
    expected_decision_epoch: obs.clock.decision_epoch, expected_resource_versions: {}, requested_sim_time_ms: atMs,
  };
}

/**
 * Build an estimated PhysicsWorld from an ObservedSnapshot alone. Exported for P1-8 / P1-9.
 *
 * Inversion of the hidden coolant temperature (step.ts / world.ts model: GPU temp = loop temp + rack inlet_offset_c
 * + 35 °C × heat load + per-GPU offset, with heat load = power_w / 700 W for capped and uncapped GPUs alike):
 *   for every reachable GPU with a fresh reading (last_seen = now) on a loop's racks,
 *     loop_g = temp_c − 35 × power_w / 700 − rack inlet_offset_c;
 *   loop temp = median(loop_g), clamped at the loop supply setpoint (the median ignores one hot outlier GPU).
 *   Each GPU's offset = its residual temp_c − (loop temp + offset + 35 × load), so the estimated world reproduces
 *   every observed temperature at t0 exactly (an observed hot GPU stays hot). Because the loop ODE does not depend
 *   on the loop temperature above the supply clamp, any constant error in the loop estimate is cancelled by the
 *   residuals. Unreachable or stale GPUs get offset 0. A loop with no usable reading starts at its supply temp.
 *
 * Observed degradation persists, with NO fault rows: a pump's capacity config is set to its
 * observed_capacity_estimate_w (null → nominal). The estimated world's cooling rows are re-derived as 'normal' after
 * a tick because the degradation lives in that config; physics only uses the capacity. Unreachable / degraded /
 * cordoned GPUs latch an inferred failure (from availability + last_xid_code) that never clears. A checkpoint store
 * with a non-failed checkpoint observed inaccessible gets one synthetic `estimated.storage_inaccessible.<store>`
 * network_link_down row (physics reads storage availability only from fault rows); it is not fault truth.
 *
 * Commands already running in the real world are not observable; they are rebuilt from the observed rows: a
 * 'checkpointing' job finishes its writing checkpoint at requested_sim_time_ms + checkpoint_duration_ms (with the
 * checkpoint's command_key), a 'restarting' job is running again at allocation since + restart_duration_ms.
 * The clock is unpaused so step() advances.
 */
export function estimateWorld(obs: ObservedSnapshot, seed = 0): PhysicsWorld {
  // a deep copy with any private key stripped (defense in depth; an ObservedSnapshot has none)
  const observable = toObserved({ observable: obs } as unknown as PhysicsWorld);
  observable.clock = { ...observable.clock, paused: false };
  const now = observable.clock.sim_time_ms;
  const topo = buildTopology(observable.resources, observable.gpus);

  // pumps: observed capacity estimate becomes the capacity
  const coolingById = new Map(observable.cooling.map((c) => [c.resource_id, c]));
  for (const r of observable.resources) {
    if (r.kind !== 'cooling_pump') continue;
    const est = coolingById.get(r.resource_id)?.observed_capacity_estimate_w;
    if (typeof est === 'number' && Number.isFinite(est)) r.config = { ...r.config, nominal_capacity_w: Math.max(0, est) };
  }

  // GPU failures and cordons inferred from availability
  const nodeAvail = new Map(observable.nodes.map((n) => [n.resource_id, n.availability]));
  const gpu_failure: Record<string, GpuFailure> = {};
  const gpu_cordoned: string[] = [];
  for (const g of observable.gpus) {
    const f = inferredFailure(g.availability, g.last_xid_code, nodeAvail.get(g.node_id) === 'unreachable', g.temp_c);
    if (f) gpu_failure[g.resource_id] = f;
    if (g.availability === 'cordoned') gpu_cordoned.push(g.resource_id);
  }

  // hidden coolant temperature per loop + per-GPU residual offsets (see header)
  const usable = observable.gpus.filter((g) => g.availability !== 'unreachable' && g.last_seen_sim_ms >= now);
  const heatC = (g: { power_w: number }) => GPU_TEMP_RISE_C_PER_LOAD * (g.power_w / POWER_LIMIT_W);
  const rackOffset = (gpu: string) => topo.rackOffsetC.get(topo.gpuRack.get(gpu) ?? '') ?? 0;
  const loop_temp_c: Record<string, number> = {};
  for (const loop of topo.loops) {
    const racks = new Set(topo.loopRacks.get(loop) ?? []);
    const samples = usable.filter((g) => racks.has(topo.gpuRack.get(g.resource_id) ?? ''))
      .map((g) => g.temp_c - heatC(g) - rackOffset(g.resource_id));
    const supply = topo.loopSupplyC.get(loop) ?? LOOP_SUPPLY_C;
    loop_temp_c[loop] = samples.length > 0 ? Math.max(supply, median(samples)) : supply;
  }
  const gpu_offset_c: Record<string, number> = {};
  for (const g of observable.gpus) gpu_offset_c[g.resource_id] = 0;
  for (const g of usable) {
    const loop = topo.rackLoop.get(topo.gpuRack.get(g.resource_id) ?? '');
    const base = loop ? loop_temp_c[loop]! : LOOP_SUPPLY_C;
    gpu_offset_c[g.resource_id] = g.temp_c - (base + rackOffset(g.resource_id) + heatC(g));
  }

  // checkpoint bookkeeping
  const checkpoint_counter: Record<string, number> = {};
  for (const j of observable.job_states) {
    let n = 0;
    for (const c of observable.checkpoints) {
      if (c.job_id !== j.job_id) continue;
      const m = /-(\d+)$/.exec(c.checkpoint_id);
      n = Math.max(n, m ? Number(m[1]) : 0);
    }
    checkpoint_counter[j.job_id] = n + 1;
  }
  const ids = new Set(observable.checkpoints.map((c) => c.checkpoint_id));
  for (const j of observable.job_states) while (ids.has(`ckpt-${j.job_id}-${checkpoint_counter[j.job_id]}`)) checkpoint_counter[j.job_id]! += 1;

  // in-flight commands rebuilt from observed rows
  const in_flight: InFlightCommand[] = [];
  for (const j of observable.job_states) {
    const spec = observable.job_specs.find((s) => s.job_id === j.job_id);
    if (j.status === 'checkpointing') {
      const row = observable.checkpoints.filter((c) => c.job_id === j.job_id && c.status === 'writing')
        .sort((a, b) => b.requested_sim_time_ms - a.requested_sim_time_ms)[0];
      if (!row) {
        j.status = 'running'; // no writing row observed: assume the write ended
        continue;
      }
      in_flight.push({
        command: syntheticCommand(observable, row.command_key, 'checkpoint', j, row.requested_sim_time_ms),
        started_sim_ms: row.requested_sim_time_ms,
        due_sim_ms: row.requested_sim_time_ms + (spec?.checkpoint_duration_ms ?? 0),
        resume_status: 'running', checkpoint_id: row.checkpoint_id,
      });
    } else if (j.status === 'restarting') {
      const since = observable.allocations.filter((a) => a.job_id === j.job_id).map((a) => a.since_sim_time_ms);
      const start = since.length > 0 ? Math.min(...since) : now;
      in_flight.push({
        command: syntheticCommand(observable, `${ESTIMATED_PREFIX}restart.${j.job_id}`, 'migrate_restart', j, start),
        started_sim_ms: start, due_sim_ms: start + (spec?.restart_duration_ms ?? 0),
        destination_gpu_ids: [...j.allocated_gpu_ids],
      });
    }
  }

  // inaccessible checkpoint stores persist (the only synthetic fault row; see header)
  const downStores = [...new Set(observable.checkpoints.filter((c) => !c.accessible && c.status !== 'failed').map((c) => c.storage_resource_id))].sort();
  const estimatedFaults: FaultInjection[] = downStores.map((store) => ({
    schema_version: V, fault_id: `${ESTIMATED_PREFIX}storage_inaccessible.${store}`, run_id: observable.run_id,
    target_resource_id: store, kind: 'network_link_down', start_sim_time_ms: now, duration_sim_ms: null, severity: 1,
    parameters: { estimated_from: 'checkpoint.accessible=false' }, seed_offset: 0,
  }));

  const hidden: HiddenState = {
    model: GPU_MODEL_VERSION, preset_id: `${ESTIMATED_PREFIX}from_observed`, seed,
    loop_temp_c, gpu_offset_c, gpu_failure, gpu_cordoned, checkpoint_counter,
    command_inbox: [], in_flight, finished_command_keys: [], command_outcomes: {}, stale_values: {},
  };
  return {
    schema_version: V, run_id: observable.run_id, observable, active_faults_private: estimatedFaults,
    hidden_physics_state_json: hidden as unknown as Record<string, unknown>, rng_state: rngFromSeed(seed).state(),
  };
}

// ---- simulation ------------------------------------------------------------------------------------

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const EPS = 1e-9;
/** PlanCandidate.assumptions maxItems (wire schema), so the list can be copied into a candidate as is. */
const MAX_ASSUMPTIONS = 50;

function describeEstimate(obs: ObservedSnapshot, world: PhysicsWorld, horizonS: number, seed: number): string[] {
  const h = hiddenOf(world);
  const out: string[] = [
    `Estimated world built from the ObservedSnapshot at sim t=${obs.clock.sim_time_ms} ms; no private fault truth used.`,
    'No new faults during the horizon; observed degradation persists.',
  ];
  for (const c of obs.cooling) {
    if (c.observed_capacity_estimate_w !== null && c.observed_capacity_estimate_w !== c.nominal_capacity_w) {
      out.push(`${c.resource_id} stays at its observed capacity estimate ${c.observed_capacity_estimate_w} W (nominal ${c.nominal_capacity_w} W).`);
    }
  }
  for (const [loop, t] of Object.entries(h.loop_temp_c).sort()) {
    out.push(`${loop} coolant temperature estimated at ${Math.round(t * 10) / 10} °C from observed GPU temperatures, power and rack offsets.`);
  }
  const unreachable = obs.gpus.filter((g) => g.availability === 'unreachable').map((g) => g.resource_id);
  if (unreachable.length > 0) out.push(`Unreachable GPUs stay unreachable: ${unreachable.join(', ')}.`);
  const degraded = obs.gpus.filter((g) => g.availability === 'degraded').map((g) => g.resource_id);
  if (degraded.length > 0) out.push(`Degraded GPUs stay degraded: ${degraded.join(', ')}.`);
  if (h.gpu_cordoned.length > 0) out.push(`Cordons stay: ${h.gpu_cordoned.join(', ')}.`);
  for (const f of world.active_faults_private) out.push(`Checkpoint store ${f.target_resource_id} was observed inaccessible and stays inaccessible.`);
  for (const f of h.in_flight) {
    out.push(`In-flight ${f.command.operation} of ${f.command.job_id} rebuilt from observed rows; it finishes at sim t=${f.due_sim_ms} ms.`);
  }
  const stale = obs.gpus.filter((g) => g.availability !== 'unreachable' && g.last_seen_sim_ms < obs.clock.sim_time_ms).length;
  if (stale > 0) out.push(`${stale} GPU readings are stale; they are not used for the coolant estimate.`);
  out.push(`Horizon ${horizonS} sim-s at step ${STEP_MS} ms; seed ${seed}; deterministic model (one outcome, not a distribution).`);
  return out;
}

interface DepState {
  failedKeys: Set<string>;
  violations: string[];
}

function simulate(obs: ObservedSnapshot, commands: ActionCommand[], opts: SimulatePlanOptions): PlanMetrics {
  const horizonS = opts.horizon_s ?? PLANNER_HORIZON_S;
  const seed = opts.seed ?? 0;
  const ticks = Number.isFinite(horizonS) && horizonS > 0 ? Math.ceil((horizonS * 1000) / STEP_MS) : 0;
  const dtS = STEP_MS / 1000;
  const simS = ticks * dtS;

  const base = estimateWorld(obs, seed);
  const assumptions = describeEstimate(obs, base, horizonS, seed);
  let world = enqueueCommands(base, commands);

  // static over the run: resources never change; estimated fault rows never expire
  const topo = buildTopology(world.observable.resources, world.observable.gpus);
  const cond = faultConditions(world.active_faults_private, topo);
  const planKeys = new Set(commands.map((c) => c.command_key));
  const knownKeys = new Set([...planKeys, ...hiddenOf(world).in_flight.map((f) => f.command.command_key)]);

  const start = new Map(world.observable.job_states.map((j) => [j.job_id, { status: j.status, progress: j.progress_work_units }]));
  const jobMaxTemp = new Map<string, number>();
  const jobFailed = new Set<string>();
  let lost = 0;
  let waste = 0;

  let pending = [...commands];
  const deps: DepState = { failedKeys: new Set(), violations: [] };
  const outcomeOf = (key: string) => commandOutcome(world, key);

  for (let i = 0; i < ticks; i++) {
    // dependencies: request what is ready, drop what can never run (repeat: a drop can cascade)
    const requested: string[] = [];
    for (let changed = true; changed;) {
      changed = false;
      const next: ActionCommand[] = [];
      for (const c of pending) {
        const ds = c.depends_on_command_keys;
        const missing = ds.find((k) => !knownKeys.has(k) && outcomeOf(k) === null);
        const failed = ds.find((k) => deps.failedKeys.has(k) || outcomeOf(k)?.ok === false);
        if (missing !== undefined || failed !== undefined) {
          deps.failedKeys.add(c.command_key);
          deps.violations.push(missing !== undefined ? 'DEPENDENCY_NOT_FOUND' : 'DEPENDENCY_FAILED');
          changed = true;
        } else if (ds.every((k) => outcomeOf(k)?.ok === true)) {
          requested.push(c.action_id);
        } else {
          next.push(c);
        }
      }
      pending = next;
    }

    // per-tick accounting at t0 (the state step() integrates with)
    const h0 = hiddenOf(world);
    const gpuRows = new Map(world.observable.gpus.map((g) => [g.resource_id, g]));
    const before = new Map<string, { progress: number; gain: number; status: JobState['status'] }>();
    for (const j of world.observable.job_states) {
      let gain = 0;
      if (j.allocated_gpu_ids.length > 0 && ACTIVE_STATUSES.has(j.status)) {
        const spec = specOf(world, j.job_id);
        for (const g of j.allocated_gpu_ids) {
          let factor = 0;
          const row = gpuRows.get(g);
          const f = h0.gpu_failure[g];
          if (j.status === 'running' && row && !(f && UNREACHABLE_FAILURES.has(f))) {
            factor = gpuPhysics(row, 1, h0, topo, cond).clock_factor;
          }
          waste += (1 - factor) * dtS;
          gain += (spec?.work_rate_per_gpu_per_sim_s ?? 0) * factor * dtS;
        }
        if (spec) gain = Math.min(gain, Math.max(0, spec.total_work_units - j.progress_work_units));
      }
      before.set(j.job_id, { progress: j.progress_work_units, gain, status: j.status });
    }

    const result = step({
      schema_version: V, run_id: world.run_id, step_ms: STEP_MS, seed, world, due_faults_private: [], requested_action_ids: requested,
    });
    world = result.world_after;

    const temps = new Map(world.observable.gpus.map((g) => [g.resource_id, g.temp_c]));
    for (const j of world.observable.job_states) {
      const b = before.get(j.job_id);
      if (b) {
        const shortfall = b.progress + b.gain - j.progress_work_units;
        if (shortfall > EPS) lost += shortfall;
      }
      if (j.status === 'failed' && b && b.status !== 'failed') jobFailed.add(j.job_id);
      for (const g of j.allocated_gpu_ids) {
        const t = temps.get(g);
        if (t !== undefined) jobMaxTemp.set(j.job_id, Math.max(jobMaxTemp.get(j.job_id) ?? -Infinity, t));
      }
    }
  }

  // delay
  let delay = 0;
  for (const j of world.observable.job_states) {
    const s = start.get(j.job_id);
    const spec = specOf(world, j.job_id);
    if (!s || !spec || s.status === 'completed') continue;
    const rate = spec.gpus_required * spec.work_rate_per_gpu_per_sim_s;
    if (!(rate > 0)) continue;
    const ideal = Math.min(rate * simS, Math.max(0, spec.total_work_units - s.progress));
    delay += Math.max(0, ideal - (j.progress_work_units - s.progress)) / rate;
  }

  // risk
  let survive = 1;
  const band = SHUTDOWN_C - SLOWDOWN_C;
  for (const jobId of new Set([...jobMaxTemp.keys(), ...jobFailed])) {
    const p = jobFailed.has(jobId) ? 1 : Math.min(1, Math.max(0, ((jobMaxTemp.get(jobId) ?? 0) - SLOWDOWN_C) / band));
    survive *= 1 - p;
  }

  // violations: physics failures of plan commands, in plan order, then dependency drops
  const violations: string[] = [];
  let unfinished = 0;
  for (const c of commands) {
    if (deps.failedKeys.has(c.command_key)) continue;
    const o = commandOutcome(world, c.command_key);
    if (o === null) unfinished += 1;
    else if (!o.ok) violations.push(o.reason_code ?? 'FAILED');
  }
  violations.push(...deps.violations);
  if (unfinished > 0) assumptions.push(`${unfinished} plan command(s) had not finished by the end of the horizon.`);
  if (jobFailed.size > 0) assumptions.push(`Simulated job failures within the horizon: ${[...jobFailed].sort().join(', ')}.`);

  return {
    expected_completion_delay_sim_s: r3(delay),
    expected_lost_work_units: r3(lost),
    expected_gpu_busy_waste_s: r3(waste),
    failure_risk_estimate: Math.min(1, Math.max(0, r4(1 - survive))),
    violations,
    assumptions: assumptions.slice(0, MAX_ASSUMPTIONS),
  };
}

/** CONTRACTS §0.6 (frozen signature). See PlanMetrics for the metric definitions. */
export function simulatePlan(obs: ObservedSnapshot, plan: { commands: ActionCommand[] }, opts: SimulatePlanOptions = {}): PlanMetrics {
  return simulate(obs, plan.commands, opts);
}

/** The plan plus the "do nothing" reference (no commands) over the same estimated world, horizon and seed. */
export function simulatePlanWithReference(
  obs: ObservedSnapshot, plan: { commands: ActionCommand[] }, opts: SimulatePlanOptions = {},
): { plan: PlanMetrics; do_nothing: PlanMetrics } {
  return { plan: simulate(obs, plan.commands, opts), do_nothing: simulate(obs, [], opts) };
}
