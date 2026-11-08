// Integration: P3 triage + planner + safety against P1's REAL @dcos/physics (no FakePhysics), llm = null.
// Worlds come from buildPreset('gpu_demo_8') + step() with contract FaultInjections; observations via toObserved().
import type { ActionCommand, ObservedSnapshot, SignalEvent } from '@dcos/contracts';
import * as physicsPkg from '@dcos/physics';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPhysicsPort } from '../../src/adapters/physics.js';
import { planIncidents, type JobPlan, type PlanResult } from '../../src/planner.js';
import { SAFETY_REASON_CODES, type LlmPort, type PhysicsPort } from '../../src/ports.js';
import { createSnapshotDb } from '../../src/snapshot-db.js';
import { runTriage, type TriageResult } from '../../src/triage.js';
import {
  LOOP_A_RACKS,
  demoPumpFault,
  newDriver,
  observe,
  rackOf,
  runUntil,
  scenario,
  simNow,
  startCommands,
  tick,
  xidFault,
  type Driver,
} from './physics-driver.js';

// Compile-time proof that P1's exports satisfy P3's PhysicsPort (CONTRACTS §0.6) with no adapter shims.
const _typed: PhysicsPort = {
  simulatePlan: physicsPkg.simulatePlan,
  evaluateSafety: physicsPkg.evaluateSafety,
  thresholdPolicy: physicsPkg.thresholdPolicy,
};
void _typed;

/** llm = null for the planner: the deterministic path (same object nemotronPolicy uses offline). */
const NO_LLM: LlmPort = {
  async chat() {
    throw new Error('no LLM configured; using deterministic path');
  },
};

let physics: PhysicsPort;
beforeAll(async () => {
  physics = await createPhysicsPort(); // the real dynamic-import adapter, not a hand-wired object
});

async function triageAndPlan(obs: ObservedSnapshot, signals: SignalEvent[], workflowId = 'wf-int') {
  const db = createSnapshotDb(obs, signals);
  const triage: TriageResult = await runTriage({ db, llm: null, now: () => 0 }, { signals });
  const plan: PlanResult | null = triage.incidents.length
    ? await planIncidents({ db, physics, llm: NO_LLM, workflowId, runId: obs.run_id, attempt: 1 }, { incidents: triage.incidents })
    : null;
  return { triage, plan };
}

const destOf = (c: ActionCommand): string[] =>
  c.operation === 'migrate_restart' ? ((c.arguments.destination_gpu_ids as string[] | undefined) ?? []) : [];
const jobPlan = (p: PlanResult, jobId: string): JobPlan => {
  const jp = p.job_plans.find((j) => j.job_id === jobId);
  if (!jp) throw new Error(`no plan for ${jobId}`);
  return jp;
};

describe('P1 <-> P3 contract surface', () => {
  it('createPhysicsPort resolves the real package (no AdapterNotReadyError)', () => {
    expect(typeof physics.simulatePlan).toBe('function');
  });

  it('P1 safety codes = P3 §0.7 list + the §0.12 #4 physics-only codes (P3 list is missing those 5)', () => {
    const p1 = new Set<string>(physicsPkg.SAFETY_REASON_CODES);
    for (const c of SAFETY_REASON_CODES) expect(p1.has(c), c).toBe(true);
    const extra = [...p1].filter((c) => !(SAFETY_REASON_CODES as readonly string[]).includes(c)).sort();
    expect(extra).toEqual(['INVALID_ARGUMENT', 'JOB_FAILED_DURING_OPERATION', 'JOB_NOT_FOUND', 'JOB_STATE_INVALID', 'TARGET_NOT_FOUND']);
  });

  it('buildPreset honours CONTRACTS §0.12 #2 (clock 600000, job-a ckpt 60000, job-b ckpt 540000)', () => {
    const obs = observe(newDriver(1));
    expect(obs.clock.sim_time_ms).toBe(600_000);
    const done = (j: string) => obs.checkpoints.find((c) => c.job_id === j)?.complete_sim_time_ms;
    expect(done('job-a')).toBe(60_000);
    expect(done('job-b')).toBe(540_000);
    expect(done('job-c')).toBeUndefined();
  });
});

describe('(i) healthy gpu_demo_8', () => {
  it('no incidents, no plan, no threshold actions at run start and after 60 healthy sim-s', async () => {
    const d = newDriver(1);
    for (const at of [600_000, 660_000]) {
      runUntil(d, at);
      const obs = observe(d);
      const { triage, plan } = await triageAndPlan(obs, d.signals);
      expect(triage.incidents).toEqual([]);
      expect(plan).toBeNull();
      expect(physics.thresholdPolicy(obs)).toEqual([]);
    }
  });
});

describe('(ii) pump-a degraded at 610000, observed 120 sim-s later', () => {
  let d: Driver;
  let obs: ObservedSnapshot;
  let plan: PlanResult;
  let triage: TriageResult;

  beforeAll(async () => {
    d = newDriver(117, [demoPumpFault()]);
    runUntil(d, 730_000);
    obs = observe(d);
    const r = await triageAndPlan(obs, d.signals);
    triage = r.triage;
    plan = r.plan!;
  });

  it('real physics really degraded loop-a (sanity on the world, not on P3)', () => {
    const pumpA = obs.cooling.find((c) => c.resource_id === 'pump-a')!;
    expect(pumpA.operating_state).toBe('degraded');
    expect(d.signals.some((s) => s.resource_id === 'pump-a')).toBe(true);
  });

  it('opens exactly one incident, tied to evidence', () => {
    expect(triage.incidents).toHaveLength(1);
    expect(triage.links.length).toBeGreaterThan(0);
    expect(plan).not.toBeNull();
  });

  it('job-a: checkpoint, then migrate_restart (depends on it) to a placement off loop-a and off r6', () => {
    const cmds = plan.commands.filter((c) => c.job_id === 'job-a');
    expect(cmds.map((c) => c.operation)).toEqual(['checkpoint', 'migrate_restart']);
    expect(cmds[1]!.depends_on_command_keys).toEqual([cmds[0]!.command_key]);
    const dest = destOf(cmds[1]!);
    expect(dest).toHaveLength(16);
    for (const g of dest) {
      expect(LOOP_A_RACKS.has(rackOf(g))).toBe(false);
      expect(rackOf(g)).not.toBe('r6');
    }
  });

  it('every planned command passes the REAL evaluateSafety on the planning snapshot', () => {
    for (const c of plan.commands) {
      const dec = physics.evaluateSafety(obs, c, { decision_epoch: obs.clock.decision_epoch, leased_resource_ids: [] });
      expect(dec.decision, `${c.command_key}: ${dec.violations.join(',')}`).toBe('allow');
    }
  });

  it('job-a moves fix the incident on their own: joint simulatePlan risk 0 without touching job-b', () => {
    const aOnly = physics.simulatePlan(obs, { commands: plan.commands.filter((c) => c.job_id === 'job-a') });
    const none = physics.simulatePlan(obs, { commands: [] });
    expect(none.failure_risk_estimate).toBeGreaterThan(0.5);
    expect(aOnly.failure_risk_estimate).toBe(0);
  });

  // DIVERGENCE (reported, not hidden): CONTRACTS §0.3 / PLAN.md expect job-b (fresh-ish ckpt, rack r4) to keep
  // running or power-cap. With real physics P3's planner chooses checkpoint + move for job-b, because each job's
  // options are scored against "every other job keeps running" — job-b:keep then inherits job-a's heat on loop-a
  // (risk 1.0, lost 21194.7). Jointly (job-a moved), job-b keep is risk 0 and cheaper. `it.fails` flips red when
  // P3 fixes this, so the expectation is restored rather than silently dropped.
  it.fails('spec: job-b keeps running or power-caps (P3 per-job scoring currently moves it)', () => {
    const b = jobPlan(plan, 'job-b');
    expect(['job-b:keep', 'job-b:cap']).toContain(b.chosen.option_id);
  });

  it('observed today: job-b checkpoint + move to a loop-b rack (documents the divergence above)', () => {
    const b = jobPlan(plan, 'job-b');
    expect(b.chosen.option_id).toMatch(/^job-b:ckpt\+move:/);
    const keep = [b.chosen, ...b.alternatives].find((o) => o.option_id === 'job-b:keep')!;
    expect(keep.metrics.failure_risk_estimate).toBe(1);
    expect([b.chosen, ...b.alternatives].some((o) => o.option_id === 'job-b:cap')).toBe(false); // r4 not "hot" yet
  });

  it('a move onto a low-headroom / busy rack is DENIED with §0.7 codes', () => {
    const job = obs.job_states.find((j) => j.job_id === 'job-b')!;
    const base = plan.commands.find((c) => c.job_id === 'job-b' && c.operation === 'migrate_restart')!;
    const r6 = obs.gpus.filter((g) => rackOf(g.resource_id) === 'r6').map((g) => g.resource_id);
    const r2 = obs.gpus.filter((g) => rackOf(g.resource_id) === 'r2').map((g) => g.resource_id);
    for (const dest of [r6, r2]) {
      const cmd: ActionCommand = { ...base, command_key: `${base.command_key}:probe:${rackOf(dest[0]!)}`, arguments: { destination_gpu_ids: dest } };
      const dec = physics.evaluateSafety(obs, cmd, { decision_epoch: obs.clock.decision_epoch, leased_resource_ids: [] });
      expect(dec.decision).toBe('deny');
      expect(dec.violations.length).toBeGreaterThan(0);
      for (const v of dec.violations) expect(SAFETY_REASON_CODES as readonly string[]).toContain(v);
    }
    expect(job.allocated_gpu_ids.some((g) => rackOf(g) === 'r4')).toBe(true);
  });

  it('sc09 hot destination: moves onto hot free racks r1/r5 are DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT; planner avoids them', async () => {
    const s = scenario('sc09-hot-destination');
    const h = newDriver(s.seed, s.faults);
    runUntil(h, 640_000);
    const o = observe(h);
    const r = await triageAndPlan(o, h.signals, 'wf-sc09');
    expect(r.plan).not.toBeNull();
    const mig = r.plan!.commands.find((c) => c.job_id === 'job-a' && c.operation === 'migrate_restart')!;
    expect(mig).toBeDefined();
    for (const g of destOf(mig)) expect(['r1', 'r5']).not.toContain(rackOf(g));
    const hot = o.gpus.filter((g) => ['r1', 'r5'].includes(rackOf(g.resource_id))).map((g) => g.resource_id);
    const probe: ActionCommand = { ...mig, command_key: `${mig.command_key}:probe-hot`, arguments: { destination_gpu_ids: hot } };
    const dec = physics.evaluateSafety(o, probe, { decision_epoch: o.clock.decision_epoch, leased_resource_ids: [] });
    expect(dec.decision).toBe('deny');
    expect(dec.violations).toContain('DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT');
  });
});

describe('(iii) XID 79 on job-a\'s chosen destination mid-checkpoint -> replan avoids it', () => {
  it('second incident opens and the new job-a destination excludes the dead GPU', async () => {
    const d = newDriver(117, [demoPumpFault()]);
    runUntil(d, 730_000);
    const first = await triageAndPlan(observe(d), d.signals, 'wf-xid');
    const aCmds = first.plan!.commands.filter((c) => c.job_id === 'job-a');
    const dead = destOf(aCmds[1]!)[0]!;

    // start job-a's checkpoint for real; the XID lands while it writes (checkpoint = 30 s)
    startCommands(d, [aCmds[0]!]);
    d.pending.push(xidFault(dead, simNow(d) + 5_000));
    for (let i = 0; i < 10; i += 1) tick(d);
    const obs = observe(d);
    expect(obs.gpus.find((g) => g.resource_id === dead)!.availability).toBe('unreachable');
    expect(d.signals.some((s) => s.resource_id === dead && s.event_type === 'xid_error')).toBe(true);

    // Offline planner DURING the checkpoint: it re-enumerates checkpoint options for a job that is already
    // checkpointing; the real safety check rejects all of them (CONFLICTING_ACTION; with a new attempt number also
    // JOB_STATE_INVALID, a §0.12 #4 physics-only code) and job-a falls back to keep. The agent loop avoids this via runReplan; reported.
    const during = await triageAndPlan(obs, d.signals, 'wf-xid');
    expect(during.triage.incidents.length).toBe(2);
    expect(obs.job_states.find((j) => j.job_id === 'job-a')!.status).toBe('checkpointing');
    const duringA = jobPlan(during.plan!, 'job-a');
    expect(duringA.chosen.option_id).toBe('job-a:keep');
    const ckptOpt = duringA.alternatives.find((o) => o.option_id === 'job-a:ckpt')!;
    expect(ckptOpt.excluded_reason).toContain('CONFLICTING_ACTION');
    expect(ckptOpt.safety.flatMap((s) => s.violations)).toContain('CONFLICTING_ACTION');

    // Let the real checkpoint finish (XID was not on job-a's GPUs), then replan: fresh checkpoint is reused.
    runUntil(d, simNow(d) + 25_000);
    const after = observe(d);
    expect(after.checkpoints.filter((c) => c.job_id === 'job-a' && c.status === 'complete')).toHaveLength(2);
    const second = await triageAndPlan(after, d.signals, 'wf-xid');
    expect(second.triage.incidents.length).toBe(2);
    expect(second.plan).not.toBeNull();
    const aOps = second.plan!.commands.filter((c) => c.job_id === 'job-a').map((c) => c.operation);
    expect(aOps).toEqual(['migrate_restart']); // fresh (<60 s) checkpoint reused, no second checkpoint
    const mig = second.plan!.commands.find((c) => c.job_id === 'job-a' && c.operation === 'migrate_restart');
    expect(mig, 'job-a still needs a move').toBeDefined();
    const dest = destOf(mig!);
    expect(dest).not.toContain(dead);
    for (const g of dest) expect(LOOP_A_RACKS.has(rackOf(g)) || rackOf(g) === 'r6').toBe(false);
    const dec = physics.evaluateSafety(after, mig!, { decision_epoch: after.clock.decision_epoch, leased_resource_ids: [] });
    expect(dec.decision, dec.violations.join(',')).toBe('allow');
    // and the stale first plan's migrate is now denied by the real safety check
    const stale = physics.evaluateSafety(after, aCmds[1]!, { decision_epoch: after.clock.decision_epoch, leased_resource_ids: [] });
    expect(stale.decision).toBe('deny');
    expect(stale.violations).toEqual(expect.arrayContaining(['DEST_GPU_UNHEALTHY']));
  });
});
