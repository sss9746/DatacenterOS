import { describe, expect, it } from 'vitest';
import { createLocalPhysicsClient } from '../src/data/local-physics';
import { DashboardStore } from '../src/data/dashboard';
import { jobMoveTimeline } from '../src/components/jobs/move-timeline';
import { buildFaultInjection } from '../src/components/controls/fault-form';
import { buildR6Probe, probeIds } from '../src/components/controls/safety-probe';

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('in-browser recovery preview (deterministic thresholdPolicy through the local physics command path)', () => {
  it('after an XID kills job-a: cordons the GPU, moves job-a to free racks from its checkpoint, and physics restarts it in 120 sim-s', async () => {
    const client = createLocalPhysicsClient();
    const store = new DashboardStore(client);
    try {
      await store.refresh(); store.start(); await settle();
      const s0 = store.state.snapshot!;
      const jobA0 = s0.job_states.find((j) => j.job_id === 'job-a')!;
      await client.injectFault(buildFaultInjection({ runId: s0.run_id, simTimeMs: s0.clock.sim_time_ms, faultId: 'judge-x', fault: 'gpu_xid_79', targetId: 'gpu-r3-n1-0', delayS: 0 }));
      client.advance(2); await settle();
      expect(store.state.snapshot!.job_states.find((j) => j.job_id === 'job-a')!.status).toBe('failed');

      await client.runRecoveryPreview(); await settle();
      const keys = store.state.actionDetails.map((d) => `${d.command.operation}:${d.command.job_id ?? d.command.target_resource_id}:${d.status.status}`);
      expect(keys).toContain('cordon_gpu:gpu-r3-n1-0:running');
      expect(keys).toContain('migrate_restart:job-a:running');
      expect(store.state.actionDetails.every((d) => d.command.workflow_id.startsWith('wf-preview-'))).toBe(true);

      client.advance(5); await settle(); await store.refresh(); await settle();
      const mid = store.state.snapshot!.job_states.find((j) => j.job_id === 'job-a')!;
      expect(mid.status).toBe('restarting');
      expect(mid.progress_work_units).toBe(jobA0.durable_work_units);
      const t = jobMoveTimeline('job-a', store.state)!;
      expect(t.kind).toBe('move'); expect(t.phase).toBe('restarting');
      expect(t.from?.racks).toEqual([2, 3]); expect(t.to?.racks).toEqual([1, 2]);
      expect(t.lostWorkUnits).toBe(jobA0.progress_work_units - jobA0.durable_work_units);
      expect(t.restart?.remainingMs).toBeGreaterThan(0);
      expect(store.state.actionDetails.find((d) => d.command.operation === 'cordon_gpu')?.status.status).toBe('succeeded');

      client.advance(125); await settle(); await store.refresh(); await settle();
      const done = store.state.snapshot!.job_states.find((j) => j.job_id === 'job-a')!;
      expect(done.status).toBe('running');
      expect(done.allocated_gpu_ids.every((id) => /^gpu-r[12]-/.test(id))).toBe(true);
      const landed = jobMoveTimeline('job-a', store.state)!;
      expect(landed.phase).toBe('running');
      expect(landed.steps[4]!.detail).toMatch(/^Resumed from checkpoint ckpt-job-a-1 \(.* saved\) · lost [\d,]+ wu$/);
      expect(store.state.actionDetails.find((d) => d.command.operation === 'migrate_restart')?.status.status).toBe('succeeded');
      expect(client.recoveryPreview.log.some((line) => line.includes('not Nemotron'))).toBe(true);
    } finally { store.close(); }
  });

  it('never executes a command that evaluateSafety rejected: the r6 probe stays failed and job-b never moves', async () => {
    const client = createLocalPhysicsClient();
    try {
      client.advance(2);
      const snapshot = await client.getObservedSnapshot();
      const build = buildR6Probe(snapshot, probeIds('t'));
      if (!build.ok) throw new Error(build.reason);
      const status = await client.requestAction(build.command);
      expect(status.status).toBe('failed'); expect(status.reason_code).toBe('SAFETY_REJECTED');
      await expect(client.claimAction(build.command.command_key, status.version, 'preview-planner')).rejects.toThrow(/INVALID_TRANSITION/);
      client.advance(130);
      const after = await client.getObservedSnapshot();
      const jobB = after.job_states.find((j) => j.job_id === 'job-b')!;
      expect(jobB.status).toBe('running');
      expect(jobB.allocated_gpu_ids.every((id) => id.startsWith('gpu-r4-'))).toBe(true);
      expect((await client.getActionStatus(build.command.command_key))?.status).toBe('failed');
    } finally { client.close(); }
  });
});
