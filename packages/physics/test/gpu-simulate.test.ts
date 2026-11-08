// P1-7: simulatePlan(), simulatePlanWithReference(), estimateWorld().
import { describe, expect, it } from 'vitest';
import { validatePayload, type ActionCommand, type ObservedSnapshot, type PhysicsWorld, type PlanCandidate } from '@dcos/contracts';
import {
  PRIVATE_KEYS,
  enqueueCommands,
  estimateWorld,
  simulatePlan,
  simulatePlanWithReference,
  step,
  toObserved,
  type PlanMetrics,
} from '../src/index.js';
import { PUMP_A_FAULT, T0, deepFreeze, demoWorld, fault, gpusOn, readFixture, runUntil, tickInput } from './gpu-helpers.js';

const degraded = readFixture<ObservedSnapshot>('observed_snapshot_pump_degraded.json');

let seq = 0;
function cmd(
  operation: ActionCommand['operation'], job: string, args: Record<string, unknown> = {}, deps: string[] = [],
  opts: Partial<ActionCommand> = {},
): ActionCommand {
  seq += 1;
  const c: ActionCommand = {
    schema_version: '1.1.0', run_id: 'run-demo-1', action_id: `act-sim-${seq}`, command_key: `ck-sim-${operation}-${job}-${seq}`,
    workflow_id: 'wf-1', plan_id: 'plan-1', incident_ids: ['inc-1'], operation, target_resource_id: job, job_id: job,
    arguments: args, depends_on_command_keys: deps, expected_decision_epoch: 1, expected_resource_versions: {},
    requested_sim_time_ms: T0 + 120_000, ...opts,
  };
  expect(validatePayload('ActionCommand', c)).toEqual({ ok: true });
  return c;
}

/** job-a: checkpoint, then (after it completes) move to the free racks r7 + r8. The intended demo plan. */
function jobAMove(): ActionCommand[] {
  const ck = cmd('checkpoint', 'job-a');
  return [ck, cmd('migrate_restart', 'job-a', { destination_node_ids: ['node-r7-n1', 'node-r8-n1'] }, [ck.command_key])];
}

function expectValidNumbers(m: PlanMetrics): void {
  for (const k of ['expected_completion_delay_sim_s', 'expected_lost_work_units', 'expected_gpu_busy_waste_s'] as const) {
    expect(Number.isFinite(m[k]), k).toBe(true);
    expect(m[k], k).toBeGreaterThanOrEqual(0);
  }
  expect(m.failure_risk_estimate).toBeGreaterThanOrEqual(0);
  expect(m.failure_risk_estimate).toBeLessThanOrEqual(1);
  // the numeric fields and assumptions drop straight into a PlanCandidate
  const candidate: PlanCandidate = {
    schema_version: '1.1.0', plan_id: 'plan-1', run_id: 'run-demo-1', workflow_id: 'wf-1', incident_ids: ['inc-1'],
    based_on_decision_epoch: 1, assumptions: m.assumptions, command_keys: ['ck-1'],
    expected_completion_delay_sim_s: m.expected_completion_delay_sim_s, expected_lost_work_units: m.expected_lost_work_units,
    expected_gpu_busy_waste_s: m.expected_gpu_busy_waste_s, failure_risk_estimate: m.failure_risk_estimate, explanation: 'test',
  };
  expect(validatePayload('PlanCandidate', candidate)).toEqual({ ok: true });
}

function expectNoPrivate(m: PlanMetrics): void {
  const text = JSON.stringify(m);
  for (const k of PRIVATE_KEYS) expect(text).not.toContain(k);
  expect(text).not.toMatch(/fault-|fault_id|cooling_pump_degradation|severity|capacity_factor/);
}

/** Truth world with several private faults, observed at start + 120 s. */
function faultyTruth(): PhysicsWorld {
  const faults = [
    PUMP_A_FAULT,
    fault('gpu_xid_79', 'gpu-r5-n1-0', T0 + 60_000, { fault_id: 'fault-xid79-r5-0' }),
    fault('gpu_thermal_load', 'gpu-r1-n1-3', T0 + 30_000, { fault_id: 'fault-thermal-r1-3', severity: 0.5 }),
    // a future fault that the planner must not see
    fault('gpu_xid_79', 'gpu-r7-n1-0', T0 + 300_000, { fault_id: 'fault-future-r7-0' }),
  ];
  return runUntil(demoWorld(), T0 + 120_000, { faults }).world;
}

describe('estimateWorld', () => {
  it('is a valid PhysicsWorld with no private faults even when the source world has some', () => {
    const truth = faultyTruth();
    expect(truth.active_faults_private.map((f) => f.fault_id).sort()).toEqual(['fault-pump-a-degradation-1', 'fault-thermal-r1-3', 'fault-xid79-r5-0']);
    const est = estimateWorld(toObserved(truth), 7);
    expect(validatePayload('PhysicsWorld', est)).toEqual({ ok: true });
    expect(est.active_faults_private).toEqual([]);
    const text = JSON.stringify(est);
    expect(text).not.toMatch(/fault-|cooling_pump_degradation|gpu_thermal_load/);
    const h = est.hidden_physics_state_json as Record<string, any>;
    // only observable consequences carry over: the XID-79 GPU stays unreachable, pump capacity = observed estimate
    expect(h.gpu_failure).toEqual({ 'gpu-r5-n1-0': 'xid_79' });
    expect(est.observable.resources.find((r) => r.resource_id === 'pump-a')!.config.nominal_capacity_w).toBe(9600);
    expect(h.seed).toBe(7);
    // nothing from the truth's hidden state (e.g. its seeded per-GPU offsets) is copied
    const truthH = truth.hidden_physics_state_json as Record<string, any>;
    expect(h.gpu_offset_c['gpu-r1-n1-3']).not.toBe(truthH.gpu_offset_c['gpu-r1-n1-3']);
  });

  it('reproduces every observed GPU temperature at t0 (coolant inversion + residual offsets)', () => {
    const est = estimateWorld(degraded);
    const h = est.hidden_physics_state_json as Record<string, any>;
    expect(h.loop_temp_c['loop-a']).toBeCloseTo(39.4, 0);
    expect(h.loop_temp_c['loop-b']).toBeGreaterThanOrEqual(35);
    expect(h.loop_temp_c['loop-b']).toBeLessThan(35.3);
    // one tick with no faults: the estimate's temps match the truth's next tick within rounding (0.1 °C)
    const truthNext = step(tickInput(runUntil(demoWorld(), T0 + 120_000, { faults: [PUMP_A_FAULT] }).world, [PUMP_A_FAULT])).world_after;
    const estNext = step(tickInput(est)).world_after;
    for (const g of estNext.observable.gpus) {
      const t = truthNext.observable.gpus.find((x) => x.resource_id === g.resource_id)!;
      expect(Math.abs(g.temp_c - t.temp_c), g.resource_id).toBeLessThanOrEqual(0.1 + 1e-9);
    }
  });

  it('tracks the truth: with no action job-a fails on the same tick as in the real world', () => {
    const failTick = (start: PhysicsWorld, faults: typeof PUMP_A_FAULT[]): number | null => {
      let w = start;
      for (let i = 0; i < 600; i++) {
        w = step(tickInput(w, faults)).world_after;
        if (w.observable.job_states.find((j) => j.job_id === 'job-a')!.status === 'failed') return w.observable.clock.sim_time_ms;
      }
      return null;
    };
    const truth = runUntil(demoWorld(), T0 + 120_000, { faults: [PUMP_A_FAULT] }).world;
    const real = failTick(truth, [PUMP_A_FAULT]);
    const est = failTick(estimateWorld(toObserved(truth)), []);
    expect(real).not.toBeNull();
    expect(Math.abs(est! - real!)).toBeLessThanOrEqual(2000);
  });

  it('rebuilds an in-flight checkpoint from the observed rows', () => {
    const ck = cmd('checkpoint', 'job-b');
    const truth = runUntil(enqueueCommands(demoWorld(), [ck]), T0 + 110_000, { requestAt: { [T0 + 100_000]: [ck.action_id] } }).world;
    const obs = toObserved(truth);
    expect(obs.job_states.find((j) => j.job_id === 'job-b')!.status).toBe('checkpointing');
    let w = estimateWorld(obs);
    for (let i = 0; i < 20; i++) w = step(tickInput(w)).world_after; // → start + 130 s
    const jb = w.observable.job_states.find((j) => j.job_id === 'job-b')!;
    expect(jb).toMatchObject({ status: 'running', latest_checkpoint_id: 'ckpt-job-b-2' });
    expect(w.observable.checkpoints.find((c) => c.checkpoint_id === 'ckpt-job-b-2')).toMatchObject({ status: 'complete', complete_sim_time_ms: T0 + 130_000 });
    // a plan step may depend on that real in-flight command
    const mv = cmd('migrate_restart', 'job-b', { destination_node_ids: ['node-r1-n1'] }, [ck.command_key]);
    expect(simulatePlan(obs, { commands: [mv] }).violations).toEqual([]);
  });

  it('an observed inaccessible checkpoint store stays inaccessible (synthetic estimated.* row only)', () => {
    const obs: ObservedSnapshot = JSON.parse(JSON.stringify(degraded));
    for (const c of obs.checkpoints) c.accessible = false;
    const est = estimateWorld(obs);
    expect(est.active_faults_private.map((f) => f.fault_id)).toEqual(['estimated.storage_inaccessible.ckpt-store-1']);
    const m = simulatePlan(obs, { commands: [cmd('checkpoint', 'job-b')] });
    expect(m.violations).toEqual(['CHECKPOINT_NOT_ACCESSIBLE']);
    expect(m.assumptions.join('\n')).toMatch(/ckpt-store-1 was observed inaccessible/);
  });
});

describe('simulatePlan', () => {
  it('is deterministic and never mutates the input snapshot', () => {
    const obs = deepFreeze(JSON.parse(JSON.stringify(degraded)) as ObservedSnapshot);
    const before = JSON.stringify(obs);
    const plan = deepFreeze({ commands: jobAMove() });
    const a = simulatePlan(obs, plan, { seed: 3 });
    const b = simulatePlan(obs, plan, { seed: 3 });
    expect(a).toEqual(b);
    expect(simulatePlanWithReference(obs, plan, { seed: 3 })).toEqual({ plan: a, do_nothing: simulatePlan(obs, { commands: [] }, { seed: 3 }) });
    expect(JSON.stringify(obs)).toBe(before);
  });

  it('job-a: checkpoint + move to r7/r8 beats keep-running (lower lost work and delay)', () => {
    const keepA = cmd('keep_running', 'job-a');
    const keep = simulatePlan(degraded, { commands: [keepA] });
    const { plan: move, do_nothing } = simulatePlanWithReference(degraded, { commands: jobAMove() });
    // keep_running has no physical effect: identical to do-nothing apart from the command itself
    expect({ ...keep, assumptions: [] }).toEqual({ ...do_nothing, assumptions: [] });
    // with no action, loop-a reaches shutdown within the horizon: job-a fails back to its 9-min-old checkpoint
    expect(keep.failure_risk_estimate).toBe(1);
    expect(keep.expected_lost_work_units).toBeGreaterThan(15_000);
    expect(keep.expected_completion_delay_sim_s).toBeGreaterThan(1200);
    expect(keep.assumptions.join('\n')).toMatch(/job failures within the horizon: job-a/);
    // checkpoint (30 s) + restart (120 s) + the 1 s gap between them
    expect(move.violations).toEqual([]);
    expect(move.expected_completion_delay_sim_s).toBeCloseTo(151, 0);
    expect(move.expected_lost_work_units).toBeLessThan(100);
    expect(move.failure_risk_estimate).toBe(0);
    expect(move.expected_lost_work_units).toBeLessThan(keep.expected_lost_work_units);
    expect(move.expected_completion_delay_sim_s).toBeLessThan(keep.expected_completion_delay_sim_s);
    for (const m of [keep, move]) {
      expectValidNumbers(m);
      expectNoPrivate(m);
    }
  });

  it('job-b (alongside job-a checkpoint + move): keep running or power_cap beats moving it', () => {
    const run = (extra: ActionCommand[]) => simulatePlan(degraded, { commands: [...jobAMove(), ...extra] });
    const keep = run([cmd('keep_running', 'job-b')]);
    const cap = run([cmd('power_cap', 'job-b', { power_limit_w: 500 })]);
    const ckB = cmd('checkpoint', 'job-b');
    const ckMove = run([ckB, cmd('migrate_restart', 'job-b', { destination_node_ids: ['node-r1-n1'] }, [ckB.command_key])]);
    const move = run([cmd('migrate_restart', 'job-b', { destination_node_ids: ['node-r5-n1'] })]);
    for (const m of [keep, cap, ckMove, move]) {
      expect(m.violations).toEqual([]);
      expectValidNumbers(m);
      expectNoPrivate(m);
    }
    for (const stay of [keep, cap]) {
      for (const go of [ckMove, move]) {
        expect(stay.expected_completion_delay_sim_s).toBeLessThan(go.expected_completion_delay_sim_s);
        expect(stay.expected_lost_work_units).toBeLessThanOrEqual(go.expected_lost_work_units);
      }
    }
    // the cap costs −15% clock on 8 GPUs over the horizon (≈ 90 s of job-b time)
    expect(cap.expected_completion_delay_sim_s - keep.expected_completion_delay_sim_s).toBeCloseTo(90, 0);
    // a move without a fresh checkpoint throws away job-b's work since its last checkpoint
    expect(move.expected_lost_work_units).toBeGreaterThan(1000);
  });

  it('reports physics failures and dependency drops as violations', () => {
    const ckC = cmd('checkpoint', 'job-c'); // job-c has no checkpoint support
    const mvC = cmd('migrate_restart', 'job-c', { destination_node_ids: ['node-r1-n1'] }, [ckC.command_key]);
    const after = cmd('cordon_gpu', 'gpu-r6-n1-0', {}, [mvC.command_key], { job_id: null });
    const ghost = cmd('pause_job', 'job-b', {}, ['ck-not-in-plan']);
    const busy = cmd('migrate_restart', 'job-a', { destination_gpu_ids: gpusOn(6, 7) }); // r6 is job-c's
    const m = simulatePlan(degraded, { commands: [ckC, mvC, after, ghost, busy] });
    expect(m.violations).toEqual(['CHECKPOINT_UNSUPPORTED', 'DEST_GPU_BUSY', 'DEPENDENCY_NOT_FOUND', 'DEPENDENCY_FAILED', 'DEPENDENCY_FAILED']);
    expectValidNumbers(m);
  });

  it('a dependent waits for its dependency to complete before it is requested', () => {
    const ck = cmd('checkpoint', 'job-a');
    const mv = cmd('migrate_restart', 'job-a', { destination_node_ids: ['node-r7-n1', 'node-r8-n1'] }, [ck.command_key]);
    // without the dependency both are requested on tick 1 and the move finds job-a already checkpointing
    const noDep = { ...mv, command_key: 'ck-nodep', action_id: 'act-nodep', depends_on_command_keys: [] };
    expect(simulatePlan(degraded, { commands: [ck, mv] }).violations).toEqual([]);
    expect(simulatePlan(degraded, { commands: [ck, noDep] }).violations).toEqual(['JOB_STATE_INVALID']);
  });

  it('honours horizon_s and reports unfinished commands', () => {
    const short = simulatePlan(degraded, { commands: jobAMove() }, { horizon_s: 60 });
    // job-a runs on tick 1 (the checkpoint starts at its end), then makes no progress while checkpointing / restarting
    expect(short.expected_completion_delay_sim_s).toBeCloseTo(59, 0);
    expect(short.assumptions.join('\n')).toMatch(/Horizon 60 sim-s/);
    expect(short.assumptions.join('\n')).toMatch(/1 plan command\(s\) had not finished/);
    const none = simulatePlan(degraded, { commands: [] }, { horizon_s: 0 });
    expect(none).toMatchObject({ expected_completion_delay_sim_s: 0, expected_lost_work_units: 0, expected_gpu_busy_waste_s: 0, failure_risk_estimate: 0 });
    expect(simulatePlan(degraded, { commands: [] }).assumptions.join('\n')).toMatch(/Horizon 600 sim-s at step 1000 ms; seed 0/);
  });

  it('runs a 600 s plan fast enough to call several times per decision', () => {
    const plan = { commands: jobAMove() };
    simulatePlan(degraded, plan); // warm-up
    const n = 5;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) simulatePlan(degraded, plan);
    const ms = (performance.now() - t0) / n;
    console.log(`simulatePlan: ${ms.toFixed(1)} ms per 600-tick call`);
    expect(ms).toBeLessThan(1000);
  });
});
