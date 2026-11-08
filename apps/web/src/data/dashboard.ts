import { connect, createMockClient, type ActionDetail, type DbClient, type AgentEventInput, type Evidence, type MockDbClient, type PlanRecord, type WorkflowRecord } from '@dcos/db-client';
import type { ActionStatus, EvaluationResult, Incident, JobState, ObservedSnapshot, SignalEvent } from '@dcos/contracts';
import { evaluateSafety } from '@dcos/physics';
import { loadRecoveryExample } from './recovery-example';
import { loadRecordedRun } from './recorded-run';
import { createLocalPhysicsClient, type LocalFacilityConfig } from './local-physics';

export type Preview = 'physics' | 'demo' | 'pump_degraded' | 'recovery' | 'recorded';
export interface DashboardState {
  phase: 'loading' | 'ready' | 'error';
  snapshot: ObservedSnapshot | null;
  incidents: Incident[];
  actions: ActionStatus[];
  /** Typed ledger projection from `onActionDetails`: command, safety evidence, timing and history. */
  actionDetails: ActionDetail[];
  events: AgentEventInput[];
  /** Every persisted workflow row (`onWorkflows`), including `done` ones whose state carries the final handoff. */
  workflows: WorkflowRecord[];
  /** Persisted plans (`onPlans`). The selected plan is `workflow.plan_id`; `plan.status` stays `proposed` and is not an adoption signal. */
  plans: PlanRecord[];
  results: EvaluationResult[];
  evidence: Evidence | null;
  signals: SignalEvent[];
  losses: Record<string, number>;
  jobHistory: Record<string, Array<{ status: string; sim_time_ms: number }>>;
  /**
   * Observed per-job trail: one entry each time a job's status, GPU set or latest checkpoint changed between
   * snapshots, with the progress seen in the snapshot just before the change. Pure observation, never advanced here;
   * `jobMoveTimeline` derives the recovery story (previous placement, work lost at a move) from it.
   */
  jobTrail: Record<string, JobTrailEntry[]>;
  error: string | null;
  /**
   * Wall time of the last observed change: a subscription callback or an advancing sim clock. A periodic re-read of
   * an unchanged client cache does not count, so a silently dropped live socket shows up as stale rather than fresh.
   */
  lastReceived: number | null;
}
export interface JobTrailEntry {
  sim_time_ms: number;
  status: string;
  gpu_ids: string[];
  progress: number;
  durable: number;
  checkpoint_id: string | null;
  /** Progress in the snapshot just before this change (null for the first observation of the job). */
  progress_before: number | null;
}
const TRAIL_LIMIT = 24;
/** Append a trail entry when the job's status, GPU set or latest checkpoint changed; otherwise keep the trail as is. */
export function appendTrail(trail: readonly JobTrailEntry[] | undefined, job: Pick<JobState, 'status' | 'allocated_gpu_ids' | 'progress_work_units' | 'durable_work_units' | 'latest_checkpoint_id'>, simMs: number, previousProgress: number | null): JobTrailEntry[] {
  const entries = trail ?? [];
  const last = entries.at(-1);
  const gpus = [...job.allocated_gpu_ids].sort();
  const same = last && last.status === job.status && last.checkpoint_id === job.latest_checkpoint_id && last.gpu_ids.length === gpus.length && last.gpu_ids.every((id, i) => id === gpus[i]);
  if (same) return entries as JobTrailEntry[];
  return [...entries, { sim_time_ms: simMs, status: job.status, gpu_ids: gpus, progress: job.progress_work_units, durable: job.durable_work_units, checkpoint_id: job.latest_checkpoint_id, progress_before: previousProgress }].slice(-TRAIL_LIMIT);
}
export const emptyState = (): DashboardState => ({ phase: 'loading', snapshot: null, incidents: [], actions: [], actionDetails: [], events: [], workflows: [], plans: [], results: [], evidence: null, signals: [], losses: {}, jobHistory: {}, jobTrail: {}, error: null, lastReceived: null });
export function errorMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? `${String(error.code)}: ` : '';
  return code + (error instanceof Error ? error.message : 'The database request failed. Retry when the connection is available.');
}

/** Public read model. History records observed changes; it never advances physics. */
export class DashboardStore {
  state = emptyState();
  private listeners = new Set<() => void>();
  private unsubscribers: Array<() => void> = [];
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private refreshing = false;
  private refreshAgain = false;
  constructor(readonly client: DbClient) {}
  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; };
  getSnapshot = () => this.state;
  private update(patch: Partial<DashboardState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((cb) => cb());
  }
  private touch() { this.update({ lastReceived: Date.now() }); }
  start() {
    const seen = <T>(fn: (value: T) => void) => (value: T) => { this.touch(); fn(value); };
    this.unsubscribers = [
      this.client.onGpu(seen((_) => { void this.refresh(); })),
      this.client.onJobs(seen((_) => { void this.refresh(); })),
      this.client.onIncidents(seen((incidents) => { this.update({ incidents }); void this.refresh(); })),
      this.client.onActions(seen((actions) => this.update({ actions }))),
      this.client.onActionDetails(seen((actionDetails) => { this.update({ actionDetails }); void this.refresh(); })),
      this.client.onAgentEvents(seen((events) => { this.update({ events: events.slice(-200) }); void this.refresh(); })),
      this.client.onEvaluation(seen((results) => this.update({ results }))),
      this.client.onWorkflows(seen((workflows) => this.update({ workflows }))),
      this.client.onPlans(seen((plans) => this.update({ plans }))),
      this.client.onChange(seen((_) => { void this.refresh(); })),
    ];
    // The current API has no onRun/onCooling subscription. Refresh its public snapshot
    // once per second as well, so paused clocks and cooling-only changes are visible.
    this.timer = setInterval(() => { void this.refresh(); }, 1000);
    void this.refresh();
  }
  async refresh() {
    if (this.closed) return;
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        const [snapshot, evidence] = await Promise.all([this.client.getObservedSnapshot(), this.client.getEvidence([], 600_000)]);
        if (this.closed) return;
        const losses = { ...this.state.losses };
        const history = { ...this.state.jobHistory };
        const sameRun = this.state.snapshot?.run_id === snapshot.run_id && snapshot.clock.sim_time_ms >= this.state.snapshot.clock.sim_time_ms;
        const trail: Record<string, JobTrailEntry[]> = sameRun ? { ...this.state.jobTrail } : {};
        if (!sameRun) { Object.keys(losses).forEach((id) => delete losses[id]); Object.keys(history).forEach((id) => delete history[id]); }
        for (const job of snapshot.job_states) {
          const previous = sameRun ? this.state.snapshot?.job_states.find((row) => row.job_id === job.job_id) : undefined;
          const drop = previous ? Math.max(0, previous.progress_work_units - job.progress_work_units) : 0;
          if (drop) losses[job.job_id] = (losses[job.job_id] ?? 0) + drop;
          const entries = history[job.job_id] ?? [];
          if (entries.at(-1)?.status !== job.status) history[job.job_id] = [...entries, { status: job.status, sim_time_ms: snapshot.clock.sim_time_ms }].slice(-12);
          trail[job.job_id] = appendTrail(trail[job.job_id], job, snapshot.clock.sim_time_ms, previous?.progress_work_units ?? null);
        }
        const advanced = !sameRun || snapshot.clock.sim_time_ms !== this.state.snapshot?.clock.sim_time_ms || this.state.lastReceived === null;
        this.update({ snapshot, evidence, signals: evidence.signals.slice(-100), losses, jobHistory: history, jobTrail: trail, phase: 'ready', error: null, ...(advanced ? { lastReceived: Date.now() } : {}) });
      } while (this.refreshAgain && !this.closed);
    } catch (error) { this.update({ phase: 'error', error: errorMessage(error) }); }
    finally { this.refreshing = false; }
  }
  close() { this.closed = true; clearInterval(this.timer); this.unsubscribers.forEach((fn) => fn()); this.client.close(); this.listeners.clear(); }
}

export async function openDashboard(mode: 'mock' | 'live', preview: Preview, options: { uri: string; db: string; token?: string; localConfig?: LocalFacilityConfig }) {
  let client: DbClient;
  if (mode === 'live') client = await connect({ ...options, runId: 'run-demo-1' });
  else {
    const mock = preview === 'physics' ? createLocalPhysicsClient(42, options.localConfig) : createMockClient({ snapshot: preview === 'pump_degraded' ? preview : 'demo', evaluateSafety });
    if (preview === 'recovery') await loadRecoveryExample(mock);
    if (preview === 'recorded') await loadRecordedRun(mock);
    client = mock;
  }
  return new DashboardStore(client);
}
export const asMock = (client: DbClient) => client.mode === 'mock' ? client as MockDbClient : null;
