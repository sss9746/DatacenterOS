import { LockKeyhole, ShieldCheck, ArrowRight } from 'lucide-react';
import type { ObservedSnapshot } from '@dcos/contracts';
import type { DashboardState } from '../../data/dashboard';
import { Panel, Badge } from '../ui/panel';
import { duration, fraction, number } from '../../lib/utils';
export function Jobs({ snapshot, losses, history }: { snapshot: ObservedSnapshot; losses: DashboardState['losses']; history: DashboardState['jobHistory'] }) {
  const legacyClock = snapshot.checkpoints.some((c) => c.complete_sim_time_ms === 0 && c.command_key.startsWith('preset.'));
  return <Panel title="Training jobs" id="jobs" detail={<Badge>Simulated</Badge>}>
    <div className="jobs-legend"><span><i className="progress-key"/>Work in progress</span><span><ShieldCheck size={13}/>Durable checkpoint</span></div>
    <div className="jobs-list">{snapshot.job_states.map((job) => {
      const spec = snapshot.job_specs.find((s) => s.job_id === job.job_id);
      const checkpoint = snapshot.checkpoints.find((c) => c.checkpoint_id === job.latest_checkpoint_id);
      const writing = snapshot.checkpoints.find((c) => c.job_id === job.job_id && c.status === 'writing');
      const total = spec?.total_work_units ?? 0;
      return <article className={`job ${job.job_id}`} key={job.job_id}>
        <div className="job-heading"><h3><i/>{job.job_id}</h3><Badge tone={job.status === 'failed' ? 'danger' : job.status === 'checkpointing' || job.status === 'restarting' ? 'agent' : 'neutral'}>{job.status}</Badge></div>
        <div className="job-meta"><span>{spec?.gpus_required ?? '—'} GPUs · {Array.from(new Set(job.allocated_gpu_ids.map((id) => id.split('-')[1]?.toUpperCase()))).join(' + ') || 'No allocation'}</span>{spec && !spec.preemptible && <span><LockKeyhole size={11}/>Non-preemptible</span>}</div>
        <div className="progress-label"><strong>{number(fraction(job.progress_work_units, total), 1)}<small>%</small></strong><span>{number(job.progress_work_units)} / {number(total)} work units</span></div>
        <div className="job-progress" role="progressbar" aria-label={`${job.job_id} simulated training progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction(job.progress_work_units, total)}><i className="work-progress" style={{ width: `${fraction(job.progress_work_units, total)}%` }}/><i className="durable-progress" style={{ width: `${fraction(job.durable_work_units, total)}%` }}/>{checkpoint && <span className="checkpoint-marker" style={{ left: `${fraction(checkpoint.progress_work_units, total)}%` }}/>}</div>
        <div className="checkpoint-line"><span><ShieldCheck size={13}/>{number(job.durable_work_units)} durable</span><span>{checkpoint ? legacyClock ? 'Age unavailable' : `${duration(snapshot.clock.sim_time_ms - (checkpoint.complete_sim_time_ms ?? snapshot.clock.sim_time_ms))} old` : 'No checkpoint'}</span></div>
        {writing && <p className="job-notice">Checkpoint writing · not durable yet</p>}
        {(losses[job.job_id] ?? 0) > 0 && <p className="job-loss">{number(losses[job.job_id])} work units lost since this view opened</p>}
        {(history[job.job_id]?.length ?? 0) > 1 && <div className="job-history" aria-label={`${job.job_id} observed status history`}>{history[job.job_id]?.map((entry, i) => <span key={`${entry.sim_time_ms}-${i}`}>{i > 0 && <ArrowRight size={11}/>}<span>{entry.status}<small>{duration(entry.sim_time_ms)}</small></span></span>)}</div>}
      </article>;
    })}</div>{legacyClock && <p className="panel-footnote">Current mock fixtures use a legacy zero clock; checkpoint ages are unavailable.</p>}
  </Panel>;
}
