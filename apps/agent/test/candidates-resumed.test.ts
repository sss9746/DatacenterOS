// R3b: `state.candidates` (plan-stage comparison) and `state.resumed` (+ resume_count) on the workflow record.
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentLoop, type AgentLoop, type AgentLoopDeps } from '../src/agent-loop.js';
import { DEFAULT_LEASE_MS } from '../src/coordinator.js';
import { createEventPublisher } from '../src/events.js';
import { CANDIDATE_LIMITS, capCandidates, mergeCandidates, type PersistedCandidate } from '../src/planner.js';
import { CLAIM_LEASE_MS } from '../src/resume.js';
import { killable } from '../scripts/crash-test.js';
import { FakeDb, FakePhysics } from './fakes/index.js';
import { RUN_ID, loadPumpDegradedSnapshot } from './fixtures/index.js';

function world() {
  const physics = new FakePhysics();
  const db = new FakeDb({ snapshot: loadPumpDegradedSnapshot(), physics });
  const simNow = () => {
    let t = 0;
    db.mutateSnapshot((s) => (t = s.clock.sim_time_ms));
    return t;
  };
  const clock = { unixMs: () => 0, simTimeMs: simNow };
  const sleep = async () => {
    db.tick(1000);
  };
  return { physics, db, clock, sleep };
}
type World = ReturnType<typeof world>;

const loops: AgentLoop[] = [];
function makeLoop(w: World, over: Partial<AgentLoopDeps> = {}): AgentLoop {
  const db = over.db ?? w.db;
  const events = over.events ?? createEventPublisher({ db, runId: RUN_ID, clock: w.clock, redact: (s) => s });
  const loop = createAgentLoop({ db, physics: w.physics, llm: null, events, workerId: 'worker-1', runId: RUN_ID, clock: w.clock, sleep: w.sleep, log: () => undefined, pollMs: 50, debounceMs: 10, ...over });
  loops.push(loop);
  return loop;
}
afterEach(async () => {
  for (const l of loops.splice(0)) await l.stop();
});

const cand = (over: Partial<PersistedCandidate> = {}): PersistedCandidate => ({
  job_id: 'job-a',
  option: 'keep_running',
  commands_summary: 'x',
  predicted_lost_work_units: 1,
  predicted_work_deficit_units: null,
  predicted_gpu_busy_waste_s: 0,
  safety: 'allow',
  violations: [],
  chosen: false,
  reason: 'r',
  decided_by: 'code',
  snapshot_epoch: 1,
  as_of_sim_time_ms: 1,
  ...over,
});

describe('state.candidates', () => {
  it('is persisted at the plan stage with chosen + rejected options and survives to done', async () => {
    const w = world();
    const r = await makeLoop(w).runOnce();
    expect(r.verification?.verified).toBe(true);
    const wf = await w.db.getWorkflow(r.workflow_id!);
    expect(wf?.stage).toBe('done');
    const list = wf!.state.candidates as PersistedCandidate[];
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(1);
    expect(list.length).toBeLessThanOrEqual(CANDIDATE_LIMITS.total);

    // chosen first, then by predicted lost work; chosen ones match the plan's real choices
    const firstRejected = list.findIndex((c) => !c.chosen);
    expect(firstRejected).toBeGreaterThan(0);
    expect(list.slice(firstRejected).some((c) => c.chosen)).toBe(false);
    const planned = r.plans[0]!.job_plans;
    for (const jp of planned) {
      const mine = list.filter((c) => c.job_id === jp.job_id);
      expect(mine.filter((c) => c.chosen)).toHaveLength(1);
      expect(mine.some((c) => !c.chosen)).toBe(true);
      expect(mine.length).toBeLessThanOrEqual(CANDIDATE_LIMITS.per_job);
      expect(mine.find((c) => c.chosen)!.commands_summary).toContain(jp.chosen.label.slice(0, 20));
    }
    const rejected = list.filter((c) => !c.chosen);
    expect(rejected.length).toBeGreaterThan(0);

    const epoch = r.plans[0]!.plan.based_on_decision_epoch;
    for (const c of list) {
      expect(c.snapshot_epoch).toBe(epoch);
      expect(c.decided_by).toBe('code'); // llm: null -> deterministic
      expect(c.reason.length).toBeGreaterThan(0);
      expect(c.reason.length).toBeLessThanOrEqual(160);
      // metrics were computed by simulatePlan: numbers, never a made-up 0 placeholder for unknowns
      expect(typeof c.predicted_lost_work_units).toBe('number');
      expect(typeof c.predicted_gpu_busy_waste_s).toBe('number');
      expect(c.predicted_work_deficit_units).toBeNull(); // the planner has no such metric
    }
    expect(list.find((c) => c.option === 'escalate')?.safety).toBe('needs_approval');
    expect(list.some((c) => c.option !== 'keep_running' && c.safety !== 'not_checked')).toBe(true);
    // existing state fields keep their meaning
    expect(typeof wf!.state.plan_id).toBe('string');
    expect(wf!.state.verification).toBeTruthy();
  });

  it('is visible on the plan-stage write, before anything executes', async () => {
    const w = world();
    await makeLoop(w).runOnce();
    const planWrite = w.db.calls.find((c) => c.method === 'updateWorkflow' && c.args[3] === 'plan');
    expect(planWrite).toBeTruthy();
    expect(Array.isArray((planWrite!.args[4] as Record<string, unknown>).candidates)).toBe(true);
  });
});

describe('candidate caps (pure)', () => {
  it('keeps <= 6 per job, <= 24 total, chosen survives, sorted chosen-first then by lost work (null last)', () => {
    const list: PersistedCandidate[] = [];
    for (let j = 0; j < 6; j++) {
      list.push(cand({ job_id: `job-${j}`, option: 'pause_job', chosen: true, predicted_lost_work_units: 50 }));
      for (let k = 0; k < 9; k++) list.push(cand({ job_id: `job-${j}`, option: `o${k}`, predicted_lost_work_units: k === 8 ? null : k }));
    }
    const out = capCandidates(list);
    expect(out.length).toBe(CANDIDATE_LIMITS.total);
    for (let j = 0; j < 6; j++) {
      const mine = out.filter((c) => c.job_id === `job-${j}`);
      expect(mine.length).toBeLessThanOrEqual(CANDIDATE_LIMITS.per_job);
      expect(mine.filter((c) => c.chosen)).toHaveLength(1);
    }
    expect(out.slice(0, 6).every((c) => c.chosen)).toBe(true);
    const rest = out.slice(6).map((c) => c.predicted_lost_work_units ?? Infinity);
    expect(rest).toEqual([...rest].sort((a, b) => a - b));
    const per = capCandidates(Array.from({ length: 10 }, (_, k) => cand({ option: `o${k}`, predicted_lost_work_units: k })));
    expect(per).toHaveLength(CANDIDATE_LIMITS.per_job);
  });

  it('mergeCandidates replaces only the replanned jobs and tolerates junk previous state', () => {
    const prev = [cand({ job_id: 'job-a', option: 'old' }), cand({ job_id: 'job-b', option: 'keep_running' })];
    const merged = mergeCandidates(prev, [cand({ job_id: 'job-a', option: 'new', chosen: true })]);
    expect(merged.map((c) => c.option).sort()).toEqual(['keep_running', 'new']);
    expect(mergeCandidates(undefined, [cand()])).toHaveLength(1);
    expect(mergeCandidates('junk', [cand()])).toHaveLength(1);
  });
});

describe('state.resumed', () => {
  it('is written after a simulated crash + resume by the new worker, and resume_count increments on each resume', async () => {
    const w = world();
    let killedKey: string | null = null;
    const k = killable(w.db, (m, args, phase) => {
      if (m !== 'startAction' || phase !== 'after' || !String(args[0]).includes(':checkpoint:')) return false;
      killedKey = String(args[0]);
      return true;
    });
    const loop1 = makeLoop(w, { db: k.db, workerId: 'worker-1' });
    loops.pop(); // its tick hangs forever (dead worker)
    void loop1.runOnce();
    await k.killed;
    expect(killedKey).not.toBeNull();
    const before = (await w.db.listOpenWorkflows())[0]!;
    expect(before.state.resumed).toBeUndefined();
    expect(before.lease_owner).toBe('worker-1');
    w.db.tick(5_000);
    w.db.advanceWallMs(Math.max(CLAIM_LEASE_MS, DEFAULT_LEASE_MS) + 1_000);

    const events = createEventPublisher({ db: w.db, runId: RUN_ID, clock: w.clock, redact: (s) => s, startSeq: 1000 });
    const loop2 = makeLoop(w, { workerId: 'worker-2', events });
    await loop2.start();
    const wf = (await w.db.getWorkflow(before.workflow_id))!;
    expect(wf.stage).toBe('done');
    const resumed = wf.state.resumed as Record<string, unknown>;
    expect(resumed).toMatchObject({ by_worker: 'worker-2', action: 'resumed_execute', previous_owner: 'worker-1' });
    expect(typeof resumed.at_sim_time_ms).toBe('number');
    expect(wf.state.resume_count).toBe(1);
    // candidates from the original plan survived the crash, the resume and verification
    expect((wf.state.candidates as unknown[]).length).toBeGreaterThan(1);
    // existing fields keep their meaning
    expect(typeof wf.state.plan_id).toBe('string');
  });

  it('a second resume of the same workflow overwrites the marker (latest wins) and bumps resume_count', async () => {
    const w = world();
    const k1 = killable(w.db, (m, args, phase) => m === 'startAction' && phase === 'after' && String(args[0]).includes(':checkpoint:'));
    const l1 = makeLoop(w, { db: k1.db, workerId: 'worker-1' });
    loops.pop();
    void l1.runOnce();
    await k1.killed;
    w.db.tick(5_000);
    w.db.advanceWallMs(Math.max(CLAIM_LEASE_MS, DEFAULT_LEASE_MS) + 1_000);
    // worker-2 resumes but is itself killed right after its first resumed write (dies mid-execute)
    const k2 = killable(w.db, (m, _a, phase) => m === 'updateWorkflow' && phase === 'after' && w.db.calls.filter((c) => c.method === 'updateWorkflow').length > 0 && Object.prototype.hasOwnProperty.call(lastState(w.db), 'resumed'));
    const l2 = makeLoop(w, { db: k2.db, workerId: 'worker-2' });
    loops.pop();
    void l2.start();
    await k2.killed;
    const mid = (await w.db.listOpenWorkflows())[0]!;
    expect((mid.state.resumed as { by_worker: string }).by_worker).toBe('worker-2');
    expect(mid.state.resume_count).toBe(1);
    w.db.tick(5_000);
    w.db.advanceWallMs(Math.max(CLAIM_LEASE_MS, DEFAULT_LEASE_MS) + 1_000);

    const events = createEventPublisher({ db: w.db, runId: RUN_ID, clock: w.clock, redact: (s) => s, startSeq: 2000 });
    const l3 = makeLoop(w, { workerId: 'worker-3', events });
    await l3.start();
    const wf = (await w.db.getWorkflow(mid.workflow_id))!;
    expect(wf.state.resumed).toMatchObject({ by_worker: 'worker-3', previous_owner: 'worker-2' });
    expect(wf.state.resume_count).toBe(2);
  });
});

function lastState(db: FakeDb): Record<string, unknown> {
  const calls = db.calls.filter((c) => c.method === 'updateWorkflow');
  return (calls.at(-1)?.args[4] as Record<string, unknown>) ?? {};
}
