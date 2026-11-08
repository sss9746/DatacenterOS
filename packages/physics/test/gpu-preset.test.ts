// P1-3: buildPreset('gpu_demo_8') + world model + toObserved.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validatePayload, type ObservedSnapshot } from '@dcos/contracts';
import { buildPreset, toObserved, PRIVATE_KEYS } from '../src/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'gpu');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as ObservedSnapshot;
const SLOTS = [0, 1, 2, 3, 4, 5, 6, 7];
const gpusOn = (...racks: number[]) => racks.flatMap((r) => SLOTS.map((k) => `gpu-r${r}-n1-${k}`));

function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); allKeys(x, out); }
  return out;
}

describe('buildPreset gpu_demo_8', () => {
  const world = buildPreset('gpu_demo_8', 'run-demo-1', 1);
  const obs = toObserved(world);

  it('the world validates as PhysicsWorld and the snapshot as ObservedSnapshot', () => {
    expect(validatePayload('PhysicsWorld', world)).toEqual({ ok: true });
    expect(validatePayload('ObservedSnapshot', obs)).toEqual({ ok: true });
  });

  it('toObserved(buildPreset(gpu_demo_8, run-demo-1, 1)) deep-equals fixtures/gpu/observed_snapshot_demo.json', () => {
    expect(obs).toEqual(fixture('observed_snapshot_demo.json'));
    // byte-exact too (key order and float spelling), as the fixture generator serializes it
    expect(`${JSON.stringify(obs, null, 2)}\n`).toBe(readFileSync(join(FIXTURES, 'observed_snapshot_demo.json'), 'utf8'));
  });

  it('has 64 simulated GPUs and §0.3 placements', () => {
    expect(obs.gpus).toHaveLength(64);
    const placed = new Map(obs.job_states.map((j) => [j.job_id, [...j.allocated_gpu_ids].sort()]));
    expect(placed.get('job-a')).toEqual(gpusOn(2, 3).sort());
    expect(placed.get('job-b')).toEqual(gpusOn(4).sort());
    expect(placed.get('job-c')).toEqual(gpusOn(6).sort());
    const ids = obs.allocations.map((a) => a.gpu_id);
    expect(new Set(ids).size).toBe(32);
  });

  it('toObserved has no private fields and is a copy (mutating it leaves the world alone)', () => {
    const keys = allKeys(obs);
    for (const k of PRIVATE_KEYS) expect(keys.has(k), k).toBe(false);
    obs.gpus[0]!.temp_c = 999;
    expect(world.observable.gpus[0]!.temp_c).not.toBe(999);
  });

  it('toObserved strips private keys even if one leaked into the observable', () => {
    const w = buildPreset('gpu_demo_8', 'run-demo-1', 1);
    (w.observable.resources[0]!.config as Record<string, unknown>).hidden_physics_state_json = { leak: true };
    expect(allKeys(toObserved(w)).has('hidden_physics_state_json')).toBe(false);
  });

  it('starts the run clock at 600 000 (CONTRACTS §0.12 #2): tick 0, epoch 0', () => {
    expect(obs.clock).toMatchObject({ sim_time_ms: 600_000, tick_index: 0, decision_epoch: 0, paused: false });
    expect(obs.gpus.every((g) => g.last_seen_sim_ms === 600_000)).toBe(true);
    expect(obs.job_states.every((j) => j.last_update_sim_time_ms === 600_000)).toBe(true);
  });

  it('pre-run checkpoints carry real times: job-a 9 min old (complete 60 000), job-b 1 min old (540 000), job-c none', () => {
    const ck = new Map(obs.checkpoints.map((c) => [c.job_id, c]));
    expect(ck.get('job-a')).toMatchObject({ requested_sim_time_ms: 30_000, complete_sim_time_ms: 60_000, status: 'complete' });
    expect(ck.get('job-b')).toMatchObject({ requested_sim_time_ms: 510_000, complete_sim_time_ms: 540_000, status: 'complete' });
    expect(ck.has('job-c')).toBe(false);
    // age = sim_time_ms − complete_sim_time_ms, and it matches the work at risk (progress − durable) at the nominal rate
    for (const [id, gpus, ageS] of [['job-a', 16, 540], ['job-b', 8, 60]] as const) {
      expect(obs.clock.sim_time_ms - ck.get(id)!.complete_sim_time_ms!).toBe(ageS * 1000);
      const j = obs.job_states.find((x) => x.job_id === id)!;
      expect(j.progress_work_units - j.durable_work_units).toBe(gpus * ageS);
    }
    // no hidden-state workaround: the hidden state carries no checkpoint times
    expect(Object.keys(world.hidden_physics_state_json)).not.toContain('last_checkpoint_sim_ms');
  });

  it('is deterministic per seed; a different seed changes only the seeded temperature spread', () => {
    expect(buildPreset('gpu_demo_8', 'run-demo-1', 1)).toEqual(world);
    const other = toObserved(buildPreset('gpu_demo_8', 'run-demo-1', 2));
    expect(other.gpus.map((g) => g.temp_c)).not.toEqual(obs.gpus.map((g) => g.temp_c));
    expect(other.job_states).toEqual(obs.job_states);
    expect(world.rng_state).toMatch(/^mulberry32:0x[0-9a-f]{8}$/);
  });

  it('uses the given run id everywhere', () => {
    const w = buildPreset('gpu_demo_8', 'run-x', 1);
    expect(JSON.stringify(w)).not.toContain('run-demo-1');
    expect(validatePayload('PhysicsWorld', w)).toEqual({ ok: true });
  });

  it('rejects unknown presets', () => {
    expect(() => buildPreset('nope' as 'gpu_demo_8', 'run-demo-1', 1)).toThrow(/unknown preset/);
  });
});
