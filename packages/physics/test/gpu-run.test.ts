// P1-9b: the offline harness runScenario / runAllScenarios / summarizeResults (src/gpu/run.ts).
// Written against small inline test policies (P1-8's reactive / threshold policies are tested separately once merged).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { validatePayload, type ActionCommand, type EvaluationResult, type ObservedSnapshot } from '@dcos/contracts';
import { PRIVATE_KEYS, loadScenarios, runAllScenarios, runScenario, summarizeResults, type Scenario } from '../src/index.js';
import { DO_NOTHING_POLICY, runScenarioDetailed, type Policy, type ScenarioRunDetails } from '../src/gpu/run.js';
import { DO_NOTHING_FILE, EVALUATION_DIR, buildBaselineFiles, type ReferenceRow } from '../scripts/make-baseline-results.js';
import { T0, gpusOn } from './gpu-helpers.js';

const scenarios = loadScenarios();
const byId = new Map(scenarios.map((s) => [s.scenario_id, s]));
const sc = (id: string): Scenario => {
  const s = byId.get(id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
};

// ---- inline test policies -------------------------------------------------------------------------

function mk(
  obs: ObservedSnapshot, op: ActionCommand['operation'], job: string, key: string,
  args: Record<string, unknown> = {}, deps: string[] = [], over: Partial<ActionCommand> = {},
): ActionCommand {
  return {
    schema_version: '1.1.0', run_id: obs.run_id, action_id: `act-${key}`, command_key: key, workflow_id: 'wf-test',
    plan_id: 'plan-test', incident_ids: ['inc-test'], operation: op, target_resource_id: job, job_id: job, arguments: args,
    depends_on_command_keys: deps, expected_decision_epoch: obs.clock.decision_epoch, expected_resource_versions: {},
    requested_sim_time_ms: obs.clock.sim_time_ms, ...over,
  };
}

/** While pump-a looks unhealthy and job-a runs: checkpoint job-a, then (after it completes) move it to r7 + r8.
 * Re-issues the same two keys every tick, so the harness's idempotency is exercised. */
const ckptMove: Policy = (obs) => {
  const pump = obs.cooling.find((c) => c.resource_id === 'pump-a');
  const job = obs.job_states.find((j) => j.job_id === 'job-a');
  if (!pump || pump.operating_state === 'normal' || job?.status !== 'running') return [];
  return [
    mk(obs, 'checkpoint', 'job-a', 'ckm-ckpt-job-a'),
    mk(obs, 'migrate_restart', 'job-a', 'ckm-move-job-a', { destination_gpu_ids: gpusOn(7, 8) }, ['ckm-ckpt-job-a']),
  ];
};

/** From start + 125 s: move job-a onto the hot rack r6 (its ready GPUs first, then r7 / r8), with no new checkpoint. */
const unsafeR6: Policy = (obs) => {
  if (obs.clock.sim_time_ms < T0 + 125_000) return [];
  const ready = (r: number) => obs.gpus.filter((g) => g.resource_id.startsWith(`gpu-r${r}-`) && g.availability === 'ready').map((g) => g.resource_id);
  const dest = [...ready(6), ...ready(7), ...ready(8)].slice(0, 16);
  return [mk(obs, 'migrate_restart', 'job-a', 'unsafe-r6-move-job-a', { destination_gpu_ids: dest })];
};

const validate = (r: EvaluationResult) => expect(validatePayload('EvaluationResult', r)).toEqual({ ok: true });

/** Pump-degraded scenarios where r7 / r8 and the checkpoint store stay usable: checkpoint + move must save work. */
const PUMP_MOVE_HELPS = ['sc03-severe-pump', 'sc09-hot-destination', 'sc11-stale-telemetry', 'sc12-two-independent-incidents',
  'sc16-pump-outage', 'sc17-demo-destination-xid79'];

let doNothing: EvaluationResult[] = [];
let moved: EvaluationResult[] = [];
let wallMs = 0;
const resultOf = (rows: EvaluationResult[], id: string) => rows.find((r) => r.scenario_id === id)!;

beforeAll(async () => {
  const t0 = performance.now();
  doNothing = await runAllScenarios(DO_NOTHING_POLICY, { policy_name: 'reactive' });
  wallMs = performance.now() - t0;
  moved = await runAllScenarios(ckptMove, { policy_name: 'threshold' });
  const table = scenarios.map((s) => {
    const a = resultOf(doNothing, s.scenario_id);
    const b = resultOf(moved, s.scenario_id);
    return `${s.scenario_id.padEnd(38)} lost ${a.lost_work_units} → ${b.lost_work_units} | delay ${a.job_completion_delay_s} → ${b.job_completion_delay_s} | waste ${a.gpu_busy_waste_s} → ${b.gpu_busy_waste_s} | unnec ${b.unnecessary_preemptions} blocked ${b.unsafe_actions_blocked} rec ${b.successful_recoveries}/${b.failed_recoveries}`;
  });
  console.log(`[gpu-run] runAllScenarios(do-nothing, 20 scenarios incl. the internal reference) ${Math.round(wallMs)} ms\n${table.join('\n')}`);
}, 120_000);

// ---- tests ----------------------------------------------------------------------------------------

describe('runScenario: results', () => {
  it('runAllScenarios returns one valid EvaluationResult per scenario, in scenario order', () => {
    expect(doNothing.map((r) => r.scenario_id)).toEqual(scenarios.map((s) => s.scenario_id));
    expect(moved).toHaveLength(scenarios.length);
    for (const r of [...doNothing, ...moved]) validate(r);
    expect(resultOf(moved, 'sc03-severe-pump')).toMatchObject({
      schema_version: '1.1.0', run_id: 'eval-threshold-sc03-severe-pump', policy: 'threshold', seed: sc('sc03-severe-pump').seed,
      agent_crash_resumes: 0,
    });
  });

  it('runAllScenarios stays practical for P4 (seconds, not minutes)', () => {
    expect(wallMs).toBeLessThan(30_000);
  });

  it('is deterministic: the same scenario + policy gives an identical result and log', async () => {
    for (const id of ['sc03-severe-pump', 'sc05-pump-gpu-mid-checkpoint']) {
      const a = await runScenarioDetailed(sc(id), ckptMove, { policy_name: 'threshold' });
      const b = await runScenarioDetailed(sc(id), ckptMove, { policy_name: 'threshold' });
      expect(b).toEqual(a);
      expect(a.result).toEqual(resultOf(moved, id));
    }
  });

  it('do-nothing: no commands, no unsafe / preemption / recovery counts; healthy scenarios lose nothing', () => {
    for (const r of doNothing) {
      expect(r).toMatchObject({ unnecessary_preemptions: 0, unsafe_actions_executed: 0, unsafe_actions_blocked: 0, successful_recoveries: 0, failed_recoveries: 0 });
    }
    for (const id of ['sc01-thermal-warning-only', 'sc02-harmless-temp-spike', 'sc14-preventive-move-hurts', 'sc18-xid74-nvlink']) {
      expect(resultOf(doNothing, id)).toMatchObject({ lost_work_units: 0, job_completion_delay_s: 0, gpu_busy_waste_s: 0 });
    }
    // severe pump: job-a and job-b fail back to durable work; a job that never finishes still accrues delay
    expect(resultOf(doNothing, 'sc03-severe-pump').lost_work_units).toBeGreaterThan(16 * 540);
    expect(resultOf(doNothing, 'sc03-severe-pump').job_completion_delay_s).toBeGreaterThan(0);
  });

  it('opts.run_id labels the result', async () => {
    const r = await runScenario(sc('sc04-failed-gpu-xid79'), DO_NOTHING_POLICY, { policy_name: 'nemotron', run_id: 'run-eval-7' });
    expect(r).toMatchObject({ run_id: 'run-eval-7', policy: 'nemotron', scenario_id: 'sc04-failed-gpu-xid79' });
    validate(r);
  });
});

describe('runScenario: checkpoint + move test policy', () => {
  it('beats do-nothing on lost work on the pump-degraded scenarios where a move is possible', () => {
    for (const id of PUMP_MOVE_HELPS) {
      expect(resultOf(moved, id).lost_work_units, id).toBeLessThan(resultOf(doNothing, id).lost_work_units);
      expect(resultOf(moved, id).successful_recoveries, id).toBe(1);
    }
    // no spare capacity: the move is refused, but the checkpoint alone still saves work
    const s07 = resultOf(moved, 'sc07-no-spare-capacity');
    expect(s07.unsafe_actions_blocked).toBe(1);
    expect(s07.lost_work_units).toBeLessThan(resultOf(doNothing, 'sc07-no-spare-capacity').lost_work_units);
  });

  it('a needless move on a harmless pump alarm counts as 2 unnecessary preemptions (checkpoint + move) and costs time', () => {
    for (const id of ['sc01-thermal-warning-only', 'sc13-near-complete-job-stay', 'sc14-preventive-move-hurts']) {
      const r = resultOf(moved, id);
      expect(r.unnecessary_preemptions, id).toBe(2);
      expect(r.job_completion_delay_s, id).toBeGreaterThan(resultOf(doNothing, id).job_completion_delay_s);
      expect(r.successful_recoveries + r.failed_recoveries, id).toBe(0); // not a recovery: job-a was never at risk
    }
  });

  it('runs each command_key once although the policy re-issues it every tick (idempotency)', async () => {
    const d = await runScenarioDetailed(sc('sc03-severe-pump'), ckptMove, { policy_name: 'threshold' });
    expect(d.duplicate_commands_ignored).toBeGreaterThan(100);
    expect(d.commands.map((c) => [c.command_key, c.disposition, c.outcome?.status])).toEqual([
      ['ckm-ckpt-job-a', 'executed', 'succeeded'],
      ['ckm-move-job-a', 'executed', 'succeeded'],
    ]);
    // the move was requested only after its checkpoint completed
    const [ck, mv] = d.commands;
    expect(mv!.requested_sim_time_ms!).toBeGreaterThan(ck!.outcome!.sim_time_ms - 1);
    expect(d.failed_job_ids).toEqual([]);
  });

  it('storage down: the gate blocks the checkpoint and the dependent move (CHECKPOINT_NOT_ACCESSIBLE)', async () => {
    const d = await runScenarioDetailed(sc('sc10-checkpoint-storage-inaccessible'), ckptMove, { policy_name: 'threshold' });
    expect(d.result.unsafe_actions_blocked).toBe(2);
    expect(d.result.unsafe_actions_executed).toBe(0);
    for (const c of d.commands) {
      expect(c.disposition).toBe('blocked');
      expect(c.safety.violations).toContain('CHECKPOINT_NOT_ACCESSIBLE');
    }
  });

  it('a checkpoint killed by an XID mid-write drops its dependent move: a failed recovery', async () => {
    const d = await runScenarioDetailed(sc('sc05-pump-gpu-mid-checkpoint'), ckptMove, { policy_name: 'threshold' });
    expect(d.commands.map((c) => [c.command_key, c.disposition, c.outcome?.reason_code ?? null, c.dependency_reason])).toEqual([
      ['ckm-ckpt-job-a', 'executed', 'JOB_FAILED_DURING_OPERATION', null],
      ['ckm-move-job-a', 'dependency_dropped', null, 'DEPENDENCY_FAILED'],
    ]);
    expect(d.result).toMatchObject({ successful_recoveries: 0, failed_recoveries: 1 });
  });
});

describe('runScenario: the safety gate', () => {
  it('blocks the unsafe move onto r6 (gate safety): blocked ≥ 1, executed 0', async () => {
    for (const id of ['sc12-two-independent-incidents', 'sc03-severe-pump', 'sc01-thermal-warning-only']) {
      const d = await runScenarioDetailed(sc(id), unsafeR6, { policy_name: 'nemotron' });
      validate(d.result);
      expect(d.result.unsafe_actions_blocked, id).toBeGreaterThanOrEqual(1);
      expect(d.result.unsafe_actions_executed, id).toBe(0);
      expect(d.commands[0]!.safety.decision).toBe('deny');
      expect(d.commands[0]!.safety.violations).toContain('DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT');
    }
  });

  it('counts it as an executed unsafe action with gate none (r6 is free after job-c fails in sc12)', async () => {
    const d = await runScenarioDetailed(sc('sc12-two-independent-incidents'), unsafeR6, { policy_name: 'nemotron', gate: 'none' });
    validate(d.result);
    expect(d.result.unsafe_actions_blocked).toBe(0);
    expect(d.result.unsafe_actions_executed).toBe(1);
    expect(d.commands[0]).toMatchObject({ disposition: 'executed', unsafe_executed: expect.arrayContaining(['SAFETY_DENY']) });
    expect(d.commands[0]!.safety.violations).toContain('DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT');
  });

  it('gate none: a move onto the hot r1 + r5 (sc09) is denied at request time AND its destination overheats: counted once', async () => {
    const hotDest: Policy = (obs) => (obs.clock.sim_time_ms >= T0 + 15_000
      ? [mk(obs, 'migrate_restart', 'job-a', 'hot-move-job-a', { destination_gpu_ids: gpusOn(1, 5) })]
      : []);
    const open = await runScenarioDetailed(sc('sc09-hot-destination'), hotDest, { policy_name: 'nemotron', gate: 'none' });
    expect(open.commands[0]).toMatchObject({ disposition: 'executed', unsafe_executed: ['SAFETY_DENY', 'DEST_REACHED_SLOWDOWN'] });
    expect(open.result.unsafe_actions_executed).toBe(1);
    const gated = await runScenario(sc('sc09-hot-destination'), hotDest, { policy_name: 'nemotron' });
    expect(gated).toMatchObject({ unsafe_actions_executed: 0, unsafe_actions_blocked: 1 });
    // blocked → nothing physical happened: the same world as do-nothing
    expect({ ...gated, unsafe_actions_blocked: 0, run_id: '', policy: 'reactive' }).toEqual({ ...resultOf(doNothing, 'sc09-hot-destination'), run_id: '' });
  });

  it('gate none: a move physics cannot start (r6 busy) is not executed, so not counted', async () => {
    const d = await runScenarioDetailed(sc('sc03-severe-pump'), unsafeR6, { policy_name: 'nemotron', gate: 'none' });
    expect(d.commands[0]).toMatchObject({ disposition: 'physics_rejected', outcome: { status: 'failed', reason_code: 'DEST_GPU_BUSY' } });
    expect(d.result.unsafe_actions_executed).toBe(0);
  });

  it('gate none executes the ckpt + move plan the same way when safety allows it', async () => {
    const a = await runScenario(sc('sc03-severe-pump'), ckptMove, { policy_name: 'threshold', gate: 'none' });
    expect(a).toEqual(resultOf(moved, 'sc03-severe-pump'));
  });

  it('retry_new_snapshot drops the command without remembering its key: the same key re-issued fresh runs', async () => {
    let calls = 0;
    const staleOnce: Policy = (obs) => {
      if (obs.clock.sim_time_ms < T0 + 20_000) return [];
      calls += 1;
      // first attempt carries a stale epoch; later attempts use the current one with the SAME key
      const epoch = calls === 1 ? obs.clock.decision_epoch + 5 : obs.clock.decision_epoch;
      return [mk(obs, 'checkpoint', 'job-b', 'retry-ckpt-job-b', {}, [], { expected_decision_epoch: epoch })];
    };
    const d = await runScenarioDetailed(sc('sc01-thermal-warning-only'), staleOnce, { policy_name: 'nemotron' });
    expect(d.retry_dropped).toBe(1);
    expect(d.commands).toHaveLength(1);
    expect(d.commands[0]).toMatchObject({ command_key: 'retry-ckpt-job-b', disposition: 'executed', issued_sim_time_ms: T0 + 21_000 });
    expect(d.result.unsafe_actions_blocked).toBe(0);
  });

  it('a command on a job whose checkpoint is in flight is a CONFLICTING_ACTION (in-flight lease closure)', async () => {
    const twoCkpts: Policy = (obs) => {
      const t = obs.clock.sim_time_ms - T0;
      if (t === 20_000) return [mk(obs, 'checkpoint', 'job-b', 'lease-ckpt-1')];
      if (t === 25_000) return [mk(obs, 'power_cap', 'job-b', 'lease-cap-1', { power_limit_w: 500 })];
      return [];
    };
    const d = await runScenarioDetailed(sc('sc01-thermal-warning-only'), twoCkpts, { policy_name: 'nemotron' });
    expect(d.commands.map((c) => [c.command_key, c.disposition])).toEqual([['lease-ckpt-1', 'executed'], ['lease-cap-1', 'blocked']]);
    expect(d.commands[1]!.safety.violations).toContain('CONFLICTING_ACTION');
  });
});

describe('runScenario: policy interface', () => {
  it('awaits async policies and only ever hands them a private-free ObservedSnapshot with ctx.sim_time_ms', async () => {
    const seenTimes: number[] = [];
    const leaks: string[] = [];
    const asyncMove: Policy = async (obs, ctx) => {
      seenTimes.push(ctx.sim_time_ms);
      expect(ctx.sim_time_ms).toBe(obs.clock.sim_time_ms);
      const text = JSON.stringify(obs);
      for (const k of PRIVATE_KEYS) if (text.includes(k)) leaks.push(k);
      if (/fault_id|cooling_pump_degradation/.test(text)) leaks.push('fault truth');
      await Promise.resolve();
      return ckptMove(obs, ctx);
    };
    const r = await runScenario(sc('sc03-severe-pump'), asyncMove, { policy_name: 'threshold' });
    expect(r).toEqual(resultOf(moved, 'sc03-severe-pump'));
    expect(leaks).toEqual([]);
    expect(seenTimes).toHaveLength(sc('sc03-severe-pump').horizon_s);
    expect(seenTimes[0]).toBe(T0); // the run clock starts at 600 000 (CONTRACTS §0.12 #2)
  });

  it('a policy mutating its snapshot cannot change the world', async () => {
    const vandal: Policy = (obs) => {
      for (const j of obs.job_states) j.progress_work_units = 0;
      obs.gpus.length = 0;
      return [];
    };
    const r = await runScenario(sc('sc03-severe-pump'), vandal, { policy_name: 'reactive' });
    expect(r).toEqual(resultOf(doNothing, 'sc03-severe-pump'));
  });
});

describe('summarizeResults', () => {
  it('totals per policy, sorted by policy name', () => {
    const sum = summarizeResults([...doNothing, ...moved]);
    expect(sum.map((x) => [x.policy, x.scenarios])).toEqual([['reactive', 20], ['threshold', 20]]);
    const total = (rows: EvaluationResult[], k: keyof EvaluationResult) => rows.reduce((s, r) => s + (r[k] as number), 0);
    expect(sum[1]!.lost_work_units).toBeCloseTo(total(moved, 'lost_work_units'), 3);
    expect(sum[1]!.unnecessary_preemptions).toBe(total(moved, 'unnecessary_preemptions'));
    expect(sum[1]!.successful_recoveries).toBe(total(moved, 'successful_recoveries'));
    expect(sum[0]!.lost_work_units).toBeGreaterThan(sum[1]!.lost_work_units);
    expect(summarizeResults([])).toEqual([]);
  });
});

describe('fixtures/evaluation (hand-off to P4)', () => {
  let files: Record<string, string> = {};
  beforeAll(async () => {
    files = await buildBaselineFiles({ runAllScenarios, DO_NOTHING_POLICY });
  }, 120_000);

  it('the files on disk are exactly what the generator produces', () => {
    const onDisk = readdirSync(EVALUATION_DIR).sort();
    expect(onDisk).toEqual(Object.keys(files).sort());
    for (const [name, text] of Object.entries(files)) expect(readFileSync(join(EVALUATION_DIR, name), 'utf8'), name).toBe(text);
  });

  it('the do-nothing reference has 20 rows that are EvaluationResult-valid apart from the non-contract policy label', () => {
    const rows = JSON.parse(files[DO_NOTHING_FILE]!) as ReferenceRow[];
    expect(rows.map((r) => r.scenario_id)).toEqual(scenarios.map((s) => s.scenario_id));
    for (const r of rows) {
      expect(r.policy).toBe('do_nothing');
      expect(validatePayload('EvaluationResult', r).ok).toBe(false); // can never be published as a contract row
      expect(validatePayload('EvaluationResult', { ...r, policy: 'reactive' })).toEqual({ ok: true });
      const { policy: _p, run_id: _r, ...metrics } = r;
      const { policy: _q, run_id: _s, ...live } = resultOf(doNothing, r.scenario_id);
      expect(metrics).toEqual(live);
    }
  });
});
