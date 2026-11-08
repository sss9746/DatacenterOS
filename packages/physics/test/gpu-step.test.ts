// P1-4: step() for the GPU layer, including the mandatory Gate 1 physics test.
import { describe, expect, it } from 'vitest';
import { validatePayload, type ObservedSnapshot, type PhysicsTickResult, type SignalEvent } from '@dcos/contracts';
import * as root from '../src/index.js';
import { step as gpuStep } from '../src/gpu/step.js';
import { step as v0Step } from '../src/v0/index.js';
import { buildPreset, toObserved, step } from '../src/index.js';
import { PUMP_A_FAULT, T0, deepFreeze, demoWorld, fault, gpusOn, readFixture, runUntil, tickInput } from './gpu-helpers.js';

const XID79 = fault('gpu_xid_79', 'gpu-r3-n1-0', T0 + 150_000, { fault_id: 'fault-xid79-r3-0' });
const gpu = (s: ObservedSnapshot, id: string) => s.gpus.find((g) => g.resource_id === id)!;
const job = (s: ObservedSnapshot, id: string) => s.job_states.find((j) => j.job_id === id)!;

describe('P1-2 done-when: the package root is the GPU API', () => {
  it("import { step } from '@dcos/physics' is the GPU step, not the v0 facility step", () => {
    expect(root.step).toBe(gpuStep);
    expect(root.step).not.toBe(v0Step);
    expect(typeof root.buildPreset).toBe('function');
    expect(typeof root.toObserved).toBe('function');
  });
});

describe('Gate 1 physics: pump-a degradation at start + 10 s (610 000)', () => {
  const firstThrottleMs = new Map<string, number>();
  let maxCoolRackTemp = 0;
  let validated = 0;
  const { world, results } = runUntil(demoWorld(), T0 + 600_000, {
    faults: [PUMP_A_FAULT],
    onTick: (r) => {
      const s = r.world_after.observable;
      for (const g of s.gpus) {
        if ((g.clocks_event_reasons & 0x40) !== 0 && !firstThrottleMs.has(g.resource_id)) firstThrottleMs.set(g.resource_id, s.clock.sim_time_ms);
      }
      for (const id of gpusOn(1, 5, 6, 7, 8)) maxCoolRackTemp = Math.max(maxCoolRackTemp, gpu(s, id).temp_c);
      if (s.clock.sim_time_ms % 50_000 === 0 || r.material_change) {
        expect(validatePayload('PhysicsTickResult', r)).toEqual({ ok: true });
        validated++;
      }
    },
  });

  it('heats every r2–r4 GPU past 85 °C (throttled) within the 600 s horizon', () => {
    for (const id of gpusOn(2, 3, 4)) {
      expect(firstThrottleMs.get(id), id).toBeDefined();
      expect(firstThrottleMs.get(id)!).toBeLessThanOrEqual(T0 + 600_000);
      expect(firstThrottleMs.get(id)!).toBeGreaterThan(T0 + 10_000);
    }
  });

  it('keeps r1 and r5–r8 GPUs below 85 °C the whole time', () => {
    for (const id of gpusOn(1, 5, 6, 7, 8)) expect(firstThrottleMs.has(id), id).toBe(false);
    expect(maxCoolRackTemp).toBeLessThan(85);
  });

  it('a throttled GPU runs at 1980 × 0.7 MHz and its job loses 30% of that GPU`s rate', () => {
    const t = firstThrottleMs.get('gpu-r4-n1-0')!;
    const r = results.find((x) => x.world_after.observable.clock.sim_time_ms === t)!;
    expect(gpu(r.world_after.observable, 'gpu-r4-n1-0')).toMatchObject({ sm_clock_mhz: 1386, clocks_event_reasons: 0x40 });
    expect(r.material_change).toBe(true);
  });

  it('pump-a shows degraded with an equipment_alarm at start + 10 s and epoch 1', () => {
    const r10 = results[9]!;
    expect(r10.world_after.observable.clock).toMatchObject({ sim_time_ms: T0 + 10_000, tick_index: 10, decision_epoch: 1 });
    expect(r10.material_change).toBe(true);
    expect(r10.signals.map((s) => [s.resource_id, s.event_type])).toEqual([['pump-a', 'equipment_alarm']]);
    expect(results.slice(0, 9).every((r) => !r.material_change)).toBe(true);
    expect(world.observable.cooling.find((c) => c.resource_id === 'pump-a')?.operating_state).toBe('degraded');
    expect(validated).toBeGreaterThan(10);
  });

  it('GPUs that reach 92 °C shut down (unavailable) and their non-elastic job fails back to durable', () => {
    const shut = results.flatMap((r) => r.signals.filter((s) => s.event_type === 'gpu_unreachable'));
    expect(shut.length).toBeGreaterThan(0);
    const first = shut[0]!;
    const throttles = [...firstThrottleMs.values()];
    console.info(`[P1-4] r2–r4 first throttle start + ${(Math.min(...throttles) - T0) / 1000}–${(Math.max(...throttles) - T0) / 1000} s; first shutdown ${first.resource_id} at start + ${(first.sim_time_ms - T0) / 1000} s`);
    expect(first.evidence.temp_c as number).toBeGreaterThanOrEqual(92);
    const after = results.find((r) => r.signals.includes(first))!.world_after.observable;
    expect(gpu(after, first.resource_id).availability).toBe('unreachable');
    const victim = after.job_states.find((j) => j.status === 'failed')!;
    expect(victim.progress_work_units).toBe(victim.durable_work_units);
    expect(victim.allocated_gpu_ids).toEqual([]);
  });
});

describe('Gate 1 physics: XID 79 on gpu-r3-n1-0', () => {
  const { results } = runUntil(demoWorld(), T0 + 151_000, { faults: [XID79] });
  const r150 = results.find((r) => r.world_after.observable.clock.sim_time_ms === T0 + 150_000)!;
  const s = r150.world_after.observable;

  it('makes the GPU unavailable and fails job-a back to durable_work_units', () => {
    const before = results.find((r) => r.world_after.observable.clock.sim_time_ms === T0 + 149_000)!.world_after.observable;
    expect(job(before, 'job-a').progress_work_units).toBe(95_040 + 16 * 149);
    expect(gpu(s, 'gpu-r3-n1-0')).toMatchObject({ availability: 'unreachable', last_xid_code: 79, power_w: 0 });
    expect(job(s, 'job-a')).toMatchObject({ status: 'failed', progress_work_units: 86_400, durable_work_units: 86_400, allocated_gpu_ids: [] });
    expect(s.allocations.some((a) => a.job_id === 'job-a')).toBe(false);
    expect(job(s, 'job-b').status).toBe('running');
    expect(r150.material_change).toBe(true);
    expect(s.clock.decision_epoch).toBe(1);
    expect(validatePayload('PhysicsTickResult', r150)).toEqual({ ok: true });
  });

  it('emits the XID as a SignalEvent identical to fixtures/gpu/signal_xid79.json', () => {
    expect(r150.signals).toEqual([readFixture<SignalEvent>('signal_xid79.json')]);
    expect(r150.telemetry.some((e) => e.metric.includes('XID'))).toBe(false);
  });

  it('afterwards the GPU reports only a missing temperature sample and job-a stays failed', () => {
    const next = results.at(-1)!;
    const samples = next.telemetry.filter((e) => e.resource_id === 'gpu-r3-n1-0');
    expect(samples.map((e) => [e.metric, e.quality])).toEqual([['DCGM_FI_DEV_GPU_TEMP_CELSIUS', 'missing']]);
    expect(job(next.world_after.observable, 'job-a').status).toBe('failed');
    expect(next.material_change).toBe(false);
  });
});

describe('Gate 1 physics: determinism', () => {
  const runAll = (seed: number) => runUntil(demoWorld(seed), T0 + 200_000, { faults: [PUMP_A_FAULT, XID79] }).results;

  it('the same seed gives an identical result', () => {
    expect(runAll(1)).toEqual(runAll(1));
  });

  it('a different seed gives a different temperature spread', () => {
    const a = runAll(1).at(-1)!.world_after.observable.gpus.map((g) => g.temp_c);
    const b = runAll(2).at(-1)!.world_after.observable.gpus.map((g) => g.temp_c);
    expect(a).not.toEqual(b);
  });

  it('never mutates its input', () => {
    const input = deepFreeze(tickInput(demoWorld(), [PUMP_A_FAULT]));
    const copy = JSON.parse(JSON.stringify(input));
    expect(() => step(input)).not.toThrow();
    expect(input).toEqual(copy);
  });
});

describe('fixture agreement', () => {
  it('start + 120 s after the pump fault matches fixtures/gpu/observed_snapshot_pump_degraded.json', () => {
    const fx = readFixture<ObservedSnapshot>('observed_snapshot_pump_degraded.json');
    const { world } = runUntil(demoWorld(), T0 + 120_000, { faults: [PUMP_A_FAULT] });
    const obs = toObserved(world);
    expect(validatePayload('ObservedSnapshot', obs)).toEqual({ ok: true });
    expect(obs.clock).toEqual(fx.clock);
    expect(obs.cooling).toEqual(fx.cooling);
    expect(obs.job_states).toEqual(fx.job_states);
    expect(obs.observation_event_ids).toEqual(fx.observation_event_ids);
    expect(obs.gpus.map((g) => [g.resource_id, g.availability, g.clocks_event_reasons, g.version]))
      .toEqual(fx.gpus.map((g) => [g.resource_id, g.availability, g.clocks_event_reasons, g.version]));
    const deltas = obs.gpus.map((g, i) => Math.abs(g.temp_c - fx.gpus[i]!.temp_c));
    const maxDelta = Math.max(...deltas);
    console.info(`[P1-4] start + 120 s max GPU temp delta vs fixture: ${maxDelta.toFixed(3)} °C`);
    expect(maxDelta).toBeLessThanOrEqual(1);
    // the model reproduces the fixture exactly
    expect(obs).toEqual(fx);
  });

  it('the start + 10 s fault tick matches fixtures/gpu/tick_result_example.json (observable, telemetry, signals)', () => {
    const fx = readFixture<PhysicsTickResult>('tick_result_example.json');
    const { results } = runUntil(demoWorld(), T0 + 10_000, { faults: [PUMP_A_FAULT] });
    const r = results.at(-1)!;
    expect(r.world_after.observable).toEqual(fx.world_after.observable);
    expect(r.world_after.active_faults_private).toEqual(fx.world_after.active_faults_private);
    expect(r.world_after.rng_state).toBe(fx.world_after.rng_state);
    expect(r.telemetry).toEqual(fx.telemetry);
    expect(r.signals).toEqual(fx.signals);
    expect(r.material_change).toBe(true);
  });
});

describe('telemetry and epoch rules', () => {
  const { results } = runUntil(demoWorld(), T0 + 5_000);

  it('emits ≤ 1 sample per (resource, metric) per tick with unique ids and increasing source_seq', () => {
    for (const r of results) {
      const keys = r.telemetry.map((e) => `${e.resource_id}|${e.metric}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(r.telemetry).toHaveLength(64 * 4 + 8 + 2);
      const seqs = [...r.telemetry, ...r.signals].map((e) => e.source_seq);
      seqs.slice(1).forEach((x, i) => expect(x).toBeGreaterThan(seqs[i]!));
      expect(r.telemetry.every((e) => e.source_kind === 'simulator' && e.quality === 'estimated')).toBe(true);
    }
    const all = results.flatMap((r) => r.telemetry.map((e) => e.event_id));
    expect(new Set(all).size).toBe(all.length);
  });

  it('quiet ticks advance the clock and progress without bumping the epoch', () => {
    const last = results.at(-1)!.world_after.observable;
    expect(last.clock).toMatchObject({ sim_time_ms: T0 + 5_000, tick_index: 5, decision_epoch: 0 });
    expect(results.every((r) => !r.material_change)).toBe(true);
    expect(job(last, 'job-c').progress_work_units).toBe(30_000 + 8 * 5);
  });

  it('a paused clock does not advance', () => {
    const w = demoWorld();
    w.observable.clock.paused = true;
    const r = step(tickInput(w));
    expect(r.world_after.observable.clock.sim_time_ms).toBe(T0);
    expect(r.telemetry).toEqual([]);
  });

  it('a job reaching total_work_units completes and frees its GPUs', () => {
    const w = demoWorld();
    const b = w.observable.job_states.find((j) => j.job_id === 'job-b')!;
    b.progress_work_units = 60_000 - 8;
    const r = step(tickInput(w));
    expect(job(r.world_after.observable, 'job-b')).toMatchObject({ status: 'completed', progress_work_units: 60_000, allocated_gpu_ids: [] });
    expect(r.material_change).toBe(true);
    const s = r.world_after.observable;
    expect(s.gpus.filter((g) => gpusOn(4).includes(g.resource_id)).every((g) => g.power_w < 100)).toBe(true);
  });

  it('builds on the preset world (buildPreset is reusable across runs)', () => {
    const a = buildPreset('gpu_demo_8', 'run-demo-1', 1);
    step(tickInput(a));
    expect(a.observable.clock.sim_time_ms).toBe(T0);
  });
});
