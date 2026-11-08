// Budget accounting through the real cfg-built client path: createNimLlm is replaced by a stand-in that emits the
// adapter's events, so corrective retries are observed exactly the way round.ts observes them in production.

import type { Incident, IncidentLink } from '@dcos/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../src/config.js';
import type { NimLlmEvent, NimLlmOptions } from '../../src/llm.js';
import { planIncidents } from '../../src/planner.js';
import type { LlmChatRequest, LlmChatResponse } from '../../src/ports.js';
import { CHOOSE_OPTIONS_TOOL_NAME } from '../../src/prompts/planner.js';
import { TEAM_BUDGET, createTeamChooser } from '../../src/team/round.js';
import { FakeDb, FakeLlm, FakePhysics } from '../fakes/index.js';
import { RUN_ID, loadPumpDegradedSnapshot } from '../fixtures/index.js';

interface Script {
  respond: (req: LlmChatRequest, n: number) => LlmChatResponse;
  /** Which chat() calls (0-based) the stand-in performs a corrective retry on. */
  corrective: (n: number) => boolean;
  /** Runs before the corrective event; a promise that never settles models a hung request. */
  before?: (n: number) => Promise<void>;
  /** Runs after the corrective event, before the reply. */
  after?: (n: number) => Promise<void>;
}

const nim = vi.hoisted(() => ({
  options: [] as unknown[],
  configs: [] as unknown[],
  requests: [] as unknown[],
  script: null as unknown,
}));

vi.mock('../../src/llm.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/llm.js')>();
  return {
    ...original,
    createNimLlm: (cfg: AgentConfig, opts: NimLlmOptions) => {
      nim.configs.push(cfg);
      nim.options.push(opts);
      let n = 0;
      return {
        endpoints: [],
        chat: async (req: LlmChatRequest): Promise<LlmChatResponse> => {
          const i = n++;
          nim.requests.push(req);
          const script = nim.script as Script;
          await script.before?.(i);
          if (script.corrective(i)) {
            await Promise.resolve();
            opts.onEvent?.({ type: 'tool_args_invalid', endpoint: 'primary', model: 'm', corrective: true } satisfies NimLlmEvent);
          }
          await script.after?.(i);
          return script.respond(req, i);
        },
      };
    },
  };
});

const INCIDENT: Incident = {
  schema_version: '1.1.0',
  run_id: RUN_ID,
  incident_id: 'inc-pump-a',
  state: 'open',
  severity: 'high',
  title: 'loop-a racks throttling',
  hypothesis: null,
  confidence: 0.7,
  opened_sim_time_ms: 430_000,
  updated_sim_time_ms: 540_000,
  version: 1,
};

const LINKS: IncidentLink[] = ['pump-a', 'loop-a', 'rack-r2', 'rack-r3', 'rack-r4'].map((linked_id) => ({
  schema_version: '1.1.0',
  run_id: RUN_ID,
  incident_id: INCIDENT.incident_id,
  linked_id,
  link_kind: 'resource',
  reason: 'test',
}));

const CFG = { NIM_API_KEY: 'test-key', NIM_MODEL: 'test-model', LLM_TIMEOUT_MS: 30_000 } as unknown as AgentConfig;

const toolOf = (req: LlmChatRequest) => req.tools![0]!.name;
const isCooling = (req: LlmChatRequest) => String((req.messages[0] as { content: string }).content).startsWith('You are the Cooling');

/** Well-formed replies citing ids the fixture's snapshot provides to both roles. */
const healthy = (req: LlmChatRequest): LlmChatResponse => {
  const tool = toolOf(req);
  if (tool === 'submit_finding') {
    return FakeLlm.toolCall('submit_finding', {
      summary: 'observed',
      evidence_ids: ['sig-pump-a-alarm-1'],
      resource_ids: [isCooling(req) ? 'pump-a' : 'job-a'],
      question_for_peer: 'Anything I should know?',
      no_question_reason: null,
    });
  }
  if (tool === 'answer_peer') {
    return FakeLlm.toolCall('answer_peer', { answer: 'noted', evidence_ids: ['sig-pump-a-alarm-1'], resource_ids: [] });
  }
  return FakeLlm.toolCall(CHOOSE_OPTIONS_TOOL_NAME, {
    choices: [{ job_id: 'job-a', option_id: 'job-a:keep', needs_approval: false, explanation: 'keep' }],
  });
};

let db: FakeDb;
let physics: FakePhysics;

beforeEach(async () => {
  nim.options.length = 0;
  nim.configs.length = 0;
  nim.requests.length = 0;
  physics = new FakePhysics();
  db = new FakeDb({ snapshot: loadPumpDegradedSnapshot(), physics });
  await db.upsertIncident(INCIDENT, LINKS);
});

const plan = (script: Script) => {
  nim.script = script;
  return planIncidents(
    { db, physics, llm: new FakeLlm(), workflowId: 'wf-1', runId: RUN_ID, chooser: createTeamChooser({ cfg: CFG, now: () => Date.now() }) },
    { incidents: [INCIDENT] },
  );
};

describe('team client budget', () => {
  it('builds the client with the team call timeout, no retries and no fallback', async () => {
    await plan({ respond: healthy, corrective: () => false });
    expect((nim.configs[0] as AgentConfig).LLM_TIMEOUT_MS).toBe(TEAM_BUDGET.callTimeoutMs);
    expect(nim.options[0]).toMatchObject({ maxRetries: 0, useFallback: false });
  });

  it('spends five calls on a clean round', async () => {
    const r = await plan({ respond: healthy, corrective: () => false });
    expect(r.team!.calls_used).toBe(5);
    expect(r.team!.outcome).toBe('lead');
  });

  it('counts corrective retries and never exceeds six when every call needs one', async () => {
    const r = await plan({
      respond: (req) => (toolOf(req) === CHOOSE_OPTIONS_TOOL_NAME ? FakeLlm.toolCall(CHOOSE_OPTIONS_TOOL_NAME, '{bad') : FakeLlm.toolCall(toolOf(req), '{bad')),
      corrective: () => true,
    });
    // Two findings and the Lead, each with a corrective retry; answers and cover are refused to protect the Lead.
    expect(nim.requests).toHaveLength(3);
    expect(r.team!.calls_used).toBe(TEAM_BUDGET.maxCalls);
    expect(r.team!.outcome).toBe('deterministic');
  });

  it('still reaches the Lead when correctives leave exactly enough budget', async () => {
    const r = await plan({ respond: healthy, corrective: (n) => n === 0 || n === 1 });
    expect(r.team!.calls_used).toBe(5);
    expect(nim.requests.map((q) => toolOf(q as LlmChatRequest))).not.toContain('answer_peer');
    expect(r.team!.outcome).toBe('lead');
  });

  it('skips the Lead rather than risk a seventh call', async () => {
    // Finding corrective (3 spent), first answer corrective (5 spent): the Lead's worst case would be 7.
    const r = await plan({ respond: healthy, corrective: (n) => n === 0 || n === 2 });
    expect(r.team!.calls_used).toBe(5);
    expect(nim.requests.map((q) => toolOf(q as LlmChatRequest))).not.toContain(CHOOSE_OPTIONS_TOOL_NAME);
    expect(r.team!.outcome).toBe('deterministic');
    expect(r.team!.missing_roles).toContain('lead');
  });

  it('caps a corrective retry at the round deadline and drops what follows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const running = plan({
        respond: healthy,
        corrective: (n) => n === 4,
        // Findings take 5 s, both answers hang until the 18 s specialist limit, the Lead retries at 25 s and then hangs.
        before: (n) => (n < 2 ? wait(5_000) : n < 4 ? new Promise<void>(() => {}) : wait(7_000)),
        after: (n) => (n === 4 ? new Promise<void>(() => {}) : Promise.resolve()),
      });
      await vi.advanceTimersByTimeAsync(40_000);
      const r = await running;
      expect(r.team!.wall_ms).toBe(TEAM_BUDGET.roundMs);
      expect(r.team!.calls_used).toBe(TEAM_BUDGET.maxCalls);
      expect(r.team!.outcome).toBe('deterministic');
      const before = structuredClone(r.team!);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(r.team).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
