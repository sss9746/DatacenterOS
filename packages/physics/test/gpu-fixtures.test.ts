// P1-1: every GPU fixture validates against @dcos/contracts and matches the frozen §0.3 IDs.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validatePayload,
  type ObservedSnapshot,
  type PhysicsTickResult,
  type SignalEvent,
} from '../../contracts/src/index.js';
import { FIXTURE_TYPES, GPU_FIXTURE_DIR, buildGpuFixtures, serializeFixture } from '../scripts/make-gpu-fixtures.js';

const read = <T>(name: string): T => JSON.parse(readFileSync(join(GPU_FIXTURE_DIR, name), 'utf8')) as T;
const demo = read<ObservedSnapshot>('observed_snapshot_demo.json');
const degraded = read<ObservedSnapshot>('observed_snapshot_pump_degraded.json');
const tick = read<PhysicsTickResult>('tick_result_example.json');
const xid = read<SignalEvent>('signal_xid79.json');

const RACKS = [1, 2, 3, 4, 5, 6, 7, 8];
const SLOTS = [0, 1, 2, 3, 4, 5, 6, 7];
const ALL_GPU_IDS = RACKS.flatMap((r) => SLOTS.map((k) => `gpu-r${r}-n1-${k}`));
const gpusOn = (...racks: number[]) => racks.flatMap((r) => SLOTS.map((k) => `gpu-r${r}-n1-${k}`));
const PRIVATE_KEYS = ['active_faults_private', 'hidden_physics_state_json', 'due_faults_private'];
const METRICS_05 = new Set([
  'DCGM_FI_DEV_GPU_TEMP_CELSIUS', 'DCGM_FI_DEV_SM_CLOCK', 'DCGM_FI_DEV_POWER_USAGE', 'DCGM_FI_DEV_CLOCKS_EVENT_REASONS',
  'rack.inlet_temp_c', 'pump.power_w',
]);

function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); allKeys(x, out); }
  return out;
}

describe('GPU fixtures: files and validation', () => {
  it('fixtures/gpu holds exactly the four P1-1 files (plus README)', () => {
    const files = readdirSync(GPU_FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort();
    expect(files).toEqual(Object.keys(FIXTURE_TYPES).sort());
  });

  for (const [name, typeName] of Object.entries(FIXTURE_TYPES)) {
    it(`${name} validates as ${typeName}`, () => {
      expect(validatePayload(typeName, read(name))).toEqual({ ok: true });
    });
  }

  it('the PhysicsWorld inside the tick result validates on its own', () => {
    expect(validatePayload('PhysicsWorld', tick.world_after)).toEqual({ ok: true });
    expect(validatePayload('ObservedSnapshot', tick.world_after.observable)).toEqual({ ok: true });
  });

  it('files on disk are exactly what the generator produces (no hand edits, deterministic)', () => {
    const a = buildGpuFixtures();
    const b = buildGpuFixtures();
    for (const [name, payload] of Object.entries(a)) {
      expect(serializeFixture(payload)).toBe(serializeFixture(b[name]));
      expect(readFileSync(join(GPU_FIXTURE_DIR, name), 'utf8')).toBe(serializeFixture(payload));
    }
  });
});

describe('GPU fixtures: §0.3 IDs and topology', () => {
  const ids = new Set(demo.resources.map((r) => r.resource_id));
  const kindOf = new Map(demo.resources.map((r) => [r.resource_id, r.kind]));

  it('has the frozen resource IDs', () => {
    for (const r of RACKS) {
      for (const id of [`rack-r${r}`, `node-r${r}-n1`, `link-r${r}`]) expect(ids.has(id), id).toBe(true);
    }
    for (const id of ALL_GPU_IDS) expect(kindOf.get(id), id).toBe('gpu');
    for (const id of ['pump-a', 'pump-b', 'loop-a', 'loop-b', 'power-main', 'ckpt-store-1', 'fan-sensor-r3', 'gpu-real-0']) {
      expect(ids.has(id), id).toBe(true);
    }
    expect(demo.run_id).toBe('run-demo-1');
    expect(ids.size).toBe(demo.resources.length);
  });

  it('has 64 simulated GPUs in gpu_current; gpu-real-0 is brev_real and not allocatable', () => {
    expect(demo.gpus.map((g) => g.resource_id).sort()).toEqual([...ALL_GPU_IDS].sort());
    const real = demo.resources.find((r) => r.resource_id === 'gpu-real-0');
    expect(real?.profile).toBe('brev_real');
    expect(real?.config.allocatable).toBe(false);
    expect(demo.allocations.some((a) => a.gpu_id === 'gpu-real-0')).toBe(false);
  });

  it('dependency edges go consumer → provider with the §0.3 cooling split', () => {
    const edge = (c: string, p: string) => demo.dependencies.some((e) => e.consumer_id === c && e.provider_id === p);
    for (const r of RACKS) {
      const loop = [2, 3, 4].includes(r) ? 'loop-a' : 'loop-b';
      expect(edge(`rack-r${r}`, loop), `rack-r${r} → ${loop}`).toBe(true);
      expect(edge(`rack-r${r}`, 'power-main')).toBe(true);
      expect(edge(`node-r${r}-n1`, `rack-r${r}`)).toBe(true);
      for (const k of SLOTS) expect(edge(`gpu-r${r}-n1-${k}`, `node-r${r}-n1`)).toBe(true);
    }
    expect(edge('loop-a', 'pump-a')).toBe(true);
    expect(edge('loop-b', 'pump-b')).toBe(true);
    expect(edge('job-a', 'ckpt-store-1')).toBe(true);
    expect(edge('job-b', 'ckpt-store-1')).toBe(true);
    expect(new Set(demo.dependencies.map((e) => e.edge_id)).size).toBe(demo.dependencies.length);
  });

  it('jobs are placed as in §0.3 with no double allocation', () => {
    const state = new Map(demo.job_states.map((j) => [j.job_id, j]));
    const spec = new Map(demo.job_specs.map((j) => [j.job_id, j]));
    expect(state.get('job-a')?.allocated_gpu_ids.sort()).toEqual(gpusOn(2, 3).sort());
    expect(state.get('job-b')?.allocated_gpu_ids.sort()).toEqual(gpusOn(4).sort());
    expect(state.get('job-c')?.allocated_gpu_ids.sort()).toEqual(gpusOn(6).sort());
    expect(spec.get('job-a')).toMatchObject({ gpus_required: 16, preemptible: true, checkpoint_supported: true });
    expect(spec.get('job-b')).toMatchObject({ gpus_required: 8, preemptible: true, checkpoint_supported: true });
    expect(spec.get('job-c')).toMatchObject({ gpus_required: 8, preemptible: false, checkpoint_supported: false });
    expect(state.get('job-c')?.latest_checkpoint_id).toBeNull();

    const gpuIds = demo.allocations.map((a) => a.gpu_id);
    expect(new Set(gpuIds).size).toBe(gpuIds.length);
    for (const j of demo.job_states) {
      expect(demo.allocations.filter((a) => a.job_id === j.job_id).map((a) => a.gpu_id).sort()).toEqual([...j.allocated_gpu_ids].sort());
    }
    // r1, r5, r7, r8 are free capacity
    for (const g of gpusOn(1, 5, 7, 8)) expect(gpuIds.includes(g)).toBe(false);
  });

  it('checkpoint ages match §0.3 (job-a ≈ 9 sim-min of work at risk, job-b ≈ 1 sim-min)', () => {
    const at = (id: string) => demo.job_states.find((j) => j.job_id === id)!;
    const a = at('job-a');
    const b = at('job-b');
    expect(a.progress_work_units - a.durable_work_units).toBe(16 * 540);
    expect(b.progress_work_units - b.durable_work_units).toBe(8 * 60);
    for (const c of demo.checkpoints) expect(c).toMatchObject({ status: 'complete', accessible: true, storage_resource_id: 'ckpt-store-1' });
  });
});

describe('GPU fixtures: observed vs private', () => {
  for (const [name, snap] of [['demo', demo], ['pump_degraded', degraded], ['tick.world_after.observable', tick.world_after.observable]] as const) {
    it(`${name} snapshot has no private fields or fault truth`, () => {
      const keys = allKeys(snap);
      for (const k of PRIVATE_KEYS) expect(keys.has(k), k).toBe(false);
      const text = JSON.stringify(snap);
      expect(text).not.toMatch(/fault-|cooling_pump_degradation|fault_id/);
    });
  }

  it('the private fault lives only in the tick result world', () => {
    expect(tick.world_after.active_faults_private.map((f) => f.kind)).toEqual(['cooling_pump_degradation']);
    expect(tick.world_after.active_faults_private[0]?.target_resource_id).toBe('pump-a');
  });
});

describe('GPU fixtures: scenario content', () => {
  const temps = (s: ObservedSnapshot, ...racks: number[]) =>
    s.gpus.filter((g) => gpusOn(...racks).includes(g.resource_id)).map((g) => g.temp_c);

  it('t=0 is healthy: loaded GPUs ≈70 °C, nothing throttled, epoch 0', () => {
    expect(demo.clock).toMatchObject({ sim_time_ms: 0, tick_index: 0, decision_epoch: 0 });
    for (const t of temps(demo, 2, 3, 4)) expect(t).toBeGreaterThan(69);
    for (const t of temps(demo, 2, 3, 4)) expect(t).toBeLessThan(71);
    expect(demo.gpus.every((g) => g.clocks_event_reasons === 0 && g.availability === 'ready')).toBe(true);
    expect(demo.cooling.every((c) => c.operating_state === 'normal')).toBe(true);
  });

  it('r6 is the hot destination (< 5 °C of headroom to slowdown)', () => {
    const r6 = demo.nodes.find((n) => n.resource_id === 'node-r6-n1')!;
    expect(r6.thermal_headroom_c).toBeGreaterThan(0);
    expect(r6.thermal_headroom_c).toBeLessThan(5);
  });

  it('t=120 s: pump-a degraded, r2–r4 hotter than t=0, loop-b racks unchanged', () => {
    expect(degraded.clock).toMatchObject({ sim_time_ms: 120_000, tick_index: 120, decision_epoch: 1 });
    expect(degraded.cooling.find((c) => c.resource_id === 'pump-a')?.operating_state).toBe('degraded');
    expect(degraded.cooling.find((c) => c.resource_id === 'pump-b')?.operating_state).toBe('normal');
    const before = temps(demo, 2, 3, 4);
    temps(degraded, 2, 3, 4).forEach((t, i) => expect(t).toBeGreaterThan(before[i]! + 3));
    expect(temps(degraded, 1, 5, 6, 7, 8)).toEqual(temps(demo, 1, 5, 6, 7, 8));
    expect(degraded.observation_event_ids).toEqual(['sig.10000.pump-a.equipment_alarm']);
  });

  it('tick result: fault tick at t=10 s, material change, §0.5 metrics, unique ids, increasing source_seq', () => {
    expect(tick.material_change).toBe(true);
    expect(tick.world_after.observable.clock).toMatchObject({ sim_time_ms: 10_000, decision_epoch: 1 });
    expect(tick.signals.map((s) => [s.resource_id, s.event_type])).toEqual([['pump-a', 'equipment_alarm']]);
    expect(tick.telemetry).toHaveLength(64 * 4 + 8 + 2);
    for (const e of tick.telemetry) {
      expect(METRICS_05.has(e.metric), e.metric).toBe(true);
      expect(e).toMatchObject({ source_kind: 'simulator', quality: 'estimated', sim_time_ms: 10_000 });
    }
    // ≤ 1 Hz per GPU: one sample per (resource, metric) in a 1 s tick
    const keys = tick.telemetry.map((e) => `${e.resource_id}|${e.metric}`);
    expect(new Set(keys).size).toBe(keys.length);
    const events = [...tick.telemetry, ...tick.signals];
    expect(new Set(events.map((e) => e.event_id)).size).toBe(events.length);
    const seqs = events.map((e) => e.source_seq);
    seqs.slice(1).forEach((s, i) => expect(s).toBeGreaterThan(seqs[i]!));
  });

  it('signal_xid79 is an XID 79 SignalEvent on gpu-r3-n1-0', () => {
    expect(xid).toMatchObject({ resource_id: 'gpu-r3-n1-0', event_type: 'xid_error', xid_code: 79, severity: 'critical', source_kind: 'simulator' });
  });
});
