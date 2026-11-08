import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePayload } from '@dcos/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNemotronPolicy, policyWorkflowId } from '../src/policy.js';
import type { LlmChatRequest, LlmChatResponse, LlmPort } from '../src/ports.js';
import { CHOOSE_OPTIONS_TOOL_NAME } from '../src/prompts/planner.js';
import { SNAPSHOT_DB_READ_ONLY_MESSAGE, createSnapshotDb } from '../src/snapshot-db.js';
import { FakeLlm, FakePhysics } from './fakes/index.js';
import { loadDemoSnapshot, loadPumpDegradedSnapshot } from './fixtures/index.js';

/** Counting Nemotron stand-in: picks rank 1 for the planner call; triage replies are unusable (deterministic grouping). */
class CountingLlm implements LlmPort {
  calls = 0;
  async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
    this.calls += 1;
    if (req.tools?.[0]?.name !== CHOOSE_OPTIONS_TOOL_NAME) return FakeLlm.text('no assessment');
    const user = req.messages.find((m) => m.role === 'user');
    const text = user && 'content' in user ? String(user.content) : '';
    const input = JSON.parse(text.slice(text.indexOf('PLANNING_INPUT=') + 'PLANNING_INPUT='.length)) as {
      jobs: { job_id: string; options: { option_id: string }[] }[];
    };
    return FakeLlm.toolCall(CHOOSE_OPTIONS_TOOL_NAME, {
      choices: input.jobs.map((j) => ({ job_id: j.job_id, option_id: j.options[0]!.option_id, needs_approval: false, explanation: 'test pick' })),
    });
  }
}

class DownLlm implements LlmPort {
  async chat(): Promise<LlmChatResponse> {
    throw new Error('down');
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'policy-cache-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (obs: { clock: { sim_time_ms: number } }) => ({ sim_time_ms: obs.clock.sim_time_ms });

describe('nemotron policy', () => {
  it('pump_degraded: checkpoint + migrate_restart for job-a, power_cap or nothing for job-b', async () => {
    const obs = loadPumpDegradedSnapshot();
    const policy = createNemotronPolicy({ llm: new CountingLlm(), physics: new FakePhysics(), cacheDir: dir });
    const cmds = await policy(obs, ctx(obs));
    const ops = (job: string) => cmds.filter((c) => c.job_id === job).map((c) => c.operation);
    expect(ops('job-a')).toEqual(['checkpoint', 'migrate_restart']);
    for (const op of ops('job-b')) expect(['power_cap', 'keep_running']).toContain(op);
    expect(ops('job-b')).not.toContain('migrate_restart');
    for (const c of cmds) expect(validatePayload('ActionCommand', c).ok).toBe(true);
  });

  it('healthy demo snapshot yields no commands', async () => {
    const obs = loadDemoSnapshot();
    const policy = createNemotronPolicy({ llm: new CountingLlm(), physics: new FakePhysics(), cacheDir: dir });
    expect(await policy(obs, ctx(obs))).toEqual([]);
  });

  it('second identical call is a cache hit and makes no live LLM call', async () => {
    const obs = loadPumpDegradedSnapshot();
    const llm = new CountingLlm();
    const policy = createNemotronPolicy({ llm, physics: new FakePhysics(), cacheDir: dir });
    const first = await policy(obs, ctx(obs));
    const callsAfterFirst = llm.calls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(policy.stats().cacheHits).toBe(0);
    expect(readdirSync(dir).length).toBe(callsAfterFirst);
    const second = await policy(obs, ctx(obs));
    expect(llm.calls).toBe(callsAfterFirst);
    expect(policy.stats().cacheHits).toBe(callsAfterFirst);
    expect(policy.stats().calls).toBe(2);
    expect(second).toEqual(first);
  });

  it('does not cache failed LLM responses', async () => {
    const obs = loadPumpDegradedSnapshot();
    const policy = createNemotronPolicy({ llm: new DownLlm(), physics: new FakePhysics(), cacheDir: dir });
    const cmds = await policy(obs, ctx(obs));
    expect(cmds.length).toBeGreaterThan(0);
    expect(readdirSync(dir)).toEqual([]);
    expect(policy.stats().llmFailures).toBe(1);
  });

  it('llm=null falls back to the deterministic path with valid commands', async () => {
    const obs = loadPumpDegradedSnapshot();
    const policy = createNemotronPolicy({ llm: null, physics: new FakePhysics(), cacheDir: dir });
    const cmds = await policy(obs, ctx(obs));
    expect(cmds.filter((c) => c.job_id === 'job-a').map((c) => c.operation)).toEqual(['checkpoint', 'migrate_restart']);
    for (const c of cmds) expect(validatePayload('ActionCommand', c).ok).toBe(true);
    expect(policy.stats()).toMatchObject({ calls: 1, cacheHits: 0, llmFailures: 1 });
  });

  it('derives the workflow id from run id and sim-time bucket', () => {
    expect(policyWorkflowId('run-1', 430_000)).toBe(policyWorkflowId('run-1', 431_000));
    expect(policyWorkflowId('run-1', 430_000)).not.toBe(policyWorkflowId('run-1', 700_000));
  });
});

describe('snapshot-db', () => {
  it('rejects every execution and workflow method', async () => {
    const db = createSnapshotDb(loadPumpDegradedSnapshot()) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const methods = ['requestAction', 'claimAction', 'startAction', 'cancelAction', 'verifyAction', 'claimWorkflow', 'heartbeatWorkflow', 'updateWorkflow'];
    for (const m of methods) {
      await expect(db[m]!(), m).rejects.toThrow(SNAPSHOT_DB_READ_ONLY_MESSAGE);
    }
  });

  it('stores symptoms in memory and serves them as evidence', async () => {
    const obs = loadPumpDegradedSnapshot();
    const db = createSnapshotDb(obs);
    expect((await db.getObservedSnapshot()).run_id).toBe(obs.run_id);
    const t = obs.clock.sim_time_ms;
    await db.upsertSymptoms([
      { symptom_id: 's1', run_id: obs.run_id, resource_id: 'pump-a', first_seen_sim_ms: t, last_seen_sim_ms: t, kind: 'k', severity: 'warning', evidence_event_ids: [], status: 'open' },
    ]);
    expect((await db.getEvidence([], 600_000)).symptoms).toHaveLength(1);
    expect(db.onChange(() => {})()).toBeUndefined();
  });
});
