import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkflowRecord } from '@dcos/db-client';
import L3 from './fixtures/team-L3.json';
import SBK from './fixtures/team-SBK.json';
import { buildChapters, parseRoundId, readOperatorJobs, readRecovery, readTeam, readTeamRound } from '../src/components/team/team-view';
import { edgeLine, TeamStage } from '../src/components/team/TeamStage';
import { TeamTranscript } from '../src/components/team/TeamTranscript';
import { TeamSection } from '../src/components/team/TeamSection';
import { buildWorkflowViews } from '../src/components/workflows/workflow-view';
import { WorkflowBoard } from '../src/components/workflows/WorkflowBoard';

const [l3a1, l3a2] = L3.rounds.map((r) => r.trace);
const sbk = SBK.rounds[0]!.trace;

const wf = (state: Record<string, unknown>, patch: Partial<WorkflowRecord> = {}): WorkflowRecord => ({
  workflow_id: 'wf-inc-thermal-pump-a-b2', run_id: 'run-1', stage: 'plan', state, incident_ids: [], plan_id: null, current_command_key: null,
  last_processed_event_seq: 0, attempt: 1, lease_owner: 'agent-1', lease_expires_unix_ms: 0, fencing_token: 1n, updated_at_unix_ms: 0, version: 1, ...patch,
});

/** Hand-built v2 trace mid-round: Cooling done, Workload timed out, Cooling now covering, Lead not called yet. */
const v2Running = {
  version: 2, round_id: 'wf-x:a1:e4', snapshot_sim_ms: 120000, model: 'nvidia/nemotron-3.5-lightning-30b-a3b', calls_used: 3, wall_ms: 9400, outcome: 'deterministic',
  status: 'running', phase: 'cover', started_unix_ms: 1794142832228, budget: { max_calls: 6, round_ms: 30000, call_timeout_ms: 8000 },
  calls: [
    { role: 'cooling', phase: 'findings', started_ms: 0, ended_ms: 3100, status: 'ok' },
    { role: 'workload', phase: 'findings', started_ms: 0, ended_ms: 8000, status: 'timeout' },
    { role: 'cooling', phase: 'cover', started_ms: 8100, ended_ms: null, status: 'running' },
  ],
  messages: [
    { id: 'wf-x:a1:e4:m1', round_id: 'wf-x:a1:e4', from: 'cooling', to: 'lead', kind: 'finding', reply_to: null, summary: 'pump-a degraded', evidence_ids: ['sig.1'], resource_ids: ['pump-a'], consumed_by: [], t_ms: 3100 },
    { id: 'wf-x:a1:e4:m2', round_id: 'wf-x:a1:e4', from: 'cooling', to: 'workload', kind: 'question', reply_to: null, summary: 'Which job is on rack-r6?', evidence_ids: [], resource_ids: [], consumed_by: [], t_ms: 3100 },
  ],
  covers: [{ failed_role: 'workload', covered_by: 'cooling' }],
  missing_roles: [],
};

describe('team-view: v1 traces (real L3 / SBK)', () => {
  it('reads both L3 rounds from history, oldest first, the latest from state.team', () => {
    const team = readTeam({ team: l3a2, team_rounds: { rounds: [l3a1, l3a2], dropped: 0 } })!;
    expect(team.rounds.map((r) => r.label)).toEqual(['a1 · e1', 'a2 · e3']);
    const [a1, a2] = team.rounds;
    expect(a1).toMatchObject({ version: 1, status: 'closed', timing: 'not recorded', callsUsed: 5, wallMs: 8973, decider: 'Lead (Nemotron)', covers: [] });
    expect(a1!.budget).toMatchObject({ maxCalls: 6, roundMs: 30000, source: 'default' });
    expect(a1!.messages).toHaveLength(7);
    expect(a2!.messages).toHaveLength(5);
    // every role spoke in a1
    expect(Object.values(a1!.nodes).map((n) => n.state)).toEqual(['done', 'done', 'done']);
  });

  it('dedupes by round id when state.team repeats the last history round', () => {
    expect(readTeam({ team: l3a1, team_rounds: { rounds: [l3a1], dropped: 2 } })).toMatchObject({ rounds: [{ roundId: l3a1!.round_id }], dropped: 2 });
  });

  it('a1: solid edge only when the recipient consumed it, dashed otherwise', () => {
    const a1 = readTeamRound(l3a1)!;
    const edge = (k: string) => a1.edges.find((e) => e.key === k);
    expect(edge('cooling->workload')).toMatchObject({ consumption: 'partial', notConsumed: 1, messageIds: [expect.stringMatching(/m2$/), expect.stringMatching(/m6$/)] });
    expect(edge('cooling->lead')?.consumption).toBe('consumed');
    expect(edge('lead->supervisor')?.consumption).toBe('code');
    const m6 = a1.messages.find((m) => m.id.endsWith(':m6'))!;
    expect(m6).toMatchObject({ consumedByRecipient: false, claim: true, replyTo: expect.stringMatching(/m4$/) });
    // both peer questions were answered in a1
    expect(a1.messages.filter((m) => m.kind === 'question').every((m) => !m.unanswered)).toBe(true);
  });

  it('a2: Workload failed and Cooling covered; the peer question went unanswered and unconsumed', () => {
    const a2 = readTeamRound(l3a2)!;
    expect(a2.covers).toEqual([{ failedRole: 'workload', coveredBy: 'cooling', cause: 'did not deliver a usable finding', messageId: expect.stringMatching(/m4$/) }]);
    expect(a2.nodes.workload).toMatchObject({ state: 'failed', label: 'no usable finding · covered by Cooling', coveredBy: 'cooling' });
    expect(a2.nodes.cooling).toMatchObject({ state: 'done', coveredFor: ['workload'] });
    const q = a2.messages.find((m) => m.kind === 'question')!;
    expect(q).toMatchObject({ unanswered: true, consumedByRecipient: false });
    expect(a2.edges.find((e) => e.key === 'supervisor->workload')).toMatchObject({ consumption: 'none', kinds: ['objection'] });
  });

  it('SBK: one full round with peer answers, no cover', () => {
    const r = readTeamRound(sbk)!;
    expect(r).toMatchObject({ label: 'a2 · e2', attempt: 2, epoch: 2, callsUsed: 5, wallMs: 14393, covers: [], outcome: 'lead' });
    expect(r.messages.filter((m) => m.kind === 'answer')).toHaveLength(2);
  });
});

describe('team-view: v2 traces', () => {
  it('derives node states from calls[]: done, timed out, covering, idle', () => {
    const r = readTeamRound(v2Running)!;
    expect(r).toMatchObject({ version: 2, status: 'running', phase: 'cover', timing: 'recorded', outcome: null, decider: 'not decided yet' });
    expect(r.budget).toMatchObject({ maxCalls: 6, roundMs: 30000, callTimeoutMs: 8000, source: 'trace' });
    expect(r.nodes.cooling).toMatchObject({ state: 'covering', calls: 2 });
    expect(r.nodes.workload).toMatchObject({ state: 'timed_out', label: 'timed out · covered by Cooling' });
    expect(r.nodes.lead).toMatchObject({ state: 'idle', label: 'waiting its turn' });
    expect(r.covers[0]?.cause).toBe('timed out');
    expect(r.messages.map((m) => m.tMs)).toEqual([3100, 3100]);
  });

  it('marks an interrupted round in history and an older round that never closed', () => {
    const interrupted = { ...v2Running, round_id: 'wf-x:a1:e4', status: 'interrupted' };
    const stale = { ...v2Running, round_id: 'wf-x:a1:e2', status: 'running' };
    const latest = { ...v2Running, round_id: 'wf-x:a2:e5', status: 'closed', outcome: 'lead', calls: v2Running.calls.map((c) => ({ ...c, ended_ms: c.ended_ms ?? 9000, status: c.status === 'running' ? 'ok' : c.status })) };
    const team = readTeam({ team: latest, team_rounds: { rounds: [stale, interrupted], dropped: 0 } })!;
    expect(team.rounds.map((r) => [r.label, r.status])).toEqual([['a1 · e2', 'not_closed'], ['a1 · e4', 'interrupted'], ['a2 · e5', 'closed']]);
    expect(team.rounds[1]!.decider).toBe('no decision (round interrupted)');
    expect(team.rounds[2]!.decider).toBe('Lead (Nemotron)');
  });

  it('a takeover rerun with the same round id keeps the interrupted run and the rerun (identified by start time)', () => {
    const interrupted = { ...v2Running, status: 'interrupted', started_unix_ms: 1000 };
    const rerun = { ...v2Running, status: 'running', started_unix_ms: 2000 };
    const team = readTeam({ team: rerun, team_rounds: { rounds: [interrupted, rerun], dropped: 0 } })!;
    expect(team.rounds.map((r) => [r.label, r.status, r.key])).toEqual([
      ['a1 · e4 · run 1', 'interrupted', 'wf-x:a1:e4@1000'],
      ['a1 · e4 · run 2', 'running', 'wf-x:a1:e4@2000'],
    ]);
    // no team_rounds key at all (single round)
    expect(readTeam({ team: rerun })!.rounds).toHaveLength(1);
    const html = renderToStaticMarkup(createElement(TeamSection, { view: buildWorkflowViews({ workflows: [wf({ team: rerun, team_rounds: { rounds: [interrupted, rerun], dropped: 0 } })], events: [], actionDetails: [], incidents: [], snapshot: null })[0]!, mode: 'live', example: false, recorded: null }));
    expect(html).toContain('Round a1 · e4 · run 1');
    expect(html).toContain('interrupted');
  });

  it('a deterministic outcome reads as code deciding, and the Lead → code edge as not used', () => {
    const r = readTeamRound({ ...l3a1, outcome: 'deterministic' })!;
    expect(r.decider).toBe('deterministic code');
    expect(r.edges.find((e) => e.key === 'lead->supervisor')?.consumption).toBe('none');
  });
});

describe('team-view: tolerance', () => {
  it.each([undefined, null, 42, 'x', [], {}, { team: 'nope' }, { team: { round_id: 'r' } }, { team: { messages: [] } }, { team_rounds: { rounds: 'x' } }])('malformed %j → null', (state) => {
    expect(readTeam(state)).toBeNull();
  });

  it('keeps junk messages without throwing; unknown parties read as unattributed', () => {
    const r = readTeamRound({ round_id: 'r1', messages: [null, 3, { from: 'mystery', to: 'lead', summary: 5, kind: 'shout' }] })!;
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ from: 'unattributed', kind: 'unknown', summary: '', claim: false });
    expect(r.edges).toEqual([]);
    expect(parseRoundId('weird').label).toBe('weird');
  });

  it('reads recovery and operator jobs; ignores malformed ones', () => {
    expect(readRecovery({ recovery: { status: 'waiting', job_ids: ['job-c'], blocked_reason: 'job-c: no capacity', first_wait_unix_ms: 1, attempts: 2, fingerprint: 'f' } })).toMatchObject({ status: 'waiting', jobIds: ['job-c'], attempts: 2 });
    expect(readRecovery({ recovery: 'x' })).toBeNull();
    expect(readOperatorJobs({ operator_jobs: [{ job_id: 'job-c', reason: 'no completed checkpoint' }, 7] })).toEqual([{ jobId: 'job-c', reason: 'no completed checkpoint' }]);
    expect(readOperatorJobs({ operator_jobs: 'x' })).toEqual([]);
  });
});

describe('team-view: chapters', () => {
  it('orders rounds, takeover and verify by recorded sim time; waiting and operator chapters come from persisted state', () => {
    const team = readTeam({ team: l3a2, team_rounds: { rounds: [l3a1], dropped: 0 } });
    const chapters = buildChapters({
      team,
      actions: [{ command: { command_key: 'k1', plan_id: 'plan-1', requested_sim_time_ms: 620000 }, status: { status: 'succeeded' } }],
      resumed: { sim_time_ms: 640000, previous_owner: 'agent-alpha-123', by_worker: 'agent-beta-456', action: 'took_over' },
      verification: { verified: true, asOf: { from: 700000, to: 710000 }, outcome: 'recovered' },
      recovery: { status: 'waiting', jobIds: ['job-c'], blockedReason: 'job-c: no capacity', firstWaitUnixMs: null, attempts: 1, freeGpus: null },
      operatorJobs: [{ jobId: 'job-c', reason: 'no completed checkpoint' }],
      stage: 'verify', escalationReason: null,
    });
    expect(chapters.map((c) => c.kind)).toEqual(['round', 'execute', 'takeover', 'round', 'waiting', 'escalated', 'verify']);
    expect(chapters[2]!.detail).toContain('agent-beta took over');
    expect(chapters[3]!.detail).toContain('Workload did not deliver a usable finding, Cooling covered');
  });
});

describe('team stage and transcript render', () => {
  it('stage shows the gate, CODE and NEMOTRON labels, budget, and edge list; v1 timing is labelled', () => {
    const html = renderToStaticMarkup(createElement(TeamStage, { round: readTeamRound(l3a2)!, mode: 'live', example: false, recorded: { model: 'nemotron', date: '2026-11-08', db: 'dcos-r-local', timing: 'replay' } }));
    expect(html).toContain('Code safety gate');
    expect(html).toContain('Findings inform. Code decides.');
    expect(html).toContain('NEMOTRON');
    expect(html).toContain('CODE');
    expect(html).toContain('4 of 6');
    expect(html).toContain('12.1 s of 30 s');
    expect(html).toContain('Lead (Nemotron)');
    expect(html).toContain('RECORDED');
    expect(html).toContain('replay pacing, not recorded timing');
    expect(html).toContain('Per-call timing not recorded');
    expect(html).toContain('covered by Cooling');
    expect(html).not.toContain('ts-dot'); // nothing travels on first paint
  });

  it('transcript: CLAIM labels, full text, ids, not-consumed marker, cover as it happened, aria-live only here', () => {
    const round = readTeamRound(l3a2)!;
    const html = renderToStaticMarkup(createElement(TeamTranscript, { round }));
    expect(html.match(/aria-live/g)).toHaveLength(1);
    expect(html).toContain('CLAIM');
    expect(html).toContain('Workload did not deliver a usable finding — Cooling covered');
    expect(html).toContain('not consumed');
    expect(html).toContain('no answer recorded in this round');
    expect(html).toContain('sig.602000.pump-a.equipment_alarm');
    expect(html).toContain(round.messages[3]!.summary.replaceAll('°', '°'));
    const stage = renderToStaticMarkup(createElement(TeamStage, { round, mode: 'mock', example: false, recorded: null }));
    expect(stage).not.toContain('aria-live');
  });

  it('every stage pair has a line and reverse lines are offset', () => {
    expect(edgeLine('cooling', 'workload')).not.toEqual(edgeLine('workload', 'cooling'));
    expect(edgeLine('supervisor', 'workload')).not.toBeNull();
    expect(edgeLine('lead', 'lead')).toBeNull();
  });

  it('section: honest empty state when no trace, round picker when there are two rounds', () => {
    const [empty] = buildWorkflowViews({ workflows: [wf({})], events: [], actionDetails: [], incidents: [], snapshot: null });
    expect(renderToStaticMarkup(createElement(TeamSection, { view: empty!, mode: 'mock', example: false, recorded: null }))).toContain('No team round recorded for this workflow');
    const [two] = buildWorkflowViews({ workflows: [wf({ team: l3a2, team_rounds: { rounds: [l3a1, l3a2], dropped: 0 } })], events: [], actionDetails: [], incidents: [], snapshot: null });
    const html = renderToStaticMarkup(createElement(TeamSection, { view: two!, mode: 'live', example: false, recorded: null }));
    expect(html).toContain('Choose a team round');
    expect(html).toContain('Round a1 · e1');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Recovery so far');
  });
});

describe('workflow-view: team, recovery and operator jobs', () => {
  it('Compare reads "Team round" when a trace exists, keeping the step id', () => {
    const [v] = buildWorkflowViews({ workflows: [wf({ team: l3a1 })], events: [], actionDetails: [], incidents: [], snapshot: null });
    expect(v!.steps.find((s) => s.id === 'compare')?.label).toBe('Team round');
    expect(v!.hasTeam).toBe(true);
    const [plain] = buildWorkflowViews({ workflows: [wf({})], events: [], actionDetails: [], incidents: [], snapshot: null });
    expect(plain!.steps.find((s) => s.id === 'compare')?.label).toBe('Compare');
  });

  it('a persisted capacity wait gives a real waiting status; operator jobs show on the card', () => {
    const state = { recovery: { status: 'waiting', job_ids: ['job-c'], blocked_reason: 'job-c: no free GPUs', first_wait_unix_ms: 0, attempts: 3, fingerprint: 'f' }, operator_jobs: [{ job_id: 'job-b', reason: 'no completed checkpoint' }] };
    const [v] = buildWorkflowViews({ workflows: [wf(state)], events: [], actionDetails: [], incidents: [], snapshot: null });
    expect(v!.status).toMatchObject({ kind: 'waiting', label: 'Waiting for capacity' });
    expect(v!.status.detail).toContain('Holding job-c until capacity returns');
    expect(v!.status.detail).toContain('(check 3)');
    expect(v!.operatorJobs).toEqual([{ jobId: 'job-b', reason: 'no completed checkpoint' }]);
    const html = renderToStaticMarkup(createElement(WorkflowBoard, { workflows: [wf(state)], events: [], actionDetails: [], incidents: [], snapshot: null, example: false, mode: 'live' }));
    expect(html).toContain('job-b needs an operator');
    expect(html).toContain('Waiting for capacity');
  });

  it('a resumed or expired recovery record is not a wait', () => {
    const [v] = buildWorkflowViews({ workflows: [wf({ recovery: { status: 'resumed', job_ids: ['job-c'] } })], events: [], actionDetails: [], incidents: [], snapshot: null });
    expect(v!.status.kind).toBe('in_progress');
  });
});
