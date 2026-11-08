import type { EvaluationResult } from '@dcos/contracts';
import { metrics, policies, policyLabels, provenanceConflicts, requireResult, summarizeResults, type Metric } from '@dcos/evaluation';

/**
 * Pure view logic for the R6 scoreboard (CONTRACTS §0.14, SCOPE §7). Every visible label is derived from the row's
 * `provenance` object, never from `policy`: `policy: "nemotron"` alone does not establish that a model ran.
 */
export type Policy = EvaluationResult['policy'];
export type Provenance = NonNullable<EvaluationResult['provenance']>;

/**
 * Provenance label rules, applied in this order (counts are the row's provenance counters):
 *  1. no `provenance` object                                   → `unavailable`  "Provenance unavailable" (legacy row)
 *  2. live_model_responses + cache_hits > model_requests       → `inconsistent` (a response cannot exceed the attempts)
 *  3. model_enabled false and any request/live/cache count > 0 → `inconsistent`
 *  4. model_enabled false                                      → `deterministic`: nemotron policy "Deterministic planner,
 *     no model calls"; reactive/threshold "Rule baseline". fallback_decisions may be > 0 here (explicit no-model mode
 *     counts its planner selections as fallbacks), which does not change the label.
 *  5. model enabled, fallback_decisions > 0, some live/cached response → `mixed_fallback` "Mixed fallback"
 *  6. model enabled, no live/cached response, but fallback_decisions > 0 or model_requests > 0
 *                                                              → `fallback_only` "Fallback only" (no usable model choice)
 *  7. model enabled, no fallbacks, live > 0 and cache > 0      → `mixed_live_cached` "Mixed live + cached"
 *  8. model enabled, no fallbacks, live > 0, cache 0           → `model_assisted` "Model-assisted"
 *  9. model enabled, no fallbacks, cache > 0, live 0           → `cached` "Cached model responses"
 * 10. model enabled, every counter 0                           → `no_model_call` "No model call needed" (legitimate for
 *     no-action cases)
 */
export type ProvenanceKind = 'model_assisted' | 'cached' | 'mixed_live_cached' | 'mixed_fallback' | 'fallback_only' | 'no_model_call' | 'deterministic' | 'inconsistent' | 'unavailable';
export type Tone = 'agent' | 'neutral' | 'warning' | 'danger';
export type ProvenanceLabel = { kind: ProvenanceKind; text: string; detail: string; tone: Tone };

export function provenanceKind(row: Pick<EvaluationResult, 'provenance'>): ProvenanceKind {
  const p = row.provenance;
  if (!p) return 'unavailable';
  const { model_requests: requests, live_model_responses: live, cache_hits: cache, fallback_decisions: fallbacks } = p;
  if (live + cache > requests) return 'inconsistent';
  if (!p.model_enabled) return requests > 0 || live > 0 || cache > 0 ? 'inconsistent' : 'deterministic';
  const responses = live + cache;
  if (fallbacks > 0 && responses > 0) return 'mixed_fallback';
  if (responses === 0 && (fallbacks > 0 || requests > 0)) return 'fallback_only';
  if (live > 0 && cache > 0) return 'mixed_live_cached';
  if (live > 0) return 'model_assisted';
  if (cache > 0) return 'cached';
  return 'no_model_call';
}

const kindText: Record<Exclude<ProvenanceKind, 'deterministic'>, Omit<ProvenanceLabel, 'kind'>> = {
  model_assisted: { text: 'Model-assisted', detail: 'Live model responses, no fallback decisions.', tone: 'agent' },
  cached: { text: 'Cached model responses', detail: 'Responses replayed from an identified model/prompt cache; not an independent fresh trial.', tone: 'neutral' },
  mixed_live_cached: { text: 'Mixed live + cached', detail: 'Some live model responses and some replayed from cache; no fallback decisions.', tone: 'neutral' },
  mixed_fallback: { text: 'Mixed fallback', detail: 'Model enabled, but some decisions were made by the code fallback without a usable model choice.', tone: 'warning' },
  fallback_only: { text: 'Fallback only', detail: 'Model enabled, but no usable model response; the code fallback made every decision.', tone: 'warning' },
  no_model_call: { text: 'No model call needed', detail: 'Model enabled; this case required no model call (zero requests, zero fallbacks).', tone: 'neutral' },
  inconsistent: { text: 'Inconsistent provenance', detail: 'Counters contradict model_enabled or the request total; this row cannot be certified.', tone: 'danger' },
  unavailable: { text: 'Provenance unavailable', detail: 'Legacy row without provenance; cannot be certified.', tone: 'warning' },
};

export function provenanceLabel(row: Pick<EvaluationResult, 'policy' | 'provenance'>): ProvenanceLabel {
  const kind = provenanceKind(row);
  if (kind === 'deterministic') return row.policy === 'nemotron'
    ? { kind, text: 'Deterministic planner, no model calls', detail: 'model_enabled is false: the nemotron policy ran its deterministic planner only.', tone: 'warning' }
    : { kind, text: 'Rule baseline', detail: 'Rule-based policy; no model involved.', tone: 'neutral' };
  return { kind, ...kindText[kind] };
}

/** Kinds whose decisions came from model responses (live or identified cache). `no_model_call` is neutral, not evidence. */
const modelBacked: ReadonlySet<ProvenanceKind> = new Set(['model_assisted', 'cached', 'mixed_live_cached']);
const neutralForClaim: ReadonlySet<ProvenanceKind> = new Set([...modelBacked, 'no_model_call']);

export type ColumnProvenance = { policy: Policy; total: number; counts: Partial<Record<ProvenanceKind, number>>; uniform: ProvenanceLabel | null; headline: string };
export function columnProvenance(rows: readonly EvaluationResult[], policy: Policy): ColumnProvenance {
  const own = rows.filter((row) => row.policy === policy);
  const counts: Partial<Record<ProvenanceKind, number>> = {};
  const texts = new Map<string, number>();
  for (const row of own) {
    const label = provenanceLabel(row);
    counts[label.kind] = (counts[label.kind] ?? 0) + 1;
    texts.set(label.text, (texts.get(label.text) ?? 0) + 1);
  }
  const uniform = own.length && texts.size === 1 ? provenanceLabel(own[0]) : null;
  const headline = !own.length ? 'No rows' : uniform ? uniform.text : `Mixed across cases: ${[...texts].map(([text, n]) => `${n} ${text.toLowerCase()}`).join(', ')}`;
  return { policy, total: own.length, counts, uniform, headline };
}

/** Honest display name for the nemotron-policy column, derived from its rows' provenance. */
export function nemotronName(rows: readonly EvaluationResult[]): string {
  const own = rows.filter((row) => row.policy === 'nemotron').map(provenanceKind);
  if (!own.length) return 'Nemotron policy';
  if (own.every((kind) => kind === 'deterministic')) return 'Deterministic planner (nemotron policy, no model)';
  if (own.every((kind) => kind === 'unavailable')) return 'Nemotron policy (provenance unavailable)';
  if (own.every((kind) => neutralForClaim.has(kind)) && own.some((kind) => modelBacked.has(kind))) return own.some((kind) => kind !== 'model_assisted' && kind !== 'no_model_call') ? 'Nemotron planner (incl. cached responses)' : 'Nemotron planner (model-assisted)';
  return 'Nemotron policy (mixed provenance)';
}
export function policyName(policy: Policy, rows: readonly EvaluationResult[]): string {
  return policy === 'nemotron' ? nemotronName(rows) : policyLabels[policy];
}
/**
 * Short column heading for dense tables and the headline. Only the fully deterministic nemotron column gets the short
 * form ("no model calls" stays in the name); every other provenance mix keeps the full honest name.
 */
export function columnName(policy: Policy, rows: readonly EvaluationResult[]): string {
  if (policy !== 'nemotron') return policyLabels[policy];
  const own = rows.filter((row) => row.policy === 'nemotron').map(provenanceKind);
  return own.length && own.every((kind) => kind === 'deterministic') ? 'Nemotron policy · no model calls' : nemotronName(rows);
}

/**
 * Whether the nemotron-policy rows can support a Nemotron performance claim: every row must be model-backed or a
 * legitimate no-call case, and at least one row must actually be model-backed. Otherwise `banner` explains why not.
 */
export function nemotronClaim(rows: readonly EvaluationResult[]): { substantiated: boolean; banner: string | null } {
  const own = rows.filter((row) => row.policy === 'nemotron');
  if (!own.length) return { substantiated: false, banner: null };
  const kinds = own.map(provenanceKind);
  if (kinds.every((kind) => neutralForClaim.has(kind)) && kinds.some((kind) => modelBacked.has(kind))) return { substantiated: true, banner: null };
  const suffix = 'cannot substantiate a Nemotron performance claim.';
  if (kinds.every((kind) => kind === 'deterministic')) return { substantiated: false, banner: `Deterministic-only results: all ${own.length} nemotron-policy rows have model_enabled false and made no model calls. These results ${suffix}` };
  if (kinds.every((kind) => kind === 'unavailable')) return { substantiated: false, banner: `Provenance unavailable: nothing shows whether a model ran for the ${own.length} nemotron-policy rows. These results ${suffix}` };
  if (kinds.every((kind) => kind === 'no_model_call')) return { substantiated: false, banner: `No nemotron-policy row made a model call. These results ${suffix}` };
  const col = columnProvenance(own, 'nemotron');
  return { substantiated: false, banner: `Not fully model-assisted: ${col.headline.replace(/^Mixed across cases: /, '')}. Deterministic-only or mixed results ${suffix}` };
}

// ---- matched cases (mirrors summarizeResults' grouping so the per-scenario table agrees with its aggregates) ----

export type Case = { key: string; run_id: string; scenario_id: string; seed: number; horizon_sim_s: number | null; rows: Record<Policy, EvaluationResult> };
export function matchedCases(results: readonly unknown[]): { valid: EvaluationResult[]; invalid: number; cases: Case[] } {
  const valid: EvaluationResult[] = [];
  let invalid = 0;
  const groups = new Map<string, Map<Policy, EvaluationResult>>();
  const conflicting = new Set<string>();
  for (const value of results) {
    let row: EvaluationResult;
    try { row = requireResult(value); } catch { invalid++; continue; }
    valid.push(row);
    const key = JSON.stringify([row.run_id, row.scenario_id, row.seed]);
    const group = groups.get(key) ?? new Map<Policy, EvaluationResult>();
    const previous = group.get(row.policy);
    if (previous) { if (metrics.some((metric) => previous[metric] !== row[metric])) conflicting.add(key); continue; }
    group.set(row.policy, row); groups.set(key, group);
  }
  const cases = [...groups].filter(([key, group]) => group.size === policies.length && !conflicting.has(key)).map(([key, group]): Case => {
    const rows = Object.fromEntries(policies.map((policy) => [policy, group.get(policy)!])) as Record<Policy, EvaluationResult>;
    const first = rows.nemotron;
    return { key, run_id: first.run_id, scenario_id: first.scenario_id, seed: first.seed, horizon_sim_s: first.provenance?.horizon_sim_s ?? null, rows };
  });
  cases.sort((a, b) => a.scenario_id.localeCompare(b.scenario_id) || a.seed - b.seed || a.run_id.localeCompare(b.run_id));
  return { valid, invalid, cases };
}

// ---- metrics, verdicts, ties and losses ----

export type ViewMetric = Exclude<Metric, 'agent_crash_resumes'> | 'unfinished_jobs';
export type Direction = 'lower' | 'unranked';
/** Column labels. `job_completion_delay_s` is a finite-horizon work deficit, never a measured completion time. */
export const metricInfo: Record<ViewMetric, { label: string; unit: string; direction: Direction; note?: string }> = {
  lost_work_units: { label: 'Lost work', unit: 'work units', direction: 'lower' },
  job_completion_delay_s: { label: 'Finite-horizon work deficit', unit: 's', direction: 'lower', note: 'Lower bound truncated at the case horizon; not measured wall completion time.' },
  gpu_busy_waste_s: { label: 'GPU busy waste', unit: 's', direction: 'lower' },
  unnecessary_preemptions: { label: 'Unnecessary interventions', unit: 'count', direction: 'lower' },
  unsafe_actions_blocked: { label: 'Unsafe proposals blocked', unit: 'count', direction: 'unranked', note: 'Not ranked: a block shows the safety layer working, not a better or worse policy.' },
  unsafe_actions_executed: { label: 'Unsafe actions executed', unit: 'count', direction: 'lower' },
  successful_recoveries: { label: 'Recoveries succeeded', unit: 'count', direction: 'unranked', note: 'Not ranked: a policy that avoids the need for recovery records none.' },
  failed_recoveries: { label: 'Recoveries failed', unit: 'count', direction: 'lower' },
  unfinished_jobs: { label: 'Unfinished jobs at horizon', unit: 'jobs', direction: 'lower', note: 'From provenance.unfinished_job_ids; unknown for legacy rows (never shown as 0).' },
};
export const viewMetrics = Object.keys(metricInfo) as ViewMetric[];
export const metricLabel = (metric: ViewMetric) => `${metricInfo[metric].label}${metricInfo[metric].unit === 's' ? ' (s)' : ''}`;

/** Metric value for one row; `null` means unknown (only unfinished jobs on a legacy row can be unknown). */
export function metricValue(row: EvaluationResult, metric: ViewMetric): number | null {
  if (metric === 'unfinished_jobs') return row.provenance ? row.provenance.unfinished_job_ids.length : null;
  return row[metric];
}

export type Verdict = 'win' | 'tie' | 'loss' | 'unknown' | 'unranked';
export const verdictText: Record<Verdict, string> = { win: 'Wins', tie: 'Ties', loss: 'Loses', unknown: 'Unknown', unranked: 'Not ranked' };
const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
/** Nemotron-policy row vs a baseline on one metric (lower is better for ranked metrics). Unknown stays unknown. */
export function verdict(item: Case, metric: ViewMetric, baseline: Exclude<Policy, 'nemotron'>): Verdict {
  if (metricInfo[metric].direction === 'unranked') return 'unranked';
  const ours = metricValue(item.rows.nemotron, metric);
  const theirs = metricValue(item.rows[baseline], metric);
  if (ours === null || theirs === null) return 'unknown';
  return same(ours, theirs) ? 'tie' : ours < theirs ? 'win' : 'loss';
}
export const baselines = ['reactive', 'threshold'] as const;
export const headlineMetrics = ['lost_work_units', 'job_completion_delay_s'] as const satisfies readonly ViewMetric[];

export type Tally = Record<'win' | 'tie' | 'loss' | 'unknown', number>;
export function tally(cases: readonly Case[], metric: ViewMetric, baseline: Exclude<Policy, 'nemotron'>): Tally {
  const out: Tally = { win: 0, tie: 0, loss: 0, unknown: 0 };
  for (const item of cases) { const v = verdict(item, metric, baseline); if (v !== 'unranked') out[v]++; }
  return out;
}

/** One headline column: total lost work over the matched cases plus case-count tallies against the other side. */
export type HeadlineTally = { versus: Policy; win: number; tie: number; loss: number; unknown: number };
export type HeadlineColumn = { policy: Policy; lostWork: number; /** strictly the lowest of the three (ties flag nobody) */ lowest: boolean; tallies: HeadlineTally[] };
/**
 * Headline numbers from the matched cases only. Lost work is summed per policy; tallies are case counts on lost work.
 * The nemotron column is tallied against each baseline; a baseline column shows the same comparison from its side
 * (its wins are the nemotron column's losses), so the three columns never disagree.
 */
export function headlineColumns(cases: readonly Case[]): HeadlineColumn[] {
  const totals = Object.fromEntries(policies.map((policy) => [policy, cases.reduce((sum, item) => sum + (metricValue(item.rows[policy], 'lost_work_units') ?? 0), 0)])) as Record<Policy, number>;
  const byBaseline = Object.fromEntries(baselines.map((b) => [b, tally(cases, 'lost_work_units', b)])) as Record<Exclude<Policy, 'nemotron'>, Tally>;
  return policies.map((policy) => {
    const others = policies.filter((p) => p !== policy).map((p) => totals[p]);
    const tallies: HeadlineTally[] = policy === 'nemotron'
      ? baselines.map((b) => ({ versus: b, ...byBaseline[b] }))
      : [{ versus: 'nemotron', win: byBaseline[policy].loss, tie: byBaseline[policy].tie, loss: byBaseline[policy].win, unknown: byBaseline[policy].unknown }];
    return { policy, lostWork: totals[policy], lowest: cases.length > 0 && others.every((other) => totals[policy] < other), tallies };
  });
}

export type Outcome = { scenario_id: string; seed: number; baseline: Exclude<Policy, 'nemotron'>; metric: ViewMetric; ours: number; theirs: number };
/** Ties and losses on the headline metrics (lost work, finite-horizon work deficit), for the visible ties/losses lists. */
export function tiesAndLosses(cases: readonly Case[]): { ties: Outcome[]; losses: Outcome[] } {
  const ties: Outcome[] = [];
  const losses: Outcome[] = [];
  for (const item of cases) for (const baseline of baselines) for (const metric of headlineMetrics) {
    const v = verdict(item, metric, baseline);
    const outcome = { scenario_id: item.scenario_id, seed: item.seed, baseline, metric, ours: item.rows.nemotron[metric], theirs: item.rows[baseline][metric] };
    if (v === 'tie') ties.push(outcome); else if (v === 'loss') losses.push(outcome);
  }
  return { ties, losses };
}

// ---- comparison refusal and batch metadata ----

const distinct = <T,>(values: Iterable<T>) => [...new Set(values)];
const sorted = (values: Iterable<string>) => distinct(values).sort();

/**
 * Every reason the rows must not be compared. `provenanceConflicts` (shared with the evaluation runner) covers mixed
 * batch_id, mixed code_revision, provenance on only some rows and mixed horizon per scenario/seed. The scoreboard also
 * refuses mixed physics profiles, mixed latency models and a policy whose version/model/prompt differs across its rows.
 */
export function comparisonConflicts(rows: readonly EvaluationResult[]): string[] {
  const out = provenanceConflicts(rows);
  const withProv = rows.filter((row) => row.provenance);
  if (!withProv.length) return out;
  const physics = sorted(withProv.map((row) => row.provenance!.physics_profile_version));
  if (physics.length > 1) out.push(`mixed physics_profile_version: ${physics.join(', ')}`);
  const latency = sorted(withProv.map((row) => row.provenance!.latency_model));
  if (latency.length > 1) out.push(`mixed latency_model: ${latency.join(', ')}`);
  for (const policy of policies) {
    const own = withProv.filter((row) => row.policy === policy).map((row) => row.provenance!);
    for (const field of ['policy_version', 'model_id', 'prompt_version'] as const) {
      const values = sorted(own.map((p) => String(p[field])));
      if (values.length > 1) out.push(`mixed ${field} for ${policy}: ${values.join(', ')}`);
    }
  }
  return out;
}

export type BatchGroup = { batch_id: string | null; rows: number; cases: number; policies: Policy[]; code_revisions: string[]; horizons: number[] };
/** Rows grouped by batch_id (null = legacy rows without provenance), shown when a comparison is refused. */
export function batchBreakdown(rows: readonly EvaluationResult[]): BatchGroup[] {
  const groups = new Map<string | null, EvaluationResult[]>();
  for (const row of rows) { const id = row.provenance?.batch_id ?? null; groups.set(id, [...(groups.get(id) ?? []), row]); }
  return [...groups].map(([batch_id, own]) => ({
    batch_id, rows: own.length,
    cases: distinct(own.map((row) => `${row.scenario_id}/${row.seed}`)).length,
    policies: policies.filter((policy) => own.some((row) => row.policy === policy)),
    code_revisions: sorted(own.flatMap((row) => row.provenance ? [row.provenance.code_revision] : [])),
    horizons: distinct(own.flatMap((row) => row.provenance ? [row.provenance.horizon_sim_s] : [])).sort((a, b) => a - b),
  })).sort((a, b) => (a.batch_id ?? '').localeCompare(b.batch_id ?? ''));
}

export const shortRevision = (revision: string) => /^[0-9a-f]{13,}$/i.test(revision) ? revision.slice(0, 12) : revision;

export type BatchHeader = {
  rowsWithProvenance: number; legacyRows: number;
  batchIds: string[]; codeRevisions: string[]; physicsProfiles: string[]; latencyModels: string[];
  policyVersions: Record<Policy, string[]>; modelIds: string[]; promptVersions: string[];
  horizons: Array<{ horizon_sim_s: number; cases: number }>;
  counts: { model_requests: number; live_model_responses: number; cache_hits: number; fallback_decisions: number };
  wallTimeMs: Record<Policy, number> & { total: number };
};
/** Batch metadata from the provenance of the given rows (legacy rows only counted, never defaulted). */
export function batchHeader(rows: readonly EvaluationResult[]): BatchHeader {
  const withProv = rows.filter((row) => row.provenance);
  const prov = withProv.map((row) => row.provenance!);
  const nemotron = withProv.filter((row) => row.policy === 'nemotron').map((row) => row.provenance!);
  const sum = (pick: (p: Provenance) => number, from = prov) => from.reduce((total, p) => total + pick(p), 0);
  const horizonByCase = new Map<string, number>();
  for (const row of withProv) horizonByCase.set(`${row.scenario_id}/${row.seed}`, row.provenance!.horizon_sim_s);
  const horizonCounts = new Map<number, number>();
  for (const horizon of horizonByCase.values()) horizonCounts.set(horizon, (horizonCounts.get(horizon) ?? 0) + 1);
  const wall = Object.fromEntries(policies.map((policy) => [policy, sum((p) => p.decision_wall_time_ms, withProv.filter((row) => row.policy === policy).map((row) => row.provenance!))])) as Record<Policy, number>;
  return {
    rowsWithProvenance: withProv.length, legacyRows: rows.length - withProv.length,
    batchIds: sorted(prov.map((p) => p.batch_id)), codeRevisions: sorted(prov.map((p) => p.code_revision)),
    physicsProfiles: sorted(prov.map((p) => p.physics_profile_version)), latencyModels: sorted(prov.map((p) => p.latency_model)),
    policyVersions: Object.fromEntries(policies.map((policy) => [policy, sorted(withProv.filter((row) => row.policy === policy).map((row) => row.provenance!.policy_version))])) as Record<Policy, string[]>,
    modelIds: sorted(nemotron.map((p) => p.model_id ?? 'none')), promptVersions: sorted(nemotron.map((p) => p.prompt_version ?? 'none')),
    horizons: [...horizonCounts].map(([horizon_sim_s, cases]) => ({ horizon_sim_s, cases })).sort((a, b) => b.cases - a.cases || a.horizon_sim_s - b.horizon_sim_s),
    counts: { model_requests: sum((p) => p.model_requests), live_model_responses: sum((p) => p.live_model_responses), cache_hits: sum((p) => p.cache_hits), fallback_decisions: sum((p) => p.fallback_decisions) },
    wallTimeMs: { ...wall, total: sum((p) => p.decision_wall_time_ms) },
  };
}

/** Per-policy unfinished-job total over the compared rows, or null when any row is legacy (unknown is not zero). */
export function unfinishedTotal(cases: readonly Case[], policy: Policy): number | null {
  let total = 0;
  for (const item of cases) { const value = metricValue(item.rows[policy], 'unfinished_jobs'); if (value === null) return null; total += value; }
  return total;
}

// ---- whole view and export ----

export function buildScoreboard(results: readonly EvaluationResult[]) {
  const { valid, invalid, cases } = matchedCases(results);
  const conflicts = comparisonConflicts(valid);
  const compared = cases.flatMap((item) => policies.map((policy) => item.rows[policy]));
  return {
    valid, invalid, cases, conflicts,
    comparable: conflicts.length === 0,
    legacyOnly: valid.length > 0 && valid.every((row) => !row.provenance),
    batches: batchBreakdown(valid),
    header: batchHeader(valid),
    columns: policies.map((policy) => columnProvenance(compared, policy)),
    names: Object.fromEntries(policies.map((policy) => [policy, policyName(policy, compared)])) as Record<Policy, string>,
    shortNames: Object.fromEntries(policies.map((policy) => [policy, columnName(policy, compared)])) as Record<Policy, string>,
    headline: headlineColumns(cases),
    claim: nemotronClaim(compared),
    outcomes: tiesAndLosses(cases),
    report: summarizeResults(results),
  };
}
export type ScoreboardView = ReturnType<typeof buildScoreboard>;

/** JSON export: raw rows (provenance included), derived labels, refusal reasons and the aggregate report. */
export function exportPayload(view: ScoreboardView, mode: 'mock' | 'live', results: readonly EvaluationResult[]) {
  return {
    source: mode === 'mock' ? 'mock data source' : 'live evaluation_result rows',
    comparison_allowed: view.comparable,
    provenance_conflicts: view.conflicts,
    batches: view.batches,
    batch_header: view.header,
    nemotron_claim: view.claim,
    latency_model_note: 'Offline runs use zero simulated decision latency; decision_wall_time_ms is measured wall time spent in policy calls.',
    delay_note: 'job_completion_delay_s is a finite-horizon work deficit, not measured completion time.',
    crash_note: 'agent_crash_resumes is always 0 offline: offline runs cannot show crash recovery.',
    row_labels: view.valid.map((row) => ({ run_id: row.run_id, scenario_id: row.scenario_id, seed: row.seed, policy: row.policy, provenance_label: provenanceLabel(row).text })),
    results,
    report: view.comparable ? view.report : null,
  };
}
