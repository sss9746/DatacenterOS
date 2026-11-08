import type { Incident, IncidentLink, SignalEvent } from '@dcos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planIncidents, type ChooserResult, type PlanResult } from '../../src/planner.js';
import type { LlmChatRequest, LlmChatResponse } from '../../src/ports.js';
import { CHOOSE_OPTIONS_TOOL_NAME } from '../../src/prompts/planner.js';
import { TEAM_LIMITS, boundMessage, boundTrace, teamFeedEvents, type TeamMessage, type TeamTrace } from '../../src/team/protocol.js';
import { ROLE_EVIDENCE_MAX_BYTES } from '../../src/team/roles.js';
import { TEAM_BUDGET, createTeamChooser } from '../../src/team/round.js';
import { FakeDb, FakeLlm, FakePhysics } from '../fakes/index.js';
import { RUN_ID, loadPumpDegradedSnapshot } from '../fixtures/index.js';

const SIM_MS = 540_000;
const COOL_EVENT = 'ev-cool-1';
const XID_EVENT = 'ev-xid-1';
const XID_GPU = 'gpu-r2-n1-0';

const PUMP: Incident = {
  schema_version: '1.1.0',
  run_id: RUN_ID,
  incident_id: 'inc-pump-a',
  state: 'open',
  severity: 'high',
  title: 'loop-a racks throttling',
  hypothesis: null,
  confidence: 0.7,
  opened_sim_time_ms: 430_000,
  updated_sim_time_ms: SIM_MS,
  version: 1,
};

const link = (linked: string): IncidentLink => ({
  schema_version: '1.1.0',
  run_id: RUN_ID,
  incident_id: PUMP.incident_id,
  linked_id: linked,
  link_kind: 'resource',
  reason: 'test',
});

const signal = (event_id: string, resource_id: string, event_type: SignalEvent['event_type'], xid_code: number | null): SignalEvent => ({
  schema_version: '1.1.0',
  event_id,
  run_id: RUN_ID,
  resource_id,
  source_kind: 'simulator',
  source_id: 'sim-engine-1',
  source_seq: 1,
  sim_time_ms: SIM_MS,
  observed_unix_ms: 1,
  event_type,
  xid_code,
  severity: 'critical',
  message: `${event_type} on ${resource_id}`,
  evidence: {},
});

type Handler = (req: LlmChatRequest) => LlmChatResponse | Promise<LlmChatResponse>;

const roleOf = (req: LlmChatRequest): string => {
  const system = req.messages[0];
  const text = system && 'content' in system ? String(system.content) : '';
  if (text.startsWith('You are the Cooling')) return 'cooling';
  if (text.startsWith('You are the Workload')) return 'workload';
  return 'lead';
};
const keyOf = (req: LlmChatRequest): string => `${roleOf(req)}:${req.tools![0]!.name}`;
const contentOf = (m: LlmChatRequest['messages'][number] | undefined): string => (m && 'content' in m ? String(m.content ?? '') : '');
const lastUser = (req: LlmChatRequest): string => contentOf([...req.messages].reverse().find((m) => m.role === 'user'));

const COOLING_FINDING = {
  summary: 'pump-a is degraded at 31 kW of 60 kW',
  evidence_ids: [COOL_EVENT],
  resource_ids: ['pump-a'],
  question_for_peer: 'Does job-a have a complete checkpoint?',
  no_question_reason: null,
};
const WORKLOAD_FINDING = {
  summary: 'job-a holds unsaved work and a GPU reports Xid 79',
  evidence_ids: [XID_EVENT],
  resource_ids: ['job-a'],
  question_for_peer: 'Is rack-r1 thermally safe?',
  no_question_reason: null,
};
const COOLING_ANSWER = { answer: 'rack-r1 has 14 C of headroom on loop-b', evidence_ids: [COOL_EVENT], resource_ids: ['rack-r1'] };
const WORKLOAD_ANSWER = { answer: 'job-a checkpoint ckpt-job-a-0 is complete', evidence_ids: [XID_EVENT], resource_ids: ['ckpt-job-a-0'] };

const leadPicksTop: Handler = (req) => {
  const text = lastUser(req);
  const input = JSON.parse(text.slice(text.indexOf('PLANNING_INPUT=') + 'PLANNING_INPUT='.length)) as { jobs: { job_id: string; options: { option_id: string }[] }[] };
  return FakeLlm.toolCall(CHOOSE_OPTIONS_TOOL_NAME, {
    choices: input.jobs.map((j) => ({ job_id: j.job_id, option_id: j.options[0]!.option_id, needs_approval: false, explanation: 'team choice' })),
  });
};

const DEFAULTS: Record<string, Handler> = {
  'cooling:submit_finding': () => FakeLlm.toolCall('submit_finding', COOLING_FINDING),
  'workload:submit_finding': () => FakeLlm.toolCall('submit_finding', WORKLOAD_FINDING),
  'cooling:answer_peer': () => FakeLlm.toolCall('answer_peer', COOLING_ANSWER),
  'workload:answer_peer': () => FakeLlm.toolCall('answer_peer', WORKLOAD_ANSWER),
  [`lead:${CHOOSE_OPTIONS_TOOL_NAME}`]: leadPicksTop,
};

const LEAD = `lead:${CHOOSE_OPTIONS_TOOL_NAME}`;

/** A FakeLlm whose every step routes on the caller's role and tool, so parallel call order does not matter. */
const teamLlm = (overrides: Record<string, Handler> = {}): FakeLlm => {
  const handlers = { ...DEFAULTS, ...overrides };
  const route: Handler = (req) => handlers[keyOf(req)]!(req);
  return new FakeLlm(Array.from({ length: 12 }, () => route));
};

const requestsFor = (llm: FakeLlm, key: string): LlmChatRequest[] => llm.requests.filter((r) => keyOf(r) === key);
const never = (): Promise<LlmChatResponse> => new Promise(() => {});

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let db: FakeDb;
let physics: FakePhysics;

beforeEach(async () => {
  physics = new FakePhysics();
  db = new FakeDb({ snapshot: loadPumpDegradedSnapshot(), physics });
  await db.upsertIncident(PUMP, ['pump-a', 'loop-a', 'rack-r2', 'rack-r3', 'rack-r4', XID_GPU].map(link));
  db.injectSignal(signal(COOL_EVENT, 'pump-a', 'equipment_alarm', null));
  db.injectSignal(signal(XID_EVENT, XID_GPU, 'xid_error', 79));
});

afterEach(() => {
  vi.useRealTimers();
});

const plan = (llm: FakeLlm): Promise<PlanResult> =>
  planIncidents(
    { db, physics, llm: new FakeLlm(), workflowId: 'wf-1', runId: RUN_ID, chooser: createTeamChooser({ llm, now: () => Date.now() }) },
    { incidents: [PUMP] },
  );

const messagesOf = (r: PlanResult, kind: TeamMessage['kind']): TeamMessage[] => r.team!.messages.filter((m) => m.kind === kind);

describe('evidence partitioning', () => {
  it('gives each specialist a different, bounded slice with no private or real-hardware data', async () => {
    const llm = teamLlm();
    await plan(llm);
    const cooling = lastUser(requestsFor(llm, 'cooling:submit_finding')[0]!);
    const workload = lastUser(requestsFor(llm, 'workload:submit_finding')[0]!);

    expect(cooling).not.toBe(workload);
    for (const present of ['operating_state', 'min_thermal_headroom_c', 'max_temp_c', COOL_EVENT]) expect(cooling).toContain(present);
    for (const absent of ['progress_work_units', 'ckpt-job-a-0', 'placements', 'last_xid_code', XID_EVENT]) expect(cooling).not.toContain(absent);
    for (const present of ['progress_work_units', 'ckpt-job-a-0', 'placements', 'last_xid_code', XID_EVENT]) expect(workload).toContain(present);
    for (const absent of ['operating_state', 'thermal_headroom', 'temp_c', 'cooling_states', COOL_EVENT]) expect(workload).not.toContain(absent);

    for (const text of [cooling, workload]) {
      expect(Buffer.byteLength(text.slice(text.indexOf('EVIDENCE=') + 'EVIDENCE='.length), 'utf8')).toBeLessThanOrEqual(ROLE_EVIDENCE_MAX_BYTES);
      for (const forbidden of ['gpu-real-0', 'node-real-0', 'fault_injection', 'active_faults', 'hidden_physics']) expect(text).not.toContain(forbidden);
    }
  });
});

describe('round flow', () => {
  it('starts both specialists before either finishes, and never exceeds two in flight', async () => {
    const coolingGate = deferred<LlmChatResponse>();
    const workloadGate = deferred<LlmChatResponse>();
    let inFlight = 0;
    let peak = 0;
    const track = (inner: Handler): Handler => async (req) => {
      peak = Math.max(peak, ++inFlight);
      try {
        return await inner(req);
      } finally {
        inFlight -= 1;
      }
    };
    const llm = teamLlm({
      'cooling:submit_finding': track(() => coolingGate.promise),
      'workload:submit_finding': track(() => workloadGate.promise),
      'cooling:answer_peer': track(DEFAULTS['cooling:answer_peer']!),
      'workload:answer_peer': track(DEFAULTS['workload:answer_peer']!),
      [LEAD]: track(leadPicksTop),
    });
    const running = plan(llm);
    await vi.waitFor(() => expect(llm.requests).toHaveLength(2));
    expect(llm.requests.map(keyOf).sort()).toEqual(['cooling:submit_finding', 'workload:submit_finding']);

    coolingGate.resolve(FakeLlm.toolCall('submit_finding', COOLING_FINDING));
    workloadGate.resolve(FakeLlm.toolCall('submit_finding', WORKLOAD_FINDING));
    const result = await running;
    expect(peak).toBe(2);
    expect(result.team!.calls_used).toBe(5);
  });

  it('delivers a question into the other specialist session and an answer into the asker next input', async () => {
    const llm = teamLlm();
    const r = await plan(llm);

    const workloadAnswer = requestsFor(llm, 'workload:answer_peer')[0]!;
    expect(lastUser(workloadAnswer)).toContain(COOLING_FINDING.question_for_peer);
    expect(workloadAnswer.messages.some((m) => m.role === 'assistant')).toBe(true);

    // Workload answered first, so its answer is in Cooling's next model input.
    const coolingAnswer = requestsFor(llm, 'cooling:answer_peer')[0]!;
    expect(lastUser(coolingAnswer)).toContain(`Message from Workload: ${WORKLOAD_ANSWER.answer}`);
    expect(lastUser(coolingAnswer)).toContain(WORKLOAD_FINDING.question_for_peer);

    const fromWorkload = messagesOf(r, 'answer').find((m) => m.from === 'workload')!;
    expect(fromWorkload.to).toBe('cooling');
    expect(fromWorkload.consumed_by).toEqual(['cooling', 'lead']);
    const question = messagesOf(r, 'question').find((m) => m.from === 'cooling')!;
    expect(fromWorkload.reply_to).toBe(question.id);
    expect(question.consumed_by).toContain('workload');
  });

  it('marks a one-way answer consumed only by the Lead, since the asker has no further model call', async () => {
    const llm = teamLlm({
      'workload:submit_finding': () => FakeLlm.toolCall('submit_finding', { ...WORKLOAD_FINDING, question_for_peer: null, no_question_reason: 'nothing needed' }),
    });
    const r = await plan(llm);
    expect(requestsFor(llm, 'cooling:answer_peer')).toHaveLength(0);
    expect(messagesOf(r, 'answer').map((m) => m.consumed_by)).toEqual([['lead']]);
    expect(r.team!.calls_used).toBe(4);
  });

  it("puts findings, answers and the candidate board in the Lead's input and uses its choices", async () => {
    const llm = teamLlm();
    const r = await plan(llm);
    const input = lastUser(requestsFor(llm, LEAD)[0]!);
    for (const text of [COOLING_FINDING.summary, WORKLOAD_FINDING.summary, COOLING_ANSWER.answer, WORKLOAD_ANSWER.answer, 'PLANNING_INPUT=', 'job-a:ckpt+move']) {
      expect(input).toContain(text);
    }
    for (const m of [...messagesOf(r, 'finding'), ...messagesOf(r, 'answer')]) expect(m.consumed_by).toContain('lead');
    expect(r.team!.outcome).toBe('lead');
    expect(r.team!.missing_roles).toEqual([]);
    expect(r.job_plans.every((p) => p.decided_by === 'nemotron')).toBe(true);
    expect(messagesOf(r, 'decision')).toHaveLength(1);
  });
});

describe('cover', () => {
  it('covers once for a failed specialist, using its evidence, and stays in budget', async () => {
    const llm = teamLlm({ 'cooling:submit_finding': () => Promise.reject(new Error('boom')) });
    const r = await plan(llm);

    const workloadCalls = requestsFor(llm, 'workload:submit_finding');
    expect(workloadCalls).toHaveLength(2);
    expect(lastUser(workloadCalls[1]!)).toContain('operating_state');
    expect(r.team!.covers).toEqual([{ failed_role: 'cooling', covered_by: 'workload' }]);
    expect(r.team!.missing_roles).toEqual([]);
    expect(messagesOf(r, 'cover').map((m) => m.consumed_by)).toEqual([['lead']]);
    expect(r.team!.calls_used).toBe(4);
    expect(r.team!.calls_used).toBeLessThanOrEqual(TEAM_BUDGET.maxCalls);
    // Its question to the failed role was never delivered to a model.
    expect(messagesOf(r, 'question').map((m) => m.consumed_by)).toEqual([[]]);
    expect(r.team!.outcome).toBe('lead');
  });

  it('shows the advice as missing when the cover itself is unusable', async () => {
    let n = 0;
    const llm = teamLlm({
      'cooling:submit_finding': () => Promise.reject(new Error('boom')),
      'workload:submit_finding': () =>
        FakeLlm.toolCall('submit_finding', n++ === 0 ? WORKLOAD_FINDING : { ...WORKLOAD_FINDING, evidence_ids: ['made-up'] }),
    });
    const r = await plan(llm);
    expect(r.team!.covers).toEqual([]);
    expect(r.team!.missing_roles).toEqual(['cooling']);
    expect(r.team!.outcome).toBe('lead');
  });

  it('does not attempt a cover when both specialists failed', async () => {
    const fail = () => Promise.reject(new Error('boom'));
    const llm = teamLlm({ 'cooling:submit_finding': fail, 'workload:submit_finding': fail });
    const r = await plan(llm);
    expect(r.team!.calls_used).toBe(3);
    expect(r.team!.covers).toEqual([]);
    expect(r.team!.missing_roles.sort()).toEqual(['cooling', 'workload']);
    expect(r.team!.outcome).toBe('lead');
  });
});

describe('validation', () => {
  it('rejects a finding citing an unknown evidence id and treats the role as failed', async () => {
    const llm = teamLlm({ 'workload:submit_finding': () => FakeLlm.toolCall('submit_finding', { ...WORKLOAD_FINDING, evidence_ids: ['no-such-event'] }) });
    const r = await plan(llm);
    expect(messagesOf(r, 'finding').map((m) => m.from)).toEqual(['cooling']);
    const objection = messagesOf(r, 'objection');
    expect(objection).toHaveLength(1);
    expect(objection[0]!.from).toBe('supervisor');
    expect(JSON.stringify(r.team)).not.toContain('no-such-event');
    expect(requestsFor(llm, LEAD).map(lastUser).join()).not.toContain(WORKLOAD_FINDING.summary);
    expect(requestsFor(llm, 'cooling:submit_finding')).toHaveLength(2); // Cooling covered
  });

  it('rejects a finding citing a resource outside the role bundle', async () => {
    const llm = teamLlm({ 'cooling:submit_finding': () => FakeLlm.toolCall('submit_finding', { ...COOLING_FINDING, resource_ids: ['job-a'] }) });
    const r = await plan(llm);
    expect(messagesOf(r, 'finding').map((m) => m.from)).toEqual(['workload']);
    expect(r.team!.covers).toEqual([{ failed_role: 'cooling', covered_by: 'workload' }]);
  });

  it('rejects a null question that gives no reason', async () => {
    const llm = teamLlm({ 'cooling:submit_finding': () => FakeLlm.toolCall('submit_finding', { ...COOLING_FINDING, question_for_peer: null }) });
    const r = await plan(llm);
    expect(messagesOf(r, 'finding').map((m) => m.from)).toEqual(['workload']);
  });
});

describe('failure and deadlines', () => {
  it('ends deterministic and within budget when every tool call is malformed', async () => {
    const bad: Handler = () => FakeLlm.toolCall('submit_finding', '{not json');
    const llm = teamLlm({ 'cooling:submit_finding': bad, 'workload:submit_finding': bad, [LEAD]: () => FakeLlm.toolCall(CHOOSE_OPTIONS_TOOL_NAME, '{not json') });
    const r = await plan(llm);
    expect(r.team!.outcome).toBe('deterministic');
    expect(r.team!.calls_used).toBeLessThanOrEqual(TEAM_BUDGET.maxCalls);
    expect(r.used_llm).toBe(false);
  });

  it('times hung calls out at 8 s each and finishes inside the round deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const llm = teamLlm({ 'cooling:submit_finding': never, 'workload:submit_finding': never, [LEAD]: never });
    const running = plan(llm);
    await vi.advanceTimersByTimeAsync(40_000);
    const r = await running;
    expect(r.team!.outcome).toBe('deterministic');
    expect(r.team!.calls_used).toBe(3);
    expect(r.team!.wall_ms).toBe(16_000);
    expect(r.team!.wall_ms).toBeLessThanOrEqual(TEAM_BUDGET.roundMs);
  });

  it('ignores a specialist reply that arrives after its call timed out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const late = deferred<LlmChatResponse>();
    const llm = teamLlm({ 'cooling:submit_finding': () => late.promise });
    const running = plan(llm);
    await vi.advanceTimersByTimeAsync(9_000);
    late.resolve(FakeLlm.toolCall('submit_finding', COOLING_FINDING));
    await vi.advanceTimersByTimeAsync(1_000);
    const r = await running;
    expect(messagesOf(r, 'finding').map((m) => m.from)).toEqual(['workload']);
    expect(r.team!.covers).toEqual([{ failed_role: 'cooling', covered_by: 'workload' }]);
  });

  it('lets a late Lead reply change neither the result nor the trace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const late = deferred<LlmChatResponse>();
    let leadRequest: LlmChatRequest | undefined;
    const llm = teamLlm({
      [LEAD]: (req) => {
        leadRequest = req;
        return late.promise;
      },
    });
    const running = plan(llm);
    await vi.advanceTimersByTimeAsync(TEAM_BUDGET.roundMs + 1_000);
    const r = await running;
    expect(r.team!.outcome).toBe('deterministic');
    const before = structuredClone(r.team!);
    const beforePlans = r.job_plans.map((p) => p.chosen.option_id);

    late.resolve(await leadPicksTop(leadRequest!));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(r.team).toEqual(before);
    expect(r.job_plans.map((p) => p.chosen.option_id)).toEqual(beforePlans);
    expect(r.job_plans.every((p) => p.decided_by === 'deterministic')).toBe(true);
  });

  it('returns choices null with findings retained when the Lead fails outright', async () => {
    const llm = teamLlm({ [LEAD]: () => Promise.reject(new Error('down')) });
    const r = await plan(llm);
    expect(r.team!.outcome).toBe('deterministic');
    expect(r.team!.missing_roles).toEqual(['lead']);
    expect(messagesOf(r, 'finding')).toHaveLength(2);
    expect(r.used_llm).toBe(false);
    expect(r.actor).toBe('code');
    expect(r.job_plans.every((p) => p.decided_by === 'deterministic')).toBe(true);
  });

  it('treats a Lead that picks only unlisted options as no valid choice', async () => {
    const llm = teamLlm({
      [LEAD]: () => FakeLlm.toolCall(CHOOSE_OPTIONS_TOOL_NAME, { choices: [{ job_id: 'job-a', option_id: 'job-a:invented', needs_approval: false, explanation: 'x' }] }),
    });
    const r = await plan(llm);
    expect(r.team!.outcome).toBe('deterministic');
    expect(r.used_llm).toBe(false);
  });

  it('never throws when the chooser has no client at all', async () => {
    const r = await planIncidents(
      { db, physics, llm: new FakeLlm(), workflowId: 'wf-1', runId: RUN_ID, chooser: createTeamChooser({ now: () => Date.now() }) },
      { incidents: [PUMP] },
    );
    expect(r.team!.outcome).toBe('deterministic');
    expect(r.team!.calls_used).toBe(0);
  });
});

describe('trace bounds and feed', () => {
  it('clips a long model summary to the message limit', async () => {
    const llm = teamLlm({ 'cooling:submit_finding': () => FakeLlm.toolCall('submit_finding', { ...COOLING_FINDING, summary: 'x'.repeat(5_000) }) });
    const r = await plan(llm);
    expect(messagesOf(r, 'finding').find((m) => m.from === 'cooling')!.summary.length).toBeLessThanOrEqual(TEAM_LIMITS.summaryChars);
  });

  it('enforces message, summary and id limits', () => {
    const message = (i: number): TeamMessage => ({
      id: `m${i}`,
      round_id: 'r',
      from: 'cooling',
      to: 'lead',
      kind: 'finding',
      reply_to: null,
      summary: 's'.repeat(1_000),
      evidence_ids: Array.from({ length: 30 }, (_, n) => `e${n}`),
      resource_ids: Array.from({ length: 30 }, (_, n) => `r${n}`),
      consumed_by: ['lead', 'lead'],
    });
    const one = boundMessage(message(0));
    expect(one.summary.length).toBeLessThanOrEqual(TEAM_LIMITS.summaryChars);
    expect(one.evidence_ids).toHaveLength(TEAM_LIMITS.evidenceIds);
    expect(one.resource_ids).toHaveLength(TEAM_LIMITS.resourceIds);
    expect(one.consumed_by).toEqual(['lead']);

    const trace: TeamTrace = {
      version: 1,
      round_id: 'r',
      snapshot_sim_ms: 0,
      model: null,
      calls_used: 0,
      wall_ms: 0,
      outcome: 'lead',
      messages: Array.from({ length: 40 }, (_, i) => message(i)),
      covers: [],
      missing_roles: [],
    };
    const bounded = boundTrace(trace);
    expect(bounded.messages).toHaveLength(TEAM_LIMITS.messages);
    expect(bounded.messages.at(-1)!.id).toBe('m39');
  });

  it('holds the limits and identifies the round on a real trace', async () => {
    const r = await plan(teamLlm());
    expect(r.team!.version).toBe(1);
    expect(r.team!.round_id).toMatch(/^wf-1:a1:e\d+$/);
    expect(r.team!.snapshot_sim_ms).toBe(SIM_MS);
    expect(r.team!.model).toBe('fake-nemotron');
    expect(r.team!.messages.length).toBeLessThanOrEqual(TEAM_LIMITS.messages);
    expect(new Set(r.team!.messages.map((m) => m.id)).size).toBe(r.team!.messages.length);
  });

  it('projects messages to feed events, labelling covers and deterministic outcomes', async () => {
    const covered = await plan(teamLlm({ 'cooling:submit_finding': () => Promise.reject(new Error('boom')) }));
    const events = teamFeedEvents(covered.team!, 'inc-1');
    expect(events.some((e) => e.summary.startsWith('Workload covering for Cooling: '))).toBe(true);
    expect(events.every((e) => e.stage === 'plan' && e.incidentId === 'inc-1' && e.toolCalls[0]!.tool === 'team_message')).toBe(true);
    expect(events.find((e) => e.summary.startsWith('Workload → Lead'))!.actor).toBe('nemotron');

    const failed = await plan(teamLlm({ [LEAD]: () => Promise.reject(new Error('down')) }));
    const last = teamFeedEvents(failed.team!).at(-1)!;
    expect(last.actor).toBe('code');
    expect(last.summary).toContain('deterministic');
    expect(teamFeedEvents(failed.team!).some((e) => e.summary === 'Missing team advice: Lead')).toBe(true);
  });
});

describe('planIncidents seam', () => {
  const trace = (): TeamTrace => ({
    version: 1,
    round_id: 'stub',
    snapshot_sim_ms: 0,
    model: 'stub',
    calls_used: 1,
    wall_ms: 1,
    outcome: 'lead',
    messages: [],
    covers: [],
    missing_roles: [],
  });

  it('uses the chooser instead of the single LLM call', async () => {
    const llm = new FakeLlm();
    const chooser = vi.fn(async (): Promise<ChooserResult> => ({
      choices: [{ job_id: 'job-a', option_id: 'job-a:keep', needs_approval: false, explanation: 'stub keeps job-a' }],
      team: trace(),
    }));
    const r = await planIncidents({ db, physics, llm, workflowId: 'wf-1', runId: RUN_ID, chooser }, { incidents: [PUMP] });
    expect(chooser).toHaveBeenCalledOnce();
    expect(llm.requests).toHaveLength(0);
    expect(r.team).toEqual(trace());
    const a = r.job_plans.find((p) => p.job_id === 'job-a')!;
    expect(a.chosen.option_id).toBe('job-a:keep');
    expect(a.decided_by).toBe('nemotron');
  });

  it('follows the existing outage path when the chooser returns null', async () => {
    const llm = new FakeLlm();
    const r = await planIncidents({ db, physics, llm, workflowId: 'wf-1', runId: RUN_ID, chooser: async () => ({ choices: null, team: trace() }) }, { incidents: [PUMP] });
    expect(llm.requests).toHaveLength(0);
    expect(r.used_llm).toBe(false);
    expect(r.team).toBeDefined();
  });

  it('calls the single LLM exactly as before when no chooser is set', async () => {
    const llm = new FakeLlm([leadPicksTop]);
    const r = await planIncidents({ db, physics, llm, workflowId: 'wf-1', runId: RUN_ID }, { incidents: [PUMP] });
    expect(llm.requests).toHaveLength(1);
    expect(contentOf(llm.requests[0]!.messages[0])).toMatch(/^You are a GPU-cluster incident engineer/);
    expect(lastUser(llm.requests[0]!)).not.toContain('TEAM_INPUT');
    expect(r.used_llm).toBe(true);
    expect('team' in r).toBe(false);
  });
});
