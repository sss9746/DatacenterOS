import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockClient } from '@dcos/db-client';
import { evaluateSafety } from '@dcos/physics';
import { DashboardStore, openDashboard } from '../src/data/dashboard';
import { loadRecordedRun, RECORDED_FIXTURE, RECORDED_META, RECORDED_ROUNDS } from '../src/data/recorded-run';
import { loadRecoveryExample } from '../src/data/recovery-example';
import { TopBar, type TopBarProps } from '../src/components/shell/TopBar';
import { buildRoomView } from '../src/components/agent-room/room-view';
import fixture from '../src/data/fixtures/recorded-l3.json';

const stores: DashboardStore[] = [];
afterEach(() => { stores.forEach((s) => s.close()); stores.length = 0; });

describe('RECORDED replay (real L3 agent-team traces)', () => {
  it('fixture holds the two real rounds of wf-inc-thermal-pump-a-b2, v1, from dcos-r-local', () => {
    expect(RECORDED_ROUNDS.map((r) => r.round_id)).toEqual(['wf-inc-thermal-pump-a-b2:a1:e1', 'wf-inc-thermal-pump-a-b2:a2:e3']);
    expect(RECORDED_ROUNDS.map((r) => [r.calls_used, r.wall_ms, r.messages.length])).toEqual([[5, 8973, 7], [4, 12058, 5]]);
    expect(RECORDED_ROUNDS[1]!.covers).toEqual([{ failed_role: 'workload', covered_by: 'cooling' }]);
    expect(RECORDED_FIXTURE.source.db).toBe('dcos-r-local');
    expect(RECORDED_META).toEqual({ model: 'nvidia/nemotron-3.5-lightning-30b-a3b', date: '2026-11-08', db: 'dcos-r-local', timing: 'replay' });
  });

  it('seeds one workflow with state.team = latest round and state.team_rounds = the earlier round, and nothing invented', async () => {
    const client = createMockClient({ snapshot: 'demo', evaluateSafety });
    await loadRecordedRun(client);
    const wf = await client.getWorkflow('wf-inc-thermal-pump-a-b2');
    expect(wf).not.toBeNull();
    expect(wf!.stage).toBe('done');
    expect(wf!.attempt).toBe(2);
    expect(wf!.lease_owner).toBe('agent-MacBook-Pro-8.local-13045');
    expect(wf!.incident_ids).toEqual(['inc-compute-gpu-r1-n1-0-b2', 'inc-thermal-pump-a-b2']);
    expect(wf!.state.team).toEqual(fixture.team_rounds[1]);
    expect(wf!.state.team_rounds).toEqual({ rounds: [fixture.team_rounds[0]], dropped: 0 });
    expect(wf!.state.verification).toEqual(fixture.verification);
    // No resume marker, plan or other state the file does not contain.
    expect(Object.keys(wf!.state).sort()).toEqual(['incident_ids', 'team', 'team_rounds', 'verification']);
  });

  it('opens through the dashboard with no feed rows, actions, plans or incidents added', async () => {
    const store = await openDashboard('mock', 'recorded', { uri: '', db: '' }); stores.push(store);
    store.start(); await new Promise((r) => setTimeout(r, 25));
    expect(store.state.workflows.map((w) => w.workflow_id)).toEqual(['wf-inc-thermal-pump-a-b2']);
    expect(store.state.events).toHaveLength(0);
    expect(store.state.actions).toHaveLength(0);
    expect(store.state.plans).toHaveLength(0);
    expect(store.state.incidents).toHaveLength(0);
    expect(store.state.results).toHaveLength(0);
  });

  it('TopBar shows the RECORDED badge with model, date, database and the replay-pacing note', () => {
    const base: TopBarProps = { mode: 'mock', dbName: '', localPhysics: false, snapshot: null, error: null, stale: false, canAdmin: true, pending: false, preview: 'recorded', onPreview: () => {}, speed: 1, onSpeed: () => {}, onTogglePause: () => {}, demoOpen: false, onToggleDemo: () => {} };
    const html = renderToStaticMarkup(createElement(TopBar, { ...base, recorded: RECORDED_META }));
    expect(html).toContain('RECORDED · nvidia/nemotron-3.5-lightning-30b-a3b · 2026-11-08 · dcos-r-local');
    expect(html).toContain('replay pacing, not recorded timing');
    expect(html).toMatch(/<option value="recorded"[^>]*>Recorded agent team \(L3\)<\/option>/);
    const plain = renderToStaticMarkup(createElement(TopBar, { ...base, preview: 'physics', recorded: null }));
    expect(plain).not.toContain('RECORDED ·');
  });
});

describe('recovery example after the agent_message removal', () => {
  it('has no agent_message calls; its team exchange uses team_message between cooling and workload, still labelled Example', async () => {
    const client = createMockClient({ snapshot: 'demo', evaluateSafety });
    await loadRecoveryExample(client);
    const events: Parameters<typeof buildRoomView>[0]['events'][number][] = [];
    const off = client.onAgentEvents((rows) => { events.splice(0, events.length, ...rows); });
    off();
    const calls = events.flatMap((e) => e.tool_calls);
    expect(events.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.tool === 'agent_message')).toBe(false);
    const team = events.filter((e) => e.tool_calls.some((c) => c.tool === 'team_message'));
    expect(team.map((e) => e.tool_calls[0]!.args_summary)).toEqual(['question cooling->workload', 'answer workload->cooling']);
    expect(team.every((e) => e.summary.startsWith('Example: ') && e.actor === 'nemotron')).toBe(true);
    const view = buildRoomView({ events, workflows: [], incidents: [], nowUnixMs: 0, example: true });
    const seats = view.threads.flatMap((t) => t.items).filter((i) => i.kind === 'bubble' && i.message).map((i) => i.kind === 'bubble' ? i.seat : null);
    expect(seats).toContain('cooling');
    expect(seats).toContain('workload');
  });
});
