import { useState } from 'react';
import type { AgentActor, AgentEventInput } from '@dcos/db-client';
import { ArrowRight, Code2, Sparkles } from 'lucide-react';
import { Panel, Badge, Empty } from '../ui/panel';
import { duration } from '../../lib/utils';
import { actorCounts, actorLabel, actorSummary } from '../workflows/workflow-view';
import { FEED_CAP, FEED_FILTERS, actorClass, sliceFeed, type FeedFilter } from './feed-view';
import './feed.css';

/**
 * Event log with a per-event actor pill. The panel badge counts actual actors ("3 Nemotron · 5 code"); it never
 * brands every event as model output. Per-workflow stages live in the WorkflowBoard, not in a single global track.
 */
export function Feed({ events, example }: { events: AgentEventInput[]; example: boolean }) {
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [showAll, setShowAll] = useState(false);
  const counts = actorCounts(events);
  const summary = actorSummary(counts);
  const slice = sliceFeed(events, filter, showAll);
  const chipCount: Record<FeedFilter, number> = { all: events.length, nemotron: counts.nemotron, code: counts.code };
  const chipLabel: Record<FeedFilter, string> = { all: 'All', nemotron: 'Nemotron', code: 'Code' };
  return <Panel title="Agent activity" id="activity" detail={<span className="feed-badges"><Badge tone={counts.nemotron && !example ? 'agent' : 'neutral'}>{summary}</Badge>{example && <Badge tone="warning">Scripted example</Badge>}</span>}>
    {example && <p className="example-note">Scripted tool-call examples · not live Nemotron output</p>}
    {!events.length ? <Empty title="Waiting for the orchestrator">Diagnosis summaries, evidence IDs and tool calls will appear here. Each event is labeled with its actor: Nemotron for model steps, Code for deterministic steps.</Empty> : <>
      <div className="feed-filter" role="group" aria-label="Filter events by actor">
        {FEED_FILTERS.map((f) => <button key={f} type="button" className={`feed-chip feed-chip-${f}`} aria-pressed={filter === f} onClick={() => { setFilter(f); setShowAll(false); }}>
          {f === 'nemotron' ? <Sparkles size={13} aria-hidden="true"/> : f === 'code' ? <Code2 size={13} aria-hidden="true"/> : null}{chipLabel[f]}<span className="feed-chip-count">{chipCount[f]}</span>
        </button>)}
        {counts.unlabelled > 0 && <span className="feed-filter-note">{counts.unlabelled} without a recorded actor{filter === 'all' ? '' : ' (hidden by this filter)'}</span>}
      </div>
      {slice.matching === 0
        ? <Empty title={`No ${chipLabel[filter]} events`}>{slice.filteredOut} {slice.filteredOut === 1 ? 'event is' : 'events are'} hidden by this filter. Choose All to see every event.</Empty>
        : <div className="feed-list">{slice.visible.map((event) => <FeedEvent key={event.agent_event_id} event={event} example={example}/>)}</div>}
      <p className="feed-foot" aria-live="polite">
        <span>Showing {slice.visible.length} of {slice.matching}{filter === 'all' ? '' : ` ${chipLabel[filter]}`} {slice.matching === 1 ? 'event' : 'events'}{slice.filteredOut > 0 ? ` · ${slice.filteredOut} hidden by filter` : ''}</span>
        {slice.matching > FEED_CAP && <button type="button" className="feed-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>{showAll ? `Show newest ${FEED_CAP}` : `Show all (${slice.matching})`}</button>}
      </p>
    </>}
  </Panel>;
}

function ActorPill({ actor, example }: { actor: AgentActor | undefined; example: boolean }) {
  return <strong className={`feed-actor ${actorClass(actor)}`}>{actor === 'nemotron' ? <Sparkles size={12} aria-hidden="true"/> : actor === 'code' ? <Code2 size={12} aria-hidden="true"/> : null}{actorLabel(actor, example)}</strong>;
}

function FeedEvent({ event, example }: { event: AgentEventInput; example: boolean }) {
  const hasEvidence = !!event.incident_id || event.evidence_ids.length > 0;
  return <article className={`feed-event ${actorClass(event.actor)}`}>
    <div className="feed-event-meta"><span><ActorPill actor={event.actor} example={example}/><Badge tone={event.stage === 'replan' ? 'warning' : 'neutral'}>{event.stage}</Badge></span><time>{duration(event.sim_time_ms)} sim</time></div>
    <p className="feed-workflow">{event.workflow_id ? <>Workflow <code>{event.workflow_id}</code></> : 'Run-wide (no workflow)'}</p>
    <p>{event.summary}</p>
    {event.tool_calls.map((call, i) => <details className={`tool-call ${actorClass(call.actor)}`} key={`${event.agent_event_id}-${i}`}><summary><code>{call.tool}()</code><span>{call.actor ? actorLabel(call.actor, example) : 'Tool call · actor not recorded'}</span></summary><div><code>{call.args_summary}</code><ArrowRight size={14} aria-hidden="true"/><p>{call.result_summary}</p></div></details>)}
    {hasEvidence && <div className="evidence-ids">{event.incident_id && <span>{event.incident_id}</span>}{event.evidence_ids.map((id) => <code key={id}>{id}</code>)}</div>}
  </article>;
}
