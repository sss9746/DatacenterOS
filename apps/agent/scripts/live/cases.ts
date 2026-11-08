// The six R5 cases (TASKS R5 table, SCOPE §6 steps 2-6) over a REAL database and a REAL agent child.
// Each case: controlled reset (agent stopped) -> spawn agent -> inject via admin -> wait on observed DB
// state (bounded) -> crash/probe -> assert from public ledger/snapshot data -> artifact.
// The agent never receives private fault truth; the harness only reads public plan/ledger rows.

import type { ActionCommand, ActionStatus } from '@dcos/contracts';
import { isDbError, type ActionDetail, type DbClient, type WorkflowRecord } from '@dcos/db-client';
import { spawnAgent, buildAgentEnv, directAgentSpawnSpec, type AgentHandle } from './agent-process.js';
import type { CaseId, HarnessArgs, TargetPolicy, TeamMode } from './args.js';
import {
  allPassed,
  allWorkflowsSettled,
  buildProvenance,
  check,
  checkAllocationUniqueness,
  checkCheckpointOnce,
  checkFirstWaitPreserved,
  checkHandoffRecorded,
  checkDestinationReplanned,
  checkFallbackAttributed,
  checkHardSafetyHeld,
  checkJobInOperatorHandoff,
  checkKeysReconciled,
  checkNoNewDurableCheckpoint,
  checkNoRestartDuringOutage,
  checkNotRestarted,
  checkpointBaseline,
  checkProvenanceReported,
  checkRecoveredOrEscalated,
  checkRecoveryWaiting,
  checkRestartFromCheckpoint,
  checkSeparateIncidents,
  checkSinglePlacement,
  checkTeamRounds,
  checkWorkAdvanced,
  checkWorkflowReclaimed,
  extractPlannedDestinations,
  finalMigrate,
  allocationUniqueness,
  newLlmLogStats,
  nodeOutage,
  recoveryOf,
  tallyLlmLogLine,
  waitingJobIds,
  type Check,
  type CheckpointBaseline,
  type LlmLogStats,
  type RecoverySample,
} from './asserts.js';
import { deriveCheckpointDue, describeDue } from './due.js';
import { COOLING_RESOURCE_IDS, dueTickTooLate, nodeCrash, nodeOfGpu, pumpDegradation, simulatedNodeIds, xid79 } from './faults.js';
import { byKey, completeCheckpoints, createObserver, jobState, ledgerRow, openAction, snapshotSummary, type LiveState, type Observer } from './observe.js';
import type { Redactor } from './redact.js';
import type { AgentGenerationRecord, CaseArtifact, RunMeta, TimelineEntry } from './report.js';
import { controlledReset } from './reset.js';
import { Budget, WaitTimeoutError } from './wait.js';

export const JOB_A = 'job-a';
export const JOB_B = 'job-b';
export const JOB_C = 'job-c';
/** Scene B: the jobs with a completed checkpoint, and every job the outage takes down. */
const RESTART_JOBS = [JOB_A, JOB_B] as const;
const SCENE_B_JOBS = [JOB_A, JOB_B, JOB_C] as const;
const SCENE_B_NODE_COUNT = 8;
/** Sim steps between reading the clock and the outage tick: room for all eight reducer calls to land first. */
const OUTAGE_LEAD_STEPS = 12;
/** Physics constants mirrored for timeout sizing only (never for correctness). */
const CHECKPOINT_SIM_MS = 30_000;
const RESTART_SIM_MS = 120_000;
const WORKFLOW_LEASE_MS = 15_000;
const L6_UNREACHABLE_NIM = 'http://127.0.0.1:9/v1';
const MAX_REPORTED_ROUNDS = 8;

export const CASE_TITLES: Record<CaseId, string> = {
  L1: 'SIGKILL during checkpoint; fresh process reclaims',
  L2: 'Xid 79 on the actual planned destination during the source write',
  L3: 'L1 + L2: destination Xid then SIGKILL; fresh process sees both incidents',
  L4: 'Stale fencing token cannot mutate after takeover',
  L5: 'Source Xid 79 on the checkpoint due tick: no new durable checkpoint',
  L6: 'Model unreachable: hard safety holds, fallback attributed to code',
  SB: 'Scene B: all nodes down, checkpoint-backed jobs wait and restart when nodes return',
  SBK: 'Scene B + SIGKILL during the wait: fresh process keeps the wait and places once',
};

/**
 * Whether this case launches the agent as a single process so SIGKILL truly ends it. Single-mode L1-L6 keep the
 * original `tsx/cli` launch unchanged; Scene B and every case under multi need a real kill.
 */
export const needsDirectAgent = (id: CaseId, teamMode: TeamMode): boolean => teamMode === 'multi' || id === 'SB' || id === 'SBK';

/** A Lead decision is only possible with a real model; L6 forces the endpoint unreachable. */
export const expectsLead = (id: CaseId, llmMode: RunMeta['llm_mode']): boolean => llmMode === 'live_nim' && id !== 'L6';

export interface CaseEnv {
  args: HarnessArgs;
  target: TargetPolicy;
  meta: RunMeta;
  admin: DbClient;
  /** Merged env (process.env over .env.local), used to build the agent child's env. */
  env: Record<string, string | undefined>;
  uri: string;
  agentToken: string;
  redact: Redactor;
  log: (m: string) => void;
}

// --------------------------------------------------------------------------------------- recorder

class CaseRun {
  readonly checks: Check[] = [];
  readonly timeline: TimelineEntry[] = [];
  readonly generations: AgentGenerationRecord[] = [];
  readonly keys: Record<string, string | null> = {};
  readonly started = Date.now();
  simStart: number | null = null;
  verification: Record<string, unknown> | null = null;
  checkpointCount: CaseArtifact['checkpoint_count'] = null;
  readonly llmLog: LlmLogStats = newLlmLogStats();
  private gen = 0;
  private agent: AgentHandle | null = null;
  readonly budget: Budget;

  constructor(readonly id: CaseId, readonly env: CaseEnv, readonly obs: Observer) {
    this.budget = new Budget(env.args.timeoutS * 1_000);
  }

  log(event: string, detail?: Record<string, unknown>) {
    const sim = this.obs.simNow() || null;
    this.timeline.push(detail ? { wall_unix_ms: Date.now(), sim_time_ms: sim, event, detail } : { wall_unix_ms: Date.now(), sim_time_ms: sim, event });
    this.env.log(`[${this.id}] ${event}${detail ? ' ' + JSON.stringify(detail) : ''}`);
  }
  add(c: Check) {
    this.checks.push(c);
    this.env.log(`[${this.id}] ${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
  }
  key(name: string, value: string | null) {
    this.keys[name] = value;
  }

  // ---- agent lifecycle
  startAgent(opts: { noLlm: boolean; llmOverride?: { baseUrl: string; timeoutMs: number; retries: number } }): AgentHandle {
    this.gen += 1;
    const teamMode = this.env.args.teamMode;
    const env = buildAgentEnv({ base: this.env.env, uri: this.env.uri, db: this.env.args.db, agentToken: this.env.agentToken, noLlm: opts.noLlm, llmOverride: opts.llmOverride, teamMode });
    const spec = needsDirectAgent(this.id, teamMode) ? directAgentSpawnSpec() : undefined;
    const h = spawnAgent({
      env,
      redact: this.env.redact,
      generation: this.gen,
      spec,
      onLine: (l) => {
        tallyLlmLogLine(this.llmLog, l);
        this.env.log(`  agent#${this.gen} ${l}`);
      },
    });
    this.agent = h;
    this.generations.push({ generation: this.gen, pid: h.pid, started_unix_ms: h.startedUnixMs, ended_unix_ms: null, how_ended: 'running', exit_code: null, stderr_tail: [] });
    this.log(`agent generation ${this.gen} spawned`, { pid: h.pid, no_llm: opts.noLlm, nim_override: opts.llmOverride ? 'unreachable' : null, team_mode: teamMode });
    return h;
  }
  private record(h: AgentHandle, how: AgentGenerationRecord['how_ended']) {
    const g = this.generations.find((x) => x.generation === h.generation);
    if (!g) return;
    g.ended_unix_ms = Date.now();
    g.how_ended = how;
    g.exit_code = h.exitCode();
    g.stderr_tail = h.tail().slice(-60);
  }
  async killAgent(): Promise<void> {
    const h = this.agent;
    if (!h) throw new Error('no agent to kill');
    const simAtKill = this.obs.simNow();
    const r = await h.kill();
    this.record(h, r.how);
    this.agent = null;
    this.log(`agent generation ${h.generation} killed`, { pid: h.pid, how: r.how, waited_ms: r.waitedMs, sim_at_kill: simAtKill });
  }
  async stopAgent(): Promise<void> {
    const h = this.agent;
    if (!h) return;
    const r = await h.kill();
    this.record(h, h.exitCode() !== null && r.how === 'already_exited' ? 'exited' : 'stopped_by_harness');
    this.agent = null;
    this.log(`agent generation ${h.generation} stopped by harness`, { pid: h.pid });
  }
  /** Abort rule for waits that need a LIVE agent: fail fast if the child died. */
  agentMustBeAlive = (): string | null => {
    const h = this.agent;
    if (!h) return 'no agent process is running';
    if (!h.isAlive()) return `agent generation ${h.generation} exited (code ${h.exitCode()}); tail: ${h.tail().slice(-5).join(' | ')}`;
    return null;
  };
  agentAlive(): boolean {
    return this.agent?.isAlive() ?? false;
  }

  until<R>(what: string, wantMs: number, pred: (s: LiveState) => R, needAgent = true) {
    return this.obs.until(what, this.budget.slice(wantMs), pred, needAgent ? this.agentMustBeAlive : undefined);
  }

  /** Observed model/fallback usage, from persisted events and rounds plus the agent's own log lines. */
  provenance(events: LiveState['events']) {
    return buildProvenance(this.env.meta.model, this.env.meta.llm_mode, events, this.llmLog, this.obs.teamRounds());
  }

  async artifact(passed: boolean, error: string | null, last: LiveState | null): Promise<CaseArtifact> {
    const alloc = last ? allocationUniqueness(last.snapshot.allocations, last.jobs) : null;
    const failures = this.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    if (error) failures.push(error);
    const multi = this.env.args.teamMode === 'multi';
    const rounds = this.obs.teamRounds();
    const team = multi
      ? {
          lead_rounds: rounds.filter((r) => r.trace.outcome === 'lead').length,
          fallback_rounds: rounds.filter((r) => r.trace.outcome === 'deterministic').length,
          malformed_workflows: this.obs.teamMalformed(),
          rounds: rounds.slice(-MAX_REPORTED_ROUNDS),
        }
      : null;
    const label = this.env.meta.llm_mode === 'live_nim' ? 'live DB + real agent process + live NIM' : this.env.meta.llm_mode === 'deterministic_no_llm' ? 'live DB + real agent process, DETERMINISTIC (no LLM) rehearsal' : 'live DB + real agent process, NIM forced unreachable';
    return {
      case: this.id,
      title: CASE_TITLES[this.id],
      evidence_label: multi ? `${label} [team mode: multi]` : label,
      passed,
      failure_reasons: failures,
      started_unix_ms: this.started,
      ended_unix_ms: Date.now(),
      sim_start_ms: this.simStart,
      sim_end_ms: last?.snapshot.clock.sim_time_ms ?? null,
      command_keys: this.keys,
      checks: this.checks,
      allocation_uniqueness: alloc ? { ok: alloc.ok, doubled: alloc.doubled } : null,
      checkpoint_count: this.checkpointCount,
      verification: this.verification,
      agent_generations: this.generations,
      timeline: this.timeline,
      last_snapshot_summary: last ? snapshotSummary(last) : null,
      ledger: last ? last.details.map(ledgerRow) : [],
      team,
      provenance: last && needsDirectAgent(this.id, this.env.args.teamMode) ? this.provenance(last.events) : null,
      error,
    };
  }
}

// --------------------------------------------------------------------------------------- shared steps

async function resetIfAllowed(run: CaseRun): Promise<void> {
  const { env } = run;
  if (!env.target.willReset) {
    run.log('reset skipped (--skip-reset or prod)');
    return;
  }
  const rep = await controlledReset(env.admin, { db: env.args.db, runId: env.args.runId, seed: env.args.seed, presetId: env.args.presetId, speed: env.args.speed, agentStopped: !run.agentAlive(), log: env.log });
  run.log('controlled reset done', { sim_time_after_ms: rep.sim_time_after_ms, tick_index: rep.tick_index_after, gpus: rep.gpus, jobs: rep.jobs, actions: rep.actions, speed: rep.speed });
}

async function injectPump(run: CaseRun): Promise<void> {
  const s = await run.obs.read();
  const f = pumpDegradation(run.env.args.runId, s.snapshot.clock, 0.6, run.id.toLowerCase());
  await run.env.admin.injectFault(f);
  run.log('injected pump-a degradation 0.6', { fault_id: f.fault_id, start_sim_time_ms: f.start_sim_time_ms });
}

async function injectXid(run: CaseRun, gpu: string, startSimMs?: number): Promise<number> {
  const s = await run.obs.read();
  const f = xid79(run.env.args.runId, gpu, s.snapshot.clock, startSimMs, run.id.toLowerCase());
  await run.env.admin.injectFault(f);
  run.log(`injected gpu_xid_79 on ${gpu}`, { fault_id: f.fault_id, start_sim_time_ms: f.start_sim_time_ms });
  return f.start_sim_time_ms;
}

/** Wait until job-a's checkpoint action is `running` (the source write is in progress). */
async function waitCheckpointRunning(run: CaseRun): Promise<{ detail: ActionDetail; state: LiveState }> {
  const want = 150_000 + (run.env.args.noLlm ? 0 : 90_000);
  const r = await run.until(`${JOB_A} checkpoint action running`, want, (s) => {
    const d = openAction(s, 'checkpoint', JOB_A);
    return d && d.status.status === 'running' ? d : null;
  });
  run.key('checkpoint', r.value.command.command_key);
  run.obs.trackWorkflow(r.value.command.workflow_id);
  run.log('checkpoint running', { command_key: r.value.command.command_key, due_sim_time_ms: r.value.due_sim_time_ms, waited_ms: r.waitedMs });
  return { detail: r.value, state: r.state };
}

/** Wait until a migrate destination for job-a is observable from public plan/ledger rows (never guessed). */
async function waitPlannedDestination(run: CaseRun): Promise<{ key: string; gpus: string[]; source: string }> {
  const r = await run.until(`an observable migrate destination for ${JOB_A} (public plan/ledger rows)`, 60_000, (s) => {
    const dests = extractPlannedDestinations(s.details, s.workflows, JOB_A);
    return dests.length ? dests[0]! : null;
  });
  run.key('planned_migrate', r.value.command_key);
  run.log('planned destination observed', { command_key: r.value.command_key, source: r.value.source, status: r.value.status, gpu_ids: r.value.gpu_ids });
  return { key: r.value.command_key, gpus: r.value.gpu_ids, source: r.value.source };
}

const wfOf = (s: LiveState, id: string): WorkflowRecord | null => s.workflows.find((w) => w.workflow_id === id) ?? null;

async function assertClockAdvancesWithoutAgent(run: CaseRun): Promise<void> {
  const s0 = await run.obs.read();
  const t0 = s0.snapshot.clock.sim_time_ms;
  try {
    const r = await run.until('DB sim clock to advance with the agent dead', 20_000, (s) => (s.snapshot.clock.sim_time_ms >= t0 + 2 * s.snapshot.clock.step_ms ? s.snapshot.clock.sim_time_ms : null), false);
    run.add(check('DB sim clock advances without the agent', !run.agentAlive(), `${t0} -> ${r.value} in ${r.waitedMs} ms wall, agent alive=${run.agentAlive()}`, { sim_before: t0, sim_after: r.value }));
  } catch (e) {
    run.add(check('DB sim clock advances without the agent', false, e instanceof Error ? e.message : String(e)));
  }
}

async function waitCheckpointCompletesWithoutAgent(run: CaseRun, ck: string): Promise<void> {
  const want = (CHECKPOINT_SIM_MS / run.env.args.speed) + 45_000;
  const r = await run.until(`checkpoint ${ck} to complete while the agent is dead`, want, (s) => {
    const row = s.snapshot.checkpoints.find((c) => c.command_key === ck && c.status === 'complete');
    const act = byKey(s, ck);
    return row && act && act.status.status === 'succeeded' ? { checkpoint_id: row.checkpoint_id, complete_sim_time_ms: row.complete_sim_time_ms } : null;
  }, false);
  run.add(check('checkpoint completed by the DB while the agent was dead', !run.agentAlive(), `${r.value.checkpoint_id} complete at sim ${r.value.complete_sim_time_ms}; agent alive=${run.agentAlive()}`, { ...r.value }));
}

async function waitReclaim(run: CaseRun, wfId: string, oldOwner: string | null): Promise<WorkflowRecord> {
  const r = await run.until(`workflow ${wfId} reclaimed by the fresh agent process`, WORKFLOW_LEASE_MS + 90_000, (s) => {
    const w = wfOf(s, wfId);
    return w && w.lease_owner && w.lease_owner !== oldOwner ? w : null;
  });
  run.log('workflow reclaimed', { workflow_id: wfId, owner: r.value.lease_owner, attempt: r.value.attempt, waited_ms: r.waitedMs });
  return r.value;
}

async function waitWorkflowSettled(run: CaseRun, wfId: string, extraMs = 0): Promise<{ wf: WorkflowRecord; state: LiveState }> {
  const want = (RESTART_SIM_MS / run.env.args.speed) + 150_000 + extraMs;
  const r = await run.until(`workflow ${wfId} to finish (done/escalated)`, want, (s) => {
    const w = wfOf(s, wfId);
    return w && (w.stage === 'done' || w.stage === 'escalated') ? w : null;
  });
  const v = (r.value.state as { verification?: unknown }).verification;
  run.verification = v && typeof v === 'object' ? (v as Record<string, unknown>) : { stage: r.value.stage, escalation_reason: (r.value.state as { escalation_reason?: unknown }).escalation_reason ?? null };
  run.log('workflow settled', { workflow_id: wfId, stage: r.value.stage, waited_ms: r.waitedMs });
  return { wf: r.value, state: r.state };
}

/** Default bound for `waitAllWorkflowsSettled`: one more restart-length workflow plus slack. */
const allSettledWant = (run: CaseRun): number => RESTART_SIM_MS / run.env.args.speed + 120_000;

/**
 * Wait until EVERY workflow of the run is done/escalated, not just the one the case followed. A fault
 * injected mid-case (e.g. L2's destination Xid) opens a second workflow whose verification/handoff must
 * be persisted before the harness resets for the next case; otherwise the dashboard shows "Verifying…".
 * Every workflow seen while waiting is tracked so it stays readable after it closes.
 */
async function waitAllWorkflowsSettled(run: CaseRun, timeoutMs: number): Promise<{ workflows: WorkflowRecord[]; state: LiveState }> {
  try {
    const r = await run.until('every workflow of the run to finish (done/escalated)', timeoutMs, (s) => {
      for (const w of s.workflows) run.obs.trackWorkflow(w.workflow_id);
      return allWorkflowsSettled(s.workflows).settled ? s.workflows : null;
    });
    run.log('all workflows settled', { workflows: r.value.map((w) => `${w.workflow_id}@${w.stage}`), waited_ms: r.waitedMs });
    return { workflows: r.value, state: r.state };
  } catch (e) {
    if (!(e instanceof WaitTimeoutError)) throw e;
    const rep = allWorkflowsSettled(run.obs.current()?.workflows ?? []);
    throw new WaitTimeoutError(
      `every workflow of the run to finish (done/escalated); still pending: ${rep.pending.length ? rep.pending.join(', ') : '(none readable)'} of ${rep.total} workflow(s)`,
      e.waitedMs,
      e.lastSummary,
    );
  }
}

/** One check per settled workflow: it persisted a handoff (verification object, or escalation with a reason). */
function assertHandoffs(run: CaseRun, workflows: readonly WorkflowRecord[]): void {
  if (workflows.length === 0) {
    run.add(check('handoff/verification persisted', false, 'no workflows readable after settlement'));
    return;
  }
  for (const w of workflows) run.add(checkHandoffRecorded(w));
}

function finalChecks(run: CaseRun, s: LiveState, wf: WorkflowRecord, requireDone: boolean) {
  run.add(checkAllocationUniqueness(s.snapshot.allocations, s.jobs));
  const fin = finalMigrate(s.details, JOB_A);
  run.key('final_migrate', fin?.command_key ?? null);
  const ja = jobState(s, JOB_A);
  if (fin) {
    const onDest = ja ? [...ja.allocated_gpu_ids].sort().join() === [...fin.gpu_ids].sort().join() : false;
    run.add(check('migrate succeeded and job-a runs on its destination', fin.status === 'succeeded' && onDest && (ja?.status === 'running' || ja?.status === 'completed' || ja?.status === 'checkpointing'), `${fin.command_key}: ${fin.status}; ${JOB_A} ${ja?.status} on [${ja?.allocated_gpu_ids.join(',')}]`, { command_key: fin.command_key, status: fin.status, job_status: ja?.status ?? null, destination: fin.gpu_ids }));
  } else if (requireDone) {
    run.add(check('migrate succeeded and job-a runs on its destination', false, 'no running/succeeded migrate for job-a', {}));
  }
  const rec = checkRecoveredOrEscalated(wf);
  run.add(requireDone ? { ...rec, ok: rec.ok && wf.stage === 'done', name: 'workflow verified and closed (done)' } : rec);
}

// --------------------------------------------------------------------------------------- cases

async function caseL1(run: CaseRun): Promise<LiveState> {
  run.startAgent({ noLlm: run.env.args.noLlm });
  await injectPump(run);
  const { detail: ck, state: s1 } = await waitCheckpointRunning(run);
  const wfId = ck.command.workflow_id;
  const before = await run.obs.read();
  const wfBefore = wfOf(before, wfId);
  const ckptBaseline = completeCheckpoints(s1, JOB_A);
  run.checkpointCount = { job_id: JOB_A, complete_before: ckptBaseline, complete_after: ckptBaseline };

  await run.killAgent();
  await assertClockAdvancesWithoutAgent(run);
  await waitCheckpointCompletesWithoutAgent(run, ck.command.command_key);

  run.startAgent({ noLlm: run.env.args.noLlm });
  const wfAfter = await waitReclaim(run, wfId, wfBefore?.lease_owner ?? null);
  run.add(checkWorkflowReclaimed(wfBefore, wfAfter));

  const { wf, state } = await waitWorkflowSettled(run, wfId);
  run.add(checkCheckpointOnce(state.snapshot.checkpoints, ck.command.command_key, JOB_A, ckptBaseline));
  run.checkpointCount.complete_after = completeCheckpoints(state, JOB_A);
  run.add(checkKeysReconciled(before.details, state.details));
  finalChecks(run, state, wf, true);
  const all = await waitAllWorkflowsSettled(run, allSettledWant(run));
  return all.state;
}

async function caseL2(run: CaseRun): Promise<LiveState> {
  run.startAgent({ noLlm: run.env.args.noLlm });
  await injectPump(run);
  const { detail: ck, state: s1 } = await waitCheckpointRunning(run);
  const wfId = ck.command.workflow_id;
  const ckptBaseline = completeCheckpoints(s1, JOB_A);
  run.checkpointCount = { job_id: JOB_A, complete_before: ckptBaseline, complete_after: ckptBaseline };
  const dest = await waitPlannedDestination(run);
  const failedGpu = [...dest.gpus].sort()[0]!;
  // The source write must still be in progress when the destination fails.
  const now = await run.obs.read();
  const ckNow = byKey(now, ck.command.command_key);
  run.add(check('source checkpoint still running at destination fault', ckNow?.status.status === 'running', `${ck.command.command_key}: ${ckNow?.status.status}`));
  await injectXid(run, failedGpu);
  run.key('failed_destination_gpu', failedGpu);

  const { wf, state } = await waitWorkflowSettled(run, wfId);
  const links = await run.obs.links();
  run.add(checkSeparateIncidents(state.incidents, links, COOLING_RESOURCE_IDS, [failedGpu, nodeOfGpu(failedGpu) ?? failedGpu]));
  run.add({ ...checkCheckpointOnce(state.snapshot.checkpoints, ck.command.command_key, JOB_A, ckptBaseline), name: 'valid source checkpoint retained' });
  run.checkpointCount.complete_after = completeCheckpoints(state, JOB_A);
  for (const c of checkDestinationReplanned(state.details, JOB_A, dest.key, failedGpu)) run.add(c);
  const ja = jobState(state, JOB_A);
  run.add(check('job-a not allocated to the failed GPU', !(ja?.allocated_gpu_ids ?? []).includes(failedGpu), `${JOB_A} on [${ja?.allocated_gpu_ids.join(',')}]`));
  finalChecks(run, state, wf, false);
  // The destination Xid opened a second workflow: it too must verify/hand off before the next reset.
  const all = await waitAllWorkflowsSettled(run, allSettledWant(run));
  assertHandoffs(run, all.workflows);
  return all.state;
}

async function caseL3(run: CaseRun): Promise<LiveState> {
  run.startAgent({ noLlm: run.env.args.noLlm });
  await injectPump(run);
  const { detail: ck, state: s1 } = await waitCheckpointRunning(run);
  const wfId = ck.command.workflow_id;
  const ckptBaseline = completeCheckpoints(s1, JOB_A);
  run.checkpointCount = { job_id: JOB_A, complete_before: ckptBaseline, complete_after: ckptBaseline };
  const dest = await waitPlannedDestination(run);
  const failedGpu = [...dest.gpus].sort()[0]!;
  run.key('failed_destination_gpu', failedGpu);
  const before = await run.obs.read();
  const wfBefore = wfOf(before, wfId);
  await injectXid(run, failedGpu);
  // Kill right after the destination fault: the fresh process must discover BOTH incidents from the DB.
  await run.killAgent();
  await assertClockAdvancesWithoutAgent(run);
  await waitCheckpointCompletesWithoutAgent(run, ck.command.command_key);

  run.startAgent({ noLlm: run.env.args.noLlm });
  const wfAfter = await waitReclaim(run, wfId, wfBefore?.lease_owner ?? null);
  run.add(checkWorkflowReclaimed(wfBefore, wfAfter));
  const { wf, state } = await waitWorkflowSettled(run, wfId, 60_000);

  const links = await run.obs.links();
  run.add(checkSeparateIncidents(state.incidents, links, COOLING_RESOURCE_IDS, [failedGpu, nodeOfGpu(failedGpu) ?? failedGpu]));
  run.add(checkCheckpointOnce(state.snapshot.checkpoints, ck.command.command_key, JOB_A, ckptBaseline));
  run.checkpointCount.complete_after = completeCheckpoints(state, JOB_A);
  run.add(checkKeysReconciled(before.details, state.details, { allowReplan: true }));
  for (const c of checkDestinationReplanned(state.details, JOB_A, dest.key, failedGpu)) run.add(c);
  const ja = jobState(state, JOB_A);
  run.add(check('job-a not allocated to the failed GPU', !(ja?.allocated_gpu_ids ?? []).includes(failedGpu), `${JOB_A} on [${ja?.allocated_gpu_ids.join(',')}]`));
  finalChecks(run, state, wf, false);
  // Evidence, not just an exit code: the fresh process left a handoff.
  run.add(check('fresh process recorded a handoff/verification', run.verification !== null && Object.keys(run.verification).length > 0, JSON.stringify(run.verification ?? {}).slice(0, 200)));
  const all = await waitAllWorkflowsSettled(run, allSettledWant(run));
  assertHandoffs(run, all.workflows);
  return all.state;
}

async function probeRejected(run: CaseRun, name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn();
    run.add(check(name, false, `MUTATION ACCEPTED with a stale token: ${JSON.stringify(r).slice(0, 120)}`));
  } catch (e) {
    const code = isDbError(e) ? e.code : null;
    const ok = code === 'STALE_FENCING_TOKEN' || code === 'LEASE_HELD' || code === 'LEASE_EXPIRED' || code === 'VERSION_CONFLICT';
    run.add(check(name, ok, `rejected: ${code ?? (e instanceof Error ? e.message : String(e))}`, { code }));
  }
}

async function caseL4(run: CaseRun): Promise<LiveState> {
  run.startAgent({ noLlm: run.env.args.noLlm });
  await injectPump(run);
  const { detail: ck, state: s1 } = await waitCheckpointRunning(run);
  const wfId = ck.command.workflow_id;
  const wfBefore = wfOf(s1, wfId);
  if (!wfBefore) throw new Error(`workflow ${wfId} not readable`);
  const oldToken = wfBefore.fencing_token;
  const oldOwner = wfBefore.lease_owner;
  run.log('captured old worker identity', { workflow_id: wfId, owner: oldOwner, attempt: wfBefore.attempt, token: oldToken.toString() });

  await run.killAgent();
  run.startAgent({ noLlm: run.env.args.noLlm });
  const wfAfter = await waitReclaim(run, wfId, oldOwner);
  run.add(checkWorkflowReclaimed(wfBefore, wfAfter));

  // The "old worker resumes": every protected mutation with the captured token must be fenced out.
  const cur = (await run.obs.workflow(wfId)) ?? wfAfter;
  await probeRejected(run, 'stale token cannot update_workflow', () => run.env.admin.updateWorkflow(wfId, cur.version, oldToken, 'execute', { lr_l4_probe: true }));
  await probeRejected(run, 'stale token cannot heartbeat_workflow', () => run.env.admin.heartbeatWorkflow(wfId, oldOwner ?? 'old-worker', oldToken, WORKFLOW_LEASE_MS));
  const s2 = await run.obs.read();
  const open = s2.details.find((d) => d.command.workflow_id === wfId && (d.status.status === 'requested' || d.status.status === 'claimed'));
  if (open) {
    await probeRejected(run, 'stale token cannot cancel protected action', () => run.env.admin.cancelAction(open.command.command_key, 'LR_L4_PROBE', oldToken));
    if (open.status.status === 'claimed') await probeRejected(run, 'stale token cannot start protected action', () => run.env.admin.startAction(open.command.command_key, oldToken));
  } else {
    run.log('no requested/claimed action to probe cancel/start against (all running or terminal)');
  }
  const after = await run.obs.workflow(wfId);
  run.add(check('probe did not mutate workflow state', !(after?.state as { lr_l4_probe?: unknown } | undefined)?.lr_l4_probe, `stage ${after?.stage} v${after?.version} owner ${after?.lease_owner}`));

  const { wf, state } = await waitWorkflowSettled(run, wfId);
  run.add(check('new owner proceeded', wf.lease_owner !== oldOwner && wf.version > wfAfter.version, `owner ${wf.lease_owner}, version ${wfAfter.version} -> ${wf.version}`));
  finalChecks(run, state, wf, false);
  return state;
}

async function caseL5(run: CaseRun): Promise<LiveState> {
  run.startAgent({ noLlm: run.env.args.noLlm });
  await injectPump(run);
  const { detail: ck, state: s1 } = await waitCheckpointRunning(run);
  const wfId = ck.command.workflow_id;
  const ckptBaseline = completeCheckpoints(s1, JOB_A);
  run.checkpointCount = { job_id: JOB_A, complete_before: ckptBaseline, complete_after: ckptBaseline };
  const ja0 = jobState(s1, JOB_A);
  const durableBefore = ja0?.durable_work_units ?? 0;
  // The live ledger may carry due_sim_time_ms = null for a running checkpoint: derive it (start + 30 s) from
  // the checkpoint row / lifecycle history, or, as a labeled estimate, from when the harness first saw it running.
  const dueD = deriveCheckpointDue(ck, s1.snapshot.checkpoints, s1.snapshot.clock.sim_time_ms);
  const due = dueD.due_sim_time_ms;
  run.log(dueD.source === 'ledger_due' ? 'checkpoint due tick from ledger' : `checkpoint due tick DERIVED (${describeDue(dueD)})${dueD.estimate ? ' -- no start time observable; this is an estimate' : ''}`, {
    command_key: ck.command.command_key,
    due_sim_time_ms: due,
    start_sim_time_ms: dueD.start_sim_time_ms,
    source: dueD.source,
    estimate: dueD.estimate,
  });
  // Lead guard against a FRESH clock: at least two steps until the due tick, or injecting would land late.
  const clockNow = (await run.obs.read()).snapshot.clock;
  const late = dueTickTooLate(clockNow, due);
  if (late) throw new Error(`cannot time the source fault to the checkpoint due tick (${describeDue(dueD)}): ${late}. Re-run with a lower --speed so the harness observes the running checkpoint earlier.`);
  const sourceGpu = [...(ja0?.allocated_gpu_ids ?? [])].sort()[0];
  if (!sourceGpu) throw new Error(`${JOB_A} has no allocated GPUs to fault`);
  run.key('source_gpu', sourceGpu);
  const start = await injectXid(run, sourceGpu, due);
  run.add(check('source fault scheduled on the checkpoint due tick', start === due, `fault start ${start} == due ${due}`, { due_sim_time_ms: due }));

  const r = await run.until(`checkpoint ${ck.command.command_key} to settle after the due-tick fault`, (CHECKPOINT_SIM_MS / run.env.args.speed) + 60_000, (s) => {
    const a = byKey(s, ck.command.command_key);
    return a && (a.status.status === 'failed' || a.status.status === 'succeeded' || a.status.status === 'cancelled') ? a : null;
  }, false);
  run.add(check('checkpoint action did not succeed', r.value.status.status !== 'succeeded', `${ck.command.command_key}: ${r.value.status.status}${r.value.status.reason_code ? ` (${r.value.status.reason_code})` : ''}`));

  const { wf, state } = await waitWorkflowSettled(run, wfId);
  const ja = jobState(state, JOB_A);
  run.add(checkNoNewDurableCheckpoint(state.snapshot.checkpoints, ck.command.command_key, JOB_A, ckptBaseline, durableBefore, ja?.durable_work_units ?? 0));
  run.checkpointCount.complete_after = completeCheckpoints(state, JOB_A);
  const consumers = state.details.filter((d) => d.command.depends_on_command_keys.includes(ck.command.command_key));
  const consumed = consumers.filter((d) => d.status.status === 'running' || d.status.status === 'succeeded');
  run.add(check('dependent move did not consume the failed write', consumed.length === 0, consumers.length ? consumers.map((d) => `${d.command.command_key}=${d.status.status}`).join(', ') : 'no dependent command', { consumers: consumers.map((d) => d.command.command_key) }));
  finalChecks(run, state, wf, false);
  const all = await waitAllWorkflowsSettled(run, allSettledWant(run));
  return all.state;
}

function unsafeProbeCommand(s: LiveState, wfId: string): ActionCommand | null {
  const jb = jobState(s, JOB_B);
  const inc = s.incidents[0]?.incident_id;
  if (!jb || jb.allocated_gpu_ids.length === 0 || !inc) return null;
  const key = `lr-l6-probe:migrate_restart:${JOB_A}:${Date.now()}`;
  return {
    schema_version: '1.1.0',
    run_id: s.snapshot.run_id,
    action_id: `act:${key}`,
    command_key: key,
    workflow_id: wfId,
    plan_id: 'plan-lr-l6-probe',
    incident_ids: [inc],
    operation: 'migrate_restart',
    target_resource_id: JOB_A,
    job_id: JOB_A,
    arguments: { destination_gpu_ids: [...jb.allocated_gpu_ids] },
    depends_on_command_keys: [],
    expected_decision_epoch: s.snapshot.clock.decision_epoch,
    expected_resource_versions: {},
    requested_sim_time_ms: s.snapshot.clock.sim_time_ms,
  };
}

async function caseL6(run: CaseRun): Promise<LiveState> {
  run.startAgent({ noLlm: false, llmOverride: { baseUrl: L6_UNREACHABLE_NIM, timeoutMs: 1_500, retries: 0 } });
  await injectPump(run);
  const r = await run.until('the agent to open a workflow and act (model unreachable)', 180_000, (s) => {
    const w = s.workflows[0];
    return w && (s.details.length > 0 || w.stage === 'escalated' || w.stage === 'done') ? w : null;
  });
  const wfId = r.value.workflow_id;
  run.obs.trackWorkflow(wfId);

  // A separate manual safety probe (SCOPE §6 step 3 style): move job-a onto job-b's busy GPUs.
  const s = await run.obs.read();
  const cmd = unsafeProbeCommand(s, wfId);
  if (!cmd) {
    run.add(check('manual unsafe probe rejected by hard safety', false, 'could not build probe (no job-b allocation or no incident yet)'));
  } else {
    run.key('unsafe_probe', cmd.command_key);
    try {
      const st: ActionStatus = await run.env.admin.requestAction(cmd);
      const ok = st.status === 'failed' && st.reason_code === 'SAFETY_REJECTED';
      run.add(check('manual unsafe probe rejected by hard safety', ok, `${st.status}${st.reason_code ? ` (${st.reason_code})` : ''}`, { command_key: cmd.command_key, status: st.status, reason_code: st.reason_code }));
    } catch (e) {
      run.add(check('manual unsafe probe rejected by hard safety', false, `ledger threw instead of returning SAFETY_REJECTED: ${isDbError(e) ? e.code : e instanceof Error ? e.message : String(e)}`));
    }
  }

  const { wf, state } = await waitWorkflowSettled(run, wfId);
  run.add(checkHardSafetyHeld(state.details));
  run.add(checkFallbackAttributed(state.events, { expectNoNemotron: true }));
  run.add(checkRecoveredOrEscalated(wf));
  run.add(checkAllocationUniqueness(state.snapshot.allocations, state.jobs));
  const all = await waitAllWorkflowsSettled(run, allSettledWant(run));
  return all.state;
}

// --------------------------------------------------------------------------------------- Scene B

interface OutageWindow {
  startSimMs: number;
  endSimMs: number;
}

/**
 * Queue one finite node_crash per simulated node on the same future tick, then prove from a fresh clock read that
 * every reducer call was accepted before that tick. The schedule goes only to the admin reducer's private fault
 * table, so the agent cannot see when the nodes will return.
 */
async function injectOutage(run: CaseRun, nodes: readonly string[], durationMs: number): Promise<OutageWindow> {
  const { clock } = (await run.obs.read()).snapshot;
  const startSimMs = clock.sim_time_ms + OUTAGE_LEAD_STEPS * clock.step_ms;
  for (const node of nodes) await run.env.admin.injectFault(nodeCrash(run.env.args.runId, node, clock, startSimMs, durationMs, run.id.toLowerCase()));
  const fresh = (await run.obs.read()).snapshot.clock;
  const late = dueTickTooLate(fresh, startSimMs, 1);
  run.add(check(`all ${nodes.length} node_crash faults accepted before the start tick`, late === null, late ?? `accepted at sim ${fresh.sim_time_ms}; outage starts at ${startSimMs}`, { nodes: [...nodes], start_sim_ms: startSimMs, duration_sim_ms: durationMs, accepted_at_sim_ms: fresh.sim_time_ms }));
  if (late) throw new Error(`outage was not queued in time, so the nodes would not fail together: ${late}`);
  run.log('outage queued', { nodes: nodes.length, start_sim_ms: startSimMs, duration_sim_ms: durationMs });
  return { startSimMs, endSimMs: startSimMs + durationMs };
}

const sceneBJobsAre = (s: LiveState, status: 'running' | 'failed'): boolean => SCENE_B_JOBS.every((id) => jobState(s, id)?.status === status);

async function sceneB(run: CaseRun, withKill: boolean): Promise<LiveState> {
  const { args } = run.env;
  const durationMs = args.outageS * 1_000;
  run.startAgent({ noLlm: args.noLlm });

  const ready = await run.until('job-a, job-b and job-c running', 60_000, (s) => (sceneBJobsAre(s, 'running') ? true : null));
  const baselines: CheckpointBaseline[] = [];
  for (const id of RESTART_JOBS) {
    const b = checkpointBaseline(jobState(ready.state, id), ready.state.snapshot.checkpoints);
    run.add(check(`precondition: ${id} has a completed, accessible checkpoint`, b !== null, b ? `${b.checkpoint_id}, durable ${b.durable_work_units}` : 'none'));
    if (!b) throw new Error(`${id} has no completed checkpoint, so Scene B cannot show a restart`);
    baselines.push(b);
  }
  const jc = jobState(ready.state, JOB_C);
  run.add(check('precondition: job-c has no completed checkpoint', jc?.latest_checkpoint_id === null && completeCheckpoints(ready.state, JOB_C) === 0, `latest ${jc?.latest_checkpoint_id ?? 'none'}, complete rows ${completeCheckpoints(ready.state, JOB_C)}`));
  const ckptBefore = completeCheckpoints(ready.state, JOB_A);
  run.checkpointCount = { job_id: JOB_A, complete_before: ckptBefore, complete_after: ckptBefore };

  const nodes = simulatedNodeIds(ready.state.snapshot.resources);
  if (nodes.length !== SCENE_B_NODE_COUNT) throw new Error(`expected ${SCENE_B_NODE_COUNT} simulated nodes, observed ${nodes.length}: [${nodes.join(',')}]`);
  const outage = await injectOutage(run, nodes, durationMs);

  const stepWallMs = (OUTAGE_LEAD_STEPS * ready.state.snapshot.clock.step_ms) / args.speed;
  const down = await run.until('every job failed and every simulated node unreachable', stepWallMs + 30_000, (s) => (sceneBJobsAre(s, 'failed') && nodeOutage(s.snapshot, nodes).allDown ? true : null));
  run.add(check('outage failed every job and took every node down', true, `sim ${down.state.snapshot.clock.sim_time_ms}: ${SCENE_B_JOBS.map((id) => `${id}=${jobState(down.state, id)?.status}`).join(' ')}`, { sim_time_ms: down.state.snapshot.clock.sim_time_ms }));

  const waited = await run.until('workflow.state.recovery waiting for job-a and job-b', durationMs / args.speed + 45_000, (s) => {
    const ids = waitingJobIds(s.workflows);
    return RESTART_JOBS.every((id) => ids.includes(id)) ? true : null;
  });
  run.add(checkRecoveryWaiting(waited.state.workflows, RESTART_JOBS, [JOB_C]));
  run.add(check('waiting was observed while the nodes were still down', nodeOutage(waited.state.snapshot, nodes).allDown, `unreachable ${nodeOutage(waited.state.snapshot, nodes).unreachable.length}/${nodes.length} at sim ${waited.state.snapshot.clock.sim_time_ms}`));
  const waitingIds = waited.state.workflows.filter((w) => recoveryOf(w)?.status === 'waiting').map((w) => w.workflow_id);
  run.log('recovery waiting observed', { workflows: waitingIds, jobs: waitingJobIds(waited.state.workflows), waited_ms: waited.waitedMs });

  // SBK: kill on the observed waiting state, then a fresh process must take the same wait over.
  let beforeKillDetails: LiveState['details'] | null = null;
  const heldWaits: RecoverySample[] = [];
  if (withKill) {
    const before = await run.obs.read();
    const held = before.workflows.filter((w) => recoveryOf(w)?.status === 'waiting');
    if (held.length === 0) throw new Error('recovery left the waiting state before the kill could land; use a longer --outage-s');
    for (const w of held) heldWaits.push({ workflow_id: w.workflow_id, lease_owner: w.lease_owner, attempt: w.attempt, wall_unix_ms: before.wallUnixMs, recovery: recoveryOf(w)! });
    beforeKillDetails = before.details;
    const downAtKill = nodeOutage(before.snapshot, nodes).allDown;
    await run.killAgent();
    run.add(check('SIGKILL landed while recovery was waiting and nodes were down', downAtKill, `${held.length} waiting workflow(s); nodes down=${downAtKill}`, { workflows: held.map((w) => w.workflow_id), nodes_down: downAtKill }));
    run.startAgent({ noLlm: args.noLlm });
    for (const wf of held) run.add(checkWorkflowReclaimed(wf, await waitReclaim(run, wf.workflow_id, wf.lease_owner)));
  }

  const back = await run.until('every simulated node observed ready again', durationMs / args.speed + 60_000, (s) => (nodeOutage(s.snapshot, nodes).allUp ? true : null));
  run.log('nodes observed back', { sim_time_ms: back.state.snapshot.clock.sim_time_ms, fault_end_sim_ms: outage.endSimMs, waited_ms: back.waitedMs });

  for (const id of RESTART_JOBS) {
    const restarted = await run.until(`${id} restarted and running`, RESTART_SIM_MS / args.speed + 120_000, (s) => {
      const j = jobState(s, id);
      const moved = finalMigrate(s.details.filter((d) => d.command.requested_sim_time_ms >= outage.endSimMs), id);
      return j && moved?.status === 'succeeded' && j.status === 'running' && j.allocated_gpu_ids.length > 0 ? { progress: j.progress_work_units, key: moved.command_key } : null;
    });
    run.key(`restart_${id}`, restarted.value.key);
    const advanced = await run.until(`${id} work advancing after restart`, 45_000, (s) => {
      const j = jobState(s, id);
      return j && j.progress_work_units > restarted.value.progress ? j.progress_work_units : null;
    });
    run.add(checkWorkAdvanced(id, restarted.value.progress, advanced.value));
  }

  await waitWorkflowSettled(run, waitingIds[0]!);
  const all = await waitAllWorkflowsSettled(run, allSettledWant(run));
  const s = all.state;
  run.checkpointCount.complete_after = completeCheckpoints(s, JOB_A);

  run.add(checkNoRestartDuringOutage(s.details, outage.startSimMs, outage.endSimMs));
  for (const b of baselines) run.add(checkRestartFromCheckpoint(s.details, jobState(s, b.job_id), s.snapshot.checkpoints, b, outage.endSimMs));
  run.add(checkSinglePlacement(s.details, RESTART_JOBS, outage.startSimMs));
  run.add(checkAllocationUniqueness(s.snapshot.allocations, s.jobs));
  run.add(checkNotRestarted(s.details, jobState(s, JOB_C), JOB_C, outage.startSimMs));
  run.add(checkJobInOperatorHandoff(s.workflows, s.details, JOB_C));
  if (beforeKillDetails) {
    run.add(checkKeysReconciled(beforeKillDetails, s.details, { allowReplan: true }));
    for (const held of heldWaits) run.add(checkFirstWaitPreserved(held, run.obs.recoverySamples()));
  }
  run.add(checkProvenanceReported(run.provenance(s.events)));
  return s;
}

const RUNNERS: Record<CaseId, (run: CaseRun) => Promise<LiveState>> = {
  L1: caseL1,
  L2: caseL2,
  L3: caseL3,
  L4: caseL4,
  L5: caseL5,
  L6: caseL6,
  SB: (run) => sceneB(run, false),
  SBK: (run) => sceneB(run, true),
};

// --------------------------------------------------------------------------------------- entry

/** Stands in before the real observer exists: the reset step and the did-not-start artifact only need these. */
const idleObserver = (): Observer => ({ simNow: () => 0, trackWorkflow: () => undefined, teamRounds: () => [], teamMalformed: () => [], recoverySamples: () => [] }) as unknown as Observer;

export async function runCase(id: CaseId, env: CaseEnv): Promise<CaseArtifact> {
  let obs: Observer | null = null;
  let run: CaseRun | null = null;
  let last: LiveState | null = null;
  let error: string | null = null;
  try {
    // Reset BEFORE building the observer: a stale run id would make snapshot reads fail with NOT_FOUND.
    const pre = new CaseRun(id, env, idleObserver());
    await resetIfAllowed(pre);
    obs = createObserver(env.admin, { trackAll: needsDirectAgent(id, env.args.teamMode) });
    run = new CaseRun(id, env, obs);
    run.timeline.push(...pre.timeline);
    const s0 = await obs.read();
    run.simStart = s0.snapshot.clock.sim_time_ms;
    run.log('case start', { sim_time_ms: run.simStart, speed: env.args.speed });
    last = await RUNNERS[id](run);
    if (env.args.teamMode === 'multi') {
      for (const c of checkTeamRounds(obs.teamRounds(), { expectLead: expectsLead(id, env.meta.llm_mode), malformed: obs.teamMalformed() })) run.add(c);
    }
  } catch (e) {
    error = env.redact(e instanceof WaitTimeoutError ? e.message : e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    env.log(`[${id}] ERROR ${error}`);
    if (obs) last = await obs.read().catch(() => last);
  } finally {
    await run?.stopAgent().catch(() => undefined);
    obs?.close();
  }
  if (!run) {
    const stub = new CaseRun(id, env, idleObserver());
    return stub.artifact(false, error ?? 'case did not start', null);
  }
  return run.artifact(error === null && allPassed(run.checks), error, last);
}
