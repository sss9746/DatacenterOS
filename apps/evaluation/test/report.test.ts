import { describe, expect, it } from 'vitest';
import type { EvaluationResult } from '@dcos/contracts';
import { distribution, policies, summarizeResults } from '../src/report.js';
const row = (policy: EvaluationResult['policy'], patch: Partial<EvaluationResult> = {}): EvaluationResult => ({ schema_version: '1.1.0', run_id: 'eval-test', scenario_id: 'synthetic-test-only', seed: 42, policy, lost_work_units: 10, job_completion_delay_s: 20, gpu_busy_waste_s: 30, unnecessary_preemptions: 1, unsafe_actions_executed: 0, unsafe_actions_blocked: 1, successful_recoveries: 1, failed_recoveries: 0, agent_crash_resumes: 0, ...patch });
describe('honest, comparable evaluation reporting', () => {
  it('keeps empty results empty, rather than implying zero losses', () => { expect(summarizeResults([]).summaries[0].metrics.lost_work_units).toBeNull(); });
  it('does not compare different seeds or run IDs', () => { expect(summarizeResults([row('reactive'), row('threshold'), row('nemotron', { seed: 43 })]).matchedCount).toBe(0); expect(summarizeResults([row('reactive'), row('threshold'), row('nemotron', { run_id: 'other' })]).matchedCount).toBe(0); });
  it('includes cases where Nemotron loses despite winning another metric', () => { const report = summarizeResults([row('reactive'), row('threshold'), row('nemotron', { lost_work_units: 0, unnecessary_preemptions: 3 })]); expect(report.matchedCount).toBe(1); expect(report.losses).toHaveLength(2); expect(report.losses[0].worse).toContain('unnecessary_preemptions'); });
  it('ignores identical duplicates and excludes conflicting results', () => { const rows = policies.map((policy) => row(policy)); expect(summarizeResults([...rows, row('nemotron')]).matchedCount).toBe(1); const conflict = summarizeResults([...rows, row('nemotron', { lost_work_units: 90 })]); expect(conflict.matchedCount).toBe(0); expect(conflict.conflictingCount).toBe(1); });
  it('rejects missing, negative and non-finite metrics', () => { expect(summarizeResults([{}, row('reactive', { lost_work_units: -1 }), row('reactive', { job_completion_delay_s: Infinity })]).invalidCount).toBe(3); });
  it('reports distributions and a legitimate zero', () => { expect(distribution([1, 2, 3, 8])).toEqual({ total: 14, mean: 3.5, median: 2.5, p95: 8, min: 1, max: 8 }); expect(distribution([0])?.mean).toBe(0); });
});
