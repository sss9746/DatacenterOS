import { describe, expect, it } from 'vitest';
import { createLocalPhysicsClient } from '../src/data/local-physics';

const fault = (kind: 'cooling_pump_degradation' | 'gpu_xid_79', target: string) => ({
  schema_version: '1.1.0' as const, run_id: 'run-demo-1', fault_id: `test-${kind}`,
  target_resource_id: target, kind, start_sim_time_ms: 600_000,
  duration_sim_ms: null, severity: 0.8, parameters: {}, seed_offset: 0,
});

describe('local P1 physics simulation', () => {
  it('heats the racks served by a degraded pump while another loop stays cool', async () => {
    const client = createLocalPhysicsClient();
    try {
      const before = await client.getObservedSnapshot();
      await client.injectFault(fault('cooling_pump_degradation', 'pump-a'));
      client.advance(120);
      const after = await client.getObservedSnapshot();
      const temp = (id: string, snapshot: typeof after) => snapshot.gpus.find((gpu) => gpu.resource_id === id)!.temp_c;
      expect(temp('gpu-r3-n1-0', after)).toBeGreaterThan(temp('gpu-r3-n1-0', before) + 5);
      expect(temp('gpu-r5-n1-0', after)).toBeLessThan(temp('gpu-r5-n1-0', before) + 2);
      expect(after.clock.tick_index).toBe(120);
      expect(after.cooling.find((row) => row.resource_id === 'pump-a')?.operating_state).toBe('degraded');
    } finally { client.close(); }
  });

  it('makes XID 79 unavailable and rolls the affected job back to durable work', async () => {
    const client = createLocalPhysicsClient();
    try {
      const before = await client.getObservedSnapshot();
      await client.injectFault(fault('gpu_xid_79', 'gpu-r3-n1-0'));
      client.tick();
      const after = await client.getObservedSnapshot();
      const job = after.job_states.find((row) => row.job_id === 'job-a')!;
      expect(job.status).toBe('failed');
      expect(job.progress_work_units).toBe(job.durable_work_units);
      expect(job.progress_work_units).toBeLessThan(before.job_states.find((row) => row.job_id === 'job-a')!.progress_work_units);
      expect(after.gpus.find((gpu) => gpu.resource_id === 'gpu-r3-n1-0')?.availability).toBe('unreachable');
      const evidence = await client.getEvidence([], 60_000);
      expect(evidence.signals.some((signal) => signal.xid_code === 79)).toBe(true);
    } finally { client.close(); }
  });

  it('applies facility tuning to the real model before stepping', async () => {
    const defaultClient = createLocalPhysicsClient();
    const tunedClient = createLocalPhysicsClient(42, { pumpACapacityPct: 40, pumpBCapacityPct: 100, rack6InletOffsetC: 0 });
    try {
      defaultClient.advance(60);
      tunedClient.advance(60);
      const baseline = await defaultClient.getObservedSnapshot();
      const tuned = await tunedClient.getObservedSnapshot();
      expect(tuned.cooling.find((row) => row.resource_id === 'pump-a')!.nominal_capacity_w).toBeLessThan(baseline.cooling.find((row) => row.resource_id === 'pump-a')!.nominal_capacity_w);
      expect(tuned.gpus.find((gpu) => gpu.resource_id === 'gpu-r3-n1-0')!.temp_c).toBeGreaterThan(baseline.gpus.find((gpu) => gpu.resource_id === 'gpu-r3-n1-0')!.temp_c);
      expect(tuned.gpus.find((gpu) => gpu.resource_id === 'gpu-r6-n1-0')!.temp_c).toBeLessThan(baseline.gpus.find((gpu) => gpu.resource_id === 'gpu-r6-n1-0')!.temp_c);
    } finally { defaultClient.close(); tunedClient.close(); }
  });
});
