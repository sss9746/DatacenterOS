// STAND-IN for P1's `buildPreset` (P1-3), which isn't in @dcos/physics yet.
//
// It builds the `gpu_demo_8` world from P1's own fixture (`packages/physics/fixtures/gpu/
// observed_snapshot_demo.json` @ origin/lane/p1-sim 2e641cd, copied verbatim to
// ./preset/gpu_demo_8.observed.json). The fixture predates contracts v1.1.1, so it is patched here:
//   - §0.12 #2: run clock starts at 600000; job-a's checkpoint completes at 60000, job-b's at 540000.
//   - §0.11 #4: `gpu-real-0` sits on node `node-real-0` (kind node, profile brev_real, no rack).
//   - §0.11 #9: `cooling_current` has one row per loop as well as per pump.
//   - `gpu-real-0` gets a placeholder `gpu_current` row (availability `unreachable` until the first
//     nvidia-smi sample is ingested, P2-9), so the dashboard has 65 GPU rows from the start.
//
// DELETE this file once `buildPreset` is exported: run.ts switches to
// `import { buildPreset } from '@dcos/physics'` (same signature).
import type {
  CoolingCurrent,
  DependencyEdge,
  GpuCurrent,
  ObservedSnapshot,
  PhysicsWorld,
  ResourceSpec,
} from '@dcos/contracts';
import fixture from './preset/gpu_demo_8.observed.json' with { type: 'json' };

export const PRESET_IDS = ['gpu_demo_8'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

const RUN_START_MS = 600_000;
const CHECKPOINT_COMPLETE_MS: Record<string, number> = { 'job-a': 60_000, 'job-b': 540_000 };
const REAL_GPU = 'gpu-real-0';
const REAL_NODE = 'node-real-0';

export function buildPresetStandIn(presetId: PresetId, runId: string, seed: number): PhysicsWorld {
  if (presetId !== 'gpu_demo_8') throw new Error(`unknown preset ${String(presetId)}`);
  // Deep copy with every `run_id` rewritten to the requested run.
  const obs = JSON.parse(JSON.stringify(fixture), (k, v) => (k === 'run_id' ? runId : v)) as ObservedSnapshot;

  // §0.12 #2: clock + timestamps.
  obs.clock = { ...obs.clock, sim_time_ms: RUN_START_MS };
  for (const g of obs.gpus) g.last_seen_sim_ms = RUN_START_MS;
  for (const j of obs.job_states) j.last_update_sim_time_ms = RUN_START_MS;
  for (const a of obs.allocations) a.since_sim_time_ms = 0;
  for (const c of obs.checkpoints) {
    const complete = CHECKPOINT_COMPLETE_MS[c.job_id];
    if (complete === undefined) continue;
    c.complete_sim_time_ms = complete;
    const spec = obs.job_specs.find((s) => s.job_id === c.job_id);
    c.requested_sim_time_ms = complete - (spec?.checkpoint_duration_ms ?? 0);
  }

  // §0.11 #4: real GPU on its own node.
  if (!obs.resources.some((r) => r.resource_id === REAL_NODE)) {
    const node: ResourceSpec = {
      schema_version: '1.1.0',
      run_id: runId,
      resource_id: REAL_NODE,
      kind: 'node',
      parent_id: null,
      failure_domain_id: 'fd-brev',
      profile: 'brev_real',
      config: { allocatable: false, hardware_backed: true, gpu_count: 1 },
      enabled: true,
    };
    obs.resources.push(node);
  }
  const realGpu = obs.resources.find((r) => r.resource_id === REAL_GPU);
  if (realGpu) realGpu.parent_id = REAL_NODE;
  if (!obs.dependencies.some((d) => d.consumer_id === REAL_GPU)) {
    const edge: DependencyEdge = {
      schema_version: '1.1.0',
      run_id: runId,
      edge_id: `edge.${REAL_GPU}.hosted_on.${REAL_NODE}`,
      consumer_id: REAL_GPU,
      provider_id: REAL_NODE,
      relation: 'hosted_on',
      weight: 1,
    };
    obs.dependencies.push(edge);
  }
  if (!obs.gpus.some((g) => g.resource_id === REAL_GPU)) {
    const row: GpuCurrent = {
      schema_version: '1.1.0',
      run_id: runId,
      resource_id: REAL_GPU,
      node_id: REAL_NODE,
      availability: 'unreachable',
      temp_c: 0,
      sm_clock_mhz: 0,
      power_w: 0,
      power_limit_w: 0,
      clocks_event_reasons: 0,
      last_xid_code: null,
      last_seen_sim_ms: 0,
      version: 0,
    };
    obs.gpus.push(row);
  }

  // §0.11 #9: loop rows mirror their pump.
  for (const loop of obs.resources.filter((r) => r.kind === 'cooling_loop')) {
    if (obs.cooling.some((c) => c.resource_id === loop.resource_id)) continue;
    const pump = obs.cooling.find((c) => c.resource_id === loop.config['pump_id']);
    if (!pump) continue;
    const row: CoolingCurrent = { ...pump, resource_id: loop.resource_id };
    obs.cooling.push(row);
  }

  return {
    schema_version: '1.1.0',
    run_id: runId,
    observable: obs,
    active_faults_private: [],
    hidden_physics_state_json: { stand_in: 'p2 fixture world; no hidden physics until buildPreset lands' },
    rng_state: `seed:${seed}`,
  };
}
