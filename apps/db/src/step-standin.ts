// STAND-IN for P1's GPU `step()` (P1-4), which isn't in @dcos/physics yet. Same signature:
// `(SimulationTickInput) => PhysicsTickResult`, pure, deterministic.
//
// It only does what the contracts pin down exactly, so P3/P4 can build against live rows:
//   - advances the clock by `step_ms` and `tick_index` by 1
//   - moves due faults into `active_faults_private`, drops expired ones (`material_change` = true)
//   - XID faults (§0.12 #8): 79 → GPU `unreachable`, 48/74 → `degraded`; `last_xid_code`, version+1;
//     an `xid_error` SignalEvent; XID 79 fails the job on that GPU and rolls progress back to
//     `durable_work_units` (Gate 1)
//   - one DCGM_FI_DEV_GPU_TEMP_CELSIUS sample per simulated GPU (exercises telemetry retention)
// It does NOT model heat, cooling, throttling, job progress or pump faults: those wait for P1.
//
// DELETE this file once `step` (GPU) is exported: tick.ts switches to
// `import { step } from '@dcos/physics'`.
import type {
  FaultInjection,
  ObservedSnapshot,
  PhysicsTickResult,
  PhysicsWorld,
  SignalEvent,
  SimulationTickInput,
  TelemetryEvent,
} from '@dcos/contracts';

const SOURCE_ID = 'sim-engine-1';
const XID: Partial<Record<FaultInjection['kind'], 48 | 79 | 74>> = {
  gpu_xid_48: 48,
  gpu_xid_79: 79,
  gpu_xid_74: 74,
};

/** Returns null (no observable change) when the GPU is missing or already in an equal/worse state. */
function applyXid(
  obs: ObservedSnapshot,
  gpuId: string,
  code: 48 | 79 | 74,
  simMs: number,
  seq: number
): SignalEvent | null {
  const gpu = obs.gpus.find((g) => g.resource_id === gpuId);
  if (!gpu) return null;
  const next = code === 79 ? 'unreachable' : 'degraded';
  // Never downgrade: unreachable beats degraded, so fault order can't change the outcome.
  if (gpu.availability === 'unreachable' || (gpu.availability === next && gpu.last_xid_code === code)) return null;
  gpu.availability = next;
  gpu.last_xid_code = code;
  gpu.version += 1;
  if (code === 79) {
    for (const job of obs.job_states.filter((j) => j.allocated_gpu_ids.includes(gpuId))) {
      job.status = 'failed';
      job.progress_work_units = job.durable_work_units;
      job.last_update_sim_time_ms = simMs;
      job.version += 1;
    }
  }
  return {
    schema_version: '1.1.0',
    // Derived from public facts only; never from the private fault_id.
    event_id: `sig-${obs.run_id}-${obs.clock.tick_index}-${gpuId}-xid${code}`,
    run_id: obs.run_id,
    resource_id: gpuId,
    source_kind: 'simulator',
    source_id: SOURCE_ID,
    source_seq: seq,
    sim_time_ms: simMs,
    observed_unix_ms: 0, // filled in by the DB tick
    event_type: 'xid_error',
    xid_code: code,
    severity: code === 79 ? 'critical' : 'warning',
    message: `Xid ${code} on ${gpuId}${code === 79 ? ': GPU has fallen off the bus' : ''}`,
    evidence: { node_id: gpu.node_id },
  };
}

export function stepStandIn(input: SimulationTickInput): PhysicsTickResult {
  const world = JSON.parse(JSON.stringify(input.world)) as PhysicsWorld;
  const obs = world.observable;
  const simMs = obs.clock.sim_time_ms + input.step_ms;
  obs.clock.sim_time_ms = simMs;
  obs.clock.tick_index += 1;

  // One sim-engine source: source_seq strictly increases across ticks and events (≤ 1000 per tick).
  let seq = obs.clock.tick_index * 1000;
  const signals: SignalEvent[] = [];
  // material_change only for OBSERVABLE changes: a fault that hasn't shown anything yet must not
  // bump the public decision_epoch, or the epoch would leak private injection timing.
  let material = false;
  for (const f of input.due_faults_private) {
    world.active_faults_private.push(f);
    const code = XID[f.kind];
    if (code) {
      const sig = applyXid(obs, f.target_resource_id, code, simMs, ++seq);
      if (sig) {
        signals.push(sig);
        material = true;
      }
    }
  }
  world.active_faults_private = world.active_faults_private.filter(
    (f) => f.duration_sim_ms === null || f.start_sim_time_ms + f.duration_sim_ms > simMs
  );

  const real = new Set(obs.resources.filter((r) => r.profile === 'brev_real').map((r) => r.resource_id));
  const telemetry: TelemetryEvent[] = [];
  for (const g of obs.gpus) {
    if (real.has(g.resource_id)) continue; // real GPU rows come from nvidia-smi ingest (P2-9)
    if (g.availability !== 'unreachable') g.last_seen_sim_ms = simMs;
    telemetry.push({
      schema_version: '1.1.0',
      event_id: `tel-${obs.run_id}-${obs.clock.tick_index}-${g.resource_id}-temp`,
      run_id: obs.run_id,
      resource_id: g.resource_id,
      source_kind: 'simulator',
      source_id: SOURCE_ID,
      source_seq: ++seq,
      observed_unix_ms: 0, // filled in by the DB tick
      sim_time_ms: simMs,
      metric: 'DCGM_FI_DEV_GPU_TEMP_CELSIUS',
      value: g.temp_c,
      unit: 'degC',
      quality: g.availability === 'unreachable' ? 'missing' : 'estimated',
      labels: { profile: 'demo_gpu', hardware_backed: 'false' },
    });
  }

  return {
    schema_version: '1.1.0',
    run_id: world.run_id,
    world_after: world,
    telemetry,
    signals,
    material_change: material,
    completed_command_keys: [],
    failed_command_keys: [],
  };
}
