import { CircleAlert, ShieldAlert, Repeat, CheckCircle2, UserRound, ArrowLeftRight, MapPin, Save } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Incident, ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail, AgentEventInput, Evidence, WorkflowRecord } from '@dcos/db-client';
import { Panel, Badge, Empty } from '../ui/panel';
import { duration } from '../../lib/utils';
import { explainIncidents, recoveredFacts, type FactKind, type IncidentExplanation } from './incident-view';
import './incidents.css';

export interface IncidentsProps {
  incidents: Incident[];
  evidence: Evidence | null;
  workflows: WorkflowRecord[];
  events: AgentEventInput[];
  actions: ActionDetail[];
  snapshot: ObservedSnapshot | null;
  example: boolean;
  mode: 'mock' | 'live';
}

/** One card per incident: what happened, why it was grouped this way, what the agents decided, and where it stands. */
export function Incidents({ incidents, evidence, workflows, events, actions, snapshot, example, mode }: IncidentsProps) {
  const cards = explainIncidents({ incidents, evidence, workflows, events, actions, snapshot, example });
  const open = incidents.filter((row) => row.state !== 'resolved').length;
  const signals = evidence?.signals.length ?? 0;
  return <Panel title="Incidents" id="incidents" detail={<span className="inc-head"><Badge tone={open ? 'warning' : 'neutral'}>{open} open</Badge>{example && <Badge tone="example">EXAMPLE</Badge>}</span>}>
    {example && <p className="example-note">Scripted example: these incidents, decisions and tool calls are illustrations. No model, planner or safety engine ran.</p>}
    {cards.length === 0
      ? <Empty title="No incidents in this run">{signals > 0
        ? `${signals} signal${signals === 1 ? '' : 's'} observed, but no agent has grouped them into an incident yet. A fault alone does not create a diagnosis.`
        : mode === 'live' ? 'Incidents appear when the agent groups symptoms and records a diagnosis.' : 'Inject a fault from the presenter controls, or pick the Recovery example in the Run view.'}</Empty>
      : <div className="incident-list">{cards.map((card) => <IncidentCard key={card.incidentId} card={card}/>)}</div>}
  </Panel>;
}

function IncidentCard({ card }: { card: IncidentExplanation }) {
  const { status, evidence } = card;
  return <article className="incident" aria-labelledby={`incident-${card.incidentId}-title`}>
    <div className="incident-top">
      <h3 id={`incident-${card.incidentId}-title`} title={card.incidentId}><CircleAlert size={15} aria-hidden="true"/>{card.title}</h3>
      <span className="incident-badges"><span className="incident-severity"><Badge tone={card.severityTone}>{card.severity}</Badge></span><Badge tone={status.tone}>{status.badge}</Badge></span>
    </div>
    <dl className="incident-lines">
      <Line label="What happened">{card.whatHappened}</Line>
      {card.why && <Line label="Why">{card.why}</Line>}
      {card.decided && <Line label="Agents decided">{card.decided.text}{card.decided.actor && <Badge tone={card.decided.actor === 'NEMOTRON' ? 'nemotron' : 'code'}>{card.decided.actor}</Badge>}</Line>}
      <Line label="Status now"><span title={`incident state: ${status.incidentState}`}>{status.sentence}</span>{card.example && <Badge tone="example">EXAMPLE</Badge>}</Line>
    </dl>
    <details className="incident-evidence">
      <summary>Evidence</summary>
      <dl>
        <dt>Incident</dt><dd><code>{evidence.incidentId}</code> · {Math.round(evidence.confidence * 100)} % confidence · opened at sim {duration(evidence.openedSimMs)}</dd>
        {evidence.workflowId && <><dt>Workflow</dt><dd><code>{evidence.workflowId}</code>{evidence.planId && <> · plan <code>{evidence.planId}</code></>}</dd></>}
        <dt>Linked</dt><dd>{evidence.linkedIds.length ? evidence.linkedIds.map((id) => <code key={id}>{id}</code>) : 'no linked resources yet'}</dd>
        <dt>Signals</dt><dd>{evidence.signalCount} in the evidence window{evidence.symptomCount ? ` · ${evidence.symptomCount} symptom${evidence.symptomCount === 1 ? '' : 's'}` : ''}</dd>
      </dl>
    </details>
  </article>;
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return <div className="incident-line"><dt>{label}</dt><dd>{children}</dd></div>;
}

const FACT_ICON: Record<FactKind, typeof Repeat> = { takeover: ArrowLeftRight, resume: Repeat, verified: CheckCircle2, 'no-duplicate': Repeat, blocked: ShieldAlert, unresolved: UserRound, progress: Save, placement: MapPin };

/** Facts the agents recovered: takeovers, verification, skipped duplicates, blocked actions. Omitted when nothing is recorded. */
export function RecoveredEvidence({ workflows, events, actions, example }: { workflows: WorkflowRecord[]; events: AgentEventInput[]; actions: ActionDetail[]; example: boolean }) {
  const facts = recoveredFacts(workflows, events, actions);
  return <Panel title="Evidence the agents recovered" id="recovered-evidence" detail={example ? <Badge tone="example">EXAMPLE</Badge> : <Badge>{facts.length} fact{facts.length === 1 ? '' : 's'}</Badge>}>
    {facts.length === 0
      ? <Empty title="Nothing recovered yet">Takeovers, verified recoveries, skipped duplicates and blocked actions appear here as the workflows record them.</Empty>
      : <ul className="fact-list">{facts.map((fact) => { const Icon = FACT_ICON[fact.kind]; return <li key={fact.key} className={`fact fact-${fact.tone}`} title={fact.detail ?? undefined}><Icon size={14} aria-hidden="true"/><span>{fact.text}</span></li>; })}</ul>}
  </Panel>;
}
