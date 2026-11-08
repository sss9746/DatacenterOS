import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRedactor } from '../../scripts/live/redact.js';
import { renderMarkdown, writeArtifacts, type CaseArtifact, type RunArtifact } from '../../scripts/live/report.js';

const TOKEN = 'eyJhbGciOiJFUzI1NiJ9.eyJoZXhfaWRlbnRpdHkiOiJhYmMifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ';

function sample(): RunArtifact {
  const c: CaseArtifact = {
    case: 'L1',
    title: 'SIGKILL during checkpoint',
    evidence_label: 'live DB + real agent process',
    passed: false,
    failure_reasons: ['checkpoint completed exactly once: complete_for_key=2'],
    started_unix_ms: 1_700_000_000_000,
    ended_unix_ms: 1_700_000_090_000,
    sim_start_ms: 601_000,
    sim_end_ms: 780_000,
    command_keys: { checkpoint: 'wf-inc-1:checkpoint:job-a:1', final_migrate: null },
    checks: [
      { name: 'DB sim clock advances without the agent', ok: true, detail: '612000 -> 615000' },
      { name: 'checkpoint completed exactly once', ok: false, detail: 'complete_for_key=2', evidence: { token_before: 5n as unknown as number } },
    ],
    allocation_uniqueness: { ok: true, doubled: {} },
    checkpoint_count: { job_id: 'job-a', complete_before: 1, complete_after: 2 },
    verification: { handoff: 'workload recovered' },
    agent_generations: [{ generation: 1, pid: 123, started_unix_ms: 1, ended_unix_ms: 2, how_ended: 'SIGKILL', exit_code: null, stderr_tail: [`[err] connect failed with token ${TOKEN}`] }],
    timeline: [{ wall_unix_ms: 1_700_000_000_500, sim_time_ms: 601_000, event: 'agent generation 1 spawned', detail: { pid: 123 } }],
    last_snapshot_summary: { note: `uses ${TOKEN}` },
    ledger: [],
    error: null,
  };
  return {
    meta: { harness: 'live-recovery-test', commit: 'abc1234', branch: 'r/r5', db: 'dcos-dev', run_id: 'run-demo-1', seed: 42, speed: 2, preset_id: 'gpu_demo_8', model: 'nvidia/nemotron', llm_mode: 'live_nim', reset_performed: true, started_unix_ms: 1_700_000_000_000, node: 'v22', platform: 'win32 host' },
    cases: [c],
    passed: false,
  };
}

describe('live harness report', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('renders markdown with the required fields', () => {
    const md = renderMarkdown(sample());
    expect(md).toContain('**Result:** FAIL (0/1 cases)');
    expect(md).toContain('`abc1234`');
    expect(md).toContain('`dcos-dev` run `run-demo-1` preset `gpu_demo_8` seed 42 speed 2');
    expect(md).toContain('nvidia/nemotron (live_nim)');
    expect(md).toContain('| L1 SIGKILL during checkpoint | FAIL |');
    expect(md).toContain('601s → 780s');
    expect(md).toContain('checkpoint=`wf-inc-1:checkpoint:job-a:1`');
    expect(md).toContain('complete 1 → 2');
    expect(md).toContain('FAIL  checkpoint completed exactly once');
    expect(md).toContain('gen1 pid 123 (SIGKILL)');
  });

  it('labels a deterministic rehearsal as not a Nemotron claim', () => {
    const r = sample();
    r.meta = { ...r.meta, llm_mode: 'deterministic_no_llm', model: 'deterministic (no LLM)' };
    expect(renderMarkdown(r)).toContain('NOT a Nemotron claim');
  });

  it('writes run.json, per-case json and report.md with every secret redacted and bigints stringified', () => {
    dir = mkdtempSync(join(tmpdir(), 'lr-report-'));
    const paths = writeArtifacts(dir, sample(), createRedactor([TOKEN]));
    const run = readFileSync(paths.runJson, 'utf8');
    const l1 = readFileSync(paths.caseJson[0]!, 'utf8');
    const md = readFileSync(paths.markdown, 'utf8');
    for (const text of [run, l1, md]) expect(text).not.toContain(TOKEN);
    expect(run).toContain('***');
    expect(JSON.parse(l1)).toMatchObject({ case: 'L1', meta: { db: 'dcos-dev' } });
    expect(JSON.parse(run).cases[0].checks[1].evidence.token_before).toBe('5');
    expect(paths.caseJson[0]!.endsWith('L1.json')).toBe(true);
  });
});
