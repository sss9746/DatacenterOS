// Integration: P3's createAgentLoop end-to-end with P2's REAL `createMockClient()` as the DbPort (not FakeDb),
// the REAL @dcos/physics adapter as PhysicsPort, and P1's evaluateSafety plugged into the mock's requestAction.
// llm = null (deterministic). Mismatches between P2's mock and P3's FakeDb are asserted/documented here.
import type { ActionCommand, ObservedSnapshot } from '@dcos/contracts';
import { connect, createMockClient, type DbClient, type MockDbClient } from '@dcos/db-client';
import * as physicsPkg from '@dcos/physics';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAgentLoop, type AgentLoop, type AgentLoopDeps } from '../../src/agent-loop.js';
import { createDbPort, DB_PORT_METHODS, type DbConnectConfig } from '../../src/adapters/db.js';
import { createPhysicsPort } from '../../src/adapters/physics.js';
import { DEFAULT_LEASE_MS } from '../../src/coordinator.js';
import { createEventPublisher } from '../../src/events.js';
import type { DbPort, PhysicsPort } from '../../src/ports.js';
import { CLAIM_LEASE_MS } from '../../src/resume.js';
import { killable } from '../../scripts/crash-test.js';
import { LOOP_A_RACKS, demoPumpFault, newDriver, observe, rackOf, runUntil } from './physics-driver.js';

// ---- compile-time boundary checks (tsc --noEmit covers test/**) -------------------------------------
const _mockIsPort: DbPort = createMockClient();
void _mockIsPort;
const _connectShape: (o: DbConnectConfig) => Promise<DbPort> = connect; // live connect() vs the adapter's call
void _connectShape;
const _clientIsPort = (c: DbClient): DbPort => c;
void _clientIsPort;

const RUN_ID = 'run-demo-1';

let physics: PhysicsPort;
beforeAll(async () => {
  physics = await createPhysicsPort();
});

/**
 * HARNESS SHIMS for two integration bugs (each reported; each also has an un-shimmed `it.fails` spec below):
 *  - freshTelemetry: P2's mock tick() never advances gpus[].last_seen_sim_ms, so P1's evaluateSafety reports
 *    EVIDENCE_STALE (> 10 sim-s) on every request after the first ~10 ticks. Live DB runs real step(), which does.
 *  - restampEpoch: P3's coordinator requests plan steps one at a time with the PLAN-time expected_decision_epoch,
 *    but a checkpoint starting/completing is a material change (real physics + P2 mock bump the epoch), so every
 *    later step is STALE_DECISION_EPOCH. The shim re-stamps the epoch at request time (one candidate P3 fix).
 */
export interface Shims {
  freshTelemetry: boolean;
  restampEpoch: boolean;
}
const NO_SHIMS: Shims = { freshTelemetry: false, restampEpoch: false };
const ALL_SHIMS: Shims = { freshTelemetry: true, restampEpoch: true };

const withFreshTelemetry = (f: typeof physicsPkg.evaluateSafety): typeof physicsPkg.evaluateSafety => (obs, cmd, ctx) => {
  const o = structuredClone(obs);
  for (const g of o.gpus) if (g.availability !== 'unreachable') g.last_seen_sim_ms = o.clock.sim_time_ms;
  return f(o, cmd, ctx);
};

/** Same shims on the agent's own PhysicsPort: P3's coordinator prechecks every step locally with evaluateSafety. */
function shimPhysics(p: PhysicsPort, shims: Shims): PhysicsPort {
  const base = shims.freshTelemetry ? withFreshTelemetry(p.evaluateSafety) : p.evaluateSafety;
  return {
    ...p,
    evaluateSafety: (obs, cmd, ctx) => base(obs, shims.restampEpoch ? { ...cmd, expected_decision_epoch: ctx.decision_epoch } : cmd, ctx),
  };
}

function withEpochRestamp(mock: MockDbClient): DbPort {
  return new Proxy(mock, {
    get(target, prop) {
      if (prop !== 'requestAction') return Reflect.get(target, prop, target);
      return async (cmd: ActionCommand) => {
        if (await target.getActionStatus(cmd.command_key)) return target.requestAction(cmd); // idempotent replay
        const epoch = (await target.getObservedSnapshot()).clock.decision_epoch;
        return target.requestAction({ ...cmd, expected_decision_epoch: epoch });
      };
    },
  }) as DbPort;
}

interface World {
  mock: MockDbClient;
  /** What the agent talks to: the mock, optionally behind the epoch shim. */
  db: DbPort;
  physics: PhysicsPort;
  /** Real wall time + an offset we jump forward to expire leases (P3 heartbeats on a real setInterval). */
  wall: { readonly now: number; offset: number };
  sim: () => number;
  sleep: () => Promise<void>;
  hooks: Array<() => Promise<void> | void>;
}

async function world(snapshot: 'pump_degraded' | ObservedSnapshot, shims: Shims = ALL_SHIMS): Promise<World> {
  const wall = { offset: 0, get now() { return Date.now() + this.offset; } };
  const evaluateSafety = shims.freshTelemetry ? withFreshTelemetry(physicsPkg.evaluateSafety) : physicsPkg.evaluateSafety;
  const mock = createMockClient({ snapshot, now: () => wall.now, evaluateSafety });
  const db = shims.restampEpoch ? withEpochRestamp(mock) : mock;
  let sim = (await mock.getObservedSnapshot()).clock.sim_time_ms;
  const hooks: Array<() => Promise<void> | void> = [];
  const sleep = async () => {
    mock.tick(1000);
    sim += 1000;
    for (const h of hooks) await h();
  };
  return { mock, db, physics: shimPhysics(physics, shims), wall, sim: () => sim, sleep, hooks };
}

const loops: AgentLoop[] = [];
function makeLoop(w: World, over: Partial<AgentLoopDeps> = {}): AgentLoop {
  const db = over.db ?? w.db;
  const clock = { unixMs: () => w.wall.now, simTimeMs: w.sim };
  const events = over.events ?? createEventPublisher({ db, runId: RUN_ID, clock, redact: (s) => s });
  const loop = createAgentLoop({
    db, physics: w.physics, llm: null, events, workerId: 'worker-1', runId: RUN_ID, clock, sleep: w.sleep,
    log: () => undefined, pollMs: 50, debounceMs: 10, ...over,
  });
  loops.push(loop);
  return loop;
}
afterEach(async () => {
  for (const l of loops.splice(0)) await l.stop();
});

const destOf = (c: ActionCommand): string[] =>
  c.operation === 'migrate_restart' ? ((c.arguments.destination_gpu_ids as string[] | undefined) ?? []) : [];
const requested = (m: MockDbClient) => m.calls.filter((c) => c.method === 'requestAction').map((c) => c.args[0] as ActionCommand);
const perKey = (m: MockDbClient) => {
  const n = new Map<string, number>();
  for (const c of requested(m)) n.set(c.command_key, (n.get(c.command_key) ?? 0) + 1);
  return n;
};
/** No GPU allocated to two jobs; allocations agree with job_states. */
function assertNoDoubleAllocation(s: ObservedSnapshot): void {
  const owner = new Map<string, string>();
  for (const a of s.allocations) {
    expect(owner.get(a.gpu_id), `${a.gpu_id} double-allocated`).toBeUndefined();
    owner.set(a.gpu_id, a.job_id);
  }
  for (const j of s.job_states) for (const g of j.allocated_gpu_ids) expect(owner.get(g) ?? j.job_id).toBe(j.job_id);
}

describe('adapter wiring', () => {
  it('createDbPort binds every DbPort method of a db-client (mock stands in for connect)', async () => {
    const mock = createMockClient();
    const port = await createDbPort({ uri: 'ws://unused', db: 'dcos-dev', token: 'x' }, async () => ({ connect: () => mock }));
    for (const m of DB_PORT_METHODS) expect(typeof (port as unknown as Record<string, unknown>)[m]).toBe('function');
    expect((await port.getObservedSnapshot()).run_id).toBe(RUN_ID);
  });
});

describe('UN-SHIMMED specs (expected to fail until the reported bugs are fixed)', () => {
  const runPlain = async (shims: Shims) => {
    const w = await world('pump_degraded', shims);
    const r = await makeLoop(w).runOnce();
    return { w, r, outcomes: r.executions.flatMap((e) => e.outcomes) };
  };
  it.fails('P3 bug: with fresh telemetry only, every planned step succeeds (today: STALE_DECISION_EPOCH)', async () => {
    const { outcomes } = await runPlain({ freshTelemetry: true, restampEpoch: false });
    expect(outcomes.filter((o) => o.status !== 'succeeded')).toEqual([]);
  });
  it('P3 bug (observed): later steps are blocked with STALE_DECISION_EPOCH and the workflow escalates', async () => {
    const { r, outcomes } = await runPlain({ freshTelemetry: true, restampEpoch: false });
    expect(outcomes[0]!.status).toBe('succeeded'); // job-a checkpoint
    expect(outcomes.some((o) => o.status === 'blocked' && o.violations?.includes('STALE_DECISION_EPOCH'))).toBe(true);
    expect(r.verification?.verified).toBe(false);
  });
  it.fails('P2 mock bug: with the epoch shim only, no step is EVIDENCE_STALE (today: mock never refreshes last_seen)', async () => {
    const { outcomes } = await runPlain({ freshTelemetry: false, restampEpoch: true });
    expect(outcomes.filter((o) => o.violations?.includes('EVIDENCE_STALE'))).toEqual([]);
  });
});

describe('agent loop on P2 createMockClient("pump_degraded") + real physics (both shims)', () => {
  it('pump fault -> plan -> execute -> verify; no duplicate keys, no double allocation', async () => {
    const w = await world('pump_degraded');
    const r = await makeLoop(w).runOnce();
    expect(r.error).toBeUndefined();
    expect(r.status).toBe('handled');
    expect(r.new_incident_ids).toHaveLength(1);
    const cmds = r.plans[0]!.commands;
    const aMove = cmds.find((c) => c.job_id === 'job-a' && c.operation === 'migrate_restart');
    expect(aMove).toBeDefined();
    for (const g of destOf(aMove!)) expect(LOOP_A_RACKS.has(rackOf(g)) || rackOf(g) === 'r6').toBe(false);
    expect(r.executions.at(-1)!.outcomes.map((o) => `${o.command_key}=${o.status}`)).toEqual(
      r.executions.at(-1)!.outcomes.map((o) => `${o.command_key}=succeeded`),
    );
    expect(r.verification?.verified).toBe(true);
    for (const n of perKey(w.mock).values()) expect(n).toBe(1);
    const snap = await w.mock.getObservedSnapshot();
    assertNoDoubleAllocation(snap);
    expect(snap.job_states.find((j) => j.job_id === 'job-a')!.allocated_gpu_ids.sort()).toEqual([...destOf(aMove!)].sort());
    expect(await w.mock.listOpenWorkflows()).toHaveLength(0);
  });
});

describe('agent loop on P2 mock loaded with the REAL physics world (pump-a @610000, +120 sim-s)', () => {
  it('handles the incident end to end on a §0.12-clocked snapshot', async () => {
    const d = newDriver(117, [demoPumpFault()]);
    runUntil(d, 730_000);
    const w = await world(observe(d));
    expect(w.sim()).toBe(730_000);
    // the mock carries no signals for a raw snapshot: hand it the physics signals as the DB tick would
    for (const s of d.signals) w.mock.injectSignal(s);
    const r = await makeLoop(w).runOnce();
    expect(r.error).toBeUndefined();
    expect(r.status).toBe('handled');
    expect(r.new_incident_ids).toHaveLength(1);
    expect(r.verification?.verified).toBe(true);
    for (const n of perKey(w.mock).values()) expect(n).toBe(1);
    assertNoDoubleAllocation(await w.mock.getObservedSnapshot());
  });
});

describe('crash / resume on P2 mock', () => {
  it('worker-1 dies mid-checkpoint; worker-2 resumes by command_key: no duplicate request, one checkpoint, no double allocation', async () => {
    const w = await world('pump_degraded');
    let killedKey: string | null = null;
    const k = killable(w.db, (m, args, phase) => {
      if (m !== 'startAction' || phase !== 'after' || !String(args[0]).includes(':checkpoint:')) return false;
      killedKey = String(args[0]);
      return true;
    });
    const loop1 = makeLoop(w, { db: k.db, workerId: 'worker-1' });
    loops.pop(); // dead worker: its tick hangs forever, never await stop
    void loop1.runOnce();
    await k.killed;
    expect(killedKey).not.toBeNull();
    for (let i = 0; i < 5; i += 1) w.mock.tick(1000);
    w.wall.offset += Math.max(CLAIM_LEASE_MS, DEFAULT_LEASE_MS) + 1_000;

    const before = perKey(w.mock);
    const clock = { unixMs: () => w.wall.now, simTimeMs: w.sim };
    const events = createEventPublisher({ db: w.db, runId: RUN_ID, clock, redact: (s) => s, startSeq: 1000 });
    const loop2 = makeLoop(w, { workerId: 'worker-2', events });
    await loop2.start();
    const rep = loop2.lastResume()!;
    expect(rep.items).toHaveLength(1);
    expect(rep.items[0]!.action).toBe('resumed_execute');
    expect(rep.items[0]!.reconciled.find((x) => x.command_key === killedKey)?.decision).toBe('wait');
    expect(rep.duplicates_detected).toBe(0);
    for (const [key, n] of perKey(w.mock)) expect(n, key).toBe(1);
    expect(perKey(w.mock).get(killedKey!)).toBe(before.get(killedKey!));
    const snap = await w.mock.getObservedSnapshot();
    expect(snap.checkpoints.filter((c) => c.command_key === killedKey && c.status === 'complete')).toHaveLength(1);
    assertNoDoubleAllocation(snap);
    expect(await w.mock.listOpenWorkflows()).toHaveLength(0);
  });
});
