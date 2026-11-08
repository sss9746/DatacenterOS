import { describe, expect, it } from 'vitest';
import type { ActionCommand, ObservedSnapshot, PlanCandidate } from '@dcos/contracts';
import { createCoordinator, type ExecutablePlan } from '../src/coordinator.js';
import { createEventPublisher } from '../src/events.js';
import type { PhysicsPort } from '../src/ports.js';
import { buildCommand } from '../src/tools/command.js';
import { verifyRecovery } from '../src/verify.js';
import { FakeDb, FakePhysics } from './fakes/index.js';
import { RUN_ID, gpuId, loadPumpDegradedSnapshot } from './fixtures/index.js';

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
    for (const c of p.commands) expect((await a.db.getActionStatus(c.command_key))?.result.verified).toBe(true);
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
