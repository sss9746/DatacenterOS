import { describe, expect, it } from 'vitest';
import type { ActionCommand } from '@dcos/contracts';
import { createCoordinator } from '../src/coordinator.js';
import { createEventPublisher } from '../src/events.js';
import { classify, resumeOpenWorkflows } from '../src/resume.js';
import { KILL_POINTS, WF, killable, makePlan, makeWorld, runKillPoint, type KillPoint } from '../scripts/crash-test.js';
import { RUN_ID } from './fixtures/index.js';

const failed = (checks: Array<{ name: string; ok: boolean; detail: string }>) =>
  checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);

describe('resume: kill points a–e (ARCHITECTURE §6)', () => {
  it.each(Object.keys(KILL_POINTS) as KillPoint[])('kill point (%s): resumes to one checkpoint + one move', async (point) => {
    const r = await runKillPoint(point);
    expect(failed(r.checks)).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.report?.duplicates_detected).toBe(0);
    expect(r.report?.worker_id).toBe('worker-2');
  });
});

describe('resume', () => {
  it('resumed run emits the resume event naming what was skipped and what continues', async () => {
    const r = await runKillPoint('e');
    const ev = r.world.db.agentEvents.find((e) => e.summary.startsWith('resumed after agent restart'));
    expect(ev?.stage).toBe('execute');
    expect(ev?.workflow_id).toBe(WF);
    expect(ev?.summary).toContain('checkpoint job-a already succeeded (skipped)');
    expect(ev?.summary).toContain('continuing to migrate_restart job-a');
    expect(ev?.tool_calls.map((t) => t.tool)).toEqual(['get_action_status', 'get_action_status']);
  });

  it('a second worker cannot steal a live lease', async () => {
    const w = makeWorld();
    const plan = makePlan(w.snap);
    const ck = plan.commands[0]?.command_key as string;
    // worker-1 is alive and mid-checkpoint (its execute is parked at start_action's ack)
    const live = killable(w.db, (m, a, p) => m === 'startAction' && a[0] === ck && p === 'after');
    const ev1 = createEventPublisher({ db: live.db, runId: RUN_ID, clock: w.clock, redact: (s) => s });
    const c1 = createCoordinator({ db: live.db, physics: w.physics, events: ev1, workerId: 'worker-1', clock: w.clock, pollMs: 1, sleep: w.sleep });
    await c1.ensureWorkflow(WF, ['inc-1']);
    void c1.execute(WF, plan);
    await live.killed;
    // a heartbeat-capable handle for worker-1 on the real DB (same owner may re-claim its own lease)
    const hb = createCoordinator({ db: w.db, physics: w.physics, events: ev1, workerId: 'worker-1', clock: w.clock });
    await hb.ensureWorkflow(WF, ['inc-1']);
    const ledgerBefore = JSON.stringify(w.db.listActions());

    const ev2 = createEventPublisher({ db: w.db, runId: RUN_ID, clock: w.clock, redact: (s) => s });
    const report = await resumeOpenWorkflows({
      db: w.db,
      physics: w.physics,
      events: ev2,
      workerId: 'worker-2',
      clock: w.clock,
      sleep: async (ms) => {
        w.db.advanceWallMs(ms * 4); // without heartbeats the lease would lapse while worker-2 waits
        await hb.heartbeatOnce();
      },
    });
    expect(report.items).toEqual([expect.objectContaining({ workflow_id: WF, action: 'nothing_to_do', note: 'LEASE_HELD_BY_LIVE_WORKER', reconciled: [] })]);
    expect((await w.db.getWorkflow(WF))?.lease_owner).toBe('worker-1');
    expect(JSON.stringify(w.db.listActions())).toBe(ledgerBefore);
    expect(w.db.calls.some((c) => c.method === 'claimAction' && c.args[2] === 'worker-2')).toBe(false);
  });

  it('claimed action on a DB that never releases claims -> needs_operator, escalated, no duplicate', async () => {
    const r = await runKillPoint('c', { claimLeaseMs: 10 * 60_000 });
    const item = r.report?.items[0];
    expect(item?.reconciled[0]).toMatchObject({ ledger_status: 'claimed', decision: 'needs_operator' });
    expect(item?.action).toBe('escalated');
    expect(r.report?.duplicates_detected).toBe(0);
    const ck = r.plan.commands[0] as ActionCommand;
    expect(r.world.db.calls.filter((c) => c.method === 'requestAction' && (c.args[0] as ActionCommand).command_key === ck.command_key)).toHaveLength(1);
    expect((await r.world.db.getWorkflow(WF))?.stage).toBe('escalated');
  });

  it('workflow in a pre-execute stage is taken over for the main loop; escalated is left alone', async () => {
    const w = makeWorld();
    const ev = createEventPublisher({ db: w.db, runId: RUN_ID, clock: w.clock, redact: (s) => s });
    const a = createCoordinator({ db: w.db, physics: w.physics, events: ev, workerId: 'worker-1', clock: w.clock });
    await a.ensureWorkflow('wf-triage', ['inc-1']);
    await a.updateStage('triage', { note: 'mid-triage' });
    const b = createCoordinator({ db: w.db, physics: w.physics, events: ev, workerId: 'worker-1', clock: w.clock });
    await b.ensureWorkflow('wf-esc', ['inc-2']);
    await b.updateStage('escalated', {});
    w.db.advanceWallMs(16_000);
    const report = await resumeOpenWorkflows({ db: w.db, physics: w.physics, events: ev, workerId: 'worker-2', clock: w.clock, sleep: w.sleep });
    const by = Object.fromEntries(report.items.map((i) => [i.workflow_id, i.action]));
    expect(by).toEqual({ 'wf-triage': 'took_over', 'wf-esc': 'nothing_to_do' });
    expect((await w.db.getWorkflow('wf-triage'))?.lease_owner).toBe('worker-2');
    expect((await w.db.getWorkflow('wf-esc'))?.lease_owner).toBe('worker-1');
  });

  it('classify maps ledger statuses to reconcile decisions', () => {
    const s = (status: string, reason_code: string | null = null) =>
      ({ status, reason_code, version: 1, result: {} }) as unknown as Parameters<typeof classify>[0];
    expect(classify(null)).toBe('resubmit_same_key');
    expect(classify(s('succeeded'))).toBe('skip');
    expect(classify(s('running'))).toBe('wait');
    expect(classify(s('requested'))).toBe('claim_start');
    expect(classify(s('claimed'))).toBe('reclaim_after_timeout');
    expect(classify(s('failed', 'SAFETY_REJECTED'))).toBe('blocked');
    expect(classify(s('failed', 'DEST_DIED'))).toBe('needs_operator');
  });
});
