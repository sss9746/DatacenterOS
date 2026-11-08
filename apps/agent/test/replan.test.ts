import type { ActionCommand, ObservedSnapshot } from '@dcos/contracts';
import { describe, expect, it } from 'vitest';
import { createCoordinator } from '../src/coordinator.js';
import { createEventPublisher } from '../src/events.js';
import { planIncidents, type PlanResult } from '../src/planner.js';
import type { LlmChatRequest } from '../src/ports.js';
import { CHOOSE_OPTIONS_TOOL_NAME } from '../src/prompts/planner.js';
import { createReplanWatcher, runReplan } from '../src/replan.js';
import { runTriage } from '../src/triage.js';
import { FakeDb, FakeLlm, FakePhysics } from './fakes/index.js';
import { RUN_ID, loadPumpDegradedSnapshot, loadSignalXid79Dest, loadSignalXid79R7 } from './fixtures/index.js';

const WF = 'wf-1';
const XID_GPU = 'gpu-r8-n1-0';
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

type PlanningInput = { jobs: { job_id: string; options: { option_id: string }[] }[] };

/** Nemotron stand-in: `pickA` chooses job-a's option; every other job gets its rank-1 option. */
const nemotron = (pickA: (opts: { option_id: string }[]) => string | undefined) => (req: LlmChatRequest) => {
  const user = req.messages.find((m) => m.role === 'user');
  const text = user && 'content' in user ? String(user.content) : '';
  const input = JSON.parse(text.slice(text.indexOf('PLANNING_INPUT=') + 'PLANNING_INPUT='.length)) as PlanningInput;
  return FakeLlm.toolCall(CHOOSE_OPTIONS_TOOL_NAME, {
    choices: input.jobs.map((j) => ({
      job_id: j.job_id,
      option_id: (j.job_id === 'job-a' ? pickA(j.options) : undefined) ?? j.options[0]!.option_id,
      needs_approval: false,
      explanation: 'test choice',
    })),
  });
};
/** Initial plan: job-a goes to r1+r8, so the XID fixture hits a planned destination. */
const chooseR8 = nemotron(() => 'job-a:ckpt+move:r1+r8');
/** Replan: job-a takes its best-ranked eligible move. */
const chooseMove = nemotron((opts) => opts.find((o) => o.option_id.includes('move'))?.option_id);

const dests = (cmds: ActionCommand[], jobId?: string): string[] =>
  cmds
    .filter((c) => c.operation === 'migrate_restart' && (!jobId || c.job_id === jobId))
    .flatMap((c) => c.arguments.destination_gpu_ids as string[]);

function noDoubleAllocation(snap: ObservedSnapshot): void {
  const owner = new Map<string, string>();
  for (const a of snap.allocations) {
    const prev = owner.get(a.gpu_id);
    if (prev !== undefined) expect(prev, `${a.gpu_id} allocated to ${prev} and ${a.job_id}`).toBe(a.job_id);
    owner.set(a.gpu_id, a.job_id);
  }
  for (const j of snap.job_states) for (const g of j.allocated_gpu_ids) expect(owner.get(g) ?? j.job_id).toBe(j.job_id);
}

async function setup() {
  const physics = new FakePhysics();
  const snap = loadPumpDegradedSnapshot();
  const db = new FakeDb({ snapshot: snap, physics });
  let onSleep: (() => void) | null = null;
  const clock = { unixMs: () => 0, simTimeMs: () => 0 };
  const events = createEventPublisher({ db, runId: RUN_ID, clock, redact: (s) => s });
  const coord = createCoordinator({
    db,
    physics,
    events,
    workerId: 'worker-1',
    clock,
    pollMs: 1,
    sleep: async () => {
      db.tick(1000);
      const f = onSleep;
      onSleep = null;
      f?.();
    },
  });
  const triage = await runTriage({ db, llm: null, now: () => 0 });
  const plan = await planIncidents(
    { db, physics, llm: new FakeLlm([chooseR8]), workflowId: WF, runId: RUN_ID, attempt: 1 },
    { incidents: triage.incidents },
  );
  await coord.ensureWorkflow(WF, [...plan.plan.incident_ids]);
  const replanDeps = (llm: FakeLlm | null = null) => ({
    db,
    physics,
    llm,
    events,
    workflowId: WF,
    runId: RUN_ID,
    workerId: 'worker-1',
    fencingToken: coord.lease()!.fencing_token,
    now: () => 0,
  });
  return { db, physics, events, coord, plan, triage, replanDeps, setOnSleep: (f: () => void) => (onSleep = f) };
}

const keyOf = (p: PlanResult, op: string, job = 'job-a') => p.commands.find((c) => c.operation === op && c.job_id === job)!.command_key;

describe('replan on XID 79 at a planned destination (mid-checkpoint)', () => {
  it('aborts before the migrate, opens a second incident, and moves job-a elsewhere with new keys', async () => {
    const { db, coord, plan, triage, replanDeps, setOnSleep } = await setup();
    expect(dests(plan.commands, 'job-a')).toContain(XID_GPU);
    const ckptKey = keyOf(plan, 'checkpoint');
    const moveKey = keyOf(plan, 'migrate_restart');

    const watcher = createReplanWatcher({ db }, plan);
    await flush();
    expect(watcher.shouldAbort()).toBe(false);

    // XID arrives while the checkpoint is running.
    setOnSleep(() => db.injectSignal(loadSignalXid79Dest()));
    const exec = await coord.execute(WF, plan, { shouldAbort: () => watcher.shouldAbort() });
    expect(watcher.shouldAbort()).toBe(true);
    expect(watcher.reason()).toContain(XID_GPU);
    expect(watcher.reason()).toContain('XID 79');
    expect(watcher.reason()).toContain('planned destination for job-a');

    expect(exec.aborted).toBe(true);
    expect(exec.outcomes.find((o) => o.command_key === ckptKey)?.status).toBe('succeeded');
    expect(exec.outcomes.find((o) => o.command_key === moveKey)).toMatchObject({ status: 'aborted', reason_code: 'REPLAN_REQUESTED' });
    expect(await db.getActionStatus(moveKey)).toBeNull(); // never submitted

    // Triage's LLM call fails (deterministic grouping); Nemotron then picks job-a's best-ranked move.
    const llm = new FakeLlm([new Error('triage LLM down'), chooseMove]);
    const out = await runReplan(replanDeps(llm), { previous: plan, execution: exec, attempt: 2, reason: watcher.reason()! });
    watcher.dispose();

    // second, separate incident for the XID
    expect(out.new_incident_ids).toHaveLength(1);
    const xidIncident = out.new_incident_ids[0]!;
    expect(triage.incidents.map((i) => i.incident_id)).not.toContain(xidIncident);
    expect(db.incidents.size).toBe(2);
    expect(db.links.some((l) => l.incident_id === xidIncident && l.linked_id.includes(XID_GPU))).toBe(true);
    expect(out.new_plan.plan.incident_ids).toEqual(expect.arrayContaining([...plan.plan.incident_ids, xidIncident]));

    // new destination, new keys, completed checkpoint kept (not cancelled, not re-run under its old key)
    const newDest = dests(out.new_plan.commands, 'job-a');
    const jobA = out.new_plan.job_plans.find((j) => j.job_id === 'job-a')!;
    expect(jobA.decided_by).toBe('nemotron');
    // no job-a option at all (chosen or alternative) targets the failed destination
    for (const o of [jobA.chosen, ...jobA.alternatives]) expect(dests(o.commands)).not.toContain(XID_GPU);
    expect(newDest).toHaveLength(16);
    expect(newDest).not.toContain(XID_GPU);
    expect(newDest.some((g) => g.startsWith('gpu-r8-'))).toBe(false);
    for (const c of out.new_plan.commands) expect(c.command_key.endsWith(':2')).toBe(true);
    // the completed checkpoint is fresh, so the new plan reuses it instead of taking another
    for (const o of [jobA.chosen, ...jobA.alternatives]) expect(o.commands.map((c) => c.operation)).not.toContain('checkpoint');
    expect(out.new_plan.commands.filter((c) => c.job_id === 'job-a' && c.operation === 'checkpoint')).toEqual([]);
    expect(jobA.chosen.label).toContain('reusing fresh checkpoint');
    expect(out.new_plan.commands.map((c) => c.command_key)).not.toContain(ckptKey);
    expect(out.kept_keys).toContain(ckptKey);
    expect(out.cancelled_keys).toEqual([]);
    expect((await db.getActionStatus(ckptKey))?.status).toBe('succeeded');
    expect(out.previous_plan_id).toBe(plan.plan.plan_id);
    expect(out.new_plan.plan.plan_id).not.toBe(plan.plan.plan_id);

    // workflow persisted as superseded + linked to the new incident
    const wf = await db.getWorkflow(WF);
    expect(wf?.stage).toBe('replan');
    expect(wf?.state).toMatchObject({ previous_plan_id: plan.plan.plan_id, superseded: true, cancelled_keys: [], new_plan_id: out.new_plan.plan.plan_id });
    expect(wf?.incident_ids).toContain(xidIncident);
    expect(db.agentEvents.some((e) => e.stage === 'replan' && e.summary.includes(XID_GPU))).toBe(true);
    // F-NV1: the announce is deterministic code; the decision event is Nemotron's own sentence (LLM chose the plan)
    const replanEvents = db.agentEvents.filter((e) => e.stage === 'replan');
    expect(replanEvents[0]?.actor).toBe('code');
    const decision = replanEvents[replanEvents.length - 1]!;
    expect(decision.actor).toBe('nemotron');
    expect(decision.summary).toContain('test choice');
    expect(decision.summary.length).toBeLessThanOrEqual(200);
    expect(decision.tool_calls.some((t) => t.actor === 'nemotron')).toBe(true);

    // execute the new plan to success
    await coord.ensureWorkflow(WF, [...out.new_plan.plan.incident_ids]);
    const exec2 = await coord.execute(WF, out.new_plan);
    expect(exec2.aborted).toBe(false);
    for (const o of exec2.outcomes) expect(o.status, o.command_key).toBe('succeeded');
    const snap = await db.getObservedSnapshot();
    expect([...snap.job_states.find((j) => j.job_id === 'job-a')!.allocated_gpu_ids].sort()).toEqual([...newDest].sort());
    noDoubleAllocation(snap);
    // the old checkpoint key ran exactly once
    expect(db.calls.filter((c) => c.method === 'startAction' && c.args[0] === ckptKey)).toHaveLength(1);
  });
});

describe('runReplan cancellation and reservations', () => {
  it('cancels a requested (safe-to-cancel) migrate with SUPERSEDED and leaves succeeded work alone', async () => {
    const { db, plan, replanDeps } = await setup();
    const moveKey = keyOf(plan, 'migrate_restart');
    const move = plan.commands.find((c) => c.command_key === moveKey)!;
    // the migrate depends on the checkpoint, but request_action only re-checks safety; it sits in `requested`
    expect((await db.requestAction(move)).status).toBe('requested');
    db.injectSignal(loadSignalXid79Dest());

    const exec = { workflow_id: WF, plan_id: plan.plan.plan_id, outcomes: [], aborted: true };
    const out = await runReplan(replanDeps(), { previous: plan, execution: exec, attempt: 2, reason: 'XID 79 on gpu-r8-n1-0' });
    expect(out.cancelled_keys).toEqual([moveKey]);
    expect(await db.getActionStatus(moveKey)).toMatchObject({ status: 'cancelled', reason_code: 'SUPERSEDED' });
  });

  it('never cancels a running action and never plans onto the GPUs it holds', async () => {
    const { db, plan, replanDeps } = await setup();
    // A prior migrate of job-b to r1 is running (not cancellable).
    const snap = await db.getObservedSnapshot();
    const { buildCommand } = await import('../src/tools/command.js');
    const r1 = Array.from({ length: 8 }, (_, i) => `gpu-r1-n1-${i}`);
    const running = buildCommand(
      { operation: 'migrate_restart', target_resource_id: 'job-b', job_id: 'job-b', arguments: { destination_gpu_ids: r1 } },
      snap,
      { runId: RUN_ID, workflowId: WF, incidentIds: [plan.plan.incident_ids[0]], planId: plan.plan.plan_id },
    );
    const s = await db.requestAction(running);
    const { fencing_token } = await db.claimAction(running.command_key, s.version, 'worker-1');
    await db.startAction(running.command_key, fencing_token);
    const previous: PlanResult = { ...plan, commands: [...plan.commands, running] };

    db.injectSignal(loadSignalXid79Dest());
    const exec = { workflow_id: WF, plan_id: plan.plan.plan_id, outcomes: [], aborted: true };
    const out = await runReplan(replanDeps(), { previous, execution: exec, attempt: 2, reason: 'XID 79 on gpu-r8-n1-0' });

    expect(out.cancelled_keys).not.toContain(running.command_key);
    expect((await db.getActionStatus(running.command_key))?.status).toBe('running');
    const planned = dests(out.new_plan.commands);
    for (const g of r1) expect(planned).not.toContain(g);
    expect(planned).not.toContain(XID_GPU);
  });
});

describe('watcher trigger rules', () => {
  it('ignores routine telemetry drift even when the decision epoch advances', async () => {
    const { db, plan } = await setup();
    const w = createReplanWatcher({ db }, plan);
    await flush();
    db.mutateSnapshot((s) => {
      for (const g of s.gpus) if (g.resource_id === XID_GPU || g.node_id === 'node-r2-n1') g.temp_c += 3;
      for (const n of s.nodes) n.thermal_headroom_c -= 1;
    });
    db.bumpDecisionEpoch();
    await flush();
    await flush();
    expect(w.shouldAbort()).toBe(false);
    expect(w.reason()).toBeNull();
    w.dispose();
  });

  it('ignores version bumps caused by our own commands (checkpoint completing)', async () => {
    const { db, plan } = await setup();
    const w = createReplanWatcher({ db }, plan);
    await flush();
    const ckpt = plan.commands.find((c) => c.operation === 'checkpoint')!;
    const s = await db.requestAction(ckpt);
    const { fencing_token } = await db.claimAction(ckpt.command_key, s.version, 'worker-1');
    await db.startAction(ckpt.command_key, fencing_token);
    db.tick(60_000);
    await flush();
    expect((await db.getActionStatus(ckpt.command_key))?.status).toBe('succeeded');
    expect(w.shouldAbort()).toBe(false);
    w.dispose();
  });

  it('does not abort on a signal for an unrelated resource (triage may still open its own incident)', async () => {
    const { db, plan } = await setup();
    const r7 = loadSignalXid79R7();
    expect(dests(plan.commands)).not.toContain(r7.resource_id);
    const w = createReplanWatcher({ db }, plan);
    await flush();
    db.injectSignal(r7);
    await flush();
    await flush();
    expect(w.shouldAbort()).toBe(false);
    const t = await runTriage({ db, llm: null, now: () => 0 });
    expect(t.incidents.length).toBe(2);
    w.dispose();
  });

  it('aborts on a material epoch change (destination GPU lost) even without a signal', async () => {
    const { db, plan } = await setup();
    const w = createReplanWatcher({ db }, plan);
    await flush();
    db.mutateSnapshot((s) => {
      const g = s.gpus.find((x) => x.resource_id === XID_GPU)!;
      g.availability = 'unreachable';
    });
    db.bumpDecisionEpoch();
    await flush();
    await flush();
    expect(w.shouldAbort()).toBe(true);
    expect(w.reason()).toContain(XID_GPU);
    // reset clears the flag for the next plan; dispose stops watching
    w.reset(null);
    expect(w.shouldAbort()).toBe(false);
    w.dispose();
  });

  it('flags a signal on the node hosting a planned destination', async () => {
    const { db, plan } = await setup();
    const w = createReplanWatcher({ db }, plan);
    await flush();
    const sig = { ...loadSignalXid79Dest(), event_id: 'sig-node-r8', resource_id: 'node-r8-n1', event_type: 'node_unreachable' as const, xid_code: null };
    db.injectSignal(sig);
    await flush();
    expect(w.shouldAbort()).toBe(true);
    expect(w.reason()).toContain('node-r8-n1');
    w.dispose();
  });
});
