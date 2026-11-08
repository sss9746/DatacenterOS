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

import type { Incident, PlanCandidate } from '@dcos/contracts';
import { createCoordinator, DEFAULT_LEASE_MS, type Coordinator, type ExecutionResult } from './coordinator.js';
import type { EventPublisher } from './events.js';
import { LlmUnavailableError } from './llm.js';
import { planIncidents, type PlanResult } from './planner.js';
import type { AgentStage, DbPort, Evidence, LlmPort, PhysicsPort, ToolCallSummary, WorkflowRecord } from './ports.js';
import { createReplanWatcher, runReplan, type ReplanOutcome, type ReplanWatcher } from './replan.js';
import { outcomesFromLedger, resumeOpenWorkflows, type ResumeContinuation, type ResumeHandoff, type ResumeReport } from './resume.js';
import { DEFAULT_TRIAGE_WINDOW_MS, diagnoseEvent, extractSymptoms, groupSymptoms, runTriage, SYMPTOM_BUCKET_MS } from './triage.js';
import { verifyRecovery, type VerificationReport } from './verify.js';

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

export const DEFAULT_POLL_MS = 2_000;
export const DEFAULT_DEBOUNCE_MS = 1_000;
export const DEFAULT_ACTION_POLL_MS = 500;
export const DEFAULT_MAX_REPLANS = 3;
export const DEFAULT_LLM_COOLDOWN_MS = 60_000;
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

/** After an LlmUnavailableError, fail fast for `cooldownMs` instead of waiting on timeouts again. */
export function withLlmCircuitBreaker(inner: LlmPort, cooldownMs: number, now: () => number): LlmPort {
  let openUntil = -Infinity;
  return {
    async chat(req) {
      if (now() < openUntil) throw new LlmUnavailableError('LLM circuit open after a recent outage', []);
      try {
        return await inner.chat(req);
      } catch (e) {
        if (e instanceof LlmUnavailableError) openUntil = now() + cooldownMs;
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
  const llm = deps.llm ? withLlmCircuitBreaker(deps.llm, deps.llmCooldownMs ?? DEFAULT_LLM_COOLDOWN_MS, () => clock.unixMs()) : null;
  const now = () => clock.unixMs();

  let inflight: Promise<LoopTickReport> | null = null;
  let started = false;
  let stopping = false;
  let dirty = false;
  let resumeReport: ResumeReport | null = null;
  let takeovers: string[] = [];
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

  /** Move incidents to `state` (never back to open, never to resolved). Merges no new links. */
  async function setIncidentState(ids: readonly string[], state: Incident['state']): Promise<void> {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    const sim = clock.simTimeMs();
    for (const inc of await db.listIncidents()) {
      if (!wanted.has(inc.incident_id) || inc.state === state || inc.state === 'resolved') continue;
      const next: Incident = { ...inc, state, version: inc.version + 1, updated_sim_time_ms: Math.max(sim, inc.updated_sim_time_ms) };
      await db.upsertIncident(next, []);
    }
  }

  const waitSim = async (simMs: number): Promise<void> => {
    const start = (await db.getObservedSnapshot()).clock.sim_time_ms;
    const maxPolls = Math.ceil((simMs * 4) / Math.max(1, actionPollMs)) + 20;
    for (let i = 0; i < maxPolls; i++) {
      await sleep(actionPollMs);
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
    const r = await planIncidents({ db, physics, llm: llm ?? NO_LLM, workflowId: wfId, runId, attempt }, { incidents });
    await coord.updateStage('plan', { plan_id: r.plan.plan_id, attempt, incident_ids: [...r.plan.incident_ids] });
    await publishPlan(wfId, r);
    return r;
  }

  async function escalate(wfId: string, coord: Coordinator, ids: string[], stage: AgentStage, reason: string, report: LoopTickReport): Promise<void> {
    await coord.updateStage('escalated', { escalation_reason: reason });
    await safeEmit(stage, { workflowId: wfId, incidentId: ids[0], actor: 'code', summary: `escalated to operator: ${reason}` });
    await setIncidentState(ids, 'escalated');
    report.escalated = true;
  }

  async function closeNoAction(wfId: string, coord: Coordinator, ids: string[]): Promise<void> {
    const handoff = 'No recovery action needed: affected jobs keep running; incident stays under monitoring.';
    await coord.updateStage('done', { verification: { verified: true, escalate: false, handoff, as_of_sim_time_ms: clock.simTimeMs() } });
    await safeEmit('verify', { workflowId: wfId, incidentId: ids[0], actor: 'code', summary: handoff });
    await setIncidentState(ids, 'monitoring');
  }

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
  }

  async function driveWorkflow(wfId: string, incidents: Incident[], start: DriveStart, report: LoopTickReport, stageRef: { stage: AgentStage }): Promise<void> {
    const ids = incidents.map((i) => i.incident_id);
    const coord =
      start.coord ??
      createCoordinator({ db, physics, events, workerId, clock, sleep, leaseMs, pollMs: actionPollMs, onLostOwnership: (why) => log(`lost ownership of ${wfId}: ${why}`) });
    if (!start.coord) await coord.ensureWorkflow(wfId, ids);
    coord.startHeartbeat();
    report.workflow_id = wfId;
    let watcher: ReplanWatcher | null = null;
    try {
      await setIncidentState(ids, 'investigating');
      let attempt = start.attempt;
      stageRef.stage = 'plan';
      let current = start.plan ?? (await plan(wfId, incidents, attempt, coord));
      report.plans.push(current);
      if (current.commands.length === 0) return closeNoAction(wfId, coord, workflowIncidents(coord, current));
      if (deps.requireApproval && current.job_plans.some((p) => p.needs_approval)) {
        return escalate(wfId, coord, workflowIncidents(coord, current), 'plan', 'planner flagged needs_approval', report);
      }
      watcher = createReplanWatcher({ db }, current);
      const w = watcher;
      let exec: ExecutionResult;
      let pending = start.pendingReplan ?? null;
      for (;;) {
        let reason: string;
        if (pending) {
          exec = pending.execution;
          reason = pending.reason;
          pending = null;
        } else {
          stageRef.stage = 'execute';
          exec = await coord.execute(wfId, current, { shouldAbort: () => stopping || w.shouldAbort() });
          report.executions.push(exec);
          if (!exec.aborted) break;
          if (!coord.isOwner()) {
            report.status = 'lost_ownership';
            return;
          }
          if (!w.shouldAbort()) {
            report.status = 'stopped'; // graceful stop: the persisted execute state is resumed on next boot
            return;
          }
          reason = w.reason() ?? 'material change to the active plan';
        }
        if (attempt - 1 >= maxReplans) {
          return escalate(wfId, coord, workflowIncidents(coord, current), 'replan', `replan limit (${maxReplans}) reached: ${reason}`, report);
        }
        attempt += 1;
        stageRef.stage = 'replan';
        const out = await runReplan(
          { db, physics, llm, events, workflowId: wfId, runId, workerId, fencingToken: coord.lease()!.fencing_token, now },
          { previous: current, execution: exec, attempt, reason },
        );
        report.replans.push(out);
        await coord.ensureWorkflow(wfId, [...out.new_plan.plan.incident_ids]); // runReplan bumped the workflow version
        report.new_incident_ids = [...new Set([...report.new_incident_ids, ...out.new_incident_ids])];
        await setIncidentState(out.new_plan.plan.incident_ids, 'investigating');
        current = out.new_plan;
        report.plans.push(current);
        await publishPlan(wfId, current, out);
        if (current.commands.length === 0) return closeNoAction(wfId, coord, workflowIncidents(coord, current));
        w.reset(current);
      }
      stageRef.stage = 'verify';
      await coord.updateStage('verify', {});
      const v = await verifyRecovery(
        { db, events, waitSim, persist: (stage, patch) => coord.updateStage(stage, patch) },
        { workflowId: wfId, plan: current, result: exec },
      );
      report.verification = v;
      report.escalated = report.escalated || v.escalate;
      await safeEmit('verify', { workflowId: wfId, incidentId: current.plan.incident_ids[0], actor: 'code', summary: `handoff: ${v.handoff}` });
      await setIncidentState(workflowIncidents(coord, current), v.escalate ? 'escalated' : 'monitoring');
    } finally {
      watcher?.dispose();
      coord.stopHeartbeat();
    }
  }

  // ------------------------------------------------------------------ takeovers from resume

  /** A workflow resume claimed but could not execute (stage triage/plan/replan): continue it here. */
  async function continueTakeover(wfId: string, report: LoopTickReport, stageRef: { stage: AgentStage }): Promise<void> {
    const wf = await db.getWorkflow(wfId);
    if (!wf || wf.stage === 'done' || wf.stage === 'escalated') return;
    const ids = new Set(wf.incident_ids);
    const incidents = (await db.listIncidents()).filter((i) => ids.has(i.incident_id) && i.state !== 'resolved');
    const attempt = typeof wf.state.attempt === 'number' ? wf.state.attempt : 1;
    const persisted = wf.stage === 'replan' ? planFromWorkflow(wf) : null;
    if (incidents.length === 0 && !persisted) {
      const coord = createCoordinator({ db, physics, events, workerId, clock, sleep, leaseMs, pollMs: actionPollMs });
      await coord.ensureWorkflow(wfId, []);
      await coord.updateStage('done', { note: 'no open incidents left after restart' });
      return;
    }
    await safeEmit('execute', { workflowId: wfId, incidentId: wf.incident_ids[0], summary: `continuing ${wfId} from stage ${wf.stage} after agent restart` });
    await driveWorkflow(wfId, incidents, persisted ? { attempt, plan: persisted } : { attempt }, report, stageRef);
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
    const current: PlanResult = { plan: h.plan.plan, commands: h.plan.commands, job_plans: [], tool_calls: [], used_llm: false };
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
      await safeEmit(stageRef.stage, { workflowId: wfId, summary: `agent error during ${stageRef.stage} after restart: ${errMsg(e)}` });
      return { escalated: false, aborted: true, note: 'CONTINUATION_ERROR' };
    }
    const aborted = report.status === 'lost_ownership' || report.status === 'stopped';
    return { escalated: report.escalated, aborted, ...(report.replans.length > 0 ? { note: `REPLANNED x${report.replans.length}` } : {}) };
  }

  /** Mark incidents of workflows that resume finished (done/escalated). */
  async function settleResumed(r: ResumeReport): Promise<void> {
    for (const item of r.items) {
      if (item.action === 'took_over') {
        takeovers.push(item.workflow_id);
        continue;
      }
      if (item.action !== 'resumed_execute' && item.action !== 'resumed_verify' && item.action !== 'escalated') continue;
      const wf = await db.getWorkflow(item.workflow_id);
      if (wf) await setIncidentState(wf.incident_ids, item.action === 'escalated' ? 'escalated' : 'monitoring');
    }
  }

  // ------------------------------------------------------------------ tick

  /** Cheap deterministic gate: could triage produce an incident nobody handles? Returns a fingerprint or null. */
  async function precheck(): Promise<{ needed: boolean; fingerprint: string; openWorkflows: WorkflowRecord[] }> {
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
    return { needed, fingerprint, openWorkflows };
  }

  async function tick(): Promise<LoopTickReport> {
    const report = emptyReport('idle');
    const stageRef: { stage: AgentStage } = { stage: 'triage' };
    try {
      const pending = takeovers;
      takeovers = [];
      for (const wfId of pending) await continueTakeover(wfId, report, stageRef);
      if (report.workflow_id) report.status = report.status === 'idle' ? 'handled' : report.status;
      if (stopping) return report;

      const gate = await precheck();
      if (!gate.needed) return report;

      const triage = await runTriage({ db, llm, now }, { log });
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
      await driveWorkflow(wfId, batch, { attempt: 1 }, report, stageRef);
      return report;
    } catch (e) {
      const msg = errMsg(e);
      log(`error during ${stageRef.stage}: ${msg}`);
      await safeEmit(stageRef.stage, { workflowId: report.workflow_id, summary: `agent error during ${stageRef.stage}: ${msg}` });
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
