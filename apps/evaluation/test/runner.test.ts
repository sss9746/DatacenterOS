import { describe, expect, it } from 'vitest';
import { MOCK_FIXTURES } from '@dcos/db-client';
import { observablePolicy, runMatrix, type EvaluationAdapter } from '../src/runner.js';
describe('evaluation orchestration boundaries', () => {
  it('never hands private world fields to a policy, and isolates policy mutations', async () => {
    const source = structuredClone(MOCK_FIXTURES.demo);
    const input = Object.assign(source, { active_faults_private: [{ secret: true }], due_faults_private: ['future'], hidden_physics_state_json: { secret: true } });
    await observablePolicy((obs) => { expect('active_faults_private' in obs).toBe(false); expect('due_faults_private' in obs).toBe(false); expect('hidden_physics_state_json' in obs).toBe(false); obs.gpus[0].temp_c = 999; return []; })(input, { sim_time_ms: 0 });
    expect(input.gpus[0].temp_c).not.toBe(999);
  });
  const adapter = (): EvaluationAdapter => ({
    loadScenarios: () => Array.from({ length: 10 }, (_, i) => ({ scenario_id: `test-${i}`, seed: i })),
    policies: { reactive: () => [], threshold: () => [], nemotron: () => [] },
    provenance: { physics_profile_version: 'test-only', policy_versions: { reactive: 'test', threshold: 'test', nemotron: 'test' } },
    runScenario: (scenario, _policy, policy) => ({ schema_version: '1.1.0', run_id: 'test-run', ...scenario, policy, lost_work_units: 0, job_completion_delay_s: 0, gpu_busy_waste_s: 0, unnecessary_preemptions: 0, unsafe_actions_executed: 0, unsafe_actions_blocked: 0, successful_recoveries: 0, failed_recoveries: 0, agent_crash_resumes: 0 }),
  });
  it('runs the complete matrix without mutating scenario inputs', async () => { const a = adapter(); const scenarios = a.loadScenarios(); a.loadScenarios = () => scenarios; const result = await runMatrix(a); expect(result.results).toHaveLength(30); expect(result.report.matchedCount).toBe(10); expect(result.policy_stats).toBeNull(); expect(result.unfinished_jobs).toBeNull(); });
  it('rejects duplicate scenarios and mismatched runner identities', async () => { const a = adapter(); a.loadScenarios = () => Array.from({ length: 10 }, () => ({ scenario_id: 'same', seed: 1 })); await expect(runMatrix(a)).rejects.toThrow('unique'); const b = adapter(); const run = b.runScenario; b.runScenario = async (...args) => ({ ...await run(...args) as object, seed: 999 }); await expect(runMatrix(b)).rejects.toThrow('identity mismatch'); });
});
