// Several agent processes coordinating ONLY through the (fake) DB: one FakeDb, two or three createAgentLoop
// instances with different worker ids. Covers: separate per-incident workflows, one lease owner each, zone
// preference, no duplicate keys / allocations, a lone survivor adopting a dead worker's expired lease (and two at
// once), fencing of the dead worker's token, and the agent-to-agent messages (cross_zone_move/ack, takeover, stand_by).

import type { ActionCommand, SignalEvent } from '@dcos/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentLoop, type AgentLoop, type AgentLoopDeps } from '../src/agent-loop.js';
import { DEFAULT_LEASE_MS } from '../src/coordinator.js';
import { createEventPublisher } from '../src/events.js';
import { killable } from '../scripts/crash-test.js';
import { pickIsolatedGpu } from '../scripts/live/multi.js';
import { allocationUniqueness } from '../scripts/live/asserts.js';
import { FakeDb, FakePhysics } from './fakes/index.js';
import { RUN_ID, loadPumpDegradedSnapshot, loadSignalXid79Dest } from './fixtures/index.js';

const ALPHA = 'agent-alpha-101';
const BETA = 'agent-beta-202';
const GAMMA = 'agent-gamma-303';

function world() {
  let wall = 1_794_091_200_000;
  const physics = new FakePhysics();
  const db = new FakeDb({ snapshot: loadPumpDegradedSnapshot(), physics, now: () => wall });
  const simNow = () => {
    let t = 0;
    db.mutateSnapshot((s) => (t = s.clock.sim_time_ms));
    return t;
  };
  const clock = { unixMs: () => wall, simTimeMs: simNow };
  const hooks: Array<() => Promise<void> | void> = [];
  const sleep = async () => {
    db.tick(1000);
    for (const h of hooks) await h();
  };
  return { physics, db, clock, sleep, hooks, simNow, advanceWall: (ms: number) => (wall += ms) };
}
type World = ReturnType<typeof world>;

const loops: AgentLoop[] = [];
let seq = 1;
function makeLoop(w: World, workerId: string, over: Partial<AgentLoopDeps> = {}): AgentLoop {
  const db = over.db ?? w.db;
  const events = createEventPublisher({ db, runId: RUN_ID, clock: w.clock, redact: (s) => s, startSeq: (seq += 10_000) });
  const loop = createAgentLoop({
    db,
    physics: w.physics,
    llm: null,
    events,
    workerId,
    agentName: workerId.replace(/-\d+$/, ''),
    runId: RUN_ID,
    clock: w.clock,
    sleep: w.sleep,
    log: () => undefined,
    pollMs: 1e8,
    debounceMs: 1e8,
    claimGraceMs: 2_000,
    ...over,
  });
  loops.push(loop);
  return loop;
}
afterEach(async () => {
  for (const l of loops.splice(0)) await l.stop();
});

const requestsPerKey = (db: FakeDb) => {
  const m = new Map<string, number>();
  for (const c of db.calls) if (c.method === 'requestAction') {
    const k = (c.args[0] as ActionCommand).command_key;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
};

async function injectXid(w: World, gpu: string): Promise<void> {
  const sim = w.simNow() + 1_000;
  const sig: SignalEvent = { ...loadSignalXid79Dest(), event_id: `sig-xid-${gpu}-${sim}`, resource_id: gpu, sim_time_ms: sim, evidence: { xid_code: 79, gpu_id: gpu } };
  w.db.injectSignal(sig);
}


async function expectExactlyOnce(db: FakeDb): Promise<void> {
  for (const n of requestsPerKey(db).values()) expect(n).toBe(1);
  const outcomes = db.listActions();
  expect(outcomes.some((a) => a.reason_code === 'COMMAND_KEY_COLLISION')).toBe(false);
  const snap = await db.getObservedSnapshot();
  expect(allocationUniqueness(snap.allocations, snap.job_states).ok).toBe(true);
}

describe('two agents on one DB: parallel incident response', () => {
  it('pump (loop-a) + XID on an idle loop-b GPU -> two workflows, each owned by its zone\'s agent, both settle', async () => {
    const w = world();
    const snap0 = await w.db.getObservedSnapshot();
    const xidGpu = pickIsolatedGpu(snap0, { excludeRacks: ['rack-r2', 'rack-r3', 'rack-r4'] })!;
    expect(xidGpu).toMatch(/^gpu-r[1578]-/);
    await injectXid(w, xidGpu);

    const alpha = makeLoop(w, ALPHA, { zone: 'loop-a' });
    const beta = makeLoop(w, BETA, { zone: 'loop-b' });
    const [ra, rb] = await Promise.all([alpha.runOnce(), beta.runOnce()]);

    // Both triaged the same symptoms; each drove exactly one workflow: its own zone's incident.
    expect(ra.status).toBe('handled');
    expect(rb.status).toBe('handled');
    expect(ra.workflow_ids).toHaveLength(1);
    expect(rb.workflow_ids).toHaveLength(1);
    expect(ra.workflow_ids[0]).not.toBe(rb.workflow_ids[0]);
    expect(w.db.incidents.size).toBe(2);
    const wfA = (await w.db.getWorkflow(ra.workflow_ids[0]!))!;
    const wfB = (await w.db.getWorkflow(rb.workflow_ids[0]!))!;
    expect(wfA.lease_owner).toBe(ALPHA);
    expect(wfB.lease_owner).toBe(BETA);
    // one claim each (attempt counts claims), nobody ever re-leased the other's workflow
    expect(wfA.attempt).toBe(1);
    expect(wfB.attempt).toBe(1);
    expect(['done', 'escalated']).toContain(wfA.stage);
    expect(['done', 'escalated']).toContain(wfB.stage);
    // alpha's is the pump workflow (moves job-a), beta's the XID one (idle GPU: no action)
    expect(ra.executions.length).toBeGreaterThan(0);
    expect(rb.plans[0]!.commands).toHaveLength(0);
    expect([...w.db.incidents.values()].every((i) => i.state === 'monitoring' || i.state === 'escalated')).toBe(true);
    expect(await w.db.listOpenWorkflows()).toHaveLength(0);
    await expectExactlyOnce(w.db);
    // no agent ever claimed an action under the other's workflow
    for (const c of w.db.calls.filter((c) => c.method === 'claimAction')) {
      const key = String(c.args[0]);
      expect(c.args[2]).toBe(key.startsWith(wfA.workflow_id) ? ALPHA : BETA);
    }

    // messages: alpha announced its cross-zone move (job-a leaves loop-a) and beta answered from its own state
    const sentByAlpha = alpha.messages().filter((m) => m.from === 'agent-alpha');
    const move = sentByAlpha.find((m) => m.topic === 'cross_zone_move');
    expect(move?.text).toMatch(/^move job=job-a dest_racks=rack-r\d/);
    const reply = alpha.messages().find((m) => m.from === 'agent-beta' && (m.topic === 'ack' || m.topic === 'conflict'));
    expect(reply?.to).toBe('agent-alpha');
    expect(reply?.text).toMatch(/^(ack|conflict)/);
    expect(beta.messages().some((m) => m.from === 'agent-alpha' && m.topic === 'incident_update')).toBe(true);
    expect(alpha.messages().some((m) => m.from === 'agent-beta' && m.topic === 'incident_update')).toBe(true);
    // every message rides on an agent_event row with from/to/topic
    const rows = w.db.agentEvents.filter((e) => e.tool_calls.some((t) => t.tool === 'agent_message'));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.every((e) => /^from=agent-\w+ to=\S+ topic=\w+$/.test(e.tool_calls[0]!.args_summary))).toBe(true);
  });

  it('unzoned agents race for one incident: one wins, the other stands by without touching it', async () => {
    const w = world();
    const alpha = makeLoop(w, ALPHA);
    const beta = makeLoop(w, BETA);
    const [ra, rb] = await Promise.all([alpha.runOnce(), beta.runOnce()]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual(['handled', 'standby']);
    const winner = ra.status === 'handled' ? ALPHA : BETA;
    const wfs = w.db.calls.filter((c) => c.method === 'claimWorkflow').map((c) => c.args[0]);
    expect(new Set(wfs).size).toBe(1);
    const wf = (await w.db.getWorkflow(String(wfs[0])))!;
    expect(wf.lease_owner).toBe(winner);
    expect(wf.attempt).toBe(1);
    expect(wf.stage).toBe('done');
    await expectExactlyOnce(w.db);
    for (const c of w.db.calls.filter((c) => c.method === 'claimAction')) expect(c.args[2]).toBe(winner);
    // the loser never wrote incident state or submitted anything; the winner's handoff closed the incident
    expect([...w.db.incidents.values()].map((i) => i.state)).toEqual(['monitoring']);
    // a later tick of the loser finds nothing to take over (the workflow is closed)
    const loser = ra.status === 'handled' ? beta : alpha;
    w.advanceWall(DEFAULT_LEASE_MS + 5_000);
    expect((await loser.runOnce()).status).toBe('idle');
  });

  it('one unzoned agent, two independent incidents in one tick -> two workflows driven concurrently in one process', async () => {
    const w = world();
    const snap0 = await w.db.getObservedSnapshot();
    const jobC = snap0.job_states.find((j) => j.job_id === 'job-c')!;
    await injectXid(w, [...jobC.allocated_gpu_ids].sort()[0]!); // job-c's GPU dies: a second incident that needs actions
    const alpha = makeLoop(w, ALPHA);
    const r = await alpha.runOnce();
    expect(r.status).toBe('handled');
    expect(r.workflow_ids).toHaveLength(2);
    expect(r.new_incident_ids).toHaveLength(2);
    expect(r.workflow_ids.map((id) => id.replace(/^wf-/, '')).sort()).toEqual([...r.new_incident_ids].sort());
    for (const id of r.workflow_ids) expect(['done', 'escalated']).toContain((await w.db.getWorkflow(id))!.stage);
    expect((await w.db.listOpenWorkflows()).filter((x) => x.stage !== 'escalated')).toHaveLength(0);
    await expectExactlyOnce(w.db);
    // both jobs were acted on: job-a (pump: checkpoint + move) and job-c (dead GPU: the deterministic planner caps it)
    const jobs = new Set(w.db.listActions().map((a) => a.command_key.split(':')[2]));
    expect(jobs.has('job-a')).toBe(true);
    expect(jobs.has('job-c')).toBe(true);
  });
});

describe('failover between live agents (no restart)', () => {
  /** alpha claims the pump workflow and "dies" right after starting job-a's checkpoint (every later DB call hangs). */
  async function alphaDies(w: World) {
    let ckKey: string | null = null;
    const k = killable(w.db, (m, args, phase) => {
      if (m !== 'startAction' || phase !== 'after' || !String(args[0]).includes(':checkpoint:job-a:')) return false;
      ckKey = String(args[0]);
      return true;
    });
    const alpha = makeLoop(w, ALPHA, { db: k.db, zone: 'loop-a' });
    loops.pop(); // dead worker: never await its stop
    void alpha.runOnce();
    await k.killed;
    const wf = (await w.db.listOpenWorkflows())[0]!;
    expect(wf.lease_owner).toBe(ALPHA);
    return { wfId: wf.workflow_id, token: wf.fencing_token, ckKey: ckKey! };
  }

  it('beta (already running, never saw the workflow) adopts alpha\'s expired lease, finishes it, announces the takeover; alpha\'s token is fenced', async () => {
    const w = world();
    const { wfId, token, ckKey } = await alphaDies(w);
    const beta = makeLoop(w, BETA, { zone: 'loop-b' });

    // alpha's lease is live: beta has nothing to do and does not touch the workflow
    const idle = await beta.runOnce();
    expect(idle.status).toBe('idle');
    expect((await w.db.getWorkflow(wfId))!.lease_owner).toBe(ALPHA);

    w.advanceWall(DEFAULT_LEASE_MS + 2_000); // alpha never heartbeats again
    const r = await beta.runOnce();
    expect(r.status).toBe('handled');
    expect(r.workflow_ids).toEqual([wfId]);
    const after = (await w.db.getWorkflow(wfId))!;
    expect(after.stage).toBe('done');
    expect(after.lease_owner).toBe(BETA);
    expect(after.fencing_token > token).toBe(true);
    expect(after.attempt).toBe(2);
    expect(after.state.resumed).toMatchObject({ by_worker: BETA, previous_owner: ALPHA, action: 'resumed_execute' });
    expect((after.state.verification as { verified?: boolean }).verified).toBe(true);
    expect([...w.db.incidents.values()].every((i) => i.state === 'monitoring')).toBe(true);
    await expectExactlyOnce(w.db);
    const snap = await w.db.getObservedSnapshot();
    expect(snap.checkpoints.filter((c) => c.command_key === ckKey && c.status === 'complete')).toHaveLength(1);

    // fencing: the dead worker's token can no longer mutate or heartbeat
    await expect(w.db.updateWorkflow(wfId, after.version, token, 'execute', { stale: true })).rejects.toMatchObject({ code: 'STALE_FENCING_TOKEN' });
    await expect(w.db.heartbeatWorkflow(wfId, ALPHA, token, DEFAULT_LEASE_MS)).rejects.toMatchObject({ code: 'STALE_FENCING_TOKEN' });
    expect((await w.db.getWorkflow(wfId))!.state.stale).toBeUndefined();

    // the takeover was broadcast with the dead worker, the workflow and the new token
    const takeover = beta.messages().find((m) => m.topic === 'takeover' && m.from === 'agent-beta');
    expect(takeover?.to).toBe('all');
    expect(takeover?.text).toBe(`${ALPHA} lease expired on ${wfId}; agent-beta taking over (token ${after.fencing_token})`);
    expect(beta.messages().filter((m) => m.topic === 'takeover')).toHaveLength(1);
  });

  it('alpha comes back while beta owns its old workflow: alpha stands by (stand_by message) and submits nothing', async () => {
    const w = world();
    const { wfId } = await alphaDies(w);
    const beta = makeLoop(w, BETA, { zone: 'loop-b' });
    w.advanceWall(DEFAULT_LEASE_MS + 2_000);

    let alpha2: AgentLoop | null = null;
    let alpha2Start: Promise<void> | null = null;
    w.hooks.push(async () => {
      if (alpha2) return;
      const wf = await w.db.getWorkflow(wfId);
      if (wf?.lease_owner !== BETA || wf.stage === 'done') return;
      // a fresh process with alpha's identity boots while beta is mid-execute
      alpha2 = makeLoop(w, ALPHA, { zone: 'loop-a' });
      alpha2Start = alpha2.start();
    });
    const claimsBefore = w.db.calls.filter((c) => c.method === 'claimAction' && c.args[2] === ALPHA).length;
    const r = await beta.runOnce();
    expect(r.workflow_ids).toEqual([wfId]);
    expect(alpha2).not.toBeNull();
    await alpha2Start;
    expect((await w.db.getWorkflow(wfId))!.lease_owner).toBe(BETA);
    expect((await w.db.getWorkflow(wfId))!.stage).toBe('done');
    const standBy = alpha2!.messages().find((m) => m.topic === 'stand_by' && m.from === 'agent-alpha');
    expect(standBy?.to).toBe('agent-beta');
    expect(standBy?.text).toMatch(new RegExp(`^${BETA} owns ${wfId} now \\(token \\d+\\); agent-alpha standing by$`));
    expect(beta.messages().some((m) => m.topic === 'stand_by' && m.from === 'agent-alpha')).toBe(true);
    expect(alpha2!.lastResume()!.items[0]).toMatchObject({ action: 'nothing_to_do', note: 'LEASE_HELD_BY_LIVE_WORKER' });
    expect(w.db.calls.filter((c) => c.method === 'claimAction' && c.args[2] === ALPHA).length).toBe(claimsBefore);
    await expectExactlyOnce(w.db);
  });

  it('a lone survivor adopts TWO stranded workflows in one tick and finishes both', async () => {
    const w = world();
    const { wfId: wfPump } = await alphaDies(w);
    // gamma claims a second incident (job-c loses a GPU) and dies right after starting its first job-c action
    const snap0 = await w.db.getObservedSnapshot();
    await injectXid(w, [...snap0.job_states.find((j) => j.job_id === 'job-c')!.allocated_gpu_ids].sort()[0]!);
    const kg = killable(w.db, (m, args, phase) => m === 'startAction' && phase === 'after' && String(args[0]).includes(':job-c:'));
    const gamma = makeLoop(w, GAMMA, { db: kg.db });
    loops.pop();
    void gamma.runOnce();
    await kg.killed;
    const open = await w.db.listOpenWorkflows();
    expect(open).toHaveLength(2);
    const wfC = open.find((x) => x.workflow_id !== wfPump)!;
    expect(wfC.lease_owner).toBe(GAMMA);

    const beta = makeLoop(w, BETA);
    w.advanceWall(DEFAULT_LEASE_MS + 2_000);
    const r = await beta.runOnce();
    expect(r.status).toBe('handled');
    expect([...r.workflow_ids].sort()).toEqual([wfPump, wfC.workflow_id].sort());
    for (const id of [wfPump, wfC.workflow_id]) {
      const wf = (await w.db.getWorkflow(id))!;
      expect(wf.lease_owner).toBe(BETA);
      expect(['done', 'escalated']).toContain(wf.stage);
      expect(wf.state.resumed).toMatchObject({ by_worker: BETA });
    }
    expect((await w.db.listOpenWorkflows()).filter((x) => x.stage !== 'escalated')).toHaveLength(0);
    await expectExactlyOnce(w.db);
    const takeovers = beta.messages().filter((m) => m.topic === 'takeover' && m.from === 'agent-beta');
    expect(takeovers.map((m) => m.workflow_id).sort()).toEqual([wfPump, wfC.workflow_id].sort());
    expect(takeovers.some((m) => m.text.startsWith(`${ALPHA} lease expired`))).toBe(true);
    expect(takeovers.some((m) => m.text.startsWith(`${GAMMA} lease expired`))).toBe(true);
  }, 30_000);
});

