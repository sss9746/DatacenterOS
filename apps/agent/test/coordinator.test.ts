import { describe, expect, it, vi } from 'vitest';
import type { ActionCommand, ObservedSnapshot, PlanCandidate } from '@dcos/contracts';
import { createCoordinator, type ExecutablePlan, type ExecuteState } from '../src/coordinator.js';
import { createEventPublisher } from '../src/events.js';
import { DbError, type PhysicsPort } from '../src/ports.js';
import { buildCommand } from '../src/tools/command.js';
import { FakeDb, FakePhysics } from './fakes/index.js';
import { RUN_ID, gpuId, loadPumpDegradedSnapshot } from './fixtures/index.js';

const WF = 'wf-1';
const r = (rack: number) => Array.from({ length: 8 }, (_, g) => gpuId(rack, g));
const COOL_DEST = [...r(7), ...r(8)];

function makePlan(snap: ObservedSnapshot, dest: string[] = COOL_DEST, extra: (keys: string[]) => ActionCommand[] = () => []): ExecutablePlan {
  const ctx = { runId: RUN_ID, workflowId: WF, incidentIds: ['inc-1'] as [string], planId: 'plan-1' };
  const ck = buildCommand({ operation: 'checkpoint', target_resource_id: 'job-a', job_id: 'job-a' }, snap, ctx);
  const mv = buildCommand(
    {
      operation: 'migrate_restart',
      target_resource_id: 'job-a',
      job_id: 'job-a',
      arguments: { destination_gpu_ids: dest },
      depends_on_command_keys: [ck.command_key],
    },
    snap,
    ctx,
  );
  const commands = [ck, mv, ...extra([ck.command_key, mv.command_key])];
  const plan: PlanCandidate = {
    schema_version: '1.1.0',
    plan_id: 'plan-1',
    run_id: RUN_ID,
    workflow_id: WF,
    incident_ids: ['inc-1'],
    based_on_decision_epoch: snap.clock.decision_epoch,
    assumptions: [],
    command_keys: commands.map((c) => c.command_key) as [string, ...string[]],
    expected_completion_delay_sim_s: 150,
    expected_lost_work_units: 0,
    expected_gpu_busy_waste_s: 0,
    failure_risk_estimate: 0.02,
    explanation: 'checkpoint then move job-a off the hot loop',
  };
  return { plan, commands };
}

function cordonCmd(snap: ObservedSnapshot, gpu: string, deps: string[] = []): ActionCommand {
  return buildCommand({ operation: 'cordon_gpu', target_resource_id: gpu, depends_on_command_keys: deps }, snap, {
    runId: RUN_ID,
    workflowId: WF,
    incidentIds: ['inc-1'],
    planId: 'plan-1',
  });
}

function setup(opts: { coordPhysics?: PhysicsPort; onSleep?: () => Promise<void> | void; onLost?: (r: string) => void } = {}) {
  const physics = new FakePhysics();
  const snap = loadPumpDegradedSnapshot();
  const db = new FakeDb({ snapshot: snap, physics });
  let sim = snap.clock.sim_time_ms;
  const clock = { unixMs: () => 0, simTimeMs: () => sim };
  const events = createEventPublisher({ db, runId: RUN_ID, clock, redact: (s) => s });
  const tick = (ms: number) => {
    db.tick(ms);
    sim += ms;
  };
  const coord = createCoordinator({
    db,
    physics: opts.coordPhysics ?? physics,
    events,
    workerId: 'worker-1',
    clock,
    pollMs: 1,
    sleep: async () => {
      tick(1000);
      await opts.onSleep?.();
    },
    ...(opts.onLost ? { onLostOwnership: opts.onLost } : {}),
  });
  return { db, physics, events, coord, clock, snap, tick };
}

const requestedKeys = (db: FakeDb) =>
  db.calls.filter((c) => c.method === 'requestAction').map((c) => (c.args[0] as ActionCommand).command_key);

const allowAll = (inner: PhysicsPort): PhysicsPort => ({
  simulatePlan: (o, p, x) => inner.simulatePlan(o, p, x),
  thresholdPolicy: (o) => inner.thresholdPolicy(o),
  evaluateSafety: (obs, cmd, ctx) => ({
    schema_version: '1.1.0',
    run_id: obs.run_id,
    plan_id: cmd.plan_id,
    action_id: cmd.action_id,
    decision: 'allow',
    checked_decision_epoch: ctx.decision_epoch,
    violations: [],
    checked_resource_ids: [],
    evidence: {},
  }),
});

describe('coordinator.execute', () => {
  it('happy path: checkpoint then migrate job-a, each command_key in the ledger exactly once', async () => {
    const { db, coord, snap } = setup();
    const p = makePlan(snap);
    await coord.ensureWorkflow(WF, ['inc-1']);
    const res = await coord.execute(WF, p);

    expect(res.aborted).toBe(false);
    expect(res.outcomes.map((o) => [o.operation, o.status])).toEqual([
      ['checkpoint', 'succeeded'],
      ['migrate_restart', 'succeeded'],
    ]);
    const keys = p.commands.map((c) => c.command_key);
    expect(requestedKeys(db)).toEqual(keys);
    expect(db.listActions().map((a) => a.command_key)).toEqual(keys);
    const after = await db.getObservedSnapshot();
    expect(after.job_states.find((j) => j.job_id === 'job-a')?.allocated_gpu_ids.sort()).toEqual([...COOL_DEST].sort());
    expect(res.baseline?.durable_work_units['job-a']).toBe(400_000);
  });

  it('only starts the migrate after its checkpoint succeeded', async () => {
    const { db, coord, snap } = setup();
    const p = makePlan(snap);
    await coord.execute(WF, p);
    const [ck, mv] = p.commands.map((c) => c.command_key);
    const ckDone = db.actionEvents.findIndex((e) => e.command_key === ck && e.status === 'succeeded');
    const mvReq = db.actionEvents.findIndex((e) => e.command_key === mv && e.status === 'requested');
    expect(ckDone).toBeGreaterThanOrEqual(0);
    expect(mvReq).toBeGreaterThan(ckDone);
  });

  it('persists workflow state after every transition with completed_keys', async () => {
    const { db, coord, snap } = setup();
    const p = makePlan(snap);
    await coord.execute(WF, p);
    const [ck, mv] = p.commands.map((c) => c.command_key);
    const states = db.calls.filter((c) => c.method === 'updateWorkflow').map((c) => ({ stage: c.args[3], st: c.args[4] as ExecuteState }));
    // first write is ensureWorkflow recording the incident ids; every later one is an execute transition
    expect(states[0]?.stage).toBe('idle');
    expect(states.slice(1).every((s) => s.stage === 'execute')).toBe(true);
    const ckStatuses = states.filter((s) => s.st.current_command_key === ck).map((s) => s.st.current_status);
    for (const st of ['requested', 'claimed', 'running', 'succeeded']) expect(ckStatuses).toContain(st);
    // migrate entries see the checkpoint as completed
    const mvState = states.find((s) => s.st.current_command_key === mv && s.st.current_status === 'requested');
    expect(mvState?.st.completed_keys).toEqual([ck]);
    const wf = await db.getWorkflow(WF);
    const final = wf?.state as ExecuteState;
    expect(wf?.stage).toBe('execute');
    expect(final.plan_id).toBe('plan-1');
    expect(final.completed_keys).toEqual([ck, mv]);
    expect(final.command_keys).toEqual([ck, mv]);
    expect(final.current_command_key).toBeNull();
    expect(final.blocked).toEqual([]);
    expect(final.incident_ids).toContain('inc-1');
    // persisted migrate payload is the one submitted (re-stamped job version) so resume reuses it verbatim
    const submittedMv = db.calls.find((c) => c.method === 'requestAction' && (c.args[0] as ActionCommand).command_key === mv)?.args[0];
    expect(final.commands[1]).toEqual(submittedMv);
  });

  it('emits execute events with tool-call summaries', async () => {
    const { db, coord, snap } = setup();
    await coord.execute(WF, makePlan(snap));
    const exec = db.agentEvents.filter((e) => e.stage === 'execute');
    expect(exec.length).toBeGreaterThanOrEqual(4);
    const tools = exec.flatMap((e) => e.tool_calls.map((t) => `${t.tool}(${t.args_summary}) → ${t.result_summary}`));
    expect(tools.some((t) => t.startsWith('request_action(checkpoint job-a)'))).toBe(true);
    expect(tools.some((t) => t.startsWith('start_action(') && t.endsWith('running'))).toBe(true);
    expect(exec.every((e) => e.workflow_id === WF && e.incident_id === 'inc-1')).toBe(true);
  });

  it('re-running the same plan after success skips everything as succeeded (no new ledger rows)', async () => {
    const { db, coord, snap } = setup();
    const p = makePlan(snap);
    await coord.execute(WF, p);
    const before = db.listActions().length;
    const reqBefore = requestedKeys(db).length;
    const again = await coord.execute(WF, p);
    expect(again.outcomes.map((o) => [o.status, o.reason_code])).toEqual([
      ['succeeded', 'ALREADY_SUCCEEDED'],
      ['succeeded', 'ALREADY_SUCCEEDED'],
    ]);
    expect(db.listActions().length).toBe(before);
    expect(requestedKeys(db).length).toBe(reqBefore);
  });

  it('local pre-check blocks a destination on rack r6; nothing submitted; dependents skipped', async () => {
    const { db, coord, snap } = setup();
    const dest = [...r(6), ...r(7)];
    const p = makePlan(snap, dest, ([, mv]) => [cordonCmd(snap, gpuId(2, 6), [mv as string])]);
    const res = await coord.execute(WF, p);
    const [ck, mv, cd] = res.outcomes;
    expect(ck?.status).toBe('succeeded');
    expect(mv?.status).toBe('blocked');
    expect(mv?.violations).toEqual(expect.arrayContaining(['DEST_GPU_BUSY', 'DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT']));
    expect(cd?.status).toBe('skipped');
    expect(requestedKeys(db)).toEqual([p.commands[0]?.command_key]);
    const safety = db.agentEvents.filter((e) => e.stage === 'safety');
    expect(safety).toHaveLength(1);
    expect(safety[0]?.summary).toContain('BLOCKED');
    const st = (await db.getWorkflow(WF))?.state as ExecuteState;
    expect(st.blocked[0]?.command_key).toBe(mv?.command_key);
    expect(st.skipped).toEqual([cd?.command_key]);
  });

  it('local pre-check blocks an unhealthy destination GPU', async () => {
    const { db, coord, snap } = setup();
    db.mutateSnapshot((s) => {
      const g = s.gpus.find((x) => x.resource_id === gpuId(7, 3));
      if (g) {
        g.availability = 'unreachable';
        g.last_xid_code = 79;
      }
    });
    const res = await coord.execute(WF, makePlan(snap));
    expect(res.outcomes[1]?.status).toBe('blocked');
    expect(res.outcomes[1]?.violations).toContain('DEST_GPU_UNHEALTHY');
    expect(requestedKeys(db)).toHaveLength(1);
  });

  it('a safety rejection RETURNED by the DB is recorded as blocked', async () => {
    const inner = new FakePhysics();
    const { db, coord, snap } = setup({ coordPhysics: allowAll(inner) });
    const p = makePlan(snap, [...r(6), ...r(7)]);
    const res = await coord.execute(WF, p);
    expect(res.outcomes[1]?.status).toBe('blocked');
    expect(res.outcomes[1]?.violations).toContain('DEST_GPU_BUSY');
    const mvKey = p.commands[1]?.command_key as string;
    expect(requestedKeys(db)).toContain(mvKey);
    const ledger = await db.getActionStatus(mvKey);
    expect(ledger?.reason_code).toBe('SAFETY_REJECTED');
    expect(db.calls.some((c) => c.method === 'claimAction' && c.args[0] === mvKey)).toBe(false);
    // re-run: the persisted rejection is adopted, not resubmitted
    const again = await coord.execute(WF, p);
    expect(again.outcomes[1]?.status).toBe('blocked');
    expect(requestedKeys(db).filter((k) => k === mvKey)).toHaveLength(1);
  });

  it('COMMAND_KEY_COLLISION from requestAction fails the command with that code (no retry)', async () => {
    const { db, coord, snap } = setup();
    const spy = vi.spyOn(db, 'requestAction').mockRejectedValueOnce(new DbError('COMMAND_KEY_COLLISION', 'dup'));
    const res = await coord.execute(WF, makePlan(snap));
    expect(res.outcomes[0]).toMatchObject({ status: 'failed', reason_code: 'COMMAND_KEY_COLLISION' });
    expect(res.outcomes[1]?.status).toBe('skipped');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('shouldAbort stops before the next command', async () => {
    const { db, coord, snap } = setup();
    const p = makePlan(snap);
    const ck = p.commands[0]?.command_key as string;
    const res = await coord.execute(WF, p, { shouldAbort: () => db.listActions().some((a) => a.command_key === ck && a.status === 'succeeded') });
    expect(res.aborted).toBe(true);
    expect(res.outcomes.map((o) => o.status)).toEqual(['succeeded', 'aborted']);
    expect(requestedKeys(db)).toEqual([ck]);
    const st = (await db.getWorkflow(WF))?.state as ExecuteState;
    expect(st.aborted).toBe(true);
    expect(st.completed_keys).toEqual([ck]);
  });

  it('resume: running action from a previous owner is waited on, not resubmitted', async () => {
    const { db, coord, snap } = setup();
    const p = makePlan(snap);
    const ck = p.commands[0] as ActionCommand;
    const s = await db.requestAction(ck);
    const { fencing_token } = await db.claimAction(ck.command_key, s.version, 'old-worker');
    await db.startAction(ck.command_key, fencing_token);
    const res = await coord.execute(WF, p);
    expect(res.outcomes.map((o) => o.status)).toEqual(['succeeded', 'succeeded']);
    expect(requestedKeys(db).filter((k) => k === ck.command_key)).toHaveLength(1);
    expect(db.calls.filter((c) => c.method === 'claimAction' && c.args[0] === ck.command_key)).toHaveLength(1);
  });
});

describe('coordinator lease', () => {
  it('ensureWorkflow creates at v0 and takes over an expired lease', async () => {
    const a = setup();
    const lease = await a.coord.ensureWorkflow(WF, ['inc-1']);
    expect(lease.workflow.lease_owner).toBe('worker-1');
    expect(lease.workflow.incident_ids).toEqual(['inc-1']);
    const other = createCoordinator({ db: a.db, physics: a.physics, events: a.events, workerId: 'worker-2', clock: a.clock });
    await expect(other.ensureWorkflow(WF, ['inc-1'])).rejects.toMatchObject({ code: 'LEASE_HELD' });
    a.db.advanceWallMs(16_000);
    const taken = await other.ensureWorkflow(WF, ['inc-1']);
    expect(taken.workflow.lease_owner).toBe('worker-2');
  });

  it('heartbeat keeps the lease; expiry signals lost ownership', async () => {
    const lostReasons: string[] = [];
    const a = setup({ onLost: (r) => lostReasons.push(r) });
    await a.coord.ensureWorkflow(WF, ['inc-1']);
    a.db.advanceWallMs(10_000);
    expect(await a.coord.heartbeatOnce()).toBe(true);
    a.db.advanceWallMs(10_000); // 20 s after claim but only 10 s after heartbeat
    expect(await a.coord.heartbeatOnce()).toBe(true);
    a.db.advanceWallMs(16_000);
    expect(await a.coord.heartbeatOnce()).toBe(false);
    expect(lostReasons).toEqual(['LEASE_EXPIRED']);
    expect(a.coord.isOwner()).toBe(false);
  });

  it('startHeartbeat beats every leaseMs/3', async () => {
    vi.useFakeTimers();
    try {
      const a = setup();
      await a.coord.ensureWorkflow(WF, ['inc-1']);
      a.coord.startHeartbeat();
      await vi.advanceTimersByTimeAsync(15_001);
      a.coord.stopHeartbeat();
      expect(a.db.calls.filter((c) => c.method === 'heartbeatWorkflow')).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lost lease mid-checkpoint stops execution; the migrate is never requested', async () => {
    const lost: string[] = [];
    let n = 0;
    let coordRef: ReturnType<typeof setup>['coord'] | null = null;
    let dbRef: FakeDb | null = null;
    const a = setup({
      onLost: (r) => lost.push(r),
      onSleep: async () => {
        if (++n !== 5 || !dbRef || !coordRef) return;
        dbRef.advanceWallMs(16_000);
        const thief = createCoordinator({ db: dbRef, physics: new FakePhysics(), events: a.events, workerId: 'worker-2', clock: a.clock });
        await thief.ensureWorkflow(WF, ['inc-1']);
        await coordRef.heartbeatOnce(); // what the heartbeat timer would do
      },
    });
    coordRef = a.coord;
    dbRef = a.db;
    const p = makePlan(a.snap);
    await a.coord.ensureWorkflow(WF, ['inc-1']);
    const res = await a.coord.execute(WF, p);
    expect(res.aborted).toBe(true);
    expect(res.outcomes.map((o) => o.status)).toEqual(['aborted', 'aborted']);
    expect(lost).toEqual(['STALE_FENCING_TOKEN']);
    expect(requestedKeys(a.db)).toEqual([p.commands[0]?.command_key]);
    // the in-flight checkpoint keeps running under DB supervision
    expect((await a.db.getActionStatus(p.commands[0]?.command_key as string))?.status).toBe('running');
    // and a second execute does not silently re-claim
    const again = await a.coord.execute(WF, p);
    expect(again.aborted).toBe(true);
    expect((await a.db.getWorkflow(WF))?.lease_owner).toBe('worker-2');
  });
});
