import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ActionCommand, SignalEvent } from '@dcos/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentLoop, LLM_UNAVAILABLE_NOTICE, withLlmCircuitBreaker, type AgentLoop, type AgentLoopDeps } from '../src/agent-loop.js';
import { AdapterNotReadyError } from '../src/adapters/errors.js';
import { createDbPort, DB_PORT_METHODS } from '../src/adapters/db.js';
import { createPhysicsPort, PHYSICS_NOT_READY_MESSAGE } from '../src/adapters/physics.js';
import { DEFAULT_LEASE_MS } from '../src/coordinator.js';
import { createEventPublisher } from '../src/events.js';
import { LlmUnavailableError } from '../src/llm.js';
import type { DbPort, LlmChatRequest, LlmPort } from '../src/ports.js';
import { CHOOSE_OPTIONS_TOOL_NAME } from '../src/prompts/planner.js';
import { CLAIM_LEASE_MS } from '../src/resume.js';
import { killable } from '../scripts/crash-test.js';
import { FakeDb, FakeLlm, FakePhysics } from './fakes/index.js';
import { RUN_ID, loadDemoSnapshot, loadPumpDegradedSnapshot, loadSignalXid79Dest, loadSignalXid79R7 } from './fixtures/index.js';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** `wallNow`: one wall clock shared by the DB leases and the loop (default: DB leases on FakeDb's clock, loop at 0). */
function world(wallNow?: () => number) {
  const physics = new FakePhysics();
  const db = new FakeDb({ snapshot: loadPumpDegradedSnapshot(), physics, ...(wallNow ? { now: wallNow } : {}) });
  const simNow = () => {
    let t = 0;
    db.mutateSnapshot((s) => (t = s.clock.sim_time_ms));
    return t;
  };
  const clock = { unixMs: wallNow ?? (() => 0), simTimeMs: simNow };
  const hooks: Array<() => Promise<void> | void> = [];
  const sleep = async () => {
    db.tick(1000);
    for (const h of hooks) await h();
  };
  return { physics, db, clock, sleep, hooks, simNow };
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

const destOf = (c: ActionCommand): string[] =>
  c.operation === 'migrate_restart' ? ((c.arguments.destination_gpu_ids as string[] | undefined) ?? []) : [];

/** Inject XID 79 on job-a's planned destination while its checkpoint runs. Returns the GPU (once injected). */
function armXid(w: World): () => string | null {
  let gpu: string | null = null;
  w.hooks.push(async () => {
    if (gpu) return;
    if (!w.db.listActions().some((a) => a.status === 'running' && a.command_key.includes(':checkpoint:job-a:'))) return;
    const wf = (await w.db.listOpenWorkflows())[0];
    const dest = ((wf?.state.commands ?? []) as ActionCommand[]).flatMap(destOf)[0];
    if (!dest) return;
    const sim = w.simNow();
    const sig: SignalEvent = { ...loadSignalXid79Dest(), event_id: `sig-xid-${dest}-${sim}`, resource_id: dest, sim_time_ms: sim, evidence: { xid_code: 79, gpu_id: dest } };
    gpu = dest;
    w.db.injectSignal(sig);
  });
  return () => gpu;
}

/** Nemotron stand-in for the planner: rank-1 option per job; triage calls get a text reply (-> deterministic). */
const plannerNemotron = (req: LlmChatRequest) => {
  if (!req.tools?.some((t) => t.name === CHOOSE_OPTIONS_TOOL_NAME)) return FakeLlm.text('no tool');
  const user = req.messages.find((m) => m.role === 'user');
  const text = user && 'content' in user ? String(user.content) : '';
  const input = JSON.parse(text.slice(text.indexOf('PLANNING_INPUT=') + 'PLANNING_INPUT='.length)) as { jobs: { job_id: string; options: { option_id: string }[] }[] };
  return FakeLlm.toolCall(CHOOSE_OPTIONS_TOOL_NAME, {
    choices: input.jobs.map((j) => ({ job_id: j.job_id, option_id: j.options[0]!.option_id, needs_approval: false, explanation: 'rank 1 is safest' })),
  });
};

const requestsPerKey = (db: FakeDb) => {
  const m = new Map<string, number>();
  for (const c of db.calls) if (c.method === 'requestAction') {
    const k = (c.args[0] as ActionCommand).command_key;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
};

describe('createAgentLoop.runOnce', () => {
  it('happy path: pump incident -> plan -> execute -> verified, incidents left monitoring', async () => {
    const w = world();
    const loop = makeLoop(w);
    const r = await loop.runOnce();
    expect(r.status).toBe('handled');
    expect(r.new_incident_ids).toHaveLength(1);
    expect(r.workflow_id).toBe(`wf-${r.new_incident_ids[0]}`);
    expect(r.verification?.verified).toBe(true);
    expect(r.executions.at(-1)?.outcomes.every((o) => o.status === 'succeeded')).toBe(true);
    const wf = await w.db.getWorkflow(r.workflow_id!);
    expect(wf?.stage).toBe('done');
    expect([...w.db.incidents.values()].map((i) => i.state)).toEqual(['monitoring']);
    const stages = new Set(w.db.agentEvents.map((e) => e.stage));
    for (const s of ['triage', 'diagnose', 'plan', 'execute', 'verify']) expect(stages.has(s as never)).toBe(true);
    expect(w.db.agentEvents.some((e) => e.stage === 'verify' && e.summary.startsWith('handoff: Recovery verified'))).toBe(true);

    // steady state: nothing new -> idle, no new workflow, no new triage writes
    const before = w.db.calls.filter((c) => c.method === 'upsertSymptoms').length;
    const again = await loop.runOnce();
    expect(again.status).toBe('idle');
    expect(w.db.calls.filter((c) => c.method === 'upsertSymptoms').length).toBe(before);
    expect(await w.db.listOpenWorkflows()).toHaveLength(0);
  });

  it('uses Nemotron choices when the LLM answers and tags the plan event', async () => {
    const w = world();
    const llm = new FakeLlm(Array.from({ length: 4 }, () => plannerNemotron));
    const r = await makeLoop(w, { llm }).runOnce();
    expect(r.verification?.verified).toBe(true);
    expect(r.plans[0]!.job_plans.every((p) => p.decided_by === 'nemotron')).toBe(true);
    expect(w.db.agentEvents.find((e) => e.stage === 'plan')?.actor).toBe('nemotron');
  });

  it('replan path: XID 79 on the planned destination mid-checkpoint -> second incident, new destination', async () => {
    const w = world();
    const xid = armXid(w);
    const r = await makeLoop(w).runOnce();
    expect(xid()).not.toBeNull();
    expect(r.replans).toHaveLength(1);
    expect(r.replans[0]!.new_incident_ids).toHaveLength(1);
    expect(w.db.incidents.size).toBe(2);
    expect([...w.db.incidents.values()].every((i) => i.state === 'monitoring')).toBe(true);
    expect(r.plans).toHaveLength(2);
    expect(r.plans[1]!.commands.flatMap(destOf)).not.toContain(xid());
    const snap = await w.db.getObservedSnapshot();
    expect(snap.job_states.find((j) => j.job_id === 'job-a')!.allocated_gpu_ids).not.toContain(xid());
    expect(r.verification?.verified).toBe(true);
    for (const n of requestsPerKey(w.db).values()) expect(n).toBe(1);
  });

  it('replan with Nemotron: job-a takes another safe placement; feed does not repeat the narrative or triage calls', async () => {
    const w = world();
    const xid = armXid(w);
    const llm = new FakeLlm(Array.from({ length: 8 }, () => plannerNemotron));
    const r = await makeLoop(w, { llm }).runOnce();
    expect(r.replans).toHaveLength(1);
    // §11: the replanned job-a moves (healthy loop-b racks, not the XID GPU), not a power cap in place on loop-a
    const a2 = r.plans[1]!.job_plans.find((p) => p.job_id === 'job-a')!;
    expect(a2.chosen.commands.map((c) => c.operation)).toContain('migrate_restart');
    const snap = await w.db.getObservedSnapshot();
    const rackOf = (g: string) => snap.nodes.find((n) => n.resource_id === snap.gpus.find((x) => x.resource_id === g)?.node_id)?.rack_id;
    const racks = new Set(snap.job_states.find((j) => j.job_id === 'job-a')!.allocated_gpu_ids.map(rackOf));
    for (const hot of ['rack-r2', 'rack-r3', 'rack-r4']) expect(racks.has(hot)).toBe(false);
    expect(snap.job_states.find((j) => j.job_id === 'job-a')!.allocated_gpu_ids).not.toContain(xid());

    const evs = w.db.agentEvents;
    const lastReplan = evs.map((e, i) => [e, i] as const).filter(([e]) => e.stage === 'replan').pop()!;
    const nextPlan = evs.slice(lastReplan[1] + 1).find((e) => e.stage === 'plan')!;
    expect(lastReplan[0].actor).toBe('nemotron');
    expect(nextPlan.summary).not.toBe(lastReplan[0].summary);
    expect(nextPlan.summary).toMatch(/^new plan /);
    const key = (t: { tool: string; args_summary: string; result_summary: string }) => `${t.tool}|${t.args_summary}|${t.result_summary}`;
    const replanCalls = new Set(lastReplan[0].tool_calls.map(key));
    expect(nextPlan.tool_calls.some((t) => t.tool === CHOOSE_OPTIONS_TOOL_NAME && replanCalls.has(key(t)))).toBe(false);

    const triageEv = evs.find((e) => e.stage === 'triage')!;
    const diagEv = evs.find((e) => e.stage === 'diagnose')!;
    const shown = new Set(triageEv.tool_calls.map(key));
    expect(triageEv.tool_calls.length).toBeGreaterThan(0);
    expect(diagEv.tool_calls.some((t) => shown.has(key(t)))).toBe(false);
  });

  it('escalates once the replan cap is reached', async () => {
    const w = world();
    armXid(w);
    const r = await makeLoop(w, { maxReplans: 0 }).runOnce();
    expect(r.escalated).toBe(true);
    expect(r.replans).toHaveLength(0);
    expect((await w.db.getWorkflow(r.workflow_id!))?.stage).toBe('escalated');
    expect([...w.db.incidents.values()].some((i) => i.state === 'escalated')).toBe(true);
  });

  it('never runs two ticks at once', async () => {
    const w = world();
    const loop = makeLoop(w);
    const [a, b] = await Promise.all([loop.runOnce(), loop.runOnce()]);
    expect(a.status).toBe('handled');
    expect(b.status).toBe('busy');
    expect(w.db.calls.filter((c) => c.method === 'claimWorkflow' && c.args[2] === 0)).toHaveLength(1);
  });

  it('LLM throwing LlmUnavailableError -> deterministic plan still completes', async () => {
    const w = world();
    let calls = 0;
    const down: LlmPort = {
      chat: async () => {
        calls += 1;
        throw new LlmUnavailableError('both endpoints down', []);
      },
    };
    const r = await makeLoop(w, { llm: down }).runOnce();
    expect(r.verification?.verified).toBe(true);
    expect(r.plans[0]!.job_plans.every((p) => p.decided_by === 'deterministic')).toBe(true);
    expect(calls).toBe(1); // triage tripped the circuit breaker; the planner did not wait on the LLM again
  });

  it('errors do not crash the loop: reported + published, next tick recovers', async () => {
    const w = world();
    let fail = true;
    const flaky = new Proxy(w.db, {
      get(target, prop, receiver) {
        if (prop === 'getEvidence' && fail) {
          return async () => {
            fail = false;
            throw new Error('db connection reset');
          };
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as DbPort;
    const loop = makeLoop(w, { db: flaky });
    const r1 = await loop.runOnce();
    expect(r1.status).toBe('error');
    expect(r1.error).toContain('db connection reset');
    expect(w.db.agentEvents.some((e) => e.summary.includes('agent error during triage'))).toBe(true);
    const r2 = await loop.runOnce();
    expect(r2.status).toBe('handled');
    expect(r2.verification?.verified).toBe(true);
  });

  it('requireApproval: a deterministic (needs_approval) plan escalates without executing', async () => {
    const w = world();
    const r = await makeLoop(w, { requireApproval: true }).runOnce();
    expect(r.escalated).toBe(true);
    expect(w.db.listActions()).toHaveLength(0);
    expect((await w.db.getWorkflow(r.workflow_id!))?.stage).toBe('escalated');
  });

  it('an incident that affects no running job closes as monitoring (no actions)', async () => {
    const physics = new FakePhysics();
    const db = new FakeDb({ snapshot: loadDemoSnapshot(), physics });
    db.injectSignal(loadSignalXid79R7()); // idle GPU on healthy rack r7
    const w = { ...world(), physics, db };
    const r = await makeLoop(w).runOnce();
    expect(r.status).toBe('handled');
    expect(r.plans[0]!.commands).toHaveLength(0);
    expect(r.escalated).toBe(false);
    expect(db.listActions()).toHaveLength(0);
    expect((await db.getWorkflow(r.workflow_id!))?.stage).toBe('done');
    expect([...db.incidents.values()].map((i) => i.state)).toEqual(['monitoring']);
  });
});

describe('createAgentLoop.start (resume on boot)', () => {
  it('resumes a workflow killed mid-checkpoint with the same keys, then idles', async () => {
    const w = world();
    let killedKey: string | null = null;
    const k = killable(w.db, (m, args, phase) => {
      if (m !== 'startAction' || phase !== 'after' || !String(args[0]).includes(':checkpoint:')) return false;
      killedKey = String(args[0]);
      return true;
    });
    const loop1 = makeLoop(w, { db: k.db, workerId: 'worker-1' });
    loops.pop(); // its tick hangs forever (dead worker): never await its stop
    void loop1.runOnce();
    await k.killed;
    expect(killedKey).not.toBeNull();
    w.db.tick(5_000);
    w.db.advanceWallMs(Math.max(CLAIM_LEASE_MS, DEFAULT_LEASE_MS) + 1_000);

    const events = createEventPublisher({ db: w.db, runId: RUN_ID, clock: w.clock, redact: (s) => s, startSeq: 1000 });
    const loop2 = makeLoop(w, { workerId: 'worker-2', events });
    await loop2.start();
    const rep = loop2.lastResume()!;
    expect(rep.items).toHaveLength(1);
    expect(rep.items[0]!.action).toBe('resumed_execute');
    expect(rep.items[0]!.reconciled.find((x) => x.command_key === killedKey)?.decision).toBe('wait');
    expect(rep.duplicates_detected).toBe(0);
    for (const n of requestsPerKey(w.db).values()) expect(n).toBe(1);
    const snap = await w.db.getObservedSnapshot();
    expect(snap.checkpoints.filter((c) => c.command_key === killedKey && c.status === 'complete')).toHaveLength(1);
    expect(await w.db.listOpenWorkflows()).toHaveLength(0);
    expect([...w.db.incidents.values()].every((i) => i.state === 'monitoring')).toBe(true);
  });

  it('XID 79 on the destination while the agent is dead: resume replans (attempt 2) instead of escalating', async () => {
    const w = world();
    let ckKey: string | null = null;
    const k = killable(w.db, (m, args, phase) => {
      if (m !== 'startAction' || phase !== 'after' || !String(args[0]).includes(':checkpoint:job-a:')) return false;
      ckKey = String(args[0]);
      return true;
    });
    const loop1 = makeLoop(w, { db: k.db, workerId: 'worker-1' });
    loops.pop(); // dead worker: never await its stop
    void loop1.runOnce();
    await k.killed;
    const wf = (await w.db.listOpenWorkflows())[0]!;
    const dest = ((wf.state.commands ?? []) as ActionCommand[]).filter((c) => c.job_id === 'job-a').flatMap(destOf)[0]!;
    expect(dest).toBeDefined();
    const sim = w.simNow() + 1_000;
    w.db.injectSignal({ ...loadSignalXid79Dest(), event_id: `sig-xid-${dest}-${sim}`, resource_id: dest, sim_time_ms: sim, evidence: { xid_code: 79, gpu_id: dest } });
    w.db.advanceWallMs(Math.max(CLAIM_LEASE_MS, DEFAULT_LEASE_MS) + 1_000);

    const events = createEventPublisher({ db: w.db, runId: RUN_ID, clock: w.clock, redact: (s) => s, startSeq: 1000 });
    const loop2 = makeLoop(w, { workerId: 'worker-2', events });
    await loop2.start();
    const item = loop2.lastResume()!.items[0]!;
    expect(item.action).toBe('resumed_execute');
    expect(item.note).toMatch(/REPLANNED/);
    expect(item.reconciled.find((r) => r.command_key === ckKey)?.decision).toBe('wait');
    expect(w.db.agentEvents.some((e) => e.stage === 'replan' && e.summary.includes(dest))).toBe(true);

    // the dead GPU was never targeted again; job-a moved with an attempt-2 key
    const moves = w.db.calls.filter((c) => c.method === 'requestAction' && (c.args[0] as ActionCommand).operation === 'migrate_restart').map((c) => c.args[0] as ActionCommand);
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) {
      expect(destOf(m)).not.toContain(dest);
      expect(m.command_key.endsWith(':2')).toBe(true);
    }
    const snap = await w.db.getObservedSnapshot();
    const jobA = snap.job_states.find((j) => j.job_id === 'job-a')!;
    expect(jobA.allocated_gpu_ids).not.toContain(dest);
    expect(w.db.listActions().find((a) => a.command_key === moves[0]!.command_key)?.status).toBe('succeeded');
    // exactly once: one request per key, the interrupted checkpoint completed once and was kept
    for (const n of requestsPerKey(w.db).values()) expect(n).toBe(1);
    expect(snap.checkpoints.filter((c) => c.command_key === ckKey && c.status === 'complete')).toHaveLength(1);
    expect(w.db.calls.some((c) => c.method === 'requestAction' && (c.args[0] as ActionCommand).command_key.includes(':checkpoint:job-a:2'))).toBe(false);
    expect(await w.db.listOpenWorkflows()).toHaveLength(0);
    expect([...w.db.incidents.values()].some((i) => i.state === 'escalated')).toBe(false);
  });

  it('runs resume before triage, then reacts to db changes until stopped', async () => {
    const w = world();
    const loop = makeLoop(w, { pollMs: 10_000 });
    await loop.start();
    const methods = w.db.calls.map((c) => c.method);
    expect(methods.indexOf('listOpenWorkflows')).toBeLessThan(methods.indexOf('getEvidence'));
    expect(await w.db.listOpenWorkflows()).toHaveLength(0);
    const n = w.db.calls.length;
    w.db.bumpDecisionEpoch(); // onChange -> debounced tick
    await new Promise((r) => setTimeout(r, 40));
    expect(w.db.calls.length).toBeGreaterThan(n);
    await loop.stop();
    const m = w.db.calls.length;
    w.db.bumpDecisionEpoch();
    await new Promise((r) => setTimeout(r, 40));
    expect(w.db.calls.length).toBe(m);
  });
});

/** `db` whose `method` rejects for its first `times` calls (Infinity = always). */
function failing(db: FakeDb, method: keyof DbPort, times: number): DbPort {
  let left = times;
  return new Proxy(db, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (prop === method) {
        return async (...args: unknown[]) => {
          if (left > 0) {
            left -= 1;
            throw new Error(`${String(method)} blew up`);
          }
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as DbPort;
}

describe('review P3 regressions (agent loop)', () => {
  it('#2 a throw inside the workflow drive is queued for retry (not stranded) and then completes', async () => {
    const w = world();
    const loop = makeLoop(w, { db: failing(w.db, 'submitPlan', 1), retryBackoffMs: 0 });
    const r1 = await loop.runOnce();
    expect(r1.status).toBe('error');
    const wfId = r1.workflow_id!;
    expect(wfId).toBeTruthy();
    expect((await w.db.getWorkflow(wfId))?.stage).not.toBe('done');
    expect(w.db.agentEvents.some((e) => e.workflow_id === wfId && /retry 1\/3/.test(e.summary))).toBe(true);
    const r2 = await loop.runOnce();
    expect(r2.status).toBe('handled');
    expect(r2.workflow_id).toBe(wfId);
    expect((await w.db.getWorkflow(wfId))?.stage).toBe('done');
    expect([...w.db.incidents.values()].map((i) => i.state)).toEqual(['monitoring']);
  });

  it('#2 after 3 failed retries the workflow is escalated (stage, incident state, feed event)', async () => {
    const w = world();
    const loop = makeLoop(w, { db: failing(w.db, 'submitPlan', Infinity), retryBackoffMs: 0 });
    const first = await loop.runOnce();
    const wfId = first.workflow_id!;
    for (let i = 0; i < 3; i++) await loop.runOnce();
    expect((await w.db.getWorkflow(wfId))?.stage).toBe('escalated');
    expect([...w.db.incidents.values()].map((i) => i.state)).toEqual(['escalated']);
    expect(w.db.agentEvents.some((e) => e.workflow_id === wfId && e.actor === 'code' && /escalated to operator: .*after 3 retries/.test(e.summary))).toBe(true);
    const claims = w.db.calls.filter((c) => c.method === 'claimWorkflow').length;
    expect((await loop.runOnce()).status).toBe('idle'); // nothing left queued
    expect(w.db.calls.filter((c) => c.method === 'claimWorkflow').length).toBe(claims);
  });

  it('#2 retries back off: a retry is not attempted before its delay', async () => {
    let wall = 1_000;
    const w = world(() => wall);
    const loop = makeLoop(w, { db: failing(w.db, 'submitPlan', 1), retryBackoffMs: 10_000 });
    const wfId = (await loop.runOnce()).workflow_id!;
    await loop.runOnce();
    expect((await w.db.getWorkflow(wfId))?.stage).not.toBe('done');
    wall += 10_000;
    await loop.runOnce();
    expect((await w.db.getWorkflow(wfId))?.stage).toBe('done');
  });

  it('#4 with the LLM down the loop logs the honest deterministic-execution notice and still executes', async () => {
    const w = world();
    const logs: string[] = [];
    const down: LlmPort = { chat: async () => Promise.reject(new LlmUnavailableError('both endpoints down', [])) };
    const r = await makeLoop(w, { llm: down, log: (m) => logs.push(m) }).runOnce();
    expect(r.verification?.verified).toBe(true);
    expect(w.db.listActions().length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes(LLM_UNAVAILABLE_NOTICE))).toBe(true);
    expect(LLM_UNAVAILABLE_NOTICE).toBe('LLM unavailable: executing deterministic, safety-checked plans; flagged needs_approval');
    const main = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
    expect(main).toContain('LLM_UNAVAILABLE_NOTICE');
    expect(main).not.toMatch(/running deterministic \(no Nemotron\)/);
  });

  it('#5 replan persists through the coordinator: the workflow is claimed once, never re-claimed', async () => {
    const w = world();
    armXid(w);
    const r = await makeLoop(w).runOnce();
    expect(r.replans).toHaveLength(1);
    expect(r.verification?.verified).toBe(true);
    expect(w.db.calls.filter((c) => c.method === 'claimWorkflow' && c.args[0] === r.workflow_id)).toHaveLength(1);
  });

  it('#6 a workflow skipped as LEASE_HELD_BY_LIVE_WORKER is taken over once that lease expires', async () => {
    let wall = 1_794_091_200_000;
    const w = world(() => wall);
    const k = killable(w.db, (m, args, phase) => m === 'startAction' && phase === 'after' && String(args[0]).includes(':checkpoint:'));
    const loop1 = makeLoop(w, { db: k.db, workerId: 'worker-1' });
    loops.pop(); // dead worker: never await its stop
    void loop1.runOnce();
    await k.killed;

    const events = createEventPublisher({ db: w.db, runId: RUN_ID, clock: w.clock, redact: (s) => s, startSeq: 1000 });
    const loop2 = makeLoop(w, { workerId: 'worker-2', events, pollMs: 1e8, debounceMs: 1e8 });
    await loop2.start(); // worker-1's lease has not expired yet
    expect(loop2.lastResume()!.items[0]).toMatchObject({ action: 'nothing_to_do', note: 'LEASE_HELD_BY_LIVE_WORKER' });
    expect(await w.db.listOpenWorkflows()).toHaveLength(1);

    wall += DEFAULT_LEASE_MS + 5_000; // worker-1 never heartbeats again
    const r = await loop2.runOnce();
    expect(r.status).toBe('handled');
    expect(await w.db.listOpenWorkflows()).toHaveLength(0);
    for (const n of requestsPerKey(w.db).values()) expect(n).toBe(1);
    expect([...w.db.incidents.values()].every((i) => i.state === 'monitoring')).toBe(true);
  });
});

describe('withLlmCircuitBreaker', () => {
  it('fails fast during the cooldown after an outage, then retries', async () => {
    let t = 0;
    let calls = 0;
    const inner: LlmPort = {
      chat: async () => {
        calls += 1;
        if (calls === 1) throw new LlmUnavailableError('down', []);
        return FakeLlm.text('ok');
      },
    };
    const llm = withLlmCircuitBreaker(inner, 1000, () => t);
    await expect(llm.chat({ messages: [] })).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(llm.chat({ messages: [] })).rejects.toThrow(/circuit open/);
    expect(calls).toBe(1);
    t = 2000;
    await expect(llm.chat({ messages: [] })).resolves.toMatchObject({ content: 'ok' });
  });
});

describe('adapters', () => {
  const notFound = async () => {
    const e = new Error("Cannot find package '@dcos/x'") as Error & { code: string };
    e.code = 'ERR_MODULE_NOT_FOUND';
    throw e;
  };

  it('physics: missing package or functions -> AdapterNotReadyError naming what is needed', async () => {
    await expect(createPhysicsPort(notFound)).rejects.toBeInstanceOf(AdapterNotReadyError);
    await expect(createPhysicsPort(async () => ({ simulatePlan: () => null }))).rejects.toThrow(PHYSICS_NOT_READY_MESSAGE);
    await expect(createPhysicsPort(async () => ({ simulatePlan: () => null }))).rejects.toThrow(/missing: evaluateSafety, thresholdPolicy/);
  });

  it('physics: delegates to the real functions when present', async () => {
    const fake = new FakePhysics();
    const port = await createPhysicsPort(async () => ({
      simulatePlan: fake.simulatePlan.bind(fake),
      evaluateSafety: fake.evaluateSafety.bind(fake),
      thresholdPolicy: fake.thresholdPolicy.bind(fake),
    }));
    const snap = loadPumpDegradedSnapshot();
    expect(port.simulatePlan(snap, { commands: [] })).toEqual(fake.simulatePlan(snap, { commands: [] }));
  });

  it('db: missing package / connect / wrappers -> AdapterNotReadyError; complete client is bound', async () => {
    const cfg = { uri: 'ws://x', db: 'dcos', token: 't' };
    await expect(createDbPort(cfg, notFound)).rejects.toThrow(/P2 @dcos\/db-client not shipped yet/);
    await expect(createDbPort(cfg, async () => ({}))).rejects.toThrow(/no connect/);
    await expect(createDbPort(cfg, async () => ({ connect: async () => ({ getObservedSnapshot: () => null }) }))).rejects.toThrow(/missing wrapper/);
    const fakeDb = new FakeDb({ snapshot: loadPumpDegradedSnapshot() });
    let seen: unknown = null;
    const port = await createDbPort(cfg, async () => ({ connect: async (o: unknown) => ((seen = o), fakeDb) }));
    expect(seen).toEqual(cfg);
    expect(DB_PORT_METHODS.every((m) => typeof port[m] === 'function')).toBe(true);
    expect((await port.getObservedSnapshot()).run_id).toBe(RUN_ID);
    await flush();
  });
});
