// P3-7 replan. Two pieces:
//
//  1. `createReplanWatcher` subscribes to db.onChange while a plan executes and flags an abort (checked by
//     the coordinator before each new command via `shouldAbort`) when something MATERIAL happens to a
//     resource the active plan touches (ARCHITECTURE §3, §4):
//       (a) a signal (warning/critical) on a touched resource: a command target, a job, the job's current
//           GPUs, a migrate destination GPU, or the node/rack hosting one of those GPUs;
//       (b) a resource_version bump on a touched resource that our own running/succeeded commands do not
//           explain (a checkpoint bumping job-a's version is expected, an XID bumping a destination GPU is not);
//       (c) a decision_epoch advance where a fresh snapshot shows availability / XID / foreign allocation
//           changed on a touched GPU or node (or a destination GPU is no longer healthy). Routine metric
//           drift (temperatures, power) never aborts.
//
//  2. `runReplan` supersedes the previous plan (ARCHITECTURE §6): cancel only safe-to-cancel prior actions
//     (requested, or claimed by us), never touch running/succeeded ones; keep completed checkpoints; rerun
//     triage so the new failure becomes its own incident; plan again with a new attempt number (new command
//     keys) over all open incidents of the workflow, never targeting GPUs still reserved by prior running
//     actions; persist stage `replan`.

import type { ActionCommand, ActionStatus, Incident, ObservedSnapshot, SignalEvent } from '@dcos/contracts';
import type { CommandOutcome, ExecutablePlan, ExecutionResult } from './coordinator.js';
import type { EventPublisher } from './events.js';
import { planIncidents, planNarrative, type JobPlan, type PlanResult, type RankedOption } from './planner.js';
import { isDbError, type DbChange, type DbPort, type LlmPort, type PhysicsPort, type ToolCallSummary } from './ports.js';
import { runTriage } from './triage.js';

// ---------------------------------------------------------------------------------------------- watcher

export interface ReplanWatcher {
  shouldAbort(): boolean;
  reason(): string | null;
  reset(plan: ExecutablePlan | null): void;
  dispose(): void;
}

/** Cancel reason recorded on superseded actions. */
export const SUPERSEDED_REASON = 'SUPERSEDED';

const destinationsOf = (c: ActionCommand): string[] =>
  c.operation === 'migrate_restart' && Array.isArray(c.arguments.destination_gpu_ids)
    ? (c.arguments.destination_gpu_ids as string[])
    : [];

/** Resource id -> human role ("planned destination for job-a"). First role wins. */
type Roles = Map<string, string>;

const addRole = (roles: Roles, id: string, role: string): void => {
  if (!roles.has(id)) roles.set(id, role);
};

/** Roles known without a snapshot: targets, jobs, destination GPUs. */
function directRoles(plan: ExecutablePlan): Roles {
  const roles: Roles = new Map();
  for (const c of plan.commands) {
    const job = c.job_id ?? null;
    for (const g of destinationsOf(c)) addRole(roles, g, `planned destination for ${job ?? c.target_resource_id}`);
  }
  for (const c of plan.commands) {
    if (c.job_id) addRole(roles, c.job_id, `job in the active plan`);
    addRole(roles, c.target_resource_id, `${c.operation} target`);
  }
  return roles;
}

interface Topology {
  roles: Roles;
  /** Touched GPU ids -> fingerprint of the material fields. */
  gpuFp: Map<string, string>;
  nodeFp: Map<string, string>;
  destGpus: Set<string>;
}

function planJobs(plan: ExecutablePlan): Set<string> {
  return new Set(plan.commands.map((c) => c.job_id).filter((j): j is string => !!j));
}

function gpuFingerprint(snap: ObservedSnapshot, gpuId: string, ownJobs: Set<string>): string {
  const g = snap.gpus.find((x) => x.resource_id === gpuId);
  if (!g) return 'missing';
  const foreign = snap.allocations
    .filter((a) => a.gpu_id === gpuId && !ownJobs.has(a.job_id))
    .map((a) => a.job_id)
    .sort()
    .join(',');
  return `${g.availability}|${g.last_xid_code ?? '-'}|${foreign}`;
}

function nodeFingerprint(snap: ObservedSnapshot, nodeId: string): string {
  return snap.nodes.find((n) => n.resource_id === nodeId)?.availability ?? 'missing';
}

/** Full touched set from a snapshot: adds the jobs' current GPUs and the nodes/racks hosting touched GPUs. */
function buildTopology(plan: ExecutablePlan, snap: ObservedSnapshot): Topology {
  const roles = directRoles(plan);
  const jobs = planJobs(plan);
  const destGpus = new Set(plan.commands.flatMap(destinationsOf));
  for (const js of snap.job_states) {
    if (!jobs.has(js.job_id)) continue;
    for (const g of js.allocated_gpu_ids) addRole(roles, g, `currently running ${js.job_id}`);
  }
  const gpuIds = [...roles.keys()].filter((id) => snap.gpus.some((g) => g.resource_id === id));
  const nodeIds = new Set<string>();
  for (const gid of gpuIds) {
    const g = snap.gpus.find((x) => x.resource_id === gid)!;
    const node = snap.nodes.find((n) => n.resource_id === g.node_id);
    const role = roles.get(gid)!;
    addRole(roles, g.node_id, `hosts ${gid} (${role})`);
    nodeIds.add(g.node_id);
    if (node) addRole(roles, node.rack_id, `hosts ${gid} (${role})`);
  }
  return {
    roles,
    gpuFp: new Map(gpuIds.map((id) => [id, gpuFingerprint(snap, id, jobs)])),
    nodeFp: new Map([...nodeIds].map((id) => [id, nodeFingerprint(snap, id)])),
    destGpus,
  };
}

/** First material difference between the baseline topology and a fresh snapshot, as a reason string. */
function materialChange(plan: ExecutablePlan, base: Topology, fresh: ObservedSnapshot): string | null {
  const jobs = planJobs(plan);
  for (const [id, fp] of base.gpuFp) {
    const now = gpuFingerprint(fresh, id, jobs);
    const g = fresh.gpus.find((x) => x.resource_id === id);
    const unhealthyDest = base.destGpus.has(id) && (!g || g.availability !== 'ready' || g.last_xid_code !== null);
    if (now !== fp || unhealthyDest) {
      const what = g ? (g.last_xid_code !== null ? `XID ${g.last_xid_code}` : g.availability) : 'missing';
      return `${what} on ${id} (${base.roles.get(id) ?? 'in the active plan'})`;
    }
  }
  for (const [id, fp] of base.nodeFp) {
    const now = nodeFingerprint(fresh, id);
    if (now !== fp) return `${id} is ${now} (${base.roles.get(id) ?? 'in the active plan'})`;
  }
  return null;
}

function signalReason(sig: SignalEvent, role: string): string {
  const what = sig.event_type === 'xid_error' && sig.xid_code !== null ? `XID ${sig.xid_code}` : sig.event_type.replace(/_/g, ' ');
  return `${what} on ${sig.resource_id} (${role})`;
}

export function createReplanWatcher(deps: { db: DbPort }, plan: ExecutablePlan | null): ReplanWatcher {
  const { db } = deps;
  let active: ExecutablePlan | null = null;
  let roles: Roles = new Map();
  let topology: Promise<Topology | null> = Promise.resolve(null);
  let keys = new Set<string>();
  /** Resources our own running/succeeded commands are expected to change. */
  let ownChanged = new Set<string>();
  let abortReason: string | null = null;
  let generation = 0;

  const flag = (gen: number, why: string): void => {
    if (gen === generation && active && abortReason === null) abortReason = why;
  };

  const load = (p: ExecutablePlan, gen: number): Promise<Topology | null> =>
    db.getObservedSnapshot().then(
      (snap) => {
        if (gen !== generation) return null;
        const t = buildTopology(p, snap);
        roles = t.roles;
        return t;
      },
      () => null, // no snapshot: fall back to direct roles only
    );

  const reset = (p: ExecutablePlan | null): void => {
    generation += 1;
    active = p;
    abortReason = null;
    ownChanged = new Set();
    keys = new Set(p?.commands.map((c) => c.command_key) ?? []);
    roles = p ? directRoles(p) : new Map();
    topology = p ? load(p, generation) : Promise.resolve(null);
    if (p) seedOwn(p, generation);
  };

  /**
   * A watcher attached to an already-running plan (resume after a crash) never saw the `running` status
   * events of adopted actions: read their ledger rows once so their own effects are not mistaken for news.
   */
  const seedOwn = (p: ExecutablePlan, gen: number): void => {
    for (const c of p.commands) {
      void db.getActionStatus(c.command_key).then(
        (s) => {
          if (s && gen === generation) onOwnStatus(s);
        },
        () => undefined,
      );
    }
  };

  const onOwnStatus = (s: ActionStatus): void => {
    if (!active || !keys.has(s.command_key)) return;
    if (s.status !== 'running' && s.status !== 'succeeded') return;
    const cmd = active.commands.find((c) => c.command_key === s.command_key);
    if (!cmd) return;
    ownChanged.add(cmd.target_resource_id);
    if (cmd.job_id) ownChanged.add(cmd.job_id);
    for (const g of destinationsOf(cmd)) ownChanged.add(g);
  };

  const onChange = (change: DbChange): void => {
    if (!active || abortReason !== null) return;
    const gen = generation;
    const p = active;
    switch (change.kind) {
      case 'action_status':
        onOwnStatus(change.status);
        return;
      case 'signal': {
        const sig = change.signal;
        if (sig.severity === 'info') return;
        const role = roles.get(sig.resource_id);
        if (role) return flag(gen, signalReason(sig, role));
        // Node/rack/current-GPU roles need the snapshot; decide once it has loaded.
        void topology.then((t) => {
          const r = t?.roles.get(sig.resource_id);
          if (r) flag(gen, signalReason(sig, r));
        });
        return;
      }
      case 'resource_version': {
        if (ownChanged.has(change.resource_id)) return;
        const check = (r: string | undefined): void => {
          if (r && !ownChanged.has(change.resource_id)) flag(gen, `${change.resource_id} changed to v${change.version} (${r})`);
        };
        const role = roles.get(change.resource_id);
        if (role) return check(role);
        void topology.then((t) => check(t?.roles.get(change.resource_id)));
        return;
      }
      case 'decision_epoch':
        void (async () => {
          const base = await topology;
          if (!base || gen !== generation) return;
          const fresh = await db.getObservedSnapshot().catch(() => null);
          if (!fresh) return;
          const why = materialChange(p, base, fresh);
          if (why) flag(gen, why);
        })();
        return;
    }
  };

  const unsubscribe = db.onChange(onChange);
  reset(plan);

  return {
    shouldAbort: () => abortReason !== null,
    reason: () => abortReason,
    reset,
    dispose: () => {
      generation += 1;
      active = null;
      unsubscribe();
    },
  };
}

// ---------------------------------------------------------------------------------------------- runReplan

export interface ReplanOutcome {
  previous_plan_id: string;
  new_plan: PlanResult;
  cancelled_keys: string[];
  kept_keys: string[];
  new_incident_ids: string[];
  reason: string;
  /** Summary of the final `replan` event (so the following plan event does not repeat it). */
  event_summary?: string;
  /** Tool-call objects shown in the final `replan` event (same references as in new_plan.tool_calls where shared). */
  event_tool_calls?: ToolCallSummary[];
}

export interface ReplanDeps {
  db: DbPort;
  physics: PhysicsPort;
  llm: LlmPort | null;
  events: EventPublisher;
  workflowId: string;
  runId: string;
  workerId: string;
  fencingToken: bigint;
  now: () => number;
}

export interface ReplanInput {
  previous: PlanResult;
  execution: ExecutionResult;
  attempt: number;
  reason: string;
}

/** Planner needs an LlmPort; with none configured it gets one that always fails (deterministic fallback). */
const NO_LLM: LlmPort = {
  chat: async () => {
    throw new Error('no LLM configured');
  },
};

interface CancelPass {
  cancelled: string[];
  succeeded: string[];
  /** GPUs held by prior actions we could not (or must not) cancel. */
  reserved: Set<string>;
  unsubmitted: string[];
  calls: ToolCallSummary[];
}

const claimedBy = (s: ActionStatus): unknown => s.result.claimed_by;

/** Cancel safe-to-cancel prior actions; report what stays reserved. Never touches running/succeeded rows. */
async function cancelSuperseded(deps: ReplanDeps, commands: ActionCommand[]): Promise<CancelPass> {
  const out: CancelPass = { cancelled: [], succeeded: [], reserved: new Set(), unsubmitted: [], calls: [] };
  const reserve = (c: ActionCommand) => destinationsOf(c).forEach((g) => out.reserved.add(g));
  for (const cmd of commands) {
    const s = await deps.db.getActionStatus(cmd.command_key);
    if (s === null) {
      out.unsubmitted.push(cmd.command_key);
      continue;
    }
    if (s.status === 'succeeded') {
      out.succeeded.push(cmd.command_key);
      continue;
    }
    if (s.status === 'running' || s.status === 'needs_reconciliation') {
      reserve(cmd);
      continue;
    }
    const safe = s.status === 'requested' || (s.status === 'claimed' && claimedBy(s) === deps.workerId);
    if (!safe) {
      if (s.status === 'claimed') reserve(cmd); // someone else's claim: leave it, but do not plan onto its GPUs
      continue;
    }
    try {
      const c = await deps.db.cancelAction(cmd.command_key, SUPERSEDED_REASON, deps.fencingToken);
      if (c.status === 'cancelled') {
        out.cancelled.push(cmd.command_key);
        out.calls.push({ tool: 'cancel_action', args_summary: cmd.command_key, result_summary: 'cancelled (superseded)' });
        continue;
      }
      if (c.status === 'running' || c.status === 'claimed') reserve(cmd);
    } catch (e) {
      // It moved on (started) or our token does not match its claim: treat it as still holding its GPUs.
      out.calls.push({ tool: 'cancel_action', args_summary: cmd.command_key, result_summary: isDbError(e) ? e.code : 'error' });
      const re = await deps.db.getActionStatus(cmd.command_key).catch(() => null);
      if (re?.status === 'succeeded') out.succeeded.push(cmd.command_key);
      else if (re?.status !== 'cancelled' && re?.status !== 'failed') reserve(cmd);
    }
  }
  return out;
}

const destsOfOption = (o: RankedOption): string[] => o.commands.flatMap(destinationsOf);

/** Belt and braces over PlannerDeps.reservedGpuIds: swap any chosen option that lands on a reserved GPU. */
async function enforceNoDoubleAllocation(db: DbPort, result: PlanResult, reserved: Set<string>): Promise<PlanResult> {
  if (reserved.size === 0) return result;
  const clash = (o: RankedOption) => destsOfOption(o).some((g) => reserved.has(g));
  if (!result.job_plans.some((p) => clash(p.chosen))) return result;
  const jobPlans: JobPlan[] = result.job_plans.map((p) => {
    if (!clash(p.chosen)) return p;
    const alt = p.alternatives.find((o) => !o.excluded_reason && !clash(o)) ?? p.alternatives.find((o) => o.commands.length === 0);
    if (!alt) return p;
    return {
      ...p,
      chosen: alt,
      alternatives: [p.chosen, ...p.alternatives.filter((o) => o.option_id !== alt.option_id)],
      decided_by: 'deterministic',
      explanation: `${p.chosen.label} targets GPUs held by a still-running action; using ${alt.label}`,
    };
  });
  const commands = jobPlans.flatMap((p) => p.chosen.commands);
  const keys = commands.length > 0 ? commands.map((c) => c.command_key) : result.plan.command_keys;
  const plan = { ...result.plan, command_keys: keys as [string, ...string[]] };
  await db.submitPlan(plan);
  return { ...result, plan, commands, job_plans: jobPlans };
}

const succeededKeys = (outcomes: CommandOutcome[]): string[] =>
  outcomes.filter((o) => o.status === 'succeeded').map((o) => o.command_key);

export async function runReplan(deps: ReplanDeps, input: ReplanInput): Promise<ReplanOutcome> {
  const { db, events, workflowId } = deps;
  const previousPlanId = input.previous.plan.plan_id;
  const firstIncident = input.previous.plan.incident_ids[0];

  // (1) announce
  await events.emit('replan', {
    workflowId,
    incidentId: firstIncident,
    summary: `deterministic: replanning ${previousPlanId}: ${input.reason}`,
    actor: 'code',
  });

  // (2) cancel only what is safe to cancel; remember what is still holding GPUs
  const pass = await cancelSuperseded(deps, input.previous.commands);

  // (3) triage again: the new failure becomes its own incident
  const triage = await runTriage({ db, llm: deps.llm, now: deps.now });
  const previousIds = new Set<string>(input.previous.plan.incident_ids);
  const newIncidentIds = triage.incidents.map((i) => i.incident_id).filter((id) => !previousIds.has(id));

  // (4) plan over every open incident of this workflow, with new command keys
  const wanted = new Set<string>([...previousIds, ...newIncidentIds]);
  const all = await db.listIncidents();
  const byId = new Map<string, Incident>(all.map((i) => [i.incident_id, i]));
  for (const i of triage.incidents) if (!byId.has(i.incident_id)) byId.set(i.incident_id, i);
  const open = [...wanted].map((id) => byId.get(id)).filter((i): i is Incident => !!i && i.state !== 'resolved');
  const planned = await planIncidents(
    {
      db,
      physics: deps.physics,
      llm: deps.llm ?? NO_LLM,
      workflowId,
      runId: deps.runId,
      attempt: input.attempt,
      reservedGpuIds: [...pass.reserved].sort(),
    },
    { incidents: open.length > 0 ? open : [...triage.incidents] },
  );
  const newPlan = await enforceNoDoubleAllocation(db, planned, pass.reserved);

  // (5) completed work (checkpoints) stays valid
  const kept = [...new Set([...succeededKeys(input.execution.outcomes), ...pass.succeeded])];

  // (6) persist the supersession
  const wf = await db.getWorkflow(workflowId);
  const incidentIds = [...new Set([...(wf?.incident_ids ?? []), ...newPlan.plan.incident_ids])];
  if (wf) {
    await db.updateWorkflow(workflowId, wf.version, deps.fencingToken, 'replan', {
      previous_plan_id: previousPlanId,
      superseded: true,
      cancelled_keys: pass.cancelled,
      kept_keys: kept,
      unsubmitted_keys: pass.unsubmitted,
      new_plan_id: newPlan.plan.plan_id,
      plan_id: newPlan.plan.plan_id,
      incident_ids: incidentIds,
      new_incident_ids: newIncidentIds,
      attempt: input.attempt,
      reason: input.reason,
      command_keys: newPlan.commands.map((c) => c.command_key),
      commands: newPlan.commands,
    });
  }

  const ledgerSummary =
    `superseded ${previousPlanId} -> ${newPlan.plan.plan_id}; cancelled ${pass.cancelled.length}, kept ${kept.length}` +
    (newIncidentIds.length ? `; new incident ${newIncidentIds.join(', ')}` : '');
  const narrative = planNarrative(newPlan.job_plans, newPlan.used_llm);
  const chooseCall = narrative.actor === 'nemotron' ? newPlan.tool_calls.find((t) => t.actor === 'nemotron') : undefined;
  const eventSummary = narrative.actor === 'nemotron' ? narrative.summary : `deterministic: ${ledgerSummary}`;
  const eventToolCalls = [...pass.calls, ...triage.toolCalls.slice(-2), ...(chooseCall ? [chooseCall] : []), ...newPlan.tool_calls.slice(-1)];
  await events.emit('replan', {
    workflowId,
    incidentId: newIncidentIds[0] ?? firstIncident,
    summary: eventSummary,
    actor: narrative.actor,
    toolCalls: eventToolCalls,
  });

  return {
    previous_plan_id: previousPlanId,
    new_plan: newPlan,
    cancelled_keys: pass.cancelled,
    kept_keys: kept,
    new_incident_ids: newIncidentIds,
    reason: input.reason,
    event_summary: eventSummary,
    event_tool_calls: eventToolCalls,
  };
}
