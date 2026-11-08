import { describe, expect, it } from 'vitest';
import { validatePayload, type ObservedSnapshot } from '@dcos/contracts';
import {
  FIXTURE_BUILDERS,
  FIXTURE_TYPES,
  RAW_FIXTURES,
  REAL_GPU_ID,
  THERMAL_THROTTLE_BIT,
  loadDemoSnapshot,
  loadPumpDegradedSnapshot,
  loadSignalXid79Dest,
  loadSignalXid79R7,
  type FixtureName,
} from './fixtures/index.js';

const names = Object.keys(FIXTURE_BUILDERS) as FixtureName[];
const rackOf = (gpu: string) => gpu.replace(/^gpu-(r\d)-n1-\d$/, 'rack-$1');
const gpusOnRacks = (s: ObservedSnapshot, racks: string[]) => s.gpus.filter((g) => racks.includes(rackOf(g.resource_id)));

describe('committed fixtures', () => {
  it.each(names)('%s passes validatePayload', (name) => {
    const res = validatePayload(FIXTURE_TYPES[name], RAW_FIXTURES[name]);
    expect(res).toEqual({ ok: true });
  });

  it.each(names)('%s matches its builder (regenerate with `pnpm --filter agent fixtures`)', (name) => {
    expect(RAW_FIXTURES[name]).toEqual(JSON.parse(JSON.stringify(FIXTURE_BUILDERS[name]())));
  });
});

describe('gpu_demo_8 topology (CONTRACTS §0.3)', () => {
  const s = loadDemoSnapshot();
  it('has 64 simulated GPUs + gpu-real-0 (brev_real, not allocatable)', () => {
    expect(s.gpus.filter((g) => g.resource_id !== REAL_GPU_ID)).toHaveLength(64);
    const real = s.resources.find((r) => r.resource_id === REAL_GPU_ID)!;
    expect(real.profile).toBe('brev_real');
    expect(real.config.allocatable).toBe(false);
    expect(s.allocations.some((a) => a.gpu_id === REAL_GPU_ID)).toBe(false);
  });
  it('pump-a -> loop-a cools r2–r4; pump-b -> loop-b cools r1, r5–r8', () => {
    const cooledBy = (rack: string) => s.dependencies.find((e) => e.consumer_id === rack && e.relation === 'cooled_by')!.provider_id;
    expect(['rack-r2', 'rack-r3', 'rack-r4'].map(cooledBy)).toEqual(['loop-a', 'loop-a', 'loop-a']);
    expect(['rack-r1', 'rack-r5', 'rack-r6', 'rack-r7', 'rack-r8'].every((r) => cooledBy(r) === 'loop-b')).toBe(true);
  });
  it('places job-a on r2+r3 (16), job-b on r4 (8), job-c on r6 (8, non-preemptible)', () => {
    const racksOf = (job: string) => [...new Set(s.allocations.filter((a) => a.job_id === job).map((a) => rackOf(a.gpu_id)))];
    expect(racksOf('job-a')).toEqual(['rack-r2', 'rack-r3']);
    expect(racksOf('job-b')).toEqual(['rack-r4']);
    expect(racksOf('job-c')).toEqual(['rack-r6']);
    expect(s.job_specs.find((j) => j.job_id === 'job-c')!.preemptible).toBe(false);
  });
});

describe('pump-degraded snapshot', () => {
  const s = loadPumpDegradedSnapshot();
  it('has pump-a degraded, pump-b normal', () => {
    expect(s.cooling.find((c) => c.resource_id === 'pump-a')!.operating_state).toBe('degraded');
    expect(s.cooling.find((c) => c.resource_id === 'pump-b')!.operating_state).toBe('normal');
  });
  it('heats r2–r4 to 84–88 °C with the thermal bit on GPUs >= 85 °C', () => {
    const hot = gpusOnRacks(s, ['rack-r2', 'rack-r3', 'rack-r4']);
    expect(hot).toHaveLength(24);
    for (const g of hot) {
      expect(g.temp_c).toBeGreaterThanOrEqual(84);
      expect(g.temp_c).toBeLessThanOrEqual(88);
      expect((g.clocks_event_reasons & THERMAL_THROTTLE_BIT) !== 0).toBe(g.temp_c >= 85);
    }
    expect(hot.filter((g) => g.temp_c >= 85).length).toBeGreaterThanOrEqual(18);
  });
  it('keeps r1/r5/r7/r8 ~70 °C and r6 ~82 °C with < 7 °C headroom', () => {
    for (const g of gpusOnRacks(s, ['rack-r1', 'rack-r5', 'rack-r7', 'rack-r8'])) expect(Math.abs(g.temp_c - 70)).toBeLessThan(1);
    for (const g of gpusOnRacks(s, ['rack-r6'])) expect(Math.abs(g.temp_c - 82)).toBeLessThan(1.5);
    expect(s.nodes.find((n) => n.resource_id === 'node-r6-n1')!.thermal_headroom_c).toBeLessThan(7);
    expect(s.nodes.find((n) => n.resource_id === 'node-r7-n1')!.thermal_headroom_c).toBeGreaterThanOrEqual(7);
  });
  it('job-a last checkpoint is 9 sim-min old, job-b 1 sim-min old, job-c has none', () => {
    const age = (job: string) => {
      const st = s.job_states.find((j) => j.job_id === job)!;
      const cp = s.checkpoints.find((c) => c.checkpoint_id === st.latest_checkpoint_id);
      return cp ? s.clock.sim_time_ms - cp.complete_sim_time_ms! : null;
    };
    expect(age('job-a')).toBe(9 * 60_000);
    expect(age('job-b')).toBe(60_000);
    expect(age('job-c')).toBeNull();
  });
});

describe('XID 79 signals', () => {
  it('target gpu-r7-n1-3 (independent) and gpu-r8-n1-0 (destination)', () => {
    const r7 = loadSignalXid79R7();
    const dest = loadSignalXid79Dest();
    expect([r7.resource_id, r7.event_type, r7.xid_code]).toEqual(['gpu-r7-n1-3', 'xid_error', 79]);
    expect([dest.resource_id, dest.xid_code]).toEqual(['gpu-r8-n1-0', 79]);
  });
});
