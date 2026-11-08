import type { JobState, ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail, PlanRecord, WorkflowRecord } from '@dcos/db-client';
import { racksOfGpus } from '../simulation/topology';

/** Pure derivations behind the Jobs page. Nothing here reads the DOM or invents a number the data does not carry. */

export type JobStatus = JobState['status'];
export type Decider = 'nemotron' | 'code' | 'agent';

export interface JobDecision {
  /** Option kind as persisted (`checkpoint_then_migrate`, `keep_running`, …) or derived from a plan's operations. */
  option: string;
  /** Plain words for the option. */
  label: string;
  /** One-line reason, as the planner recorded it (clipped by the agent, not here). */
  reason: string;
  decidedBy: Decider;
  /** Sim time the decision was taken at, when known; used to pick the latest. */
  asOfSimMs: number | null;
}

/** Short label for a job id: `job-a` → `Job A`; anything else is shown as written. */
export const jobName = (jobId: string): string => { const m = /^job-([a-z0-9]+)$/i.exec(jobId); return m ? `Job ${m[1]!.toUpperCase()}` : jobId; };

/** `job-a` → `a`, for the `--job-a` colour hook. */
export const jobKey = (jobId: string): string => jobId.replace(/^job-/, '');

/** Work done since the last durable checkpoint: what would be lost if the job failed right now. Never negative. */
export const workAtRisk = (job: Pick<JobState, 'progress_work_units' | 'durable_work_units'>): number => Math.max(0, job.progress_work_units - job.durable_work_units);

/** One word for the status chip. `restarting` reads as "moving" because that is what the operator sees on the racks. */
export const statusLabel = (status: JobStatus): string => ({ running: 'running', checkpointing: 'checkpointing', restarting: 'moving', failed: 'failed', completed: 'done', paused: 'paused', queued: 'queued' })[status] ?? status;

export const statusTone = (status: JobStatus): 'neutral' | 'warning' | 'danger' | 'agent' =>
  status === 'failed' ? 'danger' : status === 'checkpointing' || status === 'restarting' || status === 'paused' ? 'warning' : status === 'completed' ? 'agent' : 'neutral';

const OPTION_LABELS: Record<string, string> = {
  keep_running: 'Keep running',
  power_cap: 'Cap power, keep running',
  checkpoint: 'Checkpoint now',
  checkpoint_then_migrate: 'Checkpoint, then move',
  migrate_restart: 'Move to other racks',
  pause_job: 'Pause',
  escalate: 'Escalate to a human',
  cordon_gpu: 'Cordon the GPU',
  uncordon_gpu: 'Return the GPU to service',
};

export const optionLabel = (option: string): string => OPTION_LABELS[option] ?? option.split('+').map((part) => OPTION_LABELS[part] ?? part.replaceAll('_', ' ')).join(', then ');

/** Option kind from a list of operations, the way the agent's planner names them. */
export function optionFromOperations(operations: readonly string[]): string {
  if (operations.length === 0) return 'keep_running';
  if (operations.includes('migrate_restart')) return operations.includes('checkpoint') ? 'checkpoint_then_migrate' : 'migrate_restart';
  if (operations.includes('pause_job')) return 'pause_job';
  if (operations.length === 1) return operations[0]!;
  return [...new Set(operations)].join('+');
}

interface PersistedCandidateLike { job_id?: unknown; option_id?: unknown; candidate_id?: unknown; option?: unknown; chosen?: unknown; reason?: unknown; decided_by?: unknown; as_of_sim_time_ms?: unknown }

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const decider = (value: unknown): Decider => (value === 'nemotron' || value === 'code' ? value : 'agent');

/** Candidates persisted on any workflow of this run (`state.candidates`), tolerating unknown shapes. */
export function persistedCandidates(workflows: readonly Pick<WorkflowRecord, 'state'>[]): PersistedCandidateLike[] {
  return workflows.flatMap((wf) => { const list = wf.state?.candidates; return Array.isArray(list) ? (list as PersistedCandidateLike[]).filter((c) => typeof c === 'object' && c !== null) : []; });
}

/** A candidate belongs to a job when its `job_id` matches or its option/candidate id starts with the job id. */
const candidateIsFor = (c: PersistedCandidateLike, jobId: string): boolean =>
  c.job_id === jobId || (str(c.option_id) ?? str(c.candidate_id) ?? '').startsWith(`${jobId}:`) || (str(c.option_id) ?? str(c.candidate_id) ?? '').startsWith(`${jobId}-`);

/**
 * What the agent decided for one job, newest first: the chosen persisted candidate when the workflow recorded one;
 * otherwise the latest plan whose commands target the job (its explanation is the reason, the actor is unknown → "agent").
 * Null when nothing was recorded for the job: the card then says so instead of guessing.
 */
export function decisionFor(jobId: string, workflows: readonly Pick<WorkflowRecord, 'state'>[], plans: readonly PlanRecord[] = [], details: readonly ActionDetail[] = []): JobDecision | null {
  const chosen = persistedCandidates(workflows).filter((c) => c.chosen === true && candidateIsFor(c, jobId));
  const latest = chosen.sort((a, b) => (num(b.as_of_sim_time_ms) ?? -1) - (num(a.as_of_sim_time_ms) ?? -1))[0];
  if (latest) {
    const option = str(latest.option) ?? 'keep_running';
    return { option, label: optionLabel(option), reason: str(latest.reason) ?? '', decidedBy: decider(latest.decided_by), asOfSimMs: num(latest.as_of_sim_time_ms) };
  }
  // Fallback: plans whose command keys include an action for this job (typed ledger projection, never key text).
  const keysForJob = new Set(details.filter((d) => d.command.job_id === jobId).map((d) => d.command.command_key));
  const byPlan = new Map(details.map((d) => [d.command.command_key, d]));
  const matching = plans.filter((plan) => plan.command_keys.some((key) => keysForJob.has(key))).sort((a, b) => b.based_on_decision_epoch - a.based_on_decision_epoch);
  const plan = matching[0];
  if (!plan) return null;
  const operations: string[] = plan.command_keys.flatMap((key) => { const op = byPlan.get(key)?.command.operation; return op ? [op] : []; });
  const option = optionFromOperations(operations);
  return { option, label: optionLabel(option), reason: plan.explanation, decidedBy: 'agent', asOfSimMs: null };
}

export interface Placement { racks: number[]; text: string }

/** `[2,3]` → "Racks 2 and 3"; `[4]` → "Rack 4"; `[]` → "No GPUs assigned". */
export function placementText(racks: readonly number[]): string {
  if (racks.length === 0) return 'No GPUs assigned';
  if (racks.length === 1) return `Rack ${racks[0]}`;
  const sorted = [...racks].sort((a, b) => a - b);
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1]! + 1);
  if (contiguous) return `Racks ${sorted[0]}–${sorted.at(-1)}`;
  return `Racks ${sorted.slice(0, -1).join(', ')} and ${sorted.at(-1)}`;
}

export const placementOf = (job: Pick<JobState, 'allocated_gpu_ids'>): Placement => { const racks = racksOfGpus(job.allocated_gpu_ids); return { racks, text: placementText(racks) }; };

/** The checkpoint being written for a job right now, if any (status `writing`). */
export const writingCheckpoint = (snapshot: Pick<ObservedSnapshot, 'checkpoints'>, jobId: string) => snapshot.checkpoints.find((c) => c.job_id === jobId && c.status === 'writing');

/** Whether the latest checkpoint attempt for a job failed and nothing newer is being written. */
export const lastCheckpointFailed = (snapshot: Pick<ObservedSnapshot, 'checkpoints'>, jobId: string): boolean => {
  const rows = snapshot.checkpoints.filter((c) => c.job_id === jobId);
  const last = rows.at(-1);
  return Boolean(last && last.status === 'failed' && !rows.some((c) => c.status === 'writing'));
};
