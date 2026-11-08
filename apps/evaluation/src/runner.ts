import { type ActionCommand, type ObservedSnapshot, type EvaluationResult } from '@dcos/contracts';
import { assertConsistentProvenance, policies, requireResult, summarizeResults } from './report.js';

// P4 orchestration boundary, not a replacement physics model. The adapter binds
// P1's trusted runScenario and P3's observable-only policy after their exports land.
export type Policy = (obs: ObservedSnapshot, context: { sim_time_ms: number }) => ActionCommand[] | Promise<ActionCommand[]>;
export type ScenarioIdentity = Pick<EvaluationResult, 'scenario_id' | 'seed'>;
export interface EvaluationAdapter {
  loadScenarios(): ScenarioIdentity[] | Promise<ScenarioIdentity[]>;
  runScenario(scenario: ScenarioIdentity, policy: Policy, name: EvaluationResult['policy']): unknown | Promise<unknown>;
  policies: Record<EvaluationResult['policy'], Policy>;
  provenance: { physics_profile_version: string; policy_versions: Record<EvaluationResult['policy'], string> };
  getPolicyStats?(): { cacheHits: number; llmFailures: number; llmRequests: number };
}
export function observablePolicy(policy: Policy): Policy {
  return (input, context) => {
    // Allowlist the wire projection. Even an accidentally over-wide adapter payload
    // must not expose PhysicsWorld or a future fault schedule to the planner.
    const obs: ObservedSnapshot = {
      schema_version: input.schema_version, run_id: input.run_id, clock: structuredClone(input.clock),
      resources: structuredClone(input.resources), dependencies: structuredClone(input.dependencies),
      gpus: structuredClone(input.gpus), nodes: structuredClone(input.nodes), cooling: structuredClone(input.cooling),
      job_specs: structuredClone(input.job_specs), job_states: structuredClone(input.job_states),
      allocations: structuredClone(input.allocations), checkpoints: structuredClone(input.checkpoints),
      observation_event_ids: [...input.observation_event_ids],
    };
    return policy(obs, { sim_time_ms: context.sim_time_ms });
  };
}
export async function runMatrix(adapter: EvaluationAdapter, onResult: (result: EvaluationResult) => Promise<void> = async () => {}) {
  if (!adapter.provenance?.physics_profile_version || policies.some((name) => !adapter.provenance.policy_versions[name] || typeof adapter.policies[name] !== 'function')) throw new Error('All three policy functions and explicit physics/policy versions are required.');
  const scenarios = await adapter.loadScenarios();
  const keys = scenarios.map((scenario) => JSON.stringify([scenario.scenario_id, scenario.seed]));
  if (scenarios.length < 10 || new Set(keys).size !== scenarios.length) throw new Error('Gate 4 requires at least 10 unique scenario/seed cases. Duplicate cases are not a benchmark.');
  const results: EvaluationResult[] = [];
  for (const scenario of scenarios) {
    if (!scenario.scenario_id || !Number.isInteger(scenario.seed)) throw new Error('Each scenario must have an ID and integer seed.');
    for (const name of policies) {
      // A fresh copy for each policy prevents one runner changing the next case.
      const row = requireResult(await adapter.runScenario(structuredClone(scenario), observablePolicy(adapter.policies[name]), name));
      if (row.scenario_id !== scenario.scenario_id || row.seed !== scenario.seed || row.policy !== name) throw new Error(`Runner identity mismatch for ${scenario.scenario_id}/${name}.`);
      const peer = results.find((r) => r.scenario_id === row.scenario_id && r.seed === row.seed);
      if (peer && peer.run_id !== row.run_id) throw new Error('All policy results in a comparison must use the same run_id.');
      results.push(row);
      assertConsistentProvenance(results);
      await onResult(row);
    }
  }
  // Unfinished jobs come only from per-row provenance (runScenarioDetailed details); unknown stays null, never zero.
  const unfinished = results.every((r) => r.provenance)
    ? results.map((r) => ({ scenario_id: r.scenario_id, seed: r.seed, policy: r.policy, unfinished_job_ids: r.provenance!.unfinished_job_ids, failed_job_ids: r.provenance!.failed_job_ids }))
    : null;
  return { results, report: summarizeResults(results), provenance: adapter.provenance, policy_stats: adapter.getPolicyStats?.() ?? null, unfinished_jobs: unfinished };
}
