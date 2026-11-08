import { describe, expect, it } from 'vitest';
import type { ActionCommand } from '@dcos/contracts';
import { createCoordinator } from '../src/coordinator.js';
import { createEventPublisher } from '../src/events.js';
import { classify, persistedPlanInvalidReason, resumeOpenWorkflows, type ResumeHandoff } from '../src/resume.js';
import { KILL_POINTS, WF, killable, makePlan, makeWorld, runKillPoint, type KillPoint } from '../scripts/crash-test.js';
import { withPlainErrors } from './fakes/index.js';
import { RUN_ID, loadSignalXid79Dest } from './fixtures/index.js';

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

  it.each(['coded', 'message'] as const)('a live lease rejected as a plain db-client error (%s) is left alone, not a crash', async (mode) => {
    const w = makeWorld();
    const ev = createEventPublisher({ db: w.db, runId: RUN_ID, clock: w.clock, redact: (s) => s });
    const owner = createCoordinator({ db: w.db, physics: w.physics, events: ev, workerId: 'worker-1', clock: w.clock });
    await owner.ensureWorkflow(WF, ['inc-1']);
    const report = await resumeOpenWorkflows({
      db: withPlainErrors(w.db, mode),
      physics: w.physics,
      events: ev,
      workerId: 'worker-2',
      clock: w.clock,
      sleep: async () => undefined,
    });
    expect(report.items).toEqual([expect.objectContaining({ workflow_id: WF, action: 'nothing_to_do', note: 'LEASE_HELD_BY_LIVE_WORKER' })]);
    expect((await w.db.getWorkflow(WF))?.lease_owner).toBe('worker-1');
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

describe('resume hand-off to the agent loop (continueExecute)', () => {
  const xidOnDest = (w: ReturnType<typeof makeWorld>) => {
    const sig = loadSignalXid79Dest(); // gpu-r8-n1-0, one of COOL_DEST
    w.db.injectSignal({ ...sig, sim_time_ms: w.snap.clock.sim_time_ms + 1_000 });
  };

  it('persistedPlanInvalidReason: null while valid, names the dead destination after an XID 79', async () => {
    const w = makeWorld();
    const plan = makePlan(w.snap);
    const [ck, mv] = plan.commands as [ActionCommand, ActionCommand];
    const rec = [
      { command_key: ck.command_key, ledger_status: 'succeeded', decision: 'skip' as const },
      { command_key: mv.command_key, ledger_status: null, decision: 'resubmit_same_key' as const },
    ];
    expect(await persistedPlanInvalidReason(w.db, w.physics, plan, rec)).toBeNull();
    xidOnDest(w);
    const why = await persistedPlanInvalidReason(w.db, w.physics, plan, rec);
    expect(why).toMatch(/^migrate_restart job-a now fails safety/);
    expect(why).toContain('DEST_GPU_UNHEALTHY');
  });

  it('a safety rejection while reclaiming a dead claim is blocked, so the persisted plan is replanned', async () => {
    const w = makeWorld();
    const plan = makePlan(w.snap);
    const ck = plan.commands[0]!.command_key;
    const k = killable(w.db, (m, a, p) => m === 'claimAction' && a[0] === ck && p === 'after');
    const ev1 = createEventPublisher({ db: k.db, runId: RUN_ID, clock: w.clock, redact: (s) => s });
    const c1 = createCoordinator({ db: k.db, physics: w.physics, events: ev1, workerId: 'worker-1', clock: w.clock, pollMs: 1, sleep: w.sleep });
    await c1.ensureWorkflow(WF, ['inc-1']);
    void c1.execute(WF, plan);
    await k.killed;
    w.db.rejectStart(ck, ['EVIDENCE_STALE']); // the evidence aged while nobody was watching
    w.db.advanceWallMs(60_000);

    const handoffs: ResumeHandoff[] = [];
    const ev2 = createEventPublisher({ db: w.db, runId: RUN_ID, clock: w.clock, redact: (s) => s, startSeq: 1000 });
    const report = await resumeOpenWorkflows({
      db: w.db,
      physics: w.physics,
      events: ev2,
      workerId: 'worker-2',
      clock: w.clock,
      sleep: w.sleep,
      continueExecute: async (h) => {
        handoffs.push(h);
        return { escalated: false };
      },
    });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.reconciled[0]).toMatchObject({ command_key: ck, ledger_status: 'failed', decision: 'blocked' });
    expect(handoffs[0]!.invalidReason).toContain('safety-rejected');
    expect(handoffs[0]!.invalidReason).toContain('EVIDENCE_STALE');
    expect(report.items[0]).toMatchObject({ action: 'resumed_execute', note: 'REPLANNED' });
  });

  it('XID while the agent was dead: resume hands the invalid plan over instead of executing it blind', async () => {
    const w = makeWorld();
    const plan = makePlan(w.snap);
    const ck = plan.commands[0]!.command_key;
    const k = killable(w.db, (m, a, p) => m === 'startAction' && a[0] === ck && p === 'after');
    const ev1 = createEventPublisher({ db: k.db, runId: RUN_ID, clock: w.clock, redact: (s) => s });
    const c1 = createCoordinator({ db: k.db, physics: w.physics, events: ev1, workerId: 'worker-1', clock: w.clock, pollMs: 1, sleep: w.sleep });
    await c1.ensureWorkflow(WF, ['inc-1']);
    void c1.execute(WF, plan);
    await k.killed;
    xidOnDest(w); // lands while nobody is watching
    w.db.advanceWallMs(60_000);

    const handoffs: ResumeHandoff[] = [];
    const ev2 = createEventPublisher({ db: w.db, runId: RUN_ID, clock: w.clock, redact: (s) => s, startSeq: 1000 });
    const report = await resumeOpenWorkflows({
      db: w.db,
      physics: w.physics,
      events: ev2,
      workerId: 'worker-2',
      clock: w.clock,
      sleep: w.sleep,
      continueExecute: async (h) => {
        handoffs.push(h);
        return { escalated: false };
      },
    });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.invalidReason).toContain('DEST_GPU_UNHEALTHY');
    expect(handoffs[0]!.coordinator.isOwner()).toBe(true);
    expect(handoffs[0]!.reconciled.map((r) => r.decision)).toEqual(['wait', 'resubmit_same_key']);
    expect(report.items[0]).toMatchObject({ action: 'resumed_execute', note: 'REPLANNED' });
    // resume itself submitted nothing new: the dead destination was never requested
    expect(w.db.calls.some((c) => c.method === 'requestAction' && (c.args[0] as ActionCommand).operation === 'migrate_restart')).toBe(false);
    const ev = w.db.agentEvents.find((e) => e.summary.startsWith('resumed after agent restart'));
    expect(ev?.summary).toContain('persisted plan is invalid on a fresh snapshot');
  });
});
