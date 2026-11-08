import { useId, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, Ban, Download } from 'lucide-react';
import type { EvaluationResult } from '@dcos/contracts';
import { policies, type Distribution } from '@dcos/evaluation';
import { Panel, Badge } from '../ui/panel';
import { Button } from '../ui/button';
import { number } from '../../lib/utils';
import {
  baselines, buildScoreboard, exportPayload, headlineMetrics, metricInfo, metricLabel, metricValue, provenanceLabel, provenanceLine, shortRevision,
  tally, unfinishedTotal, verdict, verdictText, viewMetrics,
  type Case, type ColumnProvenance, type HeadlineTally, type Outcome, type Policy, type ScoreboardView, type Verdict, type ViewMetric,
} from './scoreboard-view';
import './scoreboard.css';

const verdictTone: Record<Verdict, string> = { win: 'agent', tie: 'neutral', loss: 'warning', unknown: 'neutral', unranked: 'neutral' };
const fmt = (value: number | null | undefined, digits = 1) => value === null || value === undefined ? 'unknown' : number(value, digits);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (values: readonly string[]) => values.length ? values.join(', ') : 'none';

export function Scoreboard({ results, mode, onLoadRehearsal, onLoadReal }: {
  results: EvaluationResult[]; mode: 'mock' | 'live';
  /** Mock only: publishes the deterministic (no model) rehearsal batch into the mock client. */
  onLoadRehearsal?: () => void;
  /** Mock only: publishes the measured Nemotron batch fixture (live calls, cache hits and fallbacks per row). */
  onLoadReal?: () => void;
}) {
  const view = useMemo(() => buildScoreboard(results), [results]);
  function download() {
    const blob = new Blob([JSON.stringify(exportPayload(view, mode, results), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'datacenteros-evaluation.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  const source = mode === 'mock' ? 'mock data source' : 'live evaluation_result rows';
  return <Panel title="Policy benchmarks" id="scoreboard" detail={<Badge>Simulated workloads</Badge>}>
    <div className="scoreboard-intro"><p>Same scenarios. Same seeds. Every outcome, including ties and losses. No dollar or GPU-hour conversions.</p><Button variant="ghost" size="sm" onClick={download} disabled={!results.length}><Download size={14} aria-hidden="true"/>Export results</Button></div>
    {!results.length ? <EmptyState onLoadRehearsal={mode === 'mock' ? onLoadRehearsal : undefined} onLoadReal={mode === 'mock' ? onLoadReal : undefined}/>
      : !view.comparable ? <Refusal view={view} source={source}/>
      : !view.cases.length ? <div className="benchmark-empty"><BarChart3 size={31} strokeWidth={1.3} aria-hidden="true"/><h3>No matched evaluation runs yet</h3><p>Comparisons appear after reactive, threshold and nemotron-policy results arrive for the same run, scenario and seed. {view.valid.length} valid row(s) received from the {source}; none form a complete case.</p></div>
      : <Comparison view={view} source={source}/>}
    {(view.invalid > 0 || view.report.incompleteCount > 0 || view.report.duplicateCount > 0) && <p className="data-warning" role="status">{view.report.incompleteCount} unmatched/conflicting groups excluded; {view.invalid} invalid rows; {view.report.duplicateCount} duplicate rows ignored.</p>}
  </Panel>;
}

function EmptyState({ onLoadRehearsal, onLoadReal }: { onLoadRehearsal?: () => void; onLoadReal?: () => void }) {
  return <div className="benchmark-empty"><BarChart3 size={31} strokeWidth={1.3} aria-hidden="true"/><h3>No matched evaluation runs yet</h3>
    <p>Comparisons appear after reactive, threshold and nemotron-policy results arrive for the same run, scenario and seed. No benchmark values are prefilled.</p>
    {(onLoadReal || onLoadRehearsal) && <div className="sb-loaders">
      {onLoadReal && <div className="sb-rehearsal"><Button variant="secondary" size="sm" onClick={onLoadReal}>Load Nemotron batch (mock only)</Button><small>Measured 12-case × 3-policy batch. Each nemotron-policy row records its live model calls, cache hits and fallbacks.</small></div>}
      {onLoadRehearsal && <div className="sb-rehearsal"><Button variant="secondary" size="sm" onClick={onLoadRehearsal}>Load deterministic rehearsal batch (mock only)</Button><small>Measured 12-case × 3-policy rehearsal with no model calls. It cannot substantiate a Nemotron performance claim.</small></div>}
    </div>}
    <div>{['Reactive rule-based baseline', 'Threshold-based baseline', 'Nemotron policy'].map((name) => <span key={name}>{name}<small>Awaiting results</small></span>)}</div>
  </div>;
}

function Refusal({ view, source }: { view: ScoreboardView; source: string }) {
  return <section className="sb-refusal" aria-labelledby="sb-refusal-heading">
    <h3 id="sb-refusal-heading"><Ban size={15} aria-hidden="true"/>Comparison refused: rows come from mismatched runs</h3>
    <p>The {source} mix batches, revisions, horizons or versions (results are stored per scenario, policy and seed, so a partial publication can overwrite part of an older batch). Comparison tables are hidden until a single consistent batch is loaded.</p>
    <ul className="sb-reasons">{view.conflicts.map((reason) => <li key={reason}>{reason}</li>)}</ul>
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Rows by batch"><table>
      <caption className="sr-only">Rows received, grouped by batch</caption>
      <thead><tr><th scope="col">Batch</th><th scope="col">Rows</th><th scope="col">Cases</th><th scope="col">Policies</th><th scope="col">Code revision</th><th scope="col">Horizons (sim-s)</th></tr></thead>
      <tbody>{view.batches.map((batch) => <tr key={batch.batch_id ?? 'legacy'}>
        <th scope="row">{batch.batch_id ? <code>{batch.batch_id}</code> : 'No provenance (legacy rows)'}</th>
        <td className="numeric">{batch.rows}</td><td className="numeric">{batch.cases}</td><td>{batch.policies.join(', ')}</td>
        <td>{batch.code_revisions.length ? batch.code_revisions.map((rev) => <code key={rev}>{shortRevision(rev)}</code>) : 'unknown'}</td>
        <td className="numeric">{batch.horizons.length ? batch.horizons.join(', ') : 'unknown'}</td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}

/**
 * Reading order for a judge: three lost-work numbers, the win/tie/loss tallies, one provenance line, the claim banner
 * when the rows cannot support a Nemotron claim, the open losses list, then batch and per-scenario detail behind
 * disclosures. Nothing below the headline repeats the headline.
 */
function Comparison({ view, source }: { view: ScoreboardView; source: string }) {
  const { cases, names, shortNames, columns } = view;
  const countLine = `${cases.length} matched scenario/seed cases · ${cases.length * policies.length} policy runs · ${source}`;
  const ours = view.headline.find((column) => column.policy === 'nemotron');
  return <>
    <Headline view={view}/>
    {ours && <p className="sb-line sb-line-tallies"><span className="sb-line-label">{shortNames.nemotron}, on lost work</span>{ours.tallies.map((t) => <span key={t.versus} className="sb-tally"><strong>{tallyText(t)}</strong> vs {shortNames[t.versus]}</span>)}</p>}
    <p className="sb-line sb-model-use" data-testid="sb-model-use-line"><Badge tone={columns[2].uniform?.tone ?? 'warning'}>{columns[2].headline}</Badge><span>{provenanceLine(view)}</span></p>
    {view.claim.banner && <div className="sb-banner" role="note"><AlertTriangle size={16} aria-hidden="true"/><div><strong>Cannot substantiate a Nemotron performance claim</strong><p>{view.claim.banner}</p></div></div>}
    {/* the honesty point judges should see without clicking: every case where our column is worse on any metric */}
    <Outcomes title={`Cases where ${names.nemotron} loses or trades off`} open items={view.report.losses.flatMap((loss) => loss.worse.map((metric): Outcome => ({ scenario_id: loss.scenario_id, seed: loss.seed, baseline: loss.baseline, metric, ours: loss.nemotron[metric], theirs: loss.other[metric] })))} names={names} empty="No worse values on lost work, finite-horizon work deficit, GPU busy waste, unnecessary interventions, unsafe execution or failed recoveries."/>
    <details className="report-details sb-provenance"><summary>Batch provenance<small>{countLine}</small></summary>
      {view.legacyOnly ? <p className="data-warning">Provenance unavailable on every row (legacy results). Batch, revision, horizon and model use cannot be checked, so these results cannot be certified. Unfinished jobs are unknown.</p> : <BatchSummary view={view}/>}
      <ProvenanceColumns columns={columns} names={names}/>
    </details>
    <details className="report-details sb-all"><summary>Per-scenario results<small>every case · aggregates · distributions · ties</small></summary>
      <Tallies cases={cases} name={names.nemotron} label={columns[2].headline}/>
      <CaseTable cases={cases} names={shortNames} columns={columns}/>
      <Aggregates view={view}/>
      <Outcomes title={`Ties on lost work or finite-horizon work deficit`} items={view.outcomes.ties} names={names} empty="No ties on the headline metrics."/>
    </details>
  </>;
}

const tallyText = (t: HeadlineTally) => `${plural(t.win, 'win')} · ${plural(t.tie, 'tie')} · ${plural(t.loss, 'loss', 'losses')}${t.unknown ? ` · ${t.unknown} unknown` : ''}`;

/**
 * Headline: three numbers (lost work per policy over the matched cases), from `view.headline` only. The lowest column
 * is tinted only when the nemotron rows are model-backed; a deterministic-only or legacy column never gets a favouring colour.
 */
function Headline({ view }: { view: ScoreboardView }) {
  const { cases, shortNames } = view;
  const mayTint = view.claim.substantiated;
  return <section className="sb-headline" aria-labelledby="sb-headline-heading">
    <h3 id="sb-headline-heading">Lost work over {plural(cases.length, 'matched case')}<span>work units, summed · lower is better</span></h3>
    <ul className="sb-headline-grid">{view.headline.map((column) => <li key={column.policy} className="sb-headline-col stat" data-lowest={column.lowest && mayTint ? 'true' : undefined}>
      <strong className="stat-value sb-headline-value numeric">{fmt(column.lostWork)}</strong>
      <span className="stat-label sb-headline-name">{shortNames[column.policy]}</span>
    </li>)}</ul>
  </section>;
}

function BatchSummary({ view }: { view: ScoreboardView }) {
  const h = view.header;
  const latency = h.latencyModels.length === 1 && h.latencyModels[0] === 'zero_simulated_decision_latency' ? 'Zero simulated decision latency' : list(h.latencyModels);
  return <section className="sb-batch" aria-labelledby="sb-batch-heading">
    <h3 id="sb-batch-heading">Batch provenance</h3>
    <dl className="sb-facts">
      <div><dt>Batch</dt><dd><code>{list(h.batchIds)}</code></dd></div>
      <div><dt>Code revision</dt><dd>{h.codeRevisions.map((rev) => <code key={rev}>{shortRevision(rev)}</code>)}</dd></div>
      <div><dt>Physics profile</dt><dd><code>{list(h.physicsProfiles)}</code></dd></div>
      <div className="sb-wide"><dt>Policy versions</dt><dd><ul>{policies.map((policy) => <li key={policy}><span>{policy}</span> <code>{list(h.policyVersions[policy])}</code></li>)}</ul></dd></div>
      <div><dt>Model (nemotron policy)</dt><dd><code>{list(h.modelIds)}</code></dd></div>
      <div><dt>Prompt version</dt><dd><code>{list(h.promptVersions)}</code></dd></div>
      <div><dt>Horizons (sim-s)</dt><dd>{h.horizons.map((x) => `${x.horizon_sim_s} s × ${x.cases} case${x.cases === 1 ? '' : 's'}`).join(', ')}</dd></div>
      <div><dt>Simulated latency</dt><dd>{latency}</dd></div>
      <div className="sb-wide"><dt>Measured wall time in policy calls (separate from simulated time)</dt><dd className="numeric">{number(h.wallTimeMs.total / 1000, 1)} s total · {policies.map((policy) => `${policy} ${number(h.wallTimeMs[policy] / 1000, 1)} s`).join(' · ')}</dd></div>
      <div className="sb-wide"><dt>Model usage (all rows)</dt><dd className="numeric">{h.counts.model_requests} requests · {h.counts.live_model_responses} live responses · {h.counts.cache_hits} cache hits · {h.counts.fallback_decisions} fallback decisions</dd></div>
    </dl>
    <p className="sb-note">Agent crash resumes are not reported: offline runs cannot show crash recovery (live crash evidence is shown separately).</p>
  </section>;
}

function ProvenanceColumns({ columns, names }: { columns: ColumnProvenance[]; names: Record<Policy, string> }) {
  return <ul className="sb-columns" aria-label="Provenance by policy">{columns.map((column) => <li key={column.policy}>
    <span>{names[column.policy]}</span>
    <Badge tone={column.uniform?.tone ?? 'warning'}>{column.headline}</Badge>
    {column.uniform && <small>{column.uniform.detail}</small>}
  </li>)}</ul>;
}

function Tallies({ cases, name, label }: { cases: Case[]; name: string; label: string }) {
  return <div className="sb-section"><h3>{name} vs baselines, per case</h3><p className="sb-note">Provenance: {label}. Counts of cases only; no percentage claims.</p>
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Win, tie and loss counts"><table className="sb-narrow">
      <thead><tr><th scope="col">Metric (lower is better)</th>{baselines.map((b) => <th scope="col" key={b} className="numeric">vs {b}</th>)}</tr></thead>
      <tbody>{headlineMetrics.map((metric) => <tr key={metric}><th scope="row">{metricLabel(metric)}</th>{baselines.map((b) => <td key={b} className="numeric">{tallyText({ versus: b, ...tally(cases, metric, b) })}</td>)}</tr>)}</tbody>
    </table></div>
  </div>;
}

function CaseTable({ cases, names, columns }: { cases: Case[]; names: Record<Policy, string>; columns: ColumnProvenance[] }) {
  const [metric, setMetric] = useState<ViewMetric>('lost_work_units');
  const selectId = useId();
  const info = metricInfo[metric];
  const ranked = info.direction !== 'unranked';
  // the per-row provenance pill repeats the column header when every nemotron row carries the same label
  const perRowProvenance = columns[2].uniform === null;
  return <div className="sb-section"><h3>Per-scenario results</h3>
    <div className="sb-toolbar"><label htmlFor={selectId}>Metric</label><select id={selectId} value={metric} onChange={(event) => setMetric(event.target.value as ViewMetric)}>{viewMetrics.map((m) => <option key={m} value={m}>{metricLabel(m)}</option>)}</select></div>
    <p className="sb-note">{info.label} ({info.unit}){ranked ? ', lower is better' : ''}. {info.note ?? ''}</p>
    <div className="table-scroll" tabIndex={0} role="region" aria-label={`Per-scenario ${info.label}`}><table className="sb-dense">
      <thead><tr><th scope="col">Scenario · seed</th>{policies.map((p) => <th scope="col" key={p} className="numeric">{names[p]}</th>)}{baselines.map((b) => <th scope="col" key={b}>vs {b}</th>)}{perRowProvenance && <th scope="col">Nemotron-policy row provenance</th>}</tr></thead>
      <tbody>{cases.map((item) => { const nem = provenanceLabel(item.rows.nemotron); return <tr key={item.key}>
        <th scope="row"><code>{item.scenario_id}</code><small>seed {item.seed} · horizon {item.horizon_sim_s === null ? 'unknown' : `${item.horizon_sim_s} s`}</small></th>
        {policies.map((policy, index) => <MetricCell key={policy} row={item.rows[policy]} metric={metric} uniform={columns[index].uniform !== null}/>)}
        {baselines.map((b) => { const v = verdict(item, metric, b); return <td key={b}><Badge tone={verdictTone[v]}>{verdictText[v]}</Badge></td>; })}
        {perRowProvenance && <td><Badge tone={nem.tone}>{nem.text}</Badge></td>}
      </tr>; })}</tbody>
    </table></div>
  </div>;
}

function MetricCell({ row, metric, uniform }: { row: EvaluationResult; metric: ViewMetric; uniform: boolean }) {
  const value = metricValue(row, metric);
  const p = row.provenance;
  return <td className="numeric">
    <span className="numeric">{fmt(value)}</span>
    {metric === 'unfinished_jobs' && p && p.unfinished_job_ids.length > 0 && <small>{p.unfinished_job_ids.join(', ')}{p.failed_job_ids.length ? ` (failed: ${p.failed_job_ids.join(', ')})` : ''}</small>}
    {!uniform && <small>{provenanceLabel(row).text}</small>}
  </td>;
}

const range = (d: Distribution | null) => d ? `${number(d.min, 1)}–${number(d.max, 1)}` : 'unknown';
function Aggregates({ view }: { view: ScoreboardView }) {
  const { summaries } = view.report;
  const cell = (d: Distribution | null, key: 'total' | 'mean') => <td className="numeric">{fmt(d?.[key])}</td>;
  return <>
    <div className="sb-section"><h3>Aggregate over matched cases</h3>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Aggregate policy comparison"><table className="sb-dense">
        <thead><tr><th scope="col">Policy</th>{['Lost work (total)', 'Finite-horizon work deficit (mean s)', 'GPU busy waste (total s)', 'Unnecessary interventions', 'Unsafe blocked / executed', 'Recoveries succeeded / failed', 'Unfinished jobs (total)'].map((label) => <th scope="col" key={label} className="numeric">{label}</th>)}</tr></thead>
        <tbody>{summaries.map((row, index) => { const m = row.metrics; return <tr key={row.policy}>
          <th scope="row">{view.shortNames[row.policy]}<small>{view.columns[index].headline}</small></th>
          {cell(m.lost_work_units, 'total')}{cell(m.job_completion_delay_s, 'mean')}{cell(m.gpu_busy_waste_s, 'total')}{cell(m.unnecessary_preemptions, 'total')}
          <td className="numeric">{fmt(m.unsafe_actions_blocked?.total, 0)} / {fmt(m.unsafe_actions_executed?.total, 0)}</td>
          <td className="numeric">{fmt(m.successful_recoveries?.total, 0)} / {fmt(m.failed_recoveries?.total, 0)}</td>
          <td className="numeric">{fmt(unfinishedTotal(view.cases, row.policy), 0)}</td>
        </tr>; })}</tbody>
      </table></div>
    </div>
    <details className="report-details"><summary>Distributions across cases</summary><div className="table-scroll" tabIndex={0} role="region" aria-label="Evaluation distributions"><table className="sb-dense">
      <thead><tr><th scope="col">Policy</th>{['Deficit median (s)', 'Deficit p95 (s)', 'Deficit range (s)', 'Lost work median', 'Lost work range'].map((label) => <th scope="col" key={label} className="numeric">{label}</th>)}</tr></thead>
      <tbody>{summaries.map((row) => { const d = row.metrics.job_completion_delay_s; const l = row.metrics.lost_work_units; return <tr key={row.policy}><th scope="row">{view.shortNames[row.policy]}</th><td className="numeric">{fmt(d?.median)}</td><td className="numeric">{fmt(d?.p95)}</td><td className="numeric">{range(d)}</td><td className="numeric">{fmt(l?.median)}</td><td className="numeric">{range(l)}</td></tr>; })}</tbody>
    </table></div><p>Finite-horizon work deficit is a lower bound truncated at each case horizon, not measured completion time.</p></details>
  </>;
}

function Outcomes({ title, items, names, empty, open = false }: { title: string; items: Outcome[]; names: Record<Policy, string>; empty: string; open?: boolean }) {
  return <details className="report-details" open={open && items.length > 0}><summary>{title} ({items.length})</summary>
    {items.length ? <ul className="loss-list">{items.map((item) => <li key={`${item.scenario_id}-${item.seed}-${item.baseline}-${item.metric}`}>
      <strong>{item.scenario_id}</strong> · seed {item.seed} · compared with {names[item.baseline]}
      <span>{metricLabel(item.metric)}: {number(item.ours, 1)} vs {number(item.theirs, 1)}</span>
    </li>)}</ul> : <p>{empty}</p>}
  </details>;
}
