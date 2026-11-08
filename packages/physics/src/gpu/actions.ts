// Commands inside step() (P1-5).
//
// HOW COMMANDS ENTER step() (contract question, reported to the orchestrator):
//   SimulationTickInput.requested_action_ids carries only action IDs, so the full ActionCommand payloads ride in the
//   private world: the trusted caller (DB start_action / eval harness / simulatePlan) calls
//   `enqueueCommands(world, [cmd])`, which stores them in hidden_physics_state_json.command_inbox. On a tick whose
//   requested_action_ids lists a command's action_id, step() starts it (once: command_keys are idempotent).
//   Proposed additive schema change: `SimulationTickInput.requested_actions: ActionCommand[]` would remove the inbox.
//
// TIMING: a command starts at the tick's end time t1 and gets due_sim_ms = t1 + its duration (checkpoint
//   checkpoint_duration_ms = 30 s, migrate_restart restart_duration_ms = 120 s, everything else 0). It completes on
//   the first LATER tick whose t1 ≥ due, after that tick's faults applied (completion revalidates). Its key then
//   lands in completed_command_keys or failed_command_keys; invalid commands fail on the tick they are requested.
//   commandOutcome() gives the reason code; inFlightCommands() gives due times for the DB's action rows.
//
// Physics checks only physical feasibility. Epoch / resource-version / lease / preemptibility policy is the safety
// engine's job (evaluateSafety, P1-6) and the reducers'; physics never blocks on them.
import type { ActionCommand, Checkpoint, JobState, PhysicsWorld } from '@dcos/contracts';
import { POWER_CAP_W, POWER_LIMIT_W, WIRE_SCHEMA_VERSION as V } from './constants.js';
import { JOB_FATAL_FAILURES, finishCommand, releaseJob, type TickCtx } from './jobs.js';
import {
  cloneJson,
  faultConditions,
  gpuAvailability,
  hiddenOf,
  specOf,
  type CommandOutcome,
  type HiddenState,
  type InFlightCommand,
  type Topology,
} from './world.js';

/** Thrown inside validation; becomes a failed command with this reason code. */
class CommandRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
const reject = (reason: string): never => {
  throw new CommandRejected(reason);
};

/** Store commands for later ticks (see header). Pure: returns a new world. A command_key already known is ignored. */
export function enqueueCommands(world: PhysicsWorld, commands: ActionCommand[]): PhysicsWorld {
  const next = cloneJson(world);
  const h = hiddenOf(next);
  const known = new Set([
    ...h.command_inbox.map((c) => c.command_key),
    ...h.in_flight.map((f) => f.command.command_key),
    ...h.finished_command_keys,
  ]);
  for (const c of commands) {
    if (known.has(c.command_key)) continue;
    known.add(c.command_key);
    h.command_inbox.push(cloneJson(c));
  }
  return next;
}

export interface InFlightView {
  command_key: string;
  action_id: string;
  operation: ActionCommand['operation'];
  job_id: string | null;
  started_sim_ms: number;
  due_sim_time_ms: number;
}

/** Started-but-unfinished commands with their due times (trusted callers only: it reads the private world). */
export function inFlightCommands(world: PhysicsWorld): InFlightView[] {
  return hiddenOf(world).in_flight.map((f) => ({
    command_key: f.command.command_key, action_id: f.command.action_id, operation: f.command.operation,
    job_id: f.command.job_id, started_sim_ms: f.started_sim_ms, due_sim_time_ms: f.due_sim_ms,
  }));
}

/** How a finished command ended, or null while it is queued / in flight / unknown. */
export function commandOutcome(world: PhysicsWorld, commandKey: string): CommandOutcome | null {
  return hiddenOf(world).command_outcomes[commandKey] ?? null;
}

// ---- helpers --------------------------------------------------------------------------------------

const jobIdOf = (c: ActionCommand) => c.job_id ?? c.target_resource_id;

function jobOf(world: PhysicsWorld, c: ActionCommand): JobState {
  return world.observable.job_states.find((j) => j.job_id === jobIdOf(c)) ?? reject('JOB_NOT_FOUND');
}

function stringList(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

/** GPUs a power_cap / cordon command acts on: the job's GPUs, a node's GPUs, or one GPU. */
function targetGpus(world: PhysicsWorld, topo: Topology, c: ActionCommand): string[] {
  if (c.job_id) return jobOf(world, c).allocated_gpu_ids;
  const t = c.target_resource_id;
  if (world.observable.gpus.some((g) => g.resource_id === t)) return [t];
  if (topo.nodeGpus.has(t)) return topo.nodeGpus.get(t)!;
  if (topo.resources.get(t)?.kind === 'gpu') return reject('REAL_GPU_NOT_ALLOCATABLE');
  const asJob = world.observable.job_states.find((j) => j.job_id === t);
  return asJob ? asJob.allocated_gpu_ids : reject('TARGET_NOT_FOUND');
}

function storageUp(world: PhysicsWorld, topo: Topology, storeId: string): boolean {
  return !faultConditions(world.active_faults_private, topo).storageDown.has(storeId);
}

function busyFor(world: PhysicsWorld, h: HiddenState, jobId: string): boolean {
  return h.in_flight.some((f) => jobIdOf(f.command) === jobId);
}

/** Pick the destination GPU set for migrate_restart: explicit GPUs, or free ready GPUs on the given nodes. */
function destinationGpus(world: PhysicsWorld, h: HiddenState, topo: Topology, c: ActionCommand, job: JobState, need: number): string[] {
  const explicit = stringList(c.arguments.destination_gpu_ids);
  if (explicit) return explicit;
  const nodes = stringList(c.arguments.destination_node_ids);
  if (!nodes) return reject('DEST_GPU_COUNT_INSUFFICIENT');
  const taken = new Set(world.observable.allocations.filter((a) => a.job_id !== job.job_id).map((a) => a.gpu_id));
  const free = nodes.flatMap((n) => topo.nodeGpus.get(n) ?? [])
    .filter((g) => !taken.has(g) && gpuAvailability(g, h) === 'ready');
  return free.length >= need ? free.slice(0, need) : reject('DEST_GPU_COUNT_INSUFFICIENT');
}

// ---- start ----------------------------------------------------------------------------------------

function durationMs(world: PhysicsWorld, c: ActionCommand): number {
  const spec = c.operation === 'checkpoint' || c.operation === 'migrate_restart' ? specOf(world, jobIdOf(c)) : undefined;
  if (c.operation === 'checkpoint') return spec?.checkpoint_duration_ms ?? 0;
  if (c.operation === 'migrate_restart') return spec?.restart_duration_ms ?? 0;
  return 0;
}

function startCommand(world: PhysicsWorld, h: HiddenState, topo: Topology, ctx: TickCtx, c: ActionCommand): InFlightCommand {
  const f: InFlightCommand = { command: c, started_sim_ms: ctx.t1, due_sim_ms: ctx.t1 + durationMs(world, c) };
  switch (c.operation) {
    case 'checkpoint': {
      const job = jobOf(world, c);
      const spec = specOf(world, job.job_id) ?? reject('JOB_NOT_FOUND');
      if (!spec.checkpoint_supported || !spec.checkpoint_storage_id) reject('CHECKPOINT_UNSUPPORTED');
      if (job.status !== 'running' && job.status !== 'paused') reject('JOB_STATE_INVALID');
      if (busyFor(world, h, job.job_id)) reject('CONFLICTING_ACTION');
      if (!storageUp(world, topo, spec.checkpoint_storage_id!)) reject('CHECKPOINT_NOT_ACCESSIBLE');
      const n = h.checkpoint_counter[job.job_id] ?? 1;
      h.checkpoint_counter[job.job_id] = n + 1;
      const row: Checkpoint = {
        schema_version: V, run_id: world.run_id, checkpoint_id: `ckpt-${job.job_id}-${n}`, job_id: job.job_id,
        storage_resource_id: spec.checkpoint_storage_id!, status: 'writing', progress_work_units: job.progress_work_units,
        requested_sim_time_ms: ctx.t1, complete_sim_time_ms: null, accessible: true, command_key: c.command_key,
      };
      world.observable.checkpoints.push(row);
      f.checkpoint_id = row.checkpoint_id;
      f.resume_status = job.status === 'paused' ? 'paused' : 'running';
      job.status = 'checkpointing'; // a synchronous write: no training progress while it runs (simulated)
      return f;
    }
    case 'migrate_restart': {
      const job = jobOf(world, c);
      const spec = specOf(world, job.job_id) ?? reject('JOB_NOT_FOUND');
      if (!['running', 'paused', 'failed', 'queued'].includes(job.status)) reject('JOB_STATE_INVALID');
      if (busyFor(world, h, job.job_id)) reject('CONFLICTING_ACTION');
      const dest = destinationGpus(world, h, topo, c, job, spec.gpus_required);
      // all-or-nothing: every check passes before anything changes
      if (dest.length !== spec.gpus_required || new Set(dest).size !== dest.length) reject('DEST_GPU_COUNT_INSUFFICIENT');
      const owner = new Map(world.observable.allocations.map((a) => [a.gpu_id, a.job_id]));
      for (const g of dest) {
        const res = topo.resources.get(g);
        if (res?.kind === 'gpu' && !world.observable.gpus.some((x) => x.resource_id === g)) reject('REAL_GPU_NOT_ALLOCATABLE');
        if (!res || res.kind !== 'gpu') reject('DEST_NOT_COMPATIBLE');
        if (res!.config.allocatable === false) reject('REAL_GPU_NOT_ALLOCATABLE');
        if (!spec.compatible_node_ids.includes(topo.gpuNode.get(g) ?? '')) reject('DEST_NOT_COMPATIBLE');
        if (gpuAvailability(g, h) !== 'ready') reject('DEST_GPU_UNHEALTHY');
        const o = owner.get(g);
        if (o !== undefined && o !== job.job_id) reject('DEST_GPU_BUSY');
      }
      if (spec.placement_policy === 'same_node' && new Set(dest.map((g) => topo.gpuNode.get(g))).size !== 1) reject('DEST_NOT_COMPATIBLE');
      if (job.latest_checkpoint_id !== null) {
        const ck = world.observable.checkpoints.find((x) => x.checkpoint_id === job.latest_checkpoint_id);
        if (!ck || ck.status !== 'complete') reject('NO_COMPLETED_CHECKPOINT');
        if (!storageUp(world, topo, ck!.storage_resource_id)) reject('CHECKPOINT_NOT_ACCESSIBLE');
      }
      // commit: free the old placement, atomically allocate the whole destination, restart from durable work
      releaseJob(world, job);
      for (const g of dest) {
        world.observable.allocations.push({ schema_version: V, run_id: world.run_id, job_id: job.job_id, gpu_id: g, since_sim_time_ms: ctx.t1 });
      }
      job.allocated_gpu_ids = [...dest];
      job.status = 'restarting';
      job.progress_work_units = job.durable_work_units; // work since the last durable checkpoint is lost
      f.destination_gpu_ids = [...dest];
      return f;
    }
    case 'power_cap': {
      const limit = typeof c.arguments.power_limit_w === 'number' ? c.arguments.power_limit_w : POWER_CAP_W;
      if (!(limit > 0 && limit <= POWER_LIMIT_W)) reject('INVALID_ARGUMENT');
      if (targetGpus(world, topo, c).length === 0) reject('TARGET_NOT_FOUND');
      return f;
    }
    case 'pause_job': {
      const job = jobOf(world, c);
      if (job.status !== 'running') reject('JOB_STATE_INVALID');
      if (busyFor(world, h, job.job_id)) reject('CONFLICTING_ACTION');
      return f;
    }
    case 'cordon_gpu':
    case 'uncordon_gpu':
      if (!world.observable.gpus.some((g) => g.resource_id === c.target_resource_id)) {
        reject(topo.resources.get(c.target_resource_id)?.kind === 'gpu' ? 'REAL_GPU_NOT_ALLOCATABLE' : 'TARGET_NOT_FOUND');
      }
      return f;
    case 'keep_running':
      if (c.job_id) jobOf(world, c);
      return f;
    case 'escalate':
      return f;
    default:
      return reject('UNSUPPORTED_OPERATION');
  }
}

// ---- complete -------------------------------------------------------------------------------------

/** Returns null on success, else the failure reason. Runs after this tick's faults (revalidation). */
function completeCommand(world: PhysicsWorld, h: HiddenState, topo: Topology, ctx: TickCtx, f: InFlightCommand): string | null {
  const c = f.command;
  switch (c.operation) {
    case 'checkpoint': {
      const job = jobOf(world, c);
      const row = world.observable.checkpoints.find((x) => x.checkpoint_id === f.checkpoint_id)!;
      const ok = job.status === 'checkpointing' && storageUp(world, topo, row.storage_resource_id);
      if (job.status === 'checkpointing') job.status = f.resume_status ?? 'running';
      if (!ok) {
        row.status = 'failed';
        row.accessible = false;
        return 'CHECKPOINT_NOT_ACCESSIBLE';
      }
      // durable only now: the write finished and the storage is still accessible
      row.status = 'complete';
      row.complete_sim_time_ms = ctx.t1;
      job.durable_work_units = row.progress_work_units;
      job.latest_checkpoint_id = row.checkpoint_id;
      h.last_checkpoint_sim_ms[job.job_id] = ctx.t1;
      return null;
    }
    case 'migrate_restart': {
      const job = jobOf(world, c);
      if (job.status !== 'restarting') return 'JOB_STATE_INVALID';
      const dead = job.allocated_gpu_ids.some((g) => {
        const fl = h.gpu_failure[g];
        return fl !== undefined && JOB_FATAL_FAILURES.has(fl);
      });
      if (dead) return 'DEST_GPU_UNHEALTHY'; // (failJobsOnDeadGpus normally gets there first)
      job.status = 'running';
      return null;
    }
    case 'power_cap': {
      const limit = typeof c.arguments.power_limit_w === 'number' ? c.arguments.power_limit_w : POWER_CAP_W;
      const ids = new Set(targetGpus(world, topo, c));
      if (ids.size === 0) return 'TARGET_NOT_FOUND';
      for (const g of world.observable.gpus) if (ids.has(g.resource_id)) g.power_limit_w = limit;
      return null;
    }
    case 'pause_job': {
      const job = jobOf(world, c);
      if (job.status !== 'running') return 'JOB_STATE_INVALID';
      job.status = 'paused';
      return null;
    }
    case 'cordon_gpu':
      // cordon only stops new placements; availability is re-derived and a failed GPU stays unreachable/degraded
      if (!h.gpu_cordoned.includes(c.target_resource_id)) h.gpu_cordoned.push(c.target_resource_id);
      return null;
    case 'uncordon_gpu':
      // never a repair: a GPU with a latched failure stays degraded/unreachable after uncordon
      h.gpu_cordoned = h.gpu_cordoned.filter((g) => g !== c.target_resource_id);
      return null;
    case 'keep_running': {
      if (c.job_id) {
        const job = jobOf(world, c);
        if (job.status === 'paused') job.status = 'running'; // keep_running on a paused job resumes it
      }
      return null;
    }
    case 'escalate':
      return null; // no physical effect: a human takes over
    default:
      return 'UNSUPPORTED_OPERATION';
  }
}

/** Step 3 of a tick: complete due in-flight commands, then start the requested ones. */
export function processCommands(
  world: PhysicsWorld, h: HiddenState, topo: Topology, ctx: TickCtx, requestedActionIds: string[],
): void {
  const due = h.in_flight
    .filter((f) => f.due_sim_ms <= ctx.t1 && f.started_sim_ms < ctx.t1)
    .sort((a, b) => a.due_sim_ms - b.due_sim_ms || (a.command.command_key < b.command.command_key ? -1 : 1));
  for (const f of due) {
    if (!h.in_flight.includes(f)) continue; // finished meanwhile (e.g. its job failed)
    let reason: string | null;
    try {
      reason = completeCommand(world, h, topo, ctx, f);
    } catch (e) {
      if (!(e instanceof CommandRejected)) throw e;
      reason = e.reason;
    }
    finishCommand(h, ctx, f.command.command_key, reason === null, reason);
  }

  for (const actionId of requestedActionIds) {
    const c = h.command_inbox.find((x) => x.action_id === actionId);
    if (!c) continue; // unknown or already started: requests are idempotent
    h.command_inbox = h.command_inbox.filter((x) => x !== c);
    if (h.finished_command_keys.includes(c.command_key) || h.in_flight.some((f) => f.command.command_key === c.command_key)) continue;
    try {
      h.in_flight.push(startCommand(world, h, topo, ctx, c));
    } catch (e) {
      if (!(e instanceof CommandRejected)) throw e;
      finishCommand(h, ctx, c.command_key, false, e.reason);
    }
  }
}
