import type { GpuCurrent, ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail } from '@dcos/db-client';
import { degradedPumps, racksOfGpus } from './topology';

const THROTTLE_BIT = 0x20;
const ACTIVE_OR_DONE = new Set(['requested', 'claimed', 'running', 'succeeded']);

export type ImpactTone = 'neutral' | 'warning' | 'danger' | 'agent';
export interface ImpactStat { id: string; value: number; label: string; tone: ImpactTone; title: string }

export interface ClusterImpact {
  pumpsDegraded: number;
  racksHot: number;
  gpusFailed: number;
  jobsProtected: number;
  jobsTotal: number;
  unsafeMovesBlocked: number;
}

const isSim = (gpu: GpuCurrent) => gpu.resource_id !== 'gpu-real-0';
const isFailed = (gpu: GpuCurrent) => gpu.availability !== 'ready' || gpu.last_xid_code !== null;
const isHotOrThrottled = (gpu: GpuCurrent) => gpu.temp_c >= 85 || (gpu.clocks_event_reasons & THROTTLE_BIT) !== 0;

/** A safety deny is persisted as a failed action with reason SAFETY_REJECTED: the move was BLOCKED, not executed. */
export const isBlockedBySafety = (detail: ActionDetail): boolean => detail.status.status === 'failed' && detail.status.reason_code === 'SAFETY_REJECTED';

/**
 * A job counts as protected when its training work is not in jeopardy: it is running, checkpointing or done, or a
 * recovery action for it is under way / has succeeded (moving or restarting with a plan behind it). Failed and
 * paused jobs with nothing in flight are not protected.
 */
export function isJobProtected(job: ObservedSnapshot['job_states'][number], details: readonly ActionDetail[]): boolean {
  if (job.status === 'running' || job.status === 'checkpointing' || job.status === 'completed') return true;
  if (job.status === 'failed' || job.status === 'paused') return false;
  return details.some((d) => d.command.job_id === job.job_id && ACTIVE_OR_DONE.has(d.status.status));
}

/** Counts behind the impact row; pure, derived only from observed data and the typed ledger projection. */
export function clusterImpact(snapshot: ObservedSnapshot, details: readonly ActionDetail[] = []): ClusterImpact {
  const gpus = snapshot.gpus.filter(isSim);
  return {
    pumpsDegraded: degradedPumps(snapshot).length,
    racksHot: racksOfGpus(gpus.filter(isHotOrThrottled).map((gpu) => gpu.resource_id)).length,
    gpusFailed: gpus.filter(isFailed).length,
    jobsProtected: snapshot.job_states.filter((job) => isJobProtected(job, details)).length,
    jobsTotal: snapshot.job_states.length,
    unsafeMovesBlocked: details.filter(isBlockedBySafety).length,
  };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The five tiles in display order with plain-word labels and the tone each number earns. */
export function impactStats(impact: ClusterImpact): ImpactStat[] {
  return [
    { id: 'pumps', value: impact.pumpsDegraded, label: `${plural(impact.pumpsDegraded, 'pump', 'pumps')} degraded`, tone: impact.pumpsDegraded ? 'warning' : 'neutral', title: 'Cooling pumps whose operating state is not normal (simulated).' },
    { id: 'racks', value: impact.racksHot, label: `${plural(impact.racksHot, 'rack', 'racks')} hot`, tone: impact.racksHot ? 'warning' : 'neutral', title: 'Racks with a GPU at 85 °C or above, or thermally throttled (simulated).' },
    { id: 'gpus', value: impact.gpusFailed, label: `${plural(impact.gpusFailed, 'GPU', 'GPUs')} failed`, tone: impact.gpusFailed ? 'danger' : 'neutral', title: 'Simulated GPUs that are not ready or reported an XID error.' },
    { id: 'jobs', value: impact.jobsProtected, label: `of ${impact.jobsTotal} ${plural(impact.jobsTotal, 'job', 'jobs')} protected`, tone: impact.jobsProtected < impact.jobsTotal ? 'danger' : 'agent', title: 'Jobs running, checkpointing, done, or with a recovery action in flight or succeeded.' },
    { id: 'blocked', value: impact.unsafeMovesBlocked, label: `unsafe ${plural(impact.unsafeMovesBlocked, 'move', 'moves')} blocked`, tone: impact.unsafeMovesBlocked ? 'agent' : 'neutral', title: 'Actions the safety check rejected (status failed, reason SAFETY_REJECTED). None of them ran.' },
  ];
}
