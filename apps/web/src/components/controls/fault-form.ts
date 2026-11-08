import type { CoolingCurrent, FaultInjection, ObservedSnapshot } from '@dcos/contracts';
import { STEP_MS } from '@dcos/physics';

/**
 * Presenter fault catalog over the existing admin `injectFault` (IMPLEMENTATION-SCOPE §3). One entry per behaviour the
 * physics engine actually implements; every wire `kind` of `FaultInjection` appears at least once (checked by
 * `ENGINE_KINDS` at compile time and by the tests). Encodings are read from @dcos/physics `faultConditions`
 * (gpu/world.ts) and `applyDueFaults` / `expireFaults` (gpu/faults.ts):
 *   - cooling_pump_degradation removes `severity` of the pump's capacity; factors multiply across active faults.
 *   - cooling_pump_outage zeroes the pump; gpu_thermal_load adds severity × 20 °C to one GPU.
 *   - gpu_xid_* LATCH into the GPU's hidden failure: a finite duration never repairs them, so they are persistent only.
 *   - node_crash on a node latches all its GPUs unreachable; expiry clears that latch (modelled reboot). Jobs stay failed.
 *   - network_link_down or node_crash on `ckpt-store-1` means "checkpoint storage unavailable": checkpoints become
 *     inaccessible and a checkpoint cannot complete (CHECKPOINT_NOT_ACCESSIBLE). It is not a switch emulation.
 *   - network_link_down on a rack link emits an equipment alarm only; no GPU or job is affected.
 *   - sensor_stale freezes a GPU's observed readings and last_seen while the physics keeps evolving (GPU targets only).
 */
export type FaultKind = FaultInjection['kind'];
export type FaultGroup = 'cooling' | 'gpu' | 'node' | 'storage' | 'telemetry';
export type TargetType = 'pump' | 'gpu' | 'node' | 'checkpoint_store' | 'network_link';
export type FaultCatalogId =
  | 'pump_degradation' | 'pump_outage'
  | 'gpu_thermal_load' | 'gpu_xid_79' | 'gpu_xid_48' | 'gpu_xid_74'
  | 'node_crash'
  | 'storage_link_down' | 'storage_node_crash'
  | 'sensor_stale_gpu' | 'link_down_alarm';

export type PumpId = 'pump-a' | 'pump-b';
export const PUMP_IDS: readonly PumpId[] = ['pump-a', 'pump-b'];
export const PUMP_LOSS_PRESETS = [0.3, 0.6, 0.8] as const;
export type PumpLoss = (typeof PUMP_LOSS_PRESETS)[number];
export const DEFAULT_PUMP_LOSS: PumpLoss = 0.6;
export const THERMAL_LOAD_PRESETS = [0.25, 0.5, 1] as const;
/** Simulated extra °C at thermal-load severity 1 (physics THERMAL_LOAD_FAULT_MAX_C). */
export const THERMAL_LOAD_MAX_C = 20;
export const DELAY_PRESETS_S = [0, 10, 30] as const;
export type FaultDelayS = (typeof DELAY_PRESETS_S)[number];
/** null = persistent (until reset); otherwise the fault ends after this many sim-seconds. */
export const DURATION_PRESETS_S = [null, 30, 60, 120] as const;
export type FaultDurationS = (typeof DURATION_PRESETS_S)[number];
/** The real attached GPU and its node never receive simulated faults. */
export const REAL_RESOURCE_IDS: ReadonlySet<string> = new Set(['gpu-real-0', 'node-real-0']);
export const CHECKPOINT_STORE_ID = 'ckpt-store-1';
/**
 * Default Xid 79 target: rack 7 sits on pump-b's loop, away from the pump-a cooling incident on racks 2–4 and the
 * hot rack 6, so the demo's second fault opens a separate incident instead of merging into the first.
 */
export const DEFAULT_XID_GPU_ID = 'gpu-r7-n1-0';
export const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

export interface SeveritySpec {
  label: string;
  presets: readonly number[];
  default: number;
  /** Human text for one preset value. */
  format: (value: number) => string;
}

export interface FaultCatalogEntry {
  id: FaultCatalogId;
  kind: FaultKind;
  group: FaultGroup;
  name: string;
  /** One line: what the fault is. */
  what: string;
  /** What the engine does to GPUs and jobs (its exact modelled effect, nothing more). */
  effect: string;
  target: TargetType;
  /** Severity presets, or null when the engine fixes it (encoded as 1). */
  severity: SeveritySpec | null;
  /** Whether a finite duration changes anything in the engine. False = persistent only (expiry would not repair). */
  expires: boolean;
  /** Honesty note shown next to the row, when the encoding needs one. */
  note?: string;
  /** Whether the fixture mock (no physics) has a canned effect for it. */
  fixtureEffect: boolean;
  /** Verb phrase for the Inject button: `Fail gpu-r3-n1-0 (Xid 79)`. */
  button: (target: string, severity: number | null) => string;
}

const pumpLoss: SeveritySpec = { label: 'Capacity loss', presets: PUMP_LOSS_PRESETS, default: DEFAULT_PUMP_LOSS, format: percent };
const thermalLoad: SeveritySpec = { label: 'Extra heat', presets: THERMAL_LOAD_PRESETS, default: 0.5, format: (s) => `+${Math.round(s * THERMAL_LOAD_MAX_C)} °C` };
const XID_NOTE = 'Xids are driver signals; the latch rule is a simulator assumption. Expiry never repairs hardware, so this is persistent.';
const STORAGE_NOTE = 'Labelled as storage accessibility, not switch emulation: the engine marks every checkpoint on the store inaccessible.';

export const FAULT_CATALOG: readonly FaultCatalogEntry[] = [
  { id: 'pump_degradation', kind: 'cooling_pump_degradation', group: 'cooling', name: 'Degrade pump', target: 'pump', severity: pumpLoss, expires: true, fixtureEffect: true,
    what: 'The pump loses part of its cooling capacity (low-flow alarm).',
    effect: 'The racks it cools warm over sim-minutes; GPUs at 85 °C throttle (−30% clock), at 92 °C shut down and their job fails. Losses on one pump multiply.',
    button: (t, s) => `Degrade ${t} by ${percent(s ?? DEFAULT_PUMP_LOSS)}` },
  { id: 'pump_outage', kind: 'cooling_pump_outage', group: 'cooling', name: 'Stop pump', target: 'pump', severity: null, expires: true, fixtureEffect: false,
    what: 'The pump stops: zero coolant flow on its loop.',
    effect: 'Its racks heat fast; GPUs throttle, then shut down and their jobs fail. A finite duration restores the modelled capacity afterwards.',
    button: (t) => `Stop ${t}` },
  { id: 'gpu_thermal_load', kind: 'gpu_thermal_load', group: 'gpu', name: 'Local heat spike', target: 'gpu', severity: thermalLoad, expires: true, fixtureEffect: false,
    what: 'One GPU runs hotter than its load explains.',
    effect: 'That GPU reads severity × 20 °C hotter: it throttles at 85 °C and shuts down at 92 °C (its job then fails). Other GPUs only see the extra heat through the loop.',
    button: (t, s) => `Heat ${t} by +${Math.round((s ?? 0.5) * THERMAL_LOAD_MAX_C)} °C` },
  { id: 'gpu_xid_79', kind: 'gpu_xid_79', group: 'gpu', name: 'GPU inaccessible (Xid 79)', target: 'gpu', severity: null, expires: false, fixtureEffect: true, note: XID_NOTE,
    what: 'The GPU falls off the bus.',
    effect: 'The GPU becomes unreachable (0 W, 0 MHz, readings freeze); a non-elastic job on it fails back to its last durable checkpoint.',
    button: (t) => `Fail ${t} (Xid 79)` },
  { id: 'gpu_xid_48', kind: 'gpu_xid_48', group: 'gpu', name: 'Double-bit ECC error (Xid 48)', target: 'gpu', severity: null, expires: false, fixtureEffect: true, note: XID_NOTE,
    what: 'An uncorrectable memory error on the GPU.',
    effect: 'The GPU is marked degraded with code 48 and keeps reporting; the job running on it fails back to its last checkpoint. No real-device reset advice is implied.',
    button: (t) => `Xid 48 on ${t}` },
  { id: 'gpu_xid_74', kind: 'gpu_xid_74', group: 'gpu', name: 'NVLink error (Xid 74)', target: 'gpu', severity: null, expires: false, fixtureEffect: true, note: `${XID_NOTE} No NVLink traffic is simulated.`,
    what: 'A link error on the GPU interconnect.',
    effect: 'The GPU is marked degraded with code 74 and a warning signal is raised. Its job keeps running: this profile models no job impact.',
    button: (t) => `Xid 74 on ${t}` },
  { id: 'node_crash', kind: 'node_crash', group: 'node', name: 'Node crash', target: 'node', severity: null, expires: true, fixtureEffect: false,
    what: 'The whole 8-GPU host stops responding.',
    effect: 'All 8 GPUs become unreachable and every job allocated there fails back to its checkpoint. A finite duration models a reboot: the GPUs return, the jobs stay failed.',
    button: (t) => `Crash ${t}` },
  { id: 'storage_link_down', kind: 'network_link_down', group: 'storage', name: 'Checkpoint storage unavailable', target: 'checkpoint_store', severity: null, expires: true, fixtureEffect: false, note: STORAGE_NOTE,
    what: 'The checkpoint store cannot be reached (encoded as network_link_down on the store).',
    effect: 'Every checkpoint on it becomes inaccessible: a checkpoint in flight fails (CHECKPOINT_NOT_ACCESSIBLE) and a move cannot restart from it. Running jobs keep training.',
    button: (t) => `Make ${t} unreachable` },
  { id: 'storage_node_crash', kind: 'node_crash', group: 'storage', name: 'Checkpoint storage host down', target: 'checkpoint_store', severity: null, expires: true, fixtureEffect: false, note: `${STORAGE_NOTE} Same engine effect as the link encoding.`,
    what: 'The storage host crashes (encoded as node_crash on the store).',
    effect: 'Identical to "storage unavailable": checkpoints inaccessible, checkpoint completion fails, restarts from it are impossible until it ends.',
    button: (t) => `Crash storage host ${t}` },
  { id: 'sensor_stale_gpu', kind: 'sensor_stale', group: 'telemetry', name: 'Stale GPU readings', target: 'gpu', severity: null, expires: true, fixtureEffect: false,
    what: 'The GPU\'s telemetry stops updating while the hardware keeps running.',
    effect: 'Temperature, clock, power and last_seen freeze at their last values (quality "stale"); physics and the job keep evolving underneath. Only GPUs are modelled.',
    button: (t) => `Freeze readings of ${t}` },
  { id: 'link_down_alarm', kind: 'network_link_down', group: 'telemetry', name: 'Rack link-down alarm', target: 'network_link', severity: null, expires: true, fixtureEffect: false,
    note: 'Alarm only, no workload effect: the engine raises an equipment alarm and nothing else.',
    what: 'A rack network link reports down.',
    effect: 'One warning signal in the feed. No GPU, job or checkpoint changes.',
    button: (t) => `Alarm on ${t}` },
];

/** Compile-time proof that the catalog names every engine kind (TypeScript rejects a missing or unknown key). */
export const ENGINE_KINDS: Record<FaultKind, readonly FaultCatalogId[]> = {
  cooling_pump_degradation: ['pump_degradation'],
  cooling_pump_outage: ['pump_outage'],
  gpu_thermal_load: ['gpu_thermal_load'],
  gpu_xid_79: ['gpu_xid_79'],
  gpu_xid_48: ['gpu_xid_48'],
  gpu_xid_74: ['gpu_xid_74'],
  node_crash: ['node_crash', 'storage_node_crash'],
  network_link_down: ['storage_link_down', 'link_down_alarm'],
  sensor_stale: ['sensor_stale_gpu'],
};

export const FAULT_GROUPS: readonly { id: FaultGroup; name: string }[] = [
  { id: 'cooling', name: 'Cooling' }, { id: 'gpu', name: 'GPU errors' }, { id: 'node', name: 'Node' }, { id: 'storage', name: 'Storage' }, { id: 'telemetry', name: 'Telemetry' },
];

export const catalogEntry = (id: FaultCatalogId): FaultCatalogEntry => FAULT_CATALOG.find((entry) => entry.id === id)!;

export interface FaultFormInput {
  fault: FaultCatalogId;
  runId: string;
  /** Sim clock of a snapshot read immediately before submitting. */
  simTimeMs: number;
  targetId: string;
  delayS: FaultDelayS;
  /** Preset severity for entries that have one; ignored (encoded as 1) otherwise. */
  severity?: number;
  /** Finite duration in sim-seconds, or null/undefined for persistent. Rejected for entries that never expire. */
  durationS?: FaultDurationS;
  faultId: string;
  /** Snapshot used to check the target's resource kind; without one the id pattern is checked. */
  snapshot?: Pick<ObservedSnapshot, 'resources' | 'gpus' | 'nodes'> | null;
}

export class FaultFormError extends Error {}

/** Delay 0 means the next tick: the current sim clock plus one physics step; otherwise the selected offset. */
export function faultStartSimMs(simTimeMs: number, delayS: FaultDelayS): number {
  return simTimeMs + (delayS === 0 ? STEP_MS : delayS * 1000);
}

const ID_PATTERN: Record<TargetType, RegExp> = {
  pump: /^pump-/, gpu: /^gpu-/, node: /^node-/, checkpoint_store: /^ckpt-store-/, network_link: /^link-/,
};
const RESOURCE_KIND: Record<TargetType, string> = {
  pump: 'cooling_pump', gpu: 'gpu', node: 'node', checkpoint_store: 'checkpoint_store', network_link: 'network_link',
};
export const TARGET_LABEL: Record<TargetType, string> = {
  pump: 'pump', gpu: 'simulated GPU', node: 'simulated node', checkpoint_store: 'checkpoint store', network_link: 'rack network link',
};

/**
 * Why `targetId` cannot receive `entry`, or null when it can. Checks the real GPU/node, the resource kind in the
 * snapshot (when present) and the id family, so an unsupported combination is refused in the UI, never passed on.
 */
export function targetProblem(entry: FaultCatalogEntry, targetId: string, snapshot?: FaultFormInput['snapshot']): string | null {
  if (!targetId) return `Choose a ${TARGET_LABEL[entry.target]}.`;
  if (REAL_RESOURCE_IDS.has(targetId)) return 'The real attached GPU and its node never receive simulated faults.';
  const resource = snapshot?.resources.find((row) => row.resource_id === targetId);
  if (resource) {
    if (resource.kind !== RESOURCE_KIND[entry.target]) return `${targetId} is a ${resource.kind.replaceAll('_', ' ')}; ${entry.name} needs a ${TARGET_LABEL[entry.target]}.`;
    if (resource.config.allocatable === false || resource.profile === 'brev_real') return 'The real attached GPU and its node never receive simulated faults.';
    return null;
  }
  if (snapshot && snapshot.resources.length > 0) return `${targetId} is not in this run.`;
  if (entry.target === 'pump' && !(PUMP_IDS as readonly string[]).includes(targetId)) return 'Choose pump-a or pump-b.';
  return ID_PATTERN[entry.target].test(targetId) ? null : `${targetId} is not a ${TARGET_LABEL[entry.target]}.`;
}

export function buildFaultInjection(input: FaultFormInput): FaultInjection {
  const entry = FAULT_CATALOG.find((row) => row.id === input.fault);
  if (!entry) throw new FaultFormError(`Unknown fault ${String(input.fault)}.`);
  if (!Number.isFinite(input.simTimeMs) || input.simTimeMs < 0) throw new FaultFormError('A current sim clock is required.');
  if (!DELAY_PRESETS_S.includes(input.delayS)) throw new FaultFormError(`Delay must be one of ${DELAY_PRESETS_S.join(', ')} sim-seconds.`);
  const problem = targetProblem(entry, input.targetId, input.snapshot);
  if (problem) throw new FaultFormError(problem);
  const durationS = input.durationS ?? null;
  if (durationS !== null) {
    if (!entry.expires) throw new FaultFormError(`${entry.name} is persistent: expiring it would not repair the hardware.`);
    if (!DURATION_PRESETS_S.includes(durationS)) throw new FaultFormError(`Duration must be persistent or one of ${DURATION_PRESETS_S.filter(Boolean).join(', ')} sim-seconds.`);
  }
  let severity = 1;
  const parameters: Record<string, unknown> = {};
  if (entry.severity) {
    severity = input.severity ?? entry.severity.default;
    if (!entry.severity.presets.includes(severity)) throw new FaultFormError(`${entry.severity.label} must be one of ${entry.severity.presets.map(entry.severity.format).join(', ')}.`);
    // descriptive only: physics reads severity (scenarios carry the same descriptions)
    if (entry.kind === 'cooling_pump_degradation') parameters.capacity_factor = round2(1 - severity);
    if (entry.kind === 'gpu_thermal_load') parameters.extra_temp_c = round2(severity * THERMAL_LOAD_MAX_C);
  }
  return {
    schema_version: '1.1.0', run_id: input.runId, fault_id: input.faultId, target_resource_id: input.targetId, kind: entry.kind,
    start_sim_time_ms: faultStartSimMs(input.simTimeMs, input.delayS), duration_sim_ms: durationS === null ? null : durationS * 1000,
    severity, parameters, seed_offset: 0,
  };
}

export interface TargetOption { id: string; label: string; disabledReason: string | null }

/** Targets of one type present in the snapshot (never the real GPU/node), each with why it is unavailable, if it is. */
export function targetOptions(type: TargetType, snapshot: Pick<ObservedSnapshot, 'resources' | 'gpus' | 'nodes'> | null): TargetOption[] {
  if (!snapshot) return [];
  const fromResources = snapshot.resources.filter((row) => row.kind === RESOURCE_KIND[type] && !REAL_RESOURCE_IDS.has(row.resource_id) && row.config.allocatable !== false && row.profile !== 'brev_real');
  if (type === 'gpu') {
    const ids = fromResources.length > 0 ? fromResources.map((row) => row.resource_id) : snapshot.gpus.map((row) => row.resource_id).filter((id) => !REAL_RESOURCE_IDS.has(id));
    return ids.map((id) => {
      const gpu = snapshot.gpus.find((row) => row.resource_id === id);
      const failed = gpu && (gpu.availability === 'unreachable' || gpu.last_xid_code !== null);
      return { id, label: id, disabledReason: failed ? `already failed${gpu.last_xid_code !== null ? ` (Xid ${gpu.last_xid_code})` : ''}` : null };
    });
  }
  if (type === 'node') {
    const ids = fromResources.length > 0 ? fromResources.map((row) => row.resource_id) : snapshot.nodes.map((row) => row.resource_id).filter((id) => !REAL_RESOURCE_IDS.has(id));
    return ids.map((id) => {
      const node = snapshot.nodes.find((row) => row.resource_id === id);
      return { id, label: node ? `${id} (${node.rack_id})` : id, disabledReason: node?.availability === 'unreachable' ? 'already unreachable' : null };
    });
  }
  if (type === 'checkpoint_store' && fromResources.length === 0) return [{ id: CHECKPOINT_STORE_ID, label: CHECKPOINT_STORE_ID, disabledReason: null }];
  return fromResources.map((row) => ({ id: row.resource_id, label: row.resource_id, disabledReason: null }));
}

/** The node that hosts `gpuId`, from the snapshot's GPU rows. */
export function nodeOfGpu(gpuId: string, snapshot: Pick<ObservedSnapshot, 'gpus'> | null): string | null {
  return snapshot?.gpus.find((row) => row.resource_id === gpuId)?.node_id ?? null;
}

/**
 * Observed share of nominal capacity a pump has now, and what is left after one more `loss`
 * (factors multiply). Uses the public cooling row; null when the row has no usable capacity numbers.
 */
export function effectivePumpCapacity(row: Pick<CoolingCurrent, 'nominal_capacity_w' | 'observed_capacity_estimate_w'> | undefined, loss: number): { now: number; after: number } | null {
  if (!row || !(row.nominal_capacity_w > 0) || typeof row.observed_capacity_estimate_w !== 'number') return null;
  const now = Math.max(0, Math.min(1, row.observed_capacity_estimate_w / row.nominal_capacity_w));
  return { now, after: now * (1 - loss) };
}

export type ScheduleState = 'pending' | 'start_reached' | 'ended' | 'fixture';

/**
 * Presenter-only view of a fault this session submitted. `pending` until the sim clock reaches its start;
 * `start_reached` afterwards (delivery is the tick's job; this does not claim an effect); `ended` once a finite
 * duration has elapsed. The fixture mock applies canned effects immediately and ignores the schedule (`fixture`).
 */
export function scheduleState(fault: Pick<FaultInjection, 'start_sim_time_ms'> & Partial<Pick<FaultInjection, 'duration_sim_ms'>>, simTimeMs: number, modeled: boolean): ScheduleState {
  if (!modeled) return 'fixture';
  if (simTimeMs < fault.start_sim_time_ms) return 'pending';
  const end = fault.duration_sim_ms == null ? null : fault.start_sim_time_ms + fault.duration_sim_ms;
  return end !== null && simTimeMs >= end ? 'ended' : 'start_reached';
}

/** Short presenter text for a submitted fault: catalog name, target and the chosen severity. */
export function describeFault(fault: FaultInjection): string {
  const isStore = /^ckpt-store-/.test(fault.target_resource_id);
  const entry = FAULT_CATALOG.find((row) => row.kind === fault.kind && (row.target === 'checkpoint_store') === isStore) ?? FAULT_CATALOG.find((row) => row.kind === fault.kind)!;
  const severity = entry.severity ? ` · ${entry.severity.format(fault.severity)}` : '';
  return `${entry.name} · ${fault.target_resource_id}${severity}`;
}


const round2 = (value: number) => Math.round(value * 100) / 100;
