// P3 main loop: triage -> diagnose -> plan -> execute (with replan watcher) -> verify, plus resume-on-boot.
//
// Workflow granularity (documented choice): ONE workflow per triage batch. Every new, unhandled incident
// found in one tick goes into a single workflow `wf-<first incident id>` and is planned together, so the
// planner's cross-job conflict resolution covers all of them. Incidents that arrive while a plan executes
// and touch it are folded in by replan (runReplan links the new incident to the same workflow).
//
// An incident is "handled" when it is listed by an open workflow or its state is no longer `open`
// (investigating -> monitoring | escalated). Recovery never marks an incident `resolved`: a degraded pump
// or a dead GPU still needs an operator (cordon is not repair).
//
// Robustness: runOnce never throws and never runs twice at once; errors are logged and published as an
// agent event. A cheap deterministic pre-check (extract + group symptoms) skips the LLM triage call when
// nothing new could appear, so a steady-state cluster does not burn Nemotron calls. A circuit breaker
// stops calling the LLM for a while after LlmUnavailableError; every module then runs deterministically.

import { createHash } from 'node:crypto';
import type { Incident, ObservedSnapshot, PlanCandidate } from '@dcos/contracts';
import { createCoordinator, DEFAULT_LEASE_MS, type Coordinator, type ExecutionResult } from './coordinator.js';
import type { EventPublisher } from './events.js';
import { LlmUnavailableError } from './llm.js';
import { mergeCandidates, planIncidents, type OptionChooser, type PlanResult } from './planner.js';
import { isDbError, type AgentStage, type DbPort, type Evidence, type LlmPort, type PhysicsPort, type ToolCallSummary, type WorkflowRecord } from './ports.js';
import { createReplanWatcher, planResourceIds, planStaleReason, runReplan, type ReplanOutcome, type ReplanWatcher } from './replan.js';
import {
  LEASE_HELD_BY_LIVE_WORKER,
  outcomesFromLedger,
  resumeOpenWorkflows,
  resumeWorkflow,
  type ResumeContinuation,
  type ResumeHandoff,
  type ResumeReport,
} from './resume.js';
import { teamFeedEvents } from './team/protocol.js';
import { DEFAULT_TRIAGE_WINDOW_MS, diagnoseEvent, extractSymptoms, groupSymptoms, incidentIdentity, runTriage, SYMPTOM_BUCKET_MS, type Candidate } from './triage.js';
import { buildOperatorHandoff, verifyRecovery, type VerificationReport } from './verify.js';

// ---------------------------------------------------------------------------------------------- types

export interface AgentLoopDeps {
  db: DbPort;
  physics: PhysicsPort;
  /** null = no LLM configured: triage + planner run deterministically. */
  llm: LlmPort | null;
  events: EventPublisher;
  workerId: string;
  runId: string;
  clock: { unixMs(): number; simTimeMs(): number };
  /** Wall sleep between action polls (tests/demo tick the fake DB here). Default: real setTimeout. */
  sleep?: (wallMs: number) => Promise<void>;
  /** Workflow lease (default 15 000 wall ms). */
  leaseMs?: number;
  /** Periodic runOnce poll (default 2000 wall ms). */
  pollMs?: number;
  /** db.onChange debounce (default 1000 wall ms). */
  debounceMs?: number;
  /** Action-status poll inside the coordinator / verify (default 500 wall ms). */
  actionPollMs?: number;
  /** Replans per workflow before escalating (default 3). */
  maxReplans?: number;
  /** Escalate instead of executing when the planner flags needs_approval (default false: execute; every command is still safety-checked locally and by the DB). */
  requireApproval?: boolean;
  /** After LlmUnavailableError, skip the LLM for this long (default 60 000 wall ms). */
  llmCooldownMs?: number;
  /** Retries of a workflow whose drive threw before it is escalated (default 3). */
  maxWorkflowRetries?: number;
  /** First retry delay after such a throw; doubles per retry (default 2000 wall ms). */
  retryBackoffMs?: number;
  /** Team mode (DCOS_AGENT_TEAM_MODE=multi): the agent team replaces the single planner choice. Unset = single mode. */
  chooser?: OptionChooser;
  /** Team mode: new-incident watch poll while a workflow executes (default 2000 wall ms). */
  incidentWatchMs?: number;
  /** Team mode: capacity poll while failed jobs wait for GPUs (default 2000 wall ms). */
  recoveryPollMs?: number;
  log?: (msg: string) => void;
}

export type TickStatus = 'idle' | 'handled' | 'busy' | 'error' | 'stopped' | 'lost_ownership';

export interface LoopTickReport {
  status: TickStatus;
  /** Incidents returned by triage this tick (empty when the pre-check skipped triage). */
  incidents: Incident[];
  /** Incidents this tick started handling (triage batch + any folded in by replan). */
  new_incident_ids: string[];
  workflow_id: string | null;
  plans: PlanResult[];
  replans: ReplanOutcome[];
  executions: ExecutionResult[];
  verification: VerificationReport | null;
  escalated: boolean;
  error?: string;
}

export interface AgentLoop {
  start(): Promise<void>;
  stop(): Promise<void>;
  runOnce(): Promise<LoopTickReport>;
  /** Report of the resume pass run by start() (null before start). */
  lastResume(): ResumeReport | null;
}

// ---------------------------------------------------------------------------------------------- constants

/**
 * CONTRACTS §0.11 #17: with no model the agent still EXECUTES its deterministic, safety-checked plans; they are
 * flagged needs_approval for the UI but not held back unless `requireApproval` is true (default false).
 */
export const LLM_UNAVAILABLE_NOTICE = 'LLM unavailable: executing deterministic, safety-checked plans; flagged needs_approval';

export const DEFAULT_POLL_MS = 2_000;
export const DEFAULT_DEBOUNCE_MS = 1_000;
export const DEFAULT_ACTION_POLL_MS = 500;
export const DEFAULT_MAX_REPLANS = 3;
export const DEFAULT_LLM_COOLDOWN_MS = 60_000;
export const DEFAULT_MAX_WORKFLOW_RETRIES = 3;
export const DEFAULT_RETRY_BACKOFF_MS = 2_000;
export const DEFAULT_INCIDENT_WATCH_MS = 2_000;
export const DEFAULT_RECOVERY_POLL_MS = 2_000;
/** Plan attempts in one waiting-recovery episode, the first included. */
export const MAX_RECOVERY_ATTEMPTS = 3;
/** Wall time failed jobs may wait for capacity, from the persisted `first_wait_unix_ms`. */
export const RECOVERY_DEADLINE_MS = 120_000;
/** Symptoms a plan can produce on the resources it acts on (load moved onto a GPU, telemetry gap during a restart). */
const PLAN_SIDE_EFFECT_KINDS: ReadonlySet<string> = new Set(['thermal_throttle', 'near_throttle', 'stale_telemetry']);
/** Retry a lease-held workflow this long after its lease expiry (clock skew margin). */
const LEASE_EXPIRY_MARGIN_MS = 1_000;
const STOP_WAIT_MS = 5_000;
const MAX_EVENT_TOOL_CALLS = 12;
/** Max sim time to wait for an in-flight action before replanning after a restart (coordinator's action timeout). */
const IN_FLIGHT_WAIT_SIM_MS = 15 * 60_000;
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'needs_reconciliation']);

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

const emptyReport = (status: TickStatus): LoopTickReport => ({
  status,
  incidents: [],
  new_incident_ids: [],
  workflow_id: null,
  plans: [],
  replans: [],
  executions: [],
  verification: null,
  escalated: false,
});

const errMsg = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

// ---------------------------------------------------------------------------------------------- LLM guard

/** Planner needs an LlmPort; with none it gets one that always fails (deterministic fallback). */
const NO_LLM: LlmPort = {
  chat: async () => {
    throw new LlmUnavailableError('no LLM configured', []);
  },
};

/**
 * After `failuresToOpen` consecutive LlmUnavailableErrors, fail fast for `cooldownMs` instead of waiting on timeouts
 * again. The default of 1 is the single-agent behaviour; a team with several calls per round must tolerate one slow call.
 */
export function withLlmCircuitBreaker(inner: LlmPort, cooldownMs: number, now: () => number, onOpen?: (e: LlmUnavailableError) => void, failuresToOpen = 1): LlmPort {
  let openUntil = -Infinity;
  let failures = 0;
  return {
    async chat(req) {
      if (now() < openUntil) throw new LlmUnavailableError('LLM circuit open after a recent outage', []);
      try {
        const res = await inner.chat(req);
        failures = 0;
        return res;
      } catch (e) {
        if (e instanceof LlmUnavailableError) {
          failures += 1;
          if (failures >= failuresToOpen) {
            failures = 0;
            openUntil = now() + cooldownMs;
            onOpen?.(e);
          }
        }
        throw e;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------- helpers

/** Same reuse map triage builds (triage.ts keeps it private): symptom ids from rows + open-incident links. */
function knownSymptoms(ev: Evidence, incidents: Incident[]): Map<string, { first_seen_sim_ms: number }> {
  const open = new Set(incidents.filter((i) => i.state !== 'resolved').map((i) => i.incident_id));
  const out = new Map<string, { first_seen_sim_ms: number }>();
  for (const s of ev.symptoms) out.set(s.symptom_id, { first_seen_sim_ms: s.first_seen_sim_ms });
  for (const l of ev.links) {
    if (l.link_kind !== 'symptom' || !open.has(l.incident_id) || out.has(l.linked_id)) continue;
    const m = /-b(\d+)$/.exec(l.linked_id);
    if (m) out.set(l.linked_id, { first_seen_sim_ms: Number(m[1]) * SYMPTOM_BUCKET_MS });
  }
  return out;
}

function handledIds(openWorkflows: WorkflowRecord[], incidents: Incident[]): Set<string> {
  const ids = new Set<string>(openWorkflows.flatMap((w) => w.incident_ids));
  for (const i of incidents) if (i.state !== 'open') ids.add(i.incident_id);
  return ids;
}

const label = (p: PlanResult['job_plans'][number]): string =>
  `${p.job_id} -> ${p.chosen.label}${p.decided_by === 'nemotron' ? ' (Nemotron)' : ' (deterministic)'}${p.needs_approval ? ' [needs approval]' : ''}`;

const tail = (calls: ToolCallSummary[]): ToolCallSummary[] => calls.slice(-MAX_EVENT_TOOL_CALLS);

/** PlanResult rebuilt from a persisted workflow state that carries commands (e.g. stage `replan`). */
function planFromWorkflow(wf: WorkflowRecord): PlanResult | null {
  const st = wf.state;
  if (typeof st.plan_id !== 'string' || !Array.isArray(st.commands) || st.commands.length === 0) return null;
  const commands = (st.commands as PlanResult['commands']).map((c) => structuredClone(c));
  const incidents = wf.incident_ids.length > 0 ? wf.incident_ids : commands[0]!.incident_ids;
  const plan: PlanCandidate = {
    schema_version: '1.1.0',
    plan_id: st.plan_id,
    run_id: wf.run_id,
    workflow_id: wf.workflow_id,
    incident_ids: [...incidents] as [string, ...string[]],
    based_on_decision_epoch: commands[0]!.expected_decision_epoch,
    assumptions: ['resumed from persisted workflow state after agent restart'],
    command_keys: commands.map((c) => c.command_key) as [string, ...string[]],
    expected_completion_delay_sim_s: 0,
    expected_lost_work_units: 0,
    expected_gpu_busy_waste_s: 0,
    failure_risk_estimate: 0,
    explanation: 'resumed from persisted workflow state after agent restart',
  };
  return { plan, commands, job_plans: [], tool_calls: [], used_llm: false };
}

/** Attempt number of a persisted workflow: state.attempt, else the highest `:<n>` command-key suffix, else 1. */
function attemptOf(state: Record<string, unknown>, keys: readonly string[]): number {
  if (typeof state.attempt === 'number' && state.attempt >= 1) return state.attempt;
  const ns = keys.map((k) => Number(/:(\d+)$/.exec(k)?.[1] ?? NaN)).filter((n) => Number.isFinite(n));
  return ns.length > 0 ? Math.max(...ns) : 1;
}

/** `workflow.state.recovery`: failed, checkpoint-backed jobs waiting for capacity. */
interface RecoveryRecord {
  status: 'waiting' | 'resumed' | 'expired';
  job_ids: string[];
  blocked_reason: string;
  first_wait_unix_ms: number;
  attempts: number;
  fingerprint: string;
}

const recoveryOf = (state: Record<string, unknown>): RecoveryRecord | null => (state.recovery as RecoveryRecord | undefined) ?? null;

/** Node and GPU availability plus access to the waiting jobs' completed checkpoints. Progress and telemetry are excluded. */
function capacityFingerprint(snap: ObservedSnapshot, jobIds: readonly string[]): string {
  const wanted = new Set(jobIds);
  const parts = [
    ...snap.nodes.map((n) => `${n.resource_id}=${n.availability}`),
    ...snap.gpus.map((g) => `${g.resource_id}=${g.availability}`),
    ...snap.checkpoints.filter((c) => wanted.has(c.job_id) && c.status === 'complete').map((c) => `${c.checkpoint_id}=${c.accessible}`),
  ];
  return createHash('sha256').update(parts.sort().join('|')).digest('hex').slice(0, 16);
}

/** A plan rebuilt from persisted state has no planner output: restore who is still waiting or needs an operator. */
function withRecoveryState(r: PlanResult, state: Record<string, unknown>): PlanResult {
  const rec = recoveryOf(state);
  const waiting = rec?.status === 'waiting' ? rec.job_ids.map((job_id) => ({ job_id, reason: 'waiting for capacity' })) : [];
  const operator = Array.isArray(state.operator_jobs) ? (state.operator_jobs as NonNullable<PlanResult['operator_jobs']>) : [];
  return waiting.length > 0 || operator.length > 0 ? { ...r, waiting_jobs: waiting, operator_jobs: operator } : r;
}

const nothingToRunButWaiting = (r: PlanResult): boolean => r.commands.length === 0 && (r.waiting_jobs?.length ?? 0) > 0;

/** Diagnose-event tool calls minus the ones the triage event of the same tick already showed. */
function withoutRepeats(calls: ToolCallSummary[] | undefined, shown: ToolCallSummary[]): ToolCallSummary[] | undefined {
  if (!calls) return calls;
  const seen = new Set(shown.map((t) => `${t.tool}|${t.args_summary}|${t.result_summary}`));
  return calls.filter((t) => !seen.has(`${t.tool}|${t.args_summary}|${t.result_summary}`));
}

// ---------------------------------------------------------------------------------------------- loop

export function createAgentLoop(deps: AgentLoopDeps): AgentLoop {
  const { db, physics, events, workerId, runId, clock } = deps;
  const sleep = deps.sleep ?? realSleep;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const actionPollMs = deps.actionPollMs ?? DEFAULT_ACTION_POLL_MS;
  const maxReplans = deps.maxReplans ?? DEFAULT_MAX_REPLANS;
  const log = deps.log ?? ((m: string) => console.log(`agent: ${m}`));
  const llm = deps.llm
    ? withLlmCircuitBreaker(deps.llm, deps.llmCooldownMs ?? DEFAULT_LLM_COOLDOWN_MS, () => clock.unixMs(), (e) => log(`${LLM_UNAVAILABLE_NOTICE} (${e.message})`))
    : null;
  const now = () => clock.unixMs();
  const maxWorkflowRetries = deps.maxWorkflowRetries ?? DEFAULT_MAX_WORKFLOW_RETRIES;
  const retryBackoffMs = deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  /** Snapshot the latest team round was built on: the baseline of the post-round freshness check. */
  let roundBaseline: ObservedSnapshot | null = null;
  const chooser: OptionChooser | undefined =
    deps.chooser &&
    ((input) => {
      roundBaseline = input.ix.snap;
      return deps.chooser!(input);
    });

  let inflight: Promise<LoopTickReport> | null = null;
  let started = false;
  let stopping = false;
  let dirty = false;
  let resumeReport: ResumeReport | null = null;
  /**
   * Workflows to pick up again on a later tick, keyed by id:
   *  - `continue`: claimed by resume but not executable there, or its drive threw (retry with backoff)
   *  - `resume`:   skipped because a live worker held its lease; retried through resume after that lease expires
   *  - `escalate`: retry cap reached but the escalation write itself failed
   */
  const takeovers = new Map<string, { mode: 'continue' | 'resume' | 'escalate'; dueUnixMs: number; reason?: string }>();
  /** Drive failures per workflow (reset when a drive completes). */
  const failures = new Map<string, number>();
  let lastSkippedFingerprint: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const safeEmit = async (stage: AgentStage, input: Parameters<EventPublisher['emit']>[1]): Promise<void> => {
    try {
      await events.emit(stage, input);
    } catch (e) {
      log(`event publish failed: ${errMsg(e)}`);
    }
  };

  /**
   * Move incidents to `state` (never back to open, never to resolved). Merges no new links. `investigating` only
   * ever starts from `open`: an already-handled incident (monitoring / escalated) is never flipped back.
   */
  async function setIncidentState(ids: readonly string[], state: Incident['state']): Promise<void> {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    const sim = clock.simTimeMs();
    for (const inc of await db.listIncidents()) {
      if (!wanted.has(inc.incident_id) || inc.state === state || inc.state === 'resolved') continue;
      if (state === 'investigating' && inc.state !== 'open') continue;
      const next: Incident = { ...inc, state, version: inc.version + 1, updated_sim_time_ms: Math.max(sim, inc.updated_sim_time_ms) };
      await db.upsertIncident(next, []);
    }
  }

  /**
   * Sleep until `simMs` of sim time passed. With `coord`, a heartbeat is sent after every sleep when one is due on the
   * injected clock: verify's progress window can span several lease lengths in an accelerated-time harness, where the
   * coordinator's real-time ticker never fires (same rule as the coordinator's own action polls).
   */
  const waitSim = async (simMs: number, coord?: Coordinator): Promise<void> => {
    const start = (await db.getObservedSnapshot()).clock.sim_time_ms;
    const maxPolls = Math.ceil((simMs * 4) / Math.max(1, actionPollMs)) + 20;
    for (let i = 0; i < maxPolls; i++) {
      await sleep(actionPollMs);
      await coord?.heartbeatIfDue();
      if ((await db.getObservedSnapshot()).clock.sim_time_ms >= start + simMs) return;
    }
  };

  // ------------------------------------------------------------------ stage helpers

  /**
   * `afterReplan`: the replan event just published (maybe) Nemotron's narrative and a few planner tool calls, so
   * the plan event lists the chosen options instead of repeating the same sentence, and drops the repeated calls.
   */
  async function publishPlan(wfId: string, r: PlanResult, afterReplan?: ReplanOutcome): Promise<void> {
    const jobs = r.job_plans.map(label).join('; ') || 'no affected running job: keep running';
    const shown = new Set(afterReplan?.event_tool_calls ?? []);
    const repeated = afterReplan !== undefined && r.summary !== undefined && afterReplan.event_summary === r.summary;
    await safeEmit('plan', {
      workflowId: wfId,
      incidentId: r.plan.incident_ids[0],
      summary: repeated ? `new plan ${r.plan.plan_id}: ${jobs}` : (r.summary ?? `deterministic: ${r.plan.plan_id}: ${jobs}`),
      ...(r.actor ? { actor: r.actor } : {}),
      toolCalls: r.tool_calls.filter((t) => !shown.has(t)),
    });
    const excluded = r.job_plans.flatMap((p) => [p.chosen, ...p.alternatives]).filter((o) => o.excluded_reason);
    if (excluded.length === 0) return;
    await safeEmit('safety', {
      workflowId: wfId,
      incidentId: r.plan.incident_ids[0],
      summary: `BLOCKED by deterministic safety: ${excluded.slice(0, 3).map((o) => `${o.option_id} (${o.excluded_reason})`).join('; ')}`,
      actor: 'code',
      toolCalls: excluded.slice(0, MAX_EVENT_TOOL_CALLS).map((o) => ({
        actor: 'code' as const,
        tool: 'evaluate_safety',
        args_summary: o.option_id,
        result_summary: `denied: ${o.excluded_reason}`,
      })),
    });
  }

  async function plan(wfId: string, incidents: Incident[], attempt: number, coord: Coordinator): Promise<PlanResult> {
    const r = await planIncidents({ db, physics, llm: llm ?? NO_LLM, workflowId: wfId, runId, attempt, ...(chooser ? { chooser } : {}) }, { incidents });
    // R3b: candidates ride along in the persisted state; updateStage merges, so they survive execute/verify/done.
    const saved = await coord.updateStage('plan', {
      plan_id: r.plan.plan_id,
      attempt,
      incident_ids: [...r.plan.incident_ids],
      candidates: mergeCandidates(coord.state().candidates, r.candidates ?? []),
      ...(r.team ? { team: r.team } : {}),
      ...(r.operator_jobs ? { operator_jobs: r.operator_jobs } : {}),
    });
    if (saved) await publishTeam(wfId, r);
    await publishPlan(wfId, r);
    return r;
  }

  /** Create or refresh `state.recovery`. An open episode keeps its first wait, attempts and (same jobs) baseline. */
  async function recordWaiting(coord: Coordinator, r: PlanResult, snap: ObservedSnapshot): Promise<RecoveryRecord | null> {
    const prior = recoveryOf(coord.state());
    const open = prior?.status === 'waiting' ? prior : null;
    const jobIds = (r.waiting_jobs ?? []).map((j) => j.job_id).sort();
    const sameJobs = open !== null && open.job_ids.join() === jobIds.join();
    const rec: RecoveryRecord = {
      status: 'waiting',
      job_ids: jobIds,
      blocked_reason: (r.waiting_jobs ?? []).map((j) => `${j.job_id}: ${j.reason}`).join('; '),
      first_wait_unix_ms: open?.first_wait_unix_ms ?? now(),
      attempts: open?.attempts ?? 1,
      fingerprint: sameJobs ? open.fingerprint : capacityFingerprint(snap, jobIds),
    };
    return (await coord.updateStage('plan', { recovery: rec })) ? rec : null;
  }

  /**
   * §0.6: hold the workflow at stage `plan` until capacity may have changed. True = plan again as a new attempt; false =
   * the drive is over (expired and escalated, stopping, or ownership lost). An unchanged state costs one snapshot read
   * per poll: no model calls, no action requests. A persisted baseline means a change while the agent was down counts.
   */
  async function awaitCapacity(wfId: string, coord: Coordinator, r: PlanResult, report: LoopTickReport): Promise<boolean> {
    let rec = await recordWaiting(coord, r, await db.getObservedSnapshot());
    if (!rec) {
      report.status = 'lost_ownership';
      return false;
    }
    const baseReason = rec.blocked_reason;
    const expire = async (why: string): Promise<false> => {
      await coord.updateStage('plan', { recovery: { ...rec!, status: 'expired' } });
      const operator = (r.operator_jobs ?? []).map((j) => `; ${j.job_id} needs an operator (${j.reason})`).join('');
      await escalate(wfId, coord, workflowIncidents(coord, r), 'plan', `${why}: ${baseReason}${operator}`, report);
      return false;
    };
    if (rec.attempts >= MAX_RECOVERY_ATTEMPTS) return expire(`recovery attempt limit (${MAX_RECOVERY_ATTEMPTS}) reached`);
    await safeEmit('plan', { workflowId: wfId, incidentId: r.plan.incident_ids[0], actor: 'code', summary: `waiting for capacity (attempt ${rec.attempts}/${MAX_RECOVERY_ATTEMPTS}): ${baseReason}` });

    let paused = false;
    for (;;) {
      if (stopping) {
        report.status = 'stopped'; // stage `plan` comes back through took_over -> continueTakeover on the next boot
        return false;
      }
      if (!coord.isOwner()) {
        report.status = 'lost_ownership';
        return false;
      }
      if (now() - rec.first_wait_unix_ms >= RECOVERY_DEADLINE_MS) return expire(`waited ${RECOVERY_DEADLINE_MS / 1000} s for capacity`);
      const snap = await db.getObservedSnapshot();
      if (snap.clock.paused !== paused) {
        paused = snap.clock.paused;
        rec = { ...rec, blocked_reason: paused ? `simulator paused; ${baseReason}` : baseReason };
        await coord.updateStage('plan', { recovery: rec });
        await safeEmit('plan', { workflowId: wfId, incidentId: r.plan.incident_ids[0], actor: 'code', summary: paused ? `simulator paused, not recovered: ${baseReason}` : `simulator running again: ${baseReason}` });
      }
      const fingerprint = capacityFingerprint(snap, rec.job_ids);
      if (!paused && fingerprint !== rec.fingerprint) {
        await coord.updateStage('plan', { recovery: { ...rec, attempts: rec.attempts + 1, fingerprint } });
        if (coord.isOwner()) return true;
        continue; // the check at the top of the loop reports the lost lease
      }
      await sleep(deps.recoveryPollMs ?? DEFAULT_RECOVERY_POLL_MS);
      await coord.heartbeatIfDue();
    }
  }

  /** No commands left to run: jobs without a usable checkpoint go to an operator, otherwise the normal no-action close. */
  function closeNoWork(wfId: string, coord: Coordinator, r: PlanResult, report: LoopTickReport): Promise<void> {
    const ids = workflowIncidents(coord, r);
    if (!r.operator_jobs?.length) return closeNoAction(wfId, coord, ids, report);
    return escalate(wfId, coord, ids, 'plan', r.operator_jobs.map((j) => `${j.job_id} needs an operator (${j.reason})`).join('; '), report);
  }

  /** Verified what could run, but jobs remain unrecovered: never a full recovery, and the handoff names them. */
  async function closeUnfinished(coord: Coordinator, r: PlanResult, v: VerificationReport): Promise<VerificationReport> {
    const left = [...(r.operator_jobs ?? []), ...(r.waiting_jobs ?? [])];
    const note = `Partial recovery: ${left.map((j) => `${j.job_id} needs an operator (${j.reason})`).join('; ')}.`;
    const snap = await db.getObservedSnapshot();
    const listed = new Set(v.persisted.affected_jobs.map((j) => j.job_id));
    const added = left
      .filter((j) => !listed.has(j.job_id))
      .map((j) => {
        const s = snap.job_states.find((x) => x.job_id === j.job_id);
        return { job_id: j.job_id, status: s?.status ?? 'unknown', progress_work_units: s?.progress_work_units ?? 0, durable_work_units: s?.durable_work_units ?? 0, racks: [] as string[] };
      });
    const outcome = 'operator_review' as const;
    const persisted = {
      ...v.persisted,
      verified: false,
      escalate: true,
      outcome,
      handoff: `${note} ${v.persisted.handoff}`,
      next_human_action: `${note} ${v.persisted.next_human_action}`,
      affected_jobs: [...v.persisted.affected_jobs, ...added],
    };
    const rec = recoveryOf(coord.state());
    await coord.updateStage('escalated', { escalation_reason: note, verification: persisted, ...(rec?.status === 'waiting' ? { recovery: { ...rec, status: 'expired' } } : {}) });
    return { ...v, verified: false, escalate: true, outcome, stage: 'escalated', handoff: persisted.handoff, persisted };
  }

  /** The team conversation, in order. Call only after `state.team` is written: the feed never shows an unsaved round. */
  async function publishTeam(wfId: string, r: PlanResult): Promise<void> {
    if (!r.team) return;
    for (const ev of teamFeedEvents(r.team, r.plan.incident_ids[0])) {
      await safeEmit(ev.stage, { workflowId: wfId, incidentId: ev.incidentId, summary: ev.summary, actor: ev.actor, toolCalls: ev.toolCalls });
    }
  }

  /** §0.2: the replan watcher only starts after planning, so check what changed while the team was deliberating. */
  async function staleAfterRound(wfId: string, r: PlanResult): Promise<DriveStart['pendingReplan'] | null> {
    if (!r.team || !roundBaseline) return null;
    const fresh = await db.getObservedSnapshot().catch(() => null);
    const why = fresh && planStaleReason(r, roundBaseline, fresh);
    if (!why) return null;
    return { execution: { workflow_id: wfId, plan_id: r.plan.plan_id, outcomes: [], aborted: true }, reason: `changed during the team round: ${why}` };
  }

  /**
   * Team mode §0.4: while a workflow executes, re-run the pre-check so a new fault elsewhere is folded in by the normal
   * replan instead of waiting for the next tick. Each candidate fires once, keyed on its time-independent identity (a
   * snapshot-derived candidate's `-b<bucket>` suffix rolls over). Candidates already handled, or that only show side
   * effects on the resources this workflow's plans act on, never fire, so the watch cannot burn the replan limit.
   */
  function startIncidentWatch(first: PlanResult) {
    const own = planResourceIds(first);
    const fired = new Set<string>();
    const causedByPlan = (c: Candidate): boolean => c.symptoms.every((s) => PLAN_SIDE_EFFECT_KINDS.has(s.kind) && own.has(s.resource_id));
    let why: string | null = null;
    let active = true;
    let generation = 0;
    let reading: Promise<void> | null = null;

    const read = async (gen: number): Promise<void> => {
      const gate = await precheck();
      if (gen !== generation || !gate.needed) return;
      const known = new Set([...gate.handled].map(incidentIdentity));
      const news = gate.candidates.filter((c) => !known.has(incidentIdentity(c.candidate_id)) && !fired.has(incidentIdentity(c.candidate_id)) && !causedByPlan(c));
      if (news.length === 0) return;
      for (const c of news) fired.add(incidentIdentity(c.candidate_id));
      why = `new incident during execution: ${news.map((c) => c.candidate_id).join(', ')}`;
    };
    /** At most one read in flight; nothing to read while paused or once raised. */
    const poll = (): Promise<void> => {
      if (!active || why !== null) return Promise.resolve();
      reading ??= read(generation)
        .catch((e: unknown) => log(`incident watch read failed: ${errMsg(e)}`))
        .finally(() => {
          reading = null;
        });
      return reading;
    };
    const timer = setInterval(() => void poll(), deps.incidentWatchMs ?? DEFAULT_INCIDENT_WATCH_MS);
    (timer as { unref?: () => void }).unref?.();

    return {
      raised: (): boolean => why !== null,
      reason: (): string | null => why,
      /** One read that starts after everything so far: a fault during the last command is seen before verify. */
      async settled(): Promise<boolean> {
        await reading;
        await poll();
        return why !== null;
      },
      /** A replan is taking over: its triage folds in what was raised; reads already in flight are discarded. */
      pause(): void {
        active = false;
        generation += 1;
        why = null;
      },
      resume(next: PlanResult): void {
        for (const id of planResourceIds(next)) own.add(id);
        active = true;
      },
      stop(): void {
        active = false;
        generation += 1;
        clearInterval(timer);
      },
    };
  }

  /**
   * Durable handoff for a workflow closed WITHOUT a verified execution (no-action plan, or an escalation before/instead
   * of executing). Same persisted shape as verify's, so a fresh connection reads every close the same way (R3).
   */
  async function closingHandoff(ids: string[], outcome: 'monitoring' | 'operator_review', reason: string, jobIds: string[], headline?: string) {
    const [snapshot, incidents] = await Promise.all([db.getObservedSnapshot(), db.listIncidents().catch(() => [] as Incident[])]);
    const sim = snapshot.clock.sim_time_ms;
    return buildOperatorHandoff({
      snapshot,
      incidents,
      incidentIds: ids,
      checks: [],
      outcomes: [],
      aborted: false,
      jobIds,
      interval: [sim, sim],
      outcome,
      reason,
      ...(headline ? { headline } : {}),
    });
  }

  async function escalate(wfId: string, coord: Coordinator, ids: string[], stage: AgentStage, reason: string, report: LoopTickReport): Promise<void> {
    const verification = await closingHandoff(ids, 'operator_review', `escalated to operator: ${reason}`, jobsOf(report)).catch(() => null);
    await coord.updateStage('escalated', { escalation_reason: reason, ...(verification ? { verification } : {}) });
    await safeEmit(stage, { workflowId: wfId, incidentId: ids[0], actor: 'code', summary: `escalated to operator: ${reason}` });
    await setIncidentState(ids, 'escalated');
    report.escalated = true;
  }

  /**
   * No-action close: nothing was executed and no second sample was read back, so this is NOT a verified recovery
   * (SCOPE §4: no observed window means unverified). The incident stays open under monitoring, not escalated.
   */
  async function closeNoAction(wfId: string, coord: Coordinator, ids: string[], report: LoopTickReport): Promise<void> {
    const headline = 'No recovery action executed: affected jobs are expected to keep running, not verified; incident stays under monitoring.';
    const verification = await closingHandoff(ids, 'monitoring', 'no command executed, no observed window', jobsOf(report), headline);
    await coord.updateStage('done', { verification });
    await safeEmit('verify', { workflowId: wfId, incidentId: ids[0], actor: 'code', summary: verification.handoff });
    await setIncidentState(ids, 'monitoring');
  }

  /** Jobs the tick's plans looked at (for the handoff's affected-jobs list). */
  const jobsOf = (report: LoopTickReport): string[] => [...new Set(report.plans.flatMap((p) => p.job_plans.map((j) => j.job_id)))];

  const workflowIncidents = (coord: Coordinator, r: PlanResult): string[] => [
    ...new Set([...(coord.lease()?.workflow.incident_ids ?? []), ...r.plan.incident_ids]),
  ];

  // ------------------------------------------------------------------ one workflow, plan -> verify

  interface DriveStart {
    attempt: number;
    plan?: PlanResult;
    /** Coordinator that already holds the workflow lease (resume hand-off); otherwise one is created. */
    coord?: Coordinator;
    /** Replan before executing anything: the persisted plan was found invalid after a restart. */
    pendingReplan?: { execution: ExecutionResult; reason: string };
    /** This plan's executable part is finished: go on waiting for its `waiting_jobs`. */
    waitingFrom?: PlanResult;
  }

  async function driveWorkflow(wfId: string, incidents: Incident[], start: DriveStart, report: LoopTickReport, stageRef: { stage: AgentStage }): Promise<void> {
    let next: DriveStart | void = start;
    while (next) next = await driveOnce(wfId, incidents, next, report, stageRef);
  }

  /** One pass, plan -> verify. Returns the next pass when jobs are still waiting for capacity. */
  async function driveOnce(wfId: string, incidents: Incident[], start: DriveStart, report: LoopTickReport, stageRef: { stage: AgentStage }): Promise<DriveStart | void> {
    const ids = incidents.map((i) => i.incident_id);
    const coord =
      start.coord ??
      createCoordinator({ db, physics, events, workerId, clock, sleep, leaseMs, pollMs: actionPollMs, onLostOwnership: (why) => log(`lost ownership of ${wfId}: ${why}`) });
    if (!start.coord) await coord.ensureWorkflow(wfId, ids);
    coord.startHeartbeat();
    report.workflow_id = wfId;
    let watcher: ReplanWatcher | null = null;
    let incidentWatch: ReturnType<typeof startIncidentWatch> | null = null;
    try {
      await setIncidentState(ids, 'investigating');
      let attempt = start.attempt;
      stageRef.stage = 'plan';
      let current = start.waitingFrom ?? start.plan ?? (await plan(wfId, incidents, attempt, coord));
      if (!start.waitingFrom) report.plans.push(current);
      for (let wait = start.waitingFrom !== undefined || nothingToRunButWaiting(current); wait; wait = nothingToRunButWaiting(current)) {
        if (!(await awaitCapacity(wfId, coord, current, report))) return;
        attempt += 1;
        current = await plan(wfId, incidents, attempt, coord);
        report.plans.push(current);
      }
      if (current.commands.length === 0) return closeNoWork(wfId, coord, current, report);
      if (current.waiting_jobs?.length && !(await recordWaiting(coord, current, await db.getObservedSnapshot()))) {
        report.status = 'lost_ownership';
        return;
      }
      if (deps.requireApproval && current.job_plans.some((p) => p.needs_approval)) {
        return escalate(wfId, coord, workflowIncidents(coord, current), 'plan', 'planner flagged needs_approval', report);
      }
      watcher = createReplanWatcher({ db }, current);
      const w = watcher;
      incidentWatch = chooser ? startIncidentWatch(current) : null;
      const newFault = incidentWatch;
      let exec: ExecutionResult;
      let pending = start.pendingReplan ?? (await staleAfterRound(wfId, current));
      for (;;) {
        let reason: string;
        if (pending) {
          exec = pending.execution;
          reason = pending.reason;
          pending = null;
        } else {
          stageRef.stage = 'execute';
          exec = await coord.execute(wfId, current, { shouldAbort: () => stopping || w.shouldAbort() || newFault?.raised() === true });
          report.executions.push(exec);
          if (!exec.aborted && (stopping || !(await newFault?.settled()))) break;
          if (!coord.isOwner()) {
            report.status = 'lost_ownership';
            return;
          }
          if (!w.shouldAbort() && !newFault?.raised()) {
            report.status = 'stopped'; // graceful stop: the persisted execute state is resumed on next boot
            return;
          }
          reason = w.reason() ?? newFault?.reason() ?? 'material change to the active plan';
        }
        // Attempts spent waiting for capacity have their own limit and do not use up replans.
        if (attempt - 1 - Math.max(0, (recoveryOf(coord.state())?.attempts ?? 1) - 1) >= maxReplans) {
          return escalate(wfId, coord, workflowIncidents(coord, current), 'replan', `replan limit (${maxReplans}) reached: ${reason}`, report);
        }
        attempt += 1;
        stageRef.stage = 'replan';
        newFault?.pause();
        const out = await runReplan(
          {
            db,
            physics,
            llm,
            events,
            workflowId: wfId,
            runId,
            workerId,
            fencingToken: coord.lease()!.fencing_token,
            now,
            // Persist through the lease owner: version + fencing token stay coherent, no re-claim needed.
            persist: (stage, patch) => coord.updateStage(stage, patch),
            ...(chooser ? { chooser } : {}),
          },
          { previous: current, execution: exec, attempt, reason },
        );
        report.replans.push(out);
        if (!coord.isOwner()) {
          report.status = 'lost_ownership';
          return;
        }
        report.new_incident_ids = [...new Set([...report.new_incident_ids, ...out.new_incident_ids])];
        await setIncidentState(out.new_plan.plan.incident_ids, 'investigating');
        current = out.new_plan;
        report.plans.push(current);
        // R3b: the new plan's candidates replace this workflow's older entries for the same jobs.
        const saved = await coord.updateStage('replan', {
          candidates: mergeCandidates(coord.state().candidates, current.candidates ?? []),
          ...(current.team ? { team: current.team } : {}),
          ...(current.operator_jobs ? { operator_jobs: current.operator_jobs } : {}),
        });
        if (saved) await publishTeam(wfId, current);
        await publishPlan(wfId, current, out);
        if (nothingToRunButWaiting(current)) return { attempt, coord, waitingFrom: current };
        if (current.commands.length === 0) return closeNoWork(wfId, coord, current, report);
        if (current.waiting_jobs?.length) await recordWaiting(coord, current, await db.getObservedSnapshot());
        w.reset(current);
        newFault?.resume(current);
        pending = await staleAfterRound(wfId, current); // goes through the replan-limit check above like any other replan
      }
      stageRef.stage = 'verify';
      const stillWaiting = (current.waiting_jobs?.length ?? 0) > 0;
      const unfinished = stillWaiting || (current.operator_jobs?.length ?? 0) > 0;
      const waited = recoveryOf(coord.state());
      const allRan = exec.outcomes.every((o) => o.status === 'succeeded');
      // While jobs remain, never persist stage `verify` or a closing stage: resume would close the workflow from there.
      await coord.updateStage(unfinished ? 'execute' : 'verify', waited?.status === 'waiting' && !stillWaiting ? { recovery: { ...waited, status: allRan ? 'resumed' : 'expired' } } : {});
      const verified = await verifyRecovery(
        { db, events, physics, waitSim: (simMs) => waitSim(simMs, coord), persist: (stage, patch) => coord.updateStage(unfinished ? 'plan' : stage, patch) },
        { workflowId: wfId, plan: current, result: exec },
      );
      if (stillWaiting && !verified.escalate) {
        report.verification = verified;
        return { attempt, coord, waitingFrom: current };
      }
      const v = unfinished ? await closeUnfinished(coord, current, verified) : verified;
      report.verification = v;
      report.escalated = report.escalated || v.escalate;
      await safeEmit('verify', { workflowId: wfId, incidentId: current.plan.incident_ids[0], actor: 'code', summary: `handoff: ${v.handoff}` });
      await setIncidentState(workflowIncidents(coord, current), v.escalate ? 'escalated' : 'monitoring');
    } finally {
      incidentWatch?.stop();
      watcher?.dispose();
      coord.stopHeartbeat();
    }
  }

  // ------------------------------------------------------------------ takeovers from resume

  /**
   * Continue a workflow on the normal path: one resume claimed but could not execute (stage triage/plan/replan),
   * or one whose earlier drive threw. A persisted plan (stage replan/execute/verify) is reused as-is, so its keys
   * and payloads are the same: succeeded keys are skipped, running ones waited on, nothing is resubmitted.
   */
  async function continueTakeover(wfId: string, report: LoopTickReport, stageRef: { stage: AgentStage }): Promise<void> {
    const wf = await db.getWorkflow(wfId);
    if (!wf || wf.stage === 'done' || wf.stage === 'escalated') return;
    report.workflow_id = wfId;
    const ids = new Set(wf.incident_ids);
    const incidents = (await db.listIncidents()).filter((i) => ids.has(i.incident_id) && i.state !== 'resolved');
    const rebuilt = wf.stage === 'replan' || wf.stage === 'execute' || wf.stage === 'verify' ? planFromWorkflow(wf) : null;
    const persisted = rebuilt && withRecoveryState(rebuilt, wf.state);
    const attempt = persisted
      ? attemptOf(wf.state, persisted.commands.map((c) => c.command_key))
      : typeof wf.state.attempt === 'number'
        ? wf.state.attempt
        : 1;
    if (incidents.length === 0 && !persisted) {
      const coord = createCoordinator({ db, physics, events, workerId, clock, sleep, leaseMs, pollMs: actionPollMs });
      await coord.ensureWorkflow(wfId, []);
      await coord.updateStage('done', { note: 'no open incidents left after restart' });
      return;
    }
    const why = takeovers.get(wfId)?.reason ?? (failures.has(wfId) ? 'after an agent error' : 'after agent restart');
    await safeEmit('execute', { workflowId: wfId, incidentId: wf.incident_ids[0], actor: 'code', summary: `continuing ${wfId} from stage ${wf.stage} ${why}` });
    await driveWorkflow(wfId, incidents, persisted ? { attempt, plan: persisted } : { attempt }, report, stageRef);
  }

  /** Retry a workflow that resume left alone because a live worker held its lease (that lease has now expired). */
  async function resumeTakeover(wfId: string, report: LoopTickReport): Promise<void> {
    const wf = await db.getWorkflow(wfId);
    if (!wf || wf.stage === 'done' || wf.stage === 'escalated') return;
    const item = await resumeWorkflow({ db, physics, events, workerId, clock, sleep, leaseMs, continueExecute: continueResumed }, wf);
    log(`resume retry: ${wfId} ${item.action}${item.note ? ` (${item.note})` : ''}`);
    if (item.note === LEASE_HELD_BY_LIVE_WORKER) {
      await requeueAfterLease(wfId);
      return;
    }
    report.workflow_id = wfId;
    if (report.status === 'idle') report.status = 'handled';
    await settleResumed({ worker_id: workerId, items: [item], duplicates_detected: 0 });
  }

  /** Try `wfId` again (through resume) shortly after its current lease expires. */
  async function requeueAfterLease(wfId: string): Promise<void> {
    const wf = await db.getWorkflow(wfId);
    if (!wf || wf.stage === 'done' || wf.stage === 'escalated') return;
    takeovers.set(wfId, { mode: 'resume', dueUnixMs: Math.max(now(), wf.lease_expires_unix_ms) + LEASE_EXPIRY_MARGIN_MS });
  }

  /**
   * A drive of `wfId` threw: never leave it stranded (open workflow, incidents `investigating`, never picked up
   * again). Retry it with exponential backoff; after `maxWorkflowRetries` retries escalate it to an operator.
   */
  async function onWorkflowError(wfId: string, stage: AgentStage, e: unknown): Promise<void> {
    const msg = errMsg(e);
    if (isDbError(e, 'LEASE_HELD')) {
      // Another (live) worker owns it: not our failure. Look again once its lease could have expired.
      await requeueAfterLease(wfId).catch((err: unknown) => log(`requeue of ${wfId} failed: ${errMsg(err)}`));
      return;
    }
    const n = (failures.get(wfId) ?? 0) + 1;
    failures.set(wfId, n);
    if (n > maxWorkflowRetries) {
      await escalateStuck(wfId, `agent error during ${stage} persisted after ${maxWorkflowRetries} retries: ${msg}`);
      return;
    }
    const delay = retryBackoffMs * 2 ** (n - 1);
    takeovers.set(wfId, { mode: 'continue', dueUnixMs: now() + delay, reason: `(retry ${n}/${maxWorkflowRetries} after an agent error)` });
    await safeEmit(stage, {
      workflowId: wfId,
      actor: 'code',
      summary: `agent error during ${stage}: ${msg}; retry ${n}/${maxWorkflowRetries} in ${Math.round(delay / 1000)} s`,
    });
  }

  /** Close a workflow that keeps failing as `escalated` (stage + incidents + feed event). Re-queued if that fails. */
  async function escalateStuck(wfId: string, reason: string): Promise<void> {
    try {
      const coord = createCoordinator({ db, physics, events, workerId, clock, sleep, leaseMs, pollMs: actionPollMs });
      await coord.ensureWorkflow(wfId, []);
      await coord.updateStage('escalated', { escalation_reason: reason });
      const wf = coord.lease()?.workflow ?? (await db.getWorkflow(wfId));
      const ids = wf?.incident_ids ?? [];
      await safeEmit('execute', { workflowId: wfId, incidentId: ids[0], actor: 'code', summary: `escalated to operator: ${reason}` });
      await setIncidentState(ids, 'escalated');
      takeovers.delete(wfId);
      failures.delete(wfId);
      log(`escalated ${wfId}: ${reason}`);
    } catch (err) {
      log(`escalation of ${wfId} failed: ${errMsg(err)}; retrying next tick`);
      if (isDbError(err, 'LEASE_HELD')) await requeueAfterLease(wfId).catch(() => undefined);
      else takeovers.set(wfId, { mode: 'escalate', dueUnixMs: now(), reason });
    }
  }

  /** Run every due takeover, each isolated: one failing workflow never drops the others. */
  async function runTakeovers(report: LoopTickReport, stageRef: { stage: AgentStage }): Promise<void> {
    const t = now();
    const due = [...takeovers].filter(([, p]) => p.dueUnixMs <= t);
    for (const [wfId, p] of due) {
      if (stopping) return;
      try {
        if (p.mode === 'escalate') {
          await escalateStuck(wfId, p.reason ?? 'agent error');
          continue;
        }
        if (p.mode === 'resume') {
          takeovers.delete(wfId);
          await resumeTakeover(wfId, report);
          continue;
        }
        stageRef.stage = 'plan';
        await continueTakeover(wfId, report, stageRef);
        takeovers.delete(wfId);
        failures.delete(wfId);
      } catch (e) {
        takeovers.delete(wfId);
        log(`takeover of ${wfId} failed during ${stageRef.stage}: ${errMsg(e)}`);
        await onWorkflowError(wfId, stageRef.stage, e);
      }
    }
  }

  /** Wait (DB-supervised) until the given in-flight keys are terminal, keeping the workflow lease alive. */
  async function waitInFlight(coord: Coordinator, keys: string[]): Promise<void> {
    const maxPolls = Math.ceil((IN_FLIGHT_WAIT_SIM_MS * 4) / Math.max(1, actionPollMs)) + 20;
    for (const key of keys) {
      for (let i = 0; i < maxPolls; i++) {
        const s = await db.getActionStatus(key);
        if (!s || TERMINAL_STATUSES.has(s.status)) break;
        await sleep(actionPollMs);
        if (!(await coord.heartbeatOnce())) return;
      }
    }
  }

  /**
   * Resume hand-off for an `execute`-stage workflow: continue it on the normal path (replan watcher, replan
   * instead of escalate). An invalid persisted plan (e.g. its destination died while we were down) is replanned
   * with attempt+1 once in-flight actions have finished; nothing that succeeded is ever resubmitted.
   */
  async function continueResumed(h: ResumeHandoff): Promise<ResumeContinuation> {
    const wfId = h.workflow.workflow_id;
    const report = emptyReport('handled');
    const stageRef: { stage: AgentStage } = { stage: 'execute' };
    const ids = new Set(h.workflow.incident_ids);
    const incidents = (await db.listIncidents()).filter((i) => ids.has(i.incident_id) && i.state !== 'resolved');
    const attempt = attemptOf(h.coordinator.state(), h.plan.commands.map((c) => c.command_key));
    const current = withRecoveryState({ plan: h.plan.plan, commands: h.plan.commands, job_plans: [], tool_calls: [], used_llm: false }, h.coordinator.state());
    let pendingReplan: DriveStart['pendingReplan'];
    if (h.invalidReason) {
      log(`resume: ${wfId} persisted plan invalid (${h.invalidReason}); replanning as attempt ${attempt + 1}`);
      const inFlight = h.reconciled.filter((r) => r.decision === 'wait' || r.decision === 'reclaim_after_timeout').map((r) => r.command_key);
      await waitInFlight(h.coordinator, inFlight);
      const outcomes = await outcomesFromLedger(db, h.state);
      pendingReplan = {
        execution: { workflow_id: wfId, plan_id: h.state.plan_id, outcomes, aborted: true, baseline: h.state.baseline },
        reason: `after restart: ${h.invalidReason}`,
      };
    }
    try {
      const start: DriveStart = { attempt, plan: current, coord: h.coordinator, ...(pendingReplan ? { pendingReplan } : {}) };
      await driveWorkflow(wfId, incidents, start, report, stageRef);
    } catch (e) {
      log(`resume continuation of ${wfId} failed during ${stageRef.stage}: ${errMsg(e)}`);
      await onWorkflowError(wfId, stageRef.stage, e); // queued for retry (or escalated after the cap)
      return { escalated: false, aborted: true, note: 'CONTINUATION_ERROR' };
    }
    failures.delete(wfId);
    const aborted = report.status === 'lost_ownership' || report.status === 'stopped';
    return { escalated: report.escalated, aborted, ...(report.replans.length > 0 ? { note: `REPLANNED x${report.replans.length}` } : {}) };
  }

  /** Mark incidents of workflows that resume finished (done/escalated); queue the ones it handed over or skipped. */
  async function settleResumed(r: ResumeReport): Promise<void> {
    for (const item of r.items) {
      if (item.action === 'took_over') {
        takeovers.set(item.workflow_id, { mode: 'continue', dueUnixMs: now(), reason: 'after agent restart' });
        continue;
      }
      if (item.note === LEASE_HELD_BY_LIVE_WORKER) {
        await requeueAfterLease(item.workflow_id);
        continue;
      }
      if (item.action !== 'resumed_execute' && item.action !== 'resumed_verify' && item.action !== 'escalated') continue;
      const wf = await db.getWorkflow(item.workflow_id);
      if (wf) await setIncidentState(wf.incident_ids, item.action === 'escalated' ? 'escalated' : 'monitoring');
    }
  }

  // ------------------------------------------------------------------ tick

  /** Cheap deterministic gate: could triage produce an incident nobody handles? Returns a fingerprint or null. */
  async function precheck(): Promise<{ needed: boolean; fingerprint: string; openWorkflows: WorkflowRecord[]; candidates: Candidate[]; handled: Set<string> }> {
    const [obs, evidence, incidents, openWorkflows] = await Promise.all([
      db.getObservedSnapshot(),
      db.getEvidence([], DEFAULT_TRIAGE_WINDOW_MS),
      db.listIncidents(),
      db.listOpenWorkflows(),
    ]);
    const symptoms = extractSymptoms(obs, evidence.signals.filter((s) => s.run_id === obs.run_id), { existingSymptoms: knownSymptoms(evidence, incidents) });
    const { candidates } = groupSymptoms(obs, symptoms, { windowSimMs: DEFAULT_TRIAGE_WINDOW_MS, existingIncidents: incidents });
    const handled = handledIds(openWorkflows, incidents);
    const fingerprint = candidates.map((c) => c.candidate_id).sort().join('|');
    const unhandledOpen = incidents.some((i) => i.state === 'open' && !handled.has(i.incident_id));
    const needed = unhandledOpen || (candidates.some((c) => !handled.has(c.candidate_id)) && fingerprint !== lastSkippedFingerprint);
    return { needed, fingerprint, openWorkflows, candidates, handled };
  }

  async function tick(): Promise<LoopTickReport> {
    const report = emptyReport('idle');
    const stageRef: { stage: AgentStage } = { stage: 'triage' };
    let activeWf: string | null = null;
    try {
      await runTakeovers(report, stageRef);
      if (report.workflow_id) report.status = report.status === 'idle' ? 'handled' : report.status;
      if (stopping) return report;
      stageRef.stage = 'triage';

      const gate = await precheck();
      if (!gate.needed) return report;

      const triage = await runTriage({ db, llm: chooser ? null : llm, now }, { log });
      report.incidents = triage.incidents;
      const handled = handledIds(await db.listOpenWorkflows(), await db.listIncidents());
      const fresh = triage.incidents.filter((i) => i.state === 'open' && !handled.has(i.incident_id));
      const triageCalls = triage.toolCalls.filter((t) => t.tool === 'get_incident_evidence' || t.tool === 'group_symptoms');
      await safeEmit('triage', {
        summary: `${triage.incidents.length} incident(s), ${fresh.length} new: ${triage.incidents.map((i) => i.title).join('; ') || 'none'}`,
        actor: 'code',
        evidenceIds: triage.incidents.flatMap((i) => triage.evidenceIdsByIncident[i.incident_id] ?? []),
        toolCalls: triageCalls,
      });
      if (fresh.length === 0) {
        lastSkippedFingerprint = gate.fingerprint;
        return report;
      }
      lastSkippedFingerprint = null;
      const batch = [...fresh].sort((a, b) => a.incident_id.localeCompare(b.incident_id));
      const wfId = `wf-${batch[0]!.incident_id}`;
      report.new_incident_ids = batch.map((i) => i.incident_id);
      stageRef.stage = 'diagnose';
      const diag = diagnoseEvent(triage);
      await safeEmit('diagnose', {
        ...diag,
        toolCalls: withoutRepeats(diag.toolCalls, triageCalls),
        workflowId: wfId,
        incidentId: batch[0]!.incident_id,
        evidenceIds: batch.flatMap((i) => triage.evidenceIdsByIncident[i.incident_id] ?? []),
      });
      const existing = await db.getWorkflow(wfId);
      if (existing && (existing.stage === 'done' || existing.stage === 'escalated')) {
        // Crash between closing the workflow and marking its incidents: just settle them.
        await setIncidentState(report.new_incident_ids, existing.stage === 'escalated' ? 'escalated' : 'monitoring');
        return report;
      }
      report.status = 'handled';
      activeWf = wfId;
      await driveWorkflow(wfId, batch, { attempt: 1 }, report, stageRef);
      failures.delete(wfId);
      return report;
    } catch (e) {
      const msg = errMsg(e);
      log(`error during ${stageRef.stage}: ${msg}`);
      if (activeWf) await onWorkflowError(activeWf, stageRef.stage, e); // retry with backoff, escalate after the cap
      else await safeEmit(stageRef.stage, { workflowId: report.workflow_id, actor: 'code', summary: `agent error during ${stageRef.stage}: ${msg}` });
      return { ...report, status: 'error', error: msg };
    }
  }

  // ------------------------------------------------------------------ scheduling

  function runOnce(): Promise<LoopTickReport> {
    if (inflight) {
      dirty = true;
      return Promise.resolve(emptyReport('busy'));
    }
    const run = tick().finally(() => {
      inflight = null;
      if (dirty && started && !stopping) {
        dirty = false;
        schedule(debounceMs);
      }
    });
    inflight = run;
    return run;
  }

  function schedule(delayMs: number): void {
    if (!started || stopping) return;
    if (inflight) {
      dirty = true;
      return;
    }
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runOnce();
    }, delayMs);
  }

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    stopping = false;
    try {
      resumeReport = await resumeOpenWorkflows({ db, physics, events, workerId, clock, sleep, leaseMs, continueExecute: continueResumed });
      const n = resumeReport.items.length;
      if (n > 0) log(`resume: ${resumeReport.items.map((i) => `${i.workflow_id} ${i.action}`).join(', ')}; duplicates ${resumeReport.duplicates_detected}`);
      await settleResumed(resumeReport);
    } catch (e) {
      log(`resume failed: ${errMsg(e)}`);
      await safeEmit('execute', { summary: `resume after restart failed: ${errMsg(e)}` });
    }
    if (stopping) return;
    await runOnce();
    if (stopping) return;
    unsubscribe = db.onChange(() => schedule(debounceMs));
    pollTimer = setInterval(() => schedule(0), pollMs);
  }

  async function stop(): Promise<void> {
    stopping = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    unsubscribe?.();
    unsubscribe = null;
    if (inflight) await Promise.race([inflight.then(() => undefined), realSleep(STOP_WAIT_MS)]);
    started = false;
  }

  return { start, stop, runOnce, lastResume: () => resumeReport };
}
