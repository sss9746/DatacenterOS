// P3-owned fixture builders for the frozen `gpu_demo_8` preset (CONTRACTS §0.3, defaults §0.4).
// These are hand-modelled observed snapshots for agent tests, NOT physics output; once
// @dcos/physics exports buildPreset/toObserved, cross-check against it.
//
// Timeline used here (sim time):
//   t = 0          run start; job-a and job-b each have a complete checkpoint at t=0
//   t = 420 000    pump-a degrades (loop-a cools racks r2–r4)
//   t = 480 000    job-b writes another checkpoint
//   t = 540 000    "pump degraded" snapshot = 120 s after degradation;
//                  job-a's last checkpoint is 9 sim-min old, job-b's 1 sim-min old.

import type {
  Checkpoint,
  CoolingCurrent,
  DependencyEdge,
  GpuCurrent,
  JobGpuAllocation,
  JobSpec,
  JobState,
  NodeCurrent,
  ObservedSnapshot,
  ResourceSpec,
  SignalEvent,
} from '@dcos/contracts';

import { CLOCKS_EVENT_SW_THERMAL } from '../../src/ports.js';

export const RUN_ID = 'run-demo-1';
const V = '1.1.0' as const;

export const RACKS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export const GPUS_PER_NODE = 8;
export const rackId = (r: number) => `rack-r${r}`;
export const nodeId = (r: number) => `node-r${r}-n1`;
export const gpuId = (r: number, g: number) => `gpu-r${r}-n1-${g}`;
export const REAL_GPU_ID = 'gpu-real-0';
/** CONTRACTS §0.11 #4: gpu-real-0 sits on node `node-real-0` (kind node, brev_real, no rack, never allocatable). */
export const REAL_NODE_ID = 'node-real-0';
/** Alias kept for existing imports; equals REAL_NODE_ID since §0.11 #4. */
export const REAL_GPU_HOST_ID = REAL_NODE_ID;

export const PUMP_DEGRADED_AT_MS = 420_000;
export const PUMP_DEGRADED_SNAPSHOT_MS = 540_000;

/** §0.4 defaults. */
export const SM_CLOCK_NOMINAL_MHZ = 1980;
export const THROTTLE_TEMP_C = 85;
export const GPU_POWER_W = 700;
export const NODE_POWER_BUDGET_W = 6400;
/** DCGM clocks_event_reasons thermal-slowdown bit, 0x20 (CONTRACTS §0.11 #5); power cap is 0x04. */
export const THERMAL_THROTTLE_BIT = CLOCKS_EVENT_SW_THERMAL;

const loopFor = (r: number) => (r >= 2 && r <= 4 ? 'loop-a' : 'loop-b');

// ---------------------------------------------------------------------------
// Topology (identical in both snapshots)
// ---------------------------------------------------------------------------

function res(
  resource_id: string,
  kind: ResourceSpec['kind'],
  parent_id: string | null,
  failure_domain_id: string,
  profile = 'demo_gpu',
  config: Record<string, unknown> = {},
): ResourceSpec {
  return { schema_version: V, run_id: RUN_ID, resource_id, kind, parent_id, failure_domain_id, profile, config, enabled: true };
}

function buildResources(): ResourceSpec[] {
  const out: ResourceSpec[] = [
    res('power-main', 'power_domain', null, 'power-main', 'demo_facility'),
    res('pump-a', 'cooling_pump', null, 'loop-a', 'demo_facility'),
    res('pump-b', 'cooling_pump', null, 'loop-b', 'demo_facility'),
    res('loop-a', 'cooling_loop', null, 'loop-a', 'demo_facility', { cools_racks: ['rack-r2', 'rack-r3', 'rack-r4'] }),
    res('loop-b', 'cooling_loop', null, 'loop-b', 'demo_facility', {
      cools_racks: ['rack-r1', 'rack-r5', 'rack-r6', 'rack-r7', 'rack-r8'],
    }),
    res('ckpt-store-1', 'checkpoint_store', null, 'ckpt-store-1', 'demo_facility'),
  ];
  for (const r of RACKS) {
    out.push(res(rackId(r), 'rack', null, rackId(r), 'demo_facility'));
    out.push(res(nodeId(r), 'node', rackId(r), rackId(r), 'demo_gpu', { power_budget_w: NODE_POWER_BUDGET_W }));
    for (let g = 0; g < GPUS_PER_NODE; g++) {
      out.push(res(gpuId(r, g), 'gpu', nodeId(r), rackId(r), 'demo_gpu', { allocatable: true }));
    }
    out.push(res(`link-r${r}`, 'network_link', null, `link-r${r}`, 'demo_facility'));
  }
  out.push(res('fan-sensor-r3', 'fan_sensor', 'rack-r3', 'rack-r3', 'pico_fan'));
  out.push(res(REAL_NODE_ID, 'node', null, REAL_NODE_ID, 'brev_real', { allocatable: false, hardware_backed: true }));
  out.push(res(REAL_GPU_ID, 'gpu', REAL_NODE_ID, REAL_NODE_ID, 'brev_real', { allocatable: false, hardware_backed: true }));
  return out;
}

function buildDependencies(): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  const edge = (consumer_id: string, provider_id: string, relation: DependencyEdge['relation']) =>
    edges.push({
      schema_version: V,
      run_id: RUN_ID,
      edge_id: `edge-${consumer_id}--${provider_id}`,
      consumer_id,
      provider_id,
      relation,
      weight: 1,
    });
  edge('loop-a', 'pump-a', 'cooled_by');
  edge('loop-b', 'pump-b', 'cooled_by');
  for (const r of RACKS) {
    for (let g = 0; g < GPUS_PER_NODE; g++) edge(gpuId(r, g), nodeId(r), 'hosted_on');
    edge(nodeId(r), rackId(r), 'hosted_on');
    edge(rackId(r), loopFor(r), 'cooled_by');
    edge(rackId(r), 'power-main', 'powered_by');
    edge(rackId(r), `link-r${r}`, 'connected_via');
  }
  edge('rack-r3', 'fan-sensor-r3', 'monitored_by');
  for (const j of ['job-a', 'job-b', 'job-c']) edge(j, 'ckpt-store-1', 'checkpoint_uses');
  return edges;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const ALL_NODES = RACKS.map(nodeId) as [string, ...string[]];

function buildJobSpecs(): JobSpec[] {
  const base = {
    schema_version: V,
    run_id: RUN_ID,
    gpu_profile: 'demo_gpu',
    checkpoint_duration_ms: 30_000,
    restart_duration_ms: 120_000,
    checkpoint_interval_ms: 600_000,
    work_rate_per_gpu_per_sim_s: 1,
  };
  return [
    {
      ...base,
      job_id: 'job-a',
      gpus_required: 16,
      placement_policy: 'gang_multi_node',
      compatible_node_ids: ALL_NODES,
      priority: 80,
      preemptible: true,
      checkpoint_supported: true,
      checkpoint_storage_id: 'ckpt-store-1',
      total_work_units: 2_000_000,
    },
    {
      ...base,
      job_id: 'job-b',
      gpus_required: 8,
      placement_policy: 'same_node',
      compatible_node_ids: ALL_NODES,
      priority: 60,
      preemptible: true,
      checkpoint_supported: true,
      checkpoint_storage_id: 'ckpt-store-1',
      total_work_units: 1_000_000,
    },
    {
      ...base,
      job_id: 'job-c',
      gpus_required: 8,
      placement_policy: 'same_node',
      compatible_node_ids: ['node-r6-n1'],
      priority: 90,
      preemptible: false,
      checkpoint_supported: false,
      checkpoint_storage_id: null,
      checkpoint_interval_ms: 0,
      total_work_units: 1_000_000,
    },
  ];
}

const JOB_RACKS: Record<string, number[]> = { 'job-a': [2, 3], 'job-b': [4], 'job-c': [6] };
const jobGpus = (job: string) => JOB_RACKS[job]!.flatMap((r) => Array.from({ length: GPUS_PER_NODE }, (_, g) => gpuId(r, g)));

function buildAllocations(): JobGpuAllocation[] {
  return Object.keys(JOB_RACKS).flatMap((job_id) =>
    jobGpus(job_id).map((gpu_id) => ({ schema_version: V, run_id: RUN_ID, job_id, gpu_id, since_sim_time_ms: 0 })),
  );
}

function ckpt(job_id: string, n: number, atMs: number, progress: number): Checkpoint {
  return {
    schema_version: V,
    run_id: RUN_ID,
    checkpoint_id: `ckpt-${job_id}-${n}`,
    job_id,
    storage_resource_id: 'ckpt-store-1',
    status: 'complete',
    progress_work_units: progress,
    requested_sim_time_ms: atMs,
    complete_sim_time_ms: atMs,
    accessible: true,
    command_key: `seed:${job_id}:checkpoint:${n}`,
  };
}

/** Durable progress carried into the run (jobs started before t=0). */
const INITIAL_PROGRESS: Record<string, number> = { 'job-a': 400_000, 'job-b': 200_000, 'job-c': 300_000 };

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

interface GpuState {
  temp: number;
  power: number;
}

function gpuRow(id: string, node: string, s: GpuState, simMs: number, version: number): GpuCurrent {
  const throttled = s.temp >= THROTTLE_TEMP_C;
  return {
    schema_version: V,
    run_id: RUN_ID,
    resource_id: id,
    node_id: node,
    availability: throttled ? 'degraded' : 'ready',
    temp_c: s.temp,
    sm_clock_mhz: throttled ? Math.round(SM_CLOCK_NOMINAL_MHZ * 0.7) : SM_CLOCK_NOMINAL_MHZ,
    power_w: s.power,
    power_limit_w: GPU_POWER_W,
    clocks_event_reasons: throttled ? THERMAL_THROTTLE_BIT : 0,
    last_xid_code: null,
    last_seen_sim_ms: simMs,
    version,
  };
}

/** r2–r4 after pump-a degradation: 84–88 °C (most ≥ 85 and throttling). */
const DEGRADED_TEMPS = [84.2, 85.1, 86.0, 86.8, 87.5, 88.0, 85.6, 86.3];
/** r6 under non-preemptible job-c: ~82 °C, i.e. ~2 °C thermal headroom. */
const R6_TEMPS = [81.6, 82.0, 82.4, 82.9, 81.8, 82.2, 82.7, 83.0];
/** Everything else: ~70 °C (§0.4 healthy). */
const COOL_TEMPS = [69.4, 70.0, 70.3, 69.8, 70.6, 69.6, 70.1, 70.4];

function rackTemps(r: number, degraded: boolean): number[] {
  if (r === 6) return R6_TEMPS;
  if (degraded && r >= 2 && r <= 4) return DEGRADED_TEMPS.map((_, g) => DEGRADED_TEMPS[(g + r) % 8]!);
  return COOL_TEMPS;
}

const busyRacks = new Set([2, 3, 4, 6]);
const round1 = (n: number) => Math.round(n * 10) / 10;

function buildLive(degraded: boolean, simMs: number) {
  const gpus: GpuCurrent[] = [];
  const nodes: NodeCurrent[] = [];
  for (const r of RACKS) {
    const temps = rackTemps(r, degraded);
    const hot = degraded && r >= 2 && r <= 4;
    const power = busyRacks.has(r) ? GPU_POWER_W : 300;
    const version = hot ? 3 : 1;
    for (let g = 0; g < GPUS_PER_NODE; g++) {
      gpus.push(gpuRow(gpuId(r, g), nodeId(r), { temp: temps[g]!, power }, simMs, version));
    }
    const maxTemp = Math.max(...temps);
    nodes.push({
      schema_version: V,
      run_id: RUN_ID,
      resource_id: nodeId(r),
      rack_id: rackId(r),
      availability: hot ? 'degraded' : 'ready',
      power_headroom_w: NODE_POWER_BUDGET_W - power * GPUS_PER_NODE,
      thermal_headroom_c: round1(THROTTLE_TEMP_C - maxTemp),
      version: hot ? 3 : 1,
    });
  }
  // Real Brev GPU tile (F-NV2): present in gpu_current, never allocatable.
  gpus.push(gpuRow(REAL_GPU_ID, REAL_NODE_ID, { temp: 41.0, power: 62 }, simMs, 1));

  const cooling: CoolingCurrent[] = [
    {
      schema_version: V,
      run_id: RUN_ID,
      resource_id: 'pump-a',
      operating_state: degraded ? 'degraded' : 'normal',
      nominal_capacity_w: 60_000,
      pump_power_w: degraded ? 1_150 : 2_200,
      observed_capacity_estimate_w: degraded ? 31_000 : 60_000,
      version: degraded ? 2 : 1,
    },
    {
      schema_version: V,
      run_id: RUN_ID,
      resource_id: 'loop-a',
      operating_state: degraded ? 'degraded' : 'normal',
      nominal_capacity_w: 60_000,
      pump_power_w: 0,
      observed_capacity_estimate_w: degraded ? 31_000 : 60_000,
      version: degraded ? 2 : 1,
    },
    {
      schema_version: V,
      run_id: RUN_ID,
      resource_id: 'pump-b',
      operating_state: 'normal',
      nominal_capacity_w: 100_000,
      pump_power_w: 3_400,
      observed_capacity_estimate_w: 100_000,
      version: 1,
    },
    {
      schema_version: V,
      run_id: RUN_ID,
      resource_id: 'loop-b',
      operating_state: 'normal',
      nominal_capacity_w: 100_000,
      pump_power_w: 0,
      observed_capacity_estimate_w: 100_000,
      version: 1,
    },
  ];
  return { gpus, nodes, cooling };
}

/** Work done by `gpus` GPUs up to `atMs`; throttled GPUs (>= 85 C) run 30% slower after degradation. */
function progressAt(job: string, gpus: number, atMs: number, degraded: boolean, throttles: boolean): number {
  const slowS = degraded && throttles ? Math.max(0, atMs - PUMP_DEGRADED_AT_MS) / 1000 : 0;
  return Math.round(INITIAL_PROGRESS[job]! + gpus * (atMs / 1000 - slowS) + gpus * slowS * 0.7);
}

const JOB_B_SECOND_CKPT_MS = 480_000;

function buildJobStates(simMs: number, degraded: boolean): { states: JobState[]; checkpoints: Checkpoint[] } {
  const checkpoints: Checkpoint[] = [
    ckpt('job-a', 0, 0, INITIAL_PROGRESS['job-a']!),
    ckpt('job-b', 0, 0, INITIAL_PROGRESS['job-b']!),
  ];
  let jobB = { durable: INITIAL_PROGRESS['job-b']!, latest: 'ckpt-job-b-0', version: 1 };
  if (simMs >= JOB_B_SECOND_CKPT_MS) {
    const p = progressAt('job-b', 8, JOB_B_SECOND_CKPT_MS, degraded, true);
    checkpoints.push(ckpt('job-b', 1, JOB_B_SECOND_CKPT_MS, p));
    jobB = { durable: p, latest: 'ckpt-job-b-1', version: 3 };
  }
  const state = (job_id: string, durable: number, latest: string | null, prog: number, version: number): JobState => ({
    schema_version: V,
    run_id: RUN_ID,
    job_id,
    status: 'running',
    allocated_gpu_ids: jobGpus(job_id),
    progress_work_units: prog,
    durable_work_units: durable,
    latest_checkpoint_id: latest,
    version,
    last_update_sim_time_ms: simMs,
  });
  return {
    checkpoints,
    states: [
      state('job-a', INITIAL_PROGRESS['job-a']!, 'ckpt-job-a-0', progressAt('job-a', 16, simMs, degraded, true), degraded ? 2 : 1),
      state('job-b', jobB.durable, jobB.latest, progressAt('job-b', 8, simMs, degraded, true), jobB.version),
      // job-c is non-checkpointable: no durable progress is tracked in-run.
      state('job-c', 0, null, progressAt('job-c', 8, simMs, degraded, false), 1),
    ],
  };
}

function snapshot(simMs: number, degraded: boolean, decisionEpoch: number, eventIds: string[]): ObservedSnapshot {
  const live = buildLive(degraded, simMs);
  const jobs = buildJobStates(simMs, degraded);
  return {
    schema_version: V,
    run_id: RUN_ID,
    clock: {
      sim_time_ms: simMs,
      tick_index: simMs / 1000,
      step_ms: 1000,
      wall_tick_ms: 1000,
      paused: false,
      decision_epoch: decisionEpoch,
    },
    resources: buildResources(),
    dependencies: buildDependencies(),
    gpus: live.gpus,
    nodes: live.nodes,
    cooling: live.cooling,
    job_specs: buildJobSpecs(),
    job_states: jobs.states,
    allocations: buildAllocations(),
    checkpoints: jobs.checkpoints,
    observation_event_ids: eventIds,
  };
}

/** gpu_demo_8 at t=0. */
export function buildDemoSnapshot(): ObservedSnapshot {
  return snapshot(0, false, 0, []);
}

/** gpu_demo_8 at t=540 000 ms, 120 s after pump-a degraded. */
export function buildPumpDegradedSnapshot(): ObservedSnapshot {
  return snapshot(PUMP_DEGRADED_SNAPSHOT_MS, true, 2, ['sig-pump-a-alarm-1', 'sig-loop-a-alarm-1']);
}

/** XID 79 ("GPU has fallen off the bus") on one GPU, as a SignalEvent. */
export function buildXid79Signal(gpu: string, simMs: number, seq: number): SignalEvent {
  return {
    schema_version: V,
    event_id: `sig-xid79-${gpu}-${simMs}`,
    run_id: RUN_ID,
    resource_id: gpu,
    source_kind: 'simulator',
    source_id: 'sim-engine-1',
    source_seq: seq,
    sim_time_ms: simMs,
    observed_unix_ms: 1_794_091_200_000 + simMs,
    event_type: 'xid_error',
    xid_code: 79,
    severity: 'critical',
    message: `XID 79: GPU has fallen off the bus (${gpu})`,
    evidence: { xid_code: 79, gpu_id: gpu, node_id: gpu.replace(/-\d+$/, '') },
  };
}

/** Independent XID 79 on an idle GPU on rack-r7 (no shared provider with the cooling incident). */
export const buildSignalXid79R7 = () => buildXid79Signal('gpu-r7-n1-3', 560_000, 9001);
/** XID 79 on gpu-r8-n1-0, a likely job-a migration destination, mid-checkpoint. */
export const buildSignalXid79Dest = () => buildXid79Signal('gpu-r8-n1-0', 555_000, 9000);

/** Committed JSON file basename -> builder (make-fixtures.ts writes `<name>.json`). */
export const FIXTURE_BUILDERS = {
  observed_snapshot_demo: buildDemoSnapshot,
  observed_snapshot_pump_degraded: buildPumpDegradedSnapshot,
  signal_xid79_r7: buildSignalXid79R7,
  signal_xid79_dest: buildSignalXid79Dest,
} as const;
export type FixtureName = keyof typeof FIXTURE_BUILDERS;
