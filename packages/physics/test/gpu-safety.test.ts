// P1-6: evaluateSafety: one test per CONTRACTS §0.7 reason code, the allow / needs_approval / retry paths, and the
// demo's two headline checks (job-a onto r6 is denied for thermal headroom; job-a onto r7+r8 is allowed).
import { describe, expect, it } from 'vitest';
import { validatePayload, type ActionCommand, type ObservedSnapshot, type SafetyDecision } from '@dcos/contracts';
import { evaluateSafety, toObserved } from '../src/index.js';
import {
  REQUIRED_THERMAL_HEADROOM_C,
  SAFETY_LOOKAHEAD_S,
  SAFETY_REASON_CODES,
  type SafetyReasonCode,
} from '../src/gpu/safety.js';
import { deepFreeze, demoWorld, gpusOn, readFixture } from './gpu-helpers.js';

const DEMO = deepFreeze(readFixture<ObservedSnapshot>('observed_snapshot_demo.json'));
const DEGRADED = deepFreeze(readFixture<ObservedSnapshot>('observed_snapshot_pump_degraded.json'));
const clone = (s: ObservedSnapshot): ObservedSnapshot => structuredClone(s) as ObservedSnapshot;

let seq = 0;
function cmd(operation: ActionCommand['operation'], target: string, opts: Partial<ActionCommand> = {}, obs = DEMO): ActionCommand {
  seq += 1;
  return {
    schema_version: '1.1.0', run_id: 'run-demo-1', action_id: `act-${seq}`, command_key: `ck-${operation}-${seq}`,
    workflow_id: 'wf-1', plan_id: 'plan-1', incident_ids: ['inc-1'], operation, target_resource_id: target,
    job_id: null, arguments: {}, depends_on_command_keys: [], expected_decision_epoch: obs.clock.decision_epoch,
    expected_resource_versions: {}, requested_sim_time_ms: obs.clock.sim_time_ms, ...opts,
  };
}

const move = (job: string, args: Record<string, unknown>, opts: Partial<ActionCommand> = {}, obs = DEMO) =>
  cmd('migrate_restart', job, { job_id: job, arguments: args, ...opts }, obs);

/** Evaluate and assert the result is a valid SafetyDecision. */
function check(obs: ObservedSnapshot, c: ActionCommand, ctx: Partial<{ decision_epoch: number; leased_resource_ids: string[] }> = {}): SafetyDecision {
  const d = evaluateSafety(obs, c, { decision_epoch: obs.clock.decision_epoch, leased_resource_ids: [], ...ctx });
  expect(validatePayload('SafetyDecision', d)).toEqual({ ok: true });
  expect(d.checked_decision_epoch).toBe(obs.clock.decision_epoch);
  expect(d.action_id).toBe(c.action_id);
  // deterministic order: violations follow the frozen §0.7 order and never repeat
  const order = d.violations.map((v) => SAFETY_REASON_CODES.indexOf(v as SafetyReasonCode));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(new Set(d.violations).size).toBe(d.violations.length);
  return d;
}

const R7_R8 = gpusOn(7, 8);
const fires = (d: SafetyDecision, code: SafetyReasonCode) => expect(d.violations).toContain(code);

describe('evaluateSafety: demo headline checks', () => {
  it('denies job-a onto r6 (node-r6-n1) with DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT', () => {
    const d = check(DEMO, move('job-a', { destination_node_ids: ['node-r6-n1'] }));
    expect(d.decision).toBe('deny');
    expect(d.violations).toContain('DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT');
    expect(d.evidence.required_headroom_c).toBe(REQUIRED_THERMAL_HEADROOM_C);
    expect(d.evidence.available_headroom_c as number).toBeLessThan(REQUIRED_THERMAL_HEADROOM_C);
    expect(d.evidence.available_headroom_c).toBeCloseTo(2.9, 1); // r6 GPUs ≈82 °C at full load vs 85 °C slowdown
    expect(d.evidence.lookahead_s).toBe(SAFETY_LOOKAHEAD_S);
    expect(d.checked_resource_ids).toEqual(expect.arrayContaining(['job-a', 'node-r6-n1', 'rack-r6']));
  });

  it('denies a 16-GPU job-a set spanning r6 + r7 for thermal headroom too (explicit GPU ids)', () => {
    const d = check(DEMO, move('job-a', { destination_gpu_ids: [...gpusOn(6), ...gpusOn(7)] }));
    expect(d.decision).toBe('deny');
    expect(d.violations).toContain('DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT');
    const thermal = d.evidence.thermal as { rack_id: string; available_headroom_c: number }[];
    expect(thermal.find((t) => t.rack_id === 'rack-r6')!.available_headroom_c).toBeLessThan(REQUIRED_THERMAL_HEADROOM_C);
    expect(thermal.find((t) => t.rack_id === 'rack-r7')!.available_headroom_c).toBeGreaterThan(10);
  });

  it('allows job-a onto free racks r7 + r8 (explicit GPU ids)', () => {
    const d = check(DEMO, move('job-a', { destination_gpu_ids: R7_R8 }));
    expect(d).toMatchObject({ decision: 'allow', violations: [] });
    expect(d.evidence.available_headroom_c as number).toBeGreaterThanOrEqual(REQUIRED_THERMAL_HEADROOM_C);
    expect(d.checked_resource_ids).toEqual(expect.arrayContaining(['job-a', 'rack-r7', 'rack-r8', 'loop-b', 'pump-b', 'ckpt-store-1']));
  });

  it('allows job-a onto r7 + r8 by destination_node_ids (first free ready GPUs, as actions.ts)', () => {
    const d = check(DEMO, move('job-a', { destination_node_ids: ['node-r7-n1', 'node-r8-n1'] }));
    expect(d).toMatchObject({ decision: 'allow', violations: [] });
    expect(d.evidence.destination_gpu_ids).toEqual(R7_R8);
  });

  it('allows job-a onto r7 + r8 in the pump-degraded snapshot (loop-b is unaffected)', () => {
    const d = check(DEGRADED, move('job-a', { destination_gpu_ids: R7_R8 }, {}, DEGRADED));
    expect(d).toMatchObject({ decision: 'allow', violations: [] });
    const loops = d.evidence.cooling_loops as { loop_id: string; rise_c: number }[];
    expect(loops).toEqual([expect.objectContaining({ loop_id: 'loop-b', rise_c: 0 })]);
  });

  it('works on toObserved(buildPreset(...)) the same way as on the fixture', () => {
    const obs = toObserved(demoWorld());
    expect(check(obs, move('job-a', { destination_gpu_ids: R7_R8 }, {}, obs)).decision).toBe('allow');
    expect(check(obs, move('job-a', { destination_node_ids: ['node-r6-n1'] }, {}, obs)).violations).toContain('DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT');
  });
});

describe('evaluateSafety: one test per §0.7 reason code', () => {
  it('DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT: the 120 s look-ahead catches a failed pump on the destination loop', () => {
    const obs = clone(DEMO);
    // loop-b already 5 °C warm (inlet ≈40 °C) and pump-b failed: now r7 GPUs would sit at ≈75 °C (10 °C headroom),
    // but over 120 s the loop heats by ≈7 °C with job-a's 11.2 kW on it
    for (const g of obs.gpus) if (/^gpu-r[15678]-/.test(g.resource_id)) g.temp_c += 5;
    const pumpB = obs.cooling.find((c) => c.resource_id === 'pump-b')!;
    Object.assign(pumpB, { operating_state: 'failed', pump_power_w: 0, observed_capacity_estimate_w: 0 });
    const d = check(obs, move('job-a', { destination_gpu_ids: R7_R8 }));
    expect(d.decision).toBe('deny');
    expect(d.violations).toEqual(['DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT']);
    const loop = (d.evidence.cooling_loops as { rise_c: number; capacity_w: number }[])[0]!;
    expect(loop.capacity_w).toBe(0);
    expect(loop.rise_c).toBeGreaterThan(5);
  });

  it('DEST_POWER_HEADROOM_INSUFFICIENT: destination node reports too little power headroom', () => {
    const obs = clone(DEMO);
    obs.nodes.find((n) => n.resource_id === 'node-r7-n1')!.power_headroom_w = 1000;
    const d = check(obs, move('job-a', { destination_gpu_ids: R7_R8 }));
    expect(d.violations).toEqual(['DEST_POWER_HEADROOM_INSUFFICIENT']);
    expect(d.decision).toBe('deny');
    expect(d.evidence.power).toEqual(expect.arrayContaining([{ resource_id: 'node-r7-n1', required_w: 5040, available_w: 1000 }]));
  });

  it('DEST_POWER_HEADROOM_INSUFFICIENT: an optional power_budget_w on a rack or power domain is respected', () => {
    const obs = clone(DEMO);
    obs.resources.find((r) => r.resource_id === 'rack-r7')!.config.power_budget_w = 4000; // 8 × 700 W won't fit
    const d = check(obs, move('job-a', { destination_gpu_ids: R7_R8 }));
    expect(d.violations).toEqual(['DEST_POWER_HEADROOM_INSUFFICIENT']);
    expect(d.evidence.power).toEqual(expect.arrayContaining([{ resource_id: 'rack-r7', projected_draw_w: 5600, budget_w: 4000 }]));
    // a move inside one power domain only shifts load: job-a's old racks go idle, so 25 kW still fits
    const dom = clone(DEMO);
    dom.resources.find((r) => r.resource_id === 'power-main')!.config.power_budget_w = 25_000;
    expect(check(dom, move('job-a', { destination_gpu_ids: R7_R8 })).decision).toBe('allow');
    dom.resources.find((r) => r.resource_id === 'power-main')!.config.power_budget_w = 24_000;
    fires(check(dom, move('job-a', { destination_gpu_ids: R7_R8 })), 'DEST_POWER_HEADROOM_INSUFFICIENT');
  });

  it('DEST_GPU_UNHEALTHY: a destination GPU is unreachable', () => {
    const obs = clone(DEMO);
    obs.gpus.find((g) => g.resource_id === 'gpu-r7-n1-3')!.availability = 'unreachable';
    const d = check(obs, move('job-b', { destination_gpu_ids: gpusOn(7) }));
    expect(d.violations).toEqual(['DEST_GPU_UNHEALTHY']);
  });

  it('DEST_GPU_BUSY: destination GPUs belong to another job', () => {
    const d = check(DEMO, move('job-b', { destination_gpu_ids: gpusOn(2) }));
    expect(d.violations).toEqual(['DEST_GPU_BUSY']);
  });

  it('DEST_GPU_LEASED: a destination GPU is reserved by another action', () => {
    const d = check(DEMO, move('job-a', { destination_gpu_ids: R7_R8 }), { leased_resource_ids: ['gpu-r8-n1-5'] });
    expect(d.violations).toEqual(['DEST_GPU_LEASED']);
    expect(d.evidence.leased_destinations).toEqual(['gpu-r8-n1-5']);
  });

  it('DEST_GPU_COUNT_INSUFFICIENT: one free node cannot hold 16 GPUs', () => {
    const d = check(DEMO, move('job-a', { destination_node_ids: ['node-r7-n1'] }));
    expect(d.violations).toEqual(['DEST_GPU_COUNT_INSUFFICIENT']);
    expect(d.evidence.free_gpus_on_destination_nodes).toBe(8);
  });

  it('DEST_GPU_COUNT_INSUFFICIENT: an explicit set of the wrong size, or no destination at all', () => {
    fires(check(DEMO, move('job-a', { destination_gpu_ids: gpusOn(7) })), 'DEST_GPU_COUNT_INSUFFICIENT');
    fires(check(DEMO, move('job-a', {})), 'DEST_GPU_COUNT_INSUFFICIENT');
  });

  it('DEST_NOT_COMPATIBLE: a same_node job split across two nodes', () => {
    const d = check(DEMO, move('job-b', { destination_gpu_ids: [...gpusOn(7).slice(0, 4), ...gpusOn(8).slice(0, 4)] }));
    expect(d.violations).toEqual(['DEST_NOT_COMPATIBLE']);
  });

  it('DEST_NOT_COMPATIBLE: a node outside compatible_node_ids, or an id that is not a GPU', () => {
    const obs = clone(DEMO);
    obs.job_specs.find((s) => s.job_id === 'job-b')!.compatible_node_ids = ['node-r4-n1', 'node-r5-n1'];
    expect(check(obs, move('job-b', { destination_gpu_ids: gpusOn(7) })).violations).toEqual(['DEST_NOT_COMPATIBLE']);
    fires(check(DEMO, move('job-b', { destination_gpu_ids: [...gpusOn(7).slice(0, 7), 'rack-r7'] })), 'DEST_NOT_COMPATIBLE');
  });

  it('CHECKPOINT_NOT_ACCESSIBLE: checkpoint storage is down (checkpoint rows report accessible=false)', () => {
    const obs = clone(DEMO);
    for (const c of obs.checkpoints) c.accessible = false;
    const ck = check(obs, cmd('checkpoint', 'job-a', { job_id: 'job-a' }));
    expect(ck.violations).toEqual(['CHECKPOINT_NOT_ACCESSIBLE']);
    expect(check(obs, move('job-a', { destination_gpu_ids: R7_R8 })).violations).toEqual(['CHECKPOINT_NOT_ACCESSIBLE']);
  });

  it('NO_COMPLETED_CHECKPOINT: a voluntary move without a completed checkpoint or a checkpoint dependency', () => {
    const obs = clone(DEMO);
    const job = obs.job_states.find((j) => j.job_id === 'job-a')!;
    job.latest_checkpoint_id = null;
    obs.checkpoints = obs.checkpoints.filter((c) => c.job_id !== 'job-a');
    const d = check(obs, move('job-a', { destination_gpu_ids: R7_R8 }));
    expect(d).toMatchObject({ decision: 'deny', violations: ['NO_COMPLETED_CHECKPOINT'] });
  });

  it('JOB_NOT_PREEMPTIBLE: voluntary move or pause of non-preemptible job-c', () => {
    const obs = clone(DEMO);
    obs.job_specs.find((s) => s.job_id === 'job-c')!.compatible_node_ids = ['node-r6-n1', 'node-r7-n1'];
    fires(check(obs, move('job-c', { destination_gpu_ids: gpusOn(7) })), 'JOB_NOT_PREEMPTIBLE');
    expect(check(DEMO, cmd('pause_job', 'job-c', { job_id: 'job-c' })).violations).toEqual(['JOB_NOT_PREEMPTIBLE']);
  });

  it('CHECKPOINT_UNSUPPORTED: checkpoint of job-c (checkpoint_supported=false)', () => {
    const d = check(DEMO, cmd('checkpoint', 'job-c', { job_id: 'job-c' }));
    expect(d).toMatchObject({ decision: 'deny', violations: ['CHECKPOINT_UNSUPPORTED'] });
  });

  it('STALE_DECISION_EPOCH: command planned on an older epoch → retry_new_snapshot', () => {
    const d = check(DEGRADED, move('job-a', { destination_gpu_ids: R7_R8 }, { expected_decision_epoch: 0 }, DEGRADED));
    expect(d).toMatchObject({ decision: 'retry_new_snapshot', violations: ['STALE_DECISION_EPOCH'] });
    expect(d.evidence.decision_epoch).toEqual({ snapshot: 1, current: 1, expected: 0 });
  });

  it('STALE_DECISION_EPOCH: the snapshot itself is behind the current run epoch', () => {
    const d = check(DEMO, cmd('keep_running', 'job-b', { job_id: 'job-b' }), { decision_epoch: 3 });
    expect(d).toMatchObject({ decision: 'retry_new_snapshot', violations: ['STALE_DECISION_EPOCH'] });
  });

  it('STALE_RESOURCE_VERSION: an expected version differs, or names an unknown resource → retry_new_snapshot', () => {
    const d = check(DEMO, cmd('checkpoint', 'job-a', {
      job_id: 'job-a', expected_resource_versions: { 'job-a': 4, 'node-r2-n1': 0, 'ckpt-store-1': 2, 'checkpoint-store-1': 2 },
    }));
    expect(d).toMatchObject({ decision: 'retry_new_snapshot', violations: ['STALE_RESOURCE_VERSION'] });
    expect(d.evidence.stale_resource_versions).toEqual([
      { resource_id: 'checkpoint-store-1', expected: 2, observed: null },
      { resource_id: 'job-a', expected: 4, observed: 0 },
    ]);
    expect(d.evidence.unversioned_resource_ids).toEqual(['ckpt-store-1']);
  });

  it('CONFLICTING_ACTION: the job is leased by another action', () => {
    const d = check(DEMO, move('job-a', { destination_gpu_ids: R7_R8 }), { leased_resource_ids: ['job-a'] });
    expect(d.violations).toEqual(['CONFLICTING_ACTION']);
  });

  it('CONFLICTING_ACTION: the job is already checkpointing for some other command', () => {
    const obs = clone(DEMO);
    obs.job_states.find((j) => j.job_id === 'job-b')!.status = 'checkpointing';
    obs.checkpoints.push({ ...obs.checkpoints[1]!, checkpoint_id: 'ckpt-job-b-2', status: 'writing', complete_sim_time_ms: null, command_key: 'ck-other' });
    expect(check(obs, cmd('pause_job', 'job-b', { job_id: 'job-b' })).violations).toEqual(['CONFLICTING_ACTION']);
  });

  it('EVIDENCE_STALE: destination telemetry older than the max age → needs_approval', () => {
    const obs = clone(DEGRADED);
    for (const g of obs.gpus) if (g.node_id === 'node-r8-n1') g.last_seen_sim_ms = obs.clock.sim_time_ms - 30_000;
    const d = check(obs, move('job-a', { destination_gpu_ids: R7_R8 }, {}, obs));
    expect(d).toMatchObject({ decision: 'needs_approval', violations: ['EVIDENCE_STALE'] });
    expect(d.evidence.stale_evidence_ids).toEqual(gpusOn(8));
  });

  it('UNSUPPORTED_OPERATION: an operation outside the contract enum, or a checkpoint of a completed job', () => {
    const bogus = { ...cmd('keep_running', 'node-r3-n1'), operation: 'reboot_node' } as unknown as ActionCommand;
    expect(check(DEMO, bogus)).toMatchObject({ decision: 'deny', violations: ['UNSUPPORTED_OPERATION'] });
    const obs = clone(DEMO);
    obs.job_states.find((j) => j.job_id === 'job-b')!.status = 'completed';
    expect(check(obs, cmd('checkpoint', 'job-b', { job_id: 'job-b' })).violations).toEqual(['UNSUPPORTED_OPERATION']);
  });

  it('UNSUPPORTED_OPERATION: unknown job, cordon of a non-GPU, invalid power limit', () => {
    expect(check(DEMO, cmd('pause_job', 'job-zzz', { job_id: 'job-zzz' })).violations).toEqual(['UNSUPPORTED_OPERATION']);
    expect(check(DEMO, cmd('cordon_gpu', 'pump-a')).violations).toEqual(['UNSUPPORTED_OPERATION']);
    expect(check(DEMO, cmd('power_cap', 'job-b', { job_id: 'job-b', arguments: { power_limit_w: 900 } })).violations).toEqual(['UNSUPPORTED_OPERATION']);
  });

  it('CORDON_IS_NOT_REPAIR: uncordoning a GPU that reported XID 48 does not repair it', () => {
    const obs = clone(DEMO);
    Object.assign(obs.gpus.find((g) => g.resource_id === 'gpu-r3-n1-0')!, { availability: 'cordoned', last_xid_code: 48 });
    const d = check(obs, cmd('uncordon_gpu', 'gpu-r3-n1-0'));
    expect(d).toMatchObject({ decision: 'deny', violations: ['CORDON_IS_NOT_REPAIR'] });
  });

  it('REAL_GPU_NOT_ALLOCATABLE: gpu-real-0 as a destination, or as a cordon target', () => {
    const d = check(DEMO, move('job-b', { destination_gpu_ids: [...gpusOn(7).slice(0, 7), 'gpu-real-0'] }));
    expect(d.violations).toEqual(['REAL_GPU_NOT_ALLOCATABLE']);
    expect(check(DEMO, cmd('cordon_gpu', 'gpu-real-0')).violations).toEqual(['REAL_GPU_NOT_ALLOCATABLE']);
  });

  it('covers every frozen code exactly once in SAFETY_REASON_CODES', () => {
    expect(SAFETY_REASON_CODES).toHaveLength(18);
    expect(new Set(SAFETY_REASON_CODES).size).toBe(18);
  });
});

describe('evaluateSafety: allow, needs_approval and precedence rules', () => {
  it('allows the non-disruptive operations on the demo snapshot', () => {
    for (const c of [
      cmd('checkpoint', 'job-a', { job_id: 'job-a' }),
      cmd('power_cap', 'job-b', { job_id: 'job-b', arguments: { power_limit_w: 500 } }),
      cmd('power_cap', 'node-r4-n1'),
      cmd('keep_running', 'job-b', { job_id: 'job-b' }),
      cmd('cordon_gpu', 'gpu-r3-n1-0'),
      cmd('uncordon_gpu', 'gpu-r5-n1-0'),
      cmd('pause_job', 'job-b', { job_id: 'job-b' }),
      cmd('escalate', 'job-a', { job_id: 'job-a' }),
    ]) {
      expect(check(DEMO, c), c.operation).toMatchObject({ decision: 'allow', violations: [] });
    }
  });

  it('a checkpoint dependency satisfies NO_COMPLETED_CHECKPOINT for the following migrate', () => {
    const obs = clone(DEMO);
    obs.job_states.find((j) => j.job_id === 'job-a')!.latest_checkpoint_id = null;
    obs.checkpoints = obs.checkpoints.filter((c) => c.job_id !== 'job-a');
    // (a) checkpoint requested but not started yet: no row with that key
    const pending = check(obs, move('job-a', { destination_gpu_ids: R7_R8 }, { depends_on_command_keys: ['ck-ckpt-a'] }));
    expect(pending).toMatchObject({ decision: 'allow', violations: [] });
    expect((pending.evidence.checkpoint as { satisfied_by_dependency: string }).satisfied_by_dependency).toBe('ck-ckpt-a');
    // (b) checkpoint writing: the job is checkpointing for our dependency, and its lease on job-a is tolerated
    obs.job_states.find((j) => j.job_id === 'job-a')!.status = 'checkpointing';
    obs.checkpoints.push({
      schema_version: '1.1.0', run_id: 'run-demo-1', checkpoint_id: 'ckpt-job-a-2', job_id: 'job-a', storage_resource_id: 'ckpt-store-1',
      status: 'writing', progress_work_units: 95040, requested_sim_time_ms: 0, complete_sim_time_ms: null, accessible: true, command_key: 'ck-ckpt-a',
    });
    const writing = check(obs, move('job-a', { destination_gpu_ids: R7_R8 }, { depends_on_command_keys: ['ck-ckpt-a'] }), { leased_resource_ids: ['job-a'] });
    expect(writing).toMatchObject({ decision: 'allow', violations: [] });
    // (c) a dependency whose checkpoint already failed does not count
    obs.checkpoints.find((c) => c.command_key === 'ck-ckpt-a')!.status = 'failed';
    obs.job_states.find((j) => j.job_id === 'job-a')!.status = 'running';
    fires(check(obs, move('job-a', { destination_gpu_ids: R7_R8 }, { depends_on_command_keys: ['ck-ckpt-a'] })), 'NO_COMPLETED_CHECKPOINT');
  });

  it('restarting a FAILED job elsewhere is recovery: no preemptibility or new-checkpoint requirement', () => {
    const obs = clone(DEMO);
    const job = obs.job_states.find((j) => j.job_id === 'job-a')!;
    Object.assign(job, { status: 'failed', allocated_gpu_ids: [], progress_work_units: job.durable_work_units });
    obs.allocations = obs.allocations.filter((a) => a.job_id !== 'job-a');
    obs.job_specs.find((s) => s.job_id === 'job-a')!.preemptible = false;
    expect(check(obs, move('job-a', { destination_gpu_ids: R7_R8 }))).toMatchObject({ decision: 'allow', violations: [] });
  });

  it('a disruptive move of a high-priority job needs approval', () => {
    const obs = clone(DEMO);
    obs.job_specs.find((s) => s.job_id === 'job-a')!.priority = 90;
    const d = check(obs, move('job-a', { destination_gpu_ids: R7_R8 }));
    expect(d).toMatchObject({ decision: 'needs_approval', violations: [] });
    expect(d.evidence.approval_reasons).toEqual(['HIGH_PRIORITY_JOB_DISRUPTION']);
  });

  it('hard violations dominate staleness (deny, both codes listed in §0.7 order)', () => {
    const d = check(DEMO, move('job-a', { destination_node_ids: ['node-r6-n1'] }, { expected_decision_epoch: 7 }));
    expect(d.decision).toBe('deny');
    expect(d.violations).toEqual([
      'DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT', 'DEST_GPU_BUSY', 'DEST_GPU_COUNT_INSUFFICIENT', 'STALE_DECISION_EPOCH',
    ]);
  });

  it('staleness dominates stale evidence (retry_new_snapshot)', () => {
    const obs = clone(DEGRADED);
    for (const g of obs.gpus) if (g.node_id === 'node-r8-n1') g.last_seen_sim_ms = 0;
    const d = check(obs, move('job-a', { destination_gpu_ids: R7_R8 }, { expected_decision_epoch: 0 }, obs));
    expect(d).toMatchObject({ decision: 'retry_new_snapshot', violations: ['STALE_DECISION_EPOCH', 'EVIDENCE_STALE'] });
  });

  it('escalate is always allowed, even on a stale epoch', () => {
    expect(check(DEMO, cmd('escalate', 'job-a', { expected_decision_epoch: 9 }), { decision_epoch: 9 })).toMatchObject({ decision: 'allow', violations: [] });
  });

  it('is pure and deterministic: frozen input, identical output', () => {
    const c = deepFreeze(move('job-a', { destination_node_ids: ['node-r6-n1'] }));
    const ctx = deepFreeze({ decision_epoch: 0, leased_resource_ids: ['gpu-r6-n1-0'] });
    const a = evaluateSafety(DEMO, c, ctx);
    const b = evaluateSafety(DEMO, c, ctx);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

