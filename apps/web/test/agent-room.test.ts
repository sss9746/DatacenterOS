import { describe, expect, it } from 'vitest';
import type { AgentEventInput, ToolCallSummary, WorkflowRecord } from '@dcos/db-client';
import type { Incident } from '@dcos/contracts';
import { seatOf } from '../src/components/agent-room/seat-of';
import { boundSummary, buildRoomView, dividerText, parseAgentMessage, processLabel, processName, processOfEvent, resumeAnchorIndex, resumeDividerText, zoneOfWorker, AGENTS_THREAD_ID, type Bubble, type Divider } from '../src/components/agent-room/room-view';

const call = (tool: string, actor: ToolCallSummary['actor'] = 'code'): ToolCallSummary => ({ tool, args_summary: 'a', result_summary: 'r', actor });
let seq = 0;
const ev = (patch: Partial<AgentEventInput>): AgentEventInput => ({
  agent_event_id: `e${seq++}`, run_id: 'run', workflow_id: 'wf-1', incident_id: null, stage: 'plan', summary: 'did a thing', evidence_ids: [], tool_calls: [],
  actor: 'code', sim_time_ms: 1000 + seq * 10, observed_unix_ms: 1_700_000_000_000 + seq * 1000, ...patch,
});
const wf = (patch: Partial<WorkflowRecord> = {}): WorkflowRecord => ({
  workflow_id: 'wf-1', run_id: 'run', stage: 'execute', state: {}, incident_ids: ['inc-1'], plan_id: null, current_command_key: null, last_processed_event_seq: 0,
  attempt: 1, lease_owner: 'w-1', lease_expires_unix_ms: 0, fencing_token: 1n, updated_at_unix_ms: 0, version: 1, ...patch,
});
const incident = (id: string, title: string): Incident => ({
  schema_version: '1.1.0', run_id: 'run', incident_id: id, state: 'investigating', severity: 'high', title, hypothesis: null, confidence: 0.5, opened_sim_time_ms: 0, updated_sim_time_ms: 0, version: 1,
});

describe('seatOf', () => {
  it('maps Nemotron by stage first', () => {
    expect(seatOf(ev({ actor: 'nemotron', stage: 'triage' }))).toBe('triage');
    expect(seatOf(ev({ actor: 'nemotron', stage: 'diagnose', tool_calls: [call('propose_plan')] }))).toBe('triage');
    expect(seatOf(ev({ actor: 'nemotron', stage: 'plan', tool_calls: [call('simulate_plan')] }))).toBe('planner');
    expect(seatOf(ev({ actor: 'nemotron', stage: 'replan' }))).toBe('planner');
  });
  it('maps other Nemotron stages by tool, else unattributed', () => {
    expect(seatOf(ev({ actor: 'nemotron', stage: 'execute', tool_calls: [call('list_placement_candidates')] }))).toBe('planner');
    expect(seatOf(ev({ actor: 'nemotron', stage: 'verify', tool_calls: [call('upsert_incident')] }))).toBe('triage');
    expect(seatOf(ev({ actor: 'nemotron', stage: 'verify' }))).toBe('unattributed');
  });
  it('maps code by tool names before stage', () => {
    expect(seatOf(ev({ actor: 'code', stage: 'plan', tool_calls: [call('simulate_plan'), call('evaluate_safety')] }))).toBe('simulator');
    expect(seatOf(ev({ actor: 'code', stage: 'execute', tool_calls: [call('get_job_state')] }))).toBe('simulator');
    expect(seatOf(ev({ actor: 'code', stage: 'plan', tool_calls: [call('evaluate_safety')] }))).toBe('safety');
    expect(seatOf(ev({ actor: 'code', stage: 'execute', summary: 'BLOCKED by safety' }))).toBe('safety');
    expect(seatOf(ev({ actor: 'code', stage: 'verify', tool_calls: [call('get_action_status')] }))).toBe('coordinator');
    expect(seatOf(ev({ actor: 'code', stage: 'execute' }))).toBe('coordinator');
    expect(seatOf(ev({ actor: 'code', stage: 'plan', tool_calls: [call('verify_action')] }))).toBe('verifier');
    expect(seatOf(ev({ actor: 'code', stage: 'verify' }))).toBe('verifier');
    expect(seatOf(ev({ actor: 'code', stage: 'safety' }))).toBe('safety');
    expect(seatOf(ev({ actor: 'code', stage: 'replan' }))).toBe('simulator');
    expect(seatOf(ev({ actor: 'code', stage: 'triage' }))).toBe('coordinator');
    expect(seatOf(ev({ actor: 'code', stage: 'execute', summary: 'Example: resumed after agent restart: nothing left' }))).toBe('coordinator');
  });
  it('never guesses a seat for an event without a persisted actor', () => {
    expect(seatOf(ev({ actor: undefined, stage: 'plan', tool_calls: [call('propose_plan', 'nemotron')] }))).toBe('unattributed');
    expect(seatOf(ev({ actor: undefined, stage: 'triage' }))).toBe('unattributed');
    expect(seatOf(ev({ actor: undefined, stage: 'execute', tool_calls: [call('start_action')] }))).toBe('unattributed');
  });
});

describe('boundSummary', () => {
  it('lifts the Example prefix into a flag and clamps long text', () => {
    expect(boundSummary('Example: hello')).toEqual({ text: 'hello', example: true });
    const long = boundSummary('x'.repeat(400));
    expect(long.example).toBe(false);
    expect(long.text.length).toBe(240);
    expect(long.text.endsWith('…')).toBe(true);
  });
});

describe('buildRoomView', () => {
  const now = 1_700_000_100_000;
  it('groups events into one thread per workflow named after its incident, run-level events in a Run thread', () => {
    const events = [
      ev({ workflow_id: null, stage: 'triage', actor: 'code', summary: '1 incident' }),
      ev({ workflow_id: 'wf-1', stage: 'diagnose', actor: 'nemotron' }),
      ev({ workflow_id: 'wf-2', stage: 'diagnose', actor: 'nemotron' }),
      ev({ workflow_id: 'wf-1', stage: 'plan', actor: 'nemotron' }),
    ];
    const view = buildRoomView({ events, workflows: [wf(), wf({ workflow_id: 'wf-2', incident_ids: ['inc-2'] })], incidents: [incident('inc-1', 'Cooling degradation on loop A'), incident('inc-2', 'GPU fault on r7')], nowUnixMs: now, example: false });
    expect(view.threads.map((t) => t.id)).toEqual(['run', 'wf-1', 'wf-2']);
    expect(view.threads.map((t) => t.title)).toEqual(['Run', 'Cooling degradation on loop A', 'GPU fault on r7']);
    expect(view.threads.map((t) => t.accent)).toEqual(['run', 'a', 'b']);
    expect(view.threads[1]!.items).toHaveLength(2);
  });
  it('falls back to the workflow id when no incident title is known', () => {
    const view = buildRoomView({ events: [ev({ workflow_id: 'wf-9' })], workflows: [], incidents: [], nowUnixMs: now, example: false });
    expect(view.threads[0]!.title).toBe('wf-9');
  });
  it('draws a handoff arrow only when the next bubble in the same thread sits at a different seat', () => {
    const events = [
      ev({ stage: 'diagnose', actor: 'nemotron' }),
      ev({ stage: 'plan', actor: 'nemotron' }),
      ev({ stage: 'plan', actor: 'code', tool_calls: [call('simulate_plan')] }),
      ev({ stage: 'safety', actor: 'code', tool_calls: [call('evaluate_safety')] }),
      ev({ stage: 'execute', actor: 'code', tool_calls: [call('start_action')] }),
      ev({ stage: 'execute', actor: 'code', tool_calls: [call('get_action_status')] }),
    ];
    const [thread] = buildRoomView({ events, workflows: [wf()], incidents: [], nowUnixMs: now, example: false }).threads;
    const bubbles = thread!.items.filter((i): i is Bubble => i.kind === 'bubble');
    expect(bubbles.map((b) => b.seat)).toEqual(['triage', 'planner', 'simulator', 'safety', 'coordinator', 'coordinator']);
    expect(bubbles.map((b) => b.handoffTo)).toEqual(['planner', 'simulator', 'safety', 'coordinator', null, null]);
  });
  it('inserts the resume divider before the first event at/after the persisted marker time', () => {
    const events = [
      ev({ stage: 'execute', actor: 'code', sim_time_ms: 100, tool_calls: [call('start_action')] }),
      ev({ stage: 'execute', actor: 'code', sim_time_ms: 200, summary: 'resumed after agent restart: skipped', tool_calls: [call('get_action_status')] }),
      ev({ stage: 'verify', actor: 'code', sim_time_ms: 300, tool_calls: [call('verify_action')] }),
    ];
    const state = { resumed: { by_worker: 'w-2', at_sim_time_ms: 200, action: 'resumed_verify', previous_owner: 'w-1' }, resume_count: 1 };
    const [thread] = buildRoomView({ events, workflows: [wf({ stage: 'done', state })], incidents: [], nowUnixMs: now, example: false }).threads;
    expect(thread!.items.map((i) => i.kind)).toEqual(['bubble', 'divider', 'bubble', 'bubble']);
    expect((thread!.items[1] as Divider).text).toBe('Agent process stopped → new process resumed by w-2 (#1), reconciling…');
  });
  it('anchors the divider on the resume event even when the previous event shares the marker time', () => {
    const events = [
      ev({ stage: 'execute', actor: 'code', sim_time_ms: 200, summary: 'cordon succeeded', tool_calls: [call('get_action_status')] }),
      ev({ stage: 'execute', actor: 'code', sim_time_ms: 200, summary: 'resumed after agent restart: skipped', tool_calls: [call('get_action_status')] }),
      ev({ stage: 'verify', actor: 'code', sim_time_ms: 300, tool_calls: [call('verify_action')] }),
    ];
    const state = { resumed: { by_worker: 'w-2', at_sim_time_ms: 200, action: 'resumed_verify', previous_owner: null }, resume_count: 2 };
    const [thread] = buildRoomView({ events, workflows: [wf({ stage: 'done', state })], incidents: [], nowUnixMs: now, example: false }).threads;
    expect(thread!.items.map((i) => i.kind)).toEqual(['bubble', 'divider', 'bubble', 'bubble']);
    expect((thread!.items[1] as Divider).text).toContain('w-2 (#2)');
    expect(resumeAnchorIndex(events, 'missing', 999)).toBe(3);
    expect(resumeAnchorIndex(events, events[2]!.agent_event_id, 0)).toBe(2);
  });
  it('words the divider honestly when the worker or count is not recorded', () => {
    expect(resumeDividerText({ by_worker: null, count: null })).toBe('Agent process stopped → new process resumed by a new worker, reconciling…');
    expect(resumeDividerText({ by_worker: 'w-3', count: null })).toBe('Agent process stopped → new process resumed by w-3, reconciling…');
  });
  it('marks a quiet open thread as silent, but never in example mode or when closed', () => {
    const events = [ev({ observed_unix_ms: now - 30_000 })];
    expect(buildRoomView({ events, workflows: [wf()], incidents: [], nowUnixMs: now, example: false }).threads[0]!.silentForS).toBe(30);
    expect(buildRoomView({ events, workflows: [wf()], incidents: [], nowUnixMs: now, example: true }).threads[0]!.silentForS).toBeNull();
    expect(buildRoomView({ events, workflows: [wf({ stage: 'done' })], incidents: [], nowUnixMs: now, example: false }).threads[0]!.silentForS).toBeNull();
  });
  it('derives seat states: thinking for the fresh newest seat of an open thread, done for seats that spoke, idle otherwise', () => {
    const events = [ev({ stage: 'diagnose', actor: 'nemotron', observed_unix_ms: now - 60_000 }), ev({ stage: 'plan', actor: 'nemotron', observed_unix_ms: now - 2_000 })];
    const live = buildRoomView({ events, workflows: [wf()], incidents: [], nowUnixMs: now, example: false }).seatStates;
    expect(live.planner).toBe('thinking');
    expect(live.triage).toBe('done');
    expect(live.verifier).toBe('idle');
    const stale = buildRoomView({ events, workflows: [wf()], incidents: [], nowUnixMs: now + 60_000, example: false }).seatStates;
    expect(stale.planner).toBe('done');
    const frozen = buildRoomView({ events, workflows: [wf()], incidents: [], nowUnixMs: now + 60_000, example: true }).seatStates;
    expect(frozen.planner).toBe('thinking');
  });
});

describe('agent processes', () => {
  const now = 1_700_000_100_000;
  it('processName strips one trailing pid segment and is null for empty ids', () => {
    expect(processName('agent-alpha-12345')).toBe('agent-alpha');
    expect(processName('agent-host-1-99')).toBe('agent-host-1');
    expect(processName('example-agent-2')).toBe('example-agent');
    expect(processName(null)).toBeNull();
    expect(processName(undefined)).toBeNull();
    expect(processName('')).toBeNull();
  });
  it('attributes events to previous_owner before the resume marker and by_worker at/after; lease_owner without a marker; never guesses', () => {
    const marker = { previous_owner: 'agent-alpha-1', by_worker: 'agent-beta-2', at_sim_time_ms: 200 };
    expect(processOfEvent(100, marker, 'agent-beta-2')).toBe('agent-alpha');
    expect(processOfEvent(200, marker, 'agent-beta-2')).toBe('agent-beta');
    expect(processOfEvent(100, null, 'agent-gamma-7')).toBe('agent-gamma');
    expect(processOfEvent(100, { previous_owner: null, by_worker: 'agent-beta-2', at_sim_time_ms: 200 }, 'agent-beta-2')).toBeNull();
    expect(processOfEvent(100, null, null)).toBeNull();
  });
  it('threads carry the lease owner chip from lease_owner only, with a lapsed state for open workflows', () => {
    const events = [ev({ workflow_id: 'wf-1' })];
    const owned = buildRoomView({ events, workflows: [wf({ lease_owner: 'agent-alpha-12345', lease_expires_unix_ms: now + 60_000 })], incidents: [], nowUnixMs: now, example: false }).threads[0]!;
    expect(owned.owner).toBe('agent-alpha');
    expect(owned.leaseLapsed).toBe(false);
    const lapsed = buildRoomView({ events, workflows: [wf({ lease_owner: 'agent-alpha-12345', lease_expires_unix_ms: now - 1 })], incidents: [], nowUnixMs: now, example: false }).threads[0]!;
    expect(lapsed.leaseLapsed).toBe(true);
    const done = buildRoomView({ events, workflows: [wf({ stage: 'done', lease_owner: 'agent-alpha-12345', lease_expires_unix_ms: now - 1 })], incidents: [], nowUnixMs: now, example: false }).threads[0]!;
    expect(done.leaseLapsed).toBe(false);
    const unowned = buildRoomView({ events, workflows: [wf({ lease_owner: null })], incidents: [], nowUnixMs: now, example: false }).threads[0]!;
    expect(unowned.owner).toBeNull();
    expect((unowned.items[0] as Bubble).process).toBeNull();
  });
  it('bubbles carry the owning process split at the resume marker and the divider reads as a takeover when processes differ', () => {
    const events = [
      ev({ workflow_id: 'wf-1', sim_time_ms: 100, stage: 'execute', tool_calls: [call('start_action')] }),
      ev({ workflow_id: 'wf-1', sim_time_ms: 200, stage: 'execute', summary: 'resumed after agent restart: skipped', tool_calls: [call('get_action_status')] }),
    ];
    const state = { resumed: { by_worker: 'agent-beta-2', at_sim_time_ms: 200, action: 'resumed_verify', previous_owner: 'agent-alpha-1' }, resume_count: 1 };
    const view = buildRoomView({ events, workflows: [wf({ state, lease_owner: 'agent-beta-2', lease_expires_unix_ms: now + 1 })], incidents: [], nowUnixMs: now, example: false });
    const bubbles = view.threads[0]!.items.filter((i): i is Bubble => i.kind === 'bubble');
    expect(bubbles.map((b) => b.process)).toEqual(['agent-alpha', 'agent-beta']);
    expect((view.threads[0]!.items[1] as Divider).text).toBe('agent-alpha stopped → agent-beta took over (lease reclaimed, #1), reconciling…');
    expect(view.counts.processes).toBe(2);
  });
  it('keeps the plain resume wording when the same process restarted or the previous owner is unknown', () => {
    expect(dividerText({ previous_owner: 'agent-alpha-1', by_worker: 'agent-alpha-9', count: 2 })).toBe('Agent process stopped → new process resumed by agent-alpha-9 (#2), reconciling…');
    expect(dividerText({ previous_owner: null, by_worker: 'agent-beta-2', count: null })).toBe('Agent process stopped → new process resumed by agent-beta-2, reconciling…');
    expect(dividerText({ previous_owner: 'agent-alpha-1', by_worker: 'agent-beta-2', count: null })).toBe('agent-alpha stopped → agent-beta took over (lease reclaimed), reconciling…');
  });
});

describe('cross-agent messages and zones', () => {
  const now = 1_700_000_100_000;
  const msg = (args: string, result = 'hello'): ToolCallSummary => ({ tool: 'agent_message', args_summary: args, result_summary: result, actor: 'code' });
  it('parses from/to/topic tokens in any order and rejects malformed calls', () => {
    expect(parseAgentMessage(msg('topic=ack to=agent-beta-2 from=agent-alpha-1'))).toEqual({ from: 'agent-alpha-1', to: 'agent-beta-2', topic: 'ack', zone: null });
    expect(parseAgentMessage(msg('from=agent-alpha-1 to=all topic=takeover'))).toMatchObject({ to: 'all', topic: 'takeover' });
    expect(parseAgentMessage(msg('from=agent-alpha-1 to=agent-beta-2 topic=cross_zone_move zone="loop B"'))).toMatchObject({ topic: 'cross_zone_move', zone: 'loop B' });
    expect(parseAgentMessage(msg('from=agent-alpha-1 to=agent-beta-2 topic=gossip'))).toBeNull();
    expect(parseAgentMessage(msg('from=agent-alpha-1 topic=ack'))).toBeNull();
    expect(parseAgentMessage({ tool: 'get_action_status', args_summary: 'from=a to=b topic=ack', result_summary: '' })).toBeNull();
  });
  it('derives zones from worker ids or the message token, never otherwise', () => {
    expect(zoneOfWorker('agent-alpha@loopA')).toBe('loop A');
    expect(zoneOfWorker('agent-loop-b-7')).toBe('loop B');
    expect(zoneOfWorker('agent-alpha-12345')).toBeNull();
    expect(processName('agent-alpha-3@loopA')).toBe('agent-alpha');
    expect(processLabel('agent-alpha', 'loop A')).toBe('agent-alpha · loop A');
    expect(processLabel('agent-alpha', null)).toBe('agent-alpha');
    expect(processLabel(null, 'loop A')).toBeNull();
  });
  it('renders message bubbles in their own thread and in the shared Agents lane, with a takeover divider and resolved sender/receiver threads', () => {
    const events = [
      ev({ workflow_id: 'wf-1', sim_time_ms: 100, stage: 'plan', tool_calls: [msg('from=agent-alpha-1 to=agent-beta-2 topic=cross_zone_move zone="loop B"', 'ok to use r8?')] }),
      ev({ workflow_id: 'wf-2', sim_time_ms: 110, stage: 'plan', tool_calls: [msg('from=agent-beta-2 to=agent-alpha-1 topic=ack', 'yes')] }),
      ev({ workflow_id: 'wf-2', sim_time_ms: 120, stage: 'execute', tool_calls: [msg('from=agent-beta-2 to=all topic=takeover', 'took over wf-2')] }),
      ev({ workflow_id: 'wf-2', sim_time_ms: 130, stage: 'execute', tool_calls: [{ tool: 'agent_message', args_summary: 'garbage', result_summary: 'x' }] }),
    ];
    const wfs = [wf({ workflow_id: 'wf-1', lease_owner: 'agent-alpha-1', lease_expires_unix_ms: now + 1 }), wf({ workflow_id: 'wf-2', incident_ids: ['inc-2'], lease_owner: 'agent-beta-2', lease_expires_unix_ms: now + 1 })];
    const view = buildRoomView({ events, workflows: wfs, incidents: [], nowUnixMs: now, example: false });
    expect(view.threads.map((t) => t.id)).toEqual(['wf-1', 'wf-2', AGENTS_THREAD_ID]);
    const first = view.threads[0]!.items[0] as Bubble;
    expect(first.message).toMatchObject({ fromLabel: 'agent-alpha', toLabel: 'agent-beta', topic: 'cross_zone_move', text: 'ok to use r8?', fromThreadId: 'wf-1', toThreadId: 'wf-2' });
    expect(first.zone).toBe('loop B');
    const lane = view.threads[2]!;
    expect(lane.items.map((i) => i.kind)).toEqual(['bubble', 'bubble', 'divider', 'bubble']);
    expect((lane.items[2] as Divider).text).toBe('agent-beta → all · takeover');
    expect((lane.items[3] as Bubble).message?.toThreadId).toBeNull();
    const malformed = view.threads[1]!.items.filter((i): i is Bubble => i.kind === 'bubble').at(-1)!;
    expect(malformed.message).toBeNull();
    expect(view.counts.processes).toBe(2);
  });
});
