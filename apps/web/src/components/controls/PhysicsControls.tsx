import { useEffect, useState } from 'react';
import { FastForward, RotateCcw, Zap } from 'lucide-react';
import type { FaultInjection, ResourceSpec } from '@dcos/contracts';
import type { DashboardStore } from '../../data/dashboard';
import type { LocalPhysicsClient } from '../../data/local-physics';
import { Button } from '../ui/button';
import { errorMessage } from '../../data/dashboard';
import './physics-controls.css';

type Kind = FaultInjection['kind'];
const FAULTS: Array<{ kind: Kind; label: string; targetKinds: ResourceSpec['kind'][]; detail: string }> = [
  { kind: 'cooling_pump_degradation', label: 'Reduce pump cooling', targetKinds: ['cooling_pump'], detail: 'Racks on this loop warm gradually.' },
  { kind: 'cooling_pump_outage', label: 'Stop a pump', targetKinds: ['cooling_pump'], detail: 'The pump provides no cooling.' },
  { kind: 'gpu_thermal_load', label: 'Heat one GPU', targetKinds: ['gpu'], detail: 'Adds heat to one GPU.' },
  { kind: 'gpu_xid_79', label: 'GPU disappears (XID 79)', targetKinds: ['gpu'], detail: 'The GPU becomes unreachable and its job may lose work.' },
  { kind: 'gpu_xid_48', label: 'GPU memory error (XID 48)', targetKinds: ['gpu'], detail: 'The GPU becomes degraded.' },
  { kind: 'gpu_xid_74', label: 'GPU link error (XID 74)', targetKinds: ['gpu'], detail: 'The GPU becomes degraded.' },
  { kind: 'node_crash', label: 'Node or storage crash', targetKinds: ['node', 'checkpoint_store'], detail: 'A node loses its GPUs; a storage target blocks checkpoints.' },
  { kind: 'network_link_down', label: 'Link or storage connection down', targetKinds: ['network_link', 'checkpoint_store'], detail: 'A link emits an alarm; a storage target becomes inaccessible.' },
  { kind: 'sensor_stale', label: 'Stale sensor readings', targetKinds: ['gpu', 'rack', 'cooling_pump'], detail: 'Readings stop updating even as the world changes.' },
];

const isSimulated = (resource: ResourceSpec) => resource.resource_id !== 'gpu-real-0' && resource.resource_id !== 'node-real-0';

export function PhysicsControls({ store, client, selectedGpuId, selectedPumpId, onSelectGpu, onSelectPump, onReset }: {
  store: DashboardStore; client: LocalPhysicsClient; selectedGpuId: string; selectedPumpId: 'pump-a' | 'pump-b'; onSelectGpu: (id: string) => void; onSelectPump: (id: 'pump-a' | 'pump-b') => void; onReset: () => void;
}) {
  const [kind, setKind] = useState<Kind>('cooling_pump_degradation');
  const [chosenTarget, setChosenTarget] = useState('');
  const [severity, setSeverity] = useState(0.65);
  const [duration, setDuration] = useState<'60' | 'permanent'>('permanent');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState(false);
  useEffect(() => setChosenTarget(''), [selectedGpuId, selectedPumpId]);
  const snapshot = store.state.snapshot;
  const definition = FAULTS.find((entry) => entry.kind === kind)!;
  const targets = (snapshot?.resources ?? []).filter((resource) => isSimulated(resource) && definition.targetKinds.includes(resource.kind));
  const contextualTarget = definition.targetKinds.includes('cooling_pump') ? selectedPumpId : selectedGpuId;
  const target = targets.some((resource) => resource.resource_id === chosenTarget) ? chosenTarget
    : targets.some((resource) => resource.resource_id === contextualTarget) ? contextualTarget
      : targets[0]?.resource_id ?? '';

  async function inject() {
    if (!snapshot || !target) return;
    setBusy(true); setMessage(null); setFailure(false);
    try {
      await client.injectFault({
        schema_version: '1.1.0', run_id: snapshot.run_id, fault_id: `local-${crypto.randomUUID()}`,
        target_resource_id: target, kind, start_sim_time_ms: snapshot.clock.sim_time_ms,
        duration_sim_ms: duration === 'permanent' ? null : 60_000,
        severity: ['gpu_xid_79', 'gpu_xid_48', 'gpu_xid_74', 'node_crash', 'network_link_down'].includes(kind) ? 1 : severity,
        parameters: {}, seed_offset: 0,
      });
      if (!snapshot.clock.paused) client.advance(1);
      await store.refresh();
      setMessage(`${definition.label} applied to ${target} in this local simulation${snapshot.clock.paused ? ' when the run resumes' : ''}.`);
    } catch (reason) { setFailure(true); setMessage(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function advance() {
    setBusy(true); setMessage(null); setFailure(false);
    try { client.advance(30); await store.refresh(); setMessage('Advanced the P1 physics simulation by 30 seconds.'); }
    catch (reason) { setFailure(true); setMessage(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  return <section className="physics-controls" id="fault-controls" aria-labelledby="physics-controls-title">
    <div className="physics-controls-head"><div><h2 id="physics-controls-title">Run a fault</h2><p>Choose a modeled problem and watch the same P1 physics engine advance the cluster.</p></div><span>Local simulation</span></div>
    <div className="physics-controls-grid"><label>Problem<select value={kind} onChange={(event) => { setKind(event.target.value as Kind); setChosenTarget(''); }} disabled={busy}>{FAULTS.map((entry) => <option value={entry.kind} key={entry.kind}>{entry.label}</option>)}</select></label><label>Component<select value={target} onChange={(event) => { const id = event.target.value; setChosenTarget(id); if (id.startsWith('gpu-r')) onSelectGpu(id); if (id === 'pump-a' || id === 'pump-b') onSelectPump(id); }} disabled={busy}>{targets.map((resource) => <option value={resource.resource_id} key={resource.resource_id}>{resource.resource_id}</option>)}</select></label><label>Severity <span className="physics-severity-value">{Math.round(severity * 100)}%</span><input type="range" min="0.1" max="1" step="0.05" value={severity} onChange={(event) => setSeverity(Number(event.target.value))} disabled={busy || !['cooling_pump_degradation', 'gpu_thermal_load', 'sensor_stale'].includes(kind)}/></label><label>Duration<select value={duration} onChange={(event) => setDuration(event.target.value as '60' | 'permanent')} disabled={busy}><option value="permanent">Until reset</option><option value="60">60 sim seconds</option></select></label></div>
    <p className="physics-fault-detail">{definition.detail} Hardware failures can remain latched after a timed fault ends.</p>
    <div className="physics-controls-actions"><Button disabled={busy || !target} onClick={() => void inject()}><Zap size={15}/>Inject fault</Button><Button variant="secondary" disabled={busy || Boolean(snapshot?.clock.paused)} onClick={() => void advance()}><FastForward size={15}/>Advance 30 seconds</Button><Button variant="ghost" disabled={busy} onClick={onReset}><RotateCcw size={14}/>Reset simulation</Button></div>
    {message && <p role={failure ? 'alert' : 'status'} className={failure ? 'error-message' : 'control-message'}>{message}</p>}
    <p className="physics-controls-note">Runs in this browser with simulated values. Agent actions, durable database recovery, and custom facility layouts are not connected here.</p>
  </section>;
}
