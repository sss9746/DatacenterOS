import { useState } from 'react';
import { Fan, RotateCcw, Zap, SlidersHorizontal } from 'lucide-react';
import type { DashboardStore } from '../../data/dashboard';
import { errorMessage } from '../../data/dashboard';
import { Button } from '../ui/button';
import { Badge } from '../ui/panel';
export function Controls({ store, canAdmin, onReset }: { store: DashboardStore; canAdmin: boolean; onReset: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState(false);
  const [target, setTarget] = useState('gpu-r3-n1-0');
  const [confirmReset, setConfirmReset] = useState(false);
  async function inject(kind: 'cooling_pump_degradation' | 'gpu_xid_79' | 'gpu_xid_48') {
    setBusy(true); setMessage(null); setFailure(false);
    try {
      const snapshot = await store.client.getObservedSnapshot();
      await store.client.injectFault({ schema_version: '1.1.0', run_id: snapshot.run_id, fault_id: `judge-${crypto.randomUUID()}`, target_resource_id: kind === 'cooling_pump_degradation' ? 'pump-a' : target, kind, start_sim_time_ms: snapshot.clock.sim_time_ms, duration_sim_ms: null, severity: 1, parameters: {}, seed_offset: 0 });
      await store.refresh(); setMessage(`${kind === 'cooling_pump_degradation' ? 'Pump A fault' : `XID ${kind === 'gpu_xid_79' ? 79 : 48} on ${target}`} submitted${store.client.mode === 'mock' ? ' to the mock client' : ''}.`);
    } catch (error) { setFailure(true); setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }
  async function reset() {
    if (store.client.mode === 'mock') { onReset(); return; }
    setBusy(true); setFailure(false);
    try { await store.client.createRun('run-demo-1', 42, 'gpu_demo_8'); setConfirmReset(false); onReset(); }
    catch (error) { setFailure(true); setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <details className="judge-controls"><summary><SlidersHorizontal size={16}/><span>Judge controls</span><Badge>{store.client.mode === 'mock' ? 'Mock only' : canAdmin ? 'Local presenter' : 'Read-only'}</Badge></summary><div className="controls-body"><p>{store.client.mode === 'mock' ? 'These controls call the fixture-backed mock client. They do not run the physics engine or Nemotron.' : canAdmin ? 'Fault injections change the shared live demonstration through authorized admin reducers.' : 'Fault controls require an admin token on the presenter’s local development server.'}</p><fieldset disabled={!canAdmin || busy}><legend className="sr-only">Fault injection controls</legend><div className="fault-controls"><Button variant="secondary" onClick={() => void inject('cooling_pump_degradation')}><Fan size={15}/>Degrade pump A</Button><label>Target GPU<select value={target} onChange={(event) => setTarget(event.target.value)}>{store.state.snapshot?.gpus.filter((gpu) => gpu.resource_id !== 'gpu-real-0').map((gpu) => <option key={gpu.resource_id} value={gpu.resource_id}>{gpu.resource_id}</option>)}</select></label><Button variant="secondary" onClick={() => void inject('gpu_xid_79')}><Zap size={15}/>Inject XID 79</Button><Button variant="secondary" disabled={store.client.mode === 'mock'} title={store.client.mode === 'mock' ? 'XID 48 is not implemented by the current mock client' : undefined} onClick={() => void inject('gpu_xid_48')}>XID 48</Button><Button variant="ghost" onClick={() => setConfirmReset(true)}><RotateCcw size={14}/>Reset run</Button></div></fieldset>{confirmReset && <div className="reset-confirm"><p>Reset {store.client.mode === 'mock' ? 'this mock session' : 'run-demo-1 for every connected viewer'}?</p><Button variant="destructive" disabled={busy || !canAdmin} onClick={() => void reset()}>Confirm reset</Button><Button variant="ghost" onClick={() => setConfirmReset(false)}>Cancel</Button></div>}{message && <p role={failure ? 'alert' : 'status'} className={failure ? 'error-message' : 'control-message'}>{message}</p>}</div></details>;
}
