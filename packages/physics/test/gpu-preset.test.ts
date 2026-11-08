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

  it('keeps the true pre-run checkpoint age in hidden state only', () => {
    const h = world.hidden_physics_state_json as { last_checkpoint_sim_ms: Record<string, number> };
    expect(h.last_checkpoint_sim_ms).toEqual({ 'job-a': -540_000, 'job-b': -60_000 });
    expect(obs.checkpoints.every((c) => c.requested_sim_time_ms === 0 && c.complete_sim_time_ms === 0)).toBe(true);
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
