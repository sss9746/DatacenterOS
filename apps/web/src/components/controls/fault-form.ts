import type { CoolingCurrent, FaultInjection } from '@dcos/contracts';
import { STEP_MS } from '@dcos/physics';

/**
 * The two presenter fault controls of IMPLEMENTATION-SCOPE §3, over the existing admin `injectFault`.
 *
 * Encoding (read from @dcos/physics `faultConditions` in gpu/world.ts): a `cooling_pump_degradation` removes
 * `severity` of the pump's capacity. Its factor is `1 - severity`, and several active degradations on one pump
 * multiply (two 0.6 losses leave 0.4 × 0.4 = 16 %). `parameters` is not read by physics for this kind; the
 * checked-in scenarios carry `parameters.capacity_factor = 1 - severity` as a description, and so do we.
 * `gpu_xid_79` latches the GPU as unreachable; severity is fixed at 1.
 */
export type FaultControlKind = 'cooling_pump_degradation' | 'gpu_xid_79';
export type PumpId = 'pump-a' | 'pump-b';
export const PUMP_IDS: readonly PumpId[] = ['pump-a', 'pump-b'];
export const PUMP_LOSS_PRESETS = [0.3, 0.6, 0.8] as const;
export type PumpLoss = (typeof PUMP_LOSS_PRESETS)[number];
export const DEFAULT_PUMP_LOSS: PumpLoss = 0.6;
export const DELAY_PRESETS_S = [0, 10, 30] as const;
export type FaultDelayS = (typeof DELAY_PRESETS_S)[number];
/** The real attached GPU and its node never receive simulated faults. */
export const REAL_RESOURCE_IDS: ReadonlySet<string> = new Set(['gpu-real-0', 'node-real-0']);

export interface FaultFormInput {
  kind: FaultControlKind;
  runId: string;
  /** Sim clock of a snapshot read immediately before submitting. */
  simTimeMs: number;
  targetId: string;
  delayS: FaultDelayS;
  /** Capacity fraction removed; required for the pump fault, ignored for Xid 79. */
  capacityLoss?: PumpLoss;
  faultId: string;
}

export class FaultFormError extends Error {}

/** Delay 0 means the next tick: the current sim clock plus one physics step; otherwise the selected offset. */
export function faultStartSimMs(simTimeMs: number, delayS: FaultDelayS): number {
  return simTimeMs + (delayS === 0 ? STEP_MS : delayS * 1000);
}

export function buildFaultInjection(input: FaultFormInput): FaultInjection {
  const { kind, targetId, delayS } = input;
  if (!Number.isFinite(input.simTimeMs) || input.simTimeMs < 0) throw new FaultFormError('A current sim clock is required.');
  if (!DELAY_PRESETS_S.includes(delayS)) throw new FaultFormError(`Delay must be one of ${DELAY_PRESETS_S.join(', ')} sim-seconds.`);
  const start_sim_time_ms = faultStartSimMs(input.simTimeMs, delayS);
  const common = {
    schema_version: '1.1.0' as const, run_id: input.runId, fault_id: input.faultId, target_resource_id: targetId,
    start_sim_time_ms, duration_sim_ms: null, seed_offset: 0,
  };
  if (kind === 'cooling_pump_degradation') {
    if (!(PUMP_IDS as readonly string[]).includes(targetId)) throw new FaultFormError('Choose pump-a or pump-b.');
    const loss = input.capacityLoss;
    if (loss === undefined || !PUMP_LOSS_PRESETS.includes(loss)) {
      throw new FaultFormError(`Capacity loss must be one of ${PUMP_LOSS_PRESETS.map(percent).join(', ')}.`);
    }
    return { ...common, kind, severity: loss, parameters: { capacity_factor: round2(1 - loss) } };
  }
  if (kind === 'gpu_xid_79') {
    if (REAL_RESOURCE_IDS.has(targetId) || !/^gpu-/.test(targetId)) throw new FaultFormError('Choose a simulated GPU.');
    return { ...common, kind, severity: 1, parameters: {} };
  }
  throw new FaultFormError('Only the pump degradation and Xid 79 controls are supported.');
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

export type ScheduleState = 'pending' | 'start_reached' | 'fixture';

/**
 * Presenter-only view of a fault this session submitted. `pending` until the sim clock reaches its start;
 * `start_reached` afterwards (delivery is the DB tick's job; this does not claim an effect). The fixture mock
 * applies canned effects immediately and ignores the start time, so it reports `fixture`.
 */
export function scheduleState(fault: Pick<FaultInjection, 'start_sim_time_ms'>, simTimeMs: number, modeled: boolean): ScheduleState {
  if (!modeled) return 'fixture';
  return simTimeMs >= fault.start_sim_time_ms ? 'start_reached' : 'pending';
}

export const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
const round2 = (value: number) => Math.round(value * 100) / 100;
