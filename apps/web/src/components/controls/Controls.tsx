import { useState } from 'react';
import type { DashboardStore } from '../../data/dashboard';
import { FaultControls, type FaultControlsProps } from './FaultControls';
import { SafetyProbe } from './SafetyProbe';
import type { PumpId } from './fault-form';

export { FaultControls, type FaultControlsProps } from './FaultControls';
export { SafetyProbe, type SafetyProbeProps } from './SafetyProbe';

/** Fault form plus the r6 safety probe; the probe renders only in presenter/admin mode. One component for every mode. */
export function PresenterControls(props: FaultControlsProps) {
  return <>
    <FaultControls {...props}/>
    {props.canAdmin && <SafetyProbe store={props.store} canAdmin={props.canAdmin}/>}
  </>;
}

/** Previous fixture/live entry point (no pump selection prop): keeps the pump choice locally. */
export function Controls({ store, canAdmin, selectedGpuId, onSelectGpu, onReset }: { store: DashboardStore; canAdmin: boolean; selectedGpuId: string; onSelectGpu: (id: string) => void; onReset: () => void }) {
  const [pump, setPump] = useState<PumpId>('pump-a');
  return <PresenterControls store={store} canAdmin={canAdmin} selectedGpuId={selectedGpuId} selectedPumpId={pump} onSelectGpu={onSelectGpu} onSelectPump={setPump} onReset={onReset}/>;
}
