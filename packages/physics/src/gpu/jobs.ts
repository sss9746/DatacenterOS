// Per-tick context plus the job transitions shared by faults.ts, actions.ts and step.ts.
import type { FaultInjection, JobState, PhysicsWorld } from '@dcos/contracts';
import type { GpuFailure, HiddenState } from './world.js';

/** A signal to emit at the end of the tick (built by telemetry.ts from the final world). */
export type SignalDraft =
  | { kind: 'fault_applied'; fault: FaultInjection }
  | { kind: 'fault_cleared'; fault: FaultInjection }
  | { kind: 'thermal_shutdown'; gpu_id: string; temp_c: number };

export interface TickCtx {
  /** sim time at the start of the tick (the input world's clock) */
  t0: number;
  /** sim time at the end of the tick (= the output world's clock) */
  t1: number;
  tick: number;
  completed: string[];
  failed: string[];
  signals: SignalDraft[];
}

/** Latched failures that kill any non-elastic job using the GPU. XID 74 (NVLink, Tier 2) only degrades the GPU. */
export const JOB_FATAL_FAILURES: ReadonlySet<GpuFailure> = new Set(['xid_79', 'xid_48', 'thermal_shutdown', 'node_crash']);

/** Jobs that hold GPUs. */
export const ACTIVE_STATUSES: ReadonlySet<JobState['status']> = new Set(['running', 'checkpointing', 'paused', 'restarting']);

export function finishCommand(h: HiddenState, ctx: TickCtx, commandKey: string, ok: boolean): void {
  (ok ? ctx.completed : ctx.failed).push(commandKey);
  if (!h.finished_command_keys.includes(commandKey)) h.finished_command_keys.push(commandKey);
  h.in_flight = h.in_flight.filter((f) => f.command.command_key !== commandKey);
}

/** Release a job's GPUs (allocations and allocated_gpu_ids). */
export function releaseJob(world: PhysicsWorld, job: JobState): void {
  world.observable.allocations = world.observable.allocations.filter((a) => a.job_id !== job.job_id);
  job.allocated_gpu_ids = [];
}

/**
 * A non-elastic job fails: progress falls back to the last durable (completed, accessible) checkpoint, its GPUs are
 * released, any checkpoint it was writing fails (never becomes durable), and its in-flight commands fail.
 */
export function failJob(world: PhysicsWorld, h: HiddenState, ctx: TickCtx, job: JobState): void {
  job.status = 'failed';
  job.progress_work_units = job.durable_work_units;
  releaseJob(world, job);
  for (const f of [...h.in_flight]) {
    if ((f.command.job_id ?? f.command.target_resource_id) !== job.job_id) continue;
    if (f.checkpoint_id) {
      const row = world.observable.checkpoints.find((c) => c.checkpoint_id === f.checkpoint_id);
      if (row) row.status = 'failed';
    }
    finishCommand(h, ctx, f.command.command_key, false);
  }
}

/** Fail every active job holding a GPU with a job-fatal latched failure. */
export function failJobsOnDeadGpus(world: PhysicsWorld, h: HiddenState, ctx: TickCtx): void {
  for (const job of world.observable.job_states) {
    if (!ACTIVE_STATUSES.has(job.status)) continue;
    const dead = job.allocated_gpu_ids.some((g) => {
      const f = h.gpu_failure[g];
      return f !== undefined && JOB_FATAL_FAILURES.has(f);
    });
    if (dead) failJob(world, h, ctx, job);
  }
}
