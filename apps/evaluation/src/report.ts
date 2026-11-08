import { validatePayload, type EvaluationResult } from '@dcos/contracts';

export const policies = ['reactive', 'threshold', 'nemotron'] as const;
export const policyLabels = { reactive: 'Reactive rule-based', threshold: 'Threshold-based', nemotron: 'Nemotron' };
export const metrics = ['lost_work_units', 'job_completion_delay_s', 'gpu_busy_waste_s', 'unnecessary_preemptions', 'unsafe_actions_executed', 'unsafe_actions_blocked', 'successful_recoveries', 'failed_recoveries', 'agent_crash_resumes'] as const;
export type Metric = typeof metrics[number];
export type Distribution = { total: number; mean: number; median: number; p95: number; min: number; max: number };
export function distribution(values: number[]): Distribution | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const middle = Math.floor(sorted.length / 2);
  return { total: sum, mean: sum / sorted.length, median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, p95: sorted[Math.ceil(sorted.length * 0.95) - 1], min: sorted[0], max: sorted.at(-1)! };
}
export function requireResult(value: unknown): EvaluationResult {
  const validation = validatePayload('EvaluationResult', value);
  if (!validation.ok) throw new Error(`Invalid EvaluationResult: ${validation.errors.join('; ')}`);
  const row = value as EvaluationResult;
  if (metrics.some((metric) => !Number.isFinite(row[metric]) || row[metric] < 0)) throw new Error('Evaluation metrics must be finite and non-negative.');
  return row;
}
const comparisonKey = (row: EvaluationResult) => JSON.stringify([row.run_id, row.scenario_id, row.seed]);
export function summarizeResults(input: readonly unknown[]) {
  let invalid = 0;
  let duplicates = 0;
  const groups = new Map<string, Map<EvaluationResult['policy'], EvaluationResult>>();
  const conflicts = new Set<string>();
  for (const value of input) {
    let row: EvaluationResult;
    try { row = requireResult(value); } catch { invalid++; continue; }
    const key = comparisonKey(row);
    const group = groups.get(key) ?? new Map();
    const previous = group.get(row.policy);
    if (previous) {
      duplicates++;
      if (metrics.some((metric) => previous[metric] !== row[metric])) conflicts.add(key);
      continue;
    }
    group.set(row.policy, row); groups.set(key, group);
  }
  const matched = [...groups.entries()].filter(([key, group]) => group.size === 3 && !conflicts.has(key)).map(([, group]) => group);
  const summaries = policies.map((policy) => ({ policy, count: matched.length, metrics: Object.fromEntries(metrics.map((metric) => [metric, distribution(matched.map((group) => group.get(policy)![metric]))])) as Record<Metric, Distribution | null> }));
  const losses = matched.flatMap((group) => {
    const nemotron = group.get('nemotron')!;
    return (['reactive', 'threshold'] as const).flatMap((baseline) => {
      const other = group.get(baseline)!;
      const worse = (['lost_work_units', 'job_completion_delay_s', 'gpu_busy_waste_s', 'unnecessary_preemptions', 'unsafe_actions_executed', 'failed_recoveries'] as const).filter((metric) => nemotron[metric] > other[metric]);
      return worse.length ? [{ run_id: nemotron.run_id, scenario_id: nemotron.scenario_id, seed: nemotron.seed, baseline, worse, nemotron, other }] : [];
    });
  });
  return { summaries, losses, matchedCount: matched.length, incompleteCount: groups.size - matched.length, invalidCount: invalid, duplicateCount: duplicates, conflictingCount: conflicts.size };
}

/**
 * Reasons a set of rows must not be compared: mixed batch_id, mixed code_revision, provenance present on only some rows,
 * or different horizons for one scenario/seed. Rows without provenance (legacy) are only reported as a mix, never defaulted.
 */
export function provenanceConflicts(rows: readonly EvaluationResult[]): string[] {
  const out: string[] = [];
  const withProv = rows.filter((r) => r.provenance);
  if (withProv.length === 0) return out;
  if (withProv.length !== rows.length) out.push(`${rows.length - withProv.length} row(s) lack provenance while ${withProv.length} carry it`);
  const distinct = (pick: (r: EvaluationResult) => string) => [...new Set(withProv.map(pick))].sort();
  const batches = distinct((r) => r.provenance!.batch_id);
  if (batches.length > 1) out.push(`mixed batch_id: ${batches.join(', ')}`);
  const revisions = distinct((r) => r.provenance!.code_revision);
  if (revisions.length > 1) out.push(`mixed code_revision: ${revisions.join(', ')}`);
  const horizons = new Map<string, Set<number>>();
  for (const r of withProv) {
    const key = `${r.scenario_id}/${r.seed}`;
    horizons.set(key, (horizons.get(key) ?? new Set()).add(r.provenance!.horizon_sim_s));
  }
  for (const [key, set] of horizons) if (set.size > 1) out.push(`mixed horizon_sim_s for ${key}: ${[...set].sort((a, b) => a - b).join(', ')}`);
  return out;
}
export function assertConsistentProvenance(rows: readonly EvaluationResult[]): void {
  const problems = provenanceConflicts(rows);
  if (problems.length) throw new Error(`Refusing to compare mismatched evaluation batches: ${problems.join('; ')}.`);
}
