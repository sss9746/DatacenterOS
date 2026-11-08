import type { AgentEventInput } from '@dcos/db-client';
import { ArrowRight, Code2, Sparkles } from 'lucide-react';
import { Panel, Badge, Empty } from '../ui/panel';
import { duration } from '../../lib/utils';
export function Feed({ events, example }: { events: AgentEventInput[]; example: boolean }) {
  const stage = events.at(-1)?.stage;
  return <Panel title="Agent activity" id="activity" detail={<Badge tone={events.length && !example ? 'agent' : 'neutral'}>{example ? 'Scripted example' : events.length ? 'NVIDIA Nemotron' : 'Not connected'}</Badge>}>
    <ol className="stages" aria-label="Agent workflow stages">{['triage', 'diagnose', 'plan', 'safety', 'execute', 'replan', 'verify'].map((name) => <li key={name} className={stage === name ? 'stage-active' : ''} aria-current={stage === name ? 'step' : undefined}>{name}</li>)}</ol>
    {example && <p className="example-note">Scripted tool-call examples · not live Nemotron output</p>}
    {!events.length ? <Empty title="Waiting for the orchestrator">Diagnosis summaries, evidence IDs and tool calls will appear here. Deterministic steps are labeled “Code.”</Empty> : <div className="feed-list">{[...events].reverse().map((event) => <article className="feed-event" key={event.agent_event_id}><div className="feed-event-meta"><span>{event.actor === 'nemotron' ? <Sparkles size={14}/> : <Code2 size={14}/>}<strong>{event.actor === 'nemotron' ? 'Nemotron' : event.actor === 'code' ? 'Code' : 'Actor unavailable'}</strong><Badge tone={event.stage === 'replan' ? 'warning' : 'neutral'}>{event.stage}</Badge></span><time>{duration(event.sim_time_ms)} sim</time></div><p>{event.summary}</p>{event.tool_calls.map((call, i) => <details className="tool-call" key={`${event.agent_event_id}-${i}`}><summary><code>{call.tool}()</code><span>{call.actor === 'nemotron' ? 'Nemotron' : call.actor === 'code' ? 'Code' : 'Tool call'}</span></summary><div><code>{call.args_summary}</code><ArrowRight size={14}/><p>{call.result_summary}</p></div></details>)}<div className="evidence-ids">{event.incident_id && <span>{event.incident_id}</span>}{event.evidence_ids.map((id) => <code key={id}>{id}</code>)}{event.evidence_ids.length === 0 && <span>No evidence IDs supplied</span>}</div></article>)}</div>}
  </Panel>;
}
