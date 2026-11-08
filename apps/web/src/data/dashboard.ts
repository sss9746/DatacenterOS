import { connect, createMockClient, type ActionDetail, type DbClient, type AgentEventInput, type Evidence, type MockDbClient, type WorkflowRecord } from '@dcos/db-client';
import type { ActionStatus, EvaluationResult, Incident, ObservedSnapshot, SignalEvent } from '@dcos/contracts';
import { loadRecoveryExample } from './recovery-example';
import { createLocalPhysicsClient, type LocalFacilityConfig } from './local-physics';

export type Preview = 'physics' | 'demo' | 'pump_degraded' | 'recovery';
export interface DashboardState {
  phase: 'loading' | 'ready' | 'error';
  snapshot: ObservedSnapshot | null;
  incidents: Incident[];
  actions: ActionStatus[];
  /** Typed ledger projection from `onActionDetails`: command, safety evidence, timing and history. */
  actionDetails: ActionDetail[];
  events: AgentEventInput[];
  /** Persisted workflow rows (open ones plus any workflow referenced by events or actions), read from the DB. */
  workflows: WorkflowRecord[];
  results: EvaluationResult[];
  evidence: Evidence | null;
  signals: SignalEvent[];
  losses: Record<string, number>;
  jobHistory: Record<string, Array<{ status: string; sim_time_ms: number }>>;
  error: string | null;
  lastReceived: number | null;
}
export const emptyState = (): DashboardState => ({ phase: 'loading', snapshot: null, incidents: [], actions: [], actionDetails: [], events: [], workflows: [], results: [], evidence: null, signals: [], losses: {}, jobHistory: {}, error: null, lastReceived: null });
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
  start() {
    this.unsubscribers = [
      this.client.onGpu(() => { void this.refresh(); }),
      this.client.onJobs(() => { void this.refresh(); }),
      this.client.onIncidents((incidents) => { this.update({ incidents }); void this.refresh(); }),
      this.client.onActions((actions) => this.update({ actions })),
      this.client.onActionDetails((actionDetails) => { this.update({ actionDetails }); void this.refresh(); }),
      this.client.onAgentEvents((events) => { this.update({ events: events.slice(-200) }); void this.refresh(); }),
      this.client.onEvaluation((results) => this.update({ results })),
      this.client.onChange(() => { void this.refresh(); }),
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
        const [snapshot, evidence, workflows] = await Promise.all([this.client.getObservedSnapshot(), this.client.getEvidence([], 600_000), this.readWorkflows()]);
        if (this.closed) return;
        const losses = { ...this.state.losses };
        const history = { ...this.state.jobHistory };
        const sameRun = this.state.snapshot?.run_id === snapshot.run_id && snapshot.clock.sim_time_ms >= this.state.snapshot.clock.sim_time_ms;
        if (!sameRun) { Object.keys(losses).forEach((id) => delete losses[id]); Object.keys(history).forEach((id) => delete history[id]); }
        for (const job of snapshot.job_states) {
          const previous = sameRun ? this.state.snapshot?.job_states.find((row) => row.job_id === job.job_id) : undefined;
          const drop = previous ? Math.max(0, previous.progress_work_units - job.progress_work_units) : 0;
          if (drop) losses[job.job_id] = (losses[job.job_id] ?? 0) + drop;
          const entries = history[job.job_id] ?? [];
          if (entries.at(-1)?.status !== job.status) history[job.job_id] = [...entries, { status: job.status, sim_time_ms: snapshot.clock.sim_time_ms }].slice(-12);
        }
        const runWorkflows = workflows.filter((row) => row.run_id === snapshot.run_id);
        this.update({ snapshot, evidence, workflows: runWorkflows, signals: evidence.signals.slice(-100), losses, jobHistory: history, phase: 'ready', error: null, lastReceived: Date.now() });
      } while (this.refreshAgain && !this.closed);
    } catch (error) { this.update({ phase: 'error', error: errorMessage(error) }); }
    finally { this.refreshing = false; }
  }
  /**
   * Workflow rows straight from the DB. `listOpenWorkflows` omits `done` rows, so closed workflows that events or
   * actions still reference are read individually; their persisted state carries the verification handoff.
   * References come only from DB subscriptions, so a reset (which clears those rows) drops the previous run's workflows.
   */
  private async readWorkflows(): Promise<WorkflowRecord[]> {
    const open = await this.client.listOpenWorkflows();
    const known = new Set(open.map((row) => row.workflow_id));
    const referenced = new Set<string>();
    for (const event of this.state.events) if (event.workflow_id) referenced.add(event.workflow_id);
    for (const detail of this.state.actionDetails) if (detail.command.workflow_id) referenced.add(detail.command.workflow_id);
    const missing = [...referenced].filter((id) => !known.has(id));
    const closed = await Promise.all(missing.map((id) => this.client.getWorkflow(id)));
    return [...open, ...closed.filter((row): row is WorkflowRecord => row !== null)];
  }
  close() { this.closed = true; clearInterval(this.timer); this.unsubscribers.forEach((fn) => fn()); this.client.close(); this.listeners.clear(); }
}

export async function openDashboard(mode: 'mock' | 'live', preview: Preview, options: { uri: string; db: string; token?: string; localConfig?: LocalFacilityConfig }) {
  let client: DbClient;
  if (mode === 'live') client = await connect({ ...options, runId: 'run-demo-1' });
  else {
    const mock = preview === 'physics' ? createLocalPhysicsClient(42, options.localConfig) : createMockClient({ snapshot: preview === 'pump_degraded' ? preview : 'demo' });
    if (preview === 'recovery') await loadRecoveryExample(mock);
    client = mock;
  }
  return new DashboardStore(client);
}
export const asMock = (client: DbClient) => client.mode === 'mock' ? client as MockDbClient : null;
