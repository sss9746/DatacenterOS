import { describe, expect, it } from 'vitest';
import { createMockClient } from '@dcos/db-client';
import { evaluateSafety } from '@dcos/physics';
import { appendTrail, DashboardStore } from '../src/data/dashboard';
import { loadRecoveryExample } from '../src/data/recovery-example';
import { jobMoveTimeline } from '../src/components/jobs/move-timeline';
import { createLocalPhysicsClient } from '../src/data/local-physics';
import { buildFaultInjection } from '../src/components/controls/fault-form';

const settle = () => new Promise((r) => setTimeout(r, 40));

describe('jobMoveTimeline (recovery example: checkpoint → move in flight → landed)', () => {
  it('shows job-a moving from racks 2+3 to 1+5 from its fresh checkpoint, then running on the new GPUs', async () => {
    const client = createMockClient({ snapshot: 'pump_degraded', evaluateSafety });
    const store = new DashboardStore(client);
    try {
      await loadRecoveryExample(client);
      await store.refresh(); store.start(); await settle();
      const moving = jobMoveTimeline('job-a', store.state);
      expect(moving).not.toBeNull();
      expect(moving!.kind).toBe('move'); expect(moving!.phase).toBe('moving');
      expect(moving!.from?.racks).toEqual([2, 3]); expect(moving!.to?.racks).toEqual([1, 5]);
      expect(moving!.checkpoint?.status).toBe('complete');
      expect(moving!.arcLabel).toMatch(/^job-a → R1\+R5 · from checkpoint ckpt-/);
      expect(moving!.steps.map((s) => s.state)).toEqual(['done', 'done', 'active', 'pending', 'pending']);
      expect(moving!.lostWorkUnits).toBeNull(); // nothing dropped yet: no fabricated loss
      client.tick(120_000); await settle(); await store.refresh(); await settle();
      const landed = jobMoveTimeline('job-a', store.state)!;
      expect(landed.phase).toBe('running');
      expect(landed.from?.racks).toEqual([2, 3]); expect(landed.to?.racks).toEqual([1, 5]);
      expect(landed.steps.every((s) => s.state === 'done')).toBe(true);
      expect(landed.steps[4]!.detail).toMatch(/^Resumed from checkpoint ckpt-.* saved\)$/); // mock drops no work → no "lost"
      expect(jobMoveTimeline('job-c', store.state)).toBeNull();
    } finally { store.close(); }
  });
});

describe('jobMoveTimeline (local physics: GPU dies before a checkpoint → rollback)', () => {
  it('reports the rollback with lost work = progress before − durable, both observed', async () => {
    const client = createLocalPhysicsClient();
    const store = new DashboardStore(client);
    try {
      await store.refresh();
      const before = store.state.snapshot!.job_states.find((j) => j.job_id === 'job-a')!;
      await client.injectFault(buildFaultInjection({ runId: before.run_id, simTimeMs: before.last_update_sim_time_ms, faultId: 'judge-x', fault: 'gpu_xid_79', targetId: 'gpu-r3-n1-0', delayS: 0 }));
      client.tick(); await store.refresh();
      const t = jobMoveTimeline('job-a', store.state)!;
      expect(t.kind).toBe('rollback'); expect(t.phase).toBe('rolled_back');
      expect(t.lostWorkUnits).toBe(before.progress_work_units - before.durable_work_units);
      expect(t.from?.racks).toEqual([2, 3]); expect(t.to).toBeNull();
      expect(t.steps[0]).toMatchObject({ label: 'GPU failed', state: 'done' });
      expect(t.steps[1]!.label).toBe('Rolled back to checkpoint');
      expect(t.steps[2]!.detail).toBe('awaiting a recovery plan');
    } finally { store.close(); }
  });
  it('omits numbers that were never observed (no trail: opened mid-failure)', async () => {
    const client = createLocalPhysicsClient();
    try {
      const s0 = await client.getObservedSnapshot();
      await client.injectFault(buildFaultInjection({ runId: s0.run_id, simTimeMs: s0.clock.sim_time_ms, faultId: 'judge-y', fault: 'gpu_xid_79', targetId: 'gpu-r3-n1-0', delayS: 0 }));
      client.tick();
      const snapshot = await client.getObservedSnapshot();
      const t = jobMoveTimeline('job-a', { snapshot, actionDetails: [], jobTrail: {} })!;
      expect(t.kind).toBe('rollback');
      expect(t.lostWorkUnits).toBeNull(); expect(t.progressAtMove).toBeNull();
      expect(t.steps[0]!.detail).toBeNull();
      expect(t.from).toBeNull(); // the failed job holds no GPUs and nothing earlier was seen
    } finally { client.close(); }
  });
});

describe('appendTrail', () => {
  const job = { status: 'running' as const, allocated_gpu_ids: ['gpu-r2-n1-0'], progress_work_units: 100, durable_work_units: 80, latest_checkpoint_id: 'c1' };
  it('records only changes and keeps the progress seen just before each one', () => {
    const t1 = appendTrail(undefined, job, 1000, null);
    const t2 = appendTrail(t1, { ...job, progress_work_units: 120 }, 2000, 100);
    expect(t2).toBe(t1); // nothing changed
    const t3 = appendTrail(t2, { ...job, status: 'failed', allocated_gpu_ids: [], progress_work_units: 80 }, 3000, 120);
    expect(t3).toHaveLength(2); expect(t3[1]).toMatchObject({ status: 'failed', progress_before: 120, durable: 80, gpu_ids: [] });
    expect(t1).toHaveLength(1); // immutable
  });
});
