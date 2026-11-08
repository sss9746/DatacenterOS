import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePayload, type ActionCommand, type EvaluationResult } from '@dcos/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logicalKeyConflicts, writeEvaluationResults } from '../scripts/eval-side-by-side.js';

const cmd = (command_key: string): ActionCommand => ({ command_key }) as ActionCommand;

const row = (over: Partial<EvaluationResult> = {}): EvaluationResult => ({
  schema_version: '1.1.0',
  run_id: 'eval-2026-11-08-sc03-severe-pump',
  scenario_id: 'sc03-severe-pump',
  seed: 103,
  policy: 'nemotron',
  lost_work_units: 16,
  job_completion_delay_s: 151,
  gpu_busy_waste_s: 2400,
  unnecessary_preemptions: 0,
  unsafe_actions_executed: 0,
  unsafe_actions_blocked: 0,
  successful_recoveries: 1,
  failed_recoveries: 0,
  agent_crash_resumes: 0,
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eval-out-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('eval-side-by-side helpers', () => {
  it('logicalKeyConflicts: the same (operation, job, attempt) under two workflow ids is a conflict; retries and new attempts are not', () => {
    expect(
      logicalKeyConflicts([
        cmd('wf-a:checkpoint:job-a:1'),
        cmd('wf-a:checkpoint:job-a:1'), // retry of the same key
        cmd('wf-a:checkpoint:job-a:2'), // new attempt
        cmd('wf-b:power_cap:job-b:1'),
      ]),
    ).toEqual([]);
    expect(logicalKeyConflicts([cmd('wf-policy-r-t2:migrate_restart:job-a:1'), cmd('wf-policy-r-t3:migrate_restart:job-a:1')])).toEqual([
      ['migrate_restart:job-a:1', ['wf-policy-r-t2:migrate_restart:job-a:1', 'wf-policy-r-t3:migrate_restart:job-a:1']],
    ]);
  });

  it('writeEvaluationResults writes schema-valid rows under `results` and refuses invalid ones', () => {
    const file = join(dir, 'nested', 'deterministic-2026-11-08.json');
    writeEvaluationResults(file, { label: 'test', results: [row(), row({ policy: 'threshold' })] });
    const back = JSON.parse(readFileSync(file, 'utf8')) as { label: string; results: unknown[] };
    expect(back.label).toBe('test');
    expect(back.results).toHaveLength(2);
    for (const r of back.results) expect(validatePayload('EvaluationResult', r).ok).toBe(true);

    const bad = { ...row(), extra: 1 } as unknown as EvaluationResult;
    expect(() => writeEvaluationResults(join(dir, 'bad.json'), { results: [bad] })).toThrow(/schema-invalid/);
  });
});
