import type { ObservedSnapshot } from '@dcos/contracts';
import type { PlanRecord, WorkflowRecord } from '@dcos/db-client';
import type { DashboardState, DashboardStore } from '../data/dashboard';
import type { PumpId } from '../components/controls/fault-form';
import type { RouteId } from './routes';

/**
 * CONTRACT between the shell (App.tsx) and every page in `src/pages/*`. Pages derive everything they show from
 * `state`/`snapshot`; they never open their own store. The shell renders a page only once a snapshot exists.
 * Do not change this file without telling the orchestrator; add fields in your report instead.
 */
export interface PageProps {
  /** Full read model: incidents, actions, actionDetails, events, workflows, plans, results, evidence, signals, losses, jobHistory. */
  state: DashboardState;
  store: DashboardStore;
  /** Non-null: the shell shows loading/error surfaces itself. */
  snapshot: ObservedSnapshot;
  /** `mock` (fixtures or local physics) or `live` (SpacetimeDB). Honesty labels depend on it. */
  mode: 'mock' | 'live';
  dbName: string;
  /** Presenter/admin: true in mock, or live with the local admin token. Never weaken it in a page. */
  canAdmin: boolean;
  /** Mock + local physics preview (P1 physics in the browser, no agent). */
  localPhysics: boolean;
  /** Mock + scripted recovery example: every incident/event/workflow is an EXAMPLE fixture and must be labelled so. */
  example: boolean;
  /**
   * Mock + RECORDED replay of a saved real agent-team run (`data/recorded-run.ts`): the workflow's `state.team` /
   * `state.team_rounds` are real Nemotron traces; the cluster telemetry around them is the mock fixture. Null otherwise.
   * `timing: 'replay'` means v1 traces with no per-message timing: label it "replay pacing, not recorded timing".
   */
  recorded: { model: string | null; date: string; db: string; timing: 'replay' | 'recorded' } | null;
  /** Wall clock (ms), ticks once per second. Use for staleness and lease expiry, never for sim time. */
  now: number;
  /** `state.workflows` / `state.plans` filtered to `snapshot.run_id`. */
  runWorkflows: WorkflowRecord[];
  runPlans: PlanRecord[];
  selectedGpuId: string;
  selectedPumpId: PumpId;
  onSelectGpu: (id: string) => void;
  onSelectPump: (id: PumpId) => void;
  /** Surface a user-facing error in the shell's alert strip (e.g. a failed mock batch load). */
  onError: (message: string) => void;
  /** Navigate to another page, optionally to an anchor on it (`navigate('workflows', 'ledger')`). */
  navigate: (route: RouteId, anchor?: string) => void;
}

/** Strip the `-<pid>` suffix of a worker id for display: `agent-alpha-4132` → `agent-alpha`; `example-agent-beta-2` → `example-agent-beta`. */
export const ownerLabel = (leaseOwner: string | null | undefined): string | null => {
  if (!leaseOwner) return null;
  return leaseOwner.replace(/-\d+$/, '');
};
