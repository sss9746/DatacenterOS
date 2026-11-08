import { useEffect, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import type { LocalFacilityConfig } from '../../data/local-physics';
import { Button } from '../ui/button';
import './facility-setup.css';

export function FacilitySetup({ config, onApply }: { config: LocalFacilityConfig; onApply: (next: LocalFacilityConfig) => void }) {
  const [draft, setDraft] = useState(config);
  useEffect(() => setDraft(config), [config]);
  const edit = (key: keyof LocalFacilityConfig, value: number) => setDraft((current) => ({ ...current, [key]: value }));
  const changed = Object.keys(config).some((key) => draft[key as keyof LocalFacilityConfig] !== config[key as keyof LocalFacilityConfig]);
  return <details className="facility-setup"><summary><SlidersHorizontal size={16} aria-hidden="true"/> Tune the demo facility <span>8 racks · 64 GPUs</span></summary><div className="facility-setup-body"><p>Adjust modeled cooling before a run. Applying changes starts a fresh local simulation with these inputs.</p><div className="facility-inputs"><label>Pump A cooling capacity <strong>{draft.pumpACapacityPct}%</strong><input type="range" min="40" max="140" step="5" value={draft.pumpACapacityPct} onChange={(event) => edit('pumpACapacityPct', Number(event.target.value))}/><small>Serves racks 2–4</small></label><label>Pump B cooling capacity <strong>{draft.pumpBCapacityPct}%</strong><input type="range" min="40" max="140" step="5" value={draft.pumpBCapacityPct} onChange={(event) => edit('pumpBCapacityPct', Number(event.target.value))}/><small>Serves racks 1 and 5–8</small></label><label>Rack 6 inlet offset <strong>{draft.rack6InletOffsetC} °C</strong><input type="range" min="0" max="20" step="1" value={draft.rack6InletOffsetC} onChange={(event) => edit('rack6InletOffsetC', Number(event.target.value))}/><small>Models the hot destination</small></label></div><div className="facility-setup-actions"><Button disabled={!changed} onClick={() => onApply(draft)}>Apply and restart simulation</Button><span>Rack count, GPU count, and job placement stay fixed in this preset.</span></div></div></details>;
}
