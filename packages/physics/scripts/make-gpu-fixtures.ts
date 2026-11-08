// P1-1: builds the GPU fixtures in packages/physics/fixtures/gpu/ for preset `gpu_demo_8`.
//
//   node packages/physics/scripts/make-gpu-fixtures.ts      (Node >= 22.18 / 24 strips the types)
//
// This is a stand-in for buildPreset/step/toObserved (P1-3/P1-4) so P2, P3 and P4 can build against
// stable payloads today. Once those land, regenerate these files from the real `buildPreset` + `step`.
// Deterministic: no Date.now(), no Math.random(); file writes happen only in main() below.
// (This is a Node script, not package source, so it may use node:fs.)
// IDs follow CONTRACTS §0.3; numbers follow §0.4. Every value here is SIMULATED and configurable.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  Checkpoint,
  CoolingCurrent,
  DependencyEdge,
  FaultInjection,
  GpuCurrent,
  JobGpuAllocation,
  JobSpec,
  JobState,
  NodeCurrent,
  ObservedSnapshot,
  PhysicsTickResult,
  PhysicsWorld,
  ResourceSpec,
  SignalEvent,
  TelemetryEvent,
} from '../../contracts/src/index.js';

const V = '1.1.0' as const;
export const RUN_ID = 'run-demo-1';
export const PRESET_ID = 'gpu_demo_8';
export const SEED = 1;
const SOURCE_ID = 'sim-engine-1';

/** Simulated constants. §0.4 values first; the rest are fixture assumptions (P1-3 moves them to src/gpu/constants.ts). */
export const FIXTURE_SIM = {
  // §0.4
  GPU_TEMP_RISE_C_PER_LOAD: 35, // GPU temp = rack inlet + 35 °C × load
  SLOWDOWN_C: 85,
  SHUTDOWN_C: 92,
  THROTTLE_CLOCK_FACTOR: 0.7, // SM clock −30% at slowdown
  SM_CLOCK_NOMINAL_MHZ: 1980,
  POWER_LIMIT_W: 700,
  CHECKPOINT_DURATION_MS: 30_000,
  CHECKPOINT_INTERVAL_MS: 600_000,
  RESTART_DURATION_MS: 120_000,
  STEP_MS: 1000,
  WALL_TICK_MS: 1000, // demo speed 1×
  // Fixture assumptions (not in §0.4)
  LOOP_SUPPLY_C: 35, // healthy rack inlet, so a fully loaded GPU sits at ≈70 °C (§0.4 "≈70 °C healthy")
  IDLE_LOAD: 0.1, // load of a GPU with no job; power = limit × load
  RACK_THERMAL_MASS_KJ_PER_C: 60, // v0 DEFAULT_THERMAL_MASS_KJ_PER_C
  PUMP_CAPACITY_W_PER_RACK: 8000, // pump-a (3 racks) 24 kW, pump-b (5 racks) 40 kW
  PUMP_POWER_W_PER_RACK: 500, // pump-a 1.5 kW, pump-b 2.5 kW at nominal flow
  R6_INLET_OFFSET_C: 12, // restricted manifold on r6: it is the hot destination (§0.3, job-c row)
  GPU_TEMP_SPREAD_C: 0.6, // seeded per-GPU offset in [−0.3, +0.3] °C
  WORK_RATE_PER_GPU_PER_SIM_S: 1,
  PUMP_A_FAULT_START_MS: 10_000, // same as the P1-4 Gate 1 test
  PUMP_A_FAULT_SEVERITY: 0.6, // capacity and pump power drop to 40%
  RUN_EPOCH_UNIX_MS: 1_794_091_200_000, // observed_unix_ms = this + sim_time_ms (1×)
  CLOCKS_EVENT_HW_THERMAL: 0x40, // DCGM/NVML HW thermal slowdown bit
} as const;
const S = FIXTURE_SIM;

// ---- topology (§0.3) -------------------------------------------------------------------------

const RACKS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const GPU_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
const LOOP_A_RACKS: readonly number[] = [2, 3, 4];

const rackId = (r: number) => `rack-r${r}`;
const nodeId = (r: number) => `node-r${r}-n1`;
const gpuId = (r: number, k: number) => `gpu-r${r}-n1-${k}`;
const linkId = (r: number) => `link-r${r}`;
const loopOf = (r: number) => (LOOP_A_RACKS.includes(r) ? 'loop-a' : 'loop-b');
const pumpOfLoop = (loop: string) => (loop === 'loop-a' ? 'pump-a' : 'pump-b');
const racksOnLoop = (loop: string) => RACKS.filter((r) => loopOf(r) === loop);
const round1 = (x: number) => Math.round(x * 10) / 10;

interface JobDef {
  job_id: string;
  racks: number[];
  placement_policy: JobSpec['placement_policy'];
  preemptible: boolean;
  checkpointed: boolean;
  priority: number;
  total_work_units: number;
  durable_work_units: number; // at t=0
  checkpoint_age_s: number | null; // "last checkpoint N sim-min ago" at t=0
  progress_at_t0?: number; // only for jobs with no checkpoint
}

const JOBS: JobDef[] = [
  { job_id: 'job-a', racks: [2, 3], placement_policy: 'gang_multi_node', preemptible: true, checkpointed: true,
    priority: 50, total_work_units: 200_000, durable_work_units: 86_400, checkpoint_age_s: 9 * 60 },
  { job_id: 'job-b', racks: [4], placement_policy: 'same_node', preemptible: true, checkpointed: true,
    priority: 50, total_work_units: 60_000, durable_work_units: 40_000, checkpoint_age_s: 60 },
  { job_id: 'job-c', racks: [6], placement_policy: 'same_node', preemptible: false, checkpointed: false,
    priority: 90, total_work_units: 100_000, durable_work_units: 0, checkpoint_age_s: null, progress_at_t0: 30_000 },
];

const jobGpus = (j: JobDef) => j.racks.flatMap((r) => GPU_SLOTS.map((k) => gpuId(r, k)));
const gpuJob = new Map<string, JobDef>(JOBS.flatMap((j) => jobGpus(j).map((g) => [g, j] as const)));
const jobProgressAt = (j: JobDef, simMs: number) => {
  const rate = jobGpus(j).length * S.WORK_RATE_PER_GPU_PER_SIM_S;
  const t0 = j.checkpoint_age_s === null ? (j.progress_at_t0 ?? 0) : j.durable_work_units + rate * j.checkpoint_age_s;
  return t0 + (rate * simMs) / 1000;
};
const checkpointId = (j: JobDef) => `ckpt-${j.job_id}-1`;

// ---- seeded RNG (mulberry32) -----------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    state: () => `mulberry32:0x${a.toString(16).padStart(8, '0')}`,
  };
}

const rng = mulberry32(SEED);
const GPU_OFFSET_C = new Map<string, number>(
  RACKS.flatMap((r) => GPU_SLOTS.map((k) => [gpuId(r, k), (rng.next() - 0.5) * S.GPU_TEMP_SPREAD_C] as const)),
);
const RNG_STATE = rng.state();

// ---- static resources and edges --------------------------------------------------------------

function resources(): ResourceSpec[] {
  const res = (
    resource_id: string, kind: ResourceSpec['kind'], parent_id: string | null, failure_domain_id: string,
    profile: string, config: Record<string, unknown>,
  ): ResourceSpec => ({ schema_version: V, run_id: RUN_ID, resource_id, kind, parent_id, failure_domain_id, profile, config, enabled: true });

  const out: ResourceSpec[] = [
    res('power-main', 'power_domain', null, 'fd-power-main', 'sim_power', { simulated: true }),
    ...(['pump-a', 'pump-b'] as const).map((p) => {
      const loop = p === 'pump-a' ? 'loop-a' : 'loop-b';
      const n = racksOnLoop(loop).length;
      return res(p, 'cooling_pump', null, `fd-${p}`, 'sim_pump', {
        nominal_capacity_w: n * S.PUMP_CAPACITY_W_PER_RACK, nominal_pump_power_w: n * S.PUMP_POWER_W_PER_RACK, simulated: true,
      });
    }),
    ...(['loop-a', 'loop-b'] as const).map((l) =>
      res(l, 'cooling_loop', null, `fd-${pumpOfLoop(l)}`, 'sim_loop', {
        pump_id: pumpOfLoop(l), rack_ids: racksOnLoop(l).map(rackId), supply_temp_c: S.LOOP_SUPPLY_C, simulated: true,
      }),
    ),
    res('ckpt-store-1', 'checkpoint_store', null, 'fd-storage', 'sim_storage', { simulated: true }),
  ];
  for (const r of RACKS) {
    out.push(res(rackId(r), 'rack', null, `fd-${rackId(r)}`, 'sim_rack', {
      cooling_loop_id: loopOf(r), power_domain_id: 'power-main', inlet_offset_c: r === 6 ? S.R6_INLET_OFFSET_C : 0,
      thermal_mass_kj_per_c: S.RACK_THERMAL_MASS_KJ_PER_C, simulated: true,
    }));
    out.push(res(nodeId(r), 'node', rackId(r), `fd-${rackId(r)}`, 'sim_node_8gpu', { gpu_count: GPU_SLOTS.length, simulated: true }));
    for (const k of GPU_SLOTS) {
      out.push(res(gpuId(r, k), 'gpu', nodeId(r), `fd-${rackId(r)}`, 'demo_gpu', {
        index: k, power_limit_w: S.POWER_LIMIT_W, sm_clock_nominal_mhz: S.SM_CLOCK_NOMINAL_MHZ,
        slowdown_temp_c: S.SLOWDOWN_C, shutdown_temp_c: S.SHUTDOWN_C, allocatable: true, simulated: true,
      }));
    }
    out.push(res(linkId(r), 'network_link', rackId(r), `fd-${rackId(r)}`, 'sim_link', { tier: 2, simulated: true }));
  }
  out.push(res('fan-sensor-r3', 'fan_sensor', rackId(3), `fd-${rackId(3)}`, 'pico2w_microphone', {
    hardware_sensor_id: 'pico-fan-r3', hardware_backed: true,
  }));
  out.push(res('gpu-real-0', 'gpu', null, 'fd-brev', 'brev_real', { allocatable: false, hardware_backed: true }));
  return out;
}

function dependencies(): DependencyEdge[] {
  const edge = (consumer_id: string, relation: DependencyEdge['relation'], provider_id: string): DependencyEdge => ({
    schema_version: V, run_id: RUN_ID, edge_id: `edge.${consumer_id}.${relation}.${provider_id}`, consumer_id, provider_id, relation, weight: 1,
  });
  const out: DependencyEdge[] = [];
  for (const r of RACKS) {
    for (const k of GPU_SLOTS) out.push(edge(gpuId(r, k), 'hosted_on', nodeId(r)));
    out.push(edge(nodeId(r), 'hosted_on', rackId(r)));
    out.push(edge(rackId(r), 'cooled_by', loopOf(r)));
    out.push(edge(rackId(r), 'powered_by', 'power-main'));
    out.push(edge(nodeId(r), 'connected_via', linkId(r)));
  }
  out.push(edge('loop-a', 'cooled_by', 'pump-a'), edge('loop-b', 'cooled_by', 'pump-b'));
  out.push(edge(rackId(3), 'monitored_by', 'fan-sensor-r3'));
  for (const j of JOBS) if (j.checkpointed) out.push(edge(j.job_id, 'checkpoint_uses', 'ckpt-store-1'));
  return out;
}

function jobSpecs(): JobSpec[] {
  return JOBS.map((j) => ({
    schema_version: V, run_id: RUN_ID, job_id: j.job_id,
    gpus_required: jobGpus(j).length,
    placement_policy: j.placement_policy,
    compatible_node_ids: (j.preemptible ? RACKS.map(nodeId) : j.racks.map(nodeId)) as JobSpec['compatible_node_ids'],
    gpu_profile: 'demo_gpu',
    priority: j.priority,
    preemptible: j.preemptible,
    checkpoint_supported: j.checkpointed,
    checkpoint_storage_id: j.checkpointed ? 'ckpt-store-1' : null,
    checkpoint_duration_ms: j.checkpointed ? S.CHECKPOINT_DURATION_MS : 0,
    restart_duration_ms: S.RESTART_DURATION_MS,
    checkpoint_interval_ms: j.checkpointed ? S.CHECKPOINT_INTERVAL_MS : 0,
    total_work_units: j.total_work_units,
    work_rate_per_gpu_per_sim_s: S.WORK_RATE_PER_GPU_PER_SIM_S,
  }));
}

// ---- time-dependent state --------------------------------------------------------------------

const pumpADegraded = (simMs: number) => simMs >= S.PUMP_A_FAULT_START_MS;
const gpuLoad = (g: string) => (gpuJob.has(g) ? 1 : S.IDLE_LOAD);
const gpuPowerW = (g: string) => S.POWER_LIMIT_W * gpuLoad(g);

function loopHeatW(loop: string): number {
  return racksOnLoop(loop).reduce<number>((sum, r) => sum + GPU_SLOTS.reduce<number>((s, k) => s + gpuPowerW(gpuId(r, k)), 0), 0);
}
function loopCapacityW(loop: string, simMs: number): number {
  const nominal = racksOnLoop(loop).length * S.PUMP_CAPACITY_W_PER_RACK;
  return loop === 'loop-a' && pumpADegraded(simMs) ? nominal * (1 - S.PUMP_A_FAULT_SEVERITY) : nominal;
}

/** Rack inlet: loop supply + rack offset + linear rise from the per-rack cooling deficit (v0 dT/dt = deficit / mass). */
function rackInletC(r: number, simMs: number): number {
  const base = S.LOOP_SUPPLY_C + (r === 6 ? S.R6_INLET_OFFSET_C : 0);
  const loop = loopOf(r);
  const deficitW = Math.max(0, loopHeatW(loop) - loopCapacityW(loop, simMs));
  if (deficitW === 0) return base;
  const perRackKw = deficitW / racksOnLoop(loop).length / 1000;
  const elapsedS = (simMs - S.PUMP_A_FAULT_START_MS) / 1000;
  return base + (perRackKw / S.RACK_THERMAL_MASS_KJ_PER_C) * elapsedS;
}

function gpuCurrent(r: number, k: number, simMs: number): GpuCurrent {
  const g = gpuId(r, k);
  const temp = round1(rackInletC(r, simMs) + S.GPU_TEMP_RISE_C_PER_LOAD * gpuLoad(g) + (GPU_OFFSET_C.get(g) ?? 0));
  const throttled = temp >= S.SLOWDOWN_C;
  return {
    schema_version: V, run_id: RUN_ID, resource_id: g, node_id: nodeId(r),
    availability: temp >= S.SHUTDOWN_C ? 'unreachable' : 'ready',
    temp_c: temp,
    sm_clock_mhz: throttled ? Math.round(S.SM_CLOCK_NOMINAL_MHZ * S.THROTTLE_CLOCK_FACTOR) : S.SM_CLOCK_NOMINAL_MHZ,
    power_w: gpuPowerW(g),
    power_limit_w: S.POWER_LIMIT_W,
    clocks_event_reasons: throttled ? S.CLOCKS_EVENT_HW_THERMAL : 0,
    last_xid_code: null,
    last_seen_sim_ms: simMs,
    version: 0,
  };
}

function pumpCurrent(pump: 'pump-a' | 'pump-b', simMs: number): CoolingCurrent {
  const loop = pump === 'pump-a' ? 'loop-a' : 'loop-b';
  const n = racksOnLoop(loop).length;
  const degraded = pump === 'pump-a' && pumpADegraded(simMs);
  const nominalPower = n * S.PUMP_POWER_W_PER_RACK;
  const power = degraded ? nominalPower * (1 - S.PUMP_A_FAULT_SEVERITY) : nominalPower;
  const nominalCap = n * S.PUMP_CAPACITY_W_PER_RACK;
  return {
    schema_version: V, run_id: RUN_ID, resource_id: pump,
    operating_state: degraded ? 'degraded' : 'normal',
    nominal_capacity_w: nominalCap,
    pump_power_w: power,
    observed_capacity_estimate_w: Math.round(nominalCap * (power / nominalPower)), // estimated from observed pump power
    version: degraded ? 1 : 0,
  };
}

const eventSeq = (simMs: number, i: number) => (simMs / S.STEP_MS) * 1000 + i; // telemetry i < 900, signals 900+
const unixMs = (simMs: number) => S.RUN_EPOCH_UNIX_MS + simMs;

function pumpAlarm(): SignalEvent {
  const t = S.PUMP_A_FAULT_START_MS;
  const p = pumpCurrent('pump-a', t);
  return {
    schema_version: V, event_id: `sig.${t}.pump-a.equipment_alarm`, run_id: RUN_ID, resource_id: 'pump-a',
    source_kind: 'simulator', source_id: SOURCE_ID, source_seq: eventSeq(t, 900), sim_time_ms: t, observed_unix_ms: unixMs(t),
    event_type: 'equipment_alarm', xid_code: null, severity: 'warning',
    message: 'pump-a low-flow alarm: pump power below nominal (simulated)',
    evidence: { operating_state: p.operating_state, pump_power_w: p.pump_power_w, nominal_pump_power_w: 3 * S.PUMP_POWER_W_PER_RACK, cooling_loop_id: 'loop-a', simulated: true },
  };
}

export const XID79_SIM_MS = 150_000; // 30 s after the pump-degraded snapshot: the Gate 3 overlap window
function xid79(): SignalEvent {
  const t = XID79_SIM_MS;
  return {
    schema_version: V, event_id: `sig.${t}.gpu-r3-n1-0.xid_error`, run_id: RUN_ID, resource_id: 'gpu-r3-n1-0',
    source_kind: 'simulator', source_id: SOURCE_ID, source_seq: eventSeq(t, 900), sim_time_ms: t, observed_unix_ms: unixMs(t),
    event_type: 'xid_error', xid_code: 79, severity: 'critical',
    message: 'Xid 79: GPU has fallen off the bus (simulated)',
    evidence: { xid_code: 79, gpu_id: 'gpu-r3-n1-0', node_id: nodeId(3), rack_id: rackId(3), dcgm_field: 'DCGM_FI_DEV_XID_ERROR', dcgm_field_id: 230, simulated: true },
  };
}

const signalsUpTo = (simMs: number): SignalEvent[] => (pumpADegraded(simMs) ? [pumpAlarm()] : []);

export function snapshotAt(simMs: number): ObservedSnapshot {
  const gpus = RACKS.flatMap((r) => GPU_SLOTS.map((k) => gpuCurrent(r, k, simMs)));
  const nodes: NodeCurrent[] = RACKS.map((r) => {
    const mine = gpus.filter((g) => g.node_id === nodeId(r));
    return {
      schema_version: V, run_id: RUN_ID, resource_id: nodeId(r), rack_id: rackId(r), availability: 'ready',
      power_headroom_w: mine.reduce((s, g) => s + (g.power_limit_w - g.power_w), 0),
      thermal_headroom_c: round1(S.SLOWDOWN_C - Math.max(...mine.map((g) => g.temp_c))),
      version: 0,
    };
  });
  const jobStates: JobState[] = JOBS.map((j) => ({
    schema_version: V, run_id: RUN_ID, job_id: j.job_id, status: 'running', allocated_gpu_ids: jobGpus(j),
    progress_work_units: jobProgressAt(j, simMs), durable_work_units: j.durable_work_units,
    latest_checkpoint_id: j.checkpointed ? checkpointId(j) : null, version: 0, last_update_sim_time_ms: simMs,
  }));
  const allocations: JobGpuAllocation[] = JOBS.flatMap((j) =>
    jobGpus(j).map((g) => ({ schema_version: V, run_id: RUN_ID, job_id: j.job_id, gpu_id: g, since_sim_time_ms: 0 })),
  );
  // Checkpoints taken before the run started: the schema forbids negative sim times, so they sit at t=0 and their
  // age is carried by progress − durable (e.g. job-a: 16 GPUs × 540 s = 8640 work units at risk).
  const checkpoints: Checkpoint[] = JOBS.filter((j) => j.checkpointed).map((j) => ({
    schema_version: V, run_id: RUN_ID, checkpoint_id: checkpointId(j), job_id: j.job_id, storage_resource_id: 'ckpt-store-1',
    status: 'complete', progress_work_units: j.durable_work_units, requested_sim_time_ms: 0, complete_sim_time_ms: 0,
    accessible: true, command_key: `preset.${PRESET_ID}.${checkpointId(j)}`,
  }));
  const epoch = pumpADegraded(simMs) ? 1 : 0;
  return {
    schema_version: V, run_id: RUN_ID,
    clock: { sim_time_ms: simMs, tick_index: simMs / S.STEP_MS, step_ms: S.STEP_MS, wall_tick_ms: S.WALL_TICK_MS, paused: false, decision_epoch: epoch },
    resources: resources(),
    dependencies: dependencies(),
    gpus,
    nodes,
    cooling: [pumpCurrent('pump-a', simMs), pumpCurrent('pump-b', simMs)],
    job_specs: jobSpecs(),
    job_states: jobStates,
    allocations,
    checkpoints,
    observation_event_ids: signalsUpTo(simMs).map((s) => s.event_id),
  };
}

function telemetryAt(simMs: number): TelemetryEvent[] {
  const snap = snapshotAt(simMs);
  const out: TelemetryEvent[] = [];
  const emit = (resource_id: string, metric: string, value: number, unit: string, extra: Record<string, string> = {}) => {
    out.push({
      schema_version: V, event_id: `tel.${simMs}.${resource_id}.${metric}`, run_id: RUN_ID, resource_id,
      source_kind: 'simulator', source_id: SOURCE_ID, source_seq: eventSeq(simMs, out.length),
      observed_unix_ms: unixMs(simMs), sim_time_ms: simMs, metric, value, unit, quality: 'estimated',
      labels: { simulated: 'true', hardware_backed: 'false', ...extra },
    });
  };
  for (const g of snap.gpus) {
    const labels = { profile: 'demo_gpu', node_id: g.node_id };
    emit(g.resource_id, 'DCGM_FI_DEV_GPU_TEMP_CELSIUS', g.temp_c, 'degC', labels);
    emit(g.resource_id, 'DCGM_FI_DEV_SM_CLOCK', g.sm_clock_mhz, 'MHz', labels);
    emit(g.resource_id, 'DCGM_FI_DEV_POWER_USAGE', g.power_w, 'W', labels);
    emit(g.resource_id, 'DCGM_FI_DEV_CLOCKS_EVENT_REASONS', g.clocks_event_reasons, 'ratio', labels);
  }
  for (const r of RACKS) emit(rackId(r), 'rack.inlet_temp_c', round1(rackInletC(r, simMs)), 'degC', { cooling_loop_id: loopOf(r) });
  for (const c of snap.cooling) emit(c.resource_id, 'pump.power_w', c.pump_power_w, 'W');
  return out;
}

export const PUMP_A_FAULT: FaultInjection = {
  schema_version: V, fault_id: 'fault-pump-a-degradation-1', run_id: RUN_ID, target_resource_id: 'pump-a',
  kind: 'cooling_pump_degradation', start_sim_time_ms: S.PUMP_A_FAULT_START_MS, duration_sim_ms: null,
  severity: S.PUMP_A_FAULT_SEVERITY, parameters: { capacity_factor: round1(1 - S.PUMP_A_FAULT_SEVERITY) }, seed_offset: 0,
};

/** The tick that applies the due pump-a fault (t = 9 s → 10 s): the fault applies first, then the world steps. */
function tickResultExample(): PhysicsTickResult {
  const t = S.PUMP_A_FAULT_START_MS;
  const world: PhysicsWorld = {
    schema_version: V, run_id: RUN_ID,
    observable: snapshotAt(t),
    active_faults_private: [PUMP_A_FAULT],
    hidden_physics_state_json: {
      fixture_note: 'P1-1 stand-in; P1-3/P1-4 define the real hidden state',
      rack_inlet_c: Object.fromEntries(RACKS.map((r) => [rackId(r), round1(rackInletC(r, t))])),
      loop_effective_capacity_w: { 'loop-a': loopCapacityW('loop-a', t), 'loop-b': loopCapacityW('loop-b', t) },
      loop_heat_w: { 'loop-a': loopHeatW('loop-a'), 'loop-b': loopHeatW('loop-b') },
    },
    rng_state: RNG_STATE,
  };
  return {
    schema_version: V, run_id: RUN_ID, world_after: world,
    telemetry: telemetryAt(t), signals: [pumpAlarm()], material_change: true,
    completed_command_keys: [], failed_command_keys: [],
  };
}

/** File name → payload. The contract type for each file is in FIXTURE_TYPES. */
export function buildGpuFixtures(): Record<string, unknown> {
  return {
    'observed_snapshot_demo.json': snapshotAt(0),
    'observed_snapshot_pump_degraded.json': snapshotAt(120_000),
    'tick_result_example.json': tickResultExample(),
    'signal_xid79.json': xid79(),
  };
}

export const FIXTURE_TYPES = {
  'observed_snapshot_demo.json': 'ObservedSnapshot',
  'observed_snapshot_pump_degraded.json': 'ObservedSnapshot',
  'tick_result_example.json': 'PhysicsTickResult',
  'signal_xid79.json': 'SignalEvent',
} as const;

export const serializeFixture = (payload: unknown) => `${JSON.stringify(payload, null, 2)}\n`;

export const GPU_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'gpu');

function main() {
  mkdirSync(GPU_FIXTURE_DIR, { recursive: true });
  for (const [name, payload] of Object.entries(buildGpuFixtures())) {
    writeFileSync(join(GPU_FIXTURE_DIR, name), serializeFixture(payload));
    console.log(`wrote fixtures/gpu/${name}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
