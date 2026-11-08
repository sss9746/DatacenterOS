import { describe, expect, it } from 'vitest';
import { createMockClient, type ActionDetail } from '@dcos/db-client';
import { evaluateSafety } from '@dcos/physics';
import type { ActionCommand, ActionStatus } from '@dcos/contracts';
import {
  ESTIMATE_NOTE, UNAVAILABLE, actionLabel, buildLedgerRows, describeAction, estimateProgress, filterRows,
  formatEvidence, historyNotes, reasonText, statusIndex, workflowIds,
} from '../src/components/ledger/action-view';
import * as LedgerModule from '../src/components/ledger/Ledger';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const cmd = (over: Partial<ActionCommand> = {}): ActionCommand => ({
  schema_version: '1.1.0', run_id: 'run-demo-1', action_id: 'act-1', command_key: 'wf-1:ckpt:job-a', workflow_id: 'wf-1',
  plan_id: 'plan-1', incident_ids: ['inc-1'], operation: 'checkpoint', target_resource_id: 'job-a', job_id: 'job-a',
  arguments: {}, depends_on_command_keys: [], expected_decision_epoch: 0, expected_resource_versions: {}, requested_sim_time_ms: 600_000,
  ...over,
});
const status = (over: Partial<ActionStatus> = {}): ActionStatus => ({
  schema_version: '1.1.0', run_id: 'run-demo-1', action_id: 'act-1', command_key: 'wf-1:ckpt:job-a', status: 'requested',
  attempt: 1, updated_sim_time_ms: 600_000, result: {}, reason_code: null, version: 1, ...over,
});
const detail = (c: ActionCommand, s: ActionStatus, over: Partial<ActionDetail> = {}): ActionDetail => ({
  status: s, command: c, claimed_by: null, due_sim_time_ms: null, safety: null, start_safety: null, history: [], ...over,
});

async function realClient(snapshot: 'demo' | 'pump_degraded' = 'demo') {
  const db = createMockClient({ snapshot, evaluateSafety });
  let details: ActionDetail[] = [];
  let actions: ActionStatus[] = [];
  db.onActionDetails((d) => (details = d));
  db.onActions((a) => (actions = a));
  return { db, get: () => ({ details, actions }) };
}

describe('ledger view model', () => {
  it('keeps the exported actionLabel / reasonText from Ledger.tsx', () => {
    expect(LedgerModule.actionLabel(status({ status: 'failed', reason_code: 'SAFETY_REJECTED' }))).toBe('BLOCKED');
    expect(LedgerModule.reasonText('EVIDENCE_STALE')).toContain('too old');
    expect(reasonText('JOB_FAILED_DURING_OPERATION')).toContain('failed while');
    expect(reasonText('SOMETHING_NEW')).toBe('something new');
  });

  it('takes the operation from the command, never from the command key', () => {
    // a key that "looks like" a migrate, attached to a checkpoint command
    const c = cmd({ command_key: 'wf-1:migrate_restart:job-a', operation: 'checkpoint' });
    const s = status({ command_key: c.command_key });
    const view = describeAction(s, detail(c, s), new Map(), 600_000);
    expect(view.detail?.operation).toBe('checkpoint');
    expect(view.detail?.operationLabel).toBe('Checkpoint');
    // a status row with no detail yet: nothing is guessed from the key
    const orphan = describeAction(status({ command_key: 'wf-9:migrate_restart:job-b' }), null, new Map(), 600_000);
    expect(orphan.detail).toBeNull();
    expect(JSON.stringify(orphan)).not.toMatch(/Migrate|"migrate_restart"/);
  });

  it('shows status rows whose details have not arrived', () => {
    const rows = buildLedgerRows([status({ command_key: 'k-1' })], [], 600_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toBeNull();
    expect(filterRows(rows, 'all', 'wf-1')).toHaveLength(0); // cannot be attributed to a workflow
    expect(filterRows(rows, 'active', null)).toHaveLength(1);
  });

  it('prefers the newer status version between onActions and onActionDetails', () => {
    const c = cmd();
    const old = status({ version: 1 });
    const fresh = status({ version: 3, status: 'running' });
    expect(statusIndex([fresh], [detail(c, old)]).get(c.command_key)?.status).toBe('running');
    expect(statusIndex([old], [detail(c, fresh)]).get(c.command_key)?.status).toBe('running');
  });

  it('estimates progress only from known start and due times', () => {
    expect(estimateProgress(null, 630_000, 615_000)).toBeNull();
    expect(estimateProgress(600_000, null, 615_000)).toBeNull();
    expect(estimateProgress(600_000, 630_000, null)).toBeNull();
    expect(estimateProgress(600_000, 600_000, 615_000)).toBeNull();
    const p = estimateProgress(600_000, 630_000, 615_000)!;
    expect([p.percent, p.dueReached, p.note]).toEqual([50, false, ESTIMATE_NOTE]);
    expect(estimateProgress(600_000, 630_000, 700_000)).toMatchObject({ percent: 100, dueReached: true });
  });

  it('formats physics evidence as actual vs required, and unknown values as unavailable', () => {
    const items = formatEvidence({
      operation: 'migrate_restart', required_headroom_c: 5, available_headroom_c: 2.5, slowdown_c: 85, lookahead_s: 120,
      power: [{ resource_id: 'node-r6-n1', required_w: 1200, available_w: 400 }],
      checkpoint: { latest_checkpoint_id: null, latest_status: null, latest_accessible: null, satisfied_by_dependency: 'wf-1:ckpt', storage_resource_id: 'ckpt-store-1' },
      mystery_key: { a: 1 },
    });
    const by = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(by.headroom).toMatchObject({ value: expect.stringContaining('actual 2.5 °C · required ≥ 5 °C'), tone: 'danger' });
    expect(by['power-0']).toMatchObject({ value: 'needs 1,200 W · available 400 W', tone: 'danger' });
    expect(by.checkpoint!.value).toContain(`status ${UNAVAILABLE}`);
    expect(by.checkpoint!.value).toContain(`accessible ${UNAVAILABLE}`);
    expect(by.mystery_key).toMatchObject({ label: 'Mystery key', value: 'A: 1' });
    expect(by.operation).toBeUndefined();
    // missing actual headroom is not shown as 0
    expect(formatEvidence({ required_headroom_c: 5 })[0]).toMatchObject({ value: expect.stringContaining(`actual ${UNAVAILABLE}`), tone: null });
  });

  it('reads the BLOCKED reason from the recorded violations, request-time check first, and never invents one', () => {
    const blocked = status({ status: 'failed', reason_code: 'SAFETY_REJECTED', result: { violations: ['DEST_GPU_BUSY', 'DEST_GPU_COUNT_INSUFFICIENT'] } });
    const safety = { decision: 'deny' as const, violations: ['STALE_DECISION_EPOCH', 'DEST_GPU_BUSY'], checked_decision_epoch: 3, evidence: {} };
    // request-time check wins over the status row, keeps the count of further codes
    const withSafety = describeAction(blocked, detail(cmd(), blocked, { safety }), new Map(), 600_000);
    expect(withSafety.blockedReason).toEqual({ code: 'STALE_DECISION_EPOCH', text: reasonText('STALE_DECISION_EPOCH'), source: 'request-time check', more: 1 });
    // start-time recheck when the request-time check allowed it
    const allowed = { decision: 'allow' as const, violations: [], checked_decision_epoch: 3, evidence: {} };
    const atStart = describeAction(blocked, detail(cmd(), blocked, { safety: allowed, start_safety: { ...safety, violations: ['DEST_GPU_UNHEALTHY'] } }), new Map(), 600_000);
    expect(atStart.blockedReason).toMatchObject({ code: 'DEST_GPU_UNHEALTHY', source: 'start-time recheck', more: 0 });
    // status-only row: the ledger row's own violations
    expect(describeAction(blocked, null, new Map(), 600_000).blockedReason).toMatchObject({ code: 'DEST_GPU_BUSY', source: 'ledger row', more: 1 });
    // nothing recorded anywhere → null, never a guessed reason
    expect(describeAction(status({ status: 'failed', reason_code: 'SAFETY_REJECTED' }), null, new Map(), 600_000).blockedReason).toBeNull();
    // not blocked → null even with violations around
    expect(describeAction(status({ status: 'failed', reason_code: 'JOB_FAILED_DURING_OPERATION', result: { violations: ['X'] } }), null, new Map(), 600_000).blockedReason).toBeNull();
    // a command without a job renders no "Job no job"
    const noJob = cmd({ operation: 'cordon_gpu', job_id: null, target_resource_id: 'gpu-r7-n1-0' });
    expect(describeAction(status(), detail(noJob, status()), new Map(), 600_000).detail!.job).toBeNull();
  });

  it('describes history detail payloads', () => {
    expect(historyNotes({ outcome: { status: 'failed', reason_code: 'JOB_FAILED_DURING_OPERATION', sim_time_ms: 630_000 } })[0]).toBe('Outcome failed (JOB_FAILED_DURING_OPERATION) at 00:10:30 sim');
    expect(historyNotes({ verification: { verified: true, note: 'progress advanced' } })).toEqual(['Verified — progress advanced']);
    expect(historyNotes({ start_safety: ['DEST_GPU_UNHEALTHY'] })).toEqual(['Start-time recheck rejected: DEST_GPU_UNHEALTHY']);
    expect(historyNotes({ safety: null })).toEqual(['Safety decision not recorded']);
  });
});

describe('ledger view model on real mock-client details with physics evaluateSafety', () => {
  it('walks a checkpoint through running (estimated) → succeeded (unverified) → verified, and tracks dependencies', async () => {
    const { db, get } = await realClient();
    await db.requestAction(cmd());
    const { fencing_token } = await db.claimAction('wf-1:ckpt:job-a', 1, 'worker-1');
    await db.startAction('wf-1:ckpt:job-a', fencing_token);
    await db.requestAction(cmd({
      action_id: 'act-2', command_key: 'wf-1:mig:job-b', operation: 'migrate_restart', target_resource_id: 'job-b', job_id: 'job-b',
      depends_on_command_keys: ['wf-1:ckpt:job-a'], arguments: { destination_gpu_ids: ['gpu-r6-n1-0'] }, requested_sim_time_ms: 600_001,
    }));
    for (let i = 0; i < 10; i++) db.tick();

    let { details, actions } = get();
    let rows = buildLedgerRows(actions, details, 610_000);
    expect(rows.map((r) => r.commandKey)).toEqual(['wf-1:mig:job-b', 'wf-1:ckpt:job-a']);
    const ck = rows.find((r) => r.commandKey === 'wf-1:ckpt:job-a')!;
    expect(ck.label).toBe('running');
    expect(ck.detail).toMatchObject({ operation: 'checkpoint', job: 'job-a', target: 'job-a', workflowId: 'wf-1', claimedBy: 'worker-1', startedAt: '00:10:00 sim', dueAt: '00:10:30 sim' });
    expect(ck.detail!.progress).toMatchObject({ percent: 33, note: ESTIMATE_NOTE });
    expect(ck.detail!.safety).toMatchObject({ decision: 'allow', label: 'Allowed', violations: [] });
    expect(ck.detail!.history.map((h) => h.label)).toEqual(['requested', 'claimed', 'running']);
    expect(ck.verification).toBeNull();

    const mig = rows.find((r) => r.commandKey === 'wf-1:mig:job-b')!;
    expect(mig.blocked).toBe(true);
    expect(mig.detail!.operation).toBe('migrate_restart');
    expect(mig.detail!.dependencies).toEqual([{ commandKey: 'wf-1:ckpt:job-a', status: 'running', tone: 'neutral', succeeded: false }]);
    // job-b needs 8 GPUs; one destination GPU that job-c already holds → real physics violations, with evidence
    expect(mig.detail!.safety!.violations.map((v) => v.code)).toEqual(expect.arrayContaining(['DEST_GPU_BUSY', 'DEST_GPU_COUNT_INSUFFICIENT']));
    const evidence = Object.fromEntries(mig.detail!.safety!.evidence.map((e) => [e.key, e]));
    expect(evidence.headroom!.value).toMatch(/^actual -?[\d.]+ °C · required ≥ 5 °C/);
    expect(evidence.destination_gpu_ids!.value).toBe('gpu-r6-n1-0');
    expect(filterRows(rows, 'blocked', null).map((r) => r.commandKey)).toEqual(['wf-1:mig:job-b']);
    expect(workflowIds(details)).toEqual(['wf-1']);

    for (let i = 0; i < 25; i++) db.tick();
    ({ details, actions } = get());
    rows = buildLedgerRows(actions, details, 635_000);
    const done = rows.find((r) => r.commandKey === 'wf-1:ckpt:job-a')!;
    expect(done.label).toBe('succeeded');
    expect(done.detail!.progress).toBeNull();
    expect(done.verification).toMatchObject({ state: 'unverified', label: 'Not verified' });
    expect(done.detail!.history.at(-1)!.notes[0]).toMatch(/^Outcome succeeded at /);
    expect(rows.find((r) => r.commandKey === 'wf-1:mig:job-b')!.detail!.dependencies[0]).toMatchObject({ status: 'succeeded', succeeded: true });

    await db.verifyAction('wf-1:ckpt:job-a', { verified: true, note: 'checkpoint complete and readable', checkpoint_id: 'ckpt-x' });
    ({ details, actions } = get());
    const verified = buildLedgerRows(actions, details, 635_000).find((r) => r.commandKey === 'wf-1:ckpt:job-a')!;
    expect(verified.verification).toMatchObject({ state: 'verified', note: 'checkpoint complete and readable' });
    expect(verified.verification!.evidence).toEqual([expect.objectContaining({ label: 'Checkpoint ID', value: 'ckpt-x' })]);

    // the component renders the same data: operation from the command, BLOCKED evidence, a status-only row
    const html = renderToStaticMarkup(createElement(LedgerModule.Ledger, {
      actions: [...actions, status({ command_key: 'wf-2:late:job-c', action_id: 'act-3' })], details, simTimeMs: 635_000,
    }));
    expect(html).toContain('Migrate + restart');
    expect(html).toContain('BLOCKED');
    expect(html).toContain('A destination GPU is already allocated.');
    expect(html).toContain('Details not received yet');
    expect(html).toContain('Verified');
    // three rows; only the blocked one is open by default, and its reason is in the summary, not just the body
    expect((html.match(/<details( open="")?>/g) ?? []).length).toBe(3);
    expect((html.match(/<details open="">/g) ?? []).length).toBe(1);
    const blockedRow = rows.find((r) => r.commandKey === 'wf-1:mig:job-b')!;
    expect(blockedRow.blockedReason).toMatchObject({ code: blockedRow.detail!.safety!.violations[0]!.code, source: 'request-time check', more: 2 });
    expect(html).toContain(`<span class="ledger-blocked-reason">${blockedRow.blockedReason!.text} <code class="ledger-inline-code">${blockedRow.blockedReason!.code}</code>`);
    expect(html).not.toContain('Job no job');
    db.close();
  });

  it('marks a running action without a due time as unavailable instead of estimating', () => {
    const c = cmd();
    const s = status({ status: 'running', version: 3 });
    const view = describeAction(s, detail(c, s, { history: [{ status: 'running', version: 3, sim_time_ms: 600_000, observed_unix_ms: 0, reason_code: null, detail: {} }] }), new Map(), 610_000);
    expect(view.detail!.progress).toBeNull();
    expect(view.detail!.dueAt).toBe(UNAVAILABLE);
    expect(view.detail!.progressNote).toMatch(/due time not recorded/);
    expect(actionLabel(s)).toBe('running');
  });
});
