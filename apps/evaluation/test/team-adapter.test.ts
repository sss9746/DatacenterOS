import { createHash } from 'node:crypto';
import { MOCK_FIXTURES } from '@dcos/db-client';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validatePayload, type EvaluationResult } from '@dcos/contracts';
import type { Scenario } from '../../../packages/physics/src/gpu/index.js';
import { assertConsistentProvenance, provenanceConflicts } from '../src/report.js';
import { runMatrix } from '../src/runner.js';
import { createTeamAdapter, modeLabel, selectCases, FIXED_12_PREFIXES, type DetailedRunner, type NemotronHandle } from '../src/team-adapter.js';

const scenario = (i: number): Scenario => ({ scenario_id: `sc${String(i).padStart(2, '0')}-fake`, seed: i, horizon_s: 600 + i, preset_id: 'x', faults: [] } as unknown as Scenario);
const scenarios = Array.from({ length: 10 }, (_, i) => scenario(i + 1));
const result = (s: Scenario, policy: EvaluationResult['policy'], run_id: string): EvaluationResult => ({
  schema_version: '1.1.0', run_id, scenario_id: s.scenario_id, seed: s.seed, policy, lost_work_units: 1, job_completion_delay_s: 2,
  gpu_busy_waste_s: 3, unnecessary_preemptions: 0, unsafe_actions_executed: 0, unsafe_actions_blocked: 0, successful_recoveries: 0, failed_recoveries: 0, agent_crash_resumes: 0,
});
const fakeRunner = (details: Partial<Record<string, unknown>> = {}): DetailedRunner => async (s, policy, opts) => {
  // exercise the policy so wall time and nemotron instance usage are real
  if (opts.policy_name === 'nemotron') await policy(structuredClone(MOCK_FIXTURES.demo), { sim_time_ms: 0 });
  return {
    result: result(s, opts.policy_name, opts.run_id), gate: 'safety', ticks: 3, start_sim_time_ms: 0, end_sim_time_ms: 3000,
    commands: [], duplicate_commands_ignored: 0, retry_dropped: 0,
    unfinished_job_ids: ['job-b', 'job-a'], failed_job_ids: ['job-b'], completed_job_ids: [], reference_at_risk_job_ids: [], ...details,
  } as never;
};
const fakeNemotron = (): NemotronHandle => {
  let resets = 0;
  const policy = Object.assign(async () => [], {
    stats: () => ({ calls: 1, cacheHits: 1, llmFailures: 2, llmRequests: 3, unchangedSkips: 0, deferredRechecks: 0, replans: 1 }),
    usage: () => ({ model_requests: 3, live_model_responses: 2, cache_hits: 1, fallback_decisions: 2, decision_wall_time_ms: 12.5 + resets }),
    reset: () => { resets += 1; },
  });
  return { policy: policy as never, model_id: 'fake-model', model_enabled: true };
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'team-adapter-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const build = (runDetailed = fakeRunner(), noLlm = false) =>
  createTeamAdapter({ batchId: 'batch-t', codeRevision: 'abcdef1234567890', outDir: dir, noLlm, scenarios, caseIds: scenarios.map((s) => s.scenario_id), runDetailed, createNemotron: fakeNemotron });

describe('team adapter', () => {
  it('runs a matched matrix with one shared run_id per case and validated provenance rows', async () => {
    const adapter = build();
    const out = await runMatrix(adapter);
    expect(out.results).toHaveLength(30);
    for (const row of out.results) {
      expect(validatePayload('EvaluationResult', row).ok).toBe(true);
      expect(row.provenance?.batch_id).toBe('batch-t');
      expect(row.run_id).toBe(`batch-t-${row.scenario_id}-s${row.seed}`);
      expect(row.provenance?.latency_model).toBe('zero_simulated_decision_latency');
    }
    expect(out.report.matchedCount).toBe(10);
  });

  it('takes unfinished and failed job ids from runScenarioDetailed details, never zero-filled', async () => {
    const out = await runMatrix(build());
    expect(out.results[0]!.provenance?.unfinished_job_ids).toEqual(['job-b', 'job-a']);
    expect(out.results[0]!.provenance?.failed_job_ids).toEqual(['job-b']);
    expect(out.unfinished_jobs).toHaveLength(30);
    await expect(runMatrix(build(fakeRunner({ unfinished_job_ids: undefined })))).rejects.toThrow('zero-fill');
  });

  it('captures nemotron counters before disposal; rule policies carry model_enabled false and model_id null', async () => {
    const out = await runMatrix(build());
    const nemo = out.results.find((r) => r.policy === 'nemotron')!.provenance!;
    expect(nemo).toMatchObject({ model_enabled: true, model_id: 'fake-model', model_requests: 3, live_model_responses: 2, cache_hits: 1, fallback_decisions: 2, decision_wall_time_ms: 12.5 });
    expect(modeLabel(nemo)).toBe('mixed-fallback');
    for (const name of ['reactive', 'threshold'] as const) {
      const p = out.results.find((r) => r.policy === name)!.provenance!;
      expect(p).toMatchObject({ model_enabled: false, model_id: null, prompt_version: null, model_requests: 0, fallback_decisions: 0 });
      expect(p.decision_wall_time_ms).toBeGreaterThanOrEqual(0);
    }
    expect(out.policy_stats).toEqual({ cacheHits: 10, llmFailures: 20, llmRequests: 30 });
  });

  it('hashes the saved canonical trace file and writes a manifest', async () => {
    const adapter = build();
    const out = await runMatrix(adapter);
    const row = out.results[0]!;
    const file = join(dir, 'traces', `${row.scenario_id}-s${row.seed}-${row.policy}.trace.json`);
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(row.provenance!.trace_sha256);
    const manifest = adapter.manifest() as { batch_id: string; code_revision: string; case_ids: string[]; horizons_sim_s: Record<string, number> };
    expect(manifest.batch_id).toBe('batch-t');
    expect(manifest.code_revision).toBe('abcdef1234567890');
    expect(manifest.case_ids).toHaveLength(10);
    expect(manifest.horizons_sim_s[scenarios[0]!.scenario_id]).toBe(601);
  });

  it('refuses to mix batch, revision or horizon', async () => {
    const out = await runMatrix(build());
    const rows = structuredClone(out.results);
    expect(provenanceConflicts(rows)).toEqual([]);
    rows[1]!.provenance!.batch_id = 'other';
    rows[2]!.provenance!.code_revision = 'ffff';
    rows[3]!.provenance!.horizon_sim_s += 1;
    expect(provenanceConflicts(rows)).toHaveLength(3);
    expect(() => assertConsistentProvenance(rows)).toThrow('mismatched');
  });

  it('selects the fixed 12 by prefix and fails loudly on a missing case', () => {
    const all = Array.from({ length: 20 }, (_, i) => scenario(i + 1));
    expect(selectCases(all, 'fixed12').map((s) => s.scenario_id.slice(0, 4))).toEqual([...FIXED_12_PREFIXES]);
    expect(() => selectCases(all.slice(0, 5), 'fixed12')).toThrow('sc07');
  });
});
