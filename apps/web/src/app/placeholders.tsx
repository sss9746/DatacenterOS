// TODO(integration): delete this file once the agent-room and controls slices land; App.tsx swaps its imports to
//   import { AgentRoom } from '../components/agent-room/AgentRoom';
//   import { DemoControls } from '../components/controls/DemoControls';
// Both placeholders implement the exact prop contracts from apps/web/DESIGN-DIRECTION.md §6.
import { SlidersHorizontal, Users } from 'lucide-react';
import type { ActionDetail, AgentEventInput, PlanRecord, WorkflowRecord } from '@dcos/db-client';
import type { Incident, ObservedSnapshot } from '@dcos/contracts';
import type { DashboardStore } from '../data/dashboard';
import { PresenterControls } from '../components/controls/Controls';
import type { PumpId } from '../components/controls/fault-form';
import { Badge, Eyebrow } from '../components/ui/panel';

export function AgentRoom({ events, workflows, incidents, example, mode }: {
  events: AgentEventInput[]; workflows: WorkflowRecord[]; incidents: Incident[];
  nowUnixMs: number; example: boolean; mode: 'mock' | 'live';
}) {
  return <section id="agent-room" className="agent-room" aria-labelledby="agent-room-heading">
    <div className="agent-room-head"><div className="panel-title"><Eyebrow>{example ? 'Example · scripted' : mode === 'mock' ? 'Mock · no live agent' : 'Live agents'}</Eyebrow><h2 id="agent-room-heading">Agent room</h2></div><Badge tone={example ? 'example' : mode === 'mock' ? 'mock' : 'neutral'}>{example ? 'EXAMPLE' : mode === 'mock' ? 'MOCK' : 'LIVE'}</Badge></div>
    <div className="agent-room-body"><Users size={28} aria-hidden="true"/><strong>{events.length} agent {events.length === 1 ? 'event' : 'events'}</strong><span>{workflows.length} {workflows.length === 1 ? 'workflow' : 'workflows'} · {incidents.length} {incidents.length === 1 ? 'incident' : 'incidents'}</span><span>Specialist seats and the handoff stream render here.</span></div>
  </section>;
}

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
