import type { Checkpoint, JobState, ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail } from '@dcos/db-client';
import type { JobTrailEntry } from '../../data/dashboard';
import { racksOfGpus } from '../simulation/topology';
import { number } from '../../lib/utils';

/**
 * Per-job recovery story, derived only from observed data: the snapshot (job state, allocations, checkpoint rows),
 * the typed ledger projection (`migrate_restart` / `checkpoint` actions with their due times) and the store's job
 * trail (what the job looked like just before each change). Nothing here estimates a number: when a value was not
 * observed (page opened mid-move, no trail yet) it is null and the UI omits it.
 */
export type MoveStepId = 'at_risk' | 'checkpoint' | 'moving' | 'restarting' | 'running';
export type StepState = 'done' | 'active' | 'pending' | 'failed';
export interface MoveStep { id: MoveStepId; label: string; detail: string | null; state: StepState }
export interface MovePlacement { gpuIds: string[]; racks: number[] }
export interface JobMoveTimeline {
  jobId: string;
  /** `move`: a migrate_restart is planned, running or finished. `rollback`: the job failed and fell back to its checkpoint. */
  kind: 'move' | 'rollback';
  phase: MoveStepId | 'rolled_back' | 'move_failed';
  steps: MoveStep[];
  from: MovePlacement | null;
  to: MovePlacement | null;
  checkpoint: { id: string; savedWorkUnits: number; status: Checkpoint['status'] } | null;
  restart: { startedSimMs: number | null; dueSimMs: number | null; remainingMs: number | null } | null;
  /** Progress observed just before the work was dropped, and the durable work it fell back to. */
  progressAtMove: number | null;
  durableAtMove: number | null;
  /** progressAtMove − durableAtMove, only when both were observed. */
  lostWorkUnits: number | null;
  resumedSimMs: number | null;
  /** Floating label for the cluster arc: "job-a → R1+R5 · from checkpoint ckpt-job-a-2". */
  arcLabel: string | null;
}

export interface TimelineInput {
  snapshot: ObservedSnapshot | null;
  actionDetails: readonly ActionDetail[];
  jobTrail: Record<string, readonly JobTrailEntry[]>;
}

const ACTIVE = new Set(['requested', 'claimed', 'running']);
const DROP_FROM = new Set(['running', 'checkpointing', 'paused']);

const stringList = (value: unknown): string[] | null => (Array.isArray(value) && value.every((v) => typeof v === 'string') ? [...(value as string[])] : null);
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);
const placement = (gpuIds: readonly string[] | null | undefined): MovePlacement | null => (gpuIds && gpuIds.length ? { gpuIds: [...gpuIds], racks: racksOfGpus(gpuIds) } : null);

/** "R2+R3" for the placement chips and the arc label. */
export const rackChip = (racks: readonly number[]): string => (racks.length ? racks.map((n) => `R${n}`).join('+') : '—');

const latestOf = (details: readonly ActionDetail[]): ActionDetail | undefined =>
  [...details].sort((a, b) => b.status.updated_sim_time_ms - a.status.updated_sim_time_ms || b.history.length - a.history.length)[0];

/** The entry where this job's progress last fell back (status became failed or restarting from an active state). */
function dropEntry(trail: readonly JobTrailEntry[], upTo: number): JobTrailEntry | undefined {
  for (let i = Math.min(upTo, trail.length - 1); i >= 1; i--) {
    const entry = trail[i]!;
    if ((entry.status === 'failed' || entry.status === 'restarting') && DROP_FROM.has(trail[i - 1]!.status)) return entry;
  }
  return undefined;
}

export function jobMoveTimeline(jobId: string, input: TimelineInput): JobMoveTimeline | null {
  const snapshot = input.snapshot;
  if (!snapshot) return null;
  const job = snapshot.job_states.find((row) => row.job_id === jobId);
  if (!job) return null;
  const trail = input.jobTrail[jobId] ?? [];
  const details = input.actionDetails.filter((d) => d.command.job_id === jobId && d.command.run_id === snapshot.run_id);
  const migrate = latestOf(details.filter((d) => d.command.operation === 'migrate_restart' && d.status.status !== 'cancelled'));
  const destination = migrate ? stringList(migrate.command.arguments.destination_gpu_ids) : null;
  const to = placement(destination ?? (job.status === 'restarting' ? job.allocated_gpu_ids : null));
  const onDestination = to !== null && sameSet(job.allocated_gpu_ids, to.gpuIds);

  const moveRequested = Boolean(migrate && ACTIVE.has(migrate.status.status));
  const moveStarted = job.status === 'restarting' || (onDestination && job.status === 'running' && migrate?.status.status === 'succeeded');
  const moveDone = moveStarted && job.status === 'running';
  const moveFailed = Boolean(migrate && migrate.status.status === 'failed' && migrate.status.reason_code !== 'SAFETY_REJECTED' && !onDestination);
  const checkpointWriting = snapshot.checkpoints.find((c) => c.job_id === jobId && c.status === 'writing');
  const checkpointActive = job.status === 'checkpointing' || Boolean(checkpointWriting) || details.some((d) => d.command.operation === 'checkpoint' && ACTIVE.has(d.status.status));

  let kind: JobMoveTimeline['kind'];
  if (moveRequested || moveStarted || moveFailed) kind = 'move';
  else if (job.status === 'failed') kind = 'rollback';
  else if (checkpointActive) kind = 'move';
  else return null;

  // Where the job came from: the trail entry before it landed on the destination; before the move starts, its current GPUs.
  const landingIndex = to ? trail.findIndex((e, i) => sameSet(e.gpu_ids, to.gpuIds) && (i === 0 ? false : !sameSet(trail[i - 1]!.gpu_ids, e.gpu_ids))) : -1;
  const restartIndex = landingIndex >= 0 && trail[landingIndex]!.status === 'restarting' ? landingIndex : trail.findIndex((e, i) => e.status === 'restarting' && i > 0 && trail[i - 1]!.status !== 'restarting');
  const restartEntry = restartIndex >= 0 ? trail[restartIndex] : undefined;
  let from: MovePlacement | null = null;
  if (moveStarted) {
    const upTo = landingIndex >= 0 ? landingIndex : restartIndex;
    for (let i = upTo - 1; i >= 0; i--) { const gpus = trail[i]!.gpu_ids; if (gpus.length && (!to || !sameSet(gpus, to.gpuIds))) { from = placement(gpus); break; } }
  } else {
    from = placement(job.allocated_gpu_ids) ?? placement([...trail].reverse().find((e) => e.gpu_ids.length > 0)?.gpu_ids);
  }

  // The checkpoint the restart reads: the row being written, else the job's latest complete checkpoint.
  const latestRow = job.latest_checkpoint_id ? snapshot.checkpoints.find((c) => c.checkpoint_id === job.latest_checkpoint_id) : undefined;
  const checkpointRow = checkpointWriting ?? latestRow;
  const checkpointDetail = latestOf(details.filter((d) => d.command.operation === 'checkpoint'));
  const checkpointFailed = !checkpointWriting && checkpointDetail?.status.status === 'failed' && (!latestRow || (latestRow.complete_sim_time_ms ?? 0) < checkpointDetail.status.updated_sim_time_ms);
  const checkpoint = checkpointRow ? { id: checkpointRow.checkpoint_id, savedWorkUnits: checkpointRow.progress_work_units, status: checkpointRow.status } : null;

  // Work at the drop: the snapshot just before the job failed or restarted; before any drop, the current figures.
  const drop = dropEntry(trail, trail.length - 1);
  const dropped = Boolean(drop) && (moveStarted || job.status === 'failed');
  const progressAtMove = dropped ? drop!.progress_before : job.status === 'failed' || moveStarted ? null : job.progress_work_units;
  const durableAtMove = dropped ? drop!.durable : job.status === 'failed' || moveStarted ? null : job.durable_work_units;
  const lostWorkUnits = dropped && progressAtMove !== null && progressAtMove >= durableAtMove! ? progressAtMove - durableAtMove! : null;
  const atRisk = !dropped && progressAtMove !== null && durableAtMove !== null ? Math.max(0, progressAtMove - durableAtMove) : null;

  const resumedSimMs = restartIndex >= 0 ? trail.slice(restartIndex + 1).find((e) => e.status === 'running')?.sim_time_ms ?? null : null;
  const dueSimMs = migrate?.due_sim_time_ms ?? null;
  const restart = moveStarted || moveRequested ? {
    startedSimMs: restartEntry?.sim_time_ms ?? null,
    dueSimMs,
    remainingMs: job.status === 'restarting' && dueSimMs !== null ? Math.max(0, dueSimMs - snapshot.clock.sim_time_ms) : null,
  } : null;

  const wu = (value: number) => `${number(value)} wu`;
  const shortId = (id: string) => (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-9)}` : id);
  const fromTo = `${from ? rackChip(from.racks) : '—'} → ${to ? rackChip(to.racks) : '—'}`;
  const checkpointStep: MoveStep = checkpointWriting
    ? { id: 'checkpoint', label: 'Checkpoint writing', detail: `${shortId(checkpointWriting.checkpoint_id)} · ${wu(checkpointWriting.progress_work_units)} to save`, state: 'active' }
    : checkpointFailed ? { id: 'checkpoint', label: 'Checkpoint failed', detail: checkpoint ? `last durable ${shortId(checkpoint.id)} · ${wu(checkpoint.savedWorkUnits)}` : null, state: 'failed' }
    : checkpoint ? { id: 'checkpoint', label: kind === 'rollback' ? 'Rolled back to checkpoint' : 'Checkpoint saved', detail: `${shortId(checkpoint.id)} · ${wu(checkpoint.savedWorkUnits)} saved`, state: 'done' }
    : { id: 'checkpoint', label: 'No checkpoint', detail: kind === 'rollback' ? 'restart from scratch' : null, state: kind === 'rollback' ? 'done' : 'pending' };

  const atRiskStep: MoveStep = kind === 'rollback' || (dropped && drop!.status === 'failed')
    ? { id: 'at_risk', label: 'GPU failed', detail: lostWorkUnits !== null ? `lost ${wu(lostWorkUnits)} since the last checkpoint` : null, state: 'done' }
    : { id: 'at_risk', label: 'At risk', detail: atRisk !== null ? `${wu(atRisk)} at risk` : progressAtMove !== null && durableAtMove !== null ? `${wu(progressAtMove)} done · ${wu(durableAtMove)} saved` : null, state: 'done' };

  const movingStep: MoveStep = {
    id: 'moving', label: 'Moving',
    detail: to ? fromTo : kind === 'rollback' ? 'awaiting a recovery plan' : 'no move requested yet',
    state: moveStarted ? 'done' : moveRequested ? 'active' : moveFailed ? 'failed' : 'pending',
  };
  const restartingStep: MoveStep = {
    id: 'restarting', label: 'Restarting',
    detail: job.status === 'restarting' && restart?.remainingMs !== null && restart?.remainingMs !== undefined ? `${Math.ceil(restart.remainingMs / 1000)} s left (ledger due time)` : moveFailed ? migrate?.status.reason_code ?? 'failed' : null,
    state: job.status === 'restarting' ? 'active' : moveDone ? 'done' : moveFailed ? 'failed' : 'pending',
  };
  const runningStep: MoveStep = {
    id: 'running', label: 'Running on new GPUs',
    detail: moveDone ? `Resumed from ${checkpoint ? `checkpoint ${checkpoint.id} (${wu(checkpoint.savedWorkUnits)} saved)` : 'scratch'}${lostWorkUnits !== null ? ` · lost ${wu(lostWorkUnits)}` : ''}` : null,
    state: moveDone ? 'done' : 'pending',
  };

  const phase: JobMoveTimeline['phase'] = moveDone ? 'running' : job.status === 'restarting' ? 'restarting' : moveFailed ? 'move_failed' : moveRequested ? 'moving' : kind === 'rollback' ? 'rolled_back' : checkpointActive ? 'checkpoint' : 'at_risk';
  return {
    jobId, kind, phase,
    steps: [atRiskStep, checkpointStep, movingStep, restartingStep, runningStep],
    from, to, checkpoint, restart, progressAtMove, durableAtMove, lostWorkUnits, resumedSimMs,
    arcLabel: to ? `${jobId} → ${rackChip(to.racks)} · ${checkpoint ? `from checkpoint ${checkpoint.id}` : 'no checkpoint'}` : null,
  };
}

/** Timelines for every job in the snapshot that has a recovery story right now. */
export const jobMoveTimelines = (input: TimelineInput): JobMoveTimeline[] =>
  (input.snapshot?.job_states ?? []).map((job: JobState) => jobMoveTimeline(job.job_id, input)).filter((t): t is JobMoveTimeline => t !== null);
