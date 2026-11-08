import { describe, expect, it } from 'vitest';
import { createEventPublisher, summarizeToolCall, MAX_PENDING_EVENTS } from '../src/events.js';
import { redactString } from '../src/config.js';
import type { AgentEventInput, DbPort } from '../src/ports.js';
import { FakeDb } from './fakes/index.js';
import { loadPumpDegradedSnapshot } from './fixtures/index.js';

const clock = { simTimeMs: () => 5_000, unixMs: () => 1_794_091_200_000 };
const identity = (s: string) => s;

function setup(opts: { startSeq?: number; redact?: (s: string) => string } = {}) {
  const db = new FakeDb({ snapshot: loadPumpDegradedSnapshot() });
  const pub = createEventPublisher({ db, runId: 'run1', clock, redact: opts.redact ?? identity, startSeq: opts.startSeq });
  return { db, pub };
}

/** DbPort stub whose publishAgentEvent fails while `failing` is true. */
function flakyDb() {
  const published: AgentEventInput[] = [];
  const state = { failing: true, attempts: 0 };
  const db = {
    async publishAgentEvent(ev: AgentEventInput) {
      state.attempts++;
      if (state.failing) throw new Error('db down');
      published.push(ev);
    },
  } as unknown as DbPort;
  return { db, published, state };
}

describe('event publisher ids and shape', () => {
  it('assigns monotonic ids and publishes through the db', async () => {
    const { db, pub } = setup();
    const a = await pub.emit('triage', { summary: 'one' });
    const b = await pub.emit('plan', { summary: 'two', workflowId: 'wf1', incidentId: 'inc1' });
    expect(a.agent_event_id).toBe('ae-run1-000001');
    expect(b.agent_event_id).toBe('ae-run1-000002');
    expect(db.agentEvents.map((e) => e.agent_event_id)).toEqual([a.agent_event_id, b.agent_event_id]);
    expect(b).toMatchObject({ run_id: 'run1', workflow_id: 'wf1', incident_id: 'inc1', stage: 'plan', sim_time_ms: 5_000 });
    expect(a.workflow_id).toBeNull();
  });

  it('honors startSeq so a resumed agent does not collide', async () => {
    const { pub } = setup({ startSeq: 42 });
    const e = await pub.emit('verify', { summary: 'x' });
    expect(e.agent_event_id).toBe('ae-run1-000042');
    expect(pub.nextSeq()).toBe(43);
  });

  it('assigns ids in call order for concurrent emits', async () => {
    const { db, pub } = setup();
    await Promise.all([pub.emit('triage', { summary: 'a' }), pub.emit('triage', { summary: 'b' }), pub.emit('triage', { summary: 'c' })]);
    expect(db.agentEvents.map((e) => e.summary)).toEqual(['a', 'b', 'c']);
  });
});

describe('trimming and dedupe', () => {
  it('trims summary to 200 chars and tool fields to 160', async () => {
    const { pub } = setup();
    const e = await pub.emit('diagnose', {
      summary: 'x'.repeat(500),
      toolCalls: [{ tool: 't', args_summary: 'a'.repeat(400), result_summary: 'r'.repeat(400) }],
    });
    expect(e.summary.length).toBeLessThanOrEqual(200);
    expect(e.tool_calls[0]?.args_summary.length).toBeLessThanOrEqual(160);
    expect(e.tool_calls[0]?.result_summary.length).toBeLessThanOrEqual(160);
  });

  it('dedupes evidence ids and caps at 20', async () => {
    const { pub } = setup();
    const ids = Array.from({ length: 30 }, (_, i) => `ev${i}`);
    const e = await pub.emit('diagnose', { summary: 's', evidenceIds: ['ev0', ...ids, 'ev1'] });
    expect(e.evidence_ids).toHaveLength(20);
    expect(new Set(e.evidence_ids).size).toBe(20);
  });
});

describe('redaction', () => {
  it('strips nvapi keys and bearer tokens and applies the injected redact fn', async () => {
    const { pub } = setup({ redact: (s) => s.split('SECRETVAL').join('***') });
    const e = await pub.emit('execute', {
      summary: 'key nvapi-AbC_123-xyz leaked, SECRETVAL',
      toolCalls: [{ tool: 'call', args_summary: 'Authorization: Bearer abc.DEF-123=', result_summary: 'ok nvapi-ZZZ' }],
    });
    expect(e.summary).not.toMatch(/nvapi-|SECRETVAL/);
    expect(e.tool_calls[0]?.args_summary).not.toContain('abc.DEF');
    expect(e.tool_calls[0]?.result_summary).not.toContain('nvapi-');
  });

  it('works with config redactString', async () => {
    const cfg = { NIM_API_KEY: 'topsecretkey' } as never;
    const { pub } = setup({ redact: (s) => redactString(s, cfg) });
    const e = await pub.emit('plan', { summary: 'uses topsecretkey here' });
    expect(e.summary).not.toContain('topsecretkey');
  });

  it('masks secret-named keys inside summarized args', () => {
    const t = summarizeToolCall('x', { api_key: 'abc', job: 'j1' }, null);
    expect(t.args_summary).toBe('{"api_key":"***","job":"j1"}');
  });
});

describe('chain-of-thought stripping', () => {
  it('drops reasoning/thought fields from args and results (nested)', () => {
    const t = summarizeToolCall(
      'get_incident_evidence',
      { incident_id: 'i1', reasoning: 'secret plan', nested: { chain_of_thought: 'hmm', keep: 1 } },
      { thought: 'private', items: [{ reasoning_content: 'x', id: 'a' }] },
    );
    const all = JSON.stringify(t);
    expect(all).not.toMatch(/reasoning|thought|secret plan|hmm|private/);
    expect(t.args_summary).toContain('"keep":1');
    expect(t.result_summary).toContain('"id":"a"');
  });
});

describe('failure buffering', () => {
  it('retries once, buffers on failure, flushes on next success in order', async () => {
    const { db, published, state } = flakyDb();
    const pub = createEventPublisher({ db, runId: 'r', clock, redact: identity });
    const a = await pub.emit('triage', { summary: 'a' });
    expect(a.summary).toBe('a'); // did not throw
    expect(state.attempts).toBe(2); // one retry
    expect(pub.pending()).toBe(1);
    await pub.emit('plan', { summary: 'b' });
    expect(pub.pending()).toBe(2);

    state.failing = false;
    await pub.emit('verify', { summary: 'c' });
    expect(pub.pending()).toBe(0);
    expect(published.map((e) => e.summary)).toEqual(['a', 'b', 'c']);
  });

  it('bounds the buffer at 200, dropping oldest', async () => {
    const { db } = flakyDb();
    const pub = createEventPublisher({ db, runId: 'r', clock, redact: identity });
    for (let i = 0; i < MAX_PENDING_EVENTS + 5; i++) await pub.emit('triage', { summary: String(i) });
    expect(pub.pending()).toBe(MAX_PENDING_EVENTS);
  });
});

describe('summarizeToolCall', () => {
  it('formats simulate_plan args and metrics', () => {
    const t = summarizeToolCall(
      'simulate_plan',
      { commands: [{ operation: 'checkpoint', job_id: 'job-a' }, { operation: 'migrate', job_id: 'job-a', dest_rack_id: 'r7' }] },
      { expected_lost_work_units: 0, expected_completion_delay_sim_s: 150, violations: [] },
    );
    expect(t.tool).toBe('simulate_plan');
    expect(t.args_summary).toBe('job-a: checkpoint→job-a: migrate r7');
    expect(t.result_summary).toBe('lost 0 wu · delay 150 s');
  });

  it('formats safety decisions and falls back to compact JSON', () => {
    expect(summarizeToolCall('check_safety', {}, { allowed: true }).result_summary).toBe('allowed');
    expect(summarizeToolCall('check_safety', {}, { allowed: false, violations: ['DEST_GPU_BUSY'] }).result_summary).toBe('denied: DEST_GPU_BUSY');
    const t = summarizeToolCall('list', { a: 1, b: [2] }, 'done');
    expect(t.args_summary).toBe('{"a":1,"b":[2]}');
    expect(t.result_summary).toBe('done');
    expect(summarizeToolCall('n', undefined, undefined)).toMatchObject({ args_summary: '', result_summary: '' });
  });
});

describe('F-NV1 actor tags', () => {
  it('summarizeToolCall carries the optional actor', () => {
    expect(summarizeToolCall('x', {}, {}, 'nemotron').actor).toBe('nemotron');
    expect(summarizeToolCall('x', {}, {})).not.toHaveProperty('actor');
  });

  it('derives the event actor: nemotron if any call is nemotron, else code; explicit actor wins', async () => {
    const { pub } = setup();
    const call = (actor?: 'nemotron' | 'code') => ({ tool: 't', args_summary: '', result_summary: '', ...(actor ? { actor } : {}) });
    expect((await pub.emit('plan', { summary: 's', toolCalls: [call('code'), call('nemotron')] })).actor).toBe('nemotron');
    expect((await pub.emit('plan', { summary: 's', toolCalls: [call('code')] })).actor).toBe('code');
    expect((await pub.emit('plan', { summary: 's' })).actor).toBe('code');
    expect((await pub.emit('plan', { summary: 's', toolCalls: [call('nemotron')], actor: 'code' })).actor).toBe('code');
    const e = await pub.emit('plan', { summary: 's', toolCalls: [call('nemotron')] });
    expect(e.tool_calls[0]?.actor).toBe('nemotron');
  });
});
