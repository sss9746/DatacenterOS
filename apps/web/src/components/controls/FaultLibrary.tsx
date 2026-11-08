import { useId, useState, useSyncExternalStore } from 'react';
import { Fan, Server, HardDrive, Radio, Zap } from 'lucide-react';
import type { FaultInjection } from '@dcos/contracts';
import type { DashboardStore } from '../../data/dashboard';
import { errorMessage } from '../../data/dashboard';
import { asLocalPhysics } from '../../data/local-physics';
import { duration } from '../../lib/utils';
import { Button } from '../ui/button';
import {
  buildFaultInjection, CHECKPOINT_STORE_ID, DELAY_PRESETS_S, describeFault, DURATION_PRESETS_S, effectivePumpCapacity, FAULT_CATALOG, FAULT_GROUPS,
  nodeOfGpu, percent, scheduleState, targetOptions, targetProblem, type FaultCatalogEntry, type FaultCatalogId, type FaultDelayS, type FaultDurationS,
  type FaultGroup, type PumpId, type TargetType,
} from './fault-form';
import { controlsMode, type ControlsMode } from './mode';
import './controls.css';

export interface FaultLibraryProps {
  store: DashboardStore;
  /** Presenter/admin mode: true in mock previews, or live with the local admin token. Never weakened here. */
  canAdmin: boolean;
  selectedGpuId: string;
  selectedPumpId: PumpId;
  onSelectGpu: (id: string) => void;
  onSelectPump: (id: PumpId) => void;
  /** Overrides the GPU-target default (the demo's Xid target); the selected GPU is used otherwise. */
  defaultGpuId?: string;
}

interface Submitted { fault: FaultInjection; submittedAtSimMs: number }
interface RowChoice { severity?: number; delayS: FaultDelayS; durationS: FaultDurationS }

const GROUP_ICON: Record<FaultGroup, typeof Fan> = { cooling: Fan, gpu: Zap, node: Server, storage: HardDrive, telemetry: Radio };
const MODE_COPY: Record<ControlsMode, string> = {
  local: 'Every fault below runs through the P1 physics engine in this browser. Agents never see this schedule.',
  fixture: 'Fixture mock: only pump-a degradation and the Xids have canned effects; the rest are disabled here.',
  live: 'Live presenter mode: faults change the shared run for every viewer through the admin injectFault reducer. Agents never see this schedule.',
  readonly: 'Read-only: fault injection needs the presenter’s local admin token.',
};
const delayLabel = (delay: FaultDelayS) => (delay === 0 ? 'Next tick' : `+${delay} sim-s`);
const durationLabel = (value: FaultDurationS) => (value === null ? 'Persistent' : `${value} sim-s`);

/** Grouped catalog of every engine-supported fault, one shared target picker per group, presenter-only schedule list. */
export function FaultLibrary({ store, canAdmin, selectedGpuId, selectedPumpId, onSelectGpu, onSelectPump, defaultGpuId }: FaultLibraryProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const local = asLocalPhysics(store.client);
  const mode = controlsMode(store.client.mode, Boolean(local), canAdmin);
  const modeled = mode !== 'fixture';
  const id = useId();
  const [choices, setChoices] = useState<Partial<Record<FaultCatalogId, RowChoice>>>({});
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [linkId, setLinkId] = useState<string | null>(null);
  const [busy, setBusy] = useState<FaultCatalogId | null>(null);
  const [message, setMessage] = useState<{ text: string; failure: boolean } | null>(null);
  // Submitted faults belong to one store (a reset opens a new one), so a new run never shows old entries.
  const [log, setLog] = useState<{ store: DashboardStore; items: Submitted[] }>({ store, items: [] });

  const snapshot = state.snapshot;
  const simNow = snapshot?.clock.sim_time_ms ?? 0;
  const submitted = log.store === store ? log.items.filter((item) => item.fault.run_id === snapshot?.run_id && item.submittedAtSimMs <= simNow) : [];

  const options: Record<TargetType, ReturnType<typeof targetOptions>> = {
    pump: targetOptions('pump', snapshot), gpu: targetOptions('gpu', snapshot), node: targetOptions('node', snapshot),
    checkpoint_store: targetOptions('checkpoint_store', snapshot), network_link: targetOptions('network_link', snapshot),
  };
  const gpuId = options.gpu.some((o) => o.id === (defaultGpuId ?? selectedGpuId)) ? (defaultGpuId ?? selectedGpuId) : options.gpu.some((o) => o.id === selectedGpuId) ? selectedGpuId : options.gpu[0]?.id ?? '';
  const defaultNode = nodeOfGpu(gpuId, snapshot) ?? options.node[0]?.id ?? '';
  const node = nodeId && options.node.some((o) => o.id === nodeId) ? nodeId : defaultNode;
  const link = linkId && options.network_link.some((o) => o.id === linkId) ? linkId : options.network_link[0]?.id ?? '';
  const storeId = options.checkpoint_store[0]?.id ?? CHECKPOINT_STORE_ID;
  const targetOf: Record<TargetType, string> = { pump: selectedPumpId, gpu: gpuId, node, checkpoint_store: storeId, network_link: link };

  const choice = (entry: FaultCatalogEntry): RowChoice => choices[entry.id] ?? { severity: entry.severity?.default, delayS: 0, durationS: null };
  const setChoice = (entryId: FaultCatalogId, patch: Partial<RowChoice>) => setChoices((prev) => ({ ...prev, [entryId]: { ...(prev[entryId] ?? { delayS: 0, durationS: null }), ...patch } }));

  /** Why this row cannot inject right now, or null. Unsupported combinations are disabled with the reason, never sent. */
  const rowProblem = (entry: FaultCatalogEntry): string | null => {
    if (!canAdmin) return 'Read-only without the presenter token';
    if (!snapshot) return 'Waiting for a snapshot';
    if (busy) return 'Working…';
    if (!modeled && !entry.fixtureEffect) return 'No canned fixture effect; use the local physics preview';
    const target = targetOf[entry.target];
    const picked = options[entry.target].find((o) => o.id === target);
    if (picked?.disabledReason) return `${target} ${picked.disabledReason}`;
    return targetProblem(entry, target, snapshot);
  };

  async function inject(entry: FaultCatalogEntry) {
    setBusy(entry.id); setMessage(null);
    try {
      // Fresh clock: the start time is relative to the sim time at submission, not to the last rendered frame.
      const fresh = await store.client.getObservedSnapshot();
      const picked = choice(entry);
      const fault = buildFaultInjection({ fault: entry.id, runId: fresh.run_id, simTimeMs: fresh.clock.sim_time_ms, faultId: `judge-${crypto.randomUUID()}`, targetId: targetOf[entry.target], delayS: picked.delayS, severity: picked.severity, durationS: entry.expires ? picked.durationS : null, snapshot: fresh });
      await store.client.injectFault(fault);
      setLog((prev) => ({ store, items: [...(prev.store === store ? prev.items : []), { fault, submittedAtSimMs: fresh.clock.sim_time_ms }] }));
      const where = mode === 'live' ? 'the live run' : mode === 'local' ? 'this local simulation' : 'the fixture mock';
      const ends = fault.duration_sim_ms === null ? 'persistent' : `ends at sim ${duration(fault.start_sim_time_ms + fault.duration_sim_ms)}`;
      const when = modeled ? ` Starts at sim ${duration(fault.start_sim_time_ms)}${fresh.clock.paused ? ' once the run resumes' : ''}, ${ends}.` : ' Shown immediately as a canned fixture effect.';
      setMessage({ text: `Accepted by ${where}: ${describeFault(fault)}.${when}`, failure: false });
      await store.refresh();
    } catch (error) { setMessage({ text: errorMessage(error), failure: true }); }
    finally { setBusy(null); }
  }

  const pumpRow = snapshot?.cooling.find((row) => row.resource_id === selectedPumpId);

  const picker = (group: FaultGroup) => {
    switch (group) {
      case 'cooling': return <label htmlFor={`${id}-pump`}>Pump<select id={`${id}-pump`} value={selectedPumpId} onChange={(event) => onSelectPump(event.target.value as PumpId)}>{(options.pump.length ? options.pump : [{ id: 'pump-a', label: 'pump-a', disabledReason: null }, { id: 'pump-b', label: 'pump-b', disabledReason: null }]).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>;
      case 'gpu': return <label htmlFor={`${id}-gpu`}>Simulated GPU<select id={`${id}-gpu`} value={gpuId} onChange={(event) => onSelectGpu(event.target.value)}>{options.gpu.map((o) => <option key={o.id} value={o.id}>{o.label}{o.disabledReason ? ` · ${o.disabledReason}` : ''}</option>)}</select></label>;
      case 'node': return <label htmlFor={`${id}-node`}>Node<select id={`${id}-node`} value={node} onChange={(event) => setNodeId(event.target.value)}>{options.node.map((o) => <option key={o.id} value={o.id}>{o.label}{o.disabledReason ? ` · ${o.disabledReason}` : ''}</option>)}</select><small>defaults to the node of {gpuId || 'the selected GPU'}</small></label>;
      case 'storage': return <p className="fault-fixed-target">Target <code>{storeId}</code><small>the run’s only checkpoint store</small></p>;
      case 'telemetry': return <>
        <p className="fault-fixed-target">Stale readings target <code>{gpuId || '—'}</code><small>the GPU picked under GPU errors</small></p>
        {options.network_link.length > 0 && <label htmlFor={`${id}-link`}>Rack link<select id={`${id}-link`} value={link} onChange={(event) => setLinkId(event.target.value)}>{options.network_link.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>}
      </>;
    }
  };

  return <section className="fault-library" aria-labelledby={`${id}-title`}>
    <div className="fault-library-head"><h2 id={`${id}-title`}>Fault library</h2><p>{MODE_COPY[mode]}</p></div>
    {FAULT_GROUPS.map((group) => {
      const Icon = GROUP_ICON[group.id];
      const entries = FAULT_CATALOG.filter((entry) => entry.group === group.id);
      return <section key={group.id} className="fault-group" aria-labelledby={`${id}-${group.id}`}>
        <div className="fault-group-head">
          <h3 id={`${id}-${group.id}`}><Icon size={14} aria-hidden="true"/>{group.name}</h3>
          <div className="fault-group-target">{picker(group.id)}</div>
        </div>
        <ul className="fault-rows">{entries.map((entry) => {
          const picked = choice(entry);
          const problem = rowProblem(entry);
          const target = targetOf[entry.target];
          const capacity = entry.id === 'pump_degradation' && modeled ? effectivePumpCapacity(pumpRow, picked.severity ?? 0) : null;
          return <li key={entry.id} className={`fault-row ${problem && problem !== 'Working…' ? 'is-disabled' : ''}`} data-fault={entry.id}>
            <div className="fault-row-text">
              <strong>{entry.name}</strong>
              <span className="fault-row-what">{entry.what}</span>
              <span className="fault-row-effect" id={`${id}-${entry.id}-effect`}>{entry.effect}{entry.note ? <em> {entry.note}</em> : null}{capacity ? ` ${selectedPumpId} reports ${percent(capacity.now)} of nominal now; about ${percent(capacity.after)} would remain.` : ''}</span>
              {problem && problem !== 'Working…' && <span className="fault-row-problem" role="note">Unavailable: {problem}</span>}
            </div>
            <div className="fault-row-controls">
              {entry.severity && <label>{entry.severity.label}<select aria-label={`${entry.name}: ${entry.severity.label}`} value={picked.severity ?? entry.severity.default} onChange={(event) => setChoice(entry.id, { severity: Number(event.target.value) })}>{entry.severity.presets.map((value) => <option key={value} value={value}>{entry.severity!.format(value)}</option>)}</select></label>}
              <label>Start<select aria-label={`${entry.name}: start`} value={picked.delayS} onChange={(event) => setChoice(entry.id, { delayS: Number(event.target.value) as FaultDelayS })}>{DELAY_PRESETS_S.map((value) => <option key={value} value={value}>{delayLabel(value)}</option>)}</select></label>
              <label>Duration<select aria-label={`${entry.name}: duration`} value={picked.durationS ?? ''} disabled={!entry.expires} title={entry.expires ? undefined : 'Persistent: expiry would not repair hardware'} onChange={(event) => setChoice(entry.id, { durationS: event.target.value === '' ? null : Number(event.target.value) as FaultDurationS })}>{(entry.expires ? DURATION_PRESETS_S : [null]).map((value) => <option key={String(value)} value={value ?? ''}>{durationLabel(value)}</option>)}</select></label>
              <Button variant="secondary" size="sm" disabled={Boolean(problem)} aria-describedby={`${id}-${entry.id}-effect`} onClick={() => void inject(entry)}>{busy === entry.id ? 'Working…' : entry.button(target || TARGET_LABEL_FALLBACK[entry.target], picked.severity ?? null)}</Button>
            </div>
          </li>;
        })}</ul>
      </section>;
    })}
    {canAdmin && submitted.length > 0 && <div className="presenter-schedule" aria-label="Faults submitted this session (presenter view; agents never see this)">
      <h3>Submitted this session <small>presenter-only · agents never see this schedule</small></h3>
      <ul>{submitted.map(({ fault }) => {
        const schedule = scheduleState(fault, simNow, modeled);
        const end = fault.duration_sim_ms === null ? null : fault.start_sim_time_ms + fault.duration_sim_ms;
        const text = schedule === 'pending' ? `Accepted · pending until sim ${duration(fault.start_sim_time_ms)}`
          : schedule === 'start_reached' ? `Active since sim ${duration(fault.start_sim_time_ms)}${end !== null ? ` · ends ${duration(end)}` : ' · persistent'}`
          : schedule === 'ended' ? `Ended at sim ${duration(end!)}` : 'Accepted · fixture effect';
        return <li key={fault.fault_id}><span>{describeFault(fault)}</span><span className={`presenter-chip presenter-chip-${schedule}`}>{text}</span></li>;
      })}</ul>
    </div>}
    {message && <p role={message.failure ? 'alert' : 'status'} className={`presenter-message ${message.failure ? 'error-message' : 'control-message'}`}>{message.text}</p>}
  </section>;
}

const TARGET_LABEL_FALLBACK: Record<TargetType, string> = { pump: 'pump', gpu: 'GPU', node: 'node', checkpoint_store: CHECKPOINT_STORE_ID, network_link: 'link' };
