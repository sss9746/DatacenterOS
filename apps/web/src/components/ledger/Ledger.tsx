import { useMemo, useState, type ReactNode } from 'react';
import type { ActionStatus } from '@dcos/contracts';
import type { ActionDetail } from '@dcos/db-client';
import { ShieldAlert } from 'lucide-react';
import { Panel, Badge, Empty } from '../ui/panel';
import {
  ESTIMATE_NOTE, buildLedgerRows, filterRows, workflowIds,
  type ActionView, type EvidenceItem, type LedgerFilter, type ReasonView, type SafetyView,
} from './action-view';
import './ledger.css';

export { actionLabel, reasonText } from './action-view';

const LIFECYCLE = 'requested → claimed → running → terminal status → verified';
const FILTERS: { value: LedgerFilter; label: string }[] = [
  { value: 'all', label: 'All actions' }, { value: 'active', label: 'In progress' }, { value: 'blocked', label: 'Blocked' },
];

export function Ledger({ actions, details, simTimeMs }: { actions: ActionStatus[]; details: ActionDetail[]; simTimeMs: number | null }) {
  const [filter, setFilter] = useState<LedgerFilter>('all');
  const [workflow, setWorkflow] = useState('');
  const rows = useMemo(() => buildLedgerRows(actions, details, simTimeMs), [actions, details, simTimeMs]);
  const workflows = useMemo(() => workflowIds(details), [details]);
  // a workflow that disappeared (e.g. after a reset) falls back to all workflows
  const selectedWorkflow = workflows.includes(workflow) ? workflow : '';
  const shown = filterRows(rows, filter, selectedWorkflow || null);
  const filtered = filter !== 'all' || selectedWorkflow !== '';

  return <Panel title="Durable action ledger" id="ledger" className="ledger" detail={<Badge>{rows.length} recorded</Badge>}>
    <div className="ledger-toolbar">
      <label className="inline-select ledger-field"><span>Show</span>
        <select value={filter} onChange={(event) => setFilter(event.target.value as LedgerFilter)}>
          {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </label>
      <label className="inline-select ledger-field"><span>Workflow</span>
        <select value={selectedWorkflow} onChange={(event) => setWorkflow(event.target.value)} disabled={!workflows.length}>
          <option value="">All workflows</option>
          {workflows.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </label>
      <p className="ledger-count" aria-live="polite" title={`Lifecycle: ${LIFECYCLE}`}>{filtered ? `${shown.length} of ${rows.length} shown` : `${rows.length} actions`}</p>
    </div>
    {!shown.length
      ? <Empty title={rows.length ? 'No actions match these filters' : 'No commands submitted'}>{rows.length ? 'Choose All actions and All workflows to see the full ledger. Actions whose details have not arrived cannot be matched to a workflow yet.' : 'Accepted commands and safety rejections appear here, identified by a stable command key.'}</Empty>
      : <ol className="ledger-list" aria-label="Actions, newest first">{shown.map((row) => <LedgerRow key={row.commandKey} row={row}/>)}</ol>}
  </Panel>;
}

function LedgerRow({ row }: { row: ActionView }) {
  const d = row.detail;
  const reason = row.blockedReason;
  return <li className={row.blocked ? 'ledger-row ledger-row-blocked' : 'ledger-row'}>
    {/* a blocked row opens by default: the safety decision is the point of the ledger */}
    <details open={row.blocked || undefined}>
      <summary className="ledger-summary">
        <span className="ledger-summary-main">
          <strong>{d ? d.operationLabel : 'Operation not received yet'}</strong>
          {row.blocked ? <span className="ledger-blocked-reason">
            {reason
              ? <>{reason.text} <code className="ledger-inline-code">{reason.code}</code>{reason.more > 0 ? <span className="ledger-blocked-more">+{reason.more} more</span> : null}</>
              : 'Blocked by the safety check; no violation code was recorded on this row.'}
          </span> : null}
          {/* plain-English subject only; the command key, workflow and plan ids live in the row body and the tooltip */}
          {d ? <span className="ledger-summary-sub" title={row.commandKey}>{d.job ? `${d.job} · ${d.target}` : d.target}</span> : <span className="ledger-summary-sub" title={row.commandKey}>Details not received yet</span>}
        </span>
        <span className="ledger-summary-status">
          <Badge tone={row.tone}>{row.blocked ? <ShieldAlert size={11} aria-hidden="true"/> : null}{row.label}</Badge>
          {row.verification ? <Badge tone={row.verification.tone}>{row.verification.label}</Badge> : null}
          {d?.progress ? <span className="ledger-mini">≈{d.progress.percent}% elapsed (estimate)</span> : null}
          <time>{row.updatedAt}</time>
        </span>
      </summary>
      <div className="ledger-body">{d ? <DetailBody row={row}/> : <PendingBody row={row}/>}</div>
    </details>
  </li>;
}

function PendingBody({ row }: { row: ActionView }) {
  return <>
    <p className="ledger-note">Details not received yet. The operation, target, dependencies, safety evidence and history appear when the ledger detail for this command arrives.</p>
    <dl className="ledger-facts">
      <Fact term="Command key"><code>{row.commandKey}</code></Fact>
      <Fact term="Attempt / version">{row.attempt} · v{row.version}</Fact>
      <Fact term="Last update">{row.updatedAt}</Fact>
      {row.status.reason_code ? <Fact term="Reason">{row.status.reason_code}</Fact> : null}
    </dl>
    {row.reportedViolations.length ? <section className="ledger-section"><h3>Violations on the status row</h3><Violations items={row.reportedViolations}/></section> : null}
  </>;
}

function DetailBody({ row }: { row: ActionView }) {
  const d = row.detail!;
  const started = d.history.some((h) => h.label === 'running');
  const safety = <>
    <SafetySection title="Request-time safety check" view={d.safety} missing="Safety decision not recorded for this request."/>
    {d.startSafety
      ? <SafetySection title="Start-time recheck" view={d.startSafety} missing=""/>
      : started ? <p className="ledger-note ledger-section">No start-time rejection recorded.</p> : null}
  </>;
  return <>
    {/* blocked: the safety decision comes first, before the command facts */}
    {row.blocked ? <div className="ledger-safety-first">{safety}</div> : null}
    <dl className="ledger-facts">
      <Fact term="Operation">{d.operationLabel} <code className="ledger-inline-code">{d.operation}</code></Fact>
      <Fact term="Job">{d.job ?? 'no job'}</Fact>
      <Fact term="Target">{d.target}</Fact>
      <Fact term="Workflow"><code>{d.workflowId}</code></Fact>
      <Fact term="Plan"><code>{d.planId}</code></Fact>
      <Fact term="Incidents">{d.incidentIds.join(', ')}</Fact>
      <Fact term="Claimed by">{d.claimedBy}</Fact>
      <Fact term="Attempt / version">{row.attempt} · v{row.version}</Fact>
      <Fact term="Command key"><code>{row.commandKey}</code></Fact>
      {d.arguments.map((a) => <Fact key={a.key} term={`Argument: ${a.label}`} wide>{a.value}</Fact>)}
    </dl>

    <section className="ledger-section"><h3>Timing</h3>
      <dl className="ledger-facts">
        <Fact term="Requested">{d.requestedAt}</Fact>
        <Fact term="Started">{d.startedAt}</Fact>
        <Fact term="Due">{d.dueAt}</Fact>
        <Fact term="Last update">{row.updatedAt}</Fact>
      </dl>
      {d.progress ? <div className="ledger-progress">
        <div className="ledger-progress-label"><span>Elapsed {d.progress.elapsed} of {d.progress.total}</span><strong>≈{d.progress.percent}%</strong></div>
        <progress value={d.progress.fraction} max={1} aria-label={`Elapsed time ${d.progress.percent}%, ${ESTIMATE_NOTE}`}/>
        <small>{d.progress.dueReached ? 'Due time reached; waiting for the ledger outcome. ' : ''}Estimated from sim start/due times — not verified.</small>
      </div> : null}
      {d.progressNote ? <p className="ledger-note">{d.progressNote}</p> : null}
    </section>

    <section className="ledger-section"><h3>Dependencies</h3>
      {d.dependencies.length
        ? <ul className="ledger-deps">{d.dependencies.map((dep) => <li key={dep.commandKey}><code>{dep.commandKey}</code><Badge tone={dep.tone}>{dep.status}</Badge></li>)}</ul>
        : <p className="ledger-note">No dependencies.</p>}
    </section>

    {row.blocked ? null : safety}

    {row.verification ? <section className="ledger-section"><h3>Verification</h3>
      <p className="ledger-note"><Badge tone={row.verification.tone}>{row.verification.label}</Badge>{row.verification.note ? ` ${row.verification.note}` : ''}</p>
      {row.verification.state === 'unverified' ? <p className="ledger-note">The ledger reports the operation finished. Recovery is not established until a verification is recorded.</p> : null}
      <Evidence items={row.verification.evidence}/>
    </section> : null}

    <section className="ledger-section"><h3>Lifecycle history</h3>
      <p className="ledger-lifecycle-order">{LIFECYCLE}</p>
      {d.history.length
        ? <ol className="ledger-history">{d.history.map((h) => <li key={h.key}>
          <div className="ledger-history-head"><Badge tone={h.tone}>{h.label}</Badge><span>{h.version}</span><time>{h.simTime}</time></div>
          {h.reason ? <p className="ledger-reason">{h.reason.text} <code className="ledger-inline-code">{h.reason.code}</code></p> : null}
          {h.notes.map((note, i) => <p key={i} className="ledger-history-note">{note}</p>)}
        </li>)}</ol>
        : <p className="ledger-note">No lifecycle events received.</p>}
    </section>
  </>;
}

function SafetySection({ title, view, missing }: { title: string; view: SafetyView | null; missing: string }) {
  return <section className="ledger-section"><h3>{title}</h3>
    {view ? <>
      <p className="ledger-note"><Badge tone={view.tone}>{view.label}</Badge> Checked at decision epoch {view.checkedEpoch}</p>
      {view.violations.length ? <Violations items={view.violations}/> : <p className="ledger-note">No violations.</p>}
      {view.evidence.length ? <Evidence items={view.evidence}/> : <p className="ledger-note">No evidence recorded.</p>}
    </> : <p className="ledger-note">{missing}</p>}
  </section>;
}

function Violations({ items }: { items: ReasonView[] }) {
  return <ul className="ledger-violations">{items.map((v) => <li key={v.code}>{v.text} <code className="ledger-inline-code">{v.code}</code></li>)}</ul>;
}

function Evidence({ items }: { items: EvidenceItem[] }) {
  if (!items.length) return null;
  return <dl className="ledger-evidence">{items.map((e) => <div key={e.key} className={e.tone ? `ledger-evidence-${e.tone}` : undefined}>
    <dt>{e.label}{e.tone ? <span className="ledger-verdict">{e.tone === 'danger' ? 'fails' : 'meets'}</span> : null}</dt>
    <dd>{e.value}</dd>
  </div>)}</dl>;
}

function Fact({ term, children, wide = false }: { term: string; children: ReactNode; wide?: boolean }) {
  return <div className={wide ? 'ledger-fact-wide' : undefined}><dt>{term}</dt><dd>{children}</dd></div>;
}
