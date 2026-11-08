import { useMemo } from 'react';
import { BarChart3, Download } from 'lucide-react';
import type { EvaluationResult } from '@dcos/contracts';
import { summarizeResults, policyLabels, type Metric } from '@dcos/evaluation';
import { Panel, Badge } from '../ui/panel';
import { Button } from '../ui/button';
import { number } from '../../lib/utils';
const columns: Array<{ name: string; metric: Metric; aggregate: 'total' | 'mean' }> = [
  { name: 'Lost work', metric: 'lost_work_units', aggregate: 'total' }, { name: 'Mean delay (s)', metric: 'job_completion_delay_s', aggregate: 'mean' },
  { name: 'GPU waste (s)', metric: 'gpu_busy_waste_s', aggregate: 'total' }, { name: 'Needless moves', metric: 'unnecessary_preemptions', aggregate: 'total' },
  { name: 'Unsafe blocked', metric: 'unsafe_actions_blocked', aggregate: 'total' }, { name: 'Unsafe executed', metric: 'unsafe_actions_executed', aggregate: 'total' },
];
export function Scoreboard({ results, mode }: { results: EvaluationResult[]; mode: 'mock' | 'live' }) {
  const report = useMemo(() => summarizeResults(results), [results]);
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ source: mode, results, report }, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'datacenteros-evaluation.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return <Panel title="Policy benchmarks" id="scoreboard" detail={<Badge>Simulated workloads</Badge>}>
    <div className="scoreboard-intro"><p>Same scenarios. Same seeds. Every outcome.</p><Button variant="ghost" size="sm" onClick={download} disabled={!results.length}><Download size={14}/>Export results</Button></div>
    {!report.matchedCount ? <div className="benchmark-empty"><BarChart3 size={31} strokeWidth={1.3}/><h3>No matched evaluation runs yet</h3><p>Comparisons appear after reactive, threshold and Nemotron results arrive for the same run, scenario and seed. No benchmark values are prefilled.</p><div>{['Reactive rule-based baseline', 'Threshold-based baseline', 'Nemotron planner'].map((name) => <span key={name}>{name}<small>Awaiting results</small></span>)}</div></div> : <><p className="panel-footnote">{report.matchedCount} matched scenario/seed groups · {report.matchedCount * 3} policy runs · {mode === 'mock' ? 'mock data source' : 'live evaluation_result rows'}</p><div className="table-scroll" tabIndex={0} aria-label="Policy comparison"><table><thead><tr><th scope="col">Policy</th>{columns.map((c) => <th scope="col" key={c.metric}>{c.name}</th>)}<th scope="col">Unfinished jobs</th></tr></thead><tbody>{report.summaries.map((row) => <tr key={row.policy}><th scope="row">{policyLabels[row.policy]}</th>{columns.map((column) => <td className="numeric" key={column.metric}>{number(row.metrics[column.metric]?.[column.aggregate] ?? 0, 1)}</td>)}<td>Unavailable</td></tr>)}</tbody></table></div>
      <details className="report-details"><summary>Delay distributions and recovery outcomes</summary><div className="table-scroll" tabIndex={0} aria-label="Evaluation distributions"><table><thead><tr><th>Policy</th><th>Median delay (s)</th><th>p95 delay (s)</th><th>Delay range (s)</th><th>Recovered / failed</th><th>Crash resumes</th></tr></thead><tbody>{report.summaries.map((row) => { const d = row.metrics.job_completion_delay_s!; return <tr key={row.policy}><th>{policyLabels[row.policy]}</th><td>{number(d.median, 1)}</td><td>{number(d.p95, 1)}</td><td>{number(d.min, 1)}–{number(d.max, 1)}</td><td>{row.metrics.successful_recoveries?.total} / {row.metrics.failed_recoveries?.total}</td><td>{row.metrics.agent_crash_resumes?.total}</td></tr>; })}</tbody></table></div></details>
      <details className="report-details" open={report.losses.length > 0}><summary>Cases where Nemotron loses or trades off ({report.losses.length})</summary>{report.losses.length ? <ul className="loss-list">{report.losses.map((loss) => <li key={`${loss.run_id}-${loss.scenario_id}-${loss.seed}-${loss.baseline}`}><strong>{loss.scenario_id}</strong> · seed {loss.seed} · compared with {policyLabels[loss.baseline]}<span>{loss.worse.map((metric) => `${metric.replaceAll('_', ' ')}: ${number(loss.nemotron[metric], 1)} vs ${number(loss.other[metric], 1)}`).join('; ')}</span></li>)}</ul> : <p>No worse values on the reported loss, delay, waste, moves, unsafe execution or failed-recovery metrics.</p>}</details></>}
    {(report.incompleteCount > 0 || report.invalidCount > 0 || report.duplicateCount > 0) && <p className="data-warning" role="status">{report.incompleteCount} unmatched/conflicting groups excluded; {report.invalidCount} invalid rows; {report.duplicateCount} duplicate rows ignored.</p>}
    <p className="panel-footnote">Cache usage, unfinished jobs, and policy/physics versions: not supplied by the current result contract. Gate 4 remains unverified until that provenance is available.</p>
  </Panel>;
}
