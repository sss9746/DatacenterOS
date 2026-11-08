// Durable action ledger (P2-5; kit §6, CONTRACTS §C invariants, §0.11 #2/#3/#13).
//
// Lifecycle: requested → claimed → running → succeeded | failed | cancelled | needs_reconciliation.
// Every transition bumps `action.version` and appends an `action_event`.
//
// Reducers can't return values: callers read the `action` row (by command_key) after the call.
// claim_action's fencing token is that row's `lease_token`.
//
// Leases (`resource_lease`, one row per locked resource):
//   - claim locks the whole closure, built here from the command and the world (never from caller
//     IDs alone), in sorted order, all-or-nothing, with a fresh, globally monotonic fencing token.
//   - a claimed, never-started lease expires after CLAIM_LEASE_MS; an expired claim is ignored by
//     other claims and the action can be claimed again (new token, so the old worker's start fails).
//   - a running action's leases never expire; only success / failure / cancel / reconciliation
//     release them, so an agent crash can't strand or double-book resources.
//
// Physics owns timing and completion: start_action enqueues the command into the private world
// (`enqueueCommands`); the next advance_tick passes its action_id in `requested_action_ids`, copies
// the physics due time into `due_sim_time_ms`, and settles completed/failed keys (`settleActions`).
import { t } from 'spacetimedb/server';
import {
  validatePayload,
  type ActionCommand,
  type ActionStatus,
  type PhysicsWorld,
  type SafetyDecision,
} from '@dcos/contracts';
import { commandOutcome, enqueueCommands, evaluateSafety, inFlightCommands, toObserved } from '@dcos/physics';
import spacetimedb, { type Ctx } from './schema';
import { reject, requireRole } from './auth';
import { loadWorld, saveWorld } from './run';
import { sha256Hex, stableStringify } from './hash';
import { nextFencingToken } from './tokens';

type RowOf<K extends keyof Ctx['db']> = Ctx['db'][K] extends { iter(): Iterable<infer R> } ? R : never;
type ActionRow = RowOf<'action'>;
type ActionState = ActionStatus['status'];

/** A claimed, never-started action's leases expire after this long (wall time). */
export const CLAIM_LEASE_MS = 15_000;
/** Running leases are held under DB supervision until the action settles. */
const NEVER_MS = 8.64e15;

const nowMs = (ctx: Ctx) => Number(ctx.timestamp.toMillis());
const simNow = (ctx: Ctx, runId: string) => ctx.db.run.run_id.find(runId)?.sim_time_ms ?? 0;

export function payloadHash(cmd: ActionCommand): string {
  const { requested_sim_time_ms: _ignored, ...rest } = cmd;
  return sha256Hex(stableStringify(rest));
}

function parseJsonObject(field: string, text: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    reject('INVALID_PAYLOAD', `${field} is not valid JSON`);
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) reject('INVALID_PAYLOAD', `${field} must be a JSON object`);
  return v as Record<string, unknown>;
}

/**
 * The one execution rule, used at request and at start (§0.13 #5): any §0.7 violation blocks,
 * incl. EVIDENCE_STALE. Only a needs_approval with no violation (approval reasons in evidence) stays
 * executable; the agent/UI gate it (§0.11 #17).
 */
const isRejected = (d: SafetyDecision): boolean =>
  d.decision !== 'allow' && (d.decision !== 'needs_approval' || d.violations.length > 0);

const commandOf = (row: ActionRow): ActionCommand => {
  const result = JSON.parse(row.result_json) as { command?: ActionCommand };
  if (!result.command) throw new Error(`action ${row.command_key} has no stored command`);
  return result.command;
};

function findAction(ctx: Ctx, commandKey: string): ActionRow {
  const row = ctx.db.action.command_key.find(commandKey);
  if (!row) reject('NOT_FOUND', `no action ${commandKey}`);
  return row;
}

/** Apply a transition: status/patch, version+1, updated time, one action_event. */
function transition(
  ctx: Ctx,
  row: ActionRow,
  status: ActionState,
  patch: Partial<ActionRow> = {},
  detail: Record<string, unknown> = {}
): ActionRow {
  const next: ActionRow = {
    ...row,
    ...patch,
    status,
    version: row.version + 1,
    updated_sim_time_ms: simNow(ctx, row.run_id),
  };
  ctx.db.action.action_id.update(next);
  appendEvent(ctx, next, detail);
  return next;
}

function appendEvent(ctx: Ctx, row: ActionRow, detail: Record<string, unknown>): void {
  ctx.db.action_event.insert({
    action_event_id: 0n,
    run_id: row.run_id,
    action_id: row.action_id,
    command_key: row.command_key,
    status: row.status,
    sim_time_ms: row.updated_sim_time_ms,
    observed_unix_ms: nowMs(ctx),
    reason_code: row.reason_code,
    detail_json: JSON.stringify({ version: row.version, ...detail }),
  });
}

function patchResult(row: ActionRow, add: Record<string, unknown>): string {
  return JSON.stringify({ ...(JSON.parse(row.result_json) as Record<string, unknown>), ...add });
}

// ---------------------------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------------------------

type LeaseRow = RowOf<'resource_lease'>;

/** A lease counts unless it belongs to a claimed (never-started) action whose claim expired. */
function leaseIsLive(ctx: Ctx, lease: LeaseRow): boolean {
  if (lease.expires_at_unix_ms > nowMs(ctx)) return true;
  const owner = ctx.db.action.action_id.find(lease.action_id);
  return owner?.status === 'running';
}

/** Resources reserved by live leases of OTHER actions (evaluateSafety's `leased_resource_ids`). */
function leasedByOthers(ctx: Ctx, runId: string, exceptActionId?: string): string[] {
  return [...ctx.db.resource_lease.iter()]
    .filter((l) => l.run_id === runId && l.action_id !== exceptActionId && leaseIsLive(ctx, l))
    .map((l) => l.resource_id)
    .sort();
}

function releaseLeases(ctx: Ctx, actionId: string): void {
  const mine = [...ctx.db.resource_lease.iter()].filter((l) => l.action_id === actionId);
  for (const l of mine) ctx.db.resource_lease.resource_id.delete(l.resource_id);
}

const parentOf = (world: PhysicsWorld, id: string) =>
  world.observable.resources.find((r) => r.resource_id === id)?.parent_id ?? null;

/**
 * Resources an action locks (kit §C: built inside the trusted reducer). Job + its current GPUs;
 * migrate adds the destination GPUs and their nodes and racks; GPU ops lock the GPU. `escalate`
 * locks nothing, so a human hand-off is never blocked.
 */
export function closureOf(world: PhysicsWorld, cmd: ActionCommand): string[] {
  if (cmd.operation === 'escalate') return [];
  const obs = world.observable;
  const ids = new Set<string>([cmd.target_resource_id]);
  const jobId = cmd.job_id ?? (obs.job_states.some((j) => j.job_id === cmd.target_resource_id) ? cmd.target_resource_id : null);
  const job = jobId ? obs.job_states.find((j) => j.job_id === jobId) : undefined;
  if (jobId) ids.add(jobId);
  job?.allocated_gpu_ids.forEach((g) => ids.add(g));
  // A node target (e.g. node-scoped power_cap) acts on every GPU of the node: lock them too, so a
  // GPU-scoped command can't claim one of them concurrently.
  obs.gpus.filter((g) => g.node_id === cmd.target_resource_id).forEach((g) => ids.add(g.resource_id));

  if (cmd.operation === 'migrate_restart') {
    const args = cmd.arguments as { destination_gpu_ids?: unknown; destination_node_ids?: unknown };
    const destGpus = Array.isArray(args.destination_gpu_ids) ? args.destination_gpu_ids.filter((g): g is string => typeof g === 'string') : [];
    const destNodes = Array.isArray(args.destination_node_ids) ? args.destination_node_ids.filter((n): n is string => typeof n === 'string') : [];
    const nodes = new Set(destNodes);
    for (const g of destGpus) {
      ids.add(g);
      const node = parentOf(world, g);
      if (node) nodes.add(node);
    }
    for (const n of nodes) {
      ids.add(n);
      obs.gpus.filter((g) => g.node_id === n).forEach((g) => ids.add(g.resource_id)); // whole destination node
      const rack = parentOf(world, n); // destination rack: serialises moves onto the same rack
      if (rack) ids.add(rack);
    }
  }
  return [...ids].sort();
}

/** Current version of a GPU / node / cooling row or job (undefined when unversioned or unknown). */
function versionOf(world: PhysicsWorld, id: string): number | undefined {
  const o = world.observable;
  return (
    o.gpus.find((g) => g.resource_id === id)?.version ??
    o.nodes.find((n) => n.resource_id === id)?.version ??
    o.cooling.find((c) => c.resource_id === id)?.version ??
    o.job_states.find((j) => j.job_id === id)?.version
  );
}

// ---------------------------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------------------------

/**
 * request_action(action_command_json): validate, dedupe by command_key + payload_hash, fresh
 * evaluateSafety. A deny or stale snapshot persists the action as `failed` / SAFETY_REJECTED with
 * the violations in result (§0.11 #3: returned, not thrown). `needs_approval` is persisted as
 * `requested`; the agent/UI gate it (§0.11 #17). Bad payloads and key collisions throw.
 */
export const request_action = spacetimedb.reducer({ action_command_json: t.string() }, (ctx, { action_command_json }) => {
  requireRole(ctx, 'agent');
  const raw = parseJsonObject('action_command_json', action_command_json);
  const v = validatePayload('ActionCommand', raw);
  if (!v.ok) reject('INVALID_PAYLOAD', `ActionCommand: ${v.errors.slice(0, 5).join('; ')}`);
  const cmd = raw as unknown as ActionCommand;
  const hash = payloadHash(cmd);

  const existing = ctx.db.action.command_key.find(cmd.command_key);
  if (existing) {
    if (existing.payload_hash === hash) return; // idempotent retry: no side effects
    reject('COMMAND_KEY_COLLISION', `command_key ${cmd.command_key} reused with a different payload`);
  }
  if (ctx.db.action.action_id.find(cmd.action_id)) {
    reject('INVALID_PAYLOAD', `action_id ${cmd.action_id} already used by another command_key`);
  }
  const run = ctx.db.run.run_id.find(cmd.run_id);
  if (!run) reject('NOT_FOUND', `run ${cmd.run_id} does not exist`);

  const world = loadWorld(ctx, cmd.run_id);
  const decision: SafetyDecision = evaluateSafety(toObserved(world), cmd, {
    decision_epoch: run.decision_epoch,
    leased_resource_ids: leasedByOthers(ctx, cmd.run_id),
  });
  const rejected = isRejected(decision);
  const safety = { decision: decision.decision, violations: decision.violations, checked_decision_epoch: decision.checked_decision_epoch, evidence: decision.evidence };

  const row: ActionRow = {
    action_id: cmd.action_id,
    command_key: cmd.command_key,
    run_id: cmd.run_id,
    workflow_id: cmd.workflow_id,
    plan_id: cmd.plan_id,
    operation: cmd.operation,
    target_resource_id: cmd.target_resource_id,
    job_id: cmd.job_id ?? undefined,
    payload_hash: hash,
    args_json: JSON.stringify(cmd.arguments),
    incident_ids_json: JSON.stringify(cmd.incident_ids),
    depends_on_command_keys_json: JSON.stringify(cmd.depends_on_command_keys),
    expected_versions_json: JSON.stringify(cmd.expected_resource_versions),
    expected_decision_epoch: cmd.expected_decision_epoch,
    requested_sim_time_ms: cmd.requested_sim_time_ms,
    due_sim_time_ms: undefined,
    status: rejected ? 'failed' : 'requested',
    attempt: 1,
    claimed_by: undefined,
    lease_token: 0n,
    // `command` is the stored payload the ledger replays into physics; `violations` per §0.11 #3.
    result_json: JSON.stringify(rejected ? { violations: decision.violations, safety, command: cmd } : { safety, command: cmd }),
    reason_code: rejected ? 'SAFETY_REJECTED' : undefined,
    updated_sim_time_ms: run.sim_time_ms,
    version: 1,
  };
  ctx.db.action.insert(row);
  appendEvent(ctx, row, { safety });

  for (const depKey of cmd.depends_on_command_keys) {
    const dep = ctx.db.action.command_key.find(depKey);
    if (!dep) continue; // dependency not requested yet; depends_on_command_keys_json keeps the link
    const dep_id = `${cmd.action_id}/${dep.action_id}`;
    if (!ctx.db.action_dependency.dep_id.find(dep_id)) {
      ctx.db.action_dependency.insert({ dep_id, run_id: cmd.run_id, action_id: cmd.action_id, depends_on_action_id: dep.action_id });
    }
  }
});

/** claim_action(command_key, expected_action_version, worker_id): lock the closure; token = row.lease_token. */
export const claim_action = spacetimedb.reducer(
  { command_key: t.string(), expected_action_version: t.u32(), worker_id: t.string() },
  (ctx, { command_key, expected_action_version, worker_id }) => {
    requireRole(ctx, 'agent');
    if (worker_id.trim() === '') reject('INVALID_PAYLOAD', 'worker_id is empty');
    const row = findAction(ctx, command_key);
    if (row.version !== expected_action_version) {
      reject('VERSION_CONFLICT', `action ${command_key} is v${row.version}, expected v${expected_action_version}`);
    }
    if (row.status === 'claimed') {
      const own = [...ctx.db.resource_lease.iter()].filter((l) => l.action_id === row.action_id);
      if (own.some((l) => l.expires_at_unix_ms > nowMs(ctx))) {
        reject('LEASE_HELD', `${command_key} is claimed by ${row.claimed_by ?? 'another worker'}`);
      }
    } else if (row.status !== 'requested') {
      reject('INVALID_TRANSITION', `cannot claim ${command_key} from ${row.status}`);
    }

    const world = loadWorld(ctx, row.run_id);
    const closure = closureOf(world, commandOf(row)); // sorted: locks are taken in ID order
    for (const id of closure) {
      const lease = ctx.db.resource_lease.resource_id.find(id);
      if (lease && lease.action_id !== row.action_id && leaseIsLive(ctx, lease)) {
        reject('LEASE_HELD', `${id} is reserved by action ${lease.action_id}`);
      }
    }

    releaseLeases(ctx, row.action_id); // drop any expired leases of a previous claim
    const token = nextFencingToken(ctx);
    const expires = nowMs(ctx) + CLAIM_LEASE_MS;
    for (const id of closure) {
      const lease = { resource_id: id, run_id: row.run_id, action_id: row.action_id, workflow_id: row.workflow_id, expires_at_unix_ms: expires, fencing_token: token };
      if (ctx.db.resource_lease.resource_id.find(id)) ctx.db.resource_lease.resource_id.update(lease);
      else ctx.db.resource_lease.insert(lease);
    }
    transition(
      ctx,
      row,
      'claimed',
      {
        claimed_by: worker_id,
        lease_token: token,
        attempt: row.status === 'claimed' ? row.attempt + 1 : row.attempt,
        result_json: patchResult(row, { claimed_by: worker_id }),
      },
      { worker_id, fencing_token: token.toString(), locked: closure }
    );
  }
);

/**
 * start_action(command_key, fencing_token): fencing + lease ownership + dependencies succeeded +
 * expected versions still current (resources changed by its own dependencies excepted, e.g. the
 * job version a finished checkpoint bumped). Enqueues the command into physics; the next tick
 * starts it (physics creates the `writing` checkpoint) and fills `due_sim_time_ms`.
 */
export const start_action = spacetimedb.reducer(
  { command_key: t.string(), fencing_token: t.u64() },
  (ctx, { command_key, fencing_token }) => {
    requireRole(ctx, 'agent');
    const row = findAction(ctx, command_key);
    if (row.status !== 'claimed') reject('INVALID_TRANSITION', `cannot start ${command_key} from ${row.status}`);
    if (row.lease_token !== fencing_token) reject('STALE_FENCING_TOKEN', `token ${fencing_token} for ${command_key}`);

    const cmd = commandOf(row);
    let world = loadWorld(ctx, row.run_id);
    const closure = closureOf(world, cmd);
    for (const id of closure) {
      const lease = ctx.db.resource_lease.resource_id.find(id);
      if (!lease || lease.action_id !== row.action_id || lease.fencing_token !== fencing_token) {
        reject('LEASE_EXPIRED', `${command_key} no longer holds ${id}`);
      }
      if (lease.expires_at_unix_ms <= nowMs(ctx)) {
        reject('LEASE_EXPIRED', `${command_key}'s claim expired; claim it again`);
      }
    }

    const depClosure = new Set<string>();
    for (const depKey of cmd.depends_on_command_keys) {
      const dep = ctx.db.action.command_key.find(depKey);
      if (dep?.status !== 'succeeded') reject('INVALID_TRANSITION', `${command_key} depends on ${depKey}, which has not succeeded`);
      closureOf(world, commandOf(dep)).forEach((id) => depClosure.add(id));
      if (dep.job_id) depClosure.add(dep.job_id);
    }

    const stale = Object.entries(cmd.expected_resource_versions)
      .filter(([id, v]) => !depClosure.has(id) && versionOf(world, id) !== undefined && versionOf(world, id) !== v)
      .map(([id]) => id);
    if (stale.length > 0) {
      // Same outcome as a stale version at request time: failed / SAFETY_REJECTED, returned not thrown.
      const violations = ['STALE_RESOURCE_VERSION'];
      const evidence = { stale_resource_ids: stale };
      releaseLeases(ctx, row.action_id);
      transition(
        ctx,
        row,
        'failed',
        { reason_code: 'SAFETY_REJECTED', result_json: patchResult(row, { violations, stale_resource_ids: stale, start_safety: { decision: 'retry_new_snapshot', violations, evidence } }) },
        { start_safety: violations, stale_resource_ids: stale }
      );
      return;
    }

    // Fresh safety check before dispatch: physics only checks physical feasibility, so thermal /
    // power headroom and evidence age must still hold now. Versions were checked above (with the
    // dependency exception), so the command is restamped to the current epoch/versions here; every
    // other violation, incl. EVIDENCE_STALE that appeared after the request, blocks the start.
    const run = ctx.db.run.run_id.find(row.run_id)!;
    const recheck = evaluateSafety(
      toObserved(world),
      { ...cmd, expected_decision_epoch: run.decision_epoch, expected_resource_versions: {} },
      { decision_epoch: run.decision_epoch, leased_resource_ids: leasedByOthers(ctx, row.run_id, row.action_id) }
    );
    if (isRejected(recheck)) {
      releaseLeases(ctx, row.action_id);
      transition(
        ctx,
        row,
        'failed',
        { reason_code: 'SAFETY_REJECTED', result_json: patchResult(row, { violations: recheck.violations, start_safety: { decision: recheck.decision, violations: recheck.violations, evidence: recheck.evidence } }) },
        { start_safety: recheck.violations }
      );
      return;
    }

    world = enqueueCommands(world, [cmd]);
    saveWorld(ctx, world);
    for (const id of closure) {
      const lease = ctx.db.resource_lease.resource_id.find(id)!;
      ctx.db.resource_lease.resource_id.update({ ...lease, expires_at_unix_ms: NEVER_MS });
    }
    transition(ctx, row, 'running', {}, { enqueued: true });
  }
);

/**
 * cancel_action(command_key, reason_code, fencing_token): only `requested` / `claimed`. The token is
 * the action's own lease token, or the owning workflow's token while its lease is live (§0.11 #13).
 */
export const cancel_action = spacetimedb.reducer(
  { command_key: t.string(), reason_code: t.string(), fencing_token: t.u64() },
  (ctx, { command_key, reason_code, fencing_token }) => {
    requireRole(ctx, 'agent');
    if (!/^[A-Z][A-Z0-9_]*$/.test(reason_code)) reject('INVALID_PAYLOAD', 'reason_code must be UPPER_SNAKE_CASE');
    const row = findAction(ctx, command_key);
    const ownToken = row.lease_token !== 0n && row.lease_token === fencing_token;
    const wf = ctx.db.workflow.workflow_id.find(row.workflow_id);
    const wfToken = !!wf && wf.fencing_token === fencing_token && wf.lease_expires_unix_ms > nowMs(ctx);
    if (!ownToken && !wfToken) reject('STALE_FENCING_TOKEN', `token ${fencing_token} for ${command_key}`);
    if (row.status !== 'requested' && row.status !== 'claimed') {
      reject('INVALID_TRANSITION', `cannot cancel ${command_key} from ${row.status}`);
    }
    releaseLeases(ctx, row.action_id);
    transition(ctx, row, 'cancelled', { reason_code }, { by: ownToken ? 'action_token' : 'workflow_token' });
  }
);

/** verify_action(command_key, evidence_json): records verification on a succeeded action. */
export const verify_action = spacetimedb.reducer(
  { command_key: t.string(), evidence_json: t.string() },
  (ctx, { command_key, evidence_json }) => {
    requireRole(ctx, 'agent');
    const evidence = parseJsonObject('evidence_json', evidence_json);
    const row = findAction(ctx, command_key);
    if (row.status !== 'succeeded') reject('INVALID_TRANSITION', `cannot verify ${command_key} in ${row.status}`);
    transition(ctx, row, 'succeeded', { result_json: patchResult(row, { verification: evidence }) }, { verification: evidence });
  }
);

// ---------------------------------------------------------------------------------------------
// Tick hooks (called by advance_tick)
// ---------------------------------------------------------------------------------------------

/** Running actions of a run (index scan, not the whole history). */
const runningActions = (ctx: Ctx, runId: string): ActionRow[] => [...ctx.db.action.by_run_status.filter([runId, 'running'])];

/** action_ids of running actions physics hasn't started yet (no due time). */
export function actionsToStart(ctx: Ctx, runId: string): string[] {
  return runningActions(ctx, runId)
    .filter((a) => a.due_sim_time_ms === undefined)
    .map((a) => a.action_id)
    .sort();
}

/**
 * After a physics step: copy due times of newly started commands, then settle finished ones.
 * Physics already revalidated command-specific prerequisites at completion. A running action that
 * physics no longer knows (not in flight, no outcome) becomes needs_reconciliation.
 */
export function settleActions(ctx: Ctx, world: PhysicsWorld, completed: string[], failed: string[]): void {
  const inFlight = new Map(inFlightCommands(world).map((f) => [f.command_key, f]));
  const running = runningActions(ctx, world.run_id);
  const done = new Set([...completed, ...failed]);

  for (const row of running) {
    const f = inFlight.get(row.command_key);
    if (f && row.due_sim_time_ms === undefined) {
      const next = { ...row, due_sim_time_ms: f.due_sim_time_ms, result_json: patchResult(row, { due_sim_time_ms: f.due_sim_time_ms }) };
      ctx.db.action.action_id.update(next);
    }
  }

  for (const key of done) {
    const row = ctx.db.action.command_key.find(key);
    if (!row || row.status !== 'running') continue;
    const outcome = commandOutcome(world, key);
    const ok = completed.includes(key) && (outcome ? outcome.status === 'succeeded' : true);
    releaseLeases(ctx, row.action_id);
    transition(
      ctx,
      row,
      ok ? 'succeeded' : 'failed',
      { reason_code: ok ? undefined : (outcome?.reason_code ?? 'JOB_FAILED_DURING_OPERATION'), result_json: patchResult(row, { outcome }) },
      { outcome }
    );
  }

  // Lost track: started (has a due time), not in flight, no outcome, not settled above.
  for (const row of running) {
    if (done.has(row.command_key) || row.due_sim_time_ms === undefined || inFlight.has(row.command_key)) continue;
    if (commandOutcome(world, row.command_key)) continue;
    const cur = ctx.db.action.action_id.find(row.action_id)!;
    if (cur.status !== 'running') continue;
    releaseLeases(ctx, row.action_id);
    transition(ctx, cur, 'needs_reconciliation', { reason_code: 'PHYSICS_LOST_COMMAND' }, {});
  }
}
