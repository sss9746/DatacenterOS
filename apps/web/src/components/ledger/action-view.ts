// Pure view model for the durable action ledger (R4.1 / C1.1).
// Everything here is read from the ledger projection the client exposes (`onActions` + `onActionDetails`).
// Rules: the operation and every other field come from the stored command or ledger rows, never from parsing a
// command-key string; unknown values render as "unavailable", never as zero; elapsed sim time is only an estimate,
// and only ledger status plus a recorded verification establishes success.
import type { ActionStatus } from '@dcos/contracts';
import type { ActionDetail, ActionHistoryEntry, ActionSafety } from '@dcos/db-client';
import { duration } from '../../lib/utils';

export const UNAVAILABLE = 'unavailable';
export const ESTIMATE_NOTE = 'estimated from sim start/due times — not verified';
const ACTIVE: ReadonlySet<ActionStatus['status']> = new Set(['requested', 'claimed', 'running', 'needs_reconciliation']);

const reasons: Record<string, string> = {
  DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT: 'The destination rack has too little thermal headroom for this placement.',
  DEST_POWER_HEADROOM_INSUFFICIENT: 'The destination does not have enough available power.',
  DEST_GPU_UNHEALTHY: 'A destination GPU is unhealthy.',
  DEST_GPU_BUSY: 'A destination GPU is already allocated.',
  DEST_GPU_LEASED: 'Another action has reserved a destination GPU.',
  DEST_GPU_COUNT_INSUFFICIENT: 'There are not enough eligible GPUs for the whole job.',
  DEST_NOT_COMPATIBLE: 'The destination is incompatible with this job.',
  CHECKPOINT_NOT_ACCESSIBLE: 'The checkpoint cannot be read from this destination.',
  NO_COMPLETED_CHECKPOINT: 'A completed checkpoint is required before restarting.',
  JOB_NOT_PREEMPTIBLE: 'This job cannot be moved voluntarily.',
  CHECKPOINT_UNSUPPORTED: 'This job does not support checkpointing.',
  STALE_DECISION_EPOCH: 'The cluster changed after the plan was made. A fresh plan is needed.',
  STALE_RESOURCE_VERSION: 'A resource changed after the plan was made.',
  CONFLICTING_ACTION: 'Another action conflicts with this command.',
  EVIDENCE_STALE: 'The supporting evidence is too old.',
  UNSUPPORTED_OPERATION: 'This operation is not supported.',
  CORDON_IS_NOT_REPAIR: 'Cordoning a GPU does not repair it.',
  REAL_GPU_NOT_ALLOCATABLE: 'The real Brev GPU is observation-only and cannot be allocated.',
  JOB_NOT_FOUND: 'The job named by this command does not exist.',
  JOB_STATE_INVALID: 'The job is in the wrong state for this operation.',
  TARGET_NOT_FOUND: 'The target resource does not exist.',
  INVALID_ARGUMENT: 'The command arguments are malformed.',
  JOB_FAILED_DURING_OPERATION: 'The job failed while this operation was running.',
  SAFETY_REJECTED: 'The safety check rejected this command.',
  HIGH_PRIORITY_JOB_DISRUPTION: 'This disrupts a high-priority job, so a human must approve it.',
};

export const actionLabel = (action: Pick<ActionStatus, 'status' | 'reason_code'>) =>
  action.status === 'failed' && action.reason_code === 'SAFETY_REJECTED' ? 'BLOCKED' : action.status.replaceAll('_', ' ');
export const reasonText = (code: string) => reasons[code] ?? code.replaceAll('_', ' ').toLowerCase();

export type Tone = 'neutral' | 'agent' | 'warning' | 'danger';
export const statusTone = (action: Pick<ActionStatus, 'status' | 'reason_code'>): Tone =>
  action.status === 'failed' ? 'danger'
    : action.status === 'succeeded' ? 'agent'
      : action.status === 'needs_reconciliation' ? 'warning'
        : 'neutral';

const OPERATION_LABELS: Record<string, string> = {
  keep_running: 'Keep running', power_cap: 'Power cap', checkpoint: 'Checkpoint', pause_job: 'Pause job',
  cordon_gpu: 'Cordon GPU', migrate_restart: 'Migrate + restart', uncordon_gpu: 'Uncordon GPU', escalate: 'Escalate',
};
/** Label for the command's own `operation` field. */
export const operationLabel = (operation: string) => OPERATION_LABELS[operation] ?? operation.replaceAll('_', ' ');

// ---- value formatting -----------------------------------------------------------------------------

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const fmtNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const n = (v: unknown, unit = '') => { const x = num(v); return x === null ? UNAVAILABLE : `${fmtNumber.format(x)}${unit}`; };
const yesNo = (v: unknown) => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : UNAVAILABLE);

export const humanize = (key: string) => {
  const s = key.replaceAll('_', ' ').replace(/\b(gpu|gpus|id|ids)\b/g, (w) => w.toUpperCase().replace('IDS', 'IDs'));
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Generic, readable rendering of any JSON-ish value. null / undefined → "unavailable". */
export function formatValue(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return UNAVAILABLE;
  if (typeof v === 'number') return Number.isFinite(v) ? fmtNumber.format(v) : UNAVAILABLE;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v.length ? v : '(empty)';
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.length ? v.map((x) => formatValue(x, depth + 1)).join(', ') : 'none';
  if (typeof v === 'object') {
    if (depth > 2) return JSON.stringify(v);
    const entries = Object.entries(v as Record<string, unknown>);
    return entries.length ? entries.map(([k, x]) => `${humanize(k)}: ${formatValue(x, depth + 1)}`).join('; ') : 'none';
  }
  return String(v);
}

export const simTime = (ms: unknown) => { const x = num(ms); return x === null ? UNAVAILABLE : `${duration(x)} sim`; };

// ---- safety evidence ------------------------------------------------------------------------------

/** One readable line of evidence. `tone` only when the evidence itself shows pass/fail (actual vs required). */
export interface EvidenceItem { key: string; label: string; value: string; tone: 'ok' | 'danger' | null }
const item = (key: string, label: string, value: string, tone: EvidenceItem['tone'] = null): EvidenceItem => ({ key, label, value, tone });
const vsTone = (ok: boolean | null): EvidenceItem['tone'] => (ok === null ? null : ok ? 'ok' : 'danger');
const geq = (a: unknown, b: unknown) => { const x = num(a); const y = num(b); return x === null || y === null ? null : x >= y; };

const EVIDENCE_LABELS: Record<string, string> = {
  job_status: 'Job status', job_in_flight_status: 'Job already in flight', destination_mode: 'Destination given as',
  free_gpus_on_destination_nodes: 'Free GPUs on destination nodes', unknown_job_id: 'Unknown job',
  destination_gpu_ids: 'Destination GPUs', conflicting_leases: 'Reserved by another action',
  leased_destinations: 'Destination reserved by another action', unversioned_resource_ids: 'Unversioned resources (not checked)',
  invalid_arguments: 'Invalid arguments', unknown_operation: 'Unknown operation',
};
/** Echo of the command's operation; the command itself is the source of truth, so it is not repeated. */
const SKIP = new Set(['operation', 'required_headroom_c', 'available_headroom_c', 'slowdown_c', 'lookahead_s', 'evidence_max_age_ms']);

/** evaluateSafety's evidence (packages/physics/src/gpu/safety.ts) as readable lines; unknown keys fall back to key/value. */
export function formatEvidence(evidence: Record<string, unknown> | null | undefined): EvidenceItem[] {
  if (!evidence) return [];
  const out: EvidenceItem[] = [];
  if ('available_headroom_c' in evidence || 'required_headroom_c' in evidence) {
    const extra = [
      'slowdown_c' in evidence ? `vs ${n(evidence.slowdown_c, ' °C')} slowdown` : null,
      'lookahead_s' in evidence ? `${n(evidence.lookahead_s, ' s')} look-ahead` : null,
    ].filter(Boolean).join(', ');
    out.push(item('headroom', 'Thermal headroom (worst destination rack)',
      `actual ${n(evidence.available_headroom_c, ' °C')} · required ≥ ${n(evidence.required_headroom_c, ' °C')}${extra ? ` (${extra})` : ''}`,
      vsTone(geq(evidence.available_headroom_c, evidence.required_headroom_c))));
  } else {
    if ('slowdown_c' in evidence) out.push(item('slowdown_c', 'Slowdown threshold', n(evidence.slowdown_c, ' °C')));
    if ('lookahead_s' in evidence) out.push(item('lookahead_s', 'Look-ahead', n(evidence.lookahead_s, ' s')));
  }
  for (const [key, value] of Object.entries(evidence)) {
    if (SKIP.has(key)) continue;
    switch (key) {
      case 'thermal':
        if (Array.isArray(value)) {
          value.forEach((row, i) => {
            const r = rec(row);
            if (!r) return void out.push(item(`thermal-${i}`, 'Rack thermal', formatValue(row)));
            const inlet = `inlet ${n(r.inlet_now_c, ' °C')} → ${n(r.inlet_projected_c, ' °C')}${r.inlet_inferred === true ? ' (inferred from GPU temps)' : r.inlet_inferred === false ? ' (modelled)' : ''}`;
            out.push(item(`thermal-${i}`, `Rack ${str(r.rack_id) ?? UNAVAILABLE}${str(r.loop_id) ? ` · ${r.loop_id as string}` : ''}`,
              `projected max GPU ${n(r.projected_max_gpu_temp_c, ' °C')} · headroom ${n(r.available_headroom_c, ' °C')} of required ${n(r.required_headroom_c, ' °C')} · ${inlet}`,
              vsTone(geq(r.available_headroom_c, r.required_headroom_c))));
          });
          continue;
        }
        break;
      case 'cooling_loops':
        if (Array.isArray(value)) {
          value.forEach((row, i) => {
            const r = rec(row);
            if (!r) return void out.push(item(`loop-${i}`, 'Cooling loop', formatValue(row)));
            out.push(item(`loop-${i}`, `Loop ${str(r.loop_id) ?? UNAVAILABLE}`,
              `coolant ${n(r.coolant_now_c, ' °C')} → ${n(r.coolant_after_lookahead_c, ' °C')} over look-ahead · heat ${n(r.heat_after_move_w, ' W')} vs capacity ${n(r.capacity_w, ' W')}`));
          });
          continue;
        }
        break;
      case 'power':
        if (Array.isArray(value)) {
          value.forEach((row, i) => {
            const r = rec(row);
            if (!r) return void out.push(item(`power-${i}`, 'Power', formatValue(row)));
            const id = str(r.resource_id) ?? UNAVAILABLE;
            if ('budget_w' in r) {
              out.push(item(`power-${i}`, `Power budget ${id}`, `projected draw ${n(r.projected_draw_w, ' W')} · budget ${n(r.budget_w, ' W')}`,
                vsTone(geq(r.budget_w, r.projected_draw_w))));
            } else {
              out.push(item(`power-${i}`, `Power ${id}`, `needs ${n(r.required_w, ' W')} · available ${n(r.available_w, ' W')}`,
                vsTone(geq(r.available_w, r.required_w))));
            }
          });
          continue;
        }
        break;
      case 'checkpoint': {
        const r = rec(value);
        if (r) {
          const parts = [
            `latest ${str(r.latest_checkpoint_id) ?? 'none recorded'}`,
            `status ${str(r.latest_status) ?? UNAVAILABLE}`,
            `accessible ${yesNo(r.latest_accessible)}`,
            str(r.satisfied_by_dependency) ? `satisfied by dependency ${r.satisfied_by_dependency as string}` : null,
            `store ${str(r.storage_resource_id) ?? UNAVAILABLE}`,
          ].filter(Boolean);
          out.push(item('checkpoint', 'Checkpoint', parts.join(' · ')));
          continue;
        }
        break;
      }
      case 'decision_epoch': {
        const r = rec(value);
        if (r) {
          const vals = [num(r.snapshot), num(r.current), num(r.expected)];
          const ok = vals.every((x) => x !== null) ? vals[0] === vals[1] && vals[1] === vals[2] : null;
          out.push(item('decision_epoch', 'Decision epoch', `snapshot ${n(r.snapshot)} · current ${n(r.current)} · command expected ${n(r.expected)}`, vsTone(ok)));
          continue;
        }
        break;
      }
      case 'stale_resource_versions':
        if (Array.isArray(value)) {
          value.forEach((row, i) => {
            const r = rec(row);
            out.push(item(`stale-${i}`, `Stale version ${r ? str(r.resource_id) ?? UNAVAILABLE : ''}`.trim(),
              r ? `expected v${n(r.expected)} · observed ${r.observed === null ? 'no such resource' : `v${n(r.observed)}`}` : formatValue(row), 'danger'));
          });
          continue;
        }
        break;
      case 'stale_evidence_ids':
        out.push(item(key, 'Stale telemetry', `${formatValue(value)}${'evidence_max_age_ms' in evidence ? ` (older than ${n(num(evidence.evidence_max_age_ms) === null ? null : (evidence.evidence_max_age_ms as number) / 1000, ' s')})` : ''}`, 'danger'));
        continue;
      case 'approval_reasons':
        out.push(item(key, 'Needs approval because', Array.isArray(value) ? value.map((x) => (typeof x === 'string' ? reasonText(x) : formatValue(x))).join(' ') : formatValue(value)));
        continue;
      case 'gpu_condition': {
        const r = rec(value);
        if (r) { out.push(item(key, 'GPU condition', `availability ${str(r.availability) ?? UNAVAILABLE} · last XID ${n(r.last_xid_code)}`)); continue; }
        break;
      }
    }
    out.push(item(key, EVIDENCE_LABELS[key] ?? humanize(key), formatValue(value)));
  }
  return out;
}

// ---- safety, dependencies, history, progress -----------------------------------------------------

export interface ReasonView { code: string; text: string }
export const reasonView = (code: string): ReasonView => ({ code, text: reasonText(code) });

export interface SafetyView { decision: string; label: string; tone: Tone; violations: ReasonView[]; checkedEpoch: string; evidence: EvidenceItem[] }
const DECISIONS: Record<string, [string, Tone]> = {
  allow: ['Allowed', 'agent'], deny: ['Denied', 'danger'], retry_new_snapshot: ['Retry with a fresh snapshot', 'warning'], needs_approval: ['Needs approval', 'warning'],
};
export function safetyView(s: ActionSafety | null): SafetyView | null {
  if (!s) return null;
  const [label, tone] = DECISIONS[s.decision] ?? [String(s.decision).replaceAll('_', ' '), 'neutral' as Tone];
  return {
    decision: s.decision, label, tone,
    violations: s.violations.map(reasonView),
    checkedEpoch: s.checked_decision_epoch === null ? 'not recorded' : String(s.checked_decision_epoch),
    evidence: formatEvidence(s.evidence),
  };
}

export interface DependencyView { commandKey: string; status: string; tone: Tone; succeeded: boolean }
export interface HistoryView { key: string; label: string; tone: Tone; version: string; simTime: string; reason: ReasonView | null; notes: string[] }
export interface ProgressView { fraction: number; percent: number; elapsed: string; total: string; dueReached: boolean; note: string }
export interface VerificationView { state: 'verified' | 'failed' | 'unverified' | 'recorded'; label: string; tone: Tone; note: string | null; evidence: EvidenceItem[] }

/** Readable notes for an action_event's detail (`{ safety }`, `{ outcome }`, `{ verification }`, `{ start_safety }`, …). */
export function historyNotes(detail: Record<string, unknown>): string[] {
  const notes: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (key === 'safety') {
      const s = rec(value);
      notes.push(s ? `Safety ${DECISIONS[String(s.decision)]?.[0].toLowerCase() ?? formatValue(s.decision)}${Array.isArray(s.violations) && s.violations.length ? `: ${s.violations.join(', ')}` : ''}` : 'Safety decision not recorded');
    } else if (key === 'outcome') {
      const o = rec(value);
      notes.push(o ? `Outcome ${str(o.status) ?? UNAVAILABLE}${str(o.reason_code) ? ` (${o.reason_code as string})` : ''} at ${simTime(o.sim_time_ms)}` : `Outcome ${formatValue(value)}`);
    } else if (key === 'verification') {
      const v = rec(value);
      const verdict = v?.verified === true ? 'verified' : v?.verified === false ? 'verification failed' : 'verification recorded (result unavailable)';
      notes.push(`${verdict.charAt(0).toUpperCase()}${verdict.slice(1)}${v && str(v.note) ? ` — ${v.note as string}` : ''}`);
    } else if (key === 'start_safety') {
      notes.push(`Start-time recheck rejected: ${Array.isArray(value) ? value.join(', ') : formatValue(value)}`);
    } else if (key === 'enqueued' && value === true) {
      notes.push('Enqueued for the simulator');
    } else if (key === 'worker_id') {
      notes.push(`Claimed by ${formatValue(value)}`);
    } else if (key === 'locked') {
      notes.push(`Reserved ${formatValue(value)}`);
    } else {
      notes.push(`${humanize(key)}: ${formatValue(value)}`);
    }
  }
  return notes;
}

const historyView = (h: ActionHistoryEntry, i: number): HistoryView => ({
  key: `${i}-${h.version}-${h.status}`,
  label: actionLabel(h),
  tone: statusTone(h),
  version: h.version > 0 ? `v${h.version}` : 'version unavailable',
  simTime: simTime(h.sim_time_ms),
  reason: h.reason_code ? reasonView(h.reason_code) : null,
  notes: historyNotes(h.detail),
});

/** Elapsed fraction between sim start and due. null unless all three times are known and due > start. */
export function estimateProgress(startMs: number | null, dueMs: number | null, nowMs: number | null): ProgressView | null {
  if (startMs === null || dueMs === null || nowMs === null || !(dueMs > startMs)) return null;
  const fraction = Math.min(1, Math.max(0, (nowMs - startMs) / (dueMs - startMs)));
  return {
    fraction, percent: Math.round(fraction * 100),
    elapsed: duration(Math.max(0, Math.min(nowMs, dueMs) - startMs)), total: duration(dueMs - startMs),
    dueReached: nowMs >= dueMs, note: ESTIMATE_NOTE,
  };
}

function verificationView(status: ActionStatus, history: ActionHistoryEntry[]): VerificationView | null {
  if (status.status !== 'succeeded') return null;
  const fromHistory = [...history].reverse().find((h) => rec(h.detail.verification))?.detail.verification;
  const v = rec(fromHistory) ?? rec(status.result.verification);
  if (!v) return { state: 'unverified', label: 'Ledger succeeded · not verified', tone: 'warning', note: null, evidence: [] };
  const { verified, note, ...rest } = v;
  const evidence = formatEvidence(rest);
  if (verified === true) return { state: 'verified', label: 'Verified', tone: 'agent', note: str(note), evidence };
  if (verified === false) return { state: 'failed', label: 'Verification failed', tone: 'danger', note: str(note), evidence };
  return { state: 'recorded', label: 'Verification recorded · result unavailable', tone: 'warning', note: str(note), evidence };
}

// ---- the row model --------------------------------------------------------------------------------

export interface DetailView {
  operation: string;
  operationLabel: string;
  job: string;
  target: string;
  workflowId: string;
  planId: string;
  incidentIds: string[];
  arguments: EvidenceItem[];
  claimedBy: string;
  dependencies: DependencyView[];
  requestedAt: string;
  startedAt: string;
  dueAt: string;
  progress: ProgressView | null;
  /** Why no estimate is shown for a running action. */
  progressNote: string | null;
  safety: SafetyView | null;
  startSafety: SafetyView | null;
  history: HistoryView[];
}

export interface ActionView {
  commandKey: string;
  status: ActionStatus;
  label: string;
  tone: Tone;
  blocked: boolean;
  active: boolean;
  attempt: number;
  version: number;
  updatedAt: string;
  /** `status.result.violations` from the ledger row (shown when details have not arrived). */
  reportedViolations: ReasonView[];
  verification: VerificationView | null;
  /** null: the status row exists but `onActionDetails` has not delivered this action yet. */
  detail: DetailView | null;
}

const newer = (a: ActionStatus | undefined, b: ActionStatus | undefined) => (!a ? b : !b ? a : b.version > a.version ? b : a);

/** Latest status per command key across both subscriptions (they can arrive in either order). */
export function statusIndex(actions: readonly ActionStatus[], details: readonly ActionDetail[]): Map<string, ActionStatus> {
  const map = new Map<string, ActionStatus>();
  for (const a of actions) map.set(a.command_key, newer(map.get(a.command_key), a)!);
  for (const d of details) map.set(d.status.command_key, newer(map.get(d.status.command_key), d.status)!);
  return map;
}

export function describeAction(status: ActionStatus, detail: ActionDetail | null, statuses: ReadonlyMap<string, ActionStatus>, simTimeMs: number | null): ActionView {
  const label = actionLabel(status);
  const violations = Array.isArray(status.result.violations) ? status.result.violations.filter((v): v is string => typeof v === 'string') : [];
  const history = detail?.history ?? [];
  const base: ActionView = {
    commandKey: status.command_key, status, label, tone: statusTone(status), blocked: label === 'BLOCKED', active: ACTIVE.has(status.status),
    attempt: status.attempt, version: status.version, updatedAt: simTime(status.updated_sim_time_ms),
    reportedViolations: violations.map(reasonView), verification: verificationView(status, history), detail: null,
  };
  if (!detail) return base;
  const cmd = detail.command;
  const startedMs = history.find((h) => h.status === 'running')?.sim_time_ms ?? null;
  const dueMs = detail.due_sim_time_ms ?? num(status.result.due_sim_time_ms);
  const running = status.status === 'running';
  const progress = running ? estimateProgress(startedMs, dueMs, simTimeMs) : null;
  const progressNote = !running || progress ? null
    : startedMs === null ? 'Progress estimate unavailable: start time not recorded.'
      : dueMs === null ? 'Progress estimate unavailable: due time not recorded yet.'
        : simTimeMs === null ? 'Progress estimate unavailable: sim clock not received.'
          : 'Progress estimate unavailable: due time is not after the start time.';
  return {
    ...base,
    detail: {
      operation: cmd.operation,
      operationLabel: operationLabel(cmd.operation),
      job: cmd.job_id ?? 'no job',
      target: cmd.target_resource_id,
      workflowId: cmd.workflow_id,
      planId: cmd.plan_id,
      incidentIds: [...cmd.incident_ids],
      arguments: Object.entries(cmd.arguments).map(([k, v]) => item(k, humanize(k), formatValue(v))),
      claimedBy: detail.claimed_by ?? (history.some((h) => h.status === 'claimed') ? UNAVAILABLE : 'not claimed'),
      dependencies: cmd.depends_on_command_keys.map((key) => {
        const dep = statuses.get(key);
        return dep
          ? { commandKey: key, status: actionLabel(dep), tone: statusTone(dep), succeeded: dep.status === 'succeeded' }
          : { commandKey: key, status: 'status unavailable', tone: 'neutral', succeeded: false };
      }),
      requestedAt: simTime(cmd.requested_sim_time_ms),
      startedAt: startedMs === null ? (running ? UNAVAILABLE : 'not started') : simTime(startedMs),
      dueAt: dueMs === null ? (startedMs === null && !running ? 'not scheduled' : UNAVAILABLE) : simTime(dueMs),
      progress, progressNote,
      safety: safetyView(detail.safety),
      startSafety: safetyView(detail.start_safety),
      history: history.map(historyView),
    },
  };
}

export type LedgerFilter = 'all' | 'active' | 'blocked';

/** Every action known from either subscription, newest request first. */
export function buildLedgerRows(actions: readonly ActionStatus[], details: readonly ActionDetail[], simTimeMs: number | null): ActionView[] {
  const statuses = statusIndex(actions, details);
  const detailByKey = new Map(details.map((d) => [d.status.command_key, d]));
  const order = new Map<string, number>();
  // details arrive sorted by request time; status-only rows keep their onActions order after them
  details.forEach((d, i) => order.set(d.status.command_key, i));
  actions.forEach((a, i) => { if (!order.has(a.command_key)) order.set(a.command_key, details.length + i); });
  return [...statuses.values()]
    .sort((a, b) => (order.get(b.command_key) ?? 0) - (order.get(a.command_key) ?? 0))
    .map((s) => describeAction(s, detailByKey.get(s.command_key) ?? null, statuses, simTimeMs));
}

export function filterRows(rows: readonly ActionView[], filter: LedgerFilter, workflowId: string | null): ActionView[] {
  return rows.filter((row) =>
    (filter === 'all' || (filter === 'blocked' ? row.blocked : row.active))
    && (workflowId === null || row.detail?.workflowId === workflowId));
}

export const workflowIds = (details: readonly ActionDetail[]) => [...new Set(details.map((d) => d.command.workflow_id))].sort();
