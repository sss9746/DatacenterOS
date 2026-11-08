import type { MockDbClient } from '@dcos/db-client';
import recorded from './fixtures/recorded-l3.json';

/**
 * RECORDED replay of a real agent-team run: harness case L3 on 2026-11-08 against the local `dcos-r-local` database
 * (apps/agent/live-results/agent-team-2026-11-08/L3-team-scene-a/L3.json, copied field-for-field into
 * fixtures/recorded-l3.json). Real Nemotron wrote the team messages; nothing here is scripted.
 *
 * What is seeded, and only this: one workflow row whose `state.team` is the latest saved round trace (a2:e3, after the
 * SIGKILL takeover), `state.team_rounds` holds the earlier round (a1:e1), and `state.verification` is the persisted
 * code verifier handoff. The lease history follows the harness's reclaim evidence (owner_before → owner_after).
 * The file has no feed rows, actions or plans, so none are added. The cluster telemetry around it is the mock
 * `pump_degraded` fixture, not the recording. Traces are v1: no per-message timing, so any pacing is replay pacing.
 */

export interface TeamTraceV1 {
  version: 1;
  round_id: string;
  snapshot_sim_ms: number;
  model: string | null;
  calls_used: number;
  wall_ms: number;
  outcome: string;
  messages: unknown[];
  covers: unknown[];
  missing_roles: unknown[];
}

export interface RecordedRunMeta {
  model: string | null;
  date: string;
  db: string;
  /** v1 traces carry no per-message timing: the UI must say "replay pacing, not recorded timing". */
  timing: 'replay' | 'recorded';
}

const RECORDED_DATE = '2026-11-08';
const LEASE_MS = 60 * 60 * 1000;

export const RECORDED_FIXTURE = recorded;
export const RECORDED_ROUNDS = recorded.team_rounds as TeamTraceV1[];

/** Model, date and database for the RECORDED badge, read from the fixture (latest round's `trace.model`). */
export const RECORDED_META: RecordedRunMeta = {
  model: RECORDED_ROUNDS.at(-1)?.model ?? null,
  date: RECORDED_DATE,
  db: recorded.source.db,
  timing: RECORDED_ROUNDS.every((r) => r.version === 1) ? 'replay' : 'recorded',
};

/** Seeds the mock with the recorded workflow: latest round in `state.team`, earlier rounds in `state.team_rounds`. */
export async function loadRecordedRun(client: MockDbClient) {
  client.loadSnapshot('pump_degraded');
  const wf = recorded.workflow;
  const rounds = RECORDED_ROUNDS;
  const latest = rounds.at(-1);
  if (!latest) throw new Error('recorded fixture has no team rounds');

  // Lease history as recorded by the harness: generation 1 claimed, was SIGKILLed, generation 2 reclaimed (attempt 2).
  const first = await client.claimWorkflow(wf.workflow_id, recorded.reclaim.owner_before, 0, LEASE_MS);
  await client.heartbeatWorkflow(wf.workflow_id, recorded.reclaim.owner_before, first.fencing_token, 0);
  const second = await client.claimWorkflow(wf.workflow_id, recorded.reclaim.owner_after, first.workflow.version, LEASE_MS);

  await client.updateWorkflow(wf.workflow_id, second.workflow.version, second.fencing_token, wf.stage as 'done', {
    incident_ids: wf.incident_ids,
    team: latest,
    team_rounds: { rounds: rounds.slice(0, -1), dropped: 0 },
    verification: recorded.verification,
  });
}
