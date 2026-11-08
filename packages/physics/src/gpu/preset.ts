// buildPreset('gpu_demo_8', runId, seed): the CONTRACTS §0.3 demo world at the run start (RUN_START_SIM_MS = 600 000,
// CONTRACTS §0.12 #2; tick_index 0).
// IDs are frozen (§0.3); numbers come from ./constants.ts (all simulated). The construction order matches the
// P1-1 fixture generator so toObserved(buildPreset('gpu_demo_8', 'run-demo-1', 1)) equals
// fixtures/gpu/observed_snapshot_demo.json.
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
  PhysicsWorld,
  ResourceSpec,
} from '@dcos/contracts';
import {
  CHECKPOINT_DURATION_MS,
  CHECKPOINT_INTERVAL_MS,
  CHECKPOINT_STORE_ID,
  GPU_MODEL_VERSION,
  GPU_PROFILE,
  GPU_SLOTS,
  GPU_TEMP_SPREAD_C,
  LOOP_A_RACKS,
  LOOP_SUPPLY_C,
  POWER_DOMAIN_ID,
  POWER_LIMIT_W,
  PRESET_ID,
  PUMP_CAPACITY_W_PER_RACK,
  PUMP_POWER_W_PER_RACK,
  R6_INLET_OFFSET_C,
  RACK_NUMBERS,
  RACK_THERMAL_MASS_KJ_PER_C,
  RESTART_DURATION_MS,
  RUN_START_SIM_MS,
  SHUTDOWN_C,
  SLOWDOWN_C,
  SM_CLOCK_NOMINAL_MHZ,
  STEP_MS,
  WALL_TICK_MS,
  WIRE_SCHEMA_VERSION as V,
  WORK_RATE_PER_GPU_PER_SIM_S,
  gpuId,
  linkId,
  nodeId,
  rackId,
} from './constants.js';
import { rngFromSeed } from './rng.js';
import {
  buildTopology,
  deriveCooling,
  deriveGpus,
  deriveNodes,
  faultConditions,
  gpuJobMap,
  type HiddenState,
} from './world.js';

export type PresetId = typeof PRESET_ID;

interface JobDef {
  job_id: string;
  racks: number[];
  placement_policy: JobSpec['placement_policy'];
  preemptible: boolean;
  checkpointed: boolean;
  priority: number;
  total_work_units: number;
  /** durable work at the run start (the last checkpoint's progress) */
  durable_work_units: number;
  /** "last checkpoint N sim-min ago" at the run start, seconds (its completion time = start − age); null = none */
  checkpoint_age_s: number | null;
  /** progress at the run start for a job with no checkpoint */
  progress_at_t0?: number;
}

/** §0.3 jobs at start (simulated work sizes). */
const DEMO_JOBS: readonly JobDef[] = [
  { job_id: 'job-a', racks: [2, 3], placement_policy: 'gang_multi_node', preemptible: true, checkpointed: true,
    priority: 50, total_work_units: 200_000, durable_work_units: 86_400, checkpoint_age_s: 9 * 60 },
  { job_id: 'job-b', racks: [4], placement_policy: 'same_node', preemptible: true, checkpointed: true,
    priority: 50, total_work_units: 60_000, durable_work_units: 40_000, checkpoint_age_s: 60 },
  { job_id: 'job-c', racks: [6], placement_policy: 'same_node', preemptible: false, checkpointed: false,
    priority: 90, total_work_units: 100_000, durable_work_units: 0, checkpoint_age_s: null, progress_at_t0: 30_000 },
];

const loopOf = (r: number) => (LOOP_A_RACKS.includes(r) ? 'loop-a' : 'loop-b');
const pumpOfLoop = (loop: string) => (loop === 'loop-a' ? 'pump-a' : 'pump-b');
const racksOnLoop = (loop: string) => RACK_NUMBERS.filter((r) => loopOf(r) === loop);
const jobGpus = (j: JobDef) => j.racks.flatMap((r) => GPU_SLOTS.map((k) => gpuId(r, k)));
const checkpointId = (jobId: string, n: number) => `ckpt-${jobId}-${n}`;

function resources(runId: string): ResourceSpec[] {
  const res = (
    resource_id: string, kind: ResourceSpec['kind'], parent_id: string | null, failure_domain_id: string,
    profile: string, config: Record<string, unknown>,
  ): ResourceSpec => ({ schema_version: V, run_id: runId, resource_id, kind, parent_id, failure_domain_id, profile, config, enabled: true });

  const out: ResourceSpec[] = [
    res(POWER_DOMAIN_ID, 'power_domain', null, 'fd-power-main', 'sim_power', { simulated: true }),
    ...(['pump-a', 'pump-b'] as const).map((p) => {
      const n = racksOnLoop(p === 'pump-a' ? 'loop-a' : 'loop-b').length;
      return res(p, 'cooling_pump', null, `fd-${p}`, 'sim_pump', {
        nominal_capacity_w: n * PUMP_CAPACITY_W_PER_RACK, nominal_pump_power_w: n * PUMP_POWER_W_PER_RACK, simulated: true,
      });
    }),
    ...(['loop-a', 'loop-b'] as const).map((l) =>
      res(l, 'cooling_loop', null, `fd-${pumpOfLoop(l)}`, 'sim_loop', {
        pump_id: pumpOfLoop(l), rack_ids: racksOnLoop(l).map(rackId), supply_temp_c: LOOP_SUPPLY_C, simulated: true,
      }),
    ),
    res(CHECKPOINT_STORE_ID, 'checkpoint_store', null, 'fd-storage', 'sim_storage', { simulated: true }),
  ];
  for (const r of RACK_NUMBERS) {
    out.push(res(rackId(r), 'rack', null, `fd-${rackId(r)}`, 'sim_rack', {
      cooling_loop_id: loopOf(r), power_domain_id: POWER_DOMAIN_ID, inlet_offset_c: r === 6 ? R6_INLET_OFFSET_C : 0,
      thermal_mass_kj_per_c: RACK_THERMAL_MASS_KJ_PER_C, simulated: true,
    }));
    out.push(res(nodeId(r), 'node', rackId(r), `fd-${rackId(r)}`, 'sim_node_8gpu', { gpu_count: GPU_SLOTS.length, simulated: true }));
    for (const k of GPU_SLOTS) {
      out.push(res(gpuId(r, k), 'gpu', nodeId(r), `fd-${rackId(r)}`, GPU_PROFILE, {
        index: k, power_limit_w: POWER_LIMIT_W, sm_clock_nominal_mhz: SM_CLOCK_NOMINAL_MHZ,
        slowdown_temp_c: SLOWDOWN_C, shutdown_temp_c: SHUTDOWN_C, allocatable: true, simulated: true,
      }));
    }
    out.push(res(linkId(r), 'network_link', rackId(r), `fd-${rackId(r)}`, 'sim_link', { tier: 2, simulated: true }));
  }
  out.push(res('fan-sensor-r3', 'fan_sensor', rackId(3), `fd-${rackId(3)}`, 'pico2w_microphone', {
    hardware_sensor_id: 'pico-fan-r3', hardware_backed: true,
  }));
  // The real Brev GPU (F-NV2): a resource row only; its gpu_current row comes from nvidia-smi ingest. Never allocatable.
  out.push(res('gpu-real-0', 'gpu', null, 'fd-brev', 'brev_real', { allocatable: false, hardware_backed: true }));
  return out;
}

function dependencies(runId: string): DependencyEdge[] {
  const edge = (consumer_id: string, relation: DependencyEdge['relation'], provider_id: string): DependencyEdge => ({
    schema_version: V, run_id: runId, edge_id: `edge.${consumer_id}.${relation}.${provider_id}`, consumer_id, provider_id, relation, weight: 1,
  });
  const out: DependencyEdge[] = [];
  for (const r of RACK_NUMBERS) {
    for (const k of GPU_SLOTS) out.push(edge(gpuId(r, k), 'hosted_on', nodeId(r)));
    out.push(edge(nodeId(r), 'hosted_on', rackId(r)));
    out.push(edge(rackId(r), 'cooled_by', loopOf(r)));
    out.push(edge(rackId(r), 'powered_by', POWER_DOMAIN_ID));
    out.push(edge(nodeId(r), 'connected_via', linkId(r)));
  }
  out.push(edge('loop-a', 'cooled_by', 'pump-a'), edge('loop-b', 'cooled_by', 'pump-b'));
  out.push(edge(rackId(3), 'monitored_by', 'fan-sensor-r3'));
  for (const j of DEMO_JOBS) if (j.checkpointed) out.push(edge(j.job_id, 'checkpoint_uses', CHECKPOINT_STORE_ID));
  return out;
}

function jobSpecs(runId: string): JobSpec[] {
  return DEMO_JOBS.map((j) => ({
    schema_version: V, run_id: runId, job_id: j.job_id,
    gpus_required: jobGpus(j).length,
    placement_policy: j.placement_policy,
    compatible_node_ids: (j.preemptible ? RACK_NUMBERS.map(nodeId) : j.racks.map(nodeId)) as JobSpec['compatible_node_ids'],
    gpu_profile: GPU_PROFILE,
    priority: j.priority,
    preemptible: j.preemptible,
    checkpoint_supported: j.checkpointed,
    checkpoint_storage_id: j.checkpointed ? CHECKPOINT_STORE_ID : null,
    checkpoint_duration_ms: j.checkpointed ? CHECKPOINT_DURATION_MS : 0,
    restart_duration_ms: RESTART_DURATION_MS,
    checkpoint_interval_ms: j.checkpointed ? CHECKPOINT_INTERVAL_MS : 0,
    total_work_units: j.total_work_units,
    work_rate_per_gpu_per_sim_s: WORK_RATE_PER_GPU_PER_SIM_S,
  }));
}

/** Progress at the run start: the checkpoint's durable work plus the work done since it completed (nominal rate). */
function progressAtT0(j: JobDef): number {
  const rate = jobGpus(j).length * WORK_RATE_PER_GPU_PER_SIM_S;
  return j.checkpoint_age_s === null ? (j.progress_at_t0 ?? 0) : j.durable_work_units + rate * j.checkpoint_age_s;
}

/**
 * Build the §0.3 demo world at the run start (sim_time_ms = RUN_START_SIM_MS, tick_index 0). Deterministic in (runId, seed): the seed drives the per-GPU temperature spread
 * (mulberry32, 64 draws in rack-major order) and the remaining generator state is PhysicsWorld.rng_state.
 */
export function buildPreset(presetId: PresetId, runId: string, seed: number): PhysicsWorld {
  if (presetId !== PRESET_ID) throw new Error(`physics: unknown preset ${String(presetId)}`);

  const rng = rngFromSeed(seed);
  const gpuOffset: Record<string, number> = {};
  for (const r of RACK_NUMBERS) for (const k of GPU_SLOTS) gpuOffset[gpuId(r, k)] = (rng.next() - 0.5) * GPU_TEMP_SPREAD_C;

  const jobStates: JobState[] = DEMO_JOBS.map((j) => ({
    schema_version: V, run_id: runId, job_id: j.job_id, status: 'running', allocated_gpu_ids: jobGpus(j),
    progress_work_units: progressAtT0(j), durable_work_units: j.durable_work_units,
    latest_checkpoint_id: j.checkpointed ? checkpointId(j.job_id, 1) : null, version: 0, last_update_sim_time_ms: RUN_START_SIM_MS,
  }));
  const allocations: JobGpuAllocation[] = DEMO_JOBS.flatMap((j) =>
    jobGpus(j).map((g) => ({ schema_version: V, run_id: runId, job_id: j.job_id, gpu_id: g, since_sim_time_ms: 0 })),
  );
  // Allocations predate the run: the jobs were placed at sim time 0.
  // Pre-run checkpoints (CONTRACTS §0.12 #2): completed checkpoint_age_s before the run start and requested
  // CHECKPOINT_DURATION_MS before that, so job-a's completed at 60 000 (9 min old) and job-b's at 540 000 (1 min old).
  // Age = clock.sim_time_ms − complete_sim_time_ms, always.
  const checkpoints: Checkpoint[] = DEMO_JOBS.filter((j) => j.checkpointed).map((j) => {
    const complete = RUN_START_SIM_MS - (j.checkpoint_age_s ?? 0) * 1000;
    return {
      schema_version: V, run_id: runId, checkpoint_id: checkpointId(j.job_id, 1), job_id: j.job_id,
      storage_resource_id: CHECKPOINT_STORE_ID, status: 'complete', progress_work_units: j.durable_work_units,
      requested_sim_time_ms: complete - CHECKPOINT_DURATION_MS, complete_sim_time_ms: complete, accessible: true,
      command_key: `preset.${PRESET_ID}.${checkpointId(j.job_id, 1)}`,
    };
  });

  const gpuSeeds: GpuCurrent[] = RACK_NUMBERS.flatMap((r) => GPU_SLOTS.map((k) => ({
    schema_version: V, run_id: runId, resource_id: gpuId(r, k), node_id: nodeId(r), availability: 'ready' as const,
    temp_c: 0, sm_clock_mhz: SM_CLOCK_NOMINAL_MHZ, power_w: 0, power_limit_w: POWER_LIMIT_W, clocks_event_reasons: 0,
    last_xid_code: null, last_seen_sim_ms: 0, version: 0,
  })));
  const nodeSeeds: NodeCurrent[] = RACK_NUMBERS.map((r) => ({
    schema_version: V, run_id: runId, resource_id: nodeId(r), rack_id: rackId(r), availability: 'ready' as const,
    power_headroom_w: 0, thermal_headroom_c: 0, version: 0,
  }));
  const coolingSeeds: CoolingCurrent[] = (['pump-a', 'pump-b'] as const).map((p) => {
    const n = racksOnLoop(p === 'pump-a' ? 'loop-a' : 'loop-b').length;
    return {
      schema_version: V, run_id: runId, resource_id: p, operating_state: 'normal' as const,
      nominal_capacity_w: n * PUMP_CAPACITY_W_PER_RACK, pump_power_w: n * PUMP_POWER_W_PER_RACK,
      observed_capacity_estimate_w: n * PUMP_CAPACITY_W_PER_RACK, version: 0,
    };
  });

  const hidden: HiddenState = {
    model: GPU_MODEL_VERSION,
    preset_id: PRESET_ID,
    seed,
    loop_temp_c: { 'loop-a': LOOP_SUPPLY_C, 'loop-b': LOOP_SUPPLY_C },
    gpu_offset_c: gpuOffset,
    gpu_failure: {},
    gpu_cordoned: [],
    checkpoint_counter: Object.fromEntries(DEMO_JOBS.map((j) => [j.job_id, j.checkpointed ? 2 : 1])),
    command_inbox: [],
    in_flight: [],
    finished_command_keys: [],
    command_outcomes: {},
    stale_values: {},
  };

  const res = resources(runId);
  const topo = buildTopology(res, gpuSeeds);
  const cond = faultConditions([], topo);
  const jobsByGpu = gpuJobMap(jobStates);
  const gpus = deriveGpus(gpuSeeds, jobsByGpu, hidden, topo, cond, RUN_START_SIM_MS).gpus.map((g) => ({ ...g, version: 0 }));
  const nodes = deriveNodes(nodeSeeds, gpus, hidden, topo).map((n) => ({ ...n, version: 0 }));
  const cooling = deriveCooling(coolingSeeds, topo, cond).map((c) => ({ ...c, version: 0 }));

  const observable: ObservedSnapshot = {
    schema_version: V, run_id: runId,
    clock: { sim_time_ms: RUN_START_SIM_MS, tick_index: 0, step_ms: STEP_MS, wall_tick_ms: WALL_TICK_MS, paused: false, decision_epoch: 0 },
    resources: res,
    dependencies: dependencies(runId),
    gpus,
    nodes,
    cooling,
    job_specs: jobSpecs(runId),
    job_states: jobStates,
    allocations,
    checkpoints,
    observation_event_ids: [],
  };

  return {
    schema_version: V,
    run_id: runId,
    observable,
    active_faults_private: [],
    hidden_physics_state_json: hidden as unknown as Record<string, unknown>,
    rng_state: rng.state(),
  };
}
