import { useId, useState, useSyncExternalStore, type ReactNode, type SyntheticEvent } from 'react';
import { FastForward, Route, SlidersHorizontal } from 'lucide-react';
import type { ActionStatus, ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail, PlanRecord, WorkflowRecord } from '@dcos/db-client';
import type { DashboardStore } from '../../data/dashboard';
import { errorMessage } from '../../data/dashboard';
import { asLocalPhysics } from '../../data/local-physics';
import { duration } from '../../lib/utils';
import { reasonText } from '../ledger/action-view';
import { Button } from '../ui/button';
import { FaultControls } from './FaultControls';
import { SafetyProbe } from './SafetyProbe';
import { buildFaultInjection, DEFAULT_PUMP_LOSS, percent, type PumpId } from './fault-form';
import { controlsMode, MODE_BADGE, type ControlsMode } from './mode';
import { buildR6Probe, probeConflict, probeIds, probeVerdict, PROBE_JOB_ID, violationsOf } from './safety-probe';
import { defaultXidTarget, XID_SOURCE_LABEL } from './xid-target';
import './controls.css';

export interface DemoControlsProps {
  store: DashboardStore;
  /** Presenter/admin mode: true in mock previews, or live with the local admin token. Never weakened here. */
  canAdmin: boolean;
  /** Drawer open state (`?presenter=1` starts it open; the top bar toggles it). */
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  selectedGpuId: string;
  selectedPumpId: PumpId;
  onSelectGpu: (id: string) => void;
  onSelectPump: (id: PumpId) => void;
  /** Called after a confirmed reset (live: after `createRun` succeeded). */
  onReset: () => void;
  plans: PlanRecord[];
  actionDetails: ActionDetail[];
  workflows: WorkflowRecord[];
  snapshot: ObservedSnapshot;
}

type Step = 'pump' | 'probe' | 'xid' | 'reset' | 'advance' | 'recover';
interface Note { text: string; failure: boolean }

const MODE_HINT: Record<ControlsMode, string> = {
  local: 'Local physics in this browser · four steps, in order',
  fixture: 'Fixture mock · canned effects, shown immediately',
  live: 'Live shared run · every viewer sees these',
  readonly: 'Read-only without the presenter token',
};
const READONLY_REASON = 'Read-only without the presenter token';

/** Bottom drawer with the four scripted demo steps; the full fault form and safety probe sit under Advanced. */
export function DemoControls({ store, canAdmin, open, onOpenChange, selectedGpuId, selectedPumpId, onSelectGpu, onSelectPump, onReset, plans, actionDetails, workflows, snapshot }: DemoControlsProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const local = asLocalPhysics(store.client);
  const mode = controlsMode(store.client.mode, Boolean(local), canAdmin);
  const id = useId();
  const [busy, setBusy] = useState<Step | null>(null);
  const [notes, setNotes] = useState<Partial<Record<Step, Note>>>({});
  const [confirmReset, setConfirmReset] = useState(false);
  // The probe result belongs to the store it was sent through; a reset opens a new store.
  const [probe, setProbe] = useState<{ store: DashboardStore; commandKey: string; status: ActionStatus } | null>(null);

  const live = state.snapshot ?? snapshot;
  const target = defaultXidTarget({ plans, workflows, actionDetails, selectedGpuId, snapshot: live });
  const where = mode === 'live' ? 'the live run' : mode === 'local' ? 'this local simulation' : 'the fixture mock';
  const disabledReason = !canAdmin ? READONLY_REASON : busy ? 'Working…' : null;
  const probeResult = probe?.store === store ? probe : null;
  const probeDetail = probeResult ? state.actionDetails.find((row) => row.command.command_key === probeResult.commandKey) : undefined;
  const probeStatus = probeDetail?.status ?? probeResult?.status;
  const probeConflictNow = canAdmin && live ? probeConflict(live, state.actions, state.actionDetails) : null;

  const note = (step: Step, text: string, failure = false) => setNotes((prev) => ({ ...prev, [step]: { text, failure } }));
  async function run(step: Step, work: () => Promise<string>) {
    setBusy(step); setNotes((prev) => ({ ...prev, [step]: undefined }));
    try { note(step, await work()); await store.refresh(); }
    catch (error) { note(step, errorMessage(error), true); }
    finally { setBusy(null); }
  }

  const breakPump = () => run('pump', async () => {
    onSelectPump('pump-a');
    const fresh = await store.client.getObservedSnapshot();
    const fault = buildFaultInjection({ kind: 'cooling_pump_degradation', runId: fresh.run_id, simTimeMs: fresh.clock.sim_time_ms, faultId: `judge-${crypto.randomUUID()}`, targetId: 'pump-a', capacityLoss: DEFAULT_PUMP_LOSS, delayS: 0 });
    await store.client.injectFault(fault);
    return mode === 'fixture'
      ? `Accepted by ${where}: pump-a loses ${percent(DEFAULT_PUMP_LOSS)} capacity, shown as a canned fixture effect.`
      : `Accepted by ${where}: pump-a loses ${percent(DEFAULT_PUMP_LOSS)} capacity from sim ${duration(fault.start_sim_time_ms)}${fresh.clock.paused ? ' once the run resumes' : ''}. Racks 2–4 heat over the next sim-minutes.`;
  });

  const tryUnsafeMove = () => run('probe', async () => {
    const fresh = await store.client.getObservedSnapshot();
    const overlap = probeConflict(fresh, store.state.actions, store.state.actionDetails);
    if (overlap) throw new Error(`Not submitted: ${overlap}`);
    const build = buildR6Probe(fresh, probeIds(crypto.randomUUID()));
    if (!build.ok) throw new Error(`Not submitted: ${build.reason}`);
    const returned = await store.client.requestAction(build.command);
    setProbe({ store, commandKey: build.command.command_key, status: returned });
    return `Submitted a migrate_restart of ${PROBE_JOB_ID} onto rack r6 through the normal action API; the verdict above is the safety check's own.`;
  });

  const failGpu = () => run('xid', async () => {
    const fresh = await store.client.getObservedSnapshot();
    const fault = buildFaultInjection({ kind: 'gpu_xid_79', runId: fresh.run_id, simTimeMs: fresh.clock.sim_time_ms, faultId: `judge-${crypto.randomUUID()}`, targetId: target.gpuId, delayS: 0 });
    await store.client.injectFault(fault);
    return mode === 'fixture'
      ? `Accepted by ${where}: ${target.gpuId} inaccessible (Xid 79), shown as a canned fixture effect.`
      : `Accepted by ${where}: ${target.gpuId} inaccessible (Xid 79) from sim ${duration(fault.start_sim_time_ms)}${fresh.clock.paused ? ' once the run resumes' : ''}.`;
  });

  const advance = () => run('advance', async () => {
    if (!local) throw new Error('Advance is only available in the local physics simulation.');
    local.advance(30);
    return 'Advanced the local physics simulation by 30 sim-seconds.';
  });

  const runRecovery = () => run('recover', async () => {
    if (!local) throw new Error('The recovery preview is only available in the local physics simulation.');
    await local.runRecoveryPreview();
    return 'In-browser preview · deterministic thresholdPolicy from @dcos/physics · not Nemotron, not the live agent. Press Advance: a checkpoint takes 30 sim-s, a restart on new GPUs 120 sim-s, both executed by the real physics step.';
  });

  const reset = () => run('reset', async () => {
    if (mode === 'live') await store.client.createRun('run-demo-1', 42, 'gpu_demo_8');
    setConfirmReset(false); setProbe(null); onReset();
    return mode === 'live' ? 'run-demo-1 recreated for every connected viewer.' : 'Local preview reset to its initial state.';
  });

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => { const next = event.currentTarget.open; if (next !== open) onOpenChange?.(next); };

  return <details id="presenter" className={`demo-controls demo-controls-${mode}`} open={open} onToggle={onToggle}>
    <summary className="demo-controls-summary">
      <SlidersHorizontal size={16} aria-hidden="true"/>
      <span className="demo-controls-title">Demo controls</span>
      <small className="demo-controls-hint">{MODE_HINT[mode]}</small>
      <span className={`presenter-mode presenter-mode-${mode}`}>{MODE_BADGE[mode]}</span>
    </summary>
    <div className="demo-controls-body">
      <ol className="demo-steps" aria-label="Demo steps">
        <StepButton n={1} id={`${id}-pump`} title="Break cooling pump A" why={`Pump A loses ${percent(DEFAULT_PUMP_LOSS)} of its cooling next tick; the racks it cools start heating`} disabledReason={disabledReason} busy={busy === 'pump'} onClick={breakPump} note={notes.pump}/>
        <StepButton n={2} id={`${id}-probe`} title="Try unsafe move to hot rack 6" why="Asks to move a training job onto the hottest rack; the safety check answers" disabledReason={disabledReason ?? probeConflictNow} busy={busy === 'probe'} onClick={tryUnsafeMove} note={notes.probe}>
          {probeStatus && probeResult && <ProbeInline status={probeStatus} detail={probeDetail} commandKey={probeResult.commandKey} mode={mode}/>}
        </StepButton>
        <StepButton n={3} id={`${id}-xid`} title="Fail a GPU (XID 79)" why="The target GPU goes dark; its job falls back to its last checkpoint" disabledReason={disabledReason} busy={busy === 'xid'} onClick={failGpu} note={notes.xid}>
          <p className="demo-target">Target: <code>{target.gpuId}</code> · {XID_SOURCE_LABEL[target.source]}{target.source === 'plan' && target.planId ? <> <code>{target.planId}</code></> : null}</p>
        </StepButton>
        <StepButton n={4} id={`${id}-reset`} title="Reset run" why={mode === 'live' ? 'Restarts the shared run for every viewer; stop the agent first' : 'Puts the preview back to the start'} disabledReason={disabledReason} busy={busy === 'reset'} ariaExpanded={confirmReset} onClick={() => setConfirmReset(true)} note={notes.reset}>
          {confirmReset && <div className="demo-confirm" role="group" aria-label="Confirm reset">
            <p>Reset {mode === 'live' ? 'run-demo-1 for every connected viewer' : 'this preview'}?</p>
            <Button variant="destructive" size="sm" disabled={Boolean(disabledReason)} onClick={() => void reset()}>Confirm reset</Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>Cancel</Button>
          </div>}
        </StepButton>
      </ol>
      <div className="demo-foot">
        {local && <Button variant="secondary" size="sm" disabled={Boolean(disabledReason) || Boolean(live?.clock.paused)} onClick={() => void advance()}><FastForward size={14} aria-hidden="true"/>Advance 30 sim-s</Button>}
        {local && <Button variant="secondary" size="sm" disabled={Boolean(disabledReason) || Boolean(live?.clock.paused)} onClick={() => void runRecovery()} title="Runs @dcos/physics' deterministic thresholdPolicy in this browser and executes it through the local ledger + physics. Not the live agent, not Nemotron."><Route size={14} aria-hidden="true"/>Run recovery (in-browser planner)</Button>}
        {notes.advance && <p role={notes.advance.failure ? 'alert' : 'status'} className={`demo-note ${notes.advance.failure ? 'demo-note-error' : ''}`}>{notes.advance.text}</p>}
        {notes.recover && <p role={notes.recover.failure ? 'alert' : 'status'} className={`demo-note ${notes.recover.failure ? 'demo-note-error' : ''}`}>{notes.recover.text}</p>}
        {local && local.recoveryPreview.log.length > 0 && <ol className="demo-recovery-log" aria-label="Recovery preview log (in-browser deterministic planner, not Nemotron)">
          <li className="demo-recovery-log-head">Recovery preview · in-browser · deterministic · not Nemotron</li>
          {local.recoveryPreview.log.slice(-6).map((line, i) => <li key={`${i}-${line}`} className={/BLOCKED|FAILED|error/.test(line) ? 'is-blocked' : ''}>{line}</li>)}
        </ol>}
        <p className="demo-process-note">Killing the agent process is done from the presenter terminal; the browser never gets process control.</p>
      </div>
      <details className="demo-advanced">
        <summary>Advanced<small>full fault form · pump-b · delays · any simulated GPU · the probe's recorded evidence</small></summary>
        <div className="demo-advanced-body">
          <FaultControls store={store} canAdmin={canAdmin} selectedGpuId={selectedGpuId} selectedPumpId={selectedPumpId} onSelectGpu={onSelectGpu} onSelectPump={onSelectPump} onReset={onReset} hideRunActions/>
          {canAdmin && <SafetyProbe store={store} canAdmin={canAdmin}/>}
        </div>
      </details>
    </div>
  </details>;
}

function StepButton({ n, id, title, why, disabledReason, busy, onClick, note, ariaExpanded, children }: {
  n: number; id: string; title: string; why: string; disabledReason: string | null; busy: boolean; onClick: () => void; note: Note | undefined; ariaExpanded?: boolean; children?: ReactNode;
}) {
  const disabled = Boolean(disabledReason);
  return <li className="demo-step">
    <button type="button" className={`demo-step-button ${busy ? 'is-busy' : ''}`} disabled={disabled} aria-labelledby={`${id}-title`} aria-describedby={`${id}-why`} aria-expanded={ariaExpanded} onClick={onClick}>
      <span className="demo-step-num" aria-hidden="true">{n}</span>
      <span className="demo-step-text">
        <strong id={`${id}-title`}>{title}</strong>
        <span id={`${id}-why`} className="demo-step-why">{disabledReason && disabledReason !== 'Working…' ? `Unavailable: ${disabledReason}` : busy ? 'Working…' : why}</span>
      </span>
    </button>
    {children}
    {note && <p role={note.failure ? 'alert' : 'status'} className={`demo-note ${note.failure ? 'demo-note-error' : ''}`}>{note.text}</p>}
  </li>;
}

/** The safety check's answer, straight from the ledger: status pill + the recorded violation codes. No recomputation. */
function ProbeInline({ status, detail, commandKey, mode }: { status: ActionStatus; detail: ActionDetail | undefined; commandKey: string; mode: ControlsMode }) {
  const verdict = probeVerdict(status);
  const violations = violationsOf(status, detail?.safety);
  const label = verdict === 'blocked' ? 'BLOCKED' : verdict === 'accepted' ? `Not blocked · ${status.status.replaceAll('_', ' ')}` : verdict === 'failed' ? `Failed · ${status.reason_code ?? 'no reason code'}` : status.status.replaceAll('_', ' ');
  return <div className={`presenter-probe presenter-probe-${verdict}`} role="status">
    <p className="presenter-probe-line"><span className={`demo-pill demo-pill-${verdict}`}>{label}</span><span className="demo-probe-src">{detail?.safety ? `safety decision ${detail.safety.decision}` : 'safety evidence not received yet'} · {mode === 'live' ? 'shared ledger' : 'mock ledger, never executed'}</span></p>
    {violations.length > 0
      ? <ul className="presenter-probe-codes">{violations.map((code) => <li key={code}><code>{code}</code><span>{reasonText(code)}</span></li>)}</ul>
      : verdict === 'blocked' ? <p className="demo-note">Blocked, but no violation code was recorded on this row.</p> : null}
    <code className="demo-probe-key" title="Probe command key">{commandKey}</code>
  </div>;
}
