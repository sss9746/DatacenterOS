import type { CoolingCurrent, ObservedSnapshot, TelemetryEvent } from '@dcos/contracts';
import type { PumpId } from '../controls/fault-form';

/**
 * Pump ↔ rack mapping read from the observed snapshot, never hard-coded. Sources, in order:
 * 1. `cooling_loop` resources (`config.pump_id`, `config.rack_ids`, `config.supply_temp_c`), as P1's preset emits them;
 * 2. `rack` resources (`config.cooling_loop_id`) and `cooled_by` dependency edges, for snapshots without loop configs.
 * A snapshot with none of these yields no loops, and callers fall back to showing racks without a loop.
 */
export interface CoolingLoop {
  loopId: string;
  pumpId: string;
  /** Rack numbers (1-based) in ascending order, parsed from `rack-rN` ids. */
  racks: number[];
  /** Nominal coolant supply for the loop; null when the data does not say. */
  supplyC: number | null;
}

const rackNumber = (rackId: string): number | null => { const m = /^rack-r(\d+)$/.exec(rackId); return m ? Number(m[1]) : null; };
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

export function coolingLoops(snapshot: Pick<ObservedSnapshot, 'resources' | 'dependencies'>): CoolingLoop[] {
  const loops = new Map<string, CoolingLoop>();
  for (const r of snapshot.resources) {
    if (r.kind !== 'cooling_loop') continue;
    const pumpId = str(r.config.pump_id);
    if (!pumpId) continue;
    const rackIds = Array.isArray(r.config.rack_ids) ? (r.config.rack_ids as unknown[]).filter((id): id is string => typeof id === 'string') : [];
    loops.set(r.resource_id, { loopId: r.resource_id, pumpId, racks: rackIds.map(rackNumber).filter((n): n is number => n !== null), supplyC: num(r.config.supply_temp_c) });
  }
  // Racks that declare a loop the loop config did not list (or when loops carry no rack_ids).
  for (const r of snapshot.resources) {
    if (r.kind !== 'rack') continue;
    const n = rackNumber(r.resource_id);
    const loopId = str(r.config.cooling_loop_id) ?? snapshot.dependencies.find((e) => e.relation === 'cooled_by' && e.consumer_id === r.resource_id)?.provider_id ?? null;
    const loop = loopId ? loops.get(loopId) : undefined;
    if (n !== null && loop && !loop.racks.includes(n)) loop.racks.push(n);
  }
  return [...loops.values()].map((loop) => ({ ...loop, racks: [...loop.racks].sort((a, b) => a - b) })).sort((a, b) => a.pumpId.localeCompare(b.pumpId));
}

export const loopOfRack = (loops: CoolingLoop[], rack: number): CoolingLoop | undefined => loops.find((loop) => loop.racks.includes(rack));

export const isPumpId = (id: string): id is PumpId => id === 'pump-a' || id === 'pump-b';

/** "pump-a" → "Pump A"; any other id is shown as written. */
export const pumpLabel = (pumpId: string): string => { const m = /^pump-([a-z0-9]+)$/i.exec(pumpId); return m ? `Pump ${m[1]!.toUpperCase()}` : pumpId; };

/** Cooling rows of real pumps only (loop rows mirror their pump and would double-count). */
export function degradedPumps(snapshot: Pick<ObservedSnapshot, 'cooling' | 'resources'>): CoolingCurrent[] {
  const kinds = new Map(snapshot.resources.map((r) => [r.resource_id, r.kind]));
  return snapshot.cooling.filter((row) => (kinds.get(row.resource_id) ?? (row.resource_id.startsWith('pump-') ? 'cooling_pump' : null)) === 'cooling_pump' && row.operating_state !== 'normal');
}

/** [2,3,4] → "racks 2–4"; [1,5,6,7,8] → "racks 1 and 5–8"; [] → "no racks". */
export function rackRanges(racks: number[]): string {
  const sorted = [...new Set(racks)].sort((a, b) => a - b);
  if (sorted.length === 0) return 'no racks';
  const runs: string[] = [];
  let start = sorted[0]!; let prev = start;
  for (const n of sorted.slice(1).concat(NaN)) {
    if (n === prev + 1) { prev = n; continue; }
    runs.push(prev === start ? `${start}` : prev === start + 1 ? `${start}, ${prev}` : `${start}–${prev}`);
    start = n; prev = n;
  }
  const noun = sorted.length === 1 ? 'rack' : 'racks';
  return `${noun} ${runs.length <= 1 ? runs.join('') : `${runs.slice(0, -1).join(', ')} and ${runs.at(-1)}`}`;
}

/**
 * Rise of a rack's measured inlet over its nominal inlet, both from the data: the latest `rack.inlet_temp_c` sample
 * for `rack-rN` minus (loop `supply_temp_c` + rack `inlet_offset_c`). Null when either side is missing: no inlet
 * telemetry in the evidence window, or no nominal in the resource configs. Nothing is estimated.
 */
export function inletRiseC(rack: number, loop: CoolingLoop | undefined, snapshot: Pick<ObservedSnapshot, 'resources'>, telemetry: readonly TelemetryEvent[] | undefined): number | null {
  if (!loop || loop.supplyC === null || !telemetry?.length) return null;
  const rackId = `rack-r${rack}`;
  const offset = num(snapshot.resources.find((r) => r.resource_id === rackId)?.config.inlet_offset_c) ?? 0;
  let latest: TelemetryEvent | undefined;
  for (const row of telemetry) {
    if (row.resource_id !== rackId || row.metric !== 'rack.inlet_temp_c' || !['good', 'estimated'].includes(row.quality)) continue;
    if (!latest || row.sim_time_ms > latest.sim_time_ms) latest = row;
  }
  return latest ? Math.round((latest.value - (loop.supplyC + offset)) * 10) / 10 : null;
}

/** Signed one-decimal Celsius delta: 5.84 → "+5.8 °C", -0.3 → "−0.3 °C". */
export const formatDeltaC = (delta: number): string => `${delta < 0 ? '−' : '+'}${Math.abs(delta).toFixed(1)} °C`;
