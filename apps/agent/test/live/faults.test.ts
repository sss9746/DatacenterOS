import { validatePayload } from '@dcos/contracts';
import { describe, expect, it } from 'vitest';
import { dueTickTooLate, nextTickMs, nodeCrash, nodeOfGpu, pumpDegradation, rackOfGpu, simulatedNodeIds, xid79 } from '../../scripts/live/faults.js';

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

  it('nodeCrash: a valid finite node_crash at the given future tick, unique per node', () => {
    const f = nodeCrash('run-demo-1', 'node-r1-n1', clock, 624_000, 30_000, 'sb');
    expect(f).toEqual({ schema_version: '1.1.0', fault_id: 'sb-node-crash-node-r1-n1-624000', run_id: 'run-demo-1', target_resource_id: 'node-r1-n1', kind: 'node_crash', start_sim_time_ms: 624_000, duration_sim_ms: 30_000, severity: 1, parameters: {}, seed_offset: 0 });
    expect(validatePayload('FaultInjection', f).ok).toBe(true);
    expect(nodeCrash('r', 'node-r2-n1', clock, 624_000, 30_000, 'sb').fault_id).not.toBe(f.fault_id);
  });

  it('nodeCrash refuses a start that is not in the future and a non-finite or empty duration', () => {
    expect(() => nodeCrash('r', 'node-r1-n1', clock, 612_000, 30_000)).toThrow(/future/);
    expect(() => nodeCrash('r', 'node-r1-n1', clock, 624_000, 0)).toThrow(/duration/);
    expect(() => nodeCrash('r', 'node-r1-n1', clock, 624_000, Number.POSITIVE_INFINITY)).toThrow(/duration/);
  });

  it('simulatedNodeIds keeps simulated nodes and drops the hardware-backed one', () => {
    const res = [
      { resource_id: 'node-r1-n1', kind: 'node', config: { simulated: true } },
      { resource_id: 'node-real-0', kind: 'node', config: { hardware_backed: true } },
      { resource_id: 'gpu-r1-n1-0', kind: 'gpu', config: {} },
    ];
    expect(simulatedNodeIds(res)).toEqual(['node-r1-n1']);
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
