// TODO(integration): delete this file once the agent-room and controls slices land; App.tsx swaps its imports to
//   import { AgentRoom } from '../components/agent-room/AgentRoom';
//   import { DemoControls } from '../components/controls/DemoControls';
// Both placeholders implement the exact prop contracts from apps/web/DESIGN-DIRECTION.md §6.
import { SlidersHorizontal } from 'lucide-react';
import type { ActionDetail, PlanRecord, WorkflowRecord } from '@dcos/db-client';
import type { ObservedSnapshot } from '@dcos/contracts';
import type { DashboardStore } from '../data/dashboard';
import { PresenterControls } from '../components/controls/Controls';
import type { PumpId } from '../components/controls/fault-form';
import { Badge } from '../components/ui/panel';

export function DemoControls({ store, canAdmin, open, selectedGpuId, selectedPumpId, onSelectGpu, onSelectPump, onReset }: {
  store: DashboardStore; canAdmin: boolean; open: boolean;
  selectedGpuId: string; selectedPumpId: PumpId;
  onSelectGpu: (id: string) => void; onSelectPump: (id: PumpId) => void; onReset: () => void;
  plans: PlanRecord[]; actionDetails: ActionDetail[]; workflows: WorkflowRecord[]; snapshot: ObservedSnapshot;
}) {
  return <details className="demo-bar" id="presenter" open={open}>
    <summary><SlidersHorizontal size={18} aria-hidden="true"/><span>Demo controls</span><small>{canAdmin ? 'Inject a fault · safety probe · reset' : 'Read-only without the presenter token'}</small>{!canAdmin && <Badge tone="simulated">Read-only</Badge>}</summary>
    <div className="demo-bar-body"><PresenterControls store={store} canAdmin={canAdmin} selectedGpuId={selectedGpuId} selectedPumpId={selectedPumpId} onSelectGpu={onSelectGpu} onSelectPump={onSelectPump} onReset={onReset}/></div>
  </details>;
}
