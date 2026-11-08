// Pure helpers of the multi-agent live cases (L7/L8): no network, no clock.
import type { ActionDetail, AgentEventInput, WorkflowRecord } from '@dcos/db-client';
import { describe, expect, it } from 'vitest';
import {
  agentForOwner,
  bothActive,
  checkMessagesWellFormed,
  checkMoveAcknowledged,
  checkNoDuplicateIntents,
  checkOwnedByDifferentAgents,
  checkTakeoverAnnounced,
  checkWorkDistribution,
  checkZoneAffinity,
  messageTranscript,
  pickIsolatedGpu,
  racksOf,
  workerIdOf,
  workflowOwners,
  type AgentIdentity,
} from '../../scripts/live/multi.js';
import { buildAgentEnv } from '../../scripts/live/agent-process.js';
import { CASE_IDS, parseCases } from '../../scripts/live/args.js';
import { loadPumpDegradedSnapshot, RUN_ID } from '../fixtures/index.js';

const ALPHA: AgentIdentity = { name: 'agent-alpha', pid: 111, zone: 'loop-a' };
const BETA: AgentIdentity = { name: 'agent-beta', pid: 222, zone: 'loop-b' };

const wf = (id: string, owner: string | null, stage: WorkflowRecord['stage'] = 'execute', incident = `inc-${id}`): WorkflowRecord => ({
  workflow_id: id, run_id: RUN_ID, stage, state: {}, incident_ids: [incident], plan_id: null, current_command_key: null, last_processed_event_seq: 0, attempt: 1, lease_owner: owner, lease_expires_unix_ms: 0, fencing_token: 1n, updated_at_unix_ms: 0, version: 1,
});

const ev = (id: string, sim: number, calls: AgentEventInput['tool_calls'], workflow: string | null = 'wf-1'): AgentEventInput => ({
  agent_event_id: id, run_id: RUN_ID, workflow_id: workflow, incident_id: null, stage: 'plan', summary: 's', evidence_ids: [], tool_calls: calls, sim_time_ms: sim, observed_unix_ms: sim,
});
const msg = (from: string, to: string, topic: string, text: string) => ({ tool: 'agent_message', args_summary: `from=${from} to=${to} topic=${topic}`, result_summary: text });

describe('agent identity', () => {
  it('maps lease owners `<name>-<pid>` back to the spawned agent by AGENT_NAME, never by pid (the harness only knows the tsx/node wrapper pid)', () => {
    expect(workerIdOf(ALPHA)).toBe('agent-alpha-111');
    expect(agentForOwner('agent-beta-222', [ALPHA, BETA])).toBe(BETA);
    // the live case: the agent's own pid (27560) differs from the wrapper pid the harness spawned (111)
    expect(agentForOwner('agent-alpha-27560', [ALPHA, BETA])).toBe(ALPHA);
    expect(agentForOwner('agent-beta-999', [ALPHA, BETA])).toBe(BETA);
    expect(agentForOwner('agent-host-5', [ALPHA, BETA])).toBeNull();
    expect(agentForOwner('agent-alphabet-5', [ALPHA, BETA])).toBeNull();
    expect(agentForOwner(null, [ALPHA, BETA])).toBeNull();
    expect(checkOwnedByDifferentAgents({ a: 'agent-alpha-27560', b: 'agent-beta-23036' }, 'a', 'b', [ALPHA, BETA]).ok).toBe(true);
  });

  it('buildAgentEnv sets AGENT_NAME/AGENT_ZONE per child and never inherits them from the harness env', () => {
    const base = { AGENT_NAME: 'stray', AGENT_ZONE: 'loop-b', NIM_MODEL: 'm' };
    const named = buildAgentEnv({ base, uri: 'wss://x', db: 'dcos-dev', agentToken: 't', noLlm: false, name: 'agent-alpha', zone: 'loop-a' });
    expect(named.AGENT_NAME).toBe('agent-alpha');
    expect(named.AGENT_ZONE).toBe('loop-a');
    const plain = buildAgentEnv({ base, uri: 'wss://x', db: 'dcos-dev', agentToken: 't', noLlm: false });
    expect(plain.AGENT_NAME).toBeUndefined();
    expect(plain.AGENT_ZONE).toBeUndefined();
    expect(plain.NIM_MODEL).toBe('m');
  });

  it('L7 and L8 are selectable cases and part of `all`', () => {
    expect(CASE_IDS).toContain('L7');
    expect(CASE_IDS).toContain('L8');
    expect(parseCases('l7,L8')).toEqual(['L7', 'L8']);
    expect(parseCases('all')).toEqual([...CASE_IDS]);
  });
});

describe('pickIsolatedGpu (from observed state only)', () => {
  const snap = loadPumpDegradedSnapshot();

  it('picks the lowest ready, idle demo GPU on a rack with no jobs, outside the excluded racks', () => {
    // jobs run on r2, r3 (job-a), r4 (job-b), r6 (job-c); r1, r5, r7, r8 are free
    expect(pickIsolatedGpu(snap, { excludeRacks: ['rack-r2', 'rack-r3', 'rack-r4'] })).toBe('gpu-r1-n1-0');
    expect(pickIsolatedGpu(snap, { excludeRacks: ['rack-r1', 'rack-r5'], excludeGpus: ['gpu-r7-n1-0'] })).toBe('gpu-r7-n1-1');
    expect(pickIsolatedGpu(snap, { excludeRacks: ['rack-r1', 'rack-r5', 'rack-r7', 'rack-r8'] })).toBeNull();
  });

  it('never picks a GPU with an XID, a non-ready GPU, the real-GPU twin or an allocated GPU', () => {
    const s = loadPumpDegradedSnapshot();
    for (const g of s.gpus) if (g.resource_id.startsWith('gpu-r1-')) g.last_xid_code = 79;
    for (const g of s.gpus) if (g.resource_id.startsWith('gpu-r5-')) g.availability = 'cordoned';
    for (const g of s.gpus) if (g.resource_id.startsWith('gpu-r7-')) g.availability = 'unreachable';
    const pick = pickIsolatedGpu(s, { excludeRacks: ['rack-r2', 'rack-r3', 'rack-r4'] });
    expect(pick).toBe('gpu-r8-n1-0');
    for (const g of s.gpus) if (g.resource_id.startsWith('gpu-r8-')) g.availability = 'degraded';
    expect(pickIsolatedGpu(s, { excludeRacks: ['rack-r2', 'rack-r3', 'rack-r4'] })).toBeNull(); // gpu-real-0 is never chosen
  });

  it('racksOf', () => {
    expect(racksOf(['gpu-r8-n1-3', 'gpu-r7-n1-0', 'gpu-r8-n1-1', 'gpu-real-0'])).toEqual(['rack-r7', 'rack-r8']);
  });
});

describe('ownership checks', () => {
  it('owners map, overlap and different-agent ownership', () => {
    const wfs = [wf('wf-pump', 'agent-alpha-111'), wf('wf-xid', 'agent-beta-222'), wf('wf-old', 'agent-alpha-111', 'done')];
    expect(workflowOwners(wfs)).toEqual({ 'wf-pump': 'agent-alpha-111', 'wf-xid': 'agent-beta-222', 'wf-old': 'agent-alpha-111' });
    expect(bothActive(wfs, 'wf-pump', 'wf-xid')).toBe(true);
    expect(bothActive(wfs, 'wf-pump', 'wf-old')).toBe(false);
    expect(bothActive(wfs, 'wf-pump', 'wf-missing')).toBe(false);
    const ok = checkOwnedByDifferentAgents(workflowOwners(wfs), 'wf-pump', 'wf-xid', [ALPHA, BETA]);
    expect(ok.ok).toBe(true);
    expect(ok.detail).toBe('wf-pump -> agent-alpha, wf-xid -> agent-beta');
    const same = checkOwnedByDifferentAgents({ a: 'agent-alpha-111', b: 'agent-alpha-111' }, 'a', 'b', [ALPHA, BETA]);
    expect(same.ok).toBe(false);
    expect(checkOwnedByDifferentAgents({ a: 'agent-alpha-111', b: 'who-9' }, 'a', 'b', [ALPHA, BETA]).ok).toBe(false);
  });

  it('work distribution is informational (always ok) and says SPLIT or single agent', () => {
    expect(checkWorkDistribution({ a: 'agent-alpha-111', b: 'agent-beta-222' }, [ALPHA, BETA])).toMatchObject({ ok: true, detail: expect.stringMatching(/^SPLIT: /) });
    expect(checkWorkDistribution({ a: 'agent-alpha-111', b: 'agent-alpha-111' }, [ALPHA, BETA])).toMatchObject({ ok: true, detail: expect.stringMatching(/^single agent: /) });
  });

  it('zone affinity: each incident\'s workflow is owned by the agent of the incident\'s zone (derived from the snapshot)', () => {
    const snap = loadPumpDegradedSnapshot();
    const links = [
      { schema_version: '1.1.0' as const, run_id: RUN_ID, incident_id: 'inc-pump', link_kind: 'resource' as const, linked_id: 'pump-a', reason: 'r' },
      { schema_version: '1.1.0' as const, run_id: RUN_ID, incident_id: 'inc-xid', link_kind: 'resource' as const, linked_id: 'gpu-r7-n1-3', reason: 'r' },
    ];
    const good = checkZoneAffinity([wf('wf-pump', 'agent-alpha-111', 'execute', 'inc-pump'), wf('wf-xid', 'agent-beta-222', 'plan', 'inc-xid')], links, snap, [ALPHA, BETA]);
    expect(good.ok).toBe(true);
    const bad = checkZoneAffinity([wf('wf-pump', 'agent-beta-222', 'execute', 'inc-pump')], links, snap, [ALPHA, BETA]);
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('expected=agent-alpha');
    // unknown zone or unknown owner: not a violation
    expect(checkZoneAffinity([wf('wf-x', 'agent-beta-222', 'execute', 'inc-none')], links, snap, [ALPHA, BETA]).ok).toBe(true);
  });
});

describe('ledger: no duplicate intent across agents', () => {
  const row = (key: string, status: ActionDetail['status']['status']): ActionDetail =>
    ({ command: { command_key: key, operation: key.split(':')[1], job_id: key.split(':')[2] }, status: { status } }) as unknown as ActionDetail;

  it('passes when every live intent has one row (cancelled/failed rows of a replan do not count)', () => {
    const c = checkNoDuplicateIntents([row('wf-a:checkpoint:job-a:1', 'succeeded'), row('wf-a:migrate_restart:job-a:1', 'cancelled'), row('wf-a:migrate_restart:job-a:2', 'running'), row('wf-b:power_cap:job-c:1', 'succeeded')]);
    expect(c.ok).toBe(true);
  });

  it('fails when two workflows submitted the same intent', () => {
    const c = checkNoDuplicateIntents([row('wf-a:checkpoint:job-a:1', 'succeeded'), row('wf-b:checkpoint:job-a:1', 'running')]);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('checkpoint:job-a: wf-a:checkpoint:job-a:1 + wf-b:checkpoint:job-a:1');
  });
});

describe('message transcript checks', () => {
  const events = [
    ev('e1', 1000, [msg('agent-alpha', 'all', 'cross_zone_move', 'move job=job-a dest_racks=rack-r7,rack-r8 gpus=16 checkpoint=planned')]),
    ev('e2', 1500, [msg('agent-beta', 'agent-alpha', 'ack', 'ack (zone loop-b): no open incidents or planned moves on rack-r7,rack-r8')]),
    ev('e3', 2000, [{ tool: 'get_action_status', args_summary: 'k', result_summary: 'running' }]),
    ev('e4', 9000, [msg('agent-beta', 'all', 'takeover', 'agent-alpha-111 lease expired on wf-1; agent-beta taking over (token 9)')]),
  ];

  it('extracts the transcript in sim order and validates from/to/topic', () => {
    const t = messageTranscript([events[3]!, events[0]!, events[1]!, events[2]!]);
    expect(t.map((m) => m.topic)).toEqual(['cross_zone_move', 'ack', 'takeover']);
    expect(checkMessagesWellFormed(events).ok).toBe(true);
    const broken = [...events, ev('e5', 9500, [{ tool: 'agent_message', args_summary: 'from=x topic=ack', result_summary: 'bad' }])];
    const c = checkMessagesWellFormed(broken);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('3/4 messages parse');
  });

  it('cross_zone_move must be answered by ANOTHER agent with ack or conflict', () => {
    expect(checkMoveAcknowledged(messageTranscript(events)).ok).toBe(true);
    expect(checkMoveAcknowledged(messageTranscript([events[0]!])).ok).toBe(false);
    const selfReply = [events[0]!, ev('x', 1200, [msg('agent-alpha', 'agent-alpha', 'ack', 'ack')])];
    expect(checkMoveAcknowledged(messageTranscript(selfReply)).ok).toBe(false);
    const conflict = [events[0]!, ev('x', 1200, [msg('agent-beta', 'agent-alpha', 'conflict', 'conflict: wf-x already plans a move onto rack-r8; ledger/safety decide')])];
    expect(checkMoveAcknowledged(messageTranscript(conflict)).ok).toBe(true);
  });

  it('takeover message names the dead worker and the workflow, from the survivor', () => {
    const t = messageTranscript(events);
    expect(checkTakeoverAnnounced(t, 'wf-1', 'agent-alpha-111', 'agent-beta').ok).toBe(true);
    expect(checkTakeoverAnnounced(t, 'wf-1', 'agent-gamma-5', 'agent-beta').ok).toBe(false);
    expect(checkTakeoverAnnounced(t, 'wf-1', 'agent-alpha-111', 'agent-alpha').ok).toBe(false);
    expect(checkTakeoverAnnounced(t, 'wf-2', 'agent-alpha-111', 'agent-beta').ok).toBe(false);
  });
});
