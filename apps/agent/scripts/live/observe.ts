// Observer: a subscription-backed view of the public DB state the cases wait on. onActionDetails /
// onJobs / onIncidents / onAgentEvents / onChange push into a cache and nudge every pending wait;
// snapshot + workflows are fetched on each evaluation (no subscription exposes them). Waits are
// bounded wall-time (wait.ts); there is no fixed sleep anywhere on the correctness path.

import type { Incident, IncidentLink, JobState, ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail, AgentEventInput, DbClient, WorkflowRecord } from '@dcos/db-client';
import { newTeamStore, OPEN_STATUSES, recordRecoverySamples, recordTeamRounds, type ObservedRound, type RecoverySample } from './asserts.js';
import { waitFor, type WaitResult } from './wait.js';

export interface LiveState {
  snapshot: ObservedSnapshot;
  details: ActionDetail[];
  jobs: JobState[];
  incidents: Incident[];
  events: AgentEventInput[];
  workflows: WorkflowRecord[];
  wallUnixMs: number;
}

export interface Observer {
  /** Latest cached state (snapshot/workflows refreshed by the last read()). */
  current(): LiveState | null;
  /** Fresh read: snapshot + open workflows from the DB, the rest from the cache. */
  read(): Promise<LiveState>;
  /** Bounded wait on a predicate over LiveState. */
  until<R>(what: string, timeoutMs: number, pred: (s: LiveState) => R, abortIf?: () => string | null): Promise<WaitResult<LiveState, NonNullable<R>>>;
  /** Incident links (resource/symptom/workflow) for separation checks. */
  links(): Promise<IncidentLink[]>;
  /** Workflow by id, including closed ones (listOpenWorkflows excludes done/escalated). */
  workflow(id: string): Promise<WorkflowRecord | null>;
  /** Keep this workflow in `read().workflows` even after it closes (done/escalated). */
  trackWorkflow(id: string): void;
  /** Every distinct team round seen so far (`state.team` itself holds only the latest). */
  teamRounds(): ObservedRound[];
  /** Workflows whose `state.team` did not have the frozen shape. */
  teamMalformed(): string[];
  /** `state.recovery` history, one entry per change of status, attempts, first wait or owner. */
  recoverySamples(): RecoverySample[];
  simNow(): number;
  close(): void;
}

export function summarizeState(s: LiveState): string {
  const wf = s.workflows.map((w) => `${w.workflow_id}@${w.stage}/${w.lease_owner ?? '-'}`).join(' ');
  const acts = s.details.map((d) => `${d.command.operation}:${d.command.job_id ?? d.command.target_resource_id}=${d.status.status}`).join(' ');
  return `sim=${s.snapshot.clock.sim_time_ms} epoch=${s.snapshot.clock.decision_epoch ?? '?'} jobs=${s.jobs.map((j) => `${j.job_id}:${j.status}`).join(',')} incidents=${s.incidents.length} wf=[${wf}] actions=[${acts}]`;
}

/** Bounded, secret-free snapshot summary for a failure artifact. */
export function snapshotSummary(s: LiveState): Record<string, unknown> {
  return {
    wall_unix_ms: s.wallUnixMs,
    clock: s.snapshot.clock,
    jobs: s.jobs.map((j) => ({ job_id: j.job_id, status: j.status, gpus: j.allocated_gpu_ids, progress: j.progress_work_units, durable: j.durable_work_units })),
    checkpoints: s.snapshot.checkpoints.map((c) => ({ id: c.checkpoint_id, job: c.job_id, status: c.status, key: c.command_key, complete_at: c.complete_sim_time_ms, accessible: c.accessible })),
    incidents: s.incidents.map((i) => ({ id: i.incident_id, state: i.state, severity: i.severity, title: i.title })),
    workflows: s.workflows.map((w) => ({ id: w.workflow_id, stage: w.stage, owner: w.lease_owner, attempt: w.attempt, version: w.version, current: w.current_command_key })),
    actions: s.details.map(ledgerRow),
    agent_events_tail: s.events.slice(-15).map((e) => ({ stage: e.stage, actor: e.actor ?? null, sim: e.sim_time_ms, summary: e.summary.slice(0, 200) })),
    unhealthy_gpus: s.snapshot.gpus.filter((g) => g.availability !== 'ready' || g.last_xid_code !== null).map((g) => ({ id: g.resource_id, availability: g.availability, last_xid: g.last_xid_code })),
  };
}

export function ledgerRow(d: ActionDetail): Record<string, unknown> {
  return {
    command_key: d.command.command_key,
    operation: d.command.operation,
    job_id: d.command.job_id,
    target: d.command.target_resource_id,
    status: d.status.status,
    reason_code: d.status.reason_code,
    attempt: d.status.attempt,
    claimed_by: d.claimed_by,
    due_sim_time_ms: d.due_sim_time_ms,
    depends_on: d.command.depends_on_command_keys,
    destination_gpu_ids: Array.isArray(d.command.arguments.destination_gpu_ids) ? d.command.arguments.destination_gpu_ids : undefined,
    safety: d.safety ? { decision: d.safety.decision, violations: d.safety.violations } : null,
    start_safety: d.start_safety ? { decision: d.start_safety.decision, violations: d.start_safety.violations } : null,
    history: d.history.map((h) => `${h.status}@${h.sim_time_ms}${h.reason_code ? `(${h.reason_code})` : ''}`),
  };
}

export interface ObserverOptions {
  /** Keep every workflow readable after it closes, so a short-lived one cannot vanish before its handoff is read. */
  trackAll?: boolean;
}

export function createObserver(client: DbClient, opts: ObserverOptions = {}): Observer {
  const team = newTeamStore();
  const recovery: RecoverySample[] = [];
  let details: ActionDetail[] = [];
  let jobs: JobState[] = [];
  let incidents: Incident[] = [];
  let events: AgentEventInput[] = [];
  let simNow = 0;
  let last: LiveState | null = null;
  const nudges = new Set<() => void>();
  const nudge = () => nudges.forEach((f) => f());

  const unsubs = [
    client.onActionDetails((d) => {
      details = d;
      nudge();
    }),
    client.onJobs((j) => {
      jobs = j;
      nudge();
    }),
    client.onIncidents((i) => {
      incidents = i;
      nudge();
    }),
    client.onAgentEvents((e) => {
      events = e;
      nudge();
    }),
    client.onChange((c) => {
      const t = c.kind === 'signal' ? c.signal.sim_time_ms : c.kind === 'action_status' ? c.status.updated_sim_time_ms : c.sim_time_ms;
      if (t > simNow) simNow = t;
      nudge();
    }),
  ];

  const tracked = new Set<string>();
  const read = async (): Promise<LiveState> => {
    const [snapshot, open] = await Promise.all([client.getObservedSnapshot(), client.listOpenWorkflows()]);
    if (opts.trackAll) for (const w of open) tracked.add(w.workflow_id);
    const missing = [...tracked].filter((id) => !open.some((w) => w.workflow_id === id));
    const closed = (await Promise.all(missing.map((id) => client.getWorkflow(id)))).filter((w): w is WorkflowRecord => w !== null);
    const workflows = [...open, ...closed];
    if (snapshot.clock.sim_time_ms > simNow) simNow = snapshot.clock.sim_time_ms;
    last = { snapshot, details, jobs, incidents, events, workflows, wallUnixMs: Date.now() };
    recordTeamRounds(team, workflows);
    recordRecoverySamples(recovery, workflows, last.wallUnixMs);
    return last;
  };

  return {
    current: () => last,
    read,
    until: (what, timeoutMs, pred, abortIf) =>
      waitFor({
        what,
        timeoutMs,
        pollMs: 500,
        nudge: (fire) => {
          nudges.add(fire);
          return () => nudges.delete(fire);
        },
        read,
        until: pred,
        summarize: summarizeState,
        abortIf,
      }),
    links: async () => (await client.getEvidence([], 1)).links,
    workflow: (id) => client.getWorkflow(id),
    trackWorkflow: (id) => void tracked.add(id),
    teamRounds: () => [...team.rounds.values()],
    teamMalformed: () => [...team.malformed],
    recoverySamples: () => [...recovery],
    simNow: () => simNow,
    close: () => unsubs.forEach((u) => u()),
  };
}

// ---------------------------------------------------------------------------- common predicates

export const openAction = (s: LiveState, operation: ActionDetail['command']['operation'], jobId: string) =>
  s.details.find((d) => d.command.operation === operation && d.command.job_id === jobId && OPEN_STATUSES.has(d.status.status)) ?? null;

export const actionWithStatus = (s: LiveState, key: string, statuses: readonly ActionDetail['status']['status'][]) => {
  const d = s.details.find((x) => x.command.command_key === key);
  return d && statuses.includes(d.status.status) ? d : null;
};

export const byKey = (s: LiveState, key: string) => s.details.find((x) => x.command.command_key === key) ?? null;

export const workflowForJob = (s: LiveState, jobId: string): WorkflowRecord | null => {
  const keyed = s.details.find((d) => d.command.job_id === jobId);
  if (keyed) return s.workflows.find((w) => w.workflow_id === keyed.command.workflow_id) ?? null;
  return s.workflows[0] ?? null;
};

export const jobState = (s: LiveState, jobId: string): JobState | null => s.jobs.find((j) => j.job_id === jobId) ?? null;

export const completeCheckpoints = (s: LiveState, jobId: string): number => s.snapshot.checkpoints.filter((c) => c.job_id === jobId && c.status === 'complete').length;
