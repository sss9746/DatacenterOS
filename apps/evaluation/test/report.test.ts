import { describe, expect, it } from 'vitest';
import type { EvaluationResult } from '@dcos/contracts';
import { distribution, LEGACY_MODE, modeLabel, policies, rowMode, summarizeResults, type Provenance } from '../src/report.js';
const row = (policy: EvaluationResult['policy'], patch: Partial<EvaluationResult> = {}): EvaluationResult => ({ schema_version: '1.1.0', run_id: 'eval-test', scenario_id: 'synthetic-test-only', seed: 42, policy, lost_work_units: 10, job_completion_delay_s: 20, gpu_busy_waste_s: 30, unnecessary_preemptions: 1, unsafe_actions_executed: 0, unsafe_actions_blocked: 1, successful_recoveries: 1, failed_recoveries: 0, agent_crash_resumes: 0, ...patch });
describe('honest, comparable evaluation reporting', () => {
  it('keeps empty results empty, rather than implying zero losses', () => { expect(summarizeResults([]).summaries[0].metrics.lost_work_units).toBeNull(); });
  it('does not compare different seeds or run IDs', () => { expect(summarizeResults([row('reactive'), row('threshold'), row('nemotron', { seed: 43 })]).matchedCount).toBe(0); expect(summarizeResults([row('reactive'), row('threshold'), row('nemotron', { run_id: 'other' })]).matchedCount).toBe(0); });
  it('includes cases where Nemotron loses despite winning another metric', () => { const report = summarizeResults([row('reactive'), row('threshold'), row('nemotron', { lost_work_units: 0, unnecessary_preemptions: 3 })]); expect(report.matchedCount).toBe(1); expect(report.losses).toHaveLength(2); expect(report.losses[0].worse).toContain('unnecessary_preemptions'); });
  it('ignores identical duplicates and excludes conflicting results', () => { const rows = policies.map((policy) => row(policy)); expect(summarizeResults([...rows, row('nemotron')]).matchedCount).toBe(1); const conflict = summarizeResults([...rows, row('nemotron', { lost_work_units: 90 })]); expect(conflict.matchedCount).toBe(0); expect(conflict.conflictingCount).toBe(1); });
  it('rejects missing, negative and non-finite metrics', () => { expect(summarizeResults([{}, row('reactive', { lost_work_units: -1 }), row('reactive', { job_completion_delay_s: Infinity })]).invalidCount).toBe(3); });
  it('reports distributions and a legitimate zero', () => { expect(distribution([1, 2, 3, 8])).toEqual({ total: 14, mean: 3.5, median: 2.5, p95: 8, min: 1, max: 8 }); expect(distribution([0])?.mean).toBe(0); });
});

const provenance = (patch: Partial<Provenance> = {}): Provenance => ({
  batch_id: 'batch-a', code_revision: 'abc1234', physics_profile_version: '1.1.0', policy_version: 'rules-1', model_id: null, prompt_version: null,
  model_enabled: false, model_requests: 0, live_model_responses: 0, cache_hits: 0, fallback_decisions: 0, decision_wall_time_ms: 1.5, horizon_sim_s: 600,
  latency_model: 'zero_simulated_decision_latency', unfinished_job_ids: ['job-b'], failed_job_ids: [], trace_sha256: 'a'.repeat(64), ...patch,
});
const withProv = (policy: EvaluationResult['policy'], p: Partial<Provenance> = {}, patch: Partial<EvaluationResult> = {}) => row(policy, { provenance: provenance(p), ...patch });

describe('provenance on the scoreboard (CONTRACTS §0.14)', () => {
  it('labels modes from provenance, never from the policy name', () => {
    expect(modeLabel(provenance())).toBe('rules');
    expect(modeLabel(provenance({ fallback_decisions: 2 }))).toBe('deterministic-only');
    expect(modeLabel(provenance({ model_enabled: true, model_requests: 3, live_model_responses: 2, cache_hits: 1 }))).toBe('model-assisted (live+cached)');
    expect(modeLabel(provenance({ model_enabled: true, model_requests: 2, live_model_responses: 1, fallback_decisions: 1 }))).toBe('mixed-fallback');
    expect(rowMode(row('nemotron'))).toBe(LEGACY_MODE);
  });
  it('counts modes and unfinished jobs per policy; a deterministic Nemotron batch is visibly not model-assisted', () => {
    const report = summarizeResults([withProv('reactive'), withProv('threshold'), withProv('nemotron', { policy_version: 'nemotron-1', fallback_decisions: 1, unfinished_job_ids: ['job-a', 'job-b'] })]);
    expect(report.matchedCount).toBe(1);
    expect(report.modes.nemotron).toEqual({ 'deterministic-only': 1 });
    expect(report.modes.reactive).toEqual({ rules: 1 });
    expect(report.unfinishedJobs).toEqual({ reactive: 1, threshold: 1, nemotron: 2 });
  });
  it('keeps legacy rows comparable but reports unfinished jobs as unknown, not zero', () => {
    const report = summarizeResults(policies.map((policy) => row(policy)));
    expect(report.matchedCount).toBe(1);
    expect(report.modes.nemotron).toEqual({ [LEGACY_MODE]: 1 });
    expect(report.unfinishedJobs.nemotron).toBeNull();
  });
  it('refuses to compare mixed batches, revisions, horizons or a legacy/provenance mix after partial publication', () => {
    const mixedBatch = summarizeResults([withProv('reactive'), withProv('threshold'), withProv('nemotron', { batch_id: 'batch-b' })]);
    expect(mixedBatch.matchedCount).toBe(0); expect(mixedBatch.provenanceRefusedCount).toBe(1); expect(mixedBatch.provenanceProblems.join()).toContain('mixed batch_id');
    expect(summarizeResults([withProv('reactive'), withProv('threshold'), withProv('nemotron', { code_revision: 'other' })]).provenanceProblems.join()).toContain('mixed code_revision');
    expect(summarizeResults([withProv('reactive'), withProv('threshold'), withProv('nemotron', { horizon_sim_s: 900 })]).provenanceProblems.join()).toContain('mixed horizon_sim_s');
    const legacyMix = summarizeResults([withProv('reactive'), withProv('threshold'), row('nemotron')]);
    expect(legacyMix.matchedCount).toBe(0); expect(legacyMix.provenanceProblems.join()).toContain('lack provenance');
  });
});
