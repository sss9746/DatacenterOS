// L5 due-tick derivation when the live ledger has due_sim_time_ms = null for a running checkpoint.

import type { ActionCommand, ActionStatus, Checkpoint } from '@dcos/contracts';
import type { ActionDetail, ActionHistoryEntry } from '@dcos/db-client';
import { CHECKPOINT_DURATION_MS } from '@dcos/physics';
import { describe, expect, it } from 'vitest';
import { deriveCheckpointDue, describeDue } from '../../scripts/live/due.js';

const V = '1.1.0' as const;
const RUN = 'run-demo-1';
const KEY = 'wf-inc-1:checkpoint:job-a:1';

const hist = (status: ActionStatus['status'], sim: number): ActionHistoryEntry => ({ status, version: 1, sim_time_ms: sim, observed_unix_ms: 0, reason_code: null, detail: {} });

function detail(over: { due?: number | null; status?: ActionStatus['status']; updated?: number; result?: Record<string, unknown>; history?: ActionHistoryEntry[] } = {}): ActionDetail {
  const command: ActionCommand = {
    schema_version: V, run_id: RUN, action_id: `act:${KEY}`, command_key: KEY, workflow_id: 'wf-inc-1', plan_id: 'plan-1', incident_ids: ['inc-1'], operation: 'checkpoint', target_resource_id: 'job-a', job_id: 'job-a',
    arguments: {}, depends_on_command_keys: [], expected_decision_epoch: 1, expected_resource_versions: {}, requested_sim_time_ms: 600_000,
  };
  return {
    status: { schema_version: V, run_id: RUN, action_id: command.action_id, command_key: KEY, status: over.status ?? 'running', attempt: 1, updated_sim_time_ms: over.updated ?? 0, result: over.result ?? {}, reason_code: null, version: 2 },
    command, claimed_by: 'agent-1', due_sim_time_ms: over.due === undefined ? null : over.due, safety: null, start_safety: null, history: over.history ?? [],
  };
}

const ckptRow = (key: string, status: Checkpoint['status'], requested: number): Checkpoint => ({
  schema_version: V, run_id: RUN, checkpoint_id: `ckpt-${key}`, job_id: 'job-a', storage_resource_id: 'ckpt-store-1', status, progress_work_units: 80, requested_sim_time_ms: requested, complete_sim_time_ms: null, accessible: true, command_key: key,
});

const OBSERVED = 777_000;

describe('deriveCheckpointDue', () => {
  it('uses the physics checkpoint duration (30 s) by default', () => {
    expect(CHECKPOINT_DURATION_MS).toBe(30_000);
    expect(deriveCheckpointDue(detail(), [], OBSERVED).duration_ms).toBe(30_000);
  });

  it('prefers the ledger due_sim_time_ms when present, even if other sources disagree', () => {
    const d = deriveCheckpointDue(detail({ due: 650_000, history: [hist('running', 600_000)] }), [ckptRow(KEY, 'writing', 610_000)], OBSERVED);
    expect(d).toEqual({ due_sim_time_ms: 650_000, start_sim_time_ms: 620_000, source: 'ledger_due', estimate: false, duration_ms: 30_000 });
  });

  it('derives from the writing checkpoint row (requested + 30 s) when the ledger due is null', () => {
    const rows = [ckptRow('other:checkpoint:job-b:1', 'writing', 1), ckptRow(KEY, 'complete', 100), ckptRow(KEY, 'writing', 640_000)];
    const d = deriveCheckpointDue(detail({ due: null, history: [hist('running', 639_000)] }), rows, OBSERVED);
    expect(d.source).toBe('checkpoint_row');
    expect(d.start_sim_time_ms).toBe(640_000);
    expect(d.due_sim_time_ms).toBe(670_000);
    expect(d.estimate).toBe(false);
    // a `requested` row counts too (the write is about to start)
    expect(deriveCheckpointDue(detail(), [ckptRow(KEY, 'requested', 641_000)], OBSERVED).due_sim_time_ms).toBe(671_000);
    // a complete/failed row for the key does not (that is a previous attempt, not this write)
    expect(deriveCheckpointDue(detail(), [ckptRow(KEY, 'complete', 100)], OBSERVED).source).not.toBe('checkpoint_row');
  });

  it('falls back to the sim time the action entered running in its history', () => {
    const d = deriveCheckpointDue(detail({ history: [hist('requested', 600_000), hist('claimed', 605_000), hist('running', 612_000)] }), [], OBSERVED);
    expect(d).toMatchObject({ source: 'history_running', start_sim_time_ms: 612_000, due_sim_time_ms: 642_000, estimate: false });
  });

  it('then to status.result.started_sim_time_ms / started_sim_ms', () => {
    expect(deriveCheckpointDue(detail({ result: { started_sim_time_ms: 620_000 } }), [], OBSERVED)).toMatchObject({ source: 'status_result', due_sim_time_ms: 650_000 });
    expect(deriveCheckpointDue(detail({ result: { started_sim_ms: 621_000 } }), [], OBSERVED)).toMatchObject({ source: 'status_result', due_sim_time_ms: 651_000 });
    expect(deriveCheckpointDue(detail({ result: { started_sim_time_ms: 'soon' } }), [], OBSERVED).source).not.toBe('status_result');
  });

  it('then to status.updated_sim_time_ms while the action is running (its last transition was the start)', () => {
    expect(deriveCheckpointDue(detail({ updated: 630_000 }), [], OBSERVED)).toMatchObject({ source: 'status_updated', start_sim_time_ms: 630_000, due_sim_time_ms: 660_000, estimate: false });
    // not for a claimed action: its last transition was not the start of the write
    expect(deriveCheckpointDue(detail({ status: 'claimed', updated: 630_000 }), [], OBSERVED).source).toBe('observed_estimate');
  });

  it('last resort: first sim time the harness observed it running + 30 s, labeled an estimate', () => {
    const d = deriveCheckpointDue(detail({ updated: 0, status: 'claimed' }), [], OBSERVED);
    expect(d).toEqual({ due_sim_time_ms: OBSERVED + 30_000, start_sim_time_ms: OBSERVED, source: 'observed_estimate', estimate: true, duration_ms: 30_000 });
    expect(describeDue(d)).toBe(`due ${OBSERVED + 30_000} = start ${OBSERVED} + 30000 (source observed_estimate, ESTIMATE)`);
  });

  it('honours a custom duration', () => {
    expect(deriveCheckpointDue(detail({ history: [hist('running', 100)] }), [], OBSERVED, 45_000).due_sim_time_ms).toBe(45_100);
  });
});
