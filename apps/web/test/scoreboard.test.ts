import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EvaluationResult } from '@dcos/contracts';
import examples from '@dcos/contracts/schema/example-payloads.json';
import { Scoreboard } from '../src/components/scoreboard/Scoreboard';
import {
  buildScoreboard, columnName, comparisonConflicts, exportPayload, headlineColumns, matchedCases, metricInfo, metricLabel, metricValue, nemotronClaim, nemotronName,
  provenanceKind, provenanceLabel, provenanceLine, tally, tiesAndLosses, unfinishedTotal, verdict, type Provenance,
} from '../src/components/scoreboard/scoreboard-view';
import { REAL_BATCH, REHEARSAL_BATCH } from '../src/data/rehearsal-batch';

const base = (examples as Record<string, unknown>).evaluation_result_provenance as EvaluationResult;
type Patch = Partial<Omit<EvaluationResult, 'provenance'>> & { provenance?: Partial<Provenance> | null };
function row(patch: Patch = {}): EvaluationResult {
  const { provenance, ...rest } = patch;
  const out: EvaluationResult = { ...structuredClone(base), ...rest };
  if (provenance === null) delete out.provenance; else out.provenance = { ...structuredClone(base.provenance!), ...provenance };
  return out;
}
const det = (policy: EvaluationResult['policy'], fallbacks = 0) => row({ policy, provenance: { model_enabled: false, model_id: null, model_requests: 0, live_model_responses: 0, cache_hits: 0, fallback_decisions: fallbacks } });

/** One deterministic 3-policy case, shaped like the rehearsal batch (shared run_id per case across policies). */
function detCase(scenario: string, seed: number, values: Record<EvaluationResult['policy'], Partial<EvaluationResult>>, provenance: Partial<Provenance> = {}): EvaluationResult[] {
  return (['reactive', 'threshold', 'nemotron'] as const).map((policy) => row({
    run_id: `batch-a-${scenario}-s${seed}`, scenario_id: scenario, seed, policy, ...values[policy],
    provenance: { batch_id: 'batch-a', model_enabled: false, model_id: null, model_requests: 0, live_model_responses: 0, cache_hits: 0, fallback_decisions: policy === 'nemotron' ? 2 : 0, policy_version: `${policy}@1`, prompt_version: policy === 'nemotron' ? 'p1' : null, ...provenance },
  }));
}

describe('provenance labels', () => {
  it('derives every label from provenance counters, never from policy', () => {
    const cases: Array<[Patch, string, string]> = [
      [{ provenance: { live_model_responses: 3, cache_hits: 0, model_requests: 3, fallback_decisions: 0 } }, 'model_assisted', 'Model-assisted'],
      [{ provenance: { live_model_responses: 0, cache_hits: 2, model_requests: 2, fallback_decisions: 0 } }, 'cached', 'Cached model responses'],
      [{ provenance: { live_model_responses: 2, cache_hits: 1, model_requests: 3, fallback_decisions: 0 } }, 'mixed_live_cached', 'Mixed live + cached'],
      [{ provenance: { live_model_responses: 1, cache_hits: 0, model_requests: 3, fallback_decisions: 2 } }, 'mixed_fallback', 'Mixed fallback'],
      [{ provenance: { live_model_responses: 0, cache_hits: 1, model_requests: 2, fallback_decisions: 1 } }, 'mixed_fallback', 'Mixed fallback'],
      [{ provenance: { live_model_responses: 0, cache_hits: 0, model_requests: 2, fallback_decisions: 2 } }, 'fallback_only', 'Fallback only'],
      [{ provenance: { live_model_responses: 0, cache_hits: 0, model_requests: 1, fallback_decisions: 0 } }, 'fallback_only', 'Fallback only'],
      [{ provenance: { live_model_responses: 0, cache_hits: 0, model_requests: 0, fallback_decisions: 0 } }, 'no_model_call', 'No model call needed'],
      [{ provenance: { live_model_responses: 3, cache_hits: 1, model_requests: 3 } }, 'inconsistent', 'Inconsistent provenance'],
      [{ provenance: { model_enabled: false, model_requests: 1, live_model_responses: 1, cache_hits: 0 } }, 'inconsistent', 'Inconsistent provenance'],
      [{ provenance: null }, 'unavailable', 'Provenance unavailable'],
    ];
    for (const [patch, kind, text] of cases) {
      const r = row({ policy: 'nemotron', ...patch });
      expect(provenanceKind(r), JSON.stringify(patch)).toBe(kind);
      expect(provenanceLabel(r).text).toBe(text);
    }
  });
  it('labels the example payload (2 live + 1 cached, no fallback) as mixed live + cached, not fully live', () => {
    expect(provenanceLabel(base).text).toBe('Mixed live + cached');
  });
  it('labels an sc01-like nemotron row (model_enabled false, fallback_decisions 2) as the deterministic planner', () => {
    const label = provenanceLabel(det('nemotron', 2));
    expect(label.kind).toBe('deterministic');
    expect(label.text).toBe('Deterministic planner, no model calls');
    expect(provenanceLabel(det('reactive')).text).toBe('Rule baseline');
    expect(provenanceLabel(det('threshold')).text).toBe('Rule baseline');
  });
  it('labels legacy rows of any policy as provenance unavailable', () => {
    for (const policy of ['reactive', 'threshold', 'nemotron'] as const) expect(provenanceLabel(row({ policy, provenance: null })).text).toBe('Provenance unavailable');
  });
});

describe('nemotron naming and claim banner', () => {
  it('never calls a deterministic run Nemotron and refuses the claim', () => {
    const rows = [det('nemotron', 2), det('nemotron', 0)];
    expect(nemotronName(rows)).toBe('Deterministic planner (nemotron policy, no model)');
    const claim = nemotronClaim(rows);
    expect(claim.substantiated).toBe(false);
    expect(claim.banner).toMatch(/Deterministic-only/);
    expect(claim.banner).toMatch(/cannot substantiate a Nemotron performance claim/);
  });
  it('flags mixed provenance and accepts model-assisted plus legitimate no-call cases', () => {
    const live = row({ policy: 'nemotron', provenance: { live_model_responses: 3, cache_hits: 0, model_requests: 3, fallback_decisions: 0 } });
    const noCall = row({ policy: 'nemotron', provenance: { live_model_responses: 0, cache_hits: 0, model_requests: 0, fallback_decisions: 0 } });
    const mixed = row({ policy: 'nemotron', provenance: { live_model_responses: 1, cache_hits: 0, model_requests: 2, fallback_decisions: 1 } });
    expect(nemotronClaim([live, noCall])).toEqual({ substantiated: true, banner: null });
    expect(nemotronName([live, noCall])).toBe('Nemotron planner (model-assisted)');
    expect(nemotronClaim([live, mixed]).banner).toMatch(/Not fully model-assisted: 1 model-assisted, 1 mixed fallback/);
    expect(nemotronName([live, mixed])).toBe('Nemotron policy (mixed provenance)');
    expect(nemotronClaim([noCall]).substantiated).toBe(false);
    expect(nemotronClaim([row({ policy: 'nemotron', provenance: null })]).banner).toMatch(/Provenance unavailable/);
  });
});

describe('comparison refusal', () => {
  const caseA = detCase('sc01', 101, { reactive: {}, threshold: {}, nemotron: {} });
  it('accepts one consistent batch', () => {
    expect(comparisonConflicts(caseA)).toEqual([]);
    expect(buildScoreboard(caseA).comparable).toBe(true);
  });
  it('refuses mixed batch_id, code_revision and horizon, with a per-batch breakdown', () => {
    const otherBatch = detCase('sc03', 103, { reactive: {}, threshold: {}, nemotron: {} }, { batch_id: 'batch-b' });
    const view = buildScoreboard([...caseA, ...otherBatch]);
    expect(view.comparable).toBe(false);
    expect(view.conflicts.join(' ')).toMatch(/mixed batch_id: batch-a, batch-b/);
    expect(view.batches.map((b) => [b.batch_id, b.rows, b.cases])).toEqual([['batch-a', 3, 1], ['batch-b', 3, 1]]);
    const revision = [...caseA.slice(0, 2), row({ ...caseA[2], provenance: { ...caseA[2].provenance!, code_revision: 'deadbeef' } })];
    expect(comparisonConflicts(revision).join(' ')).toMatch(/mixed code_revision/);
    const horizon = [...caseA.slice(0, 2), row({ ...caseA[2], provenance: { ...caseA[2].provenance!, horizon_sim_s: 300 } })];
    expect(comparisonConflicts(horizon).join(' ')).toMatch(/mixed horizon_sim_s for sc01\/101: 300, 600/);
  });
  it('refuses provenance on only some rows, and mixed physics/policy versions', () => {
    const partial = [...caseA.slice(0, 2), row({ ...caseA[2], provenance: null })];
    expect(comparisonConflicts(partial).join(' ')).toMatch(/lack provenance/);
    const physics = [...caseA.slice(0, 2), row({ ...caseA[2], provenance: { ...caseA[2].provenance!, physics_profile_version: 'other' } })];
    expect(comparisonConflicts(physics).join(' ')).toMatch(/mixed physics_profile_version/);
    const second = detCase('sc03', 103, { reactive: {}, threshold: {}, nemotron: {} }, { policy_version: 'v2' });
    expect(comparisonConflicts([...caseA, ...second]).join(' ')).toMatch(/mixed policy_version for reactive/);
  });
  it('renders the refusal instead of comparison tables', () => {
    const html = renderToStaticMarkup(createElement(Scoreboard, { results: [...caseA, ...detCase('sc03', 103, { reactive: {}, threshold: {}, nemotron: {} }, { batch_id: 'batch-b' })], mode: 'live' }));
    expect(html).toContain('Comparison refused');
    expect(html).toContain('mixed batch_id');
    expect(html).not.toContain('Per-scenario results');
    expect(html).not.toContain('Aggregate over matched cases');
  });
  it('shows legacy-only data, uncertified, with every row unavailable and unfinished jobs unknown', () => {
    const legacy = caseA.map((r) => row({ ...r, provenance: null }));
    const view = buildScoreboard(legacy);
    expect(view.comparable).toBe(true);
    expect(view.legacyOnly).toBe(true);
    expect(view.columns.every((c) => c.headline === 'Provenance unavailable')).toBe(true);
    expect(metricValue(legacy[0], 'unfinished_jobs')).toBeNull();
    expect(unfinishedTotal(view.cases, 'nemotron')).toBeNull();
    expect(verdict(view.cases[0], 'unfinished_jobs', 'reactive')).toBe('unknown');
    const html = renderToStaticMarkup(createElement(Scoreboard, { results: legacy, mode: 'live' }));
    expect(html).toContain('cannot be certified');
    expect(html).toContain('Provenance unavailable');
    expect(html).toContain('unknown');
  });
});

describe('metrics, ties and losses', () => {
  it('labels delay as a finite-horizon work deficit, never completion time', () => {
    expect(metricLabel('job_completion_delay_s')).toBe('Finite-horizon work deficit (s)');
    expect(Object.values(metricInfo).some((info) => /completion time/i.test(info.label))).toBe(false);
  });
  it('detects wins, ties and losses per baseline', () => {
    const rows = [
      ...detCase('sc03', 103, { reactive: { lost_work_units: 100, job_completion_delay_s: 50 }, threshold: { lost_work_units: 10, job_completion_delay_s: 40 }, nemotron: { lost_work_units: 10, job_completion_delay_s: 45 } }),
      ...detCase('sc04', 104, { reactive: { lost_work_units: 5 }, threshold: { lost_work_units: 5 }, nemotron: { lost_work_units: 5 } }),
    ];
    const { cases } = matchedCases(rows);
    expect(cases.map((c) => c.scenario_id)).toEqual(['sc03', 'sc04']);
    expect(verdict(cases[0], 'lost_work_units', 'reactive')).toBe('win');
    expect(verdict(cases[0], 'lost_work_units', 'threshold')).toBe('tie');
    expect(verdict(cases[0], 'job_completion_delay_s', 'threshold')).toBe('loss');
    expect(verdict(cases[0], 'unsafe_actions_blocked', 'threshold')).toBe('unranked');
    expect(tally(cases, 'lost_work_units', 'threshold')).toEqual({ win: 0, tie: 2, loss: 0, unknown: 0 });
    const { ties, losses } = tiesAndLosses(cases);
    expect(losses).toEqual([{ scenario_id: 'sc03', seed: 103, baseline: 'threshold', metric: 'job_completion_delay_s', ours: 45, theirs: 40 }]);
    expect(ties.filter((t) => t.metric === 'lost_work_units')).toHaveLength(3);
  });
  it('builds the headline from the matched cases: summed lost work, mirrored tallies, lowest only when strictly lowest', () => {
    const rows = [
      ...detCase('sc03', 103, { reactive: { lost_work_units: 100 }, threshold: { lost_work_units: 10 }, nemotron: { lost_work_units: 10 } }),
      ...detCase('sc04', 104, { reactive: { lost_work_units: 5 }, threshold: { lost_work_units: 7 }, nemotron: { lost_work_units: 5 } }),
    ];
    const { cases } = matchedCases(rows);
    const [reactive, threshold, nemotron] = headlineColumns(cases);
    expect([reactive!.lostWork, threshold!.lostWork, nemotron!.lostWork]).toEqual([105, 17, 15]);
    expect([reactive!.lowest, threshold!.lowest, nemotron!.lowest]).toEqual([false, false, true]);
    expect(nemotron!.tallies).toEqual([
      { versus: 'reactive', win: 1, tie: 1, loss: 0, unknown: 0 },
      { versus: 'threshold', win: 1, tie: 1, loss: 0, unknown: 0 },
    ]);
    // a baseline column shows the same comparison from its side
    expect(reactive!.tallies).toEqual([{ versus: 'nemotron', win: 0, tie: 1, loss: 1, unknown: 0 }]);
    expect(threshold!.tallies).toEqual([{ versus: 'nemotron', win: 0, tie: 1, loss: 1, unknown: 0 }]);
    // an exact tie for lowest flags nobody
    const tied = matchedCases(detCase('sc05', 105, { reactive: { lost_work_units: 3 }, threshold: { lost_work_units: 3 }, nemotron: { lost_work_units: 9 } })).cases;
    expect(headlineColumns(tied).map((c) => c.lowest)).toEqual([false, false, false]);
    expect(headlineColumns([]).map((c) => [c.lostWork, c.lowest])).toEqual([[0, false], [0, false], [0, false]]);
  });
  it('shortens only the fully deterministic nemotron column name', () => {
    expect(columnName('nemotron', [det('nemotron', 2)])).toBe('Nemotron policy · no model calls');
    expect(columnName('reactive', [det('reactive')])).toBe('Reactive rule-based');
    const live = row({ policy: 'nemotron', provenance: { live_model_responses: 3, cache_hits: 0, model_requests: 3, fallback_decisions: 0 } });
    expect(columnName('nemotron', [live])).toBe(nemotronName([live]));
    expect(columnName('nemotron', [live, det('nemotron')])).toBe('Nemotron policy (mixed provenance)');
    expect(columnName('nemotron', [])).toBe('Nemotron policy');
  });
});

describe('deterministic 12 × 3 rehearsal batch', () => {
  const rows = REHEARSAL_BATCH.rows;
  const view = buildScoreboard(rows);
  it('is comparable, fully deterministic and honestly named', () => {
    expect(rows).toHaveLength(36);
    expect(view.comparable).toBe(true);
    expect(view.cases).toHaveLength(12);
    expect(view.header.batchIds).toEqual(['rehearsal-fixed12-nollm']);
    expect(view.header.latencyModels).toEqual(['zero_simulated_decision_latency']);
    expect(view.header.counts.live_model_responses + view.header.counts.cache_hits).toBe(0);
    expect(view.columns.map((c) => c.headline)).toEqual(['Rule baseline', 'Rule baseline', 'Deterministic planner, no model calls']);
    expect(view.names.nemotron).toBe('Deterministic planner (nemotron policy, no model)');
    expect(view.claim.substantiated).toBe(false);
    expect(unfinishedTotal(view.cases, 'reactive')).not.toBeNull();
    const sc01 = view.cases.find((c) => c.scenario_id.startsWith('sc01'))!;
    expect(provenanceLabel(sc01.rows.nemotron).text).toBe('Deterministic planner, no model calls');
    expect(view.outcomes.ties.length).toBeGreaterThan(0);
  });
  it('headline numbers agree with the per-case rows and the aggregate report', () => {
    for (const column of view.headline) {
      const fromRows = view.cases.reduce((sum, item) => sum + item.rows[column.policy].lost_work_units, 0);
      expect(column.lostWork).toBeCloseTo(fromRows, 6);
      const summary = view.report.summaries.find((s) => s.policy === column.policy)!;
      expect(column.lostWork).toBeCloseTo(summary.metrics.lost_work_units!.total, 6);
    }
    const vsReactive = tally(view.cases, 'lost_work_units', 'reactive');
    expect(view.headline[2]!.tallies[0]).toEqual({ versus: 'reactive', ...vsReactive });
    expect(view.headline[0]!.tallies[0]).toMatchObject({ versus: 'nemotron', win: vsReactive.loss, loss: vsReactive.win, tie: vsReactive.tie });
    expect(view.shortNames.nemotron).toBe('Nemotron policy · no model calls');
    expect(view.headline.filter((c) => c.lowest).length).toBeLessThanOrEqual(1);
    const html = renderToStaticMarkup(createElement(Scoreboard, { results: rows, mode: 'mock' }));
    expect(html).toContain('Nemotron policy · no model calls');
    // the headline precedes the banner, which precedes the open losses list, which precedes the collapsed provenance
    const order = ['sb-headline', 'Cannot substantiate a Nemotron performance claim', 'loses or trades off', 'sb-provenance'].map((text) => html.indexOf(text));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toMatch(/<details class="report-details" open="">[^<]*<summary>Cases where/);
    expect(html).toContain('<details class="report-details sb-provenance"><summary>Batch provenance');
    // the per-row provenance pill is gone when every nemotron row carries the column header's label
    expect(html).not.toContain('Nemotron-policy row provenance');
  });
  it('renders the header, banner and tables without Nemotron claims, dollars or GPU-hours', () => {
    const html = renderToStaticMarkup(createElement(Scoreboard, { results: rows, mode: 'mock' }));
    for (const text of ['Batch provenance', 'rehearsal-fixed12-nollm', 'Zero simulated decision latency', 'Measured wall time in policy calls', 'cannot substantiate a Nemotron performance claim', 'Finite-horizon work deficit', 'offline runs cannot show crash recovery', 'Per-scenario results', 'Deterministic planner (nemotron policy, no model)']) expect(html).toContain(text);
    expect(html).not.toContain('$');
    expect(html.replace('No dollar or GPU-hour conversions.', '')).not.toMatch(/dollar|GPU-hours?/i);
    expect(html.replaceAll(/not measured (wall )?completion time/g, '')).not.toMatch(/completion time/i);
    expect(html).not.toContain('Nemotron planner');
  });
  it('exports raw provenance, labels and conflicts', () => {
    const payload = exportPayload(view, 'mock', rows);
    expect(payload.comparison_allowed).toBe(true);
    expect(payload.provenance_conflicts).toEqual([]);
    expect(payload.results[0].provenance).toBeDefined();
    expect(payload.row_labels).toHaveLength(36);
  });
});

describe('empty state', () => {
  it('offers the rehearsal loader only in mock mode', () => {
    const mock = renderToStaticMarkup(createElement(Scoreboard, { results: [], mode: 'mock', onLoadRehearsal: () => {} }));
    expect(mock).toContain('Load deterministic rehearsal batch (mock only)');
    const live = renderToStaticMarkup(createElement(Scoreboard, { results: [], mode: 'live', onLoadRehearsal: () => {} }));
    expect(live).not.toContain('Load deterministic rehearsal batch');
  });
});

describe('model-use provenance line (v2 benchmarks page)', () => {
  it('sums the rows’ own counters for the measured Nemotron batch', () => {
    const view = buildScoreboard(REAL_BATCH.rows);
    expect(view.comparable).toBe(true);
    expect(view.cases).toHaveLength(12);
    expect(provenanceLine(view)).toBe('76 live Nemotron calls + 51 cached + 3 fallbacks across 127 model requests');
    const html = renderToStaticMarkup(createElement(Scoreboard, { results: REAL_BATCH.rows, mode: 'mock' }));
    expect(html).toContain('76 live Nemotron calls + 51 cached + 3 fallbacks');
    expect(html).not.toContain('$');
    expect(html.replace('No dollar or GPU-hour conversions.', '')).not.toMatch(/dollar|GPU-hours?/i);
  });
  it('names the deterministic batch as a deterministic planner and never as Nemotron calls', () => {
    const line = provenanceLine(buildScoreboard(REHEARSAL_BATCH.rows));
    expect(line).toContain('Deterministic planner');
    expect(line).toContain('cannot substantiate a Nemotron performance claim');
    expect(line).not.toMatch(/\d+ live Nemotron/);
  });
  it('says so when provenance is missing', () => {
    const legacy = REHEARSAL_BATCH.rows.map((row) => ({ ...row, provenance: undefined })) as EvaluationResult[];
    expect(provenanceLine(buildScoreboard(legacy))).toContain('Provenance unavailable');
  });
  it('never tints the lowest headline number when the nemotron rows are deterministic-only', () => {
    const det = renderToStaticMarkup(createElement(Scoreboard, { results: REHEARSAL_BATCH.rows, mode: 'mock' }));
    expect(det).not.toContain('data-lowest');
  });
  it('offers the Nemotron batch loader only in mock mode', () => {
    const mock = renderToStaticMarkup(createElement(Scoreboard, { results: [], mode: 'mock', onLoadReal: () => {}, onLoadRehearsal: () => {} }));
    expect(mock).toContain('Load Nemotron batch (mock only)');
    expect(mock).toContain('Load deterministic rehearsal batch (mock only)');
    expect(mock).toContain('No matched evaluation runs yet');
    const live = renderToStaticMarkup(createElement(Scoreboard, { results: [], mode: 'live', onLoadReal: () => {}, onLoadRehearsal: () => {} }));
    expect(live).not.toContain('Load Nemotron batch');
  });
});
