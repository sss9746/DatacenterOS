import { describe, expect, it } from 'vitest';
import {
  AGENT_MESSAGE_TOOL,
  agentNameOfWorker,
  clipMessage,
  createMessenger,
  formatMessageArgs,
  formatMove,
  isAddressedTo,
  messagesIn,
  parseMessageArgs,
  parseMove,
  respondToMove,
  type OwnFacts,
} from '../src/agent-messages.js';
import { createEventPublisher } from '../src/events.js';
import type { AgentEventInput } from '../src/ports.js';
import { FakeDb } from './fakes/index.js';
import { loadPumpDegradedSnapshot, RUN_ID } from './fixtures/index.js';

const ev = (over: Partial<AgentEventInput>): AgentEventInput => ({
  agent_event_id: 'ev-1',
  run_id: RUN_ID,
  workflow_id: 'wf-1',
  incident_id: 'inc-1',
  stage: 'plan',
  summary: 's',
  evidence_ids: [],
  tool_calls: [],
  sim_time_ms: 1000,
  observed_unix_ms: 0,
  ...over,
});

describe('agent message wire format', () => {
  it('round-trips from/to/topic and rejects unknown topics or shapes', () => {
    expect(parseMessageArgs(formatMessageArgs('agent-alpha', 'all', 'takeover'))).toEqual({ from: 'agent-alpha', to: 'all', topic: 'takeover' });
    expect(parseMessageArgs('from=a to=b topic=nope')).toBeNull();
    expect(parseMessageArgs('hello')).toBeNull();
  });

  it('extracts messages from an event and ignores other tool calls', () => {
    const e = ev({
      tool_calls: [
        { tool: 'get_action_status', args_summary: 'k', result_summary: 'running' },
        { tool: AGENT_MESSAGE_TOOL, args_summary: 'from=agent-alpha to=agent-beta topic=ack', result_summary: 'ack: fine', actor: 'code' },
      ],
    });
    const [m] = messagesIn(e);
    expect(messagesIn(e)).toHaveLength(1);
    expect(m).toMatchObject({ from: 'agent-alpha', to: 'agent-beta', topic: 'ack', text: 'ack: fine', workflow_id: 'wf-1', event_id: 'ev-1', actor: 'code' });
  });

  it('addressing: direct or broadcast, never from itself', () => {
    expect(isAddressedTo({ from: 'a', to: 'b' }, 'b')).toBe(true);
    expect(isAddressedTo({ from: 'a', to: 'all' }, 'b')).toBe(true);
    expect(isAddressedTo({ from: 'b', to: 'all' }, 'b')).toBe(false);
    expect(isAddressedTo({ from: 'a', to: 'c' }, 'b')).toBe(false);
    expect(agentNameOfWorker('agent-alpha-4242')).toBe('agent-alpha');
    expect(agentNameOfWorker('agent-host-1-99')).toBe('agent-host-1');
  });

  it('clips bodies to 200 chars and flattens whitespace', () => {
    expect(clipMessage('a   b\n c')).toBe('a b c');
    expect(clipMessage('x'.repeat(300))).toHaveLength(200);
  });

  it('move announcements round-trip', () => {
    const text = formatMove({ job_id: 'job-a', dest_racks: ['rack-r7', 'rack-r8'], gpu_count: 16, checkpoint: 'planned' });
    expect(text).toBe('move job=job-a dest_racks=rack-r7,rack-r8 gpus=16 checkpoint=planned');
    expect(parseMove(text)).toEqual({ job_id: 'job-a', dest_racks: ['rack-r7', 'rack-r8'], gpu_count: 16, checkpoint: 'planned' });
    expect(parseMove('ack: ok')).toBeNull();
  });
});

describe('respondToMove (receiver answers from its own real state)', () => {
  const move = { job_id: 'job-a', dest_racks: ['rack-r7', 'rack-r8'], gpu_count: 16, checkpoint: 'running' };
  const own = (workflows: OwnFacts['workflows']): OwnFacts => ({ agentName: 'agent-beta', zone: 'loop-b', workflows });

  it('conflict when the announced racks overlap a destination this agent planned or has in flight', () => {
    const r = respondToMove(move, own([{ workflow_id: 'wf-x', incident_ids: ['inc-x'], incident_racks: ['rack-r6'], planned_dest_racks: ['rack-r8', 'rack-r5'], in_flight: ['wf-x:checkpoint:job-c:1'] }]));
    expect(r.topic).toBe('conflict');
    expect(r.text).toContain('wf-x');
    expect(r.text).toContain('rack-r8');
    expect(r.text).toContain('1 action(s) in flight');
    expect(r.text).toContain('ledger/safety decide');
  });

  it('ack with a warning about an open incident on the destination racks', () => {
    const r = respondToMove(move, own([{ workflow_id: 'wf-xid', incident_ids: ['inc-xid-r7'], incident_racks: ['rack-r7'], planned_dest_racks: [], in_flight: [] }]));
    expect(r.topic).toBe('ack');
    expect(r.text).toBe('ack (zone loop-b): open incident inc-xid-r7 on rack-r7; avoid it');
  });

  it('plain ack when nothing of its own touches those racks', () => {
    const r = respondToMove(move, own([{ workflow_id: 'wf-y', incident_ids: ['inc-y'], incident_racks: ['rack-r1'], planned_dest_racks: ['rack-r5'], in_flight: [] }]));
    expect(r).toEqual({ topic: 'ack', text: 'ack (zone loop-b): no open incidents or planned moves on rack-r7,rack-r8' });
    expect(respondToMove(move, { agentName: 'b', zone: null, workflows: [] }).text).toBe('ack: no open incidents or planned moves on rack-r7,rack-r8');
  });
});

describe('createMessenger over FakeDb agent events', () => {
  function pair() {
    let wall = 1_000_000;
    const db = new FakeDb({ snapshot: loadPumpDegradedSnapshot() });
    const clock = { unixMs: () => wall, simTimeMs: () => 540_000 };
    const mk = (name: string, seq: number) => {
      const events = createEventPublisher({ db, runId: RUN_ID, clock, redact: (s) => s, startSeq: seq });
      return createMessenger({ db, events, runId: RUN_ID, agentName: name, now: () => wall });
    };
    return { db, alpha: mk('agent-alpha', 1), beta: mk('agent-beta', 1000), advance: (ms: number) => (wall += ms) };
  }

  it('delivers to the addressee and to broadcast, not back to the sender; transcripts on both sides', async () => {
    const { alpha, beta } = pair();
    const got: string[] = [];
    beta.subscribe((m) => void got.push(`${m.from}>${m.to}:${m.topic}:${m.text}`));
    const seenByAlpha: string[] = [];
    alpha.subscribe((m) => void seenByAlpha.push(m.topic));
    expect(beta.supported).toBe(true);
    await alpha.send({ topic: 'takeover', to: 'all', text: 'agent-gamma lease expired on wf-1; agent-alpha taking over (token 7)', stage: 'execute', workflowId: 'wf-1' });
    await alpha.send({ topic: 'stand_by', to: 'agent-beta', text: 'x owns wf-2 now (token 3); agent-alpha standing by', stage: 'execute', workflowId: 'wf-2' });
    await alpha.send({ topic: 'ack', to: 'agent-gamma', text: 'ack: not for beta', stage: 'plan', workflowId: 'wf-3' });
    expect(got).toEqual([
      'agent-alpha>all:takeover:agent-gamma lease expired on wf-1; agent-alpha taking over (token 7)',
      'agent-alpha>agent-beta:stand_by:x owns wf-2 now (token 3); agent-alpha standing by',
    ]);
    expect(seenByAlpha).toEqual([]); // never receives its own messages
    expect(alpha.transcript().map((m) => m.topic)).toEqual(['takeover', 'stand_by', 'ack']);
    expect(beta.transcript().map((m) => m.topic)).toEqual(['takeover', 'stand_by']);
  });

  it('rate-limits one message per topic per workflow per 5 s and drops exact repeats forever', async () => {
    const { alpha, db, advance } = pair();
    expect(await alpha.send({ topic: 'incident_update', to: 'all', text: 'wf-1 recovered', stage: 'verify', workflowId: 'wf-1' })).not.toBeNull();
    expect(await alpha.send({ topic: 'incident_update', to: 'all', text: 'wf-1 recovered', stage: 'verify', workflowId: 'wf-1' })).toBeNull(); // duplicate
    expect(await alpha.send({ topic: 'incident_update', to: 'all', text: 'wf-1 still recovering', stage: 'verify', workflowId: 'wf-1' })).toBeNull(); // rate-limited
    expect(await alpha.send({ topic: 'incident_update', to: 'all', text: 'wf-2 recovered', stage: 'verify', workflowId: 'wf-2' })).not.toBeNull(); // other workflow
    expect(await alpha.send({ topic: 'takeover', to: 'all', text: 'wf-1 taken', stage: 'execute', workflowId: 'wf-1' })).not.toBeNull(); // other topic
    advance(5_001);
    expect(await alpha.send({ topic: 'incident_update', to: 'all', text: 'wf-1 still recovering', stage: 'verify', workflowId: 'wf-1' })).not.toBeNull();
    expect(await alpha.send({ topic: 'incident_update', to: 'all', text: 'wf-1 recovered', stage: 'verify', workflowId: 'wf-1' })).toBeNull(); // still a repeat
    const sent = db.agentEvents.filter((e) => e.tool_calls.some((t) => t.tool === AGENT_MESSAGE_TOOL));
    expect(sent).toHaveLength(4);
    expect(sent.every((e) => e.actor === 'code' && e.tool_calls[0]!.args_summary.startsWith('from=agent-alpha to=all topic='))).toBe(true);
  });

  it('ignores stale history on subscribe and events of other runs; handler errors never propagate', async () => {
    const { alpha, beta, advance } = pair();
    await alpha.send({ topic: 'takeover', to: 'all', text: 'old news', stage: 'execute', workflowId: 'wf-old' });
    advance(120_000);
    const got: string[] = [];
    beta.subscribe(() => {
      got.push('x');
      throw new Error('handler boom');
    });
    await alpha.send({ topic: 'takeover', to: 'all', text: 'fresh', stage: 'execute', workflowId: 'wf-new' });
    expect(got).toEqual(['x']);
    expect(beta.transcript().map((m) => m.text)).toEqual(['fresh']);
  });
});
