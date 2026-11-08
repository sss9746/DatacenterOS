import { describe, expect, it } from 'vitest';
import { validatePayload } from '@dcos/contracts';
import { buildStallFault } from '../src/fault.js';

describe('stall fault', () => {
  it('is a valid FaultInjection matching the dashboard pump-a control', () => {
    const f = buildStallFault('run-demo-1', 5000, 123);
    expect(validatePayload('FaultInjection', f).ok).toBe(true);
    expect(f).toMatchObject({ kind: 'cooling_pump_degradation', target_resource_id: 'pump-a', severity: 0.6, start_sim_time_ms: 6000 });
  });
});
