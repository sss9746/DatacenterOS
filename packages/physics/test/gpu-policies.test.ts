// P1-8: baseline policies reactivePolicy / thresholdPolicy (CONTRACTS §0.6, ARCHITECTURE §9).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validatePayload, type ActionCommand, type GpuCurrent, type ObservedSnapshot, type PhysicsWorld } from '@dcos/contracts';
import {
  THRESHOLD_TEMP_C,
  enqueueCommands,
  evaluateSafety,
  loadScenarios,
  reactivePolicy,
  scenarioTickInput,
  scenarioWorld,
  step,
  thresholdPolicy,
  toObserved,
  type Policy,
  type Scenario,
} from '../src/index.js';
import { T0, deepFreeze, gpusOn, readFixture } from './gpu-helpers.js';

const PUMP = readFixture<ObservedSnapshot>('observed_snapshot_pump_degraded.json');
const DEMO = readFixture<ObservedSnapshot>('observed_snapshot_demo.json');
const SCENARIOS = loadScenarios();
const scenario = (id: string): Scenario => SCENARIOS.find((s) => s.scenario_id === id)!;
const POLICIES = { reactive: reactivePolicy, threshold: thresholdPolicy } as const;

const allow = (obs: ObservedSnapshot, c: ActionCommand) =>
  evaluateSafety(obs, c, { decision_epoch: obs.clock.decision_epoch, leased_resource_ids: [] });
const keys = (cmds: ActionCommand[]) => cmds.map((c) => c.command_key);
const dest = (c: ActionCommand) => (c.arguments.destination_gpu_ids as string[] | undefined) ?? [];
const job = (o: ObservedSnapshot, id: string) => o.job_states.find((j) => j.job_id === id)!;
const nodeOf = (gpuId: string) => gpuId.replace(/^gpu-(r\d+-n1)-\d+$/, 'node-$1');

function expectValid(cmds: ActionCommand[]): void {
  for (const c of cmds) {
    expect(validatePayload('ActionCommand', c), c.command_key).toEqual({ ok: true });
    expect(c.action_id).toBe(c.command_key);
  }
  expect(new Set(keys(cmds)).size).toBe(cmds.length); // unique within one call
}

/** Step a scenario with no actions until the clock reaches run start + untilMs (or stop() says so). Returns the world. */
function advance(s: Scenario, untilMs: number, stop?: (o: ObservedSnapshot) => boolean): PhysicsWorld {
  let w = scenarioWorld(s);
  while (w.observable.clock.sim_time_ms < T0 + untilMs) {
    w = step(scenarioTickInput(s, w)).world_after;
    if (stop?.(w.observable)) break;
  }
  return w;
}

interface Emitted {
  t: number;
  obs: ObservedSnapshot;
  cmd: ActionCommand;
}

interface Drive {
  /** Every key the policy returned per tick (including repeats). */
  perTick: { t: number; obs: ObservedSnapshot; keys: string[] }[];
  /** First emission of each key, with the snapshot it was planned on. */
  emitted: Emitted[];
  completed: string[];
  failed: string[];
  final: ObservedSnapshot;
}

/**
 * A minimal trusted harness (untilMs is an offset from the run start): each tick, call the policy on toObserved(world), enqueue keys it has not seen (first
 * payload wins), request a command once all its depends_on keys have completed, then step.
 */
function drive(s: Scenario, policy: (o: ObservedSnapshot) => ActionCommand[], untilMs = s.horizon_s * 1000): Drive {
  let w = scenarioWorld(s);
  const known = new Map<string, ActionCommand>();
  const requested = new Set<string>();
  const done = new Set<string>();
  const out: Drive = { perTick: [], emitted: [], completed: [], failed: [], final: toObserved(w) };
  while (w.observable.clock.sim_time_ms < T0 + untilMs) {
    const obs = toObserved(w);
    const cmds = policy(obs);
    out.perTick.push({ t: obs.clock.sim_time_ms, obs, keys: keys(cmds) });
    const fresh = cmds.filter((c) => !known.has(c.command_key));
    for (const c of fresh) {
      known.set(c.command_key, c);
      out.emitted.push({ t: obs.clock.sim_time_ms, obs, cmd: c });
    }
    w = enqueueCommands(w, fresh);
    const ready = [...known.values()].filter((c) => !requested.has(c.command_key) && c.depends_on_command_keys.every((k) => done.has(k)));
    for (const c of ready) requested.add(c.command_key);
    const r = step(scenarioTickInput(s, w, ready.map((c) => c.action_id)));
    for (const k of r.completed_command_keys) done.add(k);
    out.completed.push(...r.completed_command_keys);
    out.failed.push(...r.failed_command_keys);
    w = r.world_after;
  }
  out.final = toObserved(w);
  return out;
}

/**
 * The private-field guard: a deep-frozen copy of `obs` with decoy private keys added at every level, wrapped in a
 * deep Proxy that throws on any read / `in` / descriptor lookup of a private key. Proxy targets are fresh empty
 * objects / arrays (a frozen target would force the trap to return the raw, unwrapped child).
 */
const FORBIDDEN = ['active_faults_private', 'hidden_physics_state_json', 'due_faults_private', 'observable'];
let forbiddenHits = 0;
function guarded<T extends object>(obs: T): T {
  const decoy = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(decoy);
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(x)) o[k] = decoy(v);
      for (const k of FORBIDDEN) o[k] = { secret: true };
      return o;
    }
    return x;
  };
  const frozen = deepFreeze(decoy(JSON.parse(JSON.stringify(obs))));
  const cache = new WeakMap<object, unknown>();
  const trip = (k: PropertyKey) => {
    if (typeof k === 'string' && FORBIDDEN.includes(k)) {
      forbiddenHits += 1;
      throw new Error(`policy touched private field ${k}`);
    }
  };
  const wrap = (v: unknown): unknown => {
    if (!v || typeof v !== 'object') return v;
    const hit = cache.get(v);
    if (hit) return hit;
    const src = v as Record<PropertyKey, unknown>;
    const p = new Proxy(Array.isArray(v) ? [] : {}, {
      get: (_t, k) => { trip(k); return wrap(Reflect.get(src, k, src)); },
      has: (_t, k) => { trip(k); return Reflect.has(src, k); },
      // the decoys stay enumerable, so copying / spreading / serializing a row also trips the guard
      ownKeys: () => Reflect.ownKeys(src),
      getOwnPropertyDescriptor: (_t, k) => {
        trip(k);
        const d = Reflect.getOwnPropertyDescriptor(src, k);
        if (!d) return undefined;
        return k === 'length' && Array.isArray(src)
          ? { value: src.length, writable: true, enumerable: false, configurable: false }
          : { value: wrap(d.value), writable: false, enumerable: d.enumerable, configurable: true };
      },
      set: () => { throw new Error('snapshot is frozen'); },
      defineProperty: () => { throw new Error('snapshot is frozen'); },
      deleteProperty: () => { throw new Error('snapshot is frozen'); },
    });
    cache.set(v, p);
    return p;
  };
  return wrap(frozen) as T;
}

// ---- runs shared by several tests ----------------------------------------------------------------------

const SC03 = scenario('sc03-severe-pump');
const SC04 = scenario('sc04-failed-gpu-xid79');
const sc03Threshold = drive(SC03, thresholdPolicy);
const sc04Reactive = drive(SC04, reactivePolicy);

describe('Policy interface (CONTRACTS §0.6)', () => {
  it('both baselines are assignable to Policy and accept the harness ctx', async () => {
    const ps: Policy[] = [reactivePolicy, thresholdPolicy];
    for (const p of ps) expect(await p(PUMP, { sim_time_ms: PUMP.clock.sim_time_ms })).toEqual([]);
    expect(THRESHOLD_TEMP_C).toBe(83);
  });

  it('every command from every scenario run passes validatePayload("ActionCommand")', () => {
    for (const d of [sc03Threshold, sc04Reactive]) {
      expect(d.emitted.length).toBeGreaterThan(0);
      for (const { obs, cmd } of d.emitted) {
        expectValid([cmd]);
        expect(cmd).toMatchObject({
          run_id: obs.run_id, expected_decision_epoch: obs.clock.decision_epoch, requested_sim_time_ms: obs.clock.sim_time_ms,
        });
        expect(cmd.incident_ids.length).toBeGreaterThan(0);
        for (const [id, v] of Object.entries(cmd.expected_resource_versions)) {
          const row = obs.gpus.find((g) => g.resource_id === id) ?? obs.job_states.find((j) => j.job_id === id);
          expect(row?.version, id).toBe(v);
        }
        if (cmd.job_id) expect(cmd.expected_resource_versions[cmd.job_id]).toBe(job(obs, cmd.job_id).version);
        for (const g of dest(cmd)) expect(cmd.expected_resource_versions[g]).toBeDefined();
      }
    }
  });
});

describe('fixtures', () => {
  it('pump-degraded snapshot (no XID, hottest GPU 82.1 °C on r6): neither policy acts', () => {
    expect(PUMP.gpus.every((g) => g.last_xid_code === null)).toBe(true);
    expect(Math.max(...PUMP.gpus.map((g) => g.temp_c))).toBeLessThanOrEqual(THRESHOLD_TEMP_C);
    expect(reactivePolicy(PUMP)).toEqual([]);
    expect(thresholdPolicy(PUMP)).toEqual([]);
    expect(reactivePolicy(DEMO)).toEqual([]);
    expect(thresholdPolicy(DEMO)).toEqual([]);
  });

  it('a hot GPU never moves reactivePolicy; it does trigger thresholdPolicy', () => {
    const hot = structuredClone(PUMP);
    for (const g of hot.gpus) if (g.node_id === 'node-r2-n1') g.temp_c = 88;
    expect(reactivePolicy(hot)).toEqual([]);
    const t = thresholdPolicy(hot);
    expectValid(t);
    expect(t.map((c) => [c.operation, c.job_id])).toEqual([['checkpoint', 'job-a'], ['migrate_restart', 'job-a']]);
  });
});

describe('reactivePolicy', () => {
  it('sc04 XID 79 on gpu-r3-n1-5: cordons it and restarts job-a from its checkpoint on 16 free ready GPUs', () => {
    const before = toObserved(advance(SC04, 59_000));
    expect(reactivePolicy(before)).toEqual([]); // nothing before the fault
    const obs = toObserved(advance(SC04, 60_000));
    expect(obs.gpus.find((g) => g.resource_id === 'gpu-r3-n1-5')).toMatchObject({ last_xid_code: 79, availability: 'unreachable' });
    expect(job(obs, 'job-a').status).toBe('failed');
    const cmds = reactivePolicy(obs);
    expectValid(cmds);
    expect(keys(cmds)).toEqual(['reactive.gpu-r3-n1-5.cordon_gpu.xid79', 'reactive.job-a.migrate_restart.v1']);
    const [cordon, restart] = cmds as [ActionCommand, ActionCommand];
    expect(cordon).toMatchObject({
      operation: 'cordon_gpu', target_resource_id: 'gpu-r3-n1-5', job_id: null, incident_ids: ['inc.reactive.gpu-r3-n1-5'],
      expected_resource_versions: { 'gpu-r3-n1-5': 1 }, depends_on_command_keys: [],
    });
    expect(restart).toMatchObject({
      operation: 'migrate_restart', target_resource_id: 'job-a', job_id: 'job-a', incident_ids: ['inc.reactive.gpu-r3-n1-5'],
      workflow_id: 'wf.reactive.gpu-r3-n1-5', plan_id: 'plan.reactive.gpu-r3-n1-5',
    });
    expect(restart.arguments.from_checkpoint_id).toBe('ckpt-job-a-1');
    const d = dest(restart);
    expect(d).toHaveLength(16);
    expect(new Set(d).size).toBe(16);
    expect(d).not.toContain('gpu-r3-n1-5');
    for (const g of d) expect(obs.gpus.find((x) => x.resource_id === g)!.availability).toBe('ready');
    expect(allow(obs, restart).decision).toBe('allow');
    expect(allow(obs, cordon).decision).toBe('allow');
  });

  it('sc04: feeding its commands into step completes them; job-a runs again on the new GPUs', () => {
    expect(sc04Reactive.completed).toEqual(['reactive.gpu-r3-n1-5.cordon_gpu.xid79', 'reactive.job-a.migrate_restart.v1']);
    expect(sc04Reactive.failed).toEqual([]);
    const a = job(sc04Reactive.final, 'job-a');
    expect(a.status).toBe('running');
    expect(a.allocated_gpu_ids).toEqual(dest(sc04Reactive.emitted[1]!.cmd));
    expect(a.progress_work_units).toBeGreaterThan(86_400); // restarted from the durable 86,400 and progressing
  });

  it('sc15 XID 48 (reachable but degraded): same_node job-b restarts on ONE free node', () => {
    const obs = toObserved(advance(scenario('sc15-xid48-ecc'), 90_000));
    const cmds = reactivePolicy(obs);
    expectValid(cmds);
    expect(keys(cmds)).toEqual(['reactive.gpu-r4-n1-6.cordon_gpu.xid48', 'reactive.job-b.migrate_restart.v1']);
    const d = dest(cmds[1]!);
    expect(d).toHaveLength(8);
    expect(new Set(d.map(nodeOf)).size).toBe(1);
    expect(allow(obs, cmds[1]!).decision).toBe('allow');
  });

  it('no free compatible placement → escalate (and never places on the real GPU)', () => {
    const obs = structuredClone(toObserved(advance(SC04, 60_000)));
    for (const n of obs.nodes) if (!['node-r3-n1', 'node-r4-n1', 'node-r6-n1'].includes(n.resource_id)) n.availability = 'unreachable';
    // r3 has only 7 ready GPUs left; a ready gpu-real-0 row on r3 would make 8 but must never count
    const real: GpuCurrent = { ...obs.gpus.find((g) => g.resource_id === 'gpu-r3-n1-0')!, resource_id: 'gpu-real-0' };
    obs.gpus.push(real);
    const cmds = reactivePolicy(obs);
    expectValid(cmds);
    expect(keys(cmds)).toEqual(['reactive.gpu-r3-n1-5.cordon_gpu.xid79', 'reactive.job-a.escalate.no_destination.v1']);
    expect(cmds[1]).toMatchObject({ operation: 'escalate', job_id: 'job-a', arguments: { reason: 'no_destination' } });
  });

  it('an XID on the real GPU escalates instead of cordoning; already-cordoned GPUs are not re-cordoned', () => {
    const obs = structuredClone(DEMO);
    obs.gpus.push({ ...obs.gpus[0]!, resource_id: 'gpu-real-0', node_id: 'node-r1-n1', last_xid_code: 79, availability: 'unreachable' });
    obs.gpus.find((g) => g.resource_id === 'gpu-r1-n1-3')!.last_xid_code = 48;
    obs.gpus.find((g) => g.resource_id === 'gpu-r1-n1-3')!.availability = 'cordoned';
    const cmds = reactivePolicy(obs);
    expectValid(cmds);
    expect(keys(cmds)).toEqual(['reactive.gpu-real-0.escalate.xid79']);
  });

  it('never reacts to temperature: sc03 (r2–r4 throttle and shut down) gets no command at all', () => {
    const d = drive(SC03, reactivePolicy);
    expect(d.perTick.every((p) => p.keys.length === 0)).toBe(true);
    expect(d.perTick.some((p) => p.obs.gpus.some((g) => g.temp_c > 85))).toBe(true);
  });
});

describe('thresholdPolicy', () => {
  it('stays quiet until a job GPU passes 83 °C; then checkpoint + migrate for job-a (and job-b)', () => {
    const first = sc03Threshold.perTick.find((p) => p.keys.length > 0)!;
    const prior = sc03Threshold.perTick.filter((p) => p.t < first.t);
    for (const p of prior) {
      expect(p.obs.job_states.flatMap((j) => j.allocated_gpu_ids)
        .every((g) => p.obs.gpus.find((x) => x.resource_id === g)!.temp_c <= THRESHOLD_TEMP_C)).toBe(true);
    }
    const ofA = sc03Threshold.emitted.filter((e) => e.cmd.job_id === 'job-a');
    expect(ofA.map((e) => e.cmd.command_key)).toEqual([
      'threshold.job-a.checkpoint.after.ckpt-job-a-1', 'threshold.job-a.migrate_restart.after.ckpt-job-a-1',
    ]);
    const [ck, mv] = ofA as [Emitted, Emitted];
    expect(ck.t).toBe(mv.t);
    const hot = job(ck.obs, 'job-a').allocated_gpu_ids.filter((g) => ck.obs.gpus.find((x) => x.resource_id === g)!.temp_c > THRESHOLD_TEMP_C);
    expect(hot.length).toBeGreaterThan(0);
    expect(ck.cmd).toMatchObject({ operation: 'checkpoint', target_resource_id: 'job-a', job_id: 'job-a', depends_on_command_keys: [] });
    expect(mv.cmd).toMatchObject({
      operation: 'migrate_restart', job_id: 'job-a', depends_on_command_keys: [ck.cmd.command_key],
      incident_ids: ['inc.threshold.job-a.thermal'], plan_id: 'plan.threshold.job-a.after.ckpt-job-a-1',
    });
    expect(sc03Threshold.emitted.filter((e) => e.cmd.job_id === 'job-b').map((e) => e.cmd.operation)).toEqual(['checkpoint', 'migrate_restart']);
  });

  it('its migrates are allowed by evaluateSafety, never target r6, r2–r4 or busy GPUs, and never overlap', () => {
    const moves = sc03Threshold.emitted.filter((e) => e.cmd.operation === 'migrate_restart');
    expect(moves).toHaveLength(2);
    const all: string[] = [];
    for (const { obs, cmd } of moves) {
      expect(allow(obs, cmd).decision).toBe('allow');
      for (const g of dest(cmd)) {
        expect(['node-r2-n1', 'node-r3-n1', 'node-r4-n1', 'node-r6-n1']).not.toContain(nodeOf(g));
        expect(obs.allocations.some((a) => a.gpu_id === g)).toBe(false);
        expect(gpusOn(1, 5, 7, 8)).toContain(g);
      }
      all.push(...dest(cmd));
    }
    expect(new Set(all).size).toBe(all.length);
  });

  it('sc03: feeding its commands into step completes all four; both jobs keep running on cool racks', () => {
    expect(sc03Threshold.failed).toEqual([]);
    expect([...sc03Threshold.completed].sort()).toEqual(sc03Threshold.emitted.map((e) => e.cmd.command_key).sort());
    for (const id of ['job-a', 'job-b']) {
      const j = job(sc03Threshold.final, id);
      expect(j.status).toBe('running');
      expect(j.allocated_gpu_ids.every((g) => gpusOn(1, 5, 7, 8).includes(g))).toBe(true);
    }
    // without the policy both jobs fail on the thermal shutdown
    const idle = toObserved(advance(SC03, SC03.horizon_s * 1000));
    expect(job(idle, 'job-a').status).toBe('failed');
  });

  it('handles XID 48/79 exactly like reactivePolicy (superset)', () => {
    for (const [id, t] of [['sc04-failed-gpu-xid79', 60_000], ['sc15-xid48-ecc', 90_000]] as const) {
      const obs = toObserved(advance(scenario(id), t));
      const r = reactivePolicy(obs);
      const th = thresholdPolicy(obs);
      expectValid(th);
      const strip = (c: ActionCommand) => ({
        ...c, command_key: c.command_key.replace(/^\w+\./, ''), action_id: '', workflow_id: '', plan_id: '', incident_ids: [],
      });
      expect(th.map(strip)).toEqual(r.map(strip));
      expect(th.every((c) => c.command_key.startsWith('threshold.'))).toBe(true);
    }
  });

  it('non-preemptible job-c (sc08) is never checkpointed or moved: escalate instead', () => {
    const d = drive(scenario('sc08-non-preemptible-affected'), thresholdPolicy);
    const ofC = d.emitted.filter((e) => e.cmd.job_id === 'job-c');
    expect(ofC.map((e) => e.cmd.command_key)).toEqual(['threshold.job-c.escalate.not_preemptible.after.none']);
    expect(ofC[0]!.cmd.operation).toBe('escalate');
    expectValid(d.emitted.map((e) => e.cmd));
  });

  it('checkpoint storage inaccessible (sc10): cannot checkpoint → escalate, never a checkpoint or move', () => {
    const d = drive(scenario('sc10-checkpoint-storage-inaccessible'), thresholdPolicy);
    expect(d.emitted.length).toBeGreaterThan(0);
    expect(d.emitted.every((e) => e.cmd.operation === 'escalate')).toBe(true);
    expect(d.emitted.map((e) => e.cmd.arguments.reason)).toContain('checkpoint_unavailable');
  });

  it('no safe destination (sc07): just the checkpoint, once', () => {
    const d = drive(scenario('sc07-no-spare-capacity'), thresholdPolicy);
    expect(d.emitted.map((e) => e.cmd.operation).sort()).toEqual(['checkpoint', 'checkpoint']);
    expect(d.failed).toEqual([]);
  });
});

describe('idempotent and stateless', () => {
  it('the same snapshot always gives the same commands', () => {
    const obs = sc03Threshold.perTick.find((p) => p.keys.length > 0)!.obs;
    for (const p of Object.values(POLICIES)) expect(p(obs)).toEqual(p(structuredClone(obs)));
    const xid = toObserved(advance(SC04, 60_000));
    expect(reactivePolicy(xid)).toEqual(reactivePolicy(xid));
  });

  it('consecutive ticks with nothing executed return the same keys (no new checkpoint every tick)', () => {
    // sc03: from the trigger on, with no command ever executed, job-a's keys never change
    let w = advance(SC03, 0, undefined);
    const seen = new Set<string>();
    let ticksWithKeys = 0;
    while (w.observable.clock.sim_time_ms < T0 + 300_000) {
      w = step(scenarioTickInput(SC03, w)).world_after;
      const k = keys(thresholdPolicy(toObserved(w))).filter((x) => x.includes('job-a'));
      if (k.length > 0) ticksWithKeys += 1;
      for (const x of k) seen.add(x);
    }
    expect(ticksWithKeys).toBeGreaterThan(30);
    expect([...seen]).toEqual(['threshold.job-a.checkpoint.after.ckpt-job-a-1', 'threshold.job-a.migrate_restart.after.ckpt-job-a-1']);
    // sc04: after the XID, reactive repeats exactly the same two keys every tick
    let x = advance(SC04, 60_000);
    const first = keys(reactivePolicy(toObserved(x)));
    for (let i = 0; i < 30; i++) {
      x = step(scenarioTickInput(SC04, x)).world_after;
      expect(keys(reactivePolicy(toObserved(x)))).toEqual(first);
    }
  });

  it('while the checkpoint / restart is in flight it returns only keys it already returned, then nothing', () => {
    for (const d of [sc03Threshold, sc04Reactive]) {
      const known = new Set<string>();
      for (const p of d.perTick) {
        const isNew = p.keys.filter((k) => !known.has(k));
        // a new key only appears with a job's cycle start; never while that job is checkpointing / restarting
        for (const k of isNew) {
          const jobId = d.emitted.find((e) => e.cmd.command_key === k)!.cmd.job_id;
          if (jobId) expect(['checkpointing', 'restarting']).not.toContain(job(p.obs, jobId).status);
        }
        for (const k of p.keys) known.add(k);
        for (const j of p.obs.job_states) {
          if (j.status === 'restarting') expect(p.keys.filter((k) => k.includes(`.${j.job_id}.`))).toEqual([]);
          if (j.status === 'checkpointing') {
            expect(p.keys.filter((k) => k.includes(`.${j.job_id}.`)).every((k) => k.includes('.migrate_restart.'))).toBe(true);
          }
        }
      }
      expect(known.size).toBe(d.emitted.length);
    }
    // exactly one checkpoint per job in sc03, though the jobs stay hot through the 30 s write
    const cks = sc03Threshold.emitted.filter((e) => e.cmd.operation === 'checkpoint');
    expect(cks.map((e) => e.cmd.job_id).sort()).toEqual(['job-a', 'job-b']);
    // once the move is done the policy goes quiet
    expect(sc03Threshold.perTick.at(-1)!.keys).toEqual([]);
    expect(sc04Reactive.perTick.at(-1)!.keys.filter((k) => k.includes('job-a'))).toEqual([]);
  });

  it('across all scenarios: valid commands, reactive silent without XID 48/79, at most one checkpoint per cycle', () => {
    for (const s of SCENARIOS) {
      for (const [name, p] of Object.entries(POLICIES)) {
        const d = drive(s, p);
        for (const { obs, cmd } of d.emitted) {
          expectValid([cmd]);
          for (const g of dest(cmd)) {
            expect(obs.allocations.some((a) => a.gpu_id === g && a.job_id !== cmd.job_id), `${s.scenario_id} ${g}`).toBe(false);
            expect(obs.gpus.find((x) => x.resource_id === g)!.availability).toBe('ready');
          }
          if (name === 'threshold' && cmd.operation === 'migrate_restart' && cmd.depends_on_command_keys.length > 0) {
            expect(allow(obs, cmd).decision, `${s.scenario_id} ${cmd.command_key}`).toBe('allow');
          }
        }
        if (name === 'reactive') {
          for (const t of d.perTick) {
            if (!t.obs.gpus.some((g) => g.last_xid_code === 48 || g.last_xid_code === 79)) expect(t.keys, s.scenario_id).toEqual([]);
          }
        }
        const moves = d.completed.filter((k) => k.includes('.migrate_restart.')).length;
        for (const jobId of ['job-a', 'job-b', 'job-c']) {
          const n = d.emitted.filter((e) => e.cmd.operation === 'checkpoint' && e.cmd.job_id === jobId).length;
          expect(n, `${s.scenario_id} ${name} ${jobId}`).toBeLessThanOrEqual(moves + 1);
        }
      }
    }
  }, 60_000);
});

describe('private truth never reaches the policies', () => {
  const SNAPSHOTS: [string, ObservedSnapshot][] = [
    ['pump fixture', PUMP],
    ['sc04 after XID 79', toObserved(advance(SC04, 60_000))],
    ['sc03 first hot tick', sc03Threshold.perTick.find((p) => p.keys.length > 0)!.obs],
    ['sc03 mid-checkpoint', sc03Threshold.perTick.find((p) => job(p.obs, 'job-a').status === 'checkpointing')!.obs],
  ];

  it('the guard itself trips on a private read', () => {
    const g = guarded(PUMP) as unknown as Record<string, unknown>;
    expect(() => g.active_faults_private).toThrow(/private field/);
    expect(() => (g.gpus as Record<string, unknown>[])[0]!.hidden_physics_state_json).toThrow(/private field/);
    expect(() => 'observable' in g).toThrow(/private field/);
    expect(() => ({ ...(g.gpus as object[])[0] })).toThrow(/private field/);
    expect(() => JSON.stringify(g)).toThrow(/private field/);
    expect(() => { (g as { run_id: string }).run_id = 'x'; }).toThrow();
  });

  it('both policies run on a deep-frozen, private-field-trapped snapshot with identical results', () => {
    forbiddenHits = 0;
    for (const [label, obs] of SNAPSHOTS) {
      for (const [name, p] of Object.entries(POLICIES)) {
        const plain = p(obs);
        const trapped = p(guarded(obs));
        expect(JSON.parse(JSON.stringify(trapped)), `${label} ${name}`).toEqual(JSON.parse(JSON.stringify(plain)));
      }
    }
    expect(SNAPSHOTS.some(([, o]) => thresholdPolicy(o).length > 0)).toBe(true);
    expect(forbiddenHits).toBe(0);
  });

  it('policies.ts imports only constants, the safety check and contract types: no world / step internals', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'gpu', 'policies.ts'), 'utf8');
    const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gms)].map((m) => ({ type: !!m[1], from: m[2]! }));
    expect(imports.map((i) => i.from).sort()).toEqual(['./constants.js', './safety.js', '@dcos/contracts']);
    expect(imports.find((i) => i.from === '@dcos/contracts')!.type).toBe(true);
    expect(src).not.toMatch(/from '\.\/(world|step|actions|jobs|faults|observe|preset|scenarios|simulate|telemetry|rng)\.js'/);
    expect(src).not.toMatch(/import\(/);
    for (const k of [...FORBIDDEN.slice(0, 3), 'hiddenOf', 'Date.now', 'Math.random', "from 'node:", 'require(']) expect(src).not.toContain(k);
  });
});
