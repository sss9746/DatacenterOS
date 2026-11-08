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

/** Rack numbers (1-based, ascending, unique) behind a list of `gpu-rN-…` ids. Ids without a rack are ignored. */
export const racksOfGpus = (gpuIds: readonly string[]): number[] =>
  [...new Set(gpuIds.map((id) => /^gpu-r(\d+)-/.exec(id)?.[1]).filter((n): n is string => n !== undefined).map(Number))].sort((a, b) => a - b);

/** Rack set per job from the observed allocations (jobs with no allocation are absent). */
export function jobRacks(allocations: ReadonlyArray<{ job_id: string; gpu_id: string }>): Record<string, number[]> {
  const byJob = new Map<string, string[]>();
  for (const row of allocations) byJob.set(row.job_id, [...(byJob.get(row.job_id) ?? []), row.gpu_id]);
  return Object.fromEntries([...byJob].map(([jobId, ids]) => [jobId, racksOfGpus(ids)]));
}

export interface JobMove { jobId: string; from: number[]; to: number[] }

/**
 * Jobs whose rack set changed between two observed allocation sets, with both sides non-empty: a job that merely lost
 * its allocation (failure) or gained its first one (start) is not a move. Pure; the view diffs consecutive snapshots.
 */
export function detectMoves(previous: Record<string, number[]>, next: Record<string, number[]>): JobMove[] {
  const moves: JobMove[] = [];
  for (const [jobId, to] of Object.entries(next)) {
    const from = previous[jobId];
    if (!from || from.length === 0 || to.length === 0) continue;
    if (from.length === to.length && from.every((n, i) => n === to[i])) continue;
    moves.push({ jobId, from, to });
  }
  return moves.sort((a, b) => a.jobId.localeCompare(b.jobId));
}

/** Pixel geometry of the rack grid, measured by the view (gap mirrors `--sim-rack-gap` in the stylesheet). */
export interface RackGridGeometry { width: number; height: number; cols: number; gap: number; bandHeight: number }

/** Column count the stylesheet's container queries pick for a given field width. Keep in sync with simulation-view.css. */
export const rackColumnsFor = (width: number): number => (width >= 720 ? 8 : width >= 400 ? 4 : 2);

/** Centre x and bottom y (px) of rack `n` inside the measured field. */
export function rackAnchor(n: number, g: RackGridGeometry): { x: number; top: number; bottom: number } {
  const rows = Math.ceil(8 / g.cols);
  const cellW = (g.width - g.gap * (g.cols - 1)) / g.cols;
  const cellH = (g.height - g.bandHeight - g.gap * (rows - 1)) / rows;
  const col = (n - 1) % g.cols; const row = Math.floor((n - 1) / g.cols);
  return { x: col * (cellW + g.gap) + cellW / 2, top: row * (cellH + g.gap), bottom: row * (cellH + g.gap) + cellH };
}

/**
 * SVG path for one coolant loop drawn in the band under a single-row rack grid: a riser from each rack's bottom edge
 * down to a header pipe at `laneY` px below the racks, joined left to right. Returns '' when the grid is wrapped
 * (the band is hidden there) or the loop has no racks.
 */
export function loopPath(racks: number[], laneY: number, g: RackGridGeometry): string {
  if (g.cols < 8 || racks.length === 0 || g.width <= 0) return '';
  const anchors = racks.map((n) => rackAnchor(n, g));
  const y = anchors[0]!.bottom + laneY;
  const header = `M ${anchors[0]!.x.toFixed(1)} ${y.toFixed(1)} H ${anchors.at(-1)!.x.toFixed(1)}`;
  const risers = anchors.map((a) => `M ${a.x.toFixed(1)} ${a.bottom.toFixed(1)} V ${y.toFixed(1)}`).join(' ');
  return `${header} ${risers}`;
}

/** Arc from the first old rack to the first new rack, bowing above the rack row(s), for the job-move flourish. */
export function moveArcPath(move: JobMove, g: RackGridGeometry): string {
  if (g.width <= 0) return '';
  const from = rackAnchor(move.from[0]!, g); const to = rackAnchor(move.to[0]!, g);
  const lift = Math.max(28, Math.abs(to.x - from.x) * 0.22);
  const y0 = from.top + 6; const y1 = to.top + 6;
  return `M ${from.x.toFixed(1)} ${y0.toFixed(1)} Q ${((from.x + to.x) / 2).toFixed(1)} ${(Math.min(y0, y1) - lift).toFixed(1)} ${to.x.toFixed(1)} ${y1.toFixed(1)}`;
}

/** Fraction of nominal capacity a pump has lost (0.6 for "60 % down"); null when the data does not say. */
export function capacityLoss(row: Pick<CoolingCurrent, 'nominal_capacity_w' | 'observed_capacity_estimate_w'> | undefined): number | null {
  if (!row || row.observed_capacity_estimate_w === null || !(row.nominal_capacity_w > 0)) return null;
  return Math.round((1 - row.observed_capacity_estimate_w / row.nominal_capacity_w) * 100) / 100;
}
