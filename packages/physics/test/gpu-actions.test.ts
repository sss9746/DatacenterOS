// P1-5: actions inside step(): checkpoint, migrate_restart, power_cap, pause_job, cordon_gpu, keep_running, escalate.
import { describe, expect, it } from 'vitest';
import { validatePayload, type ActionCommand, type ActionStatus, type ObservedSnapshot, type PhysicsTickResult, type PhysicsWorld } from '@dcos/contracts';
import { commandOutcome, enqueueCommands, inFlightCommands, step } from '../src/index.js';
import { T0, demoWorld, fault, gpusOn, runUntil, tickInput, type RunOpts } from './gpu-helpers.js';

let seq = 0;
function cmd(operation: ActionCommand['operation'], target: string, opts: Partial<ActionCommand> = {}): ActionCommand {
  seq += 1;
  const c: ActionCommand = {
    schema_version: '1.1.0', run_id: 'run-demo-1', action_id: `act-${seq}`, command_key: `ck-${operation}-${seq}`,
    workflow_id: 'wf-1', plan_id: 'plan-1', incident_ids: ['inc-1'], operation, target_resource_id: target,
    job_id: null, arguments: {}, depends_on_command_keys: [], expected_decision_epoch: 0,
    expected_resource_versions: {}, requested_sim_time_ms: T0, ...opts,
  };
  expect(validatePayload('ActionCommand', c)).toEqual({ ok: true });
  return c;
}

const job = (s: ObservedSnapshot, id: string) => s.job_states.find((j) => j.job_id === id)!;
const gpu = (s: ObservedSnapshot, id: string) => s.gpus.find((g) => g.resource_id === id)!;
// Times in run() / at() are OFFSETS from the run start T0 (CONTRACTS §0.12 #2); absolute sim times are written T0 + x.
const at = (results: PhysicsTickResult[], ms: number) => results.find((r) => r.world_after.observable.clock.sim_time_ms === T0 + ms)!;

/** Enqueue commands up front and request each on the tick ending at its time; validates every tick result. */
function run(untilMs: number, schedule: [number, ActionCommand][], opts: RunOpts = {}, world: PhysicsWorld = demoWorld()) {
  const requestAt: Record<number, string[]> = {};
  for (const [t, c] of schedule) (requestAt[T0 + t] ??= []).push(c.action_id);
  const out = runUntil(enqueueCommands(world, schedule.map(([, c]) => c)), T0 + untilMs, { ...opts, requestAt });
  for (const r of out.results) expect(validatePayload('PhysicsTickResult', r)).toEqual({ ok: true });
  return out;
}

describe('checkpoint', () => {
  const ck = cmd('checkpoint', 'job-b', { job_id: 'job-b' });
  const { results, world } = run(52_000, [[20_000, ck]]);

  it('starts writing at 20 s and is NOT durable mid-write', () => {
    const s20 = at(results, 20_000).world_after.observable;
    const row = s20.checkpoints.find((c) => c.command_key === ck.command_key)!;
    expect(row).toMatchObject({ checkpoint_id: 'ckpt-job-b-2', status: 'writing', requested_sim_time_ms: T0 + 20_000, complete_sim_time_ms: null });
    expect(row.progress_work_units).toBe(40_480 + 8 * 20);
    expect(job(s20, 'job-b')).toMatchObject({ status: 'checkpointing', durable_work_units: 40_000, latest_checkpoint_id: 'ckpt-job-b-1' });
    for (let t = 20_000; t < 50_000; t += 1000) {
      const r = at(results, t);
      expect(r.completed_command_keys).toEqual([]);
      expect(job(r.world_after.observable, 'job-b').durable_work_units).toBe(40_000);
    }
    expect(at(results, 20_000).material_change).toBe(true);
    expect(inFlightCommands(at(results, 30_000).world_after)).toEqual([
      expect.objectContaining({ command_key: ck.command_key, started_sim_ms: T0 + 20_000, due_sim_time_ms: T0 + 50_000 }),
    ]);
  });

  it('completes 30 s later: durable = progress at start, job running again', () => {
    const r50 = at(results, 50_000);
    expect(r50.completed_command_keys).toEqual([ck.command_key]);
    const s = r50.world_after.observable;
    expect(job(s, 'job-b')).toMatchObject({ status: 'running', durable_work_units: 40_640, latest_checkpoint_id: 'ckpt-job-b-2' });
    expect(job(s, 'job-b').progress_work_units).toBe(40_640); // no training progress during the synchronous write
    expect(s.checkpoints.find((c) => c.checkpoint_id === 'ckpt-job-b-2')).toMatchObject({ status: 'complete', complete_sim_time_ms: T0 + 50_000, accessible: true });
    expect(job(world.observable, 'job-b').progress_work_units).toBe(40_640 + 8 * 2);
    // CONTRACTS §0.12 #4 shape: { status, reason_code? }
    expect(commandOutcome(world, ck.command_key)).toEqual({ status: 'succeeded' });
    expect(commandOutcome(at(results, 30_000).world_after, ck.command_key)).toEqual({ status: 'running' });
  });

  it('an XID mid-write fails the job and the checkpoint never becomes durable', () => {
    const c = cmd('checkpoint', 'job-a', { job_id: 'job-a' });
    const { results: rs } = run(60_000, [[20_000, c]], { faults: [fault('gpu_xid_79', 'gpu-r2-n1-5', T0 + 35_000)] });
    const r35 = at(rs, 35_000);
    expect(r35.failed_command_keys).toEqual([c.command_key]);
    const s = r35.world_after.observable;
    expect(job(s, 'job-a')).toMatchObject({ status: 'failed', durable_work_units: 86_400, progress_work_units: 86_400, latest_checkpoint_id: 'ckpt-job-a-1' });
    expect(s.checkpoints.find((x) => x.command_key === c.command_key)?.status).toBe('failed');
    expect(rs.flatMap((r) => r.completed_command_keys)).toEqual([]);
    expect(commandOutcome(rs.at(-1)!.world_after, c.command_key)?.reason_code).toBe('JOB_FAILED_DURING_OPERATION');
  });

  it('storage lost mid-write: the write fails at completion, durable unchanged, job keeps running', () => {
    const c = cmd('checkpoint', 'job-b', { job_id: 'job-b' });
    const { results: rs } = run(51_000, [[20_000, c]], { faults: [fault('network_link_down', 'ckpt-store-1', T0 + 30_000)] });
    expect(at(rs, 30_000).world_after.observable.checkpoints.every((x) => !x.accessible)).toBe(true);
    const r50 = at(rs, 50_000);
    expect(r50.failed_command_keys).toEqual([c.command_key]);
    expect(job(r50.world_after.observable, 'job-b')).toMatchObject({ status: 'running', durable_work_units: 40_000, latest_checkpoint_id: 'ckpt-job-b-1' });
    expect(commandOutcome(r50.world_after, c.command_key)?.reason_code).toBe('CHECKPOINT_NOT_ACCESSIBLE');
  });

  it('cannot start while storage is down, or on a job without checkpoint support', () => {
    const down = cmd('checkpoint', 'job-b', { job_id: 'job-b' });
    const noCk = cmd('checkpoint', 'job-c', { job_id: 'job-c' });
    const { results: rs } = run(21_000, [[20_000, down], [20_000, noCk]], { faults: [fault('node_crash', 'ckpt-store-1', T0 + 5_000)] });
    const r20 = at(rs, 20_000);
    expect(r20.failed_command_keys).toEqual([down.command_key, noCk.command_key]);
    expect(commandOutcome(r20.world_after, down.command_key)?.reason_code).toBe('CHECKPOINT_NOT_ACCESSIBLE');
    expect(commandOutcome(r20.world_after, noCk.command_key)?.reason_code).toBe('CHECKPOINT_UNSUPPORTED');
  });
});

describe('migrate_restart', () => {
  it('a migration onto busy GPUs fails atomically: nothing moves', () => {
    const busy = [...gpusOn(4), ...gpusOn(5)]; // r4 runs job-b
    const m = cmd('migrate_restart', 'job-a', { job_id: 'job-a', arguments: { destination_gpu_ids: busy } });
    const { results } = run(21_000, [[20_000, m]]);
    const before = at(results, 19_000).world_after.observable;
    const r20 = at(results, 20_000);
    const s = r20.world_after.observable;
    expect(r20.failed_command_keys).toEqual([m.command_key]);
    expect(commandOutcome(r20.world_after, m.command_key)?.reason_code).toBe('DEST_GPU_BUSY');
    expect(s.allocations).toEqual(before.allocations);
    expect(job(s, 'job-a')).toMatchObject({ status: 'running', allocated_gpu_ids: gpusOn(2, 3) });
    expect(job(s, 'job-a').progress_work_units).toBe(job(before, 'job-a').progress_work_units + 16);
    expect(job(s, 'job-b').allocated_gpu_ids).toEqual(gpusOn(4));
    expect(r20.material_change).toBe(false);
  });

  it('rejects unhealthy, cordoned, real, incompatible or wrongly sized destinations, all atomically', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['real gpu', { destination_gpu_ids: [...gpusOn(7), ...gpusOn(8).slice(0, 7), 'gpu-real-0'] }, 'REAL_GPU_NOT_ALLOCATABLE'],
      ['real node', { destination_node_ids: ['node-r7-n1', 'node-r8-n1', 'node-real-0'] }, 'REAL_GPU_NOT_ALLOCATABLE'],
      ['xid gpu', { destination_gpu_ids: [...gpusOn(7), ...gpusOn(8).slice(1), 'gpu-r1-n1-0'] }, 'DEST_GPU_UNHEALTHY'],
      ['too few', { destination_gpu_ids: gpusOn(7) }, 'DEST_GPU_COUNT_INSUFFICIENT'],
      ['no free nodes', { destination_node_ids: ['node-r4-n1', 'node-r6-n1'] }, 'DEST_GPU_COUNT_INSUFFICIENT'],
    ];
    const schedule = cases.map(([, args]) => [20_000, cmd('migrate_restart', 'job-a', { job_id: 'job-a', arguments: args })] as [number, ActionCommand]);
    const cordon = cmd('cordon_gpu', 'gpu-r8-n1-7');
    const cordoned = cmd('migrate_restart', 'job-a', { job_id: 'job-a', arguments: { destination_gpu_ids: gpusOn(7, 8) } });
    const jobC = cmd('migrate_restart', 'job-c', { job_id: 'job-c', arguments: { destination_gpu_ids: gpusOn(7) } });
    const { results } = run(23_000, [[10_000, cordon], ...schedule, [22_000, cordoned], [22_000, jobC]], {
      faults: [fault('gpu_xid_79', 'gpu-r1-n1-0', T0 + 5_000)],
    });
    const w = results.at(-1)!.world_after;
    cases.forEach(([name, , reason], i) => expect(commandOutcome(w, schedule[i]![1].command_key)?.reason_code, name).toBe(reason));
    expect(commandOutcome(w, cordoned.command_key)?.reason_code).toBe('DEST_GPU_UNHEALTHY');
    expect(commandOutcome(w, jobC.command_key)?.reason_code).toBe('DEST_NOT_COMPATIBLE'); // job-c may only run on r6
    expect(job(w.observable, 'job-a').allocated_gpu_ids).toEqual(gpusOn(2, 3));
  });

  it('checkpoint then move: allocates the whole destination at once, restarts for 120 s, then runs', () => {
    const ck = cmd('checkpoint', 'job-a', { job_id: 'job-a' });
    const mv = cmd('migrate_restart', 'job-a', {
      job_id: 'job-a', depends_on_command_keys: [ck.command_key], arguments: { destination_node_ids: ['node-r7-n1', 'node-r8-n1'] },
    });
    const { results, world } = run(175_000, [[20_000, ck], [51_000, mv]]);
    expect(at(results, 50_000).completed_command_keys).toEqual([ck.command_key]);
    const durable = 95_040 + 16 * 20;
    const s51 = at(results, 51_000).world_after.observable;
    expect(job(s51, 'job-a')).toMatchObject({ status: 'restarting', allocated_gpu_ids: gpusOn(7, 8), progress_work_units: durable, durable_work_units: durable });
    expect(s51.allocations.filter((a) => a.job_id === 'job-a').map((a) => [a.gpu_id, a.since_sim_time_ms]))
      .toEqual(gpusOn(7, 8).map((g) => [g, T0 + 51_000]));
    for (let t = 51_000; t < 171_000; t += 1000) expect(at(results, t).completed_command_keys).toEqual([]);
    const r171 = at(results, 171_000);
    expect(r171.completed_command_keys).toEqual([mv.command_key]);
    expect(job(r171.world_after.observable, 'job-a')).toMatchObject({ status: 'running', progress_work_units: durable });
    expect(job(world.observable, 'job-a').progress_work_units).toBe(durable + 16 * 4);
    // the old placement is free and idle
    expect(world.observable.gpus.filter((g) => gpusOn(2, 3).includes(g.resource_id)).every((g) => g.power_w < 100)).toBe(true);
  });

  it('a GPU lost during the restart fails the job and the migration', () => {
    const mv = cmd('migrate_restart', 'job-a', { job_id: 'job-a', arguments: { destination_gpu_ids: gpusOn(7, 8) } });
    const { results } = run(100_000, [[20_000, mv]], { faults: [fault('gpu_xid_79', 'gpu-r7-n1-3', T0 + 60_000)] });
    const r60 = at(results, 60_000);
    expect(r60.failed_command_keys).toEqual([mv.command_key]);
    expect(job(r60.world_after.observable, 'job-a')).toMatchObject({ status: 'failed', allocated_gpu_ids: [] });
  });

  it('restarts a job that failed from an XID onto free GPUs, from its durable checkpoint', () => {
    const mv = cmd('migrate_restart', 'job-a', { job_id: 'job-a', arguments: { destination_gpu_ids: gpusOn(5, 7) } });
    const { results } = run(30_000 + 121_000, [[30_000, mv]], { faults: [fault('gpu_xid_79', 'gpu-r3-n1-0', T0 + 15_000)] });
    expect(job(at(results, 15_000).world_after.observable, 'job-a').status).toBe('failed');
    expect(at(results, 150_000).completed_command_keys).toEqual([mv.command_key]);
    expect(job(at(results, 150_000).world_after.observable, 'job-a')).toMatchObject({ status: 'running', progress_work_units: 86_400 });
  });
});

describe('power_cap, pause_job, keep_running, escalate', () => {
  it('power_cap takes effect on the next tick: 500 W, SM clock −15%, cooler GPUs, slower job', () => {
    const cap = cmd('power_cap', 'job-b', { job_id: 'job-b', arguments: { power_limit_w: 500 } });
    const { results } = run(13_000, [[10_000, cap]]);
    const s10 = at(results, 10_000).world_after.observable;
    expect(at(results, 10_000).completed_command_keys).toEqual([]);
    expect(gpu(s10, 'gpu-r4-n1-0').power_limit_w).toBe(700);
    const r11 = at(results, 11_000);
    expect(r11.completed_command_keys).toEqual([cap.command_key]);
    expect(r11.material_change).toBe(true);
    const s11 = r11.world_after.observable;
    const g = gpu(s11, 'gpu-r4-n1-0');
    expect(g).toMatchObject({ power_limit_w: 500, power_w: 500, sm_clock_mhz: 1683, clocks_event_reasons: 0x4, version: 1 });
    expect(g.temp_c).toBeCloseTo(gpu(s10, 'gpu-r4-n1-0').temp_c - 10, 1);
    const p = (t: number) => job(at(results, t).world_after.observable, 'job-b').progress_work_units;
    expect(p(13_000) - p(12_000)).toBeCloseTo(8 * 0.85, 10);
  });

  it('pause_job stops progress (GPUs stay allocated); keep_running resumes it', () => {
    const pause = cmd('pause_job', 'job-b', { job_id: 'job-b' });
    const keep = cmd('keep_running', 'job-b', { job_id: 'job-b' });
    const { results } = run(26_000, [[10_000, pause], [20_000, keep]]);
    const p = (t: number) => job(at(results, t).world_after.observable, 'job-b');
    expect(p(11_000).status).toBe('paused');
    expect(p(19_000).progress_work_units).toBe(p(12_000).progress_work_units);
    expect(p(19_000).allocated_gpu_ids).toEqual(gpusOn(4));
    expect(at(results, 21_000).completed_command_keys).toEqual([keep.command_key]);
    expect(p(21_000).status).toBe('running');
    expect(p(26_000).progress_work_units - p(21_000).progress_work_units).toBe(8 * 5);
  });

  it('escalate and keep_running on a running job complete next tick and change nothing physical', () => {
    const esc = cmd('escalate', 'pump-a', { arguments: { reason: 'pump alarm' } });
    const keep = cmd('keep_running', 'job-a', { job_id: 'job-a' });
    const { results } = run(12_000, [[10_000, esc], [10_000, keep]]);
    expect(at(results, 10_000).completed_command_keys).toEqual([]);
    expect(at(results, 11_000).completed_command_keys).toEqual([esc.command_key, keep.command_key].sort());
    expect(results.every((r) => !r.material_change)).toBe(true);
  });
});

describe('cordon_gpu', () => {
  it('cordons a healthy GPU (cordoned, never ready) without stopping its job', () => {
    const c = cmd('cordon_gpu', 'gpu-r4-n1-2');
    const { results, world } = run(15_000, [[10_000, c]]);
    expect(at(results, 11_000).completed_command_keys).toEqual([c.command_key]);
    expect(gpu(world.observable, 'gpu-r4-n1-2').availability).toBe('cordoned');
    expect(job(world.observable, 'job-b').status).toBe('running');
  });

  it('never marks a failed GPU healthy: cordon keeps XID 79 unreachable, uncordon leaves XID 48 degraded', () => {
    const c79 = cmd('cordon_gpu', 'gpu-r3-n1-0');
    const c48 = cmd('cordon_gpu', 'gpu-r5-n1-1');
    const un79 = cmd('uncordon_gpu', 'gpu-r3-n1-0');
    const un48 = cmd('uncordon_gpu', 'gpu-r5-n1-1');
    const { results } = run(40_000, [[10_000, c79], [10_000, c48], [20_000, un79], [20_000, un48]], {
      faults: [fault('gpu_xid_79', 'gpu-r3-n1-0', T0 + 5_000), fault('gpu_xid_48', 'gpu-r5-n1-1', T0 + 5_000)],
    });
    for (const r of results.filter((x) => x.world_after.observable.clock.sim_time_ms >= T0 + 5_000)) {
      const s = r.world_after.observable;
      expect(gpu(s, 'gpu-r3-n1-0').availability).toBe('unreachable');
      expect(gpu(s, 'gpu-r5-n1-1').availability).not.toBe('ready');
      expect(gpu(s, 'gpu-r3-n1-0').last_xid_code).toBe(79);
    }
    expect(gpu(at(results, 15_000).world_after.observable, 'gpu-r5-n1-1').availability).toBe('cordoned');
    expect(gpu(at(results, 25_000).world_after.observable, 'gpu-r5-n1-1').availability).toBe('degraded');
    expect([...at(results, 11_000).completed_command_keys].sort()).toEqual([c79.command_key, c48.command_key].sort());
  });

  it('rejects the real GPU / node and unknown targets', () => {
    const real = cmd('cordon_gpu', 'gpu-real-0');
    const none = cmd('cordon_gpu', 'gpu-r9-n1-0');
    const realNode = cmd('cordon_gpu', 'node-real-0');
    const capNode = cmd('power_cap', 'node-real-0', { arguments: { power_limit_w: 500 } });
    const { results } = run(11_000, [[10_000, real], [10_000, none], [10_000, realNode], [10_000, capNode]]);
    const w = at(results, 10_000).world_after;
    expect(commandOutcome(w, real.command_key)?.reason_code).toBe('REAL_GPU_NOT_ALLOCATABLE');
    expect(commandOutcome(w, none.command_key)?.reason_code).toBe('TARGET_NOT_FOUND');
    expect(commandOutcome(w, realNode.command_key)?.reason_code).toBe('REAL_GPU_NOT_ALLOCATABLE');
    expect(commandOutcome(w, capNode.command_key)?.reason_code).toBe('REAL_GPU_NOT_ALLOCATABLE');
  });
});

describe('commandOutcome / inFlightCommands (CONTRACTS §0.12 #4 / #5, frozen)', () => {
  it('commandOutcome is null before the start, running in flight, then succeeded / failed + reason_code', () => {
    const ck = cmd('checkpoint', 'job-b', { job_id: 'job-b' });
    const bad = cmd('pause_job', 'job-zzz', { job_id: 'job-zzz' });
    const { results } = run(52_000, [[20_000, ck], [20_000, bad]]);
    expect(commandOutcome(at(results, 19_000).world_after, ck.command_key)).toBeNull(); // enqueued, not requested yet
    expect(commandOutcome(at(results, 19_000).world_after, 'ck-never-seen')).toBeNull();
    expect(commandOutcome(at(results, 20_000).world_after, ck.command_key)).toEqual({ status: 'running' });
    expect(commandOutcome(at(results, 49_000).world_after, ck.command_key)).toEqual({ status: 'running' });
    expect(commandOutcome(at(results, 50_000).world_after, ck.command_key)).toEqual({ status: 'succeeded' });
    expect(commandOutcome(at(results, 20_000).world_after, bad.command_key)).toEqual({ status: 'failed', reason_code: 'JOB_NOT_FOUND' });
    // every status is an ActionStatus value
    const statuses: ActionStatus['status'][] = ['running', 'succeeded', 'failed'];
    for (const r of results) {
      for (const k of [ck.command_key, bad.command_key]) {
        const o = commandOutcome(r.world_after, k);
        if (o) expect(statuses).toContain(o.status);
        if (o && o.status !== 'failed') expect(o).not.toHaveProperty('reason_code');
      }
    }
  });

  it('inFlightCommands returns at least { command_key, due_sim_time_ms } per running command', () => {
    const ck = cmd('checkpoint', 'job-a', { job_id: 'job-a' });
    const mv = cmd('migrate_restart', 'job-b', { job_id: 'job-b', arguments: { destination_gpu_ids: gpusOn(7) } });
    const cap = cmd('power_cap', 'job-c', { job_id: 'job-c', arguments: { power_limit_w: 500 } });
    const { results } = run(21_000, [[20_000, ck], [20_000, mv], [20_000, cap]]);
    const flights = inFlightCommands(at(results, 20_000).world_after);
    for (const f of flights) {
      expect(typeof f.command_key).toBe('string');
      expect(Number.isInteger(f.due_sim_time_ms)).toBe(true);
    }
    const due = Object.fromEntries(flights.map((f) => [f.command_key, f.due_sim_time_ms]));
    // §0.12 #5: checkpoint = start + 30 s, migrate_restart = start + 120 s, everything else = the next tick
    expect(due).toEqual({ [ck.command_key]: T0 + 50_000, [mv.command_key]: T0 + 140_000, [cap.command_key]: T0 + 21_000 });
    expect(inFlightCommands(at(results, 21_000).world_after).map((f) => f.command_key).sort()).toEqual([ck.command_key, mv.command_key].sort());
  });
});

describe('§0.11 #1 arguments and the §0.12 #4 physics reason codes', () => {
  it('INVALID_ARGUMENT: wrong names or types never start (same rule as evaluateSafety)', () => {
    const bad = [
      cmd('checkpoint', 'job-b', { job_id: 'job-b', arguments: { reason: 'x' } }),
      cmd('power_cap', 'job-b', { job_id: 'job-b', arguments: { power_limit_w: 900 } }),
      cmd('power_cap', 'job-b', { job_id: 'job-b', arguments: { limit_w: 500 } }),
      cmd('migrate_restart', 'job-b', { job_id: 'job-b', arguments: {} }),
      cmd('migrate_restart', 'job-b', { job_id: 'job-b', arguments: { destination_gpu_ids: gpusOn(7), destination_node_ids: ['node-r7-n1'] } }),
      cmd('escalate', 'pump-a'),
      cmd('cordon_gpu', 'gpu-r1-n1-0', { arguments: { xid_code: 79 } }),
    ];
    const { results } = run(21_000, bad.map((c) => [20_000, c] as [number, ActionCommand]));
    const w = at(results, 20_000).world_after;
    for (const c of bad) expect(commandOutcome(w, c.command_key), c.command_key).toEqual({ status: 'failed', reason_code: 'INVALID_ARGUMENT' });
    expect(job(w.observable, 'job-b')).toMatchObject({ status: 'running', allocated_gpu_ids: gpusOn(4) });
  });

  it('JOB_NOT_FOUND, JOB_STATE_INVALID, TARGET_NOT_FOUND', () => {
    const noJob = cmd('checkpoint', 'job-zzz', { job_id: 'job-zzz' });
    const pauseTwice = cmd('pause_job', 'job-b', { job_id: 'job-b' });
    const pause = cmd('pause_job', 'job-b', { job_id: 'job-b' });
    const capDead = cmd('power_cap', 'job-a', { job_id: 'job-a', arguments: { power_limit_w: 500 } });
    const capNothing = cmd('power_cap', 'rack-zz', { arguments: { power_limit_w: 500 } });
    const { results } = run(31_000, [[10_000, pause], [20_000, noJob], [20_000, pauseTwice], [30_000, capDead], [30_000, capNothing]], {
      faults: [fault('gpu_xid_79', 'gpu-r2-n1-0', T0 + 25_000)],
    });
    const w = results.at(-1)!.world_after;
    expect(commandOutcome(w, pause.command_key)).toEqual({ status: 'succeeded' });
    expect(commandOutcome(w, noJob.command_key)).toEqual({ status: 'failed', reason_code: 'JOB_NOT_FOUND' });
    expect(commandOutcome(w, pauseTwice.command_key)).toEqual({ status: 'failed', reason_code: 'JOB_STATE_INVALID' });
    expect(commandOutcome(w, capDead.command_key)).toEqual({ status: 'failed', reason_code: 'JOB_STATE_INVALID' }); // job-a failed: no GPUs
    expect(commandOutcome(w, capNothing.command_key)).toEqual({ status: 'failed', reason_code: 'TARGET_NOT_FOUND' });
  });
});

describe('command plumbing', () => {
  it('no command ever completes on the tick it starts', () => {
    const ops: ActionCommand[] = [
      cmd('power_cap', 'job-b', { job_id: 'job-b' }), cmd('pause_job', 'job-c', { job_id: 'job-c' }),
      cmd('cordon_gpu', 'gpu-r1-n1-0'), cmd('escalate', 'pump-a', { arguments: { reason: 'pump alarm' } }), cmd('keep_running', 'job-a', { job_id: 'job-a' }),
    ];
    const { results } = run(12_000, ops.map((c) => [10_000, c] as [number, ActionCommand]));
    expect(at(results, 10_000).completed_command_keys).toEqual([]);
    expect([...at(results, 11_000).completed_command_keys].sort()).toEqual(ops.map((c) => c.command_key).sort());
  });

  it('is idempotent per command_key: re-enqueueing and re-requesting runs it once; unknown ids are ignored', () => {
    const c = cmd('escalate', 'pump-a', { arguments: { reason: 'pump alarm' } });
    let w = enqueueCommands(enqueueCommands(demoWorld(), [c]), [c]);
    const r1 = step(tickInput(w, [], [c.action_id, c.action_id, 'act-unknown']));
    w = enqueueCommands(r1.world_after, [c]);
    const r2 = step(tickInput(w, [], [c.action_id]));
    const r3 = step(tickInput(r2.world_after, [], [c.action_id]));
    expect([r1, r2, r3].map((r) => r.completed_command_keys)).toEqual([[], [c.command_key], []]);
    expect(enqueueCommands(demoWorld(), [c])).not.toBe(demoWorld()); // pure: returns a new world
  });

  it('a queued command waits until its action id is requested', () => {
    const c = cmd('escalate', 'pump-a', { arguments: { reason: 'pump alarm' } });
    const { results } = run(15_000, [], {}, enqueueCommands(demoWorld(), [c]));
    expect(results.flatMap((r) => [...r.completed_command_keys, ...r.failed_command_keys])).toEqual([]);
  });
});
