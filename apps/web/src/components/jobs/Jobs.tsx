import { useEffect, useRef } from 'react';
import { LockKeyhole, ShieldCheck, ArrowRight } from 'lucide-react';
import type { ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail } from '@dcos/db-client';
import type { DashboardState } from '../../data/dashboard';
import { CHECKPOINT_DURATION_MS } from '@dcos/physics';
import { Panel, Badge } from '../ui/panel';
import { duration, fraction, number } from '../../lib/utils';
import { racksOfGpus } from '../simulation/topology';
import './jobs.css';
const ACTIVE = new Set(['requested', 'claimed', 'running']);
const RING_R = 15; const RING_C = 2 * Math.PI * RING_R; const BUMP_MS = 700;
const rackOf = (ids: string[]) => racksOfGpus(ids).map((n) => `R${n}`).join(' + ');
/** A running action for this job, from the typed ledger projection (never from command-key text). */
const activeAction = (details: ActionDetail[], jobId: string, operation: string) =>
  details.find((d) => d.command.job_id === jobId && d.command.operation === operation && ACTIVE.has(d.status.status));
/** Quiet view: one ring per job (durable = full job colour, work = tint), two numbers (percent worked, durable units). */
export function Jobs({ snapshot, losses, history, details = [] }: { snapshot: ObservedSnapshot; losses: DashboardState['losses']; history: DashboardState['jobHistory']; details?: ActionDetail[] }) {
  const legacyClock = snapshot.checkpoints.some((c) => c.complete_sim_time_ms === 0 && c.command_key.startsWith('preset.'));
  // Checkpoint flourish: when a job's durable work grows between snapshots, its ring pulses once (DOM class, no per-job state).
  const rootRef = useRef<HTMLDivElement>(null);
  const prevDurable = useRef<{ runKey: string; durable: Map<string, number> } | null>(null);
  useEffect(() => {
    const durable = new Map(snapshot.job_states.map((job) => [job.job_id, job.durable_work_units]));
    const prev = prevDurable.current; prevDurable.current = { runKey: snapshot.run_id, durable };
    if (!prev || prev.runKey !== snapshot.run_id || !rootRef.current) return;
    for (const [jobId, value] of durable) {
      const before = prev.durable.get(jobId);
      if (before === undefined || value <= before) continue;
      const ring = rootRef.current.querySelector(`[data-job-ring="${jobId}"]`);
      ring?.classList.add('is-bumping');
      window.setTimeout(() => ring?.classList.remove('is-bumping'), BUMP_MS);
    }
  }, [snapshot]);
  return <Panel title="Training jobs" id="jobs" detail={<Badge tone="simulated">Simulated</Badge>}>
    <div className="jobs-legend"><span><i className="progress-key"/>Work in progress</span><span><ShieldCheck size={13}/>Durable checkpoint</span></div>
    <div className="jobs-list" ref={rootRef}>{snapshot.job_states.map((job) => {
      const spec = snapshot.job_specs.find((s) => s.job_id === job.job_id);
      const checkpoint = snapshot.checkpoints.find((c) => c.checkpoint_id === job.latest_checkpoint_id);
      const writing = snapshot.checkpoints.find((c) => c.job_id === job.job_id && c.status === 'writing');
      const total = spec?.total_work_units ?? 0;
      const durablePct = fraction(job.durable_work_units, total); const workPct = fraction(job.progress_work_units, total);
      const ageText = checkpoint ? legacyClock ? 'age unavailable' : `${duration(snapshot.clock.sim_time_ms - (checkpoint.complete_sim_time_ms ?? snapshot.clock.sim_time_ms))} old` : 'no checkpoint';
      const title = `${job.job_id} · ${number(job.progress_work_units)} / ${number(total)} work units · ${number(job.durable_work_units)} durable · ${spec?.gpus_required ?? '—'} GPUs · checkpoint ${ageText}`;
      return <article className={`job ${job.job_id} is-${job.status}`} key={job.job_id} title={title}>
        <div className="job-heading">
          <div className="job-ring-wrap" role="progressbar" aria-label={`${job.job_id} simulated training progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(workPct)} aria-valuetext={`${number(workPct, 1)} percent worked, ${number(durablePct, 1)} percent checkpointed`}>
            <svg className="job-ring" data-job-ring={job.job_id} viewBox="0 0 36 36" aria-hidden="true">
              <circle className="job-ring-track" cx="18" cy="18" r={RING_R}/>
              <circle className="job-ring-work" cx="18" cy="18" r={RING_R} strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - Math.min(1, workPct / 100))}/>
              <circle className="job-ring-durable" cx="18" cy="18" r={RING_R} strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - Math.min(1, durablePct / 100))}/>
            </svg>
            <strong className="job-ring-value" aria-hidden="true">{number(workPct, 0)}<small>%</small></strong>
          </div>
          <div className="job-copy">
            <h3><i/>{job.job_id}</h3>
            <div className="job-meta"><span>{rackOf(job.allocated_gpu_ids) || 'No allocation'}</span>{spec && !spec.preemptible && <span><LockKeyhole size={11}/>Non-preemptible</span>}</div>
            <div className="checkpoint-line"><span><ShieldCheck size={13}/>{number(job.durable_work_units)} durable</span></div>
          </div>
          <Badge tone={job.status === 'failed' ? 'danger' : job.status === 'checkpointing' || job.status === 'restarting' ? 'warning' : 'neutral'}>{job.status}</Badge>
        </div>
        {writing && <p className="job-notice">Checkpoint writing · not durable yet{(() => { const due = activeAction(details, job.job_id, 'checkpoint')?.due_sim_time_ms ?? writing.requested_sim_time_ms + CHECKPOINT_DURATION_MS; const left = due - snapshot.clock.sim_time_ms; return left > 0 ? ` · about ${duration(left)} left (estimate)` : ' · completion not yet observed'; })()}</p>}
        {(() => { const failed = snapshot.checkpoints.filter((c) => c.job_id === job.job_id && c.status === 'failed').at(-1); return failed && !writing ? <p className="job-loss">Latest checkpoint attempt failed; durable work unchanged</p> : null; })()}
        {job.status === 'restarting' && (() => { const move = activeAction(details, job.job_id, 'migrate_restart'); const left = move?.due_sim_time_ms != null ? move.due_sim_time_ms - snapshot.clock.sim_time_ms : null; return <p className="job-notice">Restarting on {rackOf(job.allocated_gpu_ids) || 'an unreported destination'}{left !== null ? left > 0 ? ` · about ${duration(left)} left (estimate)` : ' · completion not yet observed' : ''} · not verified</p>; })()}
        {(losses[job.job_id] ?? 0) > 0 && <p className="job-loss">{number(losses[job.job_id])} work units lost since this view opened</p>}
        {(history[job.job_id]?.length ?? 0) > 1 && <div className="job-history" aria-label={`${job.job_id} observed status history`}>{history[job.job_id]?.map((entry, i) => <span key={`${entry.sim_time_ms}-${i}`} title={duration(entry.sim_time_ms)}>{i > 0 && <ArrowRight size={11}/>}<span>{entry.status}</span></span>)}</div>}
      </article>;
    })}</div>{legacyClock && <p className="panel-footnote">Current mock fixtures use a legacy zero clock; checkpoint ages are unavailable.</p>}
  </Panel>;
}
