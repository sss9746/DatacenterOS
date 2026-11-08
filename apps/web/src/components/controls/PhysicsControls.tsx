import type { DashboardStore } from '../../data/dashboard';
import type { LocalPhysicsClient } from '../../data/local-physics';
import { PresenterControls } from './Controls';
import type { PumpId } from './fault-form';

/**
 * Previous browser-local entry point. The unified PresenterControls detects the local physics client from
 * `store.client` itself (and adds "Advance 30 sim-s"); `client` is kept only so existing call sites compile.
 * Local physics is a mock preview, so presenter mode is always on.
 */
export function PhysicsControls({ store, selectedGpuId, selectedPumpId, onSelectGpu, onSelectPump, onReset }: {
  store: DashboardStore; client: LocalPhysicsClient; selectedGpuId: string; selectedPumpId: PumpId; onSelectGpu: (id: string) => void; onSelectPump: (id: PumpId) => void; onReset: () => void;
}) {
  return <PresenterControls store={store} canAdmin selectedGpuId={selectedGpuId} selectedPumpId={selectedPumpId} onSelectGpu={onSelectGpu} onSelectPump={onSelectPump} onReset={onReset}/>;
}
