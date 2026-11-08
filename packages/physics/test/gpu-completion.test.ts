// R1 (IMPLEMENTATION-TASKS R1, SCOPE §4 "Required safety repairs"): phase-aware completion of delayed commands.
// A checkpoint and a migrate_restart complete on a later tick, AFTER that tick's faults, and revalidate against the
// true post-fault state; a failed restart completion leaves a failed job with a coherent, released allocation.
import { describe, expect, it } from 'vitest';
import { validatePayload, type ActionCommand, type ObservedSnapshot, type PhysicsTickResult, type PhysicsWorld } from '@dcos/contracts';
import { commandOutcome, enqueueCommands, inFlightCommands, simulatePlan, toObserved } from '../src/index.js';
import { T0, demoWorld, fault, gpusOn, runUntil, type RunOpts } from './gpu-helpers.js';

let seq = 0;
function cmd(operation: ActionCommand['operation'], target: string, opts: Partial<ActionCommand> = {}): ActionCommand {
  seq += 1;
  const c: ActionCommand = {
    schema_version: '1.1.0', run_id: 'run-demo-1', action_id: `act-c-${seq}`, command_key: `ck-c-${operation}-${seq}`,
    workflow_id: 'wf-1', plan_id: 'plan-1', incident_ids: ['inc-1'], operation, target_resource_id: target,
    job_id: target.startsWith('job-') ? target : null, arguments: {}, depends_on_command_keys: [], expected_decision_epoch: 0,
    expected_resource_versions: {}, requested_sim_time_ms: T0, ...opts,
  };
  expect(validatePayload('ActionCommand', c)).toEqual({ ok: true });
  return c;
}
const move = (jobId: string, dest: string[], opts: Partial<ActionCommand> = {}) =>
  cmd('migrate_restart', jobId, { arguments: { destination_gpu_ids: dest }, ...opts });

const job = (s: ObservedSnapshot, id: string) => s.job_states.find((j) => j.job_id === id)!;
const gpu = (s: ObservedSnapshot, id: string) => s.gpus.find((g) => g.resource_id === id)!;
const at = (results: PhysicsTickResult[], ms: number) => results.find((r) => r.world_after.observable.clock.sim_time_ms === T0 + ms)!;
const epochAt = (results: PhysicsTickResult[], ms: number) => at(results, ms).world_after.observable.clock.decision_epoch;

/** Enqueue commands up front and request each on the tick ending at its offset; every tick result validates. */
function run(untilMs: number, schedule: [number, ActionCommand][], opts: RunOpts = {}, world: PhysicsWorld = demoWorld()) {
  const requestAt: Record<number, string[]> = {};
  for (const [t, c] of schedule) (requestAt[T0 + t] ??= []).push(c.action_id);
  const out = runUntil(enqueueCommands(world, schedule.map(([, c]) => c)), T0 + untilMs, { ...opts, requestAt });
  for (const r of out.results) expect(validatePayload('PhysicsTickResult', r)).toEqual({ ok: true });
  return out;
}

/** Allocation invariants on every tick: one owner per GPU, and allocated_gpu_ids ⇔ allocation rows. */
function expectCoherentAllocations(results: PhysicsTickResult[]): void {
  for (const r of results) {
    const s = r.world_after.observable;
    const owners = new Map<string, string>();
    for (const a of s.allocations) {
      expect(owners.has(a.gpu_id), `${a.gpu_id} allocated twice at ${s.clock.sim_time_ms}`).toBe(false);
      owners.set(a.gpu_id, a.job_id);
    }
    for (const j of s.job_states) {
      const rows = s.allocations.filter((a) => a.job_id === j.job_id).map((a) => a.gpu_id).sort();
      expect(rows, `${j.job_id} at ${s.clock.sim_time_ms}`).toEqual([...j.allocated_gpu_ids].sort());
      if (j.status === 'failed' || j.status === 'completed' || j.status === 'queued') expect(j.allocated_gpu_ids).toEqual([]);
    }
  }
}

/** World, ledger and projections agree that the restart failed and the job holds nothing. */
function expectFailedRestart(r: PhysicsTickResult, mv: ActionCommand, reason: string, durable: number): void {
  const w = r.world_after;
  const s = w.observable;
  expect(r.failed_command_keys).toEqual([mv.command_key]);
  expect(r.completed_command_keys).toEqual([]);
  expect(commandOutcome(w, mv.command_key)).toEqual({ status: 'failed', reason_code: reason });
  expect(inFlightCommands(w)).toEqual([]);
  expect(job(s, 'job-a')).toMatchObject({ status: 'failed', allocated_gpu_ids: [], progress_work_units: durable, durable_work_units: durable });
  expect(s.allocations.some((a) => a.job_id === 'job-a')).toBe(false);
  // no rollback to the old, released placement: r2 / r3 stay free
  expect(s.allocations.some((a) => gpusOn(2, 3).includes(a.gpu_id))).toBe(false);
}

const DURABLE_A = 86_400;

describe('R1 checkpoint completion', () => {
  it('(1) source GPU lost on the checkpoint due tick: the checkpoint fails, durable work unchanged', () => {
    const ck = cmd('checkpoint', 'job-b');
    const { results } = run(55_000, [[20_000, ck]], { faults: [fault('gpu_xid_79', 'gpu-r4-n1-3', T0 + 50_000)] });
    const r50 = at(results, 50_000); // the write's due tick: the fault applies first, then completion revalidates
    expect(r50.completed_command_keys).toEqual([]);
    expect(r50.failed_command_keys).toEqual([ck.command_key]);
    const s = r50.world_after.observable;
    expect(job(s, 'job-b')).toMatchObject({ status: 'failed', allocated_gpu_ids: [], durable_work_units: 40_000, progress_work_units: 40_000, latest_checkpoint_id: 'ckpt-job-b-1' });
    expect(s.checkpoints.find((c) => c.command_key === ck.command_key)).toMatchObject({ status: 'failed', complete_sim_time_ms: null });
    expect(commandOutcome(r50.world_after, ck.command_key)).toEqual({ status: 'failed', reason_code: 'JOB_FAILED_DURING_OPERATION' });
    expect(results.flatMap((r) => r.completed_command_keys)).toEqual([]);
    expect(gpu(results.at(-1)!.world_after.observable, 'gpu-r4-n1-3').availability).toBe('unreachable'); // hardware state retained
    expectCoherentAllocations(results);
  });

  it('(1b) node crash on the source node on the due tick: same outcome, nothing durable', () => {
    const ck = cmd('checkpoint', 'job-b');
    const { results } = run(52_000, [[20_000, ck]], { faults: [fault('node_crash', 'node-r4-n1', T0 + 50_000)] });
    const r50 = at(results, 50_000);
    expect(r50.failed_command_keys).toEqual([ck.command_key]);
    expect(job(r50.world_after.observable, 'job-b')).toMatchObject({ status: 'failed', durable_work_units: 40_000, latest_checkpoint_id: 'ckpt-job-b-1' });
    expect(results.flatMap((r) => r.completed_command_keys)).toEqual([]);
  });

  it('(2) destination-only loss during the source checkpoint: the checkpoint finishes; the old destination is unusable', () => {
    const ck = cmd('checkpoint', 'job-a');
    const mv = move('job-a', gpusOn(7, 8), { depends_on_command_keys: [ck.command_key] });
    const { results } = run(55_000, [[20_000, ck], [51_000, mv]], { faults: [fault('gpu_xid_79', 'gpu-r7-n1-2', T0 + 35_000)] });
    const r50 = at(results, 50_000);
    expect(r50.completed_command_keys).toEqual([ck.command_key]);
    const durable = 95_040 + 16 * 20;
    expect(job(r50.world_after.observable, 'job-a')).toMatchObject({ status: 'running', allocated_gpu_ids: gpusOn(2, 3), durable_work_units: durable, latest_checkpoint_id: 'ckpt-job-a-2' });
    // the planned destination now holds a dead GPU: the move is refused, the job keeps running on its source
    const r51 = at(results, 51_000);
    expect(r51.failed_command_keys).toEqual([mv.command_key]);
    expect(commandOutcome(r51.world_after, mv.command_key)).toEqual({ status: 'failed', reason_code: 'DEST_GPU_UNHEALTHY' });
    expect(job(r51.world_after.observable, 'job-a')).toMatchObject({ status: 'running', allocated_gpu_ids: gpusOn(2, 3), durable_work_units: durable });
    expect(gpu(r51.world_after.observable, 'gpu-r7-n1-2').availability).toBe('unreachable');
    expectCoherentAllocations(results);
  });

  it('(4) an unrelated fault (epoch change) during the write: the valid running checkpoint still completes', () => {
    const ck = cmd('checkpoint', 'job-b');
    const cordon = cmd('cordon_gpu', 'gpu-r8-n1-0');
    const { results } = run(52_000, [[20_000, ck], [30_000, cordon]], { faults: [fault('gpu_xid_79', 'gpu-r1-n1-0', T0 + 35_000)] });
    expect(epochAt(results, 50_000)).toBeGreaterThan(epochAt(results, 20_000)); // unrelated material changes happened
    const r50 = at(results, 50_000);
    expect(r50.completed_command_keys).toEqual([ck.command_key]);
    expect(job(r50.world_after.observable, 'job-b')).toMatchObject({ status: 'running', durable_work_units: 40_640, latest_checkpoint_id: 'ckpt-job-b-2' });
    expect(commandOutcome(r50.world_after, ck.command_key)).toEqual({ status: 'succeeded' });
  });

  it('(4b) storage lost on the due tick itself: no new durability (this tick’s fault, not the cached row flag)', () => {
    const ck = cmd('checkpoint', 'job-b');
    const { results } = run(52_000, [[20_000, ck]], { faults: [fault('network_link_down', 'ckpt-store-1', T0 + 50_000)] });
    expect(at(results, 49_000).world_after.observable.checkpoints.every((c) => c.accessible)).toBe(true);
    const r50 = at(results, 50_000);
    expect(r50.failed_command_keys).toEqual([ck.command_key]);
    expect(commandOutcome(r50.world_after, ck.command_key)).toEqual({ status: 'failed', reason_code: 'CHECKPOINT_NOT_ACCESSIBLE' });
    expect(job(r50.world_after.observable, 'job-b')).toMatchObject({ status: 'running', durable_work_units: 40_000 });
  });
});

describe('R1 restart completion (migrate_restart of job-a onto r7 + r8 at 20 s, due at 140 s)', () => {
  const DEST = gpusOn(7, 8);

  it('(3a) destination thermally unsafe before completion: predictive headroom fails, job failed, allocation released', () => {
    const mv = move('job-a', DEST);
    // +12 °C on one destination GPU: it would run at ≈82 °C, under the 85 °C slowdown but inside the 5 °C margin
    const hot = fault('gpu_thermal_load', 'gpu-r7-n1-0', T0 + 100_000, { parameters: { extra_temp_c: 12 } });
    const retry = move('job-a', [...gpusOn(5), ...gpusOn(8)]);
    const { results, world } = run(275_000, [[20_000, mv], [150_000, retry]], { faults: [hot] });
    expect(job(at(results, 139_000).world_after.observable, 'job-a')).toMatchObject({ status: 'restarting', allocated_gpu_ids: DEST });
    expectFailedRestart(at(results, 140_000), mv, 'DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT', DURABLE_A);
    // failed hardware state retained: the hot GPU is still hot afterwards
    expect(gpu(at(results, 141_000).world_after.observable, 'gpu-r7-n1-0').temp_c).toBeGreaterThan(gpu(at(results, 141_000).world_after.observable, 'gpu-r7-n1-1').temp_c + 10);
    // the cluster is coherent: a replanned move onto r5 + r8 (r8 was part of the released destination) restarts the job
    const r270 = at(results, 270_000);
    expect(r270.completed_command_keys).toEqual([retry.command_key]);
    expect(job(r270.world_after.observable, 'job-a')).toMatchObject({ status: 'running', allocated_gpu_ids: [...gpusOn(5), ...gpusOn(8)], progress_work_units: DURABLE_A });
    expect(job(world.observable, 'job-a').progress_work_units).toBe(DURABLE_A + 16 * 5);
    expectCoherentAllocations(results);
  });

  it('(3a′) the same extra heat on a GPU of the released source rack is unrelated: the restart completes', () => {
    const mv = move('job-a', DEST);
    const hot = fault('gpu_thermal_load', 'gpu-r2-n1-0', T0 + 100_000, { parameters: { extra_temp_c: 12 } });
    const { results } = run(141_000, [[20_000, mv]], { faults: [hot] });
    const r140 = at(results, 140_000);
    expect(r140.completed_command_keys).toEqual([mv.command_key]);
    expect(job(r140.world_after.observable, 'job-a')).toMatchObject({ status: 'running', allocated_gpu_ids: DEST });
  });

  it('(3b) checkpoint storage unavailable at completion: CHECKPOINT_NOT_ACCESSIBLE, job failed; a transient outage is not rolled back', () => {
    const mv = move('job-a', DEST);
    const down = fault('network_link_down', 'ckpt-store-1', T0 + 100_000, { duration_sim_ms: 50_000 }); // back at 150 s
    const retry = move('job-a', DEST);
    const { results } = run(281_000, [[20_000, mv], [160_000, retry]], { faults: [down] });
    expectFailedRestart(at(results, 140_000), mv, 'CHECKPOINT_NOT_ACCESSIBLE', DURABLE_A);
    // storage returns at 150 s: the job stays failed (no automatic rollback / resume) until a new command moves it
    const s155 = at(results, 155_000).world_after.observable;
    expect(s155.checkpoints.every((c) => c.status !== 'complete' || c.accessible)).toBe(true);
    expect(job(s155, 'job-a')).toMatchObject({ status: 'failed', allocated_gpu_ids: [] });
    expect(at(results, 280_000).completed_command_keys).toEqual([retry.command_key]);
    expect(job(at(results, 280_000).world_after.observable, 'job-a')).toMatchObject({ status: 'running', allocated_gpu_ids: DEST, progress_work_units: DURABLE_A });
    expectCoherentAllocations(results);
  });

  it('(3b′) storage is checked at start too: a move cannot start while the store is down', () => {
    const mv = move('job-a', DEST);
    const { results } = run(21_000, [[20_000, mv]], { faults: [fault('node_crash', 'ckpt-store-1', T0 + 10_000)] });
    expect(commandOutcome(at(results, 20_000).world_after, mv.command_key)).toEqual({ status: 'failed', reason_code: 'CHECKPOINT_NOT_ACCESSIBLE' });
    expect(job(at(results, 20_000).world_after.observable, 'job-a')).toMatchObject({ status: 'running', allocated_gpu_ids: gpusOn(2, 3) });
  });

  it('(3c) destination evidence stale (> 10 s) at completion: EVIDENCE_STALE, job failed, allocation released', () => {
    const mv = move('job-a', DEST);
    const { results } = run(141_000, [[20_000, mv]], { faults: [fault('sensor_stale', 'gpu-r8-n1-5', T0 + 100_000)] });
    const g139 = gpu(at(results, 139_000).world_after.observable, 'gpu-r8-n1-5');
    expect(T0 + 139_000 - g139.last_seen_sim_ms).toBeGreaterThan(10_000);
    expectFailedRestart(at(results, 140_000), mv, 'EVIDENCE_STALE', DURABLE_A);
    expectCoherentAllocations(results);
  });

  it('(3c′) evidence that went stale 6 s before completion is still within the 10 s freshness window', () => {
    const mv = move('job-a', DEST);
    const { results } = run(141_000, [[20_000, mv]], { faults: [fault('sensor_stale', 'gpu-r8-n1-5', T0 + 135_000)] });
    const r140 = at(results, 140_000);
    expect(r140.completed_command_keys).toEqual([mv.command_key]);
    expect(job(r140.world_after.observable, 'job-a').status).toBe('running');
  });

  it('(3d) a non-fatal destination failure (XID 74 degraded) during the restart: DEST_GPU_UNHEALTHY, failed GPU state retained', () => {
    const mv = move('job-a', DEST);
    const { results } = run(141_000, [[20_000, mv]], { faults: [fault('gpu_xid_74', 'gpu-r7-n1-6', T0 + 90_000)] });
    expectFailedRestart(at(results, 140_000), mv, 'DEST_GPU_UNHEALTHY', DURABLE_A);
    expect(gpu(at(results, 140_000).world_after.observable, 'gpu-r7-n1-6')).toMatchObject({ availability: 'degraded', last_xid_code: 74 });
  });

  it('an unrelated fault (epoch change) and a cordon of a destination GPU during the restart do not abort it', () => {
    const mv = move('job-a', DEST);
    const cordon = cmd('cordon_gpu', 'gpu-r8-n1-1'); // cordon prevents NEW placement; it never evicts the job already holding the GPU
    const { results } = run(141_000, [[20_000, mv], [60_000, cordon]], { faults: [fault('gpu_xid_79', 'gpu-r1-n1-0', T0 + 80_000)] });
    expect(epochAt(results, 139_000)).toBeGreaterThan(epochAt(results, 21_000));
    const r140 = at(results, 140_000);
    expect(r140.completed_command_keys).toEqual([mv.command_key]);
    expect(job(r140.world_after.observable, 'job-a')).toMatchObject({ status: 'running', allocated_gpu_ids: DEST, progress_work_units: DURABLE_A });
    expect(gpu(r140.world_after.observable, 'gpu-r8-n1-1').availability).toBe('cordoned');
    expectCoherentAllocations(results);
  });
});

describe('R1 (5) competing moves never allocate one GPU to two jobs', () => {
  it('two moves onto overlapping destinations on the same tick: exactly one allocates, the other is DEST_GPU_BUSY', () => {
    const a = move('job-a', gpusOn(7, 8));
    const b = move('job-b', gpusOn(7));
    const { results } = run(145_000, [[20_000, a], [20_000, b]]);
    const r20 = at(results, 20_000);
    expect(r20.failed_command_keys).toEqual([b.command_key]);
    expect(commandOutcome(r20.world_after, b.command_key)).toEqual({ status: 'failed', reason_code: 'DEST_GPU_BUSY' });
    expect(job(r20.world_after.observable, 'job-a')).toMatchObject({ status: 'restarting', allocated_gpu_ids: gpusOn(7, 8) });
    expect(job(r20.world_after.observable, 'job-b')).toMatchObject({ status: 'running', allocated_gpu_ids: gpusOn(4) });
    expect(at(results, 140_000).completed_command_keys).toEqual([a.command_key]);
    expectCoherentAllocations(results);
  });

  it('a move onto GPUs reserved by a restart in flight is refused; a disjoint move runs alongside', () => {
    const a = move('job-a', gpusOn(7, 8));
    const bBusy = move('job-b', gpusOn(8));
    const bFree = move('job-b', gpusOn(5));
    const { results } = run(185_000, [[20_000, a], [60_000, bBusy], [61_000, bFree]]);
    expect(commandOutcome(at(results, 60_000).world_after, bBusy.command_key)).toEqual({ status: 'failed', reason_code: 'DEST_GPU_BUSY' });
    expect(job(at(results, 60_000).world_after.observable, 'job-b')).toMatchObject({ status: 'running', allocated_gpu_ids: gpusOn(4) });
    expect(at(results, 140_000).completed_command_keys).toEqual([a.command_key]);
    expect(at(results, 181_000).completed_command_keys).toEqual([bFree.command_key]);
    const s = results.at(-1)!.world_after.observable;
    expect(job(s, 'job-a')).toMatchObject({ status: 'running', allocated_gpu_ids: gpusOn(7, 8) });
    expect(job(s, 'job-b')).toMatchObject({ status: 'running', allocated_gpu_ids: gpusOn(5) });
    expectCoherentAllocations(results);
  });

  it('a failed job recovering onto GPUs another job already restarted onto is refused, never double-allocated', () => {
    const b = move('job-b', gpusOn(7));
    const a = move('job-a', gpusOn(7, 8)); // job-a failed at 30 s; its recovery targets job-b's new home
    const { results } = run(160_000, [[20_000, b], [150_000, a]], { faults: [fault('gpu_xid_79', 'gpu-r2-n1-0', T0 + 30_000)] });
    expect(job(at(results, 30_000).world_after.observable, 'job-a').status).toBe('failed');
    expect(commandOutcome(at(results, 150_000).world_after, a.command_key)).toEqual({ status: 'failed', reason_code: 'DEST_GPU_BUSY' });
    expect(job(at(results, 150_000).world_after.observable, 'job-a')).toMatchObject({ status: 'failed', allocated_gpu_ids: [] });
    expect(job(at(results, 150_000).world_after.observable, 'job-b')).toMatchObject({ status: 'running', allocated_gpu_ids: gpusOn(7) });
    expectCoherentAllocations(results);
  });
});

describe('R1 offline parity: simulatePlan applies the same completion semantics', () => {
  /** A snapshot in which r7 is observed +12 °C hot (the estimate reproduces observed temperatures as persistent offsets). */
  function hotR7Snapshot(): ObservedSnapshot {
    const faults = gpusOn(7).map((g) => fault('gpu_thermal_load', g, T0 + 1_000, { parameters: { extra_temp_c: 12 } }));
    return toObserved(runUntil(demoWorld(), T0 + 5_000, { faults }).world);
  }
  const plan = (dest: string[]) => ({
    commands: [cmd('migrate_restart', 'job-a', { arguments: { destination_gpu_ids: dest }, requested_sim_time_ms: T0 + 5_000 })],
  });

  it('a move onto the observed-hot r7 fails at restart completion in the estimate; onto r5 + r8 it succeeds', () => {
    const obs = hotR7Snapshot();
    const hot = simulatePlan(obs, plan(gpusOn(7, 8)), { horizon_s: 300 });
    const cool = simulatePlan(obs, plan([...gpusOn(5), ...gpusOn(8)]), { horizon_s: 300 });
    expect(hot.violations).toEqual(['DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT']);
    expect(hot.failure_risk_estimate).toBe(1); // the job fails in the simulation
    expect(hot.assumptions.some((a) => a.includes('job-a'))).toBe(true);
    expect(cool.violations).toEqual([]);
    expect(cool.failure_risk_estimate).toBeLessThan(1);
    expect(hot.expected_completion_delay_sim_s).toBeGreaterThan(cool.expected_completion_delay_sim_s);
  });
});
