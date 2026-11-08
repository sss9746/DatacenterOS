import type { AgentEventInput } from '@dcos/db-client';
import { ArrowRight, Code2, Sparkles } from 'lucide-react';
import { Panel, Badge, Empty } from '../ui/panel';
import { duration } from '../../lib/utils';
import { actorCounts, actorLabel, actorSummary } from '../workflows/workflow-view';
import './feed.css';

/**
 * Event log with a per-event actor badge. The panel badge counts actual actors ("3 Nemotron · 5 code"); it never
 * brands every event as model output. Per-workflow stages live in the WorkflowBoard, not in a single global track.
 */
export function Feed({ events, example }: { events: AgentEventInput[]; example: boolean }) {
  const counts = actorCounts(events);
  const summary = actorSummary(counts);
  return <Panel title="Agent activity" id="activity" detail={<span className="feed-badges"><Badge tone={counts.nemotron && !example ? 'agent' : 'neutral'}>{summary}</Badge>{example && <Badge tone="warning">Scripted example</Badge>}</span>}>
    {example && <p className="example-note">Scripted tool-call examples · not live Nemotron output</p>}
    {!events.length ? <Empty title="Waiting for the orchestrator">Diagnosis summaries, evidence IDs and tool calls will appear here. Each event is labeled with its actor: Nemotron for model steps, Code for deterministic steps.</Empty> : <div className="feed-list">{[...events].reverse().map((event) => <article className="feed-event" key={event.agent_event_id}>
      <div className="feed-event-meta"><span>{event.actor === 'nemotron' ? <Sparkles size={14} aria-hidden="true"/> : <Code2 size={14} aria-hidden="true"/>}<strong>{actorLabel(event.actor, example)}</strong><Badge tone={event.stage === 'replan' ? 'warning' : 'neutral'}>{event.stage}</Badge></span><time>{duration(event.sim_time_ms)} sim</time></div>
      <p className="feed-workflow">{event.workflow_id ? <>Workflow <code>{event.workflow_id}</code></> : 'Run-wide (no workflow)'}</p>
      <p>{event.summary}</p>
      {event.tool_calls.map((call, i) => <details className="tool-call" key={`${event.agent_event_id}-${i}`}><summary><code>{call.tool}()</code><span>{call.actor ? actorLabel(call.actor, example) : 'Tool call · actor not recorded'}</span></summary><div><code>{call.args_summary}</code><ArrowRight size={14} aria-hidden="true"/><p>{call.result_summary}</p></div></details>)}
      <div className="evidence-ids">{event.incident_id && <span>{event.incident_id}</span>}{event.evidence_ids.map((id) => <code key={id}>{id}</code>)}{event.evidence_ids.length === 0 && <span>No evidence IDs supplied</span>}</div>
    </article>)}</div>}
  </Panel>;
}
