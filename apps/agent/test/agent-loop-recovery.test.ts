// WP-B2: waiting recovery (plan §0.6). Fake DB + fake OptionChooser; nothing here calls a model.
import type { ActionCommand, ObservedSnapshot } from '@dcos/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentLoop, MAX_RECOVERY_ATTEMPTS, RECOVERY_DEADLINE_MS, type AgentLoop, type AgentLoopDeps } from '../src/agent-loop.js';
import { createEventPublisher } from '../src/events.js';
import { planIncidents, type ChooserInput, type OptionChooser } from '../src/planner.js';
import type { TeamTrace } from '../src/team/protocol.js';
import { runTriage } from '../src/triage.js';
import { FakeDb, FakeLlm, FakePhysics } from './fakes/index.js';
import { RUN_ID, loadDemoSnapshot } from './fixtures/index.js';

const POLL_MS = 2_000;

interface RecoveryState {
  status: string;
  job_ids: string[];
  blocked_reason: string;
  first_wait_unix_ms: number;
  attempts: number;
  fingerprint: string;
}

function failJob(s: ObservedSnapshot, jobId: string): void {
  const j = s.job_states.find((x) => x.job_id === jobId)!;
  j.status = 'failed';
  j.allocated_gpu_ids = [];
  s.allocations = s.allocations.filter((a) => a.job_id !== jobId);
}

function dropJob(s: ObservedSnapshot, jobId: string): void {
  failJob(s, jobId);
  s.job_states.find((x) => x.job_id === jobId)!.status = 'completed';
}

const setAvailability = (s: ObservedSnapshot, availability: 'ready' | 'unreachable', keepNode?: string): void => {
  for (const n of s.nodes) if (n.resource_id !== keepNode) n.availability = availability;
  for (const g of s.gpus) {
    if (g.node_id === keepNode) continue;
    g.availability = availability;
    if (availability === 'ready') g.last_xid_code = null;
  }
};

/** All nodes down (except `keepNode`); job-a and job-b have checkpoints, job-c has none. */
function outage(opts: { withJobC?: boolean; keepNode?: string } = {}): ObservedSnapshot {
  const s = loadDemoSnapshot();
  failJob(s, 'job-a');
  failJob(s, 'job-b');
  if (opts.withJobC) failJob(s, 'job-c');
  else dropJob(s, 'job-c');
  setAvailability(s, 'unreachable', opts.keepNode);
  return s;
}

function world(snapshot: ObservedSnapshot) {
  const physics = new FakePhysics();
  let wall = 1_000_000;
  const db = new FakeDb({ snapshot, physics, now: () => wall });
  const simNow = () => {
    let t = 0;
    db.mutateSnapshot((s) => (t = s.clock.sim_time_ms));
    return t;
  };
  const clock = { unixMs: () => wall, simTimeMs: simNow };
  let polls = 0;
  const onPoll: Array<(n: number) => Promise<void> | void> = [];
  const sleep = async (ms: number) => {
    wall += ms;
    db.tick(1000);
    if (ms === POLL_MS) {
      polls += 1;
      for (const h of onPoll) await h(polls);
    }
  };
  return {
    physics,
    db,
    clock,
    sleep,
    onPoll,
    polls: () => polls,
    advanceWall: (ms: number) => (wall += ms),
    wall: () => wall,
    restoreAll: () => db.mutateSnapshot((s) => setAvailability(s, 'ready')),
  };
}
type World = ReturnType<typeof world>;

const loops: AgentLoop[] = [];
function makeLoop(w: World, over: Partial<AgentLoopDeps> = {}): AgentLoop {
  const events = createEventPublisher({ db: w.db, runId: RUN_ID, clock: w.clock, redact: (s) => s });
  const loop = createAgentLoop({ db: w.db, physics: w.physics, llm: null, events, workerId: 'worker-1', runId: RUN_ID, clock: w.clock, sleep: w.sleep, log: () => undefined, pollMs: 50, debounceMs: 10, recoveryPollMs: POLL_MS, ...over });
  loops.push(loop);
  return loop;
}
afterEach(async () => {
  for (const l of loops.splice(0)) await l.stop();
});

const trace = (roundId: string): TeamTrace => ({
  version: 1,
  round_id: roundId,
  snapshot_sim_ms: 0,
  model: 'fake',
  calls_used: 1,
  wall_ms: 1,
  outcome: 'lead',
  messages: [],
  covers: [],
  missing_roles: [],
});

/** A Lead that restarts every job it is offered a restart for, on GPUs no other job of the round takes. */
function restartChooser() {
  const calls: ChooserInput[] = [];
  const chooser: OptionChooser = async (input) => {
    calls.push(input);
    const taken = new Set<string>();
    const gpus = (c: ActionCommand): string[] => (c.operation === 'migrate_restart' ? (c.arguments.destination_gpu_ids as string[]) : []);
    const choices = [...input.ranked].flatMap(([job_id, opts]) => {
      const o = opts.find((x) => !x.excluded_reason && x.commands.some((c) => c.operation === 'migrate_restart') && !x.commands.flatMap(gpus).some((g) => taken.has(g)));
      if (o) for (const g of o.commands.flatMap(gpus)) taken.add(g);
      return o ? [{ job_id, option_id: o.option_id, needs_approval: false, explanation: 'restart from checkpoint' }] : [];
    });
    return { choices, team: trace(`${input.workflowId}:a${input.attempt}`) };
  };
  return { chooser, calls };
}

const requests = (w: World): ActionCommand[] => w.db.calls.filter((c) => c.method === 'requestAction').map((c) => c.args[0] as ActionCommand);
const writes = (w: World): number => w.db.calls.filter((c) => c.method === 'updateWorkflow').length;
const openState = async (w: World) => (await w.db.listOpenWorkflows())[0]!;
const recovery = (state: Record<string, unknown> | undefined): RecoveryState => state?.recovery as RecoveryState;
const restartedJobs = (w: World): string[] => [...new Set(requests(w).filter((c) => c.operation === 'migrate_restart').map((c) => c.job_id!))].sort();

describe('waiting recovery in the agent loop', () => {
  it('all nodes down: waits with zero chooser calls and no action requests, and unchanged polls cost nothing', async () => {
    const w = world(outage({ withJobC: true }));
    const { chooser, calls } = restartChooser();
    const llm = new FakeLlm();
    let writesAtPoll2 = 0;
    const seen: { status: string; stage: string; fp: string }[] = [];
    w.onPoll.push(async (n) => {
      const wf = await openState(w);
      seen.push({ status: recovery(wf.state).status, stage: wf.stage, fp: recovery(wf.state).fingerprint });
      if (n === 2) writesAtPoll2 = writes(w);
      if (n === 6) {
        expect(writes(w)).toBe(writesAtPoll2);
        expect(calls).toHaveLength(0);
        expect(requests(w)).toHaveLength(0);
        expect(llm.requests).toHaveLength(0);
        w.restoreAll();
      }
    });
    await makeLoop(w, { chooser, llm }).runOnce();
    expect(seen.length).toBeGreaterThanOrEqual(6);
    expect(new Set(seen.map((s) => s.status))).toEqual(new Set(['waiting']));
    expect(new Set(seen.map((s) => s.stage))).toEqual(new Set(['plan']));
    expect(new Set(seen.map((s) => s.fp)).size).toBe(1);
  });

  it('nodes return: a new attempt restarts the checkpoint-backed jobs and the workflow verifies', async () => {
    const w = world(outage());
    const { chooser, calls } = restartChooser();
    w.onPoll.push((n) => {
      if (n === 3) w.restoreAll();
    });
    const r = await makeLoop(w, { chooser }).runOnce();
    expect(calls.map((c) => c.attempt)).toEqual([2]);
    expect(r.plans).toHaveLength(2);
    expect(restartedJobs(w)).toEqual(['job-a', 'job-b']);
    expect(requests(w).every((c) => c.command_key.endsWith(':2'))).toBe(true);
    expect(r.verification?.verified).toBe(true);
    expect(r.escalated).toBe(false);
    const wf = await w.db.getWorkflow(r.workflow_id!);
    expect(wf?.stage).toBe('done');
    expect(recovery(wf?.state)).toMatchObject({ status: 'resumed', attempts: 2 });
  });

  it('a job with no completed checkpoint is never restarted, is named for an operator, and blocks nobody', async () => {
    const w = world(outage({ withJobC: true }));
    const { chooser, calls } = restartChooser();
    w.onPoll.push((n) => {
      if (n === 2) w.restoreAll();
    });
    const r = await makeLoop(w, { chooser }).runOnce();
    expect([...calls[0]!.ranked.keys()]).not.toContain('job-c');
    expect(restartedJobs(w)).toEqual(['job-a', 'job-b']);
    expect(r.plans.at(-1)!.operator_jobs?.map((j) => j.job_id)).toEqual(['job-c']);
    expect(r.verification?.verified).toBe(false);
    expect(r.escalated).toBe(true);
    const wf = await w.db.getWorkflow(r.workflow_id!);
    expect(wf?.stage).toBe('escalated');
    const handoff = wf?.state.verification as { handoff: string; outcome: string; affected_jobs: { job_id: string; status: string }[] };
    expect(handoff.outcome).toBe('operator_review');
    expect(handoff.handoff).toContain('job-c');
    expect(handoff.affected_jobs.find((j) => j.job_id === 'job-c')?.status).toBe('failed');
  });

  it('only operator jobs affected: escalates instead of closing as no action', async () => {
    const s = outage({ withJobC: true });
    dropJob(s, 'job-a');
    dropJob(s, 'job-b');
    const w = world(s);
    const { chooser, calls } = restartChooser();
    const r = await makeLoop(w, { chooser }).runOnce();
    expect(calls).toHaveLength(0);
    expect(w.polls()).toBe(0);
    expect(r.escalated).toBe(true);
    expect(String((await w.db.getWorkflow(r.workflow_id!))?.state.escalation_reason)).toContain('job-c');
  });

  it('deadline expiry sets expired and hands off through escalate', async () => {
    const w = world(outage());
    const { chooser, calls } = restartChooser();
    const r = await makeLoop(w, { chooser }).runOnce();
    expect(calls).toHaveLength(0);
    expect(requests(w)).toHaveLength(0);
    expect(w.polls() * POLL_MS).toBeGreaterThanOrEqual(RECOVERY_DEADLINE_MS);
    expect(r.escalated).toBe(true);
    const wf = await w.db.getWorkflow(r.workflow_id!);
    expect(wf?.stage).toBe('escalated');
    expect(recovery(wf?.state).status).toBe('expired');
    expect(String(wf?.state.escalation_reason)).toMatch(/waited 120 s.*job-a.*job-b/);
    expect(wf?.state.verification).toBeDefined();
  });

  it('attempt limit: capacity flapping without helping stops at the limit', async () => {
    const w = world(outage());
    const { chooser, calls } = restartChooser();
    w.onPoll.push(() => {
      w.db.mutateSnapshot((s) => {
        const g = s.gpus[0]!;
        g.availability = g.availability === 'unreachable' ? 'degraded' : 'unreachable';
      });
    });
    const r = await makeLoop(w, { chooser }).runOnce();
    expect(r.plans).toHaveLength(MAX_RECOVERY_ATTEMPTS);
    expect(calls).toHaveLength(0);
    expect(r.escalated).toBe(true);
    const wf = await w.db.getWorkflow(r.workflow_id!);
    expect(recovery(wf?.state)).toMatchObject({ status: 'expired', attempts: MAX_RECOVERY_ATTEMPTS });
    expect(String(wf?.state.escalation_reason)).toContain('attempt limit');
  });

  it('restart during the wait comes back through took_over and keeps first_wait_unix_ms', async () => {
    const w = world(outage());
    const { chooser, calls } = restartChooser();
    let phase: 'first' | 'second' = 'first';
    const loopA = makeLoop(w, { chooser });
    w.onPoll.push((n) => {
      if (phase === 'first' && n === 3) void loopA.stop();
    });
    const a = await loopA.runOnce();
    expect(a.status).toBe('stopped');
    const before = await openState(w);
    expect(before.stage).toBe('plan');
    const first = recovery(before.state).first_wait_unix_ms;

    phase = 'second';
    w.advanceWall(20_000); // the dead worker's lease expires
    const pollsBefore = w.polls();
    const seenFirst: number[] = [];
    w.onPoll.push(async (n) => {
      seenFirst.push(recovery((await openState(w)).state).first_wait_unix_ms);
      if (n === pollsBefore + 2) w.restoreAll();
    });
    const loopB = makeLoop(w, { chooser, workerId: 'worker-2' });
    await loopB.start();
    expect(loopB.lastResume()?.items.map((i) => i.action)).toEqual(['took_over']);
    expect(seenFirst.length).toBeGreaterThan(0);
    expect(new Set(seenFirst)).toEqual(new Set([first]));
    expect(calls.map((c) => c.attempt)).toEqual([2]);
    expect(restartedJobs(w)).toEqual(['job-a', 'job-b']);
    const wf = await w.db.getWorkflow(`wf-${before.incident_ids[0]}`);
    expect(wf?.stage).toBe('done');
    expect(recovery(wf?.state)).toMatchObject({ status: 'resumed', first_wait_unix_ms: first, attempts: 2 });
  });

  it('a deadline that passed while the agent was down expires on the way back', async () => {
    const w = world(outage());
    const { chooser, calls } = restartChooser();
    const loopA = makeLoop(w, { chooser });
    w.onPoll.push((n) => {
      if (n === 2) void loopA.stop();
    });
    await loopA.runOnce();
    w.advanceWall(RECOVERY_DEADLINE_MS);
    const pollsBefore = w.polls();
    const loopB = makeLoop(w, { chooser, workerId: 'worker-2' });
    await loopB.start();
    expect(calls).toHaveLength(0);
    expect(w.polls()).toBe(pollsBefore); // expired on entry, without one more poll
    const wf = await openState(w);
    expect(wf.stage).toBe('escalated');
    expect(recovery(wf.state).status).toBe('expired');
    expect([...w.db.incidents.values()].every((i) => i.state === 'escalated')).toBe(true);
  });

  it('a replan that leaves nothing to run goes back to waiting instead of closing as no action', async () => {
    const w = world(outage({ keepNode: 'node-r1-n1' }));
    const { chooser: restart, calls } = restartChooser();
    let round = 0;
    const chooser: OptionChooser = async (input) => {
      round += 1;
      // The only live node dies while the first round deliberates: the post-round check replans.
      if (round === 1) w.db.mutateSnapshot((s) => setAvailability(s, 'unreachable'));
      return restart(input);
    };
    w.onPoll.push((n) => {
      if (n === 2) w.restoreAll();
    });
    const r = await makeLoop(w, { chooser }).runOnce();
    expect(r.replans).toHaveLength(1);
    expect(r.replans[0]!.new_plan.commands).toHaveLength(0);
    expect(r.replans[0]!.new_plan.waiting_jobs?.map((j) => j.job_id).sort()).toEqual(['job-a', 'job-b']);
    expect(calls.map((c) => c.attempt)).toEqual([1, 3]);
    expect(requests(w).every((c) => c.command_key.endsWith(':3'))).toBe(true);
    expect(restartedJobs(w)).toEqual(['job-a', 'job-b']);
    expect(r.verification?.verified).toBe(true);
    expect(recovery((await w.db.getWorkflow(r.workflow_id!))?.state).status).toBe('resumed');
  });

  it('partial: runs what it can, keeps waiting for the rest, and never closes as fully recovered', async () => {
    const w = world(outage({ withJobC: true, keepNode: 'node-r1-n1' }));
    const { chooser, calls } = restartChooser();
    let during: { stage: string; rec: RecoveryState; verified: unknown; restarted: string[] } | null = null;
    w.onPoll.push(async (n) => {
      if (n !== 2) return;
      const wf = await openState(w);
      during = { stage: wf.stage, rec: recovery(wf.state), verified: (wf.state.verification as { verified?: boolean } | undefined)?.verified, restarted: restartedJobs(w) };
      w.restoreAll();
    });
    const r = await makeLoop(w, { chooser }).runOnce();
    expect(during).toMatchObject({ stage: 'plan', rec: { status: 'waiting', job_ids: ['job-a'] }, verified: true, restarted: ['job-b'] });
    expect(calls.map((c) => [...c.ranked.keys()])[0]).toEqual(['job-b']);
    expect(restartedJobs(w)).toEqual(['job-a', 'job-b']);
    expect(r.escalated).toBe(true); // job-c still needs an operator
    const wf = await w.db.getWorkflow(r.workflow_id!);
    expect(wf?.stage).toBe('escalated');
    expect(recovery(wf?.state).status).toBe('resumed');
    expect((wf?.state.verification as { handoff: string }).handoff).toContain('Partial recovery');
  });

  it('partial: a wait that expires after a successful restart is not reported as recovered', async () => {
    const w = world(outage({ keepNode: 'node-r1-n1' }));
    const { chooser } = restartChooser();
    const r = await makeLoop(w, { chooser }).runOnce();
    expect(restartedJobs(w)).toEqual(['job-b']);
    expect(r.escalated).toBe(true);
    const wf = await w.db.getWorkflow(r.workflow_id!);
    expect(wf?.stage).toBe('escalated');
    expect(recovery(wf?.state)).toMatchObject({ status: 'expired', job_ids: ['job-a'] });
    expect(String(wf?.state.escalation_reason)).toContain('job-a');
  });

  it('a paused simulator shows as paused and is not treated as recovered', async () => {
    const w = world(outage());
    const { chooser, calls } = restartChooser();
    let whilePaused: RecoveryState | null = null;
    w.onPoll.push(async (n) => {
      if (n === 1) {
        w.db.mutateSnapshot((s) => {
          s.clock.paused = true;
          setAvailability(s, 'ready');
        });
      }
      if (n === 5) {
        whilePaused = recovery((await openState(w)).state);
        expect(calls).toHaveLength(0);
        expect(requests(w)).toHaveLength(0);
        w.db.mutateSnapshot((s) => {
          s.clock.paused = false;
        });
      }
    });
    const r = await makeLoop(w, { chooser }).runOnce();
    expect(whilePaused).toMatchObject({ status: 'waiting', attempts: 1 });
    expect(whilePaused!.blocked_reason).toMatch(/^simulator paused/);
    expect(w.db.agentEvents.some((e) => e.summary.startsWith('simulator paused, not recovered'))).toBe(true);
    expect(restartedJobs(w)).toEqual(['job-a', 'job-b']);
    expect(r.verification?.verified).toBe(true);
  });

  it('stops promptly when the loop is stopped, leaving the record in place', async () => {
    const w = world(outage());
    const { chooser } = restartChooser();
    const loop = makeLoop(w, { chooser });
    w.onPoll.push((n) => {
      if (n === 1) void loop.stop();
    });
    const r = await loop.runOnce();
    expect(r.status).toBe('stopped');
    expect(w.polls()).toBe(1);
    expect(recovery((await openState(w)).state).status).toBe('waiting');
  });

  it('stops when ownership is lost', async () => {
    const w = world(outage());
    const { chooser } = restartChooser();
    w.onPoll.push(async (n) => {
      if (n !== 1) return;
      const wf = await openState(w);
      w.advanceWall(20_000); // our lease lapses and another worker takes the workflow
      await w.db.claimWorkflow(wf.workflow_id, 'worker-2', wf.version, 15_000);
    });
    const r = await makeLoop(w, { chooser }).runOnce();
    expect(r.status).toBe('lost_ownership');
    expect(r.escalated).toBe(false);
    expect(requests(w)).toHaveLength(0);
  });

  it('single mode (no chooser) is unchanged: no waiting record, no polling', async () => {
    const w = world(outage({ withJobC: true }));
    const r = await makeLoop(w).runOnce();
    expect(w.polls()).toBe(0);
    expect(r.plans[0]!.waiting_jobs).toBeUndefined();
    expect(r.plans[0]!.operator_jobs).toBeUndefined();
    expect((await w.db.getWorkflow(r.workflow_id!))?.state.recovery).toBeUndefined();
  });
});

describe('planner: waitForCapacity', () => {
  const setup = async (snapshot: ObservedSnapshot) => {
    const physics = new FakePhysics();
    const db = new FakeDb({ snapshot, physics });
    const { incidents } = await runTriage({ db, llm: null, now: () => 0 });
    return { physics, db, incidents };
  };
  const deps = (s: Awaited<ReturnType<typeof setup>>) => ({ db: s.db, physics: s.physics, llm: new FakeLlm(), workflowId: 'wf-1', runId: RUN_ID });

  it('all affected jobs held: no chooser call, zero commands, and no escalate option is taken', async () => {
    const s = await setup(outage({ withJobC: true }));
    const { chooser, calls } = restartChooser();
    const r = await planIncidents({ ...deps(s), chooser }, { incidents: s.incidents });
    expect(calls).toHaveLength(0);
    expect(r.commands).toHaveLength(0);
    expect(r.waiting_jobs?.map((j) => j.job_id).sort()).toEqual(['job-a', 'job-b']);
    expect(r.operator_jobs?.map((j) => j.job_id)).toEqual(['job-c']);
    expect(r.job_plans.every((p) => p.chosen.commands.length === 0 && !p.needs_approval)).toBe(true);
    expect(r.used_llm).toBe(false);
  });

  it('a no-checkpoint job is held for an operator even when capacity exists; the others are unaffected', async () => {
    const s = loadDemoSnapshot();
    failJob(s, 'job-a');
    failJob(s, 'job-c');
    const world2 = await setup(s);
    const incidents = world2.incidents.length > 0 ? world2.incidents : [fakeIncident()];
    const { chooser, calls } = restartChooser();
    const r = await planIncidents({ ...deps(world2), chooser }, { incidents });
    expect([...calls[0]!.ranked.keys()]).not.toContain('job-c');
    expect(r.operator_jobs).toEqual([{ job_id: 'job-c', reason: 'no completed checkpoint' }]);
    expect(r.commands.filter((c) => c.job_id === 'job-c')).toHaveLength(0);
    expect(r.commands.some((c) => c.job_id === 'job-a' && c.operation === 'migrate_restart')).toBe(true);
  });

  it('an inaccessible checkpoint is an operator case, not a wait', async () => {
    const s = outage();
    for (const c of s.checkpoints) c.accessible = false;
    const w = await setup(s);
    const r = await planIncidents({ ...deps(w), waitForCapacity: true }, { incidents: w.incidents });
    expect(r.waiting_jobs).toEqual([]);
    expect(r.operator_jobs?.map((j) => j.reason)).toEqual(['completed checkpoint is not accessible', 'completed checkpoint is not accessible']);
  });

  it('contention: the lower-priority job waits instead of taking the same GPUs', async () => {
    const s = outage({ keepNode: 'node-r1-n1' });
    s.job_specs.find((j) => j.job_id === 'job-a')!.gpus_required = 8;
    const w = await setup(s);
    const { chooser } = restartChooser();
    const r = await planIncidents({ ...deps(w), chooser }, { incidents: w.incidents });
    expect(r.commands.map((c) => c.job_id)).toEqual(['job-a']);
    expect(r.waiting_jobs?.map((j) => j.job_id)).toEqual(['job-b']);
  });

  it('both jobs choosing the same GPUs: the loser becomes waiting, with no escalate', async () => {
    const s = outage({ keepNode: 'node-r1-n1' });
    s.job_specs.find((j) => j.job_id === 'job-a')!.gpus_required = 8;
    const w = await setup(s);
    const chooser: OptionChooser = async (input) => ({
      choices: [...input.ranked].flatMap(([job_id, opts]) => {
        const o = opts.find((x) => !x.excluded_reason && x.commands.some((c) => c.operation === 'migrate_restart'));
        return o ? [{ job_id, option_id: o.option_id, needs_approval: false, explanation: 'x' }] : [];
      }),
      team: trace('r'),
    });
    const r = await planIncidents({ ...deps(w), chooser }, { incidents: w.incidents });
    expect(r.commands.map((c) => [c.job_id, c.operation])).toEqual([['job-a', 'migrate_restart']]);
    expect(r.waiting_jobs?.map((j) => j.job_id)).toEqual(['job-b']);
  });

  it('a checkpoint-backed job with a restart open restarts even if the Lead fails or asks to escalate', async () => {
    const s = outage({ keepNode: 'node-r1-n1' });
    s.job_specs.find((j) => j.job_id === 'job-a')!.gpus_required = 8;
    const w = await setup(s);
    const escalates: OptionChooser = async (input) => {
      expect(input.ranked.get('job-a')!.every((o) => o.commands.some((c) => c.operation === 'migrate_restart'))).toBe(true);
      return { choices: [{ job_id: 'job-a', option_id: 'job-a:escalate', needs_approval: false, explanation: 'x' }], team: trace('r') };
    };
    const asked = await planIncidents({ ...deps(w), chooser: escalates }, { incidents: w.incidents });
    expect(asked.commands.map((c) => [c.job_id, c.operation])).toEqual([['job-a', 'migrate_restart']]);
    const leadDown: OptionChooser = async () => ({ choices: null, team: trace('r') });
    const down = await planIncidents({ ...deps(w), chooser: leadDown, attempt: 2 }, { incidents: w.incidents });
    expect(down.commands.map((c) => [c.job_id, c.operation])).toEqual([['job-a', 'migrate_restart']]);
  });

  it('off by default without a chooser, and can be switched off with one', async () => {
    const s = await setup(outage({ withJobC: true }));
    const plain = await planIncidents(deps(s), { incidents: s.incidents });
    expect(plain.waiting_jobs).toBeUndefined();
    expect(plain.operator_jobs).toBeUndefined();
    const { chooser, calls } = restartChooser();
    const off = await planIncidents({ ...deps(s), chooser, waitForCapacity: false, attempt: 2 }, { incidents: s.incidents });
    expect(off.waiting_jobs).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

function fakeIncident() {
  return {
    schema_version: '1.1.0',
    run_id: RUN_ID,
    incident_id: 'inc-test',
    state: 'open',
    version: 1,
    title: 'test',
    hypothesis: 'test',
    severity: 'critical',
    opened_sim_time_ms: 0,
    updated_sim_time_ms: 0,
  } as unknown as Parameters<typeof planIncidents>[1]['incidents'][number];
}
