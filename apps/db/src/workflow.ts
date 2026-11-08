// Workflow coordinator leases (P2-6): claim_workflow, heartbeat_workflow, update_workflow.
//
// Workflow lease ≠ resource lease: this one says which agent worker plans the workflow next
// (short, wall-clock, renewed by heartbeat). Resource leases belong to running actions (P2-5) and
// survive agent death.
//
// Semantics match the db-client mock P3 builds against: CAS on `version` (checked first), then the
// fencing token, owner and expiry. A claim bumps the version and issues a new fencing token
// (from the global sequence shared with action claims, tokens.ts); heartbeat extends the lease without a version bump
// (§0.11 #16); update bumps the version. Reducers return nothing: callers read the `workflow` row.
import { t } from 'spacetimedb/server';
import { validatePayload } from '@dcos/contracts';
import spacetimedb, { type Ctx } from './schema';
import { reject, requireRole } from './auth';
import { nextFencingToken } from './tokens';

type RowOf<K extends keyof Ctx['db']> = Ctx['db'][K] extends { iter(): Iterable<infer R> } ? R : never;
type WorkflowRow = RowOf<'workflow'>;

export const WORKFLOW_STAGES = ['idle', 'triage', 'diagnose', 'plan', 'safety', 'execute', 'replan', 'verify', 'escalated', 'done'] as const;
const MAX_LEASE_MS = 10 * 60_000;

const nowMs = (ctx: Ctx) => Number(ctx.timestamp.toMillis());

function requireLeaseMs(leaseMs: number): void {
  if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS) {
    reject('INVALID_PAYLOAD', `lease_ms must be an integer 1..${MAX_LEASE_MS}`);
  }
}

function findWorkflow(ctx: Ctx, workflowId: string): WorkflowRow {
  const wf = ctx.db.workflow.workflow_id.find(workflowId);
  if (!wf) reject('NOT_FOUND', `workflow ${workflowId}`);
  return wf;
}

function requireVersion(wf: WorkflowRow, expected: number): void {
  if (wf.version !== expected) reject('VERSION_CONFLICT', `workflow ${wf.workflow_id} is v${wf.version}, expected v${expected}`);
}

/** Current lease holder check: token, then owner (when given), then expiry. */
function requireLease(ctx: Ctx, wf: WorkflowRow, token: bigint, workerId?: string): void {
  if (wf.fencing_token !== token) reject('STALE_FENCING_TOKEN', `workflow ${wf.workflow_id} token ${token} (current ${wf.fencing_token})`);
  if (workerId !== undefined && wf.lease_owner !== workerId) {
    reject('LEASE_HELD', `workflow ${wf.workflow_id} is owned by ${wf.lease_owner ?? 'nobody'}`);
  }
  if (wf.lease_expires_unix_ms <= nowMs(ctx)) reject('LEASE_EXPIRED', `workflow ${wf.workflow_id} lease expired`);
}

/** Keep `workflow_incident` rows equal to `incidentIds` for this workflow. */
function syncWorkflowIncidents(ctx: Ctx, wf: WorkflowRow, incidentIds: string[]): void {
  const want = new Set(incidentIds);
  for (const link of [...ctx.db.workflow_incident.workflow_id.filter(wf.workflow_id)]) {
    if (!want.has(link.incident_id)) ctx.db.workflow_incident.link_id.delete(link.link_id);
  }
  for (const incident_id of want) {
    const link_id = `${wf.workflow_id}/${incident_id}`;
    if (!ctx.db.workflow_incident.link_id.find(link_id)) {
      ctx.db.workflow_incident.insert({ link_id, run_id: wf.run_id, workflow_id: wf.workflow_id, incident_id });
    }
  }
}

/** The database's single run (create_run enforces one per database). */
function currentRunId(ctx: Ctx): string {
  for (const r of ctx.db.run.iter()) return r.run_id;
  reject('NOT_FOUND', 'no run exists; call create_run first');
}

export const claim_workflow = spacetimedb.reducer(
  { workflow_id: t.string(), worker_id: t.string(), expected_version: t.u32(), lease_ms: t.u32() },
  (ctx, { workflow_id, worker_id, expected_version, lease_ms }) => {
    requireRole(ctx, 'agent');
    const id = validatePayload('Identifier', workflow_id);
    if (!id.ok) reject('INVALID_PAYLOAD', `workflow_id: ${id.errors.join('; ')}`);
    if (worker_id.trim() === '') reject('INVALID_PAYLOAD', 'worker_id is empty');
    requireLeaseMs(lease_ms);
    const now = nowMs(ctx);

    let wf = ctx.db.workflow.workflow_id.find(workflow_id);
    if (!wf) {
      if (expected_version !== 0) reject('NOT_FOUND', `workflow ${workflow_id} (expected v${expected_version})`);
      wf = ctx.db.workflow.insert({
        workflow_id,
        run_id: currentRunId(ctx),
        stage: 'idle',
        state_json: '{}',
        plan_id: undefined,
        current_command_key: undefined,
        last_processed_event_seq: 0,
        attempt: 0,
        lease_owner: undefined,
        lease_expires_unix_ms: 0,
        fencing_token: 0n,
        updated_at_unix_ms: now,
        version: 0,
      });
    }
    requireVersion(wf, expected_version);
    if (wf.lease_owner !== undefined && wf.lease_owner !== worker_id && wf.lease_expires_unix_ms > now) {
      reject('LEASE_HELD', `workflow ${workflow_id} is leased by ${wf.lease_owner}`);
    }
    ctx.db.workflow.workflow_id.update({
      ...wf,
      lease_owner: worker_id,
      fencing_token: nextFencingToken(ctx), // global sequence shared with action claims
      lease_expires_unix_ms: now + lease_ms,
      attempt: wf.attempt + 1,
      version: wf.version + 1,
      updated_at_unix_ms: now,
    });
  }
);

export const heartbeat_workflow = spacetimedb.reducer(
  { workflow_id: t.string(), worker_id: t.string(), fencing_token: t.u64(), lease_ms: t.u32() },
  (ctx, { workflow_id, worker_id, fencing_token, lease_ms }) => {
    requireRole(ctx, 'agent');
    requireLeaseMs(lease_ms);
    const wf = findWorkflow(ctx, workflow_id);
    requireLease(ctx, wf, fencing_token, worker_id);
    const now = nowMs(ctx);
    ctx.db.workflow.workflow_id.update({ ...wf, lease_expires_unix_ms: now + lease_ms, updated_at_unix_ms: now }); // no version bump
  }
);

/**
 * update_workflow(workflow_id, expected_version, fencing_token, stage, state_json). `state` keys
 * with ledger meaning (as in the mock): `incident_ids` (array → workflow_incident rows),
 * `plan_id` / `current_command_key` (string sets, null clears; absent leaves unchanged).
 */
export const update_workflow = spacetimedb.reducer(
  { workflow_id: t.string(), expected_version: t.u32(), fencing_token: t.u64(), stage: t.string(), state_json: t.string() },
  (ctx, { workflow_id, expected_version, fencing_token, stage, state_json }) => {
    requireRole(ctx, 'agent');
    const wf = findWorkflow(ctx, workflow_id);
    requireVersion(wf, expected_version);
    requireLease(ctx, wf, fencing_token);
    if (!(WORKFLOW_STAGES as readonly string[]).includes(stage)) {
      reject('INVALID_PAYLOAD', `stage must be one of ${WORKFLOW_STAGES.join(', ')}`);
    }
    let state: unknown;
    try {
      state = JSON.parse(state_json);
    } catch {
      reject('INVALID_PAYLOAD', 'state_json is not valid JSON');
    }
    if (typeof state !== 'object' || state === null || Array.isArray(state)) reject('INVALID_PAYLOAD', 'state_json must be a JSON object');
    const s = state as { incident_ids?: unknown; plan_id?: unknown; current_command_key?: unknown };

    const next: WorkflowRow = {
      ...wf,
      stage,
      state_json: JSON.stringify(state),
      version: wf.version + 1,
      updated_at_unix_ms: nowMs(ctx),
    };
    if ('plan_id' in s) next.plan_id = typeof s.plan_id === 'string' ? s.plan_id : undefined;
    if ('current_command_key' in s) next.current_command_key = typeof s.current_command_key === 'string' ? s.current_command_key : undefined;
    ctx.db.workflow.workflow_id.update(next);
    if (Array.isArray(s.incident_ids)) {
      syncWorkflowIncidents(ctx, next, s.incident_ids.filter((x): x is string => typeof x === 'string'));
    }
  }
);
