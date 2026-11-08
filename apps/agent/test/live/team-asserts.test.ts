import type { AgentEventInput, WorkflowRecord } from '@dcos/db-client';
import { describe, expect, it } from 'vitest';
import {
  buildProvenance,
  checkProvenanceReported,
  checkTeamRounds,
  newLlmLogStats,
  newTeamStore,
  parseTeamTrace,
  recordTeamRounds,
  tallyLlmLogLine,
  type ObservedRound,
  type TeamMessageView,
} from '../../scripts/live/asserts.js';

const answer: TeamMessageView = { id: 'm2', from: 'workload', to: 'cooling', kind: 'answer', summary: 'r7 is free', consumed_by: ['lead'] };

function trace(over: Record<string, unknown> = {}) {
  return { version: 1, round_id: 'wf-1:a1:e1', snapshot_sim_ms: 612_000, model: 'nvidia/nemotron', calls_used: 4, wall_ms: 9_000, outcome: 'lead', messages: [answer], covers: [], missing_roles: [], ...over };
}
const round = (over: Record<string, unknown> = {}): ObservedRound => ({ workflow_id: 'wf-1', trace: parseTeamTrace(trace(over))! });
const named = (rounds: ObservedRound[], expectLead = true) => Object.fromEntries(checkTeamRounds(rounds, { expectLead }).map((c) => [c.name, c]));

const LEAD = 'team: Lead decided';
const ANSWER = 'team: specialist answer consumed by a role';
const CALLS = 'team: at most 6 model calls per round';
const COVERS = 'team: covers recorded with their roles';

describe('team assertions', () => {
  it('pass on a healthy Lead round', () => {
    const c = named([round()]);
    expect(Object.values(c).every((x) => x.ok)).toBe(true);
    expect(c[COVERS]!.detail).toBe('no cover occurred');
  });

  it('a fallback round fails the Lead check and says so', () => {
    const c = named([round({ outcome: 'deterministic', model: null, messages: [], missing_roles: ['lead'] })]);
    expect(c[LEAD]!.ok).toBe(false);
    expect(c[LEAD]!.detail).toMatch(/0\/1 round\(s\) decided by the Lead; FALLBACK to deterministic code in 1 round/);
    expect(c[LEAD]!.detail).toMatch(/missing roles: lead/);
    expect(c[LEAD]!.evidence).toMatchObject({ lead_rounds: 0, fallback_rounds: 1 });
  });

  it('a partial fallback passes "at least once" but is still reported', () => {
    const c = named([round(), round({ round_id: 'wf-1:a2:e2', outcome: 'deterministic', messages: [] })]);
    expect(c[LEAD]!.ok).toBe(true);
    expect(c[LEAD]!.detail).toMatch(/1\/2 round\(s\).*FALLBACK.*wf-1:a2:e2/);
  });

  it('an answer counts only if a role consumed it and a specialist wrote it', () => {
    expect(named([round({ messages: [{ ...answer, consumed_by: [] }] })])[ANSWER]!.ok).toBe(false);
    expect(named([round({ messages: [{ ...answer, from: 'lead' }] })])[ANSWER]!.ok).toBe(false);
    expect(named([round({ messages: [{ ...answer, from: 'supervisor' }] })])[ANSWER]!.ok).toBe(false);
    expect(named([round({ messages: [{ ...answer, kind: 'finding' }] })])[ANSWER]!.ok).toBe(false);
  });

  it('enforces the model-call budget on every round', () => {
    expect(named([round({ calls_used: 6 })])[CALLS]!.ok).toBe(true);
    const c = named([round(), round({ round_id: 'wf-1:a2:e2', calls_used: 7 })]);
    expect(c[CALLS]!.ok).toBe(false);
    expect(c[CALLS]!.detail).toMatch(/wf-1:a2:e2: 7 calls/);
  });

  it('records valid covers and rejects invalid or unrecorded ones', () => {
    const covers = [{ failed_role: 'cooling', covered_by: 'workload' }];
    expect(named([round({ covers })])[COVERS]).toMatchObject({ ok: true, detail: 'workload covered cooling' });
    expect(named([round({ covers: [{ failed_role: 'cooling', covered_by: 'cooling' }] })])[COVERS]!.ok).toBe(false);
    expect(named([round({ covers: [{ failed_role: 'cooling', covered_by: 'intern' }] })])[COVERS]!.ok).toBe(false);
    expect(named([round({ messages: [answer, { ...answer, id: 'm3', kind: 'cover' }] })])[COVERS]!.ok).toBe(false);
  });

  it('no rounds at all is a failure when a Lead was expected', () => {
    expect(checkTeamRounds([], { expectLead: true })).toEqual([expect.objectContaining({ name: 'team: round recorded', ok: false })]);
    expect(checkTeamRounds([], { expectLead: true, malformed: ['wf-9'] })[0]!.detail).toMatch(/malformed state.team on wf-9/);
  });

  it('without a model: fallback is the pass condition and a Lead claim is false', () => {
    const fallback = named([round({ outcome: 'deterministic', messages: [] })], false);
    expect(fallback['team: no Lead claim without a model']!.ok).toBe(true);
    expect(fallback[ANSWER]).toBeUndefined();
    expect(named([round()], false)['team: no Lead claim without a model']!.ok).toBe(false);
    expect(checkTeamRounds([], { expectLead: false })[0]!.ok).toBe(true);
  });
});

describe('parsing and accumulating persisted rounds', () => {
  const wf = (id: string, state: Record<string, unknown>) => ({ workflow_id: id, state }) as unknown as WorkflowRecord;

  it('rejects anything that is not the frozen shape', () => {
    expect(parseTeamTrace(trace())).not.toBeNull();
    expect(parseTeamTrace(null)).toBeNull();
    expect(parseTeamTrace(trace({ version: 2 }))).toBeNull();
    expect(parseTeamTrace(trace({ outcome: 'maybe' }))).toBeNull();
    expect(parseTeamTrace(trace({ messages: [{ id: 'm1' }] }))).toBeNull();
    expect(parseTeamTrace(trace({ covers: [{ failed_role: 'cooling' }] }))).toBeNull();
  });

  it('keeps an earlier Lead round after state.team moves on to a later fallback', () => {
    const store = newTeamStore();
    recordTeamRounds(store, [wf('wf-1', { team: trace() })]);
    recordTeamRounds(store, [wf('wf-1', { team: trace({ round_id: 'wf-1:a2:e2', outcome: 'deterministic' }) })]);
    const rounds = [...store.rounds.values()];
    expect(rounds.map((r) => r.trace.outcome)).toEqual(['lead', 'deterministic']);
    expect(checkTeamRounds(rounds, { expectLead: true })[0]!.ok).toBe(true);
  });

  it('a repeated read of the same round is not double counted; malformed traces are remembered', () => {
    const store = newTeamStore();
    recordTeamRounds(store, [wf('wf-1', { team: trace() }), wf('wf-2', {}), wf('wf-3', { team: { version: 1 } })]);
    recordTeamRounds(store, [wf('wf-1', { team: trace() })]);
    expect(store.rounds.size).toBe(1);
    expect([...store.malformed]).toEqual(['wf-3']);
  });

  const v2 = (over: Record<string, unknown> = {}) =>
    trace({
      version: 2,
      status: 'closed',
      phase: 'closed',
      started_unix_ms: 1_700_000_000_000,
      budget: { max_calls: 6, round_ms: 30_000, call_timeout_ms: 12_000 },
      calls: [{ role: 'cooling', phase: 'findings', started_ms: 0, ended_ms: 900, status: 'ok' }],
      ...over,
    });

  it('parses version 2 traces of every status, and rejects a v2 trace missing its v2 fields', () => {
    for (const status of ['running', 'closed', 'interrupted']) expect(parseTeamTrace(v2({ status }))).not.toBeNull();
    expect(parseTeamTrace(v2({ calls: [{ role: 'lead', phase: 'decide', started_ms: 1, ended_ms: null, status: 'running' }] }))).not.toBeNull();
    expect(parseTeamTrace(v2({ status: 'paused' }))).toBeNull();
    expect(parseTeamTrace(v2({ calls: [{ role: 'lead' }] }))).toBeNull();
    expect(parseTeamTrace(v2({ started_unix_ms: undefined }))).toBeNull();
    expect(parseTeamTrace(v2({ version: 3 }))).toBeNull();
  });

  it('counts only closed rounds: a running v2 trace is neither a round nor malformed', () => {
    const store = newTeamStore();
    recordTeamRounds(store, [wf('wf-1', { team: v2({ status: 'running', phase: 'findings' }) })]);
    expect(store.rounds.size).toBe(0);
    expect(store.malformed.size).toBe(0);
    recordTeamRounds(store, [wf('wf-1', { team: v2() })]);
    expect([...store.rounds.values()].map((r) => r.trace.round_id)).toEqual(['wf-1:a1:e1']);
  });

  it('reads state.team_rounds too, dedupes by round_id keeping the latest, and skips interrupted rounds', () => {
    const store = newTeamStore();
    recordTeamRounds(store, [
      wf('wf-1', {
        team_rounds: {
          rounds: [trace({ round_id: 'wf-1:a1:e1' }), v2({ round_id: 'wf-1:a2:e1', status: 'interrupted', phase: 'peer_answers' }), v2({ round_id: 'wf-1:a3:e1', outcome: 'deterministic' })],
          dropped: 0,
        },
        team: v2({ round_id: 'wf-1:a3:e1', outcome: 'lead' }),
      }),
    ]);
    const rounds = [...store.rounds.values()];
    expect(rounds.map((r) => [r.trace.round_id, r.trace.outcome])).toEqual([
      ['wf-1:a1:e1', 'lead'],
      ['wf-1:a3:e1', 'lead'],
    ]);
    expect(store.malformed.size).toBe(0);
    expect(checkTeamRounds(rounds, { expectLead: true }).every((c) => c.ok)).toBe(true);

    recordTeamRounds(store, [wf('wf-2', { team_rounds: { rounds: [{ version: 2 }] }, team: v2({ round_id: 'wf-2:a1:e1' }) })]);
    expect([...store.malformed]).toEqual(['wf-2']);
  });
});

describe('model provenance', () => {
  const ev = (actor: AgentEventInput['actor'], summary: string): AgentEventInput => ({ agent_event_id: summary, run_id: 'r', workflow_id: 'wf', incident_id: null, stage: 'plan', summary, evidence_ids: [], tool_calls: [], actor, sim_time_ms: 0, observed_unix_ms: 0 });

  it('counts the agent log lines that show real model use and failure', () => {
    const s = newLlmLogStats();
    for (const line of ['[out] agent: nemotron ok 812 ms', '[out] agent: nemotron failed (TimeoutError) 8000 ms', '[out] agent: nim endpoint_failed (primary m)', '[out] agent: config {}']) tallyLlmLogLine(s, line);
    expect(s).toEqual({ nemotron_ok: 1, nemotron_failed: 1, endpoint_failovers: 1 });
  });

  it('reports observed usage alongside the configured model', () => {
    const p = buildProvenance('nvidia/nemotron', 'live_nim', [ev('nemotron', 'chose'), ev('code', 'LLM unavailable: fallback')], newLlmLogStats(), [round(), round({ round_id: 'wf-1:a2:e2', outcome: 'deterministic', model: null })]);
    expect(p.team).toEqual({ models: ['nvidia/nemotron'], lead_rounds: 1, fallback_rounds: 1 });
    expect(p.events).toMatchObject({ nemotronEvents: 1, codeEvents: 1, fallbackNotices: 1 });
    expect(checkProvenanceReported(p).ok).toBe(true);
  });

  it('fails with no events or an unattributed event', () => {
    expect(checkProvenanceReported(buildProvenance('m', 'live_nim', [], newLlmLogStats(), [])).ok).toBe(false);
    expect(checkProvenanceReported(buildProvenance('m', 'live_nim', [ev(undefined, 'x')], newLlmLogStats(), [])).ok).toBe(false);
  });
});
