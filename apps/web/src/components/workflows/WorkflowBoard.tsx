import { memo, useMemo } from 'react';
import type { ActionDetail, AgentActor, AgentEventInput, PlanRecord, WorkflowRecord } from '@dcos/db-client';
import type { Incident, ObservedSnapshot } from '@dcos/contracts';
import { CheckCircle2, CircleDashed, Code2, RotateCcw, Sparkles, UserRound } from 'lucide-react';
import { Badge, Empty, Panel } from '../ui/panel';
import { duration } from '../../lib/utils';
import {
  actorLabel,
  actorSummary,
  buildWorkflowViews,
  formatSpan,
  operationLabel,
  subjectOf,
  type ActionLine,
  type CandidateOption,
  type CandidateRound,
  type InfraLine,
  type ResumeEvidence,
  type StatusKind,
  type WorkflowView,
} from './workflow-view';
import './workflows.css';

export interface WorkflowBoardProps {
  workflows: WorkflowRecord[];
  events: AgentEventInput[];
  actionDetails: ActionDetail[];
  incidents: Incident[];
  snapshot: ObservedSnapshot | null;
  example: boolean;
  mode: 'mock' | 'live';
  /** Persisted plans from `onPlans`; the workflow's selected plan is the one whose id equals `workflow.plan_id`. */
  plans?: PlanRecord[];
  /** Wall clock for lease expiry labels (defaults to Date.now() at render). */
  nowUnixMs?: number;
}

const STATUS_TONE: Record<StatusKind, string> = {
  opened: 'neutral',
  in_progress: 'neutral',
  waiting: 'warning',
  replanning: 'warning',
  escalated: 'danger',
  verified: 'agent',
  operator_review: 'danger',
  closed_unverified: 'warning',
};

/** Per-workflow progress: one card per persisted workflow, driven by DB rows, agent events and the action ledger. */
export function WorkflowBoard({ workflows, events, actionDetails, incidents, snapshot, example, mode, plans = [], nowUnixMs }: WorkflowBoardProps) {
  const views = useMemo(() => buildWorkflowViews({ workflows, events, actionDetails, incidents, snapshot }), [workflows, events, actionDetails, incidents, snapshot]);
  const source = example ? 'Scripted example' : mode === 'live' ? 'Live DB' : 'Mock data';
  const simNow = snapshot?.clock.sim_time_ms ?? null;
  const now = nowUnixMs ?? Date.now();
  return <Panel title="Workflows" id="workflows" className="wf-panel" detail={<span className="wf-panel-badges"><Badge>{views.length} {views.length === 1 ? 'workflow' : 'workflows'}</Badge><Badge tone={example ? 'warning' : 'neutral'}>{source}</Badge></span>}>
    {example && <p className="example-note">Scripted example workflows, written through the mock client APIs. No model, planner or safety engine ran.</p>}
    {views.length === 0
      ? <Empty title="No workflow opened">{mode === 'mock' ? 'No agent is running in mock mode, so the orchestrator has not opened a workflow. Choose the recovery example to see scripted workflows.' : 'The orchestrator has not opened a workflow yet. One appears per incident group once the agent claims it.'}</Empty>
      : <ol className="wf-list" aria-label="Workflows">{views.map((view) => <li key={view.workflow.workflow_id}><WorkflowCard view={view} example={example} simNow={simNow} now={now} plan={view.planId ? plans.find((p) => p.plan_id === view.planId) ?? null : null}/></li>)}</ol>}
  </Panel>;
}

function ActorBadge({ actor, example }: { actor: AgentActor | null | undefined; example: boolean }) {
  return <span className={`wf-actor wf-actor-${actor ?? 'none'}`}>{actor === 'nemotron' ? <Sparkles size={12} aria-hidden="true"/> : actor === 'code' ? <Code2 size={12} aria-hidden="true"/> : null}{actorLabel(actor ?? undefined, example)}</span>;
}

const simAt = (ms: number | null) => (ms === null ? 'not recorded' : `${duration(ms)} sim`);
const wallTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const WorkflowCard = memo(function WorkflowCard({ view, example, simNow, now, plan }: { view: WorkflowView; example: boolean; simNow: number | null; now: number; plan: PlanRecord | null }) {
  const wf = view.workflow;
  const headingId = `wf-${wf.workflow_id}-heading`;
  const closed = wf.stage === 'done' || wf.stage === 'escalated';
  const lease = wf.lease_owner === null ? 'no owner' : closed ? `${wf.lease_owner} (workflow closed)` : wf.lease_expires_unix_ms > now ? `${wf.lease_owner} · expires in ${formatSpan(wf.lease_expires_unix_ms - now)}` : `${wf.lease_owner} · lease expired`;
  const age = view.lastEventSimMs !== null && simNow !== null ? ` (${formatSpan(simNow - view.lastEventSimMs)} before current sim time)` : '';
  return <article className={`wf-card wf-kind-${view.status.kind}`} aria-labelledby={headingId}>
    <header className="wf-card-head">
      <h3 id={headingId}><code>{wf.workflow_id}</code></h3>
      <Badge tone={STATUS_TONE[view.status.kind]}>{view.status.label}</Badge>
      {view.resumed && <Badge tone="agent"><RotateCcw size={11} aria-hidden="true"/>Resumed{view.resumed.count !== null && view.resumed.count > 1 ? ` ×${view.resumed.count}` : ''}</Badge>}
      {example && <Badge tone="warning">Example</Badge>}
    </header>
    <ul className="wf-incidents" aria-label="Incidents in this workflow">
      {view.incidents.length ? view.incidents.map((inc) => <li key={inc.incident_id}><strong>{inc.title ?? 'Incident record not loaded'}</strong><span><code>{inc.incident_id}</code>{inc.state ? ` · ${inc.state}` : ''}</span></li>) : <li><span>No incident linked yet</span></li>}
    </ul>
    <ol className="wf-track" aria-label={`Stages for ${wf.workflow_id}`}>
      {view.steps.map((step) => <li key={step.id} className={`wf-step wf-step-${step.state}`} aria-current={step.id === view.current ? 'step' : undefined}><span className="wf-step-name">{step.label}</span><span className="wf-step-state">{step.stateLabel}</span></li>)}
    </ol>
    <p className={`wf-status wf-status-${view.status.kind}`}><strong>{view.status.label}.</strong> {view.status.detail}</p>
    {view.replan && wf.stage !== 'replan' && <p className="wf-note">Replanned{view.replan.previous_plan_id ? <> from <code>{view.replan.previous_plan_id}</code></> : ''}: {view.replan.reason ?? 'reason not recorded'}.</p>}
    {view.resumed && <ResumedRow resumed={view.resumed} noDuplicate={view.resumedWithoutDuplicate}/>}
    <dl className="wf-labels">
      <div><dt>Plan</dt><dd>{view.planId ? <code>{view.planId}</code> : 'not recorded'}</dd></div>
      <div><dt>Plan attempt</dt><dd>{view.attempt ?? 'not recorded'}</dd></div>
      <div><dt>Lease owner</dt><dd>{lease}</dd></div>
      <div><dt>Lease claims</dt><dd>{wf.attempt}</dd></div>
      <div><dt>Last event</dt><dd>{simAt(view.lastEventSimMs)}{age}</dd></div>
      <div><dt>Row updated</dt><dd>{wallTime(wf.updated_at_unix_ms)} wall</dd></div>
      <div><dt>Events</dt><dd>{actorSummary(view.actors)}{example && view.events.length ? ' (scripted)' : ''}</dd></div>
    </dl>
    <Candidates round={view.candidates} example={example} plan={plan} planId={view.planId}/>
    <Handoff view={view} example={example}/>
  </article>;
});

const RESUME_SOURCE_NOTE: Record<ResumeEvidence['source'], string> = {
  workflow_state: 'recorded in the persisted workflow state',
  reconcile_tool_calls: 'from ledger reconciliation tool calls',
  event_summary: 'from the resume event summary',
};

/**
 * One-line resume callout. "no duplicate action" appears only when the ledger evidence supports it
 * (`resumedWithoutDuplicate`); "stopped" is what the lapsed lease shows, not a claim about why the first agent stopped.
 */
function ResumedRow({ resumed, noDuplicate }: { resumed: ResumeEvidence; noDuplicate: boolean | null }) {
  const who = resumed.by_worker ? <>resumed by <code>{resumed.by_worker}</code></> : 'resumed';
  const stopped = resumed.previous_owner ? <>Agent <code>{resumed.previous_owner}</code> stopped</> : 'Agent stopped';
  return <div className="wf-resumed" role="note">
    <RotateCcw size={15} aria-hidden="true"/>
    <div className="wf-resumed-body">
      <p className="wf-resumed-line">{stopped} <span className="wf-resumed-arrow" aria-hidden="true">→</span><span className="sr-only">, then</span> {who} at sim {duration(resumed.sim_time_ms)}{resumed.count !== null && resumed.count > 1 ? ` (resume #${resumed.count})` : ''}{noDuplicate === true && <> · <strong>no duplicate action</strong></>}{noDuplicate === false && <> · <strong className="wf-resumed-dup">ledger shows a repeated action</strong></>}</p>
      <p className="wf-resumed-note">{resumed.action ? `${resumed.action.replaceAll('_', ' ')} · ` : ''}{RESUME_SOURCE_NOTE[resumed.source]}{resumed.source !== 'workflow_state' ? <>: <span className="wf-wrap">{resumed.detail}</span></> : ''}</p>
    </div>
  </div>;
}

/** The workflow's selected plan (`workflow.plan_id`) from the persisted `plan` table. `plan.status` is not shown: it stays `proposed`. */
function SelectedPlan({ plan, planId }: { plan: PlanRecord | null; planId: string | null }) {
  if (!planId) return <p className="wf-muted">No plan selected by this workflow yet.</p>;
  if (!plan) return <p className="wf-muted">Selected plan <code className="wf-key">{planId}</code> has not been received from the DB yet.</p>;
  return <div className="wf-group wf-selected-plan"><h4>Selected plan (persisted)</h4>
    <dl className="wf-plan-facts">
      <div><dt>Plan</dt><dd><code className="wf-key">{plan.plan_id}</code></dd></div>
      <div><dt>Snapshot decision epoch</dt><dd>{plan.based_on_decision_epoch}</dd></div>
      <div><dt>Predicted lost work</dt><dd>{plan.expected_lost_work_units} wu</dd></div>
      <div><dt>Finite-horizon work deficit</dt><dd>{plan.expected_completion_delay_sim_s} sim-s</dd></div>
      <div><dt>GPU busy waste</dt><dd>{plan.expected_gpu_busy_waste_s} s</dd></div>
      <div><dt>Model risk score</dt><dd>{plan.failure_risk_estimate}</dd></div>
    </dl>
    <p className="wf-muted">Predictions on an estimated copy of the observed cluster; not a calibrated failure probability. Commands: {plan.command_keys.length}.</p>
    {plan.explanation && <p className="wf-wrap">{plan.explanation}</p>}
    <details className="wf-assumptions"><summary>Assumptions ({plan.assumptions.length})</summary><ul>{plan.assumptions.map((a, i) => <li key={i}><span className="wf-wrap">{a}</span></li>)}</ul></details>
  </div>;
}

function Candidates({ round, example, plan, planId }: { round: CandidateRound | null; example: boolean; plan: PlanRecord | null; planId: string | null }) {
  return <details className="wf-section">
    <summary>Candidates{round ? ` · ${round.options.length} ${round.options.length === 1 ? 'option' : 'options'}` : ' · none published'}</summary>
    <div className="wf-section-body">
      <p className="wf-muted">Shown for comparison only; nothing here executes a candidate. {round?.source === 'workflow_state' ? 'Predictions are the values the agent persisted for each option in the workflow state.' : 'Projections are the agent’s own simulate_plan results as reported in its events.'}</p>
      {!round ? <p>No plan or replan event has been published for this workflow.</p> : <>
        {round.pending && <p className="wf-note">Replanning: the new plan event has not been published yet.</p>}
        {round.narrative.map((n, i) => <p key={i} className="wf-narrative"><ActorBadge actor={n.actor} example={example}/><span className="wf-wrap">{n.summary}</span></p>)}
        {round.source === 'events' && (round.choice
          ? <p className="wf-narrative"><ActorBadge actor={round.choice.actor} example={example}/><span className="wf-wrap">choose_options: {round.choice.reported}</span></p>
          : <p className="wf-muted">No option-level choice was published; the chosen option cannot be identified by id. The plan summary above names it.</p>)}
        {round.options.length > 0 && <ul className="wf-options">{round.options.map((o) => <li key={o.option_id} className={o.chosen ? 'wf-option-chosen' : ''}>
          <div className="wf-option-head"><code>{o.option_id}</code>{o.chosen === true && <Badge tone="agent">Chosen</Badge>}{o.chosen === false && <Badge>{o.persisted ? 'Rejected' : 'Alternative'}</Badge>}{o.blocked && <Badge tone="danger">Blocked by safety</Badge>}</div>
          {o.persisted ? <PersistedOption o={o} example={example} showDeficit={round.showDeficit}/> : <>
            <dl>
              <div><dt>Predicted lost work</dt><dd>{o.lost_wu === null ? 'not reported' : `${o.lost_wu} wu`}</dd></div>
              <div><dt>Predicted delay</dt><dd>{o.delay_s === null ? 'not reported' : `${o.delay_s} s`}</dd></div>
              <div><dt>Safety</dt><dd>{o.safety ?? 'not published'}</dd></div>
            </dl>
            {o.simulated && <p className="wf-muted wf-wrap">Simulated: {o.simulated} · <ActorBadge actor={o.actor} example={example}/></p>}
          </>}
        </li>)}</ul>}
        {round.combined && <p className="wf-narrative"><ActorBadge actor={round.combined.actor} example={example}/><span className="wf-wrap">Selected commands together: {round.combined.reported}{round.combined.simulated ? ` (${round.combined.simulated})` : ''}</span></p>}
      </>}
      <SelectedPlan plan={plan} planId={planId}/>
      {round?.source !== 'workflow_state' && <p className="wf-muted">This row has no persisted candidates (written before the agent saved them); alternatives above come only from its published event tool calls.</p>}
    </div>
  </details>;
}

const simulated = (v: number | null, unit: string): string => (v === null ? 'not simulated' : `${v} ${unit}`);
function PersistedOption({ o, example, showDeficit }: { o: CandidateOption; example: boolean; showDeficit: boolean }) {
  const p = o.persisted!;
  return <>
    <dl>
      <div><dt>Predicted lost work</dt><dd>{simulated(o.lost_wu, 'wu')}</dd></div>
      {showDeficit && <div><dt>Predicted work deficit</dt><dd>{simulated(p.deficit_wu, 'wu')}</dd></div>}
      <div><dt>Predicted GPU busy waste</dt><dd>{simulated(p.gpu_waste_s, 's')}</dd></div>
      <div><dt>Safety</dt><dd>{o.safety}</dd></div>
      {p.violations.length > 0 && <div><dt>Violations</dt><dd className="wf-wrap">{p.violations.join(', ')}</dd></div>}
    </dl>
    {o.simulated && <p className="wf-muted wf-wrap">Commands: {o.simulated}</p>}
    <p className="wf-narrative"><ActorBadge actor={o.actor} example={example}/><span className="wf-wrap">{p.reason ?? 'no reason recorded'}</span></p>
    <p className="wf-muted">{p.as_of_sim_time_ms !== null ? `As of sim ${duration(p.as_of_sim_time_ms)}` : 'Sim time not recorded'}{p.snapshot_epoch !== null ? ` · snapshot epoch ${p.snapshot_epoch}` : ''}</p>
  </>;
}

function ActionList({ title, lines, empty }: { title: string; lines: ActionLine[]; empty?: string }) {
  if (!lines.length && !empty) return null;
  return <div className="wf-group"><h4>{title}</h4>{lines.length ? <ul>{lines.map((l) => <li key={l.command_key}><span><strong>{operationLabel(l.operation)}</strong> {l.subject}</span><span className="wf-muted">{l.status}{l.reason ? ` · ${l.reason}` : ''}{l.status === 'succeeded' ? (l.verified === null ? ' · not verified' : l.verified ? ' · verified' : ' · verification failed') : ''}</span>{l.verification_note && <span className="wf-muted wf-wrap">{l.verification_note}</span>}<code className="wf-key">{l.command_key}</code></li>)}</ul> : <p className="wf-muted">{empty}</p>}</div>;
}

const MAX_INFRA = 6;
function InfraList({ title, lines }: { title: string; lines: InfraLine[] }) {
  if (!lines.length) return null;
  return <div className="wf-group"><h4>{title}</h4><ul>{lines.slice(0, MAX_INFRA).map((l) => <li key={l.resource_id}><span><code>{l.resource_id}</code> {l.state}</span></li>)}</ul>{lines.length > MAX_INFRA && <p className="wf-muted">+{lines.length - MAX_INFRA} more</p>}</div>;
}

/** Verified actions for the handoff card: persisted `actions.verified` keys, else ledger verify_action records. */
function verifiedActionLines(view: WorkflowView): Array<{ key: string; text: string; source: 'handoff' | 'ledger' }> {
  const byKey = new Map(view.actions.map((a) => [a.command.command_key, a.command]));
  const persisted = view.verification?.actions?.verified;
  if (persisted && persisted.length) return persisted.map((key) => { const c = byKey.get(key); return { key, text: c ? `${operationLabel(c.operation)} ${subjectOf(c)}` : key, source: 'handoff' as const }; });
  return view.groups.completed.filter((l) => l.verified === true).map((l) => ({ key: l.command_key, text: `${operationLabel(l.operation)} ${l.subject}`, source: 'ledger' as const }));
}

/**
 * Two-column handoff: what the verifier confirmed (left) and what still needs a person (right). Every line comes from
 * the persisted OperatorHandoff (`state.verification`) or the ledger; empty sides say so instead of disappearing.
 */
function HandoffCard({ view, example }: { view: WorkflowView; example: boolean }) {
  const v = view.verification;
  const verified = verifiedActionLines(view);
  const tone = v?.verified === true ? 'recovered' : v?.verified === false ? 'review' : 'unknown';
  const title = v?.verified === true ? 'Recovered' : v?.verified === false ? 'Not verified' : 'Verification not recorded';
  const evidence = v?.asOf ? (v.asOf.from !== null ? `${duration(v.asOf.from)}–${duration(v.asOf.to)} sim` : `as of ${duration(v.asOf.to)} sim`) : 'time not recorded';
  const unresolved = v?.unresolved ?? [];
  const outcome = v?.outcome ? v.outcome.replaceAll('_', ' ') : null;
  const needsHuman = v?.verified === false || unresolved.length > 0;
  return <div className={`wf-handoff-card wf-handoff-${tone}`}>
    {/* result stripe: the verifier's persisted result, and whether a person is still needed (unresolved infrastructure or no verification) */}
    <p className="wf-handoff-stripe">
      <span className={`wf-stripe wf-stripe-${tone}`}>{v?.verified === true ? <CheckCircle2 size={14} aria-hidden="true"/> : <CircleDashed size={14} aria-hidden="true"/>}{title}</span>
      {needsHuman && <span className="wf-stripe wf-stripe-human"><UserRound size={14} aria-hidden="true"/>Needs a human{unresolved.length ? ` · ${unresolved.length} unresolved` : ''}</span>}
      {example && <span className="wf-stripe wf-stripe-example">Example</span>}
    </p>
    <section className="wf-handoff-col wf-handoff-left" aria-label={title}>
      <h4 className="wf-handoff-title">{v?.verified === true ? <CheckCircle2 size={15} aria-hidden="true"/> : <CircleDashed size={15} aria-hidden="true"/>}{title}{outcome && outcome.toLowerCase() !== title.toLowerCase() ? <span className="wf-handoff-outcome">{outcome}</span> : null}</h4>
      {verified.length
        ? <ul className="wf-handoff-list">{verified.map((l) => <li key={l.key}><span>{l.text}</span><code className="wf-key">{l.key}</code></li>)}</ul>
        : <p className="wf-handoff-empty">No verified actions recorded</p>}
      <p className="wf-handoff-verifier">{v ? <>{v.source === 'code' ? 'Deterministic verifier' : v.source ? `Verifier: ${v.source}` : 'Verifier not recorded'} · evidence {evidence}{verified.some((l) => l.source === 'ledger') ? ' · verified in the ledger' : ''}</> : 'No verification result persisted.'}</p>
      {v?.handoff && <p className="wf-handoff-quote wf-wrap">{v.handoff}{example ? ' (scripted)' : ''}</p>}
    </section>
    <section className="wf-handoff-col wf-handoff-right" aria-label="Needs a human">
      <h4 className="wf-handoff-title"><UserRound size={15} aria-hidden="true"/>Needs a human</h4>
      {unresolved.length
        ? <ul className="wf-handoff-list">{unresolved.map((u, i) => <li key={i}><span className="wf-wrap">{u}</span></li>)}</ul>
        : <p className="wf-handoff-empty">No unresolved infrastructure reported</p>}
      <p className="wf-handoff-next"><strong>Next step:</strong> {view.nextStep ? <>{view.nextStep.text} <span className="wf-handoff-src">({view.nextStep.source === 'verification' ? 'persisted handoff' : 'escalation reason'})</span></> : 'not recorded'}</p>
      {v?.remainingRisk && <p className="wf-handoff-risk wf-wrap"><strong>Remaining risk:</strong> {v.remainingRisk}</p>}
    </section>
  </div>;
}

function Handoff({ view, example }: { view: WorkflowView; example: boolean }) {
  const v = view.verification;
  const g = view.groups;
  const infraCount = view.infra.cooling.length + view.infra.relatedGpus.length + view.infra.otherGpus.length;
  const detail = <div className="wf-section-body">
      {!view.terminal && <p className="wf-muted">Handoff not written yet: the agent persists it when it verifies or escalates.</p>}
      <div className="wf-group"><h4>Evidence and hypothesis</h4>{v && v.hypotheses.length ? <ul>{v.hypotheses.map((h, i) => <li key={i}><span className="wf-wrap">{h}</span><span className="wf-muted">persisted handoff</span></li>)}</ul> : view.incidents.some((i) => i.hypothesis) ? <ul>{view.incidents.map((i) => <li key={i.incident_id}><span className="wf-wrap">{i.hypothesis ?? 'No hypothesis recorded.'}</span><code className="wf-key">{i.incident_id}</code></li>)}</ul> : <p className="wf-muted">No hypothesis recorded on the linked incidents.</p>}</div>
      <h4 className="wf-subhead">Workload mitigation</h4>
      <p className="wf-labels-inline">Affected jobs: {v && v.affectedJobs.length ? v.affectedJobs.map((j) => `${j.job_id}${j.status ? ` (${j.status}${j.racks.length ? `, ${j.racks.join(' + ')}` : ''})` : ''}`).join(', ') : view.affectedJobs.length ? view.affectedJobs.join(', ') : 'none in this workflow’s commands'}</p>
      <ActionList title="Completed (ledger)" lines={g.completed}/>
      <ActionList title="In progress" lines={g.inProgress}/>
      <ActionList title="Blocked" lines={g.blocked}/>
      <ActionList title="Failed or cancelled" lines={g.failed}/>
      {view.actions.length === 0 && <p className="wf-muted">No actions requested by this workflow.</p>}
      {view.outcomes.length > 0 && <div className="wf-group"><h4>Checkpoint and placement</h4><ul>{view.outcomes.map((o) => <li key={o.command_key}><span><strong>{o.kind}</strong> {o.subject} · {o.ledger}</span><span className="wf-muted">Currently observed: {o.observed}</span></li>)}</ul></div>}
      {v?.actions && <div className="wf-group"><h4>Persisted handoff: action outcomes</h4><ul>
        {([['Verified', v.actions.verified], ['Completed, not verified', v.actions.unverified], ['Not run', v.actions.not_run]] as const).filter(([, keys]) => keys.length).map(([label, keys]) => <li key={label}><span><strong>{label}</strong></span><span className="wf-muted wf-wrap">{keys.join(', ')}</span></li>)}
        {v.actions.blocked.map((b) => <li key={`b-${b.command_key}`}><span><strong>BLOCKED</strong> <code className="wf-key">{b.command_key}</code></span><span className="wf-muted wf-wrap">{b.violations.join(', ') || 'no violation codes recorded'}</span></li>)}
        {v.actions.failed.map((f) => <li key={`f-${f.command_key}`}><span><strong>Failed</strong> <code className="wf-key">{f.command_key}</code></span><span className="wf-muted">{f.reason_code}</span></li>)}
      </ul></div>}
      {v && (v.checkpointOutcome.length > 0 || v.placementOutcome.length > 0) && <div className="wf-group"><h4>Persisted checkpoint and placement outcome</h4><ul>
        {v.checkpointOutcome.map((c) => <li key={`c-${c.checkpoint_id}`}><span><strong>Checkpoint</strong> {c.job_id} · {c.status}</span><span className="wf-muted">{c.accessible === null ? 'accessibility not recorded' : c.accessible ? 'accessible' : 'not accessible'}{c.progress_work_units !== null ? ` · ${c.progress_work_units} work units` : ''}</span></li>)}
        {v.placementOutcome.map((pl) => <li key={`p-${pl.job_id}`}><span><strong>Placement</strong> {pl.job_id}</span><span className="wf-muted wf-wrap">{pl.racks.length ? pl.racks.join(' + ') : 'no racks recorded'}{pl.gpu_ids.length ? ` · ${pl.gpu_ids.length} GPUs` : ''}</span></li>)}
      </ul></div>}
      <div className="wf-group"><h4>Verification</h4>{v ? <>
        <p>{v.outcome ? <><strong>{v.outcome.replaceAll('_', ' ')}</strong> · </> : null}{v.verified === true ? 'Verified' : v.verified === false ? 'Not verified: operator review' : 'Result not recorded'} · evidence {v.asOf ? (v.asOf.from !== null ? `${duration(v.asOf.from)}–${duration(v.asOf.to)} sim` : `as of ${duration(v.asOf.to)} sim`) : 'time not recorded'}{v.source === 'code' ? ' · deterministic verifier' : ''}</p>
        {v.handoff && <blockquote className="wf-handoff wf-wrap">{v.handoff}{example ? ' (scripted)' : ''}</blockquote>}
        {v.remainingRisk && <p className="wf-wrap"><strong>Remaining risk:</strong> {v.remainingRisk}</p>}
      </> : <p className="wf-muted">No verification result persisted.</p>}</div>
      <h4 className="wf-subhead">Infrastructure still needing service</h4>
      <p className="wf-muted">Currently observed in the latest snapshot. Agent actions mitigate workloads; they never repair a pump or a GPU.</p>
      {v && v.unresolved.length > 0 && <div className="wf-group"><h4>Persisted by the agent (unresolved infrastructure)</h4><ul>{v.unresolved.map((u, i) => <li key={i}><span className="wf-wrap">{u}</span></li>)}</ul></div>}
      <InfraList title="Cooling (cluster-wide)" lines={view.infra.cooling}/>
      <InfraList title="GPUs this workflow touched" lines={view.infra.relatedGpus}/>
      <InfraList title="Other unavailable GPUs" lines={view.infra.otherGpus}/>
      {infraCount === 0 && <p className="wf-muted">No degraded cooling or unavailable GPU is currently observed.</p>}
      <div className="wf-group"><h4>Next human step</h4><p className="wf-wrap">{view.nextStep ? <>{view.nextStep.text} <span className="wf-muted">({view.nextStep.source === 'verification' ? 'from the persisted handoff' : 'from the escalation reason'})</span></> : 'Not recorded.'}</p></div>
    </div>;
  return <details className="wf-section wf-handoff-section" open={view.terminal}>
    <summary>{view.terminal ? 'Handoff' : 'Actions so far'} · {view.actions.length} {view.actions.length === 1 ? 'action' : 'actions'}</summary>
    {view.terminal
      ? <div className="wf-section-body wf-handoff-body"><HandoffCard view={view} example={example}/><details className="wf-raw"><summary>Full handoff record · evidence, ledger, infrastructure</summary>{detail}</details></div>
      : detail}
  </details>;
}
