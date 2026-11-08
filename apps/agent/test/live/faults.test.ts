import { validatePayload } from '@dcos/contracts';
import { describe, expect, it } from 'vitest';
import { dueTickTooLate, nextTickMs, nodeOfGpu, pumpDegradation, rackOfGpu, xid79 } from '../../scripts/live/faults.js';

const clock = { sim_time_ms: 612_000, step_ms: 1_000 };

describe('live harness fault builders', () => {
  it('pump degradation: next tick start, 60% loss as severity 0.6 / capacity_factor 0.4, persistent', () => {
    const f = pumpDegradation('run-demo-1', clock);
    expect(f).toMatchObject({ target_resource_id: 'pump-a', kind: 'cooling_pump_degradation', start_sim_time_ms: 613_000, duration_sim_ms: null, severity: 0.6, parameters: { capacity_factor: 0.4 } });
    expect(validatePayload('FaultInjection', f).ok).toBe(true);
    expect(() => pumpDegradation('r', clock, 1)).toThrow(/pump loss/);
  });

  it('xid79: next tick by default, explicit due tick when given, never in the past', () => {
    const f = xid79('run-demo-1', 'gpu-r7-n1-0', clock);
    expect(f).toMatchObject({ kind: 'gpu_xid_79', target_resource_id: 'gpu-r7-n1-0', start_sim_time_ms: nextTickMs(clock), severity: 1, duration_sim_ms: null });
    expect(validatePayload('FaultInjection', f).ok).toBe(true);
    expect(xid79('r', 'gpu-r2-n1-1', clock, 640_000).start_sim_time_ms).toBe(640_000);
    expect(() => xid79('r', 'gpu-r2-n1-1', clock, 600_000)).toThrow(/in the past/);
  });

  it('node/rack of a demo GPU id', () => {
    expect(nodeOfGpu('gpu-r7-n1-3')).toBe('node-r7-n1');
    expect(rackOfGpu('gpu-r7-n1-3')).toBe('rack-r7');
    expect(nodeOfGpu('gpu-real-0')).toBeNull();
  });

  it('due-tick guard: passed, too close, or fine', () => {
    expect(dueTickTooLate(clock, 612_000)).toMatch(/already passed/);
    expect(dueTickTooLate(clock, 613_000)).toMatch(/only 1000 sim-ms/);
    expect(dueTickTooLate(clock, 614_000)).toBeNull();
  });
});
