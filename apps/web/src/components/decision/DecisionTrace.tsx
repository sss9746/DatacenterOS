import { useMemo } from 'react';
import type { Incident } from '@dcos/contracts';
import type { AgentActor, Evidence, PlanRecord } from '@dcos/db-client';
import { CheckCircle2, CircleDashed, Code2, ShieldAlert, Sparkles, UserRound, XCircle } from 'lucide-react';
import { Badge } from '../ui/panel';
import { duration } from '../../lib/utils';
import type { WorkflowView } from '../workflows/workflow-view';
import {
  decisionTrace,
  type CostStep,
  type DecisionStep,
  type DetectStep,
  type ExecuteStep,
  type LedgerSafety,
  type OptionRow,
  type OptionsStep,
  type SafetyStep,
  type TraceStep,
  type VerifyStep,
} from './decision-trace';
import './decision.css';

export interface DecisionTraceProps {
  view: WorkflowView;
  plans: readonly PlanRecord[];
  incidents: readonly Incident[];
  evidence: Evidence | null;
  example: boolean;
}

const NOT_RECORDED = 'not recorded';
const sim = (ms: number | null | undefined): string => (ms === null || ms === undefined ? NOT_RECORDED : `${duration(ms)} sim`);
const wu = (v: number | null): string => (v === null ? 'not simulated' : `${v} wu`);
const secs = (v: number | null): string => (v === null ? 'not simulated' : `${v} s`);

/** Who decided: Nemotron (solid green) vs deterministic code (grey). Never a blanket brand label. */
export function DecidedBy({ actor, example }: { actor: AgentActor | null; example: boolean }) {
  if (actor === 'nemotron') return <span className="dt-actor dt-actor-nemotron"><Sparkles size={12} aria-hidden="true"/>NEMOTRON{example ? ' (scripted)' : ''}</span>;
  if (actor === 'code') return <span className="dt-actor dt-actor-code"><Code2 size={12} aria-hidden="true"/>CODE{example ? ' (scripted)' : ''}</span>;
  return <span className="dt-actor dt-actor-none">actor {NOT_RECORDED}</span>;
}

const SAFETY_TONE: Record<string, string> = { allow: 'allow', needs_approval: 'approval', deny: 'deny', not_checked: 'none' };
function SafetyPill({ safety, label }: { safety: OptionRow['safety']; label: string }) {
  return <span className={`dt-safety dt-safety-${safety ? SAFETY_TONE[safety] : 'none'}`}>{label}</span>;
}

/**
 * Vertical numbered pipeline: Detect → Options → Cost → Safety → Decision → Execute → Verify. Every step is open by
 * default (nothing about the decision is hidden); only per-option detail tables are compact. Missing data reads
 * "not recorded"; null metrics read "not simulated".
 */
export function DecisionTrace({ view, plans, incidents, evidence, example }: DecisionTraceProps) {
  const trace = useMemo(() => decisionTrace(view, { plans, incidents, evidence }), [view, plans, incidents, evidence]);
  return <ol className="dt-trace decision-trace" aria-label={`Decision trace for ${trace.workflow_id}`} data-workflow={trace.workflow_id}>
    {trace.steps.map((step) => <li key={step.id} className={`dt-step dt-step-${step.id} ${step.recorded ? '' : 'dt-step-missing'}`}>
      <details open className="dt-details">
        <summary className="dt-summary">
          <span className="dt-index" aria-hidden="true">{step.index}</span>
          <span className="dt-head"><span className="dt-title">{step.title}</span><span className="dt-sub">{step.summary}</span></span>
          {!step.recorded && <Badge tone="warning">{NOT_RECORDED}</Badge>}
        </summary>
        <div className="dt-body"><StepBody step={step} example={example}/></div>
      </details>
    </li>)}
  </ol>;
}

function StepBody({ step, example }: { step: TraceStep; example: boolean }) {
  switch (step.id) {
    case 'detect': return <Detect step={step} example={example}/>;
    case 'options': return <Options step={step} example={example}/>;
    case 'cost': return <Cost step={step}/>;
    case 'safety': return <Safety step={step}/>;
    case 'decision': return <Decision step={step} example={example}/>;
    case 'execute': return <Execute step={step}/>;
    case 'verify': return <Verify step={step} example={example}/>;
  }
}

// ------------------------------------------------------------------------------------------------ 1. Detect

function Detect({ step, example }: { step: DetectStep; example: boolean }) {
  return <>
    {step.incidents.length === 0 && <p className="dt-muted">No incident is linked to this workflow yet.</p>}
    {step.incidents.map((inc) => <div key={inc.incident_id} className="dt-incident">
      <p className="dt-line"><strong>{inc.title ?? 'Incident record not loaded'}</strong>{inc.severity && <Badge tone={inc.severity === 'critical' || inc.severity === 'high' ? 'danger' : 'warning'}>{inc.severity}</Badge>}{inc.state && <Badge>{inc.state}</Badge>}<code className="dt-key">{inc.incident_id}</code></p>
      <dl className="dt-facts">
        <div><dt>What happened</dt><dd>{inc.hypothesis ?? NOT_RECORDED}</dd></div>
        <div><dt>Opened</dt><dd>{sim(inc.opened_sim_time_ms)}</dd></div>
        <div><dt>Resources</dt><dd>{inc.resources.length ? inc.resources.map((r) => <code key={r}>{r}</code>) : NOT_RECORDED}</dd></div>
        <div><dt>Symptoms</dt><dd>{inc.symptoms.length ? inc.symptoms.map((s) => <code key={s}>{s}</code>) : 'none linked'}</dd></div>
      </dl>
    </div>)}
    <h4>Who triaged</h4>
    {step.triage.length ? <ul className="dt-list">{step.triage.map((t, i) => <li key={i}><DecidedBy actor={t.actor} example={example}/><span className="dt-wrap">{t.summary}</span><span className="dt-meta">{t.stage} · {sim(t.sim_time_ms)}{t.tools.length ? ` · tools: ${t.tools.join(', ')}` : ''}</span></li>)}</ul>
      : <p className="dt-muted">No triage or diagnosis event was published for this workflow ({NOT_RECORDED}).</p>}
  </>;
}

// ------------------------------------------------------------------------------------------------ 2. Options

function Options({ step, example }: { step: OptionsStep; example: boolean }) {
  if (!step.jobs.length) return <p className="dt-muted">The planner published no candidate options for this workflow ({NOT_RECORDED}).</p>;
  return <>
    <p className="dt-muted">{step.source === 'workflow_state' ? 'Every option the planner evaluated, as persisted in the workflow state (chosen and rejected).' : 'Options parsed from the planner’s published simulate_plan / evaluate_safety tool calls (this row has no persisted candidates).'}{step.pending ? ' Replanning: the new plan event has not been published yet.' : ''}{example ? ' Scripted example values.' : ''}</p>
    {step.jobs.map(({ job, rows }) => <div key={job} className="dt-table-wrap">
      <table className="dt-table" aria-label={`Options for ${job}`}>
        <caption>{job}</caption>
        <thead><tr><th scope="col">Option</th><th scope="col">Commands</th><th scope="col" className="dt-num">Lost work</th>{step.show_deficit && <th scope="col" className="dt-num">Work deficit</th>}<th scope="col" className="dt-num">GPU-busy waste</th><th scope="col">Decided by</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.key} className={`${r.chosen === true ? 'dt-row-chosen' : ''} ${r.lowest_cost ? 'dt-row-lowest' : ''}`} title={r.option_id}>
          <td><span className="dt-option-name">{r.chosen === true && <CheckCircle2 size={13} aria-hidden="true"/>}{r.name}</span>{r.chosen === true && <span className="dt-tag dt-tag-chosen">chosen</span>}{r.lowest_cost && <span className="dt-tag dt-tag-lowest">lowest cost</span>}</td>
          <td className="dt-cmds">{r.commands || NOT_RECORDED}</td>
          <td className="dt-num">{wu(r.lost_wu)}</td>
          {step.show_deficit && <td className="dt-num">{wu(r.deficit_wu)}</td>}
          <td className="dt-num">{step.source === 'workflow_state' ? secs(r.gpu_waste_s) : NOT_RECORDED}</td>
          <td><DecidedBy actor={r.actor} example={example}/></td>
        </tr>)}</tbody>
      </table>
    </div>)}
  </>;
}

// ------------------------------------------------------------------------------------------------ 3. Cost

function Cost({ step }: { step: CostStep }) {
  if (!step.jobs.length) return <p className="dt-muted">No candidate options recorded, so there is nothing to compare.</p>;
  return <div className="dt-cost-grid">{step.jobs.map((job) => {
    const any = job.bars.some((b) => b.lost_wu !== null);
    return <div key={job.job} className="dt-cost-job">
      <h4>{job.job} · predicted lost work</h4>
      {!any && <p className="dt-muted">No option for {job.job} carries a predicted lost-work number ({NOT_RECORDED}).</p>}
      {any && <ul className="dt-bars" aria-label={`Predicted lost work per option for ${job.job}`}>{job.bars.map((b) => <li key={b.key} className={b.chosen === true ? 'dt-bar-chosen' : ''}>
        <span className="dt-bar-label">{b.chosen === true && <CheckCircle2 size={12} aria-hidden="true"/>}{b.name}</span>
        <span className="dt-bar-track" aria-hidden="true">{b.width_pct !== null && <span className="dt-bar-fill" style={{ width: `${Math.max(b.width_pct, b.lost_wu === 0 ? 0 : 2)}%` }}/>}{b.width_pct === null && <span className="dt-bar-none"/>}</span>
        <span className="dt-bar-value">{wu(b.lost_wu)}{b.chosen === true ? ' · chosen' : ''}</span>
      </li>)}</ul>}
      {job.saving && <p className="dt-saving"><strong>{job.saving.chosen}</strong> saves <strong>{job.saving.saved_wu} wu</strong> vs keep running ({job.saving.chosen_wu} vs {job.saving.keep_wu} wu predicted).</p>}
      {!job.saving && any && <p className="dt-muted">Saving vs keep running not shown: both numbers must be simulated.</p>}
    </div>;
  })}</div>;
}

// ------------------------------------------------------------------------------------------------ 4. Safety

function LedgerSafetyCell({ s, title }: { s: LedgerSafety | null; title: string }) {
  if (!s) return <span className="dt-muted">{title}: {NOT_RECORDED}</span>;
  const tone = s.decision === 'allow' ? 'allow' : s.decision === 'deny' ? 'deny' : s.decision === 'needs_approval' ? 'approval' : 'none';
  return <span className="dt-ledger-safety">{title}: <span className={`dt-safety dt-safety-${tone}`}>{s.decision.replaceAll('_', ' ')}</span>{s.checked_decision_epoch !== null && <span className="dt-meta"> epoch {s.checked_decision_epoch}</span>}
    {s.violations.length > 0 && <ul className="dt-violations">{s.violations.map((v) => <li key={v.code}>{v.text} <code>{v.code}</code></li>)}</ul>}</span>;
}

function Safety({ step }: { step: SafetyStep }) {
  return <>
    <h4>Per option (planner’s evaluate_safety)</h4>
    {step.options.length ? <ul className="dt-list dt-safety-list">{step.options.map((r) => <li key={r.key} title={r.option_id}>
      <span className="dt-safety-head"><SafetyPill safety={r.safety} label={r.safety_label}/><span className="dt-option-name">{r.job} · {r.name}</span>{r.chosen === true && <span className="dt-tag dt-tag-chosen">chosen</span>}</span>
      {r.violations.length > 0 && <ul className="dt-violations">{r.violations.map((v) => <li key={v.code}>{v.text} <code>{v.code}</code></li>)}</ul>}
      {r.safety === 'not_checked' && <span className="dt-meta">no command to check (or not separately simulated)</span>}
    </li>)}</ul> : <p className="dt-muted">No options recorded ({NOT_RECORDED}).</p>}
    <h4>Ledger (actual request-time and start-time checks on executed commands)</h4>
    {step.ledger.length ? <ul className="dt-list dt-ledger-list">{step.ledger.map((l) => <li key={l.command_key} className={l.blocked ? 'dt-blocked' : ''}>
      <span className="dt-safety-head">{l.blocked ? <span className="dt-blocked-pill"><ShieldAlert size={12} aria-hidden="true"/>BLOCKED</span> : null}<span className="dt-option-name">{l.label}</span><code className="dt-key" title="command key">{l.command_key}</code></span>
      <LedgerSafetyCell s={l.request} title="Request-time safety"/>
      <LedgerSafetyCell s={l.start} title="Start-time safety"/>
      {l.blocked && l.reason_code && <span className="dt-meta">ledger reason: {l.reason_code}</span>}
    </li>)}</ul> : <p className="dt-muted">No command has been requested in the ledger yet ({NOT_RECORDED}).</p>}
  </>;
}

// ------------------------------------------------------------------------------------------------ 5. Decision

function Decision({ step, example }: { step: DecisionStep; example: boolean }) {
  return <>
    {step.lines.length ? <ul className="dt-list dt-decisions">{step.lines.map((l) => <li key={l.key}>
      <span className="dt-safety-head"><CheckCircle2 size={14} aria-hidden="true" className="dt-ok"/><strong>{l.job}</strong><span className="dt-option-name">{l.name}</span><DecidedBy actor={l.actor} example={example}/></span>
      <span className="dt-wrap dt-reason">{l.reason ?? `reason ${NOT_RECORDED}`}</span>
      <span className="dt-meta">snapshot epoch {l.snapshot_epoch ?? NOT_RECORDED} · as of {sim(l.as_of_sim_time_ms)}</span>
    </li>)}</ul> : <p className="dt-muted">{step.summary}.</p>}
    {step.replan && <p className="dt-note">Replanned{step.attempt !== null ? ` (attempt ${step.attempt})` : ''}{step.replan.previous_plan_id ? <> from <code>{step.replan.previous_plan_id}</code></> : ''}: {step.replan.reason ?? `reason ${NOT_RECORDED}`}.</p>}
    {step.plan ? <dl className="dt-facts">
      <div><dt>Selected plan</dt><dd><code>{step.plan.plan_id}</code></dd></div>
      <div><dt>Snapshot decision epoch</dt><dd>{step.plan.based_on_decision_epoch}</dd></div>
      <div><dt>Plan predicted lost work</dt><dd>{step.plan.lost_wu} wu</dd></div>
      <div><dt>Plan GPU-busy waste</dt><dd>{step.plan.gpu_waste_s} s</dd></div>
      <div><dt>Commands</dt><dd>{step.plan.commands}</dd></div>
      <div><dt>Explanation</dt><dd className="dt-wrap">{step.plan.explanation ?? NOT_RECORDED}</dd></div>
    </dl> : <p className="dt-muted">Selected plan row {NOT_RECORDED}.</p>}
  </>;
}

// ------------------------------------------------------------------------------------------------ 6. Execute

function Execute({ step }: { step: ExecuteStep }) {
  if (!step.lines.length) return <p className="dt-muted">No command has been requested for this workflow ({NOT_RECORDED}).</p>;
  return <>
    {step.resumed && <p className="dt-note">Resumed{step.resumed.by ? ` by ${step.resumed.by}` : ''}{step.resumed.from ? ` after ${step.resumed.from} stopped` : ''} at {sim(step.resumed.sim_time_ms)}; finished commands were reconciled from the ledger, not re-run.</p>}
    <ol className="dt-exec" aria-label="Commands in order">{step.lines.map((l, i) => <li key={l.command_key} className={l.blocked ? 'dt-blocked' : l.status === 'succeeded' ? 'dt-succeeded' : ''}>
      <span className="dt-exec-head"><span className="dt-exec-n" aria-hidden="true">{i + 1}</span><strong>{l.label}</strong>{l.blocked ? <span className="dt-blocked-pill"><ShieldAlert size={12} aria-hidden="true"/>BLOCKED</span> : <Badge tone={l.status === 'succeeded' ? 'agent' : l.status === 'failed' || l.status === 'cancelled' ? 'danger' : 'neutral'}>{l.status}</Badge>}{l.attempt > 1 && <span className="dt-tag dt-tag-retry">retried ×{l.attempt - 1}</span>}{l.reconciled && <span className="dt-tag dt-tag-reconciled">reconciled after restart: {l.reconciled}</span>}<code className="dt-key" title={`command key: ${l.command_key}`}>{l.command_key}</code></span>
      <span className="dt-meta">requested {sim(l.requested_sim_time_ms)} · started {sim(l.started_sim_time_ms)} · due {sim(l.due_sim_time_ms)}{l.reason_code ? ` · reason ${l.reason_code}` : ''}</span>
      <span className="dt-lifecycle" aria-label="Status lifecycle">{l.lifecycle.length ? l.lifecycle.map((h, j) => <span key={j} className="dt-life">{h.status.replaceAll('_', ' ')}<small>{duration(h.sim_time_ms)}</small></span>) : <span className="dt-muted">lifecycle {NOT_RECORDED}</span>}</span>
    </li>)}</ol>
  </>;
}

// ------------------------------------------------------------------------------------------------ 7. Verify

function Verify({ step, example }: { step: VerifyStep; example: boolean }) {
  const tone = step.outcome === 'recovered' ? 'recovered' : step.outcome === 'not_verified' || step.outcome === 'escalated' ? 'review' : 'unknown';
  return <>
    <p className={`dt-outcome dt-outcome-${tone}`}>{step.outcome === 'recovered' ? <CheckCircle2 size={15} aria-hidden="true"/> : step.outcome === 'pending' || step.outcome === 'not_recorded' ? <CircleDashed size={15} aria-hidden="true"/> : <XCircle size={15} aria-hidden="true"/>}<strong>{step.outcome_label}</strong>{step.persisted_outcome && step.persisted_outcome.replaceAll('_', ' ') !== step.outcome_label.toLowerCase() && <span className="dt-tag">{step.persisted_outcome.replaceAll('_', ' ')}</span>}<span className="dt-meta">verification window {step.window ? (step.window.from !== null ? `${duration(step.window.from)}–${duration(step.window.to)} sim` : `as of ${duration(step.window.to)} sim`) : NOT_RECORDED}</span></p>
    <h4>Checks</h4>
    {step.checks.length ? <ul className="dt-list dt-checks">{step.checks.map((c) => <li key={c.command_key} className={c.ok === true ? 'dt-check-ok' : c.ok === false ? 'dt-check-fail' : ''}>
      <span className="dt-safety-head">{c.ok === true ? <CheckCircle2 size={14} aria-hidden="true" className="dt-ok"/> : c.ok === false ? <XCircle size={14} aria-hidden="true" className="dt-fail"/> : <CircleDashed size={14} aria-hidden="true"/>}<strong>{c.label}</strong><span className="dt-meta">{c.ok === true ? 'passed' : c.ok === false ? 'failed' : NOT_RECORDED}</span><code className="dt-key">{c.command_key}</code></span>
      <span className="dt-wrap">{c.note ?? `note ${NOT_RECORDED}`}</span>
      {c.evidence.length > 0 && <dl className="dt-evidence">{c.evidence.map((e) => <div key={e.key}><dt>{e.key}</dt><dd>{e.value}</dd></div>)}</dl>}
    </li>)}</ul> : <p className="dt-muted">{step.recorded ? `The verifier persisted no per-command checks (${NOT_RECORDED}).` : `No verification result persisted (${NOT_RECORDED}).`}</p>}
    {(step.jobs.length > 0 || step.placements.length > 0) && <><h4>Evidence</h4><ul className="dt-list">
      {step.jobs.map((j) => <li key={j.job}><span><strong>{j.job}</strong> {j.status ?? ''} · progress {j.progress_wu ?? NOT_RECORDED} wu · durable {j.durable_wu ?? NOT_RECORDED} wu{j.racks.length ? ` · racks ${j.racks.join(' + ')}` : ''}</span></li>)}
      {step.placements.map((p) => <li key={`p-${p.job}`}><span><strong>{p.job}</strong> placed on {p.racks.length ? p.racks.join(' + ') : `racks ${NOT_RECORDED}`}{p.gpus.length ? ` (${p.gpus.join(', ')})` : ''}</span></li>)}
    </ul></>}
    <div className="dt-human">
      <h4><UserRound size={13} aria-hidden="true"/>Needs a human</h4>
      {step.unresolved.length ? <ul className="dt-list">{step.unresolved.map((u, i) => <li key={i}><span className="dt-wrap">{u}</span></li>)}</ul> : <p className="dt-muted">No unresolved infrastructure reported.</p>}
      <p className="dt-wrap"><strong>Next step:</strong> {step.next_human_action ?? NOT_RECORDED}</p>
      {step.remaining_risk && <p className="dt-wrap"><strong>Remaining risk:</strong> {step.remaining_risk}</p>}
    </div>
    {step.handoff && <blockquote className="dt-handoff dt-wrap">{step.handoff}{example ? ' (scripted)' : ''}</blockquote>}
  </>;
}
