// Read-mostly DbPort over one ObservedSnapshot, for OFFLINE policy evaluation (no SpacetimeDB).
// Triage and the planner write incidents / symptoms / plans / feed events here (in memory) and read
// them back; anything that would execute an action or touch a workflow lease throws.

import type { ActionStatus, Incident, IncidentLink, ObservedSnapshot, PlanCandidate, SignalEvent } from '@dcos/contracts';
import type {
  AgentEventInput,
  DbChange,
  DbPort,
  Evidence,
  SymptomRecord,
  WorkflowLease,
  WorkflowRecord,
  WorkflowStage,
} from './ports.js';

export const SNAPSHOT_DB_READ_ONLY_MESSAGE =
  'snapshot-db is read-only: policies return commands, they don\'t execute';

const readOnly = (method: string): never => {
  throw new Error(`${SNAPSHOT_DB_READ_ONLY_MESSAGE} (${method})`);
};

const clone = <T>(v: T): T => structuredClone(v);

export class SnapshotDb implements DbPort {
  readonly incidents = new Map<string, Incident>();
  readonly links: IncidentLink[] = [];
  readonly symptoms = new Map<string, SymptomRecord>();
  readonly plans: PlanCandidate[] = [];
  readonly events: AgentEventInput[] = [];

  private readonly snap: ObservedSnapshot;
  private readonly signals: SignalEvent[];

  constructor(snapshot: ObservedSnapshot, signals: SignalEvent[] = []) {
    this.snap = clone(snapshot);
    this.signals = clone(signals);
  }

  async getObservedSnapshot(): Promise<ObservedSnapshot> {
    return clone(this.snap);
  }

  async getEvidence(incidentIds: string[], windowSimMs: number): Promise<Evidence> {
    const asOf = Math.max(this.snap.clock.sim_time_ms, ...this.signals.map((s) => s.sim_time_ms));
    const from = asOf - windowSimMs;
    const wanted = new Set(incidentIds);
    const all = wanted.size === 0;
    const links = this.links.filter((l) => all || wanted.has(l.incident_id));
    const linkedResources = new Set(links.map((l) => l.linked_id));
    return {
      run_id: this.snap.run_id,
      incident_ids: [...incidentIds],
      window_sim_ms: windowSimMs,
      as_of_sim_time_ms: asOf,
      incidents: clone([...this.incidents.values()].filter((i) => all || wanted.has(i.incident_id))),
      links: clone(links),
      symptoms: clone(
        [...this.symptoms.values()].filter(
          (s) => s.last_seen_sim_ms >= from && (all || linkedResources.has(s.symptom_id) || linkedResources.has(s.resource_id)),
        ),
      ),
      signals: clone(this.signals.filter((s) => s.sim_time_ms >= from && s.sim_time_ms <= asOf && (all || linkedResources.has(s.resource_id)))),
      telemetry: [],
    };
  }

  async getActionStatus(_commandKey: string): Promise<ActionStatus | null> {
    return null;
  }

  async requestAction(): Promise<ActionStatus> {
    return readOnly('requestAction');
  }
  async claimAction(): Promise<{ status: ActionStatus; fencing_token: bigint }> {
    return readOnly('claimAction');
  }
  async startAction(): Promise<ActionStatus> {
    return readOnly('startAction');
  }
  async cancelAction(): Promise<ActionStatus> {
    return readOnly('cancelAction');
  }
  async verifyAction(): Promise<ActionStatus> {
    return readOnly('verifyAction');
  }
  async claimWorkflow(): Promise<WorkflowLease> {
    return readOnly('claimWorkflow');
  }
  async heartbeatWorkflow(): Promise<WorkflowLease> {
    return readOnly('heartbeatWorkflow');
  }
  async updateWorkflow(
    _workflowId?: string,
    _expectedVersion?: number,
    _fencingToken?: bigint,
    _stage?: WorkflowStage,
    _state?: Record<string, unknown>,
  ): Promise<WorkflowRecord> {
    return readOnly('updateWorkflow');
  }

  async getWorkflow(_workflowId: string): Promise<WorkflowRecord | null> {
    return null;
  }

  async listOpenWorkflows(): Promise<WorkflowRecord[]> {
    return [];
  }

  async upsertIncident(incident: Incident, links: IncidentLink[]): Promise<Incident> {
    this.incidents.set(incident.incident_id, clone(incident));
    for (const l of links) {
      const dup = this.links.some((x) => x.incident_id === l.incident_id && x.linked_id === l.linked_id && x.link_kind === l.link_kind);
      if (!dup) this.links.push(clone(l));
    }
    return clone(incident);
  }

  async listIncidents(): Promise<Incident[]> {
    return clone([...this.incidents.values()]);
  }

  async upsertSymptoms(symptoms: SymptomRecord[]): Promise<void> {
    for (const s of symptoms) {
      const prev = this.symptoms.get(s.symptom_id);
      this.symptoms.set(s.symptom_id, {
        ...clone(s),
        first_seen_sim_ms: prev ? Math.min(prev.first_seen_sim_ms, s.first_seen_sim_ms) : s.first_seen_sim_ms,
        last_seen_sim_ms: prev ? Math.max(prev.last_seen_sim_ms, s.last_seen_sim_ms) : s.last_seen_sim_ms,
      });
    }
  }

  async submitPlan(plan: PlanCandidate): Promise<void> {
    this.plans.push(clone(plan));
  }

  async publishAgentEvent(ev: AgentEventInput): Promise<void> {
    this.events.push(clone(ev));
  }

  onChange(_cb: (change: DbChange) => void): () => void {
    return () => {};
  }
}

export const createSnapshotDb = (snapshot: ObservedSnapshot, signals: SignalEvent[] = []): SnapshotDb =>
  new SnapshotDb(snapshot, signals);
