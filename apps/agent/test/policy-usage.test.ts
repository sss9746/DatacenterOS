import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNemotronPolicy } from '../src/policy.js';
import type { LlmChatRequest, LlmChatResponse, LlmPort } from '../src/ports.js';
import { CHOOSE_OPTIONS_TOOL_NAME } from '../src/prompts/planner.js';
import { FakeLlm, FakePhysics } from './fakes/index.js';
import { loadPumpDegradedSnapshot } from './fixtures/index.js';

class PickFirstLlm implements LlmPort {
  async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
    if (req.tools?.[0]?.name !== CHOOSE_OPTIONS_TOOL_NAME) return FakeLlm.text('no assessment');
    const user = req.messages.find((m) => m.role === 'user');
    const text = user && 'content' in user ? String(user.content) : '';
    const input = JSON.parse(text.slice(text.indexOf('PLANNING_INPUT=') + 'PLANNING_INPUT='.length)) as {
      jobs: { job_id: string; options: { option_id: string }[] }[];
    };
    return FakeLlm.toolCall(CHOOSE_OPTIONS_TOOL_NAME, {
      choices: input.jobs.map((j) => ({ job_id: j.job_id, option_id: j.options[0]!.option_id, needs_approval: false, explanation: 'pick' })),
    });
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'policy-usage-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('policy usage counters (CONTRACTS 0.14)', () => {
  it('no model configured: zero model counters, every replan is a counted fallback, wall time recorded', async () => {
    const obs = loadPumpDegradedSnapshot();
    const policy = createNemotronPolicy({ llm: null, physics: new FakePhysics(), cacheDir: dir });
    await policy(obs, { sim_time_ms: obs.clock.sim_time_ms });
    const u = policy.usage();
    expect(u).toMatchObject({ model_requests: 0, live_model_responses: 0, cache_hits: 0, fallback_decisions: 1 });
    expect(u.decision_wall_time_ms).toBeGreaterThan(0);
  });

  it('counts live responses, then cache hits, and counters survive reset()', async () => {
    const obs = loadPumpDegradedSnapshot();
    const ctx = { sim_time_ms: obs.clock.sim_time_ms };
    const first = createNemotronPolicy({ llm: new PickFirstLlm(), physics: new FakePhysics(), cacheDir: dir, model: 'm' });
    await first(obs, ctx);
    const live = first.usage();
    expect(live.model_requests).toBeGreaterThan(0);
    expect(live.live_model_responses).toBe(live.model_requests);
    expect(live.cache_hits).toBe(0);
    first.reset();
    expect(first.usage()).toEqual(live);

    const second = createNemotronPolicy({ llm: new PickFirstLlm(), physics: new FakePhysics(), cacheDir: dir, model: 'm' });
    await second(obs, ctx);
    const replay = second.usage();
    expect(replay.cache_hits).toBe(live.model_requests);
    expect(replay.live_model_responses).toBe(0);
    second.reset();
    expect(second.usage()).toEqual(replay);
  });
});
