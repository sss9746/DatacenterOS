// runScenario(scenario, policy, opts) → EvaluationResult: the offline evaluation harness (P1-9b, ARCHITECTURE §9).
//
// It runs the real pipeline without a database, so P4's evaluation app and P3's nemotronPolicy share one harness:
//   1. world = scenarioWorld(s).
//   2. Each tick: obs = toObserved(world); cmds = await policy(obs, { sim_time_ms }). The world does not advance while
//      the policy thinks (zero-latency offline), so a well-formed command is never stale here.
//   3. A command_key already seen is ignored (CONTRACTS §C: a retry returns the persisted record, no new effect).
//   4. Each new command gets a FRESH evaluateSafety(obs, cmd, { decision_epoch: obs.clock.decision_epoch,
//      leased_resource_ids }), like request_action. leased_resource_ids = the resource closure (job, its GPUs and their
//      nodes, the target, migrate destination GPUs / nodes) of every command that holds a lease right now: commands in
//      flight in physics, plus accepted commands whose dependencies are all done (they are claimed this tick). An
//      accepted command still waiting for a dependency holds no lease yet (DB: `requested`, not `claimed`).
//   5. allow → enqueueCommands + requested_action_ids. A command with depends_on_command_keys is requested only after
//      every dependency completed ok (simulate.ts rule). If a dependency failed in physics, was blocked, or was never
//      submitted, the dependent is never requested (dependency_dropped).
//   6. deny / needs_approval → blocked. Offline there is no human to approve, so needs_approval never runs. The key is
//      remembered (the DB persists a failed SAFETY_REJECTED action, CONTRACTS §0.11 #3).
//   7. retry_new_snapshot → dropped and NOT remembered (the DB throws and persists nothing), so the policy may re-issue
//      the same key next tick. A new command that depends on a key dropped this way in the same batch is dropped too.
//   8. step(scenarioTickInput(s, world, requested)) until horizon_s sim-seconds after the scenario start.
//   gate 'none' skips step 4's verdict (every new command is accepted) but still runs evaluateSafety to classify
//   unsafe executions. It measures what a naive operator would do.
//
// METRICS (EvaluationResult; every counter counts distinct command_keys):
// - lost_work_units, job_completion_delay_s, gpu_busy_waste_s: the PlanMetrics definitions of simulate.ts
//   (expected_lost_work_units, expected_completion_delay_sim_s, expected_gpu_busy_waste_s), measured on the TRUE world
//   (private faults included) instead of an estimate. The per-tick accounting is copied from simulate.ts simulate()
//   (not exported there), with fault conditions recomputed each tick because real faults start and end:
//   · lost: on every tick a job's progress ends below (progress at t0 + the work it gained this tick), the shortfall
//     is lost (job failure back to durable_work_units, migrate_restart from an older checkpoint).
//   · delay: Σ over jobs not completed at the start of max(0, ideal − actual work) / ideal rate, with ideal rate =
//     gpus_required × work_rate_per_gpu_per_sim_s and ideal work = min(rate × horizon, total − progress at start). The
//     ideal is the no-fault nominal-rate reference. It is a LOWER BOUND truncated at the horizon: a job that never
//     finishes accrues the whole horizon, never zero (ARCHITECTURE §9).
//   · busy waste: per tick, per allocated GPU, (1 − clock factor) × dt while the job runs (thermal throttle and power
//     cap count fractionally), the whole dt while it holds the GPU without progress (checkpointing, restarting,
//     paused).
// - unsafe_actions_blocked: commands the gate refused (deny or needs_approval). Always 0 with gate 'none'.
// - unsafe_actions_executed: executed commands (started in physics) that are unsafe for either reason (counted once):
//   (a) the fresh safety check at request time said `deny` (only possible with gate 'none'; needs_approval and
//   retry_new_snapshot are not counted as unsafe), or (b) a migrate_restart whose destination GPUs reached ≥ 85 °C
//   (true temperature, or a latched thermal shutdown) between the move's start and 120 s (SAFETY_LOOKAHEAD_S) after
//   the job ran on them. The 120 s window starts when the restart completes, because destination GPUs idle while the
//   job restarts; a move that fails is watched until it fails.
// - unnecessary_preemptions: executed preemptive commands (checkpoint, migrate_restart, pause_job, power_cap issued
//   while every affected job was running / paused, i.e. not failed or completed) where no affected job is at risk.
//   A job is at risk when, in the do-nothing run of the same scenario (run internally), it failed or ran throttled
//   (a GPU it held while running was ≥ 85 °C, true temperature). Affected jobs: the command's job, or for a power_cap
//   on a GPU / node, the jobs holding those GPUs.
// - successful_recoveries / failed_recoveries: a recovery is a migrate_restart of a job that was failed when the
//   command was issued, or of an at-risk job. succeeded = it completed ok and the job did not fail afterwards (until
//   the horizon). failed = physics rejected or failed it, a dependency was dropped so it never ran, or the job failed
//   after it completed. Blocked recoveries count only as blocked; one still running or waiting at the horizon counts
//   as neither.
// - agent_crash_resumes: 0 offline (there is no agent process to crash).
//
// Pure and deterministic for a deterministic policy: no clock, randomness or I/O. Only `import type` from
// @dcos/contracts. The harness is a trusted caller like the DB tick: it reads the private world (in-flight commands,
// true temperatures); a policy only ever gets toObserved(world).
import type { ActionCommand, EvaluationResult, JobState, ObservedSnapshot, PhysicsWorld, SafetyDecision } from '@dcos/contracts';
import { SLOWDOWN_C, STEP_MS, WIRE_SCHEMA_VERSION as V } from './constants.js';
import { enqueueCommands, finishedCommand } from './actions.js';
import type { Policy } from './policies.js';
import { ACTIVE_STATUSES } from './jobs.js';
import { toObserved } from './observe.js';
import { SAFETY_LOOKAHEAD_S, evaluateSafety } from './safety.js';
import { loadScenarios, scenarioTickInput, scenarioWorld, type Scenario } from './scenarios.js';
import { step } from './step.js';
import {
  UNREACHABLE_FAILURES,
  buildTopology,
  faultConditions,
  gpuJobMap,
  gpuLoad,
  gpuPhysics,
  hiddenOf,
  specOf,
  type Topology,
} from './world.js';

export type { Policy } from './policies.js';

export interface RunScenarioOptions {
  /** The EvaluationResult.policy label. */
  policy_name: EvaluationResult['policy'];
  /** EvaluationResult.run_id (a label; the world keeps the scenario's run id). Default `eval-<policy>-<scenario_id>`. */
  run_id?: string;
  /** 'safety' (default): the fresh safety check gates every command. 'none': execute everything (naive operator). */
  gate?: 'safety' | 'none';
}

/** The reference policy: never acts. Used internally for unnecessary_preemptions. Not a contract policy name. */
export const DO_NOTHING_POLICY: Policy = () => [];

export type CommandDisposition =
  | 'executed' // started in physics (it may have finished, failed or still be running at the horizon)
  | 'blocked' // the gate refused it (deny / needs_approval)
  | 'physics_rejected' // requested, but physics refused to start it (see outcome.reason_code)
  | 'dependency_dropped' // a dependency failed / was blocked / was never submitted, so it was never requested
  | 'waiting'; // accepted, still waiting for a dependency at the horizon

/** One distinct command_key the policy issued (retry_new_snapshot drops are not recorded, only counted). */
export interface CommandRecord {
  command_key: string;
  action_id: string;
  operation: ActionCommand['operation'];
  job_id: string | null;
  target_resource_id: string;
  issued_sim_time_ms: number;
  /** The fresh check at request time (run with gate 'none' too, for classification). */
  safety: { decision: SafetyDecision['decision']; violations: string[] };
  disposition: CommandDisposition;
  /** End time of the tick it was requested on (it starts there), or null if never requested. */
  requested_sim_time_ms: number | null;
  /**
   * How physics finished it (commandOutcome's status / reason_code, CONTRACTS §0.12 #4, plus the finish sim time), or
   * null if it never finished (never requested, or still running at the horizon).
   */
  outcome: { status: 'succeeded' | 'failed'; reason_code: string | null; sim_time_ms: number } | null;
  /** DEPENDENCY_FAILED / DEPENDENCY_NOT_FOUND when dependency_dropped. */
  dependency_reason: string | null;
  preemptive: boolean;
  unnecessary: boolean;
  recovery: 'succeeded' | 'failed' | 'unresolved' | null;
  /** Why it counts in unsafe_actions_executed: SAFETY_DENY and/or DEST_REACHED_SLOWDOWN. */
  unsafe_executed: string[];
}

export interface ScenarioRunDetails {
  result: EvaluationResult;
  gate: 'safety' | 'none';
  ticks: number;
  start_sim_time_ms: number;
  end_sim_time_ms: number;
  commands: CommandRecord[];
  /** Commands whose command_key had been seen before (ignored). */
  duplicate_commands_ignored: number;
  /** retry_new_snapshot drops (the key is not remembered; the policy may re-issue it). */
  retry_dropped: number;
  /** Jobs neither completed nor running at the horizon / that were failed at the horizon / that completed. */
  unfinished_job_ids: string[];
  failed_job_ids: string[];
  completed_job_ids: string[];
  /** Jobs that failed or throttled in the do-nothing run of this scenario. */
  reference_at_risk_job_ids: string[];
}

// ---- helpers --------------------------------------------------------------------------------------

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const EPS = 1e-9;
const PREEMPTIVE_OPS: ReadonlySet<string> = new Set(['checkpoint', 'migrate_restart', 'pause_job', 'power_cap']);
const ALIVE_FOR_PREEMPTION: ReadonlySet<JobState['status']> = new Set(['running', 'paused', 'checkpointing', 'restarting', 'queued']);

const stringList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
const depsOf = (c: ActionCommand): string[] => (Array.isArray(c.depends_on_command_keys) ? c.depends_on_command_keys : []);

function jobIdOf(obs: ObservedSnapshot, c: ActionCommand): string | null {
  if (c.job_id) return c.job_id;
  return obs.job_states.some((j) => j.job_id === c.target_resource_id) ? c.target_resource_id : null;
}

/** Jobs a command acts on: its job, or the jobs holding the targeted GPU / node GPUs (power_cap / cordon). */
function affectedJobs(obs: ObservedSnapshot, c: ActionCommand): string[] {
  const j = jobIdOf(obs, c);
  if (j) return [j];
  const gpus = new Set(obs.gpus.filter((g) => g.resource_id === c.target_resource_id || g.node_id === c.target_resource_id).map((g) => g.resource_id));
  return obs.job_states.filter((x) => x.allocated_gpu_ids.some((g) => gpus.has(g))).map((x) => x.job_id).sort();
}

/**
 * The lease closure claim_action would lock (CONTRACTS §C): the job, its current GPUs and their nodes, the target
 * (and a target GPU's node), and for migrate_restart the destination GPUs and their nodes (or the destination nodes).
 * keep_running and escalate change nothing and lock nothing.
 */
function leaseClosure(obs: ObservedSnapshot, c: ActionCommand, dest?: string[]): string[] {
  if (c.operation === 'keep_running' || c.operation === 'escalate') return [];
  const ids = new Set<string>();
  const gpuNode = new Map(obs.gpus.map((g) => [g.resource_id, g.node_id]));
  const addGpu = (g: string) => {
    ids.add(g);
    const n = gpuNode.get(g);
    if (n) ids.add(n);
  };
  const jobId = jobIdOf(obs, c);
  const job = jobId ? obs.job_states.find((j) => j.job_id === jobId) : undefined;
  if (job) {
    ids.add(job.job_id);
    for (const g of job.allocated_gpu_ids) addGpu(g);
  }
  if (gpuNode.has(c.target_resource_id)) addGpu(c.target_resource_id);
  else ids.add(c.target_resource_id);
  if (c.operation === 'migrate_restart') {
    const explicit = dest ?? stringList(c.arguments.destination_gpu_ids);
    if (explicit) for (const g of explicit) addGpu(g);
    else for (const n of stringList(c.arguments.destination_node_ids) ?? []) ids.add(n);
  }
  return [...ids];
}

/** True GPU temperatures (the evaluation oracle sees through stale sensors). Unreachable GPUs are skipped. */
function trueTemps(world: PhysicsWorld, topo: Topology, gpuIds: Iterable<string>): Map<string, number> {
  const h = hiddenOf(world);
  const cond = faultConditions(world.active_faults_private, topo);
  const jobs = gpuJobMap(world.observable.job_states);
  const rows = new Map(world.observable.gpus.map((g) => [g.resource_id, g]));
  const out = new Map<string, number>();
  for (const id of gpuIds) {
    const row = rows.get(id);
    const f = h.gpu_failure[id];
    if (!row || (f && UNREACHABLE_FAILURES.has(f))) continue;
    out.set(id, gpuPhysics(row, gpuLoad(id, jobs), h, topo, cond).temp_c);
  }
  return out;
}

interface Pending {
  cmd: ActionCommand;
  rec: CommandRecord;
}

interface MoveWatch {
  rec: CommandRecord;
  dest: string[];
  /** null until the restart completes; then completion + 120 s. */
  until_ms: number | null;
}

interface CoreRun {
  details: Omit<ScenarioRunDetails, 'result' | 'reference_at_risk_job_ids'>;
  lost: number;
  delay: number;
  waste: number;
  /** Jobs that failed or ran throttled during the run. */
  at_risk: Set<string>;
  /** Sim times at which each job failed. */
  failures: Map<string, number[]>;
  /** Preemptive executed commands with their affected jobs (classified against the reference afterwards). */
  preemptive: { rec: CommandRecord; jobs: string[] }[];
  /** Recovery candidates: migrate_restart with the job's status at issue. */
  moves: { rec: CommandRecord; job: string | null; job_failed_at_issue: boolean }[];
}

// ---- core loop ------------------------------------------------------------------------------------

async function runCore(s: Scenario, policy: Policy | null, gate: 'safety' | 'none'): Promise<CoreRun> {
  let world = scenarioWorld(s);
  const topo = buildTopology(world.observable.resources, world.observable.gpus); // resources never change
  const startMs = world.observable.clock.sim_time_ms;
  const ticks = Number.isFinite(s.horizon_s) && s.horizon_s > 0 ? Math.ceil((s.horizon_s * 1000) / STEP_MS) : 0;
  const dtS = STEP_MS / 1000;
  const simS = ticks * dtS;

  const start = new Map(world.observable.job_states.map((j) => [j.job_id, { status: j.status, progress: j.progress_work_units }]));
  const seen = new Set<string>(); // command keys remembered (accepted or blocked)
  const accepted = new Set<string>(); // keys handed to physics (enqueued)
  const blocked = new Set<string>();
  const records: CommandRecord[] = [];
  const byKey = new Map<string, CommandRecord>();
  let pending: Pending[] = []; // accepted, not requested yet
  let duplicates = 0;
  let retryDropped = 0;
  let lost = 0;
  let waste = 0;
  const atRisk = new Set<string>();
  const failures = new Map<string, number[]>();
  const preemptive: CoreRun['preemptive'] = [];
  const moves: CoreRun['moves'] = [];
  const watches: MoveWatch[] = [];

  // the hidden finish record (status + finish time); the harness is a trusted caller like the DB tick
  const outcomeOf = (key: string) => finishedCommand(world, key);
  const ready = (c: ActionCommand) => depsOf(c).every((k) => outcomeOf(k)?.ok === true);

  for (let i = 0; i < ticks; i++) {
    const t1 = world.observable.clock.sim_time_ms + STEP_MS;

    // 1-7: the policy's commands through the gate
    if (policy) {
      const obs = toObserved(world);
      const out = await policy(obs, { sim_time_ms: obs.clock.sim_time_ms });
      const cmds = Array.isArray(out) ? out : [];
      const fresh: ActionCommand[] = [];
      const retryKeys = new Set<string>();
      for (const c of cmds) {
        if (seen.has(c.command_key) || fresh.some((x) => x.command_key === c.command_key)) {
          duplicates += 1;
          continue;
        }
        // leases held right now: in-flight commands + accepted commands that are claimable this tick
        const leased = new Set<string>();
        for (const f of hiddenOf(world).in_flight) for (const id of leaseClosure(obs, f.command, f.destination_gpu_ids)) leased.add(id);
        for (const p of pending) if (ready(p.cmd)) for (const id of leaseClosure(obs, p.cmd)) leased.add(id);
        const decision = evaluateSafety(obs, c, { decision_epoch: obs.clock.decision_epoch, leased_resource_ids: [...leased].sort() });
        const verdict = gate === 'none' ? 'allow' : decision.decision;
        if (verdict === 'retry_new_snapshot' || (gate === 'safety' && depsOf(c).some((k) => retryKeys.has(k)))) {
          retryKeys.add(c.command_key);
          retryDropped += 1;
          continue;
        }
        const jobId = jobIdOf(obs, c);
        const jobs = affectedJobs(obs, c);
        const statusOf = (j: string) => obs.job_states.find((x) => x.job_id === j)?.status;
        const rec: CommandRecord = {
          command_key: c.command_key, action_id: c.action_id, operation: c.operation, job_id: jobId,
          target_resource_id: c.target_resource_id, issued_sim_time_ms: obs.clock.sim_time_ms,
          safety: { decision: decision.decision, violations: [...decision.violations] },
          disposition: verdict === 'allow' ? 'waiting' : 'blocked', requested_sim_time_ms: null, outcome: null,
          dependency_reason: null,
          preemptive: PREEMPTIVE_OPS.has(c.operation) && jobs.length > 0 && jobs.every((j) => ALIVE_FOR_PREEMPTION.has(statusOf(j)!)),
          unnecessary: false, recovery: null, unsafe_executed: [],
        };
        seen.add(c.command_key);
        records.push(rec);
        byKey.set(c.command_key, rec);
        fresh.push(c);
        if (rec.preemptive) preemptive.push({ rec, jobs });
        if (c.operation === 'migrate_restart') moves.push({ rec, job: jobId, job_failed_at_issue: jobId !== null && statusOf(jobId) === 'failed' });
        if (verdict === 'allow') {
          accepted.add(c.command_key);
          pending.push({ cmd: c, rec });
        } else {
          blocked.add(c.command_key);
        }
      }
      const toEnqueue = fresh.filter((c) => accepted.has(c.command_key));
      if (toEnqueue.length > 0) world = enqueueCommands(world, toEnqueue);
    }

    // dependencies: request what is ready, drop what can never run (repeat: a drop can cascade)
    const requested: Pending[] = [];
    const dropped = new Set<string>();
    for (let changed = true; changed;) {
      changed = false;
      const next: Pending[] = [];
      for (const p of pending) {
        const ds = depsOf(p.cmd);
        const missing = ds.find((k) => !seen.has(k));
        const failed = ds.find((k) => blocked.has(k) || dropped.has(k) || byKey.get(k)?.disposition === 'dependency_dropped'
          || byKey.get(k)?.disposition === 'physics_rejected' || outcomeOf(k)?.ok === false);
        if (missing !== undefined || failed !== undefined) {
          p.rec.disposition = 'dependency_dropped';
          p.rec.dependency_reason = missing !== undefined ? 'DEPENDENCY_NOT_FOUND' : 'DEPENDENCY_FAILED';
          dropped.add(p.cmd.command_key);
          changed = true;
        } else if (ready(p.cmd)) {
          requested.push(p);
        } else {
          next.push(p);
        }
      }
      pending = next;
    }

    // per-tick accounting at t0 (copied from simulate.ts; the state step() integrates with)
    const h0 = hiddenOf(world);
    const cond0 = faultConditions(world.active_faults_private, topo);
    const gpuRows = new Map(world.observable.gpus.map((g) => [g.resource_id, g]));
    const before = new Map<string, { progress: number; gain: number; status: JobState['status'] }>();
    for (const j of world.observable.job_states) {
      let gain = 0;
      if (j.allocated_gpu_ids.length > 0 && ACTIVE_STATUSES.has(j.status)) {
        const spec = specOf(world, j.job_id);
        for (const g of j.allocated_gpu_ids) {
          let factor = 0;
          const row = gpuRows.get(g);
          const f = h0.gpu_failure[g];
          if (j.status === 'running' && row && !(f && UNREACHABLE_FAILURES.has(f))) {
            const p = gpuPhysics(row, 1, h0, topo, cond0);
            factor = p.clock_factor;
            if (p.throttled) atRisk.add(j.job_id);
          }
          waste += (1 - factor) * dtS;
          gain += (spec?.work_rate_per_gpu_per_sim_s ?? 0) * factor * dtS;
        }
        if (spec) gain = Math.min(gain, Math.max(0, spec.total_work_units - j.progress_work_units));
      }
      before.set(j.job_id, { progress: j.progress_work_units, gain, status: j.status });
    }

    // 8. the tick
    const result = step(scenarioTickInput(s, world, requested.map((p) => p.cmd.action_id)));
    world = result.world_after;
    const h1 = hiddenOf(world);

    for (const j of world.observable.job_states) {
      const b = before.get(j.job_id);
      if (b) {
        const shortfall = b.progress + b.gain - j.progress_work_units;
        if (shortfall > EPS) lost += shortfall;
      }
      if (j.status === 'failed' && b && b.status !== 'failed') {
        atRisk.add(j.job_id);
        failures.set(j.job_id, [...(failures.get(j.job_id) ?? []), t1]);
      }
    }

    // started or rejected by physics?
    for (const p of requested) {
      const key = p.cmd.command_key;
      p.rec.requested_sim_time_ms = t1;
      const flight = h1.in_flight.find((f) => f.command.command_key === key);
      const o = outcomeOf(key);
      if (flight || o?.reason_code === 'JOB_FAILED_DURING_OPERATION') {
        p.rec.disposition = 'executed';
        if (p.cmd.operation === 'migrate_restart') {
          const job = world.observable.job_states.find((j) => j.job_id === p.rec.job_id);
          watches.push({ rec: p.rec, dest: [...(flight?.destination_gpu_ids ?? job?.allocated_gpu_ids ?? [])], until_ms: null });
        }
      } else {
        p.rec.disposition = 'physics_rejected';
      }
    }

    // destination watch for executed moves (true temperatures)
    for (const w of watches) {
      if (w.until_ms !== null && t1 > w.until_ms) continue;
      if (!w.rec.unsafe_executed.includes('DEST_REACHED_SLOWDOWN')) {
        const temps = trueTemps(world, topo, w.dest);
        const hot = w.dest.some((g) => h1.gpu_failure[g] === 'thermal_shutdown' || (temps.get(g) ?? -Infinity) >= SLOWDOWN_C);
        if (hot) w.rec.unsafe_executed.push('DEST_REACHED_SLOWDOWN');
      }
      if (w.until_ms === null) {
        const o = outcomeOf(w.rec.command_key);
        if (o) w.until_ms = o.ok ? o.sim_time_ms + SAFETY_LOOKAHEAD_S * 1000 : o.sim_time_ms;
      }
    }
  }

  // outcomes, delay
  for (const r of records) {
    const o = r.disposition === 'executed' || r.disposition === 'physics_rejected' ? outcomeOf(r.command_key) : null;
    r.outcome = o ? { status: o.ok ? 'succeeded' : 'failed', reason_code: o.reason_code, sim_time_ms: o.sim_time_ms } : null;
  }
  let delay = 0;
  for (const j of world.observable.job_states) {
    const st = start.get(j.job_id);
    const spec = specOf(world, j.job_id);
    if (!st || !spec || st.status === 'completed') continue;
    const rate = spec.gpus_required * spec.work_rate_per_gpu_per_sim_s;
    if (!(rate > 0)) continue;
    const ideal = Math.min(rate * simS, Math.max(0, spec.total_work_units - st.progress));
    delay += Math.max(0, ideal - (j.progress_work_units - st.progress)) / rate;
  }

  const jobs = world.observable.job_states;
  return {
    details: {
      gate, ticks, start_sim_time_ms: startMs, end_sim_time_ms: world.observable.clock.sim_time_ms, commands: records,
      duplicate_commands_ignored: duplicates, retry_dropped: retryDropped,
      unfinished_job_ids: jobs.filter((j) => j.status !== 'completed').map((j) => j.job_id).sort(),
      failed_job_ids: jobs.filter((j) => j.status === 'failed').map((j) => j.job_id).sort(),
      completed_job_ids: jobs.filter((j) => j.status === 'completed').map((j) => j.job_id).sort(),
    },
    lost, delay, waste, at_risk: atRisk, failures, preemptive, moves,
  };
}

// ---- do-nothing reference (memoized per scenario: deterministic, so a cache changes no result) ---------

const REFERENCE_CACHE = new Map<string, readonly string[]>();
const REFERENCE_CACHE_MAX = 64;

async function referenceAtRisk(s: Scenario): Promise<Set<string>> {
  const key = JSON.stringify(s);
  let ids = REFERENCE_CACHE.get(key);
  if (!ids) {
    ids = [...(await runCore(s, null, 'safety')).at_risk].sort();
    if (REFERENCE_CACHE.size >= REFERENCE_CACHE_MAX) REFERENCE_CACHE.delete(REFERENCE_CACHE.keys().next().value!);
    REFERENCE_CACHE.set(key, ids);
  }
  return new Set(ids);
}

// ---- public API -----------------------------------------------------------------------------------

/** runScenario plus the per-command log and job outcomes (for P4's drill-down; not a wire type). */
export async function runScenarioDetailed(s: Scenario, policy: Policy, opts: RunScenarioOptions): Promise<ScenarioRunDetails> {
  const gate = opts.gate ?? 'safety';
  const core = await runCore(s, policy, gate);
  const ref = await referenceAtRisk(s);

  let unnecessary = 0;
  for (const p of core.preemptive) {
    if (p.rec.disposition !== 'executed') continue;
    if (p.jobs.every((j) => !ref.has(j))) {
      p.rec.unnecessary = true;
      unnecessary += 1;
    }
  }

  let ok = 0;
  let bad = 0;
  for (const m of core.moves) {
    if (!(m.job_failed_at_issue || (m.job !== null && ref.has(m.job)))) continue;
    const r = m.rec;
    if (r.disposition === 'blocked') continue;
    if (r.disposition === 'waiting' || (r.disposition === 'executed' && r.outcome === null)) r.recovery = 'unresolved';
    else if (r.disposition !== 'executed' || r.outcome?.status !== 'succeeded') r.recovery = 'failed';
    else r.recovery = (core.failures.get(m.job ?? '') ?? []).some((t) => t >= r.outcome!.sim_time_ms) ? 'failed' : 'succeeded';
    if (r.recovery === 'succeeded') ok += 1;
    if (r.recovery === 'failed') bad += 1;
  }

  let unsafeExecuted = 0;
  for (const r of core.details.commands) {
    if (r.disposition !== 'executed') continue;
    if (r.safety.decision === 'deny') r.unsafe_executed.unshift('SAFETY_DENY');
    if (r.unsafe_executed.length > 0) unsafeExecuted += 1;
  }

  const result: EvaluationResult = {
    schema_version: V,
    run_id: opts.run_id ?? `eval-${opts.policy_name}-${s.scenario_id}`,
    scenario_id: s.scenario_id,
    seed: s.seed,
    policy: opts.policy_name,
    lost_work_units: r3(core.lost),
    job_completion_delay_s: r3(core.delay),
    gpu_busy_waste_s: r3(core.waste),
    unnecessary_preemptions: unnecessary,
    unsafe_actions_executed: unsafeExecuted,
    unsafe_actions_blocked: core.details.commands.filter((r) => r.disposition === 'blocked').length,
    successful_recoveries: ok,
    failed_recoveries: bad,
    agent_crash_resumes: 0,
  };
  return { result, ...core.details, reference_at_risk_job_ids: [...ref].sort() };
}

/** CONTRACTS §0.6 harness: run one scenario under a policy. See the header for every metric definition. */
export async function runScenario(s: Scenario, policy: Policy, opts: RunScenarioOptions): Promise<EvaluationResult> {
  return (await runScenarioDetailed(s, policy, opts)).result;
}

/** One EvaluationResult per loadScenarios() entry, in scenario_id order (run sequentially). */
export async function runAllScenarios(policy: Policy, opts: RunScenarioOptions): Promise<EvaluationResult[]> {
  const out: EvaluationResult[] = [];
  for (const s of loadScenarios()) out.push(await runScenario(s, policy, opts));
  return out;
}

/** Per-policy totals for P4's scoreboard. */
export interface PolicySummary {
  policy: string;
  scenarios: number;
  lost_work_units: number;
  job_completion_delay_s: number;
  gpu_busy_waste_s: number;
  unnecessary_preemptions: number;
  unsafe_actions_executed: number;
  unsafe_actions_blocked: number;
  successful_recoveries: number;
  failed_recoveries: number;
  agent_crash_resumes: number;
}

const SUMMED = [
  'lost_work_units', 'job_completion_delay_s', 'gpu_busy_waste_s', 'unnecessary_preemptions', 'unsafe_actions_executed',
  'unsafe_actions_blocked', 'successful_recoveries', 'failed_recoveries', 'agent_crash_resumes',
] as const;

/**
 * Totals per policy (sorted by policy name). The three float totals are rounded to 0.001. Accepts rows whose policy is
 * any string, so the do-nothing reference rows can be summarized next to the contract policies.
 */
export function summarizeResults(results: readonly (Omit<EvaluationResult, 'policy'> & { policy: string })[]): PolicySummary[] {
  const by = new Map<string, PolicySummary>();
  for (const r of results) {
    let sum = by.get(r.policy);
    if (!sum) {
      sum = { policy: r.policy, scenarios: 0, lost_work_units: 0, job_completion_delay_s: 0, gpu_busy_waste_s: 0,
        unnecessary_preemptions: 0, unsafe_actions_executed: 0, unsafe_actions_blocked: 0, successful_recoveries: 0,
        failed_recoveries: 0, agent_crash_resumes: 0 };
      by.set(r.policy, sum);
    }
    sum.scenarios += 1;
    for (const k of SUMMED) sum[k] += r[k];
  }
  return [...by.values()]
    .map((x) => ({ ...x, lost_work_units: r3(x.lost_work_units), job_completion_delay_s: r3(x.job_completion_delay_s), gpu_busy_waste_s: r3(x.gpu_busy_waste_s) }))
    .sort((a, b) => (a.policy < b.policy ? -1 : a.policy > b.policy ? 1 : 0));
}
