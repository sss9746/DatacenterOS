// All-workflows-settled predicate and the per-workflow handoff check (pure; no network).
// Guards the L2 regression: the pump workflow verified, but the destination-Xid workflow was still in
// `verify` when the harness reset for the next case, so no handoff was ever persisted for it.

import type { WorkflowRecord } from '@dcos/db-client';
import { describe, expect, it } from 'vitest';
import { allWorkflowsSettled, checkHandoffRecorded, handoffOf, SETTLED_STAGES } from '../../scripts/live/asserts.js';

const wf = (id: string, stage: WorkflowRecord['stage'], state: Record<string, unknown> = {}): WorkflowRecord => ({
  workflow_id: id, run_id: 'run-demo-1', stage, state, incident_ids: [`inc-${id}`], plan_id: 'plan-1', current_command_key: null, last_processed_event_seq: 0, attempt: 1, lease_owner: 'agent-host-100', lease_expires_unix_ms: 0, fencing_token: 5n, updated_at_unix_ms: 0, version: 3,
});

const VERIFIED = { outcome: 'recovered', verified_at_sim_time_ms: 420_000, checks: ['job-a running on destination'] };

describe('allWorkflowsSettled', () => {
  it('treats only done/escalated as settled', () => {
    expect([...SETTLED_STAGES].sort()).toEqual(['done', 'escalated']);
    expect(allWorkflowsSettled([wf('wf-pump', 'done'), wf('wf-xid', 'escalated')])).toEqual({ settled: true, pending: [], total: 2 });
  });

  it('is settled on an empty list (nothing left running) and reports total 0', () => {
    expect(allWorkflowsSettled([])).toEqual({ settled: true, pending: [], total: 0 });
  });

  it('lists every pending workflow as id@stage when one is still verifying (the L2 regression)', () => {
    const r = allWorkflowsSettled([wf('wf-pump', 'done', { verification: VERIFIED }), wf('wf-xid', 'verify'), wf('wf-3', 'execute')]);
    expect(r.settled).toBe(false);
    expect(r.pending).toEqual(['wf-xid@verify', 'wf-3@execute']);
    expect(r.total).toBe(3);
  });

  it('does not count idle or triage stages as settled', () => {
    expect(allWorkflowsSettled([wf('a', 'idle')]).settled).toBe(false);
    expect(allWorkflowsSettled([wf('a', 'triage')]).settled).toBe(false);
  });
});

describe('handoffOf / checkHandoffRecorded', () => {
  it('accepts a done workflow with a non-empty verification object', () => {
    const w = wf('wf-pump', 'done', { verification: VERIFIED });
    expect(handoffOf(w)).toEqual({ kind: 'verification', verification: VERIFIED });
    const c = checkHandoffRecorded(w);
    expect(c.ok).toBe(true);
    expect(c.name).toBe('handoff/verification persisted for wf-pump');
    expect(c.detail).toContain('recovered');
    expect(c.evidence).toEqual({ workflow_id: 'wf-pump', stage: 'done', handoff: 'verification' });
  });

  it('rejects a done workflow whose verification is missing, empty, null, an array or a string', () => {
    for (const state of [{}, { verification: {} }, { verification: null }, { verification: [] }, { verification: 'ok' }]) {
      const c = checkHandoffRecorded(wf('wf-xid', 'done', state));
      expect(c.ok, JSON.stringify(state)).toBe(false);
      expect(handoffOf(wf('wf-xid', 'done', state))).toBeNull();
    }
    expect(checkHandoffRecorded(wf('wf-xid', 'done')).detail).toBe('stage done: state.verification absent, no escalation_reason');
    expect(checkHandoffRecorded(wf('wf-xid', 'done', { verification: {} })).detail).toContain('empty object');
  });

  it('counts an escalation WITH a reason as a recorded handoff, and without one as missing (L3 semantics)', () => {
    const withReason = wf('wf-xid', 'escalated', { escalation_reason: 'no healthy destination rack' });
    expect(handoffOf(withReason)).toEqual({ kind: 'escalation', reason: 'no healthy destination rack' });
    const ok = checkHandoffRecorded(withReason);
    expect(ok.ok).toBe(true);
    expect(ok.detail).toBe('escalated: no healthy destination rack');
    expect(ok.evidence?.handoff).toBe('escalation');

    expect(checkHandoffRecorded(wf('wf-xid', 'escalated')).ok).toBe(false);
    expect(checkHandoffRecorded(wf('wf-xid', 'escalated', { escalation_reason: '' })).ok).toBe(false);
    expect(checkHandoffRecorded(wf('wf-xid', 'escalated', { escalation_reason: 42 })).ok).toBe(false);
  });

  it('prefers the verification object when an escalated workflow has both', () => {
    const both = wf('wf-xid', 'escalated', { verification: VERIFIED, escalation_reason: 'operator paged' });
    expect(handoffOf(both)?.kind).toBe('verification');
  });

  it('does not accept an escalation_reason on a workflow that is not escalated', () => {
    expect(handoffOf(wf('wf-xid', 'done', { escalation_reason: 'left over from a retry' }))).toBeNull();
    expect(checkHandoffRecorded(wf('wf-xid', 'verify', { escalation_reason: 'still working' })).ok).toBe(false);
  });

  it('produces one independent check per workflow (the pump one passing never covers the Xid one)', () => {
    const checks = [wf('wf-pump', 'done', { verification: VERIFIED }), wf('wf-xid', 'done')].map(checkHandoffRecorded);
    expect(checks.map((c) => c.ok)).toEqual([true, false]);
    expect(new Set(checks.map((c) => c.name)).size).toBe(2);
  });
});
