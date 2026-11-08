import { ArrowRight } from 'lucide-react';
import { rackChip, type JobMoveTimeline } from './move-timeline';

/**
 * The recovery story on a job card: five steps (At risk → Checkpoint → Moving → Restarting → Running on new GPUs)
 * with the active one animated, plus before/after placement chips. Every number comes from the timeline, which only
 * carries observed values; missing ones are simply not rendered.
 */
export function MoveTimeline({ timeline, example = false }: { timeline: JobMoveTimeline; example?: boolean }) {
  const { steps, from, to } = timeline;
  const active = steps.find((s) => s.state === 'active');
  return <div className={`jobcard-timeline is-${timeline.kind} phase-${timeline.phase}`} data-job-timeline={timeline.jobId} aria-label={`${timeline.jobId} recovery steps`}>
    <div className="jobcard-timeline-head">
      <span className="jobcard-timeline-title">{timeline.kind === 'rollback' ? 'Rolled back to the last checkpoint' : timeline.phase === 'running' ? 'Moved from checkpoint' : 'Moving from checkpoint'}{example ? ' · example' : ''}</span>
      {(from || to) && <span className="jobcard-chips" title={`${from ? `From racks ${from.racks.join(', ')}` : 'Previous placement not observed'} to ${to ? `racks ${to.racks.join(', ')}` : 'a destination not chosen yet'}`}>
        <span className={`jobcard-chip ${from ? 'is-from' : 'is-unknown'}`}>{from ? rackChip(from.racks) : '—'}</span>
        <ArrowRight size={12} aria-hidden="true"/>
        <span className={`jobcard-chip ${to ? 'is-to' : 'is-unknown'}`}>{to ? rackChip(to.racks) : '—'}</span>
      </span>}
    </div>
    <ol className="jobcard-steps">
      {steps.map((step, i) => <li key={step.id} className={`jobcard-step is-${step.state}`} aria-current={step.state === 'active' ? 'step' : undefined}>
        <i aria-hidden="true"><b/></i>
        <span className="jobcard-step-text"><strong>{step.label}</strong>{step.detail && <small>{step.detail}</small>}</span>
        {i < steps.length - 1 && <em className="jobcard-step-line" aria-hidden="true"/>}
      </li>)}
    </ol>
    {active?.id === 'restarting' && timeline.restart?.remainingMs !== null && timeline.restart?.remainingMs !== undefined && <p className="jobcard-countdown" role="status">Restarting on {to ? rackChip(to.racks) : 'new GPUs'} · <strong>{Math.ceil(timeline.restart.remainingMs / 1000)} s</strong> left</p>}
  </div>;
}
