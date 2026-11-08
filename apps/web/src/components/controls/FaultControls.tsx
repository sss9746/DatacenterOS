import { useId, useState, useSyncExternalStore } from 'react';
import { Fan, FastForward, RotateCcw, Zap } from 'lucide-react';
import type { FaultInjection } from '@dcos/contracts';
import type { DashboardStore } from '../../data/dashboard';
import { errorMessage } from '../../data/dashboard';
import { asLocalPhysics } from '../../data/local-physics';
import { duration } from '../../lib/utils';
import { Button } from '../ui/button';
import {
  buildFaultInjection, DEFAULT_PUMP_LOSS, DELAY_PRESETS_S, effectivePumpCapacity, percent, PUMP_IDS, PUMP_LOSS_PRESETS,
  REAL_RESOURCE_IDS, scheduleState, type FaultDelayS, type PumpId, type PumpLoss,
} from './fault-form';

type FaultControlKind = 'pump_degradation' | 'gpu_xid_79';
import { controlsMode, MODE_BADGE, type ControlsMode } from './mode';
import './controls.css';

export interface FaultControlsProps {
  store: DashboardStore;
  /** Presenter/admin mode: true in mock previews, or live with the local admin token. */
  canAdmin: boolean;
  selectedGpuId: string;
  selectedPumpId: PumpId;
  onSelectGpu: (id: string) => void;
  onSelectPump: (id: PumpId) => void;
  /** Called after a reset is confirmed (and, live, after `createRun` succeeded). */
  onReset: () => void;
  /** Embedded under the Demo controls drawer, which owns "Advance 30 sim-s" and "Reset run": hide this form's copies. */
  hideRunActions?: boolean;
}

interface Submitted { fault: FaultInjection; submittedAtSimMs: number }

const MODE_COPY: Record<ControlsMode, string> = {
  local: 'Local preview: faults run through the P1 physics engine in this browser only. No agent or shared database is connected.',
  fixture: 'Mock fixture preview: the sample client shows a canned effect immediately. It does not model capacity loss, delay or pump-b.',
  live: 'Live presenter mode: these faults change the shared run for every connected viewer through the admin injectFault reducer.',
  readonly: 'Read-only: fault controls need the presenter’s local admin token. Cluster inspection stays available.',
};
const delayLabel = (delay: FaultDelayS) => (delay === 0 ? 'Next tick' : `${delay} sim-s`);
const describeFault = (fault: FaultInjection) => fault.kind === 'cooling_pump_degradation'
  ? `${fault.target_resource_id} loses ${percent(fault.severity)} capacity`
  : `${fault.target_resource_id} inaccessible (Xid 79)`;

export function FaultControls({ store, canAdmin, selectedGpuId, selectedPumpId, onSelectGpu, onSelectPump, onReset, hideRunActions = false }: FaultControlsProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const local = asLocalPhysics(store.client);
  const mode = controlsMode(store.client.mode, Boolean(local), canAdmin);
  const modeled = mode !== 'fixture';
  const id = useId();
  const [loss, setLoss] = useState<PumpLoss>(DEFAULT_PUMP_LOSS);
  const [pumpDelay, setPumpDelay] = useState<FaultDelayS>(0);
  const [gpuDelay, setGpuDelay] = useState<FaultDelayS>(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; failure: boolean } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  // Submitted faults belong to one store (a reset opens a new one), so a new run never shows old entries.
  const [log, setLog] = useState<{ store: DashboardStore; items: Submitted[] }>({ store, items: [] });

  const snapshot = state.snapshot;
  const simNow = snapshot?.clock.sim_time_ms ?? 0;
  const submitted = log.store === store ? log.items.filter((item) => item.fault.run_id === snapshot?.run_id && item.submittedAtSimMs <= simNow) : [];
  const gpus = (snapshot?.gpus ?? []).filter((gpu) => !REAL_RESOURCE_IDS.has(gpu.resource_id));
  const gpuId = gpus.some((gpu) => gpu.resource_id === selectedGpuId) ? selectedGpuId : gpus[0]?.resource_id ?? '';
  const capacity = effectivePumpCapacity(snapshot?.cooling.find((row) => row.resource_id === selectedPumpId), loss);
  const disabled = !canAdmin || busy || !snapshot;

  async function inject(kind: FaultControlKind) {
    setBusy(true); setMessage(null);
    try {
      // Fresh clock: the start time is relative to the sim time at submission, not to the last rendered frame.
      const fresh = await store.client.getObservedSnapshot();
      const fault = buildFaultInjection(kind === 'pump_degradation'
        ? { fault: kind, runId: fresh.run_id, simTimeMs: fresh.clock.sim_time_ms, faultId: `judge-${crypto.randomUUID()}`, targetId: selectedPumpId, severity: loss, delayS: pumpDelay, snapshot: fresh }
        : { fault: kind, runId: fresh.run_id, simTimeMs: fresh.clock.sim_time_ms, faultId: `judge-${crypto.randomUUID()}`, targetId: gpuId, delayS: gpuDelay, snapshot: fresh });
      await store.client.injectFault(fault);
      setLog((prev) => ({ store, items: [...(prev.store === store ? prev.items : []), { fault, submittedAtSimMs: fresh.clock.sim_time_ms }] }));
      const where = mode === 'live' ? 'the live run' : mode === 'local' ? 'this local simulation' : 'the fixture mock';
      const when = modeled ? ` Starts at sim ${duration(fault.start_sim_time_ms)}${fresh.clock.paused ? ' once the run resumes' : ''}.` : ' Shown immediately as a canned fixture effect.';
      setMessage({ text: `Accepted by ${where}: ${describeFault(fault)}.${when}`, failure: false });
      await store.refresh();
    } catch (error) { setMessage({ text: errorMessage(error), failure: true }); }
    finally { setBusy(false); }
  }

  async function advance() {
    if (!local) return;
    setBusy(true); setMessage(null);
    try { local.advance(30); await store.refresh(); setMessage({ text: 'Advanced the local physics simulation by 30 sim-seconds.', failure: false }); }
    catch (error) { setMessage({ text: errorMessage(error), failure: true }); }
    finally { setBusy(false); }
  }

  async function reset() {
    setBusy(true); setMessage(null);
    try {
      if (mode === 'live') await store.client.createRun('run-demo-1', 42, 'gpu_demo_8');
      setLog({ store, items: [] }); setConfirmReset(false); onReset();
    } catch (error) { setMessage({ text: errorMessage(error), failure: true }); }
    finally { setBusy(false); }
  }

  return <section className="presenter-controls" id="fault-controls" aria-labelledby={`${id}-title`}>
    <div className="presenter-controls-head">
      <div><h2 id={`${id}-title`}>Inject a fault</h2><p>{MODE_COPY[mode]}</p></div>
      <span className={`presenter-mode presenter-mode-${mode}`}>{MODE_BADGE[mode]}</span>
    </div>
    <div className="presenter-fault-grid">
      <fieldset className="presenter-fieldset" disabled={disabled}>
        <legend><Fan size={14} aria-hidden="true"/>Degrade pump</legend>
        <div className="presenter-fields">
          <label htmlFor={`${id}-pump`}>Pump<select id={`${id}-pump`} value={selectedPumpId} onChange={(event) => onSelectPump(event.target.value as PumpId)}>{PUMP_IDS.map((pump) => <option key={pump} value={pump}>{pump}</option>)}</select></label>
          <label htmlFor={`${id}-loss`}>Capacity loss<select id={`${id}-loss`} value={loss} onChange={(event) => setLoss(Number(event.target.value) as PumpLoss)}>{PUMP_LOSS_PRESETS.map((value) => <option key={value} value={value}>{percent(value)}</option>)}</select></label>
          <label htmlFor={`${id}-pump-delay`}>Start<select id={`${id}-pump-delay`} value={pumpDelay} onChange={(event) => setPumpDelay(Number(event.target.value) as FaultDelayS)}>{DELAY_PRESETS_S.map((value) => <option key={value} value={value}>{delayLabel(value)}</option>)}</select></label>
        </div>
        <p className="presenter-note" id={`${id}-pump-note`}>Persistent until reset. {modeled && capacity
          ? `${selectedPumpId} reports ${percent(capacity.now)} of nominal capacity now; losses multiply, so about ${percent(capacity.after)} would remain.`
          : 'Losses on one pump multiply: two 60% losses leave 16%, not less than zero.'}</p>
        <Button variant="secondary" aria-describedby={`${id}-pump-note`} onClick={() => void inject('pump_degradation')}><Fan size={15} aria-hidden="true"/>Degrade {selectedPumpId} by {percent(loss)}</Button>
      </fieldset>
      <fieldset className="presenter-fieldset" disabled={disabled}>
        <legend><Zap size={14} aria-hidden="true"/>GPU inaccessible (Xid 79)</legend>
        <div className="presenter-fields">
          <label htmlFor={`${id}-gpu`}>Simulated GPU<select id={`${id}-gpu`} value={gpuId} onChange={(event) => onSelectGpu(event.target.value)}>{gpus.map((gpu) => <option key={gpu.resource_id} value={gpu.resource_id}>{gpu.resource_id}</option>)}</select></label>
          <label htmlFor={`${id}-gpu-delay`}>Start<select id={`${id}-gpu-delay`} value={gpuDelay} onChange={(event) => setGpuDelay(Number(event.target.value) as FaultDelayS)}>{DELAY_PRESETS_S.map((value) => <option key={value} value={value}>{delayLabel(value)}</option>)}</select></label>
        </div>
        <p className="presenter-note" id={`${id}-gpu-note`}>The GPU becomes unreachable; a non-elastic job on it rolls back to its durable work. Severity 1, persistent.</p>
        <Button variant="secondary" aria-describedby={`${id}-gpu-note`} disabled={!gpuId} onClick={() => void inject('gpu_xid_79')}><Zap size={15} aria-hidden="true"/>Fail {gpuId || 'GPU'} (Xid 79)</Button>
      </fieldset>
    </div>
    {canAdmin && submitted.length > 0 && <div className="presenter-schedule">
      <h3>Submitted this session</h3>
      <ul>{submitted.map(({ fault }) => {
        const schedule = scheduleState(fault, simNow, modeled);
        return <li key={fault.fault_id}><span>{describeFault(fault)}</span><span className={`presenter-chip presenter-chip-${schedule}`}>{schedule === 'pending' ? `Accepted · pending until sim ${duration(fault.start_sim_time_ms)}` : schedule === 'start_reached' ? `Accepted · start time reached (sim ${duration(fault.start_sim_time_ms)})` : 'Accepted · fixture effect'}</span></li>;
      })}</ul>
    </div>}
    {!hideRunActions && <div className="presenter-actions">
      {local && <Button variant="secondary" disabled={disabled || Boolean(snapshot?.clock.paused)} onClick={() => void advance()}><FastForward size={15} aria-hidden="true"/>Advance 30 sim-s</Button>}
      <Button variant="ghost" disabled={!canAdmin || busy} aria-expanded={confirmReset} onClick={() => setConfirmReset(true)}><RotateCcw size={14} aria-hidden="true"/>Reset run</Button>
    </div>}
    {!hideRunActions && confirmReset && <div className="reset-confirm presenter-reset" role="group" aria-label="Confirm reset">
      <p>Reset {mode === 'live' ? 'run-demo-1 for every connected viewer' : 'this local preview'}?{mode === 'live' ? ' Stop the agent first.' : ''}</p>
      <Button variant="destructive" disabled={busy || !canAdmin} onClick={() => void reset()}>Confirm reset</Button>
      <Button variant="ghost" onClick={() => setConfirmReset(false)}>Cancel</Button>
    </div>}
    {message && <p role={message.failure ? 'alert' : 'status'} className={`presenter-message ${message.failure ? 'error-message' : 'control-message'}`}>{message.text}</p>}
  </section>;
}
