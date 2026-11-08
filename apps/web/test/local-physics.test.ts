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

  it('runs real safety on requestAction against the epoch a fresh read reports', async () => {
    const client = createLocalPhysicsClient();
    try {
      client.advance(3);
      const snapshot = await client.getObservedSnapshot();
      const destination = Array.from({ length: 8 }, (_, k) => `gpu-r5-n1-${k}`);
      const versions = Object.fromEntries([['job-b', snapshot.job_states.find((j) => j.job_id === 'job-b')!.version], ...destination.map((id) => [id, snapshot.gpus.find((g) => g.resource_id === id)!.version])]);
      const status = await client.requestAction({
        schema_version: '1.1.0', run_id: snapshot.run_id, action_id: 'move-r5', command_key: 'move-r5', workflow_id: 'wf-test', plan_id: 'plan-test',
        incident_ids: ['inc-test'], operation: 'migrate_restart', target_resource_id: 'job-b', job_id: 'job-b', arguments: { destination_gpu_ids: destination },
        depends_on_command_keys: [], expected_decision_epoch: snapshot.clock.decision_epoch, expected_resource_versions: versions, requested_sim_time_ms: snapshot.clock.sim_time_ms,
      });
      expect(status.status).toBe('requested');
      let safety: unknown = null;
      client.onActionDetails((rows) => { safety = rows.find((row) => row.command.command_key === 'move-r5')?.safety; })();
      expect(safety).toMatchObject({ decision: 'allow', violations: [] });
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
