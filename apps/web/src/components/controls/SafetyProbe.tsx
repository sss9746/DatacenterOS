import { useId, useState, useSyncExternalStore } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { ActionStatus } from '@dcos/contracts';
import type { ActionDetail } from '@dcos/db-client';
import type { DashboardStore } from '../../data/dashboard';
import { errorMessage } from '../../data/dashboard';
import { asLocalPhysics } from '../../data/local-physics';
import { reasonText } from '../ledger/Ledger';
import { Button } from '../ui/button';
import { controlsMode, MODE_BADGE, type ControlsMode } from './mode';
import {
  buildR6Probe, powerEvidence, probeConflict, probeIds, probeVerdict, PROBE_JOB_ID, thermalEvidence, violationsOf,
} from './safety-probe';
import './controls.css';

export interface SafetyProbeProps {
  store: DashboardStore;
  /** Presenter/admin mode only; the probe is a write through the normal action API. */
  canAdmin: boolean;
}

const MODE_COPY: Record<ControlsMode, string> = {
  local: 'Local preview: the request runs P1’s real safety check in this browser. Nothing is shared and the local world never executes it.',
  fixture: 'Mock fixture preview: the request runs P1’s real safety check against the sample snapshot. Nothing is shared and the fixture never executes it.',
  live: 'Live presenter mode: the probe is a real request in the shared action ledger, visible to every viewer.',
  readonly: 'Read-only: the probe needs the presenter’s local admin token.',
};
const fmt = (value: number | null, unit: string) => (value === null ? '—' : `${value.toFixed(1)} ${unit}`);

export function SafetyProbe({ store, canAdmin }: SafetyProbeProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const mode = controlsMode(store.client.mode, Boolean(asLocalPhysics(store.client)), canAdmin);
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The probe result belongs to the store it was sent through; a reset opens a new store.
  const [sent, setSent] = useState<{ store: DashboardStore; commandKey: string; status: ActionStatus } | null>(null);

  const snapshot = state.snapshot;
  const conflict = snapshot ? probeConflict(snapshot, state.actions, state.actionDetails) : 'Waiting for the first cluster snapshot.';
  const blockedReason = !canAdmin ? 'Requires the presenter’s local admin mode.' : busy ? 'Submitting…' : conflict;
  const result = sent?.store === store ? sent : null;
  const detail = result ? state.actionDetails.find((row) => row.command.command_key === result.commandKey) : undefined;
  const status = detail?.status ?? result?.status;

  async function submit() {
    setBusy(true); setError(null);
    try {
      // Fresh snapshot right before the request: its decision epoch and versions go into the command.
      const fresh = await store.client.getObservedSnapshot();
      const overlap = probeConflict(fresh, store.state.actions, store.state.actionDetails);
      if (overlap) { setError(`Not submitted: ${overlap}`); return; }
      const build = buildR6Probe(fresh, probeIds(crypto.randomUUID()));
      if (!build.ok) { setError(`Not submitted: ${build.reason}`); return; }
      const returned = await store.client.requestAction(build.command);
      setSent({ store, commandKey: build.command.command_key, status: returned });
      await store.refresh();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  return <section className="presenter-controls presenter-probe-section" aria-labelledby={`${id}-title`}>
    <div className="presenter-controls-head">
      <div><h2 id={`${id}-title`}>Manual safety probe: move {PROBE_JOB_ID} onto hot rack r6</h2><p>{MODE_COPY[mode]}</p></div>
      <span className={`presenter-mode presenter-mode-${mode}`}>{MODE_BADGE[mode]}</span>
    </div>
    <div className="presenter-probe-body">
      <p className="presenter-note">Requests a <code>migrate_restart</code> of {PROBE_JOB_ID} (8 GPUs, checkpointed) onto r6’s eight GPUs, which job-c occupies and which run with a +12 °C inlet offset. It uses a fresh decision epoch and resource versions, a unique probe key and its own workflow. It is separate from the agent and never forces the planner’s choice.</p>
      <div className="presenter-actions presenter-probe-actions">
        <Button variant="secondary" disabled={Boolean(blockedReason)} aria-describedby={`${id}-why`} onClick={() => void submit()}><ShieldAlert size={15} aria-hidden="true"/>Submit safety probe</Button>
        <span id={`${id}-why`} className="presenter-note">{blockedReason ? `Unavailable: ${blockedReason}` : 'No overlapping action is in flight.'}</span>
      </div>
      {error && <p role="alert" className="presenter-message error-message">{error}</p>}
      {status && result && <ProbeResult commandKey={result.commandKey} status={status} detail={detail} mode={mode}/>}
    </div>
  </section>;
}

function ProbeResult({ commandKey, status, detail, mode }: { commandKey: string; status: ActionStatus; detail: ActionDetail | undefined; mode: ControlsMode }) {
  const verdict = probeVerdict(status);
  const safety = detail?.safety;
  const violations = violationsOf(status, safety);
  const thermal = thermalEvidence(safety);
  const power = powerEvidence(safety);
  const title = verdict === 'blocked' ? 'BLOCKED by the safety check'
    : verdict === 'accepted' ? `Accepted: the API did not block this move (status ${status.status.replaceAll('_', ' ')})`
      : verdict === 'failed' ? `Failed: ${status.reason_code ?? 'no reason code'}` : `Status ${status.status.replaceAll('_', ' ')}`;
  return <div className={`presenter-result presenter-result-${verdict}`} role="status">
    <p className="presenter-result-title"><strong>{title}</strong> <code>{commandKey}</code></p>
    {verdict === 'accepted' && <p className="presenter-note">{mode === 'live' ? 'It now sits in the shared ledger as a real request.' : mode === 'local' ? 'The local world records it but never executes actions.' : 'The fixture mock records it but never executes actions.'}</p>}
    {violations.length > 0 && <><h3>Violations</h3><ul className="presenter-violations">{violations.map((code) => <li key={code}>{reasonText(code)} <code>{code}</code></li>)}</ul></>}
    {safety ? <>
      <h3>Recorded safety evidence <span className="presenter-note">(decision {safety.decision}{safety.checked_decision_epoch === null ? '' : `, epoch ${safety.checked_decision_epoch}`})</span></h3>
      {thermal.length > 0 && <dl className="presenter-evidence">{thermal.map((row) => <div key={row.rackId}><dt>{row.rackId} thermal headroom</dt><dd>{fmt(row.availableC, '°C')} available vs {fmt(row.requiredC, '°C')} required · projected max GPU {fmt(row.projectedMaxC, '°C')} · inlet now {fmt(row.inletNowC, '°C')}</dd></div>)}</dl>}
      {power.length > 0 && <dl className="presenter-evidence">{power.map((row) => <div key={row.resourceId}><dt>{row.resourceId} extra power</dt><dd>{row.requiredW ?? '—'} W required vs {row.availableW ?? '—'} W headroom</dd></div>)}</dl>}
      {thermal.length === 0 && power.length === 0 && <p className="presenter-note">The check recorded no thermal or power projection{violations.some((code) => code.startsWith('STALE_')) ? ' because the snapshot was stale; submit again' : ''}.</p>}
    </> : <p className="presenter-note">{detail ? 'This client recorded no safety decision for the request.' : 'Waiting for the action detail and its recorded safety evidence…'}</p>}
  </div>;
}
