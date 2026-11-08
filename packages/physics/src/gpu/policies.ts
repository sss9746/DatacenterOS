// P1-8: the two baseline policies the evaluation harness compares against Nemotron (ARCHITECTURE §9, CONTRACTS §0.6).
//
//   reactivePolicy(obs)   recovers ONLY from hard errors: XID 48 / 79 on a GPU. Never looks at temperature.
//   thresholdPolicy(obs)  everything reactivePolicy does, plus a simple preventive trigger: any reachable GPU of an
//                         active job above THRESHOLD_TEMP_C (83 °C, simulated) → checkpoint + move the job if a
//                         destination is safe per evaluateSafety.
//
// Both are PURE functions of the planner-visible ObservedSnapshot: no private world, no clock, no randomness, no I/O,
// no memory between calls. They are called every tick with a fresh snapshot and must not pile up new commands, so
// every command_key is derived from observed state only (KEY SCHEME below) and re-calling them returns the same keys
// (or nothing) until the observed state moves on. A caller dedupes by command_key (enqueueCommands ignores a key it
// has seen; the DB checks getActionStatus(commandKey) first). A re-emitted key carries a FRESH payload (this tick's
// epoch, versions, sim time, possibly another destination): callers must keep the first payload under a key, not
// resubmit (CONTRACTS §A treats same key + different payload as a collision).
//
// Imports: only constants and the hard safety check (evaluateSafety, which itself reads only the snapshot).
//
// ---- KEY SCHEME (P = 'reactive' | 'threshold', the policy that emitted it) ------------------------------------------
//   XID handling (both policies), per GPU g whose last_xid_code is 48 or 79:
//     incident  inc.P.<g>        workflow wf.P.<g>        plan plan.P.<g>
//     <P>.<g>.cordon_gpu.xid<code>                         emitted unless g shows availability `cordoned` (an
//                                                          unreachable / degraded GPU never shows it, so the same key
//                                                          repeats every tick: same key, nothing new)
//     <P>.<g>.escalate.xid<code>                           g is not allocatable (the real Brev GPU): never cordon/place
//   per FAILED job J (the snapshot drops a failed job's placement, so while any XID 48/79 GPU is observed every failed
//   job is attributed to the XID GPUs; incident_ids = all of them; workflow / plan = the first one's):
//     <P>.<J>.migrate_restart.v<J.version>                 restart from the durable checkpoint on free ready GPUs
//     <P>.<J>.escalate.no_destination.v<J.version>         no free compatible placement fits
//     <P>.<J>.escalate.checkpoint_unavailable.v<J.version> its latest checkpoint is not complete + accessible
//   The version only changes when the job's status / placement / durable work / latest checkpoint changes, so a failed
//   job keeps one key until it restarts (status → restarting), and then the policy stops emitting for it.
//
//   Thermal handling (thresholdPolicy only), per hot job J (running / paused / checkpointing with a reachable GPU
//   > 83 °C; incident inc.threshold.<J>.thermal, workflow wf.threshold.<J>, plan plan.threshold.<J>.after.<X>).
//   X = the checkpoint the cycle starts from: job.latest_checkpoint_id, or `none`. One cycle = one checkpoint + one
//   move. Destinations: free compatible nodes not hosting J, coolest (hottest reachable GPU) first, then by id; the
//   first set evaluateSafety returns `allow` for (ctx: snapshot epoch, no leases) wins. Cycles already under way pick
//   first, so a move planned on an earlier tick keeps its GPUs.
//     threshold.<J>.checkpoint.after.<X>
//     threshold.<J>.migrate_restart.after.<X>              depends_on [the checkpoint key]
//     threshold.<J>.escalate.<reason>.after.<X>            reason: not_preemptible | checkpoint_unavailable
//   The checkpoint row records its command_key, so the snapshot itself tells which cycle a job is in:
//     a. checkpointing with OUR checkpoint writing        → re-emit only the cycle's migrate (if a safe destination);
//                                                          no heat needed: the write idles the GPUs, so they cool
//     b. running / paused, latest checkpoint is OURS and the job has not moved since it completed
//                                                         → re-emit only the cycle's migrate (if a safe destination)
//     c. otherwise                                        → a NEW cycle from X = latest_checkpoint_id
//   So a checkpoint completing never starts another checkpoint (b), a failed checkpoint (latest unchanged) gives the
//   same keys again, and only a completed move lets a still-hot job start a new cycle. restarting → nothing.
//   Someone else's checkpoint in flight → nothing (never interfere).
import type { ActionCommand, Checkpoint, GpuCurrent, JobSpec, JobState, ObservedSnapshot, ResourceSpec } from '@dcos/contracts';
import { REAL_PROFILE, WIRE_SCHEMA_VERSION } from './constants.js';
import { evaluateSafety } from './safety.js';

/** Simulated, configurable: thresholdPolicy's preventive trigger, °C (2 °C under the 85 °C simulated slowdown). */
export const THRESHOLD_TEMP_C = 83;

/** XID codes the baselines treat as a hard GPU failure (ARCHITECTURE §2: 79 fell off the bus, 48 double-bit ECC). */
const HARD_XIDS: ReadonlySet<number> = new Set([48, 79]);

/** CONTRACTS §0.6 Policy interface (shared by the evaluation harness and P3's nemotronPolicy). */
export type Policy = (obs: ObservedSnapshot, ctx: { sim_time_ms: number }) => Promise<ActionCommand[]> | ActionCommand[];

/** Optional per-call context: unused (policies read time from obs.clock), accepted for the Policy signature. */
export interface PolicyCallContext {
  sim_time_ms: number;
}

type Prefix = 'reactive' | 'threshold';

// ---- snapshot index (observed rows only) ------------------------------------------------------------

interface Index {
  obs: ObservedSnapshot;
  res: Map<string, ResourceSpec>;
  gpu: Map<string, GpuCurrent>;
  nodeAvail: Map<string, string>;
  /** GPUs per node, in snapshot order. */
  nodeGpus: Map<string, GpuCurrent[]>;
  /** gpu → owning job (allocations and job_states.allocated_gpu_ids). */
  owner: Map<string, string>;
  spec: Map<string, JobSpec>;
  /** GPUs already chosen as a destination by an earlier command of this call. */
  claimed: Set<string>;
}

function index(obs: ObservedSnapshot): Index {
  const nodeGpus = new Map<string, GpuCurrent[]>();
  for (const g of obs.gpus) {
    const list = nodeGpus.get(g.node_id);
    if (list) list.push(g);
    else nodeGpus.set(g.node_id, [g]);
  }
  const owner = new Map<string, string>();
  for (const j of obs.job_states) for (const g of j.allocated_gpu_ids) owner.set(g, j.job_id);
  for (const a of obs.allocations) owner.set(a.gpu_id, a.job_id);
  return {
    obs,
    res: new Map(obs.resources.map((r) => [r.resource_id, r])),
    gpu: new Map(obs.gpus.map((g) => [g.resource_id, g])),
    nodeAvail: new Map(obs.nodes.map((n) => [n.resource_id, n.availability])),
    nodeGpus,
    owner,
    spec: new Map(obs.job_specs.map((s) => [s.job_id, s])),
    claimed: new Set(),
  };
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Not the real Brev GPU / node (CONTRACTS §0.11 #4: profile brev_real, never allocatable) and enabled. */
const placeable = (r: ResourceSpec | undefined): boolean =>
  !!r && r.enabled && r.profile !== REAL_PROFILE && r.config.allocatable !== false;

/** A simulated GPU a job may be placed on (the real Brev GPU and disabled resources never are). */
function allocatable(ix: Index, g: GpuCurrent): boolean {
  const r = ix.res.get(g.resource_id);
  return !!r && r.kind === 'gpu' && placeable(r);
}

/**
 * Free, ready, allocatable GPUs of a node for this job, in snapshot order. The node must be a simulated node with a
 * node_current row reading ready: node-real-0 has none and is never placeable, even if a job spec listed it.
 */
function freeGpus(ix: Index, node: string, spec: JobSpec): string[] {
  const res = ix.res.get(node);
  if (!res || res.kind !== 'node' || !placeable(res) || ix.nodeAvail.get(node) !== 'ready') return [];
  return (ix.nodeGpus.get(node) ?? [])
    .filter((g) => g.availability === 'ready' && allocatable(ix, g) && ix.res.get(g.resource_id)!.profile === spec.gpu_profile)
    .filter((g) => {
      const o = ix.owner.get(g.resource_id);
      return (o === undefined || o === spec.job_id) && !ix.claimed.has(g.resource_id);
    })
    .map((g) => g.resource_id);
}

/** Hottest reachable GPU temperature on a node, °C (+∞ when nothing on it reports). */
function nodeTempC(ix: Index, node: string): number {
  const live = (ix.nodeGpus.get(node) ?? []).filter((g) => g.availability !== 'unreachable');
  return live.length === 0 ? Infinity : Math.max(...live.map((g) => g.temp_c));
}

/**
 * Destination GPU sets for a job, in try order. Nodes are the job's compatible nodes minus `excludeNodes`, ordered by
 * id (`order: 'id'`) or coolest first then id (`'coolest'`). same_node: every node with enough free GPUs.
 * gang_multi_node: for each start position k, fill greedily from the k-th node on (whole free nodes first by order).
 */
function destinationCandidates(ix: Index, spec: JobSpec, order: 'id' | 'coolest', excludeNodes: ReadonlySet<string>): string[][] {
  const need = spec.gpus_required;
  if (!(need > 0)) return [];
  let nodes = [...new Set(spec.compatible_node_ids)].filter((n) => !excludeNodes.has(n)).sort(byId);
  if (order === 'coolest') {
    const temp = new Map(nodes.map((n) => [n, nodeTempC(ix, n)]));
    nodes = nodes.sort((a, b) => temp.get(a)! - temp.get(b)! || byId(a, b));
  }
  const free = nodes.map((n) => freeGpus(ix, n, spec)).filter((f) => f.length > 0);
  const out: string[][] = [];
  const seen = new Set<string>();
  const push = (c: string[]) => {
    const k = c.join(',');
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  };
  if (spec.placement_policy === 'same_node') {
    for (const f of free) if (f.length >= need) push(f.slice(0, need));
    return out;
  }
  for (let k = 0; k < free.length; k++) {
    const pick: string[] = [];
    for (let i = k; i < free.length && pick.length < need; i++) pick.push(...free[i]!.slice(0, need - pick.length));
    if (pick.length === need) push(pick);
  }
  return out;
}

// ---- command construction ----------------------------------------------------------------------------

function versionOf(ix: Index, id: string): number | null {
  const row = ix.gpu.get(id) ?? ix.obs.nodes.find((n) => n.resource_id === id)
    ?? ix.obs.cooling.find((c) => c.resource_id === id) ?? ix.obs.job_states.find((j) => j.job_id === id);
  return row ? row.version : null;
}

interface Draft {
  key: string;
  workflow: string;
  plan: string;
  incidents: string[];
  operation: ActionCommand['operation'];
  target: string;
  job: string | null;
  args?: Record<string, unknown>;
  deps?: string[];
  /** Resources whose observed versions the command expects (job, target GPU(s)). */
  versioned: string[];
}

function command(ix: Index, d: Draft): ActionCommand {
  const versions: Record<string, number> = {};
  for (const id of [...new Set(d.versioned)].sort(byId)) {
    const v = versionOf(ix, id);
    if (v !== null) versions[id] = v;
  }
  const incidents = [...new Set(d.incidents)].sort(byId);
  return {
    schema_version: WIRE_SCHEMA_VERSION,
    run_id: ix.obs.run_id,
    action_id: d.key,
    command_key: d.key,
    workflow_id: d.workflow,
    plan_id: d.plan,
    incident_ids: incidents as [string, ...string[]],
    operation: d.operation,
    target_resource_id: d.target,
    job_id: d.job,
    arguments: d.args ?? {},
    depends_on_command_keys: d.deps ?? [],
    expected_decision_epoch: ix.obs.clock.decision_epoch,
    expected_resource_versions: versions,
    requested_sim_time_ms: ix.obs.clock.sim_time_ms,
  };
}

const latestCheckpoint = (ix: Index, job: JobState): Checkpoint | undefined =>
  job.latest_checkpoint_id === null ? undefined : ix.obs.checkpoints.find((c) => c.checkpoint_id === job.latest_checkpoint_id);

// ---- XID 48 / 79 (both policies) -----------------------------------------------------------------------

function xidCommands(ix: Index, p: Prefix): ActionCommand[] {
  const bad = ix.obs.gpus.filter((g) => g.last_xid_code !== null && HARD_XIDS.has(g.last_xid_code))
    .sort((a, b) => byId(a.resource_id, b.resource_id));
  if (bad.length === 0) return [];
  const out: ActionCommand[] = [];
  for (const g of bad) {
    const id = g.resource_id;
    const base = { workflow: `wf.${p}.${id}`, plan: `plan.${p}.${id}`, incidents: [`inc.${p}.${id}`], versioned: [id] };
    if (!allocatable(ix, g)) {
      out.push(command(ix, {
        ...base, key: `${p}.${id}.escalate.xid${g.last_xid_code}`, operation: 'escalate', target: id, job: null,
        args: { reason: 'xid_on_non_allocatable_gpu', xid_code: g.last_xid_code },
      }));
    } else if (g.availability !== 'cordoned') {
      out.push(command(ix, {
        ...base, key: `${p}.${id}.cordon_gpu.xid${g.last_xid_code}`, operation: 'cordon_gpu', target: id, job: null,
        args: { reason: 'xid', xid_code: g.last_xid_code },
      }));
    }
  }

  const first = bad[0]!.resource_id;
  const incidents = bad.map((g) => `inc.${p}.${g.resource_id}`);
  const failed = ix.obs.job_states.filter((j) => j.status === 'failed').sort((a, b) => byId(a.job_id, b.job_id));
  for (const job of failed) {
    const spec = ix.spec.get(job.job_id);
    if (!spec) continue;
    const J = job.job_id;
    const base = { workflow: `wf.${p}.${first}`, plan: `plan.${p}.${first}`, incidents, job: J, target: J };
    const escalate = (reason: string) => command(ix, {
      ...base, key: `${p}.${J}.escalate.${reason}.v${job.version}`, operation: 'escalate', versioned: [J],
      args: { reason, xid_gpu_ids: bad.map((g) => g.resource_id) },
    });
    const ck = latestCheckpoint(ix, job);
    if (job.latest_checkpoint_id !== null && !(ck && ck.status === 'complete' && ck.accessible)) {
      out.push(escalate('checkpoint_unavailable'));
      continue;
    }
    const dest = destinationCandidates(ix, spec, 'id', new Set())[0];
    if (!dest) {
      out.push(escalate('no_destination'));
      continue;
    }
    for (const gid of dest) ix.claimed.add(gid);
    out.push(command(ix, {
      ...base, key: `${p}.${J}.migrate_restart.v${job.version}`, operation: 'migrate_restart', versioned: [J, ...dest],
      args: { destination_gpu_ids: dest, reason: 'restart_after_xid', from_checkpoint_id: job.latest_checkpoint_id },
    }));
  }
  return out;
}

// ---- thermal trigger (thresholdPolicy) -------------------------------------------------------------------

const SAFETY_CTX = (obs: ObservedSnapshot) => ({ decision_epoch: obs.clock.decision_epoch, leased_resource_ids: [] as string[] });

function isHot(ix: Index, job: JobState): boolean {
  return job.allocated_gpu_ids.some((id) => {
    const g = ix.gpu.get(id);
    return !!g && g.availability !== 'unreachable' && g.temp_c > THRESHOLD_TEMP_C;
  });
}

/** The cycle a hot job is in (see KEY SCHEME): X plus whether the cycle's checkpoint is already taken / in flight. */
function cycleOf(ix: Index, job: JobState): { x: string; checkpointDone: boolean } | null {
  const own = `threshold.${job.job_id}.checkpoint.after.`;
  if (job.status === 'checkpointing') {
    const writing = ix.obs.checkpoints.find((c) => c.job_id === job.job_id && (c.status === 'writing' || c.status === 'requested'));
    if (!writing || !writing.command_key.startsWith(own)) return null; // someone else's checkpoint
    return { x: writing.command_key.slice(own.length), checkpointDone: true };
  }
  const latest = latestCheckpoint(ix, job);
  if (latest && latest.status === 'complete' && latest.command_key.startsWith(own)) {
    const since = ix.obs.allocations.filter((a) => a.job_id === job.job_id).map((a) => a.since_sim_time_ms);
    const movedAfter = since.length > 0 && Math.min(...since) >= (latest.complete_sim_time_ms ?? Infinity);
    if (!movedAfter) return { x: latest.command_key.slice(own.length), checkpointDone: true };
  }
  return { x: job.latest_checkpoint_id ?? 'none', checkpointDone: false };
}

/** First destination evaluateSafety allows for this migrate (candidates coolest first, then id), or null. */
function safeMigrate(ix: Index, job: JobState, spec: JobSpec, draft: Omit<Draft, 'args' | 'versioned'>): ActionCommand | null {
  const current = new Set(job.allocated_gpu_ids.map((g) => ix.gpu.get(g)?.node_id).filter((n): n is string => !!n));
  for (const dest of destinationCandidates(ix, spec, 'coolest', current)) {
    const cmd = command(ix, {
      ...draft, versioned: [job.job_id, ...dest],
      args: { destination_gpu_ids: dest, reason: 'preventive_thermal_move', threshold_temp_c: THRESHOLD_TEMP_C },
    });
    if (evaluateSafety(ix.obs, cmd, SAFETY_CTX(ix.obs)).decision === 'allow') {
      for (const g of dest) ix.claimed.add(g);
      return cmd;
    }
  }
  return null;
}

function thermalCommands(ix: Index): ActionCommand[] {
  const hot: { job: JobState; spec: JobSpec; cycle: { x: string; checkpointDone: boolean } }[] = [];
  for (const job of ix.obs.job_states) {
    if (job.status !== 'running' && job.status !== 'paused' && job.status !== 'checkpointing') continue;
    const spec = ix.spec.get(job.job_id);
    // A synchronous checkpoint idles the GPUs, so they cool while OUR checkpoint writes: that cycle continues without
    // the trigger (its move is the point of the checkpoint). Every other case needs a GPU over the threshold now.
    const cycle = spec && (job.status === 'checkpointing' || isHot(ix, job)) ? cycleOf(ix, job) : null;
    if (spec && cycle) hot.push({ job, spec, cycle });
  }
  // Cycles already under way pick destinations first, so a move planned on an earlier tick keeps its GPUs and a job
  // that only now crosses the threshold cannot take them (then by job id).
  hot.sort((a, b) => Number(b.cycle.checkpointDone) - Number(a.cycle.checkpointDone) || byId(a.job.job_id, b.job.job_id));
  const perJob = new Map<string, ActionCommand[]>();
  for (const { job, spec, cycle } of hot) perJob.set(job.job_id, thermalCycle(ix, job, spec, cycle));
  return [...perJob.keys()].sort(byId).flatMap((j) => perJob.get(j)!);
}

function thermalCycle(ix: Index, job: JobState, spec: JobSpec, cycle: { x: string; checkpointDone: boolean }): ActionCommand[] {
  const J = job.job_id;
  const base = {
    workflow: `wf.threshold.${J}`, plan: `plan.threshold.${J}.after.${cycle.x}`, incidents: [`inc.threshold.${J}.thermal`],
    target: J, job: J,
  };
  const hotGpus = job.allocated_gpu_ids.filter((id) => (ix.gpu.get(id)?.temp_c ?? -Infinity) > THRESHOLD_TEMP_C);
  const escalate = (reason: string) => command(ix, {
    ...base, key: `threshold.${J}.escalate.${reason}.after.${cycle.x}`, operation: 'escalate', versioned: [J],
    args: { reason, hot_gpu_ids: hotGpus, threshold_temp_c: THRESHOLD_TEMP_C },
  });
  if (!spec.preemptible) return [escalate('not_preemptible')]; // no voluntary move for a non-preemptible job
  const ckKey = `threshold.${J}.checkpoint.after.${cycle.x}`;
  const migrateDraft = { ...base, key: `threshold.${J}.migrate_restart.after.${cycle.x}`, operation: 'migrate_restart' as const, deps: [ckKey] };
  if (cycle.checkpointDone) {
    const mv = safeMigrate(ix, job, spec, migrateDraft);
    return mv ? [mv] : [];
  }
  const ck = command(ix, { ...base, key: ckKey, operation: 'checkpoint', versioned: [J], args: { reason: 'preventive_thermal_checkpoint' } });
  if (!spec.checkpoint_supported || !spec.checkpoint_storage_id
    || evaluateSafety(ix.obs, ck, SAFETY_CTX(ix.obs)).decision !== 'allow') {
    return [escalate('checkpoint_unavailable')];
  }
  const mv = safeMigrate(ix, job, spec, migrateDraft);
  return mv ? [ck, mv] : [ck];
}

// ---- the policies ---------------------------------------------------------------------------------------

/** Reactive baseline: XID 48/79 only → cordon the GPU, restart the failed job(s) from checkpoint, or escalate. */
export function reactivePolicy(obs: ObservedSnapshot, _ctx?: PolicyCallContext): ActionCommand[] {
  return xidCommands(index(obs), 'reactive');
}

/** Threshold baseline: reactive's XID handling plus checkpoint + safe move for jobs with a GPU over 83 °C. */
export function thresholdPolicy(obs: ObservedSnapshot, _ctx?: PolicyCallContext): ActionCommand[] {
  const ix = index(obs);
  return [...xidCommands(ix, 'threshold'), ...thermalCommands(ix)];
}

// Compile-time proof that both baselines satisfy the frozen §0.6 Policy interface.
type Assignable = [typeof reactivePolicy, typeof thresholdPolicy] extends [Policy, Policy] ? true : never;
const assignable: Assignable = true;
void assignable;
