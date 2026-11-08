import { describe, expect, it } from 'vitest';
import type { ActionCommand, ObservedSnapshot, PlanCandidate } from '@dcos/contracts';
import { createCoordinator, type ExecutablePlan } from '../src/coordinator.js';
import { createEventPublisher } from '../src/events.js';
import type { DbPort, PhysicsPort } from '../src/ports.js';
import { resumeOpenWorkflows } from '../src/resume.js';
import { buildCommand } from '../src/tools/command.js';
import { REQUIRED_HANDOFF_FIELDS, handoffMissingFields, readHandoff, verifyRecovery } from '../src/verify.js';
import { FakeDb, FakePhysics } from './fakes/index.js';
import { RUN_ID, gpuId, loadPumpDegradedSnapshot, loadSignalXid79Dest } from './fixtures/index.js';

// Same harness as coordinator.test.ts (kept local: importing a test file would re-run its tests).
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


/** Advance sim time and let job-a make progress (FakeDb does not model progress itself). */
function progressingWait(a: ReturnType<typeof setup>, rate = 16) {
  return async (ms: number) => {
    a.tick(ms);
    a.db.mutateSnapshot((s) => {
      const j = s.job_states.find((x) => x.job_id === 'job-a');
      if (j && j.status === 'running') j.progress_work_units += (rate * ms) / 1000;
    });
  };
}

const NO_REPAIR_CLAIM = /(?<!not )\b(repaired|fixed)\b/i;

describe('verifyRecovery', () => {
  it('happy path: checkpoint + migrate verified, verify_action per command, stage done', async () => {
    const a = setup();
    const p = makePlan(a.snap);
    const result = await a.coord.execute(WF, p);
    const rep = await verifyRecovery(
      { db: a.db, events: a.events, waitSim: progressingWait(a), persist: a.coord.updateStage },
      { workflowId: WF, plan: p, result },
    );
    expect(rep.checks.map((c) => [c.operation, c.ok])).toEqual([
      ['checkpoint', true],
      ['migrate_restart', true],
    ]);
    expect(rep.verified).toBe(true);
    expect(rep.escalate).toBe(false);
    expect(rep.stage).toBe('done');
    expect(rep.handoff.length).toBeLessThanOrEqual(600);
    expect(rep.handoff).toContain('job-a');
    expect(rep.handoff).toContain(p.commands[1]?.command_key);
    expect(rep.handoff).not.toMatch(NO_REPAIR_CLAIM);
    const verified = a.db.calls.filter((c) => c.method === 'verifyAction').map((c) => c.args[0]);
    expect(verified).toEqual(p.commands.map((c) => c.command_key));
    for (const c of p.commands) expect(((await a.db.getActionStatus(c.command_key))?.result.verification as { verified: boolean }).verified).toBe(true);
    const wf = await a.db.getWorkflow(WF);
    expect(wf?.stage).toBe('done');
    expect((wf?.state.verification as { verified: boolean }).verified).toBe(true);
    expect(a.db.agentEvents.filter((e) => e.stage === 'verify')).toHaveLength(1);
  });

  it('flags a cordoned GPU as still cordoned, never repaired', async () => {
    const a = setup();
    const gpu = gpuId(2, 6);
    const p = makePlan(a.snap, COOL_DEST, ([, mv]) => [cordonCmd(a.snap, gpu, [mv as string])]);
    const result = await a.coord.execute(WF, p);
    expect(result.outcomes.map((o) => o.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    a.db.mutateSnapshot((s) => {
      const g = s.gpus.find((x) => x.resource_id === gpu);
      if (g) g.availability = 'cordoned'; // what the real cordon reducer does
    });
    const rep = await verifyRecovery(
      { db: a.db, events: a.events, waitSim: progressingWait(a), persist: a.coord.updateStage },
      { workflowId: WF, plan: p, result },
    );
    const cordon = rep.checks.find((c) => c.operation === 'cordon_gpu');
    expect(cordon?.ok).toBe(true);
    expect(cordon?.evidence.repaired).toBe(false);
    expect(rep.handoff).toContain(`${gpu} still cordoned (not repaired)`);
    expect(rep.handoff).not.toMatch(NO_REPAIR_CLAIM);
    expect(rep.verified).toBe(true);
  });

  it('a cordon that did not hold (GPU back to ready) is unverified -> needs operator review', async () => {
    const a = setup();
    const gpu = gpuId(2, 6);
    const p = makePlan(a.snap, COOL_DEST, ([, mv]) => [cordonCmd(a.snap, gpu, [mv as string])]);
    const result = await a.coord.execute(WF, p);
    const rep = await verifyRecovery(
      { db: a.db, events: a.events, waitSim: progressingWait(a), persist: a.coord.updateStage },
      { workflowId: WF, plan: p, result },
    );
    expect(rep.checks.find((c) => c.operation === 'cordon_gpu')?.ok).toBe(false);
    expect(rep.escalate).toBe(true);
    expect(rep.stage).toBe('escalated');
    expect(rep.handoff).toMatch(/^Needs operator review/);
    expect(rep.handoff).not.toMatch(NO_REPAIR_CLAIM);
    expect((await a.db.getWorkflow(WF))?.stage).toBe('escalated');
  });

  it('stale evidence (no progress between snapshots) escalates', async () => {
    const a = setup();
    const p = makePlan(a.snap);
    const result = await a.coord.execute(WF, p);
    const rep = await verifyRecovery(
      { db: a.db, events: a.events, waitSim: async () => undefined, persist: a.coord.updateStage },
      { workflowId: WF, plan: p, result },
    );
    expect(rep.checks.find((c) => c.operation === 'migrate_restart')?.ok).toBe(false);
    expect(rep.escalate).toBe(true);
    expect(rep.handoff).toContain('progress not increasing');
  });

  it('blocked commands escalate with the violation cited', async () => {
    const a = setup();
    const p = makePlan(a.snap, [...Array.from({ length: 8 }, (_, g) => gpuId(6, g)), ...Array.from({ length: 8 }, (_, g) => gpuId(7, g))]);
    const result = await a.coord.execute(WF, p);
    const rep = await verifyRecovery(
      { db: a.db, events: a.events, waitSim: progressingWait(a), persist: a.coord.updateStage },
      { workflowId: WF, plan: p, result },
    );
    expect(rep.checks.map((c) => c.operation)).toEqual(['checkpoint']);
    expect(rep.checks[0]?.ok).toBe(true);
    expect(rep.escalate).toBe(true);
    expect(rep.handoff).toContain('blocked');
    expect(rep.handoff).toContain('DEST_GPU_BUSY');
    expect(rep.handoff.length).toBeLessThanOrEqual(600);
  });
});

// --------------------------------------------------------------------------------------------- R3 read-back

/** Plan made of arbitrary commands (same PlanCandidate scaffold as makePlan). */
function planOf(snap: ObservedSnapshot, commands: ActionCommand[]): ExecutablePlan {
  const plan: PlanCandidate = {
    ...makePlan(snap).plan,
    command_keys: commands.map((c) => c.command_key) as [string, ...string[]],
    explanation: commands.map((c) => `${c.operation} ${c.job_id ?? c.target_resource_id}`).join(', '),
  };
  return { plan, commands };
}

const CTX = { runId: RUN_ID, workflowId: WF, incidentIds: ['inc-1'] as [string], planId: 'plan-1' };
const cmd = (snap: ObservedSnapshot, partial: Parameters<typeof buildCommand>[0]) => buildCommand(partial, snap, CTX);

/** The same FakeDb seen through a brand-new DbPort handle (what a fresh agent process connects with). */
function freshConnection(db: FakeDb): DbPort {
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as DbPort;
}

const verifyWith = (a: ReturnType<typeof setup>, p: ExecutablePlan, result: Awaited<ReturnType<typeof a.coord.execute>>, waitSim = progressingWait(a)) =>
  verifyRecovery({ db: a.db, events: a.events, physics: a.physics, waitSim, persist: a.coord.updateStage }, { workflowId: WF, plan: p, result });

describe('R3 verification rejects false positives', () => {
  it('stale destination readings (> 10 000 sim-ms old) make a migrate unverified even though progress advanced', async () => {
    const a = setup();
    const p = makePlan(a.snap);
    const result = await a.coord.execute(WF, p);
    const wait = progressingWait(a);
    const rep = await verifyWith(a, p, result, async (ms) => {
      await wait(ms);
      a.db.mutateSnapshot((s) => {
        // sensor_stale on the destination: values and last-seen freeze while the clock keeps moving
        for (const g of s.gpus) if (COOL_DEST.includes(g.resource_id)) g.last_seen_sim_ms = s.clock.sim_time_ms - 12_000;
      });
    });
    const mv = rep.checks.find((c) => c.operation === 'migrate_restart')!;
    expect(mv.ok).toBe(false);
    expect(mv.problems.some((x) => x.startsWith('EVIDENCE_STALE'))).toBe(true);
    expect(rep.verified).toBe(false);
    expect(rep.outcome).toBe('operator_review');
    expect(rep.handoff).toMatch(/^Needs operator review/);
    expect(((await a.db.getActionStatus(mv.command_key))?.result.verification as { verified: boolean }).verified).toBe(false);
    expect((await a.db.getWorkflow(WF))?.stage).toBe('escalated');
  });

  it('a paused sim clock is never evidence of progress (unverified, operator review)', async () => {
    const a = setup();
    const p = makePlan(a.snap);
    const result = await a.coord.execute(WF, p);
    a.db.mutateSnapshot((s) => {
      s.clock.paused = true;
    });
    const rep = await verifyWith(a, p, result);
    const mv = rep.checks.find((c) => c.operation === 'migrate_restart')!;
    expect(mv.ok).toBe(false);
    expect(mv.problems).toContain('sim clock paused');
    expect(rep.checks.find((c) => c.operation === 'checkpoint')?.ok).toBe(false);
    expect(rep.escalate).toBe(true);
  });

  it('time that does not advance between the two samples is inconclusive, not green', async () => {
    const a = setup();
    const p = makePlan(a.snap);
    const result = await a.coord.execute(WF, p);
    const rep = await verifyWith(a, p, result, async () => undefined);
    const mv = rep.checks.find((c) => c.operation === 'migrate_restart')!;
    expect(mv.ok).toBe(false);
    expect(mv.problems).toContain('sim time did not advance between samples');
    expect(mv.evidence.sim_time_ms).toEqual([rep.as_of_sim_time_ms[0], rep.as_of_sim_time_ms[0]]);
  });

  it('a too-short observed window (< 10 sim-s) is not enough for a progress claim', async () => {
    const a = setup();
    const p = makePlan(a.snap);
    const result = await a.coord.execute(WF, p);
    const wait = progressingWait(a);
    const rep = await verifyWith(a, p, result, () => wait(3_000));
    const mv = rep.checks.find((c) => c.operation === 'migrate_restart')!;
    expect(mv.ok).toBe(false);
    expect(mv.problems.some((x) => x.startsWith('observed window 3000 sim-ms <'))).toBe(true);
  });

  it('power_cap: ledger success alone is rejected when the limit was not applied', async () => {
    const a = setup();
    const p = planOf(a.snap, [cmd(a.snap, { operation: 'power_cap', target_resource_id: 'job-b', job_id: 'job-b', arguments: { power_limit_w: 500 } })]);
    const result = await a.coord.execute(WF, p);
    expect(result.outcomes.map((o) => o.status)).toEqual(['succeeded']);
    // the ledger says succeeded, but the GPUs never took the limit (ineffective action)
    a.db.mutateSnapshot((s) => {
      for (const g of s.gpus) if (g.node_id === 'node-r4-n1') g.power_limit_w = 700;
    });
    const rep = await verifyWith(a, p, result);
    const cap = rep.checks[0]!;
    expect(cap.operation).toBe('power_cap');
    expect(cap.ok).toBe(false);
    expect(cap.problems.some((x) => x.startsWith('limit not applied on gpu-r4-n1-'))).toBe(true);
    expect(rep.verified).toBe(false);
    expect(rep.handoff).toMatch(/^Needs operator review/);
    expect(rep.handoff).toContain('limit not applied');
    expect(((await a.db.getActionStatus(cap.command_key))?.result.verification as { verified: boolean; problems: string[] }).verified).toBe(false);
  });

  it('power_cap: an applied limit with modeled effect and continued progress verifies, and the pump is still open work', async () => {
    const a = setup();
    const p = planOf(a.snap, [cmd(a.snap, { operation: 'power_cap', target_resource_id: 'job-b', job_id: 'job-b', arguments: { power_limit_w: 500 } })]);
    const result = await a.coord.execute(WF, p);
    const rep = await verifyWith(a, p, result, async (ms) => a.tick(ms));
    const cap = rep.checks[0]!;
    expect(cap.ok).toBe(true);
    expect(cap.evidence.pump_repaired).toBe(false);
    const gpus = cap.evidence.gpus as Array<{ power_limit_w: number; power_w: number; cap_bit: boolean }>;
    expect(gpus).toHaveLength(8);
    for (const g of gpus) {
      expect(g.power_limit_w).toBe(500);
      expect(g.power_w).toBeLessThanOrEqual(500);
      expect(g.cap_bit).toBe(true);
    }
    const [p1, p2] = cap.evidence.progress_work_units as [number, number];
    expect(p2).toBeGreaterThan(p1);
    expect(rep.verified).toBe(true);
    expect(rep.handoff).not.toMatch(NO_REPAIR_CLAIM);
    expect(rep.persisted.unresolved_infrastructure.some((u) => u.startsWith('pump-a degraded') && u.includes('needs human service'))).toBe(true);
    expect(rep.persisted.next_human_action).toContain('service pump-a');
  });

  it('power_cap on a job that stopped progressing is unverified', async () => {
    const a = setup();
    const p = planOf(a.snap, [cmd(a.snap, { operation: 'power_cap', target_resource_id: 'job-b', job_id: 'job-b', arguments: { power_limit_w: 500 } })]);
    const result = await a.coord.execute(WF, p);
    a.db.mutateSnapshot((s) => {
      const j = s.job_states.find((x) => x.job_id === 'job-b')!;
      j.status = 'failed';
    });
    const rep = await verifyWith(a, p, result, async (ms) => a.tick(ms));
    expect(rep.checks[0]!.ok).toBe(false);
    expect(rep.checks[0]!.problems).toContain('status failed');
  });

  it('pause_job: verified only when the job is observed paused with durable work preserved', async () => {
    const a = setup();
    const p = planOf(a.snap, [cmd(a.snap, { operation: 'pause_job', target_resource_id: 'job-a', job_id: 'job-a' })]);
    const result = await a.coord.execute(WF, p);
    const rep = await verifyWith(a, p, result);
    expect(rep.checks[0]!.ok).toBe(true);
    expect(rep.checks[0]!.evidence.job_status).toBe('paused');
    expect(rep.checks[0]!.evidence.durable_after).toBe(rep.checks[0]!.evidence.durable_before);
    expect(rep.handoff).toContain('pause creates no checkpoint');
    // ledger said succeeded, but the job never stopped: unverified
    const b = setup();
    const pb = planOf(b.snap, [cmd(b.snap, { operation: 'pause_job', target_resource_id: 'job-a', job_id: 'job-a' })]);
    const rb = await b.coord.execute(WF, pb);
    b.db.mutateSnapshot((s) => {
      s.job_states.find((x) => x.job_id === 'job-a')!.status = 'running';
    });
    const repb = await verifyWith(b, pb, rb);
    expect(repb.checks[0]!.ok).toBe(false);
    expect(repb.checks[0]!.problems).toContain('status running, not paused');
  });

  it('keep_running: needs observed ongoing work over the window with fresh evidence', async () => {
    const a = setup();
    const p = planOf(a.snap, [cmd(a.snap, { operation: 'keep_running', target_resource_id: 'job-c', job_id: 'job-c' })]);
    const result = await a.coord.execute(WF, p);
    expect(result.outcomes[0]!.status).toBe('succeeded');
    const rep = await verifyWith(a, p, result, async (ms) => a.tick(ms)); // FakeDb accrues progress for a kept job
    expect(rep.checks[0]!.ok).toBe(true);
    expect(rep.verified).toBe(true);

    const b = setup();
    const pb = planOf(b.snap, [cmd(b.snap, { operation: 'keep_running', target_resource_id: 'job-c', job_id: 'job-c' })]);
    const rb = await b.coord.execute(WF, pb);
    const repb = await verifyWith(b, pb, rb, async (ms) => {
      b.tick(ms);
      b.db.mutateSnapshot((s) => {
        const j = s.job_states.find((x) => x.job_id === 'job-c')!;
        j.progress_work_units = b.snap.job_states.find((x) => x.job_id === 'job-c')!.progress_work_units; // stuck
      });
    });
    expect(repb.checks[0]!.ok).toBe(false);
    expect(repb.checks[0]!.problems).toContain('progress not increasing');
  });

  it('checkpoint: re-verification is idempotent (a complete accessible row for the key; no second durability increase needed)', async () => {
    const a = setup();
    const p = planOf(a.snap, [cmd(a.snap, { operation: 'checkpoint', target_resource_id: 'job-a', job_id: 'job-a' })]);
    const result = await a.coord.execute(WF, p);
    const first = await verifyWith(a, p, result);
    expect(first.checks[0]!.ok).toBe(true);
    // a resumed verify after a restart: baseline captured AFTER the checkpoint landed (durable before == after)
    const durable = (await a.db.getObservedSnapshot()).job_states.find((j) => j.job_id === 'job-a')!.durable_work_units;
    const again = await verifyWith(a, p, { ...result, baseline: { sim_time_ms: a.clock.simTimeMs(), durable_work_units: { 'job-a': durable } } });
    expect(again.checks[0]!.ok).toBe(true);
    expect(again.checks[0]!.evidence.durable_before).toBe(durable);
    expect(again.checks[0]!.evidence.durable_after).toBe(durable);
    expect(again.verified).toBe(true);
    // ...but a checkpoint that is not accessible (store outage) is not protected work
    a.db.mutateSnapshot((s) => {
      for (const c of s.checkpoints) if (c.command_key === p.commands[0]!.command_key) c.accessible = false;
    });
    const broken = await verifyWith(a, p, result);
    expect(broken.checks[0]!.ok).toBe(false);
    expect(broken.checks[0]!.problems.some((x) => x.includes('not accessible'))).toBe(true);
  });

  it('migrate: a destination GPU that died after the move is unverified; the handoff names it as hardware work, never repaired', async () => {
    const a = setup();
    const p = makePlan(a.snap);
    const result = await a.coord.execute(WF, p);
    const dead = COOL_DEST[0]!;
    const wait = progressingWait(a);
    const rep = await verifyWith(a, p, result, async (ms) => {
      await wait(ms);
      a.db.injectSignal({ ...loadSignalXid79Dest(), resource_id: dead, sim_time_ms: a.clock.simTimeMs() });
    });
    const mv = rep.checks.find((c) => c.operation === 'migrate_restart')!;
    expect(mv.ok).toBe(false);
    expect(mv.problems).toContain(`${dead} unreachable`);
    expect(mv.problems).toContain(`${dead} XID 79`);
    expect(rep.persisted.unresolved_infrastructure).toContain(`${dead} unreachable (XID 79): needs hardware service`);
    expect(rep.persisted.next_human_action).toContain(`inspect/replace ${dead}`);
    expect(rep.handoff).not.toMatch(NO_REPAIR_CLAIM);
    expect(JSON.stringify(rep.persisted)).not.toMatch(NO_REPAIR_CLAIM);
  });

  it('migrate: a destination whose projected thermal headroom fell under the 5 C margin is unverified', async () => {
    const a = setup();
    const p = makePlan(a.snap);
    const result = await a.coord.execute(WF, p);
    const wait = progressingWait(a);
    const rep = await verifyWith(a, p, result, async (ms) => {
      await wait(ms);
      a.db.mutateSnapshot((s) => {
        s.nodes.find((n) => n.resource_id === 'node-r7-n1')!.thermal_headroom_c = 3;
      });
    });
    const mv = rep.checks.find((c) => c.operation === 'migrate_restart')!;
    expect(mv.ok).toBe(false);
    expect(mv.problems).toContain('rack-r7 thermal headroom 3 C < 5 C');
    expect(mv.problems).toContain('predictive check: DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT'); // FakePhysics needs 7 C
  });

  it('escalate: an acknowledged escalation is a handoff, not a recovered job', async () => {
    const a = setup();
    const p = planOf(a.snap, [cmd(a.snap, { operation: 'escalate', target_resource_id: 'job-c', job_id: 'job-c', arguments: { reason: 'non-preemptible job on a hot rack' } })]);
    const result = await a.coord.execute(WF, p);
    expect(result.outcomes[0]!.status).toBe('succeeded');
    const rep = await verifyWith(a, p, result);
    expect(rep.checks[0]!.ok).toBe(true);
    expect(rep.checks[0]!.evidence).toMatchObject({ handed_off: true, recovered: false });
    expect(rep.verified).toBe(false);
    expect(rep.escalate).toBe(true);
    expect(rep.outcome).toBe('handed_off');
    expect(rep.stage).toBe('escalated');
    expect(rep.handoff).toMatch(/^Handed off to operator \(not a recovered job\)/);
    expect(rep.handoff).toContain('non-preemptible job on a hot rack');
    expect(rep.persisted.actions.verified).toEqual([]);
    expect((await a.db.getWorkflow(WF))?.stage).toBe('escalated');
  });

  it('verify facts land on the ledger row (verify_action) with actor code, and the verify event stays within size limits', async () => {
    const a = setup();
    const p = makePlan(a.snap);
    const result = await a.coord.execute(WF, p);
    const rep = await verifyWith(a, p, result);
    for (const c of rep.checks) {
      const s = await a.db.getActionStatus(c.command_key);
      const v = s?.result.verification as Record<string, unknown>;
      expect(v.verified_by).toBe('code');
      expect(v.note).toBe(c.note);
      expect(v.problems).toEqual([]);
    }
    const ev = a.db.agentEvents.find((e) => e.stage === 'verify')!;
    expect(ev.summary.length).toBeLessThanOrEqual(200);
    expect(ev.summary).toContain('2/2 checks passed over 10000 sim-ms');
    expect(ev.summary).toContain('still open: pump-a degraded');
    expect(JSON.stringify(rep.persisted).length).toBeLessThan(6_000);
  });
});

describe('R3 durable handoff', () => {
  it('persists every required field and is read back unchanged by a fresh agent connection (resume path)', async () => {
    const a = setup();
    const gpu = gpuId(2, 6);
    const p = makePlan(a.snap, COOL_DEST, ([, mv]) => [cordonCmd(a.snap, gpu, [mv as string])]);
    const result = await a.coord.execute(WF, p);
    a.db.mutateSnapshot((s) => {
      s.gpus.find((x) => x.resource_id === gpu)!.availability = 'cordoned';
    });
    const rep = await verifyWith(a, p, result);
    expect(rep.verified).toBe(true);
    expect(handoffMissingFields(rep.persisted)).toEqual([]);

    // a brand-new process: new DbPort handle, new worker id, nothing in memory
    const fresh = freshConnection(a.db);
    const read = await readHandoff(fresh, WF);
    expect(read).not.toBeNull();
    expect(read).toEqual(rep.persisted);
    expect(handoffMissingFields(read)).toEqual([]);
    const h = read!;
    expect(h.source).toBe('code');
    expect(h.outcome).toBe('recovered');
    expect(h.evidence.incident_ids).toEqual(['inc-1']);
    expect(h.affected_jobs.map((j) => j.job_id)).toEqual(['job-a']);
    expect(h.affected_jobs[0]).toMatchObject({ status: 'running', racks: ['rack-r7', 'rack-r8'] });
    expect(h.actions.completed).toEqual(p.commands.map((c) => c.command_key));
    expect(h.actions.verified).toEqual(p.commands.map((c) => c.command_key));
    expect(h.actions.unverified).toEqual([]);
    expect(h.actions.blocked).toEqual([]);
    expect(h.checkpoint_outcome).toEqual([expect.objectContaining({ job_id: 'job-a', status: 'complete', accessible: true })]);
    expect(h.placement_outcome).toEqual([{ job_id: 'job-a', gpu_ids: expect.arrayContaining(COOL_DEST), racks: ['rack-r7', 'rack-r8'] }]);
    expect(h.verification_interval_sim_ms[1] - h.verification_interval_sim_ms[0]).toBeGreaterThanOrEqual(10_000);
    expect(h.unresolved_infrastructure).toEqual(expect.arrayContaining([expect.stringMatching(/^pump-a degraded .*needs human service$/), `${gpu} cordoned: needs hardware service`]));
    expect(h.remaining_risk.length).toBeGreaterThan(0);
    expect(h.next_human_action).toContain('service pump-a');
    expect(h.next_human_action).toContain(`inspect/replace ${gpu}`);
    expect(h.handoff.length).toBeLessThanOrEqual(600);
    expect(JSON.stringify(h)).not.toMatch(NO_REPAIR_CLAIM);

    // the fresh agent's resume pass sees a closed workflow and hands the operator the same handoff
    const events2 = createEventPublisher({ db: fresh, runId: RUN_ID, clock: a.clock, redact: (s) => s, startSeq: 1000 });
    const report = await resumeOpenWorkflows({ db: fresh, physics: new FakePhysics(), events: events2, workerId: 'worker-2', clock: a.clock, sleep: async () => undefined });
    expect(report.items).toEqual([]); // done workflows are closed; nothing to resume
    const wf = await fresh.getWorkflow(WF);
    expect(wf?.stage).toBe('done');
    expect(wf?.state.verification).toEqual(rep.persisted);
  });

  it('an escalated workflow hands its handoff to the next process through resume (nothing_to_do + handoff)', async () => {
    const a = setup();
    const p = makePlan(a.snap, [...Array.from({ length: 8 }, (_, g) => gpuId(6, g)), ...Array.from({ length: 8 }, (_, g) => gpuId(7, g))]);
    const result = await a.coord.execute(WF, p);
    const rep = await verifyWith(a, p, result);
    expect(rep.outcome).toBe('operator_review');
    expect(rep.persisted.actions.blocked).toEqual([{ command_key: p.commands[1]!.command_key, violations: expect.arrayContaining(['DEST_GPU_BUSY']) }]);
    expect(rep.persisted.next_human_action).toContain('review 1 unverified/blocked action(s)');

    const fresh = freshConnection(a.db);
    const events2 = createEventPublisher({ db: fresh, runId: RUN_ID, clock: a.clock, redact: (s) => s, startSeq: 1000 });
    const report = await resumeOpenWorkflows({ db: fresh, physics: new FakePhysics(), events: events2, workerId: 'worker-2', clock: a.clock, sleep: async () => undefined });
    expect(report.items).toEqual([expect.objectContaining({ workflow_id: WF, action: 'nothing_to_do', note: 'WAITING_FOR_OPERATOR' })]);
    expect(report.items[0]!.handoff).toEqual(rep.persisted);
    expect(handoffMissingFields(report.items[0]!.handoff)).toEqual([]);
  });

  it('a pre-R3 or partial verification object is not accepted as a handoff', () => {
    expect(handoffMissingFields({ verified: true, escalate: false, handoff: 'x', as_of_sim_time_ms: 1 })).toContain('next_human_action');
    expect(handoffMissingFields(null)).toEqual([...REQUIRED_HANDOFF_FIELDS]);
  });
});

describe('F-NV1 actor tags (verify)', () => {
  it('tags the verify event and ledger calls as code', async () => {
    const a = setup();
    const p = makePlan(a.snap);
    const result = await a.coord.execute(WF, p);
    await verifyRecovery({ db: a.db, events: a.events, waitSim: progressingWait(a), persist: a.coord.updateStage }, { workflowId: WF, plan: p, result });
    const ev = a.db.agentEvents.find((e) => e.stage === 'verify')!;
    expect(ev.actor).toBe('code');
    expect(ev.tool_calls.length).toBeGreaterThan(0);
    for (const t of ev.tool_calls) expect(t.actor).toBe('code');
    expect(ev.summary.length).toBeLessThanOrEqual(200);
  });
});
