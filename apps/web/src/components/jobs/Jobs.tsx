import { useEffect, useRef, useState } from 'react';
import { ArrowRight, LockKeyhole, ShieldCheck } from 'lucide-react';
import type { ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail, PlanRecord, WorkflowRecord } from '@dcos/db-client';
import { CHECKPOINT_DURATION_MS } from '@dcos/physics';
import type { DashboardState } from '../../data/dashboard';
import { Panel, Badge } from '../ui/panel';
import { duration, fraction, number } from '../../lib/utils';
import { detectMoves, jobRacks, type JobMove } from '../simulation/topology';
import { decisionFor, jobKey, jobName, lastCheckpointFailed, placementOf, placementText, statusLabel, statusTone, workAtRisk, writingCheckpoint } from './job-view';
import './jobs.css';

const ACTIVE = new Set(['requested', 'claimed', 'running']);
const BUMP_MS = 700; const MOVE_MS = 2400;
/** A running action for this job, from the typed ledger projection (never from command-key text). */
const activeAction = (details: readonly ActionDetail[], jobId: string, operation: string) =>
  details.find((d) => d.command.job_id === jobId && d.command.operation === operation && ACTIVE.has(d.status.status));

type Props = {
  snapshot: ObservedSnapshot;
  losses: DashboardState['losses'];
  history: DashboardState['jobHistory'];
  details?: ActionDetail[];
  workflows?: WorkflowRecord[];
  plans?: PlanRecord[];
  /** Scripted recovery example: label every decision as an EXAMPLE. */
  example?: boolean;
  /** Local physics preview: no agent runs, so the decision slot says why it is empty. */
  localPhysics?: boolean;
};

/** One card per training job: progress vs durable work, where it runs, what is at risk, and what the agent decided. */
export function Jobs({ snapshot, losses, history, details = [], workflows = [], plans = [], example = false, localPhysics = false }: Props) {
  const legacyClock = snapshot.checkpoints.some((c) => c.complete_sim_time_ms === 0 && c.command_key.startsWith('preset.'));
  const rootRef = useRef<HTMLDivElement>(null);

  // Checkpoint flourish: when a job's durable work grows between snapshots, its shield pulses once (DOM class, no per-job state).
  const prevDurable = useRef<{ runKey: string; durable: Map<string, number> } | null>(null);
  useEffect(() => {
    const durable = new Map(snapshot.job_states.map((job) => [job.job_id, job.durable_work_units]));
    const prev = prevDurable.current; prevDurable.current = { runKey: snapshot.run_id, durable };
    if (!prev || prev.runKey !== snapshot.run_id || !rootRef.current) return;
    for (const [jobId, value] of durable) {
      const before = prev.durable.get(jobId);
      if (before === undefined || value <= before) continue;
      const el = rootRef.current.querySelector(`[data-job-shield="${jobId}"]`);
      el?.classList.add('is-bumping');
      window.setTimeout(() => el?.classList.remove('is-bumping'), BUMP_MS);
    }
  }, [snapshot]);

  // Job moves: the rack set changed between consecutive snapshots → show "from racks … → …" on the card for a moment.
  const prevRacks = useRef<{ runKey: string; racks: Record<string, number[]> } | null>(null);
  const [moves, setMoves] = useState<Record<string, JobMove>>({});
  useEffect(() => {
    const racks = jobRacks(snapshot.allocations);
    const prev = prevRacks.current; prevRacks.current = { runKey: snapshot.run_id, racks };
    if (!prev || prev.runKey !== snapshot.run_id) { if (prev && prev.runKey !== snapshot.run_id) setMoves({}); return; }
    const found = detectMoves(prev.racks, racks);
    if (found.length === 0) return;
    setMoves((current) => ({ ...current, ...Object.fromEntries(found.map((move) => [move.jobId, move])) }));
    const ids = found.map((move) => move.jobId);
    window.setTimeout(() => setMoves((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id)))), MOVE_MS);
  }, [snapshot]);

  return <Panel title="Training jobs" id="jobs" detail={<span className="jobs-badges"><Badge tone="simulated">Simulated</Badge>{example && <Badge tone="example">Example</Badge>}</span>}>
    <div className="jobs-legend"><span><i className="jobs-key jobs-key-work"/>Work done</span><span><i className="jobs-key jobs-key-durable"/>Checkpointed, safe</span></div>
    <div className="jobs-grid" ref={rootRef}>{snapshot.job_states.map((job) => {
      const spec = snapshot.job_specs.find((s) => s.job_id === job.job_id);
      const total = spec?.total_work_units ?? 0;
      const workPct = fraction(job.progress_work_units, total); const durablePct = fraction(job.durable_work_units, total);
      const atRisk = workAtRisk(job); const lost = losses[job.job_id] ?? 0;
      const writing = writingCheckpoint(snapshot, job.job_id);
      const placement = placementOf(job); const move = moves[job.job_id];
      const moving = job.status === 'restarting' || Boolean(activeAction(details, job.job_id, 'migrate_restart'));
      const decision = decisionFor(job.job_id, workflows, plans, details);
      const checkpoint = snapshot.checkpoints.find((c) => c.checkpoint_id === job.latest_checkpoint_id);
      const ageText = checkpoint ? legacyClock ? 'age unavailable' : `${duration(snapshot.clock.sim_time_ms - (checkpoint.complete_sim_time_ms ?? snapshot.clock.sim_time_ms))} old` : 'no checkpoint yet';
      const title = `${job.job_id} · ${number(job.progress_work_units)} of ${number(total)} work units done · ${number(job.durable_work_units)} checkpointed · ${spec?.gpus_required ?? '—'} GPUs on ${job.allocated_gpu_ids.join(', ') || 'no GPUs'} · checkpoint ${ageText}`;
      const checkpointLeft = writing ? (activeAction(details, job.job_id, 'checkpoint')?.due_sim_time_ms ?? writing.requested_sim_time_ms + CHECKPOINT_DURATION_MS) - snapshot.clock.sim_time_ms : null;
      const moveAction = activeAction(details, job.job_id, 'migrate_restart');
      const moveLeft = moveAction?.due_sim_time_ms != null ? moveAction.due_sim_time_ms - snapshot.clock.sim_time_ms : null;
      return <article className={`jobcard job-${jobKey(job.job_id)} is-${job.status} ${moving ? 'is-moving' : ''}`} key={job.job_id} title={title} aria-label={`${jobName(job.job_id)}, ${statusLabel(job.status)}`}>
        <header className="jobcard-head">
          <h3><i aria-hidden="true"/>{jobName(job.job_id)}</h3>
          {spec && !spec.preemptible && <span className="jobcard-lock" title="Non-preemptible: the agent may not pause or move it without a checkpoint first"><LockKeyhole size={12} aria-hidden="true"/></span>}
          <Badge tone={statusTone(job.status)}>{statusLabel(job.status)}</Badge>
        </header>

        <div className="jobcard-progress" role="progressbar" aria-label={`${jobName(job.job_id)} simulated training progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(workPct)} aria-valuetext={`${number(workPct, 0)} percent done, ${number(durablePct, 0)} percent checkpointed`}>
          <i className="jobcard-bar-work" style={{ transform: `scaleX(${Math.min(1, workPct / 100)})` }}/>
          <i className="jobcard-bar-durable" style={{ transform: `scaleX(${Math.min(1, durablePct / 100)})` }}/>
        </div>
        <div className="jobcard-progress-row">
          <strong>{number(workPct, 0)}<small>% done</small></strong>
          <span className={`jobcard-shield ${job.status === 'checkpointing' || writing ? 'is-writing' : ''}`} data-job-shield={job.job_id} title={`Durable work: ${number(job.durable_work_units)} units · checkpoint ${ageText}`}>
            <ShieldCheck size={13} aria-hidden="true"/>{job.status === 'checkpointing' || writing ? 'writing checkpoint' : `${number(durablePct, 0)}% safe`}
          </span>
        </div>

        <p className={`jobcard-risk ${atRisk > 0 && job.status !== 'completed' ? 'is-at-risk' : 'is-safe'}`}>
          {job.status === 'completed' ? 'Finished · all work checkpointed' : job.status === 'failed' ? 'Stopped · rolled back to the last checkpoint' : atRisk > 0 ? <><strong>{number(atRisk)}</strong> work units at risk since the last checkpoint</> : 'Nothing at risk · all work checkpointed'}
        </p>
        {lost > 0 && <p className="jobcard-lost"><strong>{number(lost)}</strong> work units lost since this view opened</p>}

        <p className="jobcard-place">
          {move ? <span className="jobcard-move" title={`Moved from ${placementText(move.from).toLowerCase()} to ${placementText(move.to).toLowerCase()}`}><span>{placementText(move.from)}</span><ArrowRight size={12} aria-hidden="true"/><span>{placementText(move.to)}</span></span>
            : <span>{placement.text}</span>}
          {moving && !move && <em className="jobcard-moving">moving{moveLeft !== null && moveLeft > 0 ? ` · about ${duration(moveLeft)} left (estimate)` : ''}</em>}
        </p>

        {writing && <p className="jobcard-note">Writing a checkpoint · not safe until it completes{checkpointLeft !== null && checkpointLeft > 0 ? ` · about ${duration(checkpointLeft)} left (estimate)` : ''}</p>}
        {!writing && lastCheckpointFailed(snapshot, job.job_id) && <p className="jobcard-note is-danger">Latest checkpoint attempt failed · safe work unchanged</p>}

        <div className="jobcard-decision">
          {decision ? <>
            <span className="jobcard-decision-head"><Badge tone={example ? 'example' : decision.decidedBy === 'nemotron' ? 'nemotron' : decision.decidedBy === 'code' ? 'code' : 'agent'}>{example ? 'Example' : decision.decidedBy === 'nemotron' ? 'Nemotron' : decision.decidedBy === 'code' ? 'Code' : 'Agent'}</Badge><strong>{decision.label}</strong></span>
            {decision.reason && <span className="jobcard-reason" title={decision.reason}>{decision.reason}</span>}
          </> : <span className="jobcard-reason is-none">{localPhysics ? 'No agent runs in the local physics preview' : 'No agent decision recorded for this job'}</span>}
        </div>
        {(history[job.job_id]?.length ?? 0) > 1 && <details className="jobcard-history"><summary>Status history</summary><ol aria-label={`${jobName(job.job_id)} observed status history`}>{history[job.job_id]?.map((entry, i) => <li key={`${entry.sim_time_ms}-${i}`}><span>{statusLabel(entry.status as never)}</span><time>{duration(entry.sim_time_ms)}</time></li>)}</ol></details>}
      </article>;
    })}</div>
    {legacyClock && <p className="panel-footnote">Current mock fixtures use a legacy zero clock; checkpoint ages are unavailable.</p>}
  </Panel>;
}
