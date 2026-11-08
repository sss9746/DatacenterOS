// Pure nvidia-smi CSV -> TelemetryEvent mapping (no I/O). Wire format: plans/team/REAL-GPU.md.
// Must match apps/web/src/components/heatmap/RealGpu.tsx exactly (resource, source_kind, labels.collector, metric names).
import type { TelemetryEvent } from '@dcos/contracts';

export const RESOURCE_ID = 'gpu-real-0';
export const COLLECTOR_LABEL = 'nvidia-smi';
export const DEFAULT_SOURCE_ID = 'nvsmi-brev-1';

/** Newer drivers renamed clocks_throttle_reasons -> clocks_event_reasons. Detected once at startup. */
export type ReasonField = 'clocks_event_reasons.active' | 'clocks_throttle_reasons.active';

/** Pick the throttle-reason field from `nvidia-smi --help-query-gpu` output. Prefers the newer name. */
export function detectReasonField(helpQueryGpuText: string): ReasonField {
  return helpQueryGpuText.includes('clocks_event_reasons.active')
    ? 'clocks_event_reasons.active'
    : 'clocks_throttle_reasons.active';
}

interface MetricSpec {
  readonly field: string;
  readonly metric: string;
  readonly unit: string;
  readonly parse: (raw: string) => number | null;
}

/** Numbers like "61", "72.35". Anything else ([N/A], [Not Supported], blank) -> null = skip, never 0. */
function parseDecimal(raw: string): number | null {
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** "0x0000000000000020" -> 32. Non-hex ([N/A]) -> null. */
function parseHexMask(raw: string): number | null {
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) return null;
  const n = Number(BigInt(raw));
  return Number.isSafeInteger(n) ? n : null;
}

function metricSpecs(reasonField: ReasonField): readonly MetricSpec[] {
  return [
    { field: 'temperature.gpu', metric: 'nvidia_smi.temperature_gpu', unit: 'C', parse: parseDecimal },
    { field: 'power.draw', metric: 'nvidia_smi.power_draw', unit: 'W', parse: parseDecimal },
    {
      field: 'utilization.gpu',
      metric: 'nvidia_smi.utilization_gpu',
      unit: 'ratio',
      // nvidia-smi reports percent; the tile expects a 0-1 fraction and multiplies by 100.
      parse: (raw) => {
        const pct = parseDecimal(raw);
        return pct === null ? null : pct / 100;
      },
    },
    { field: 'clocks.sm', metric: 'nvidia_smi.clocks_sm', unit: 'MHz', parse: parseDecimal },
    { field: 'power.limit', metric: 'nvidia_smi.power_limit', unit: 'W', parse: parseDecimal },
    { field: reasonField, metric: 'nvidia_smi.clocks_event_reasons', unit: 'bitmask', parse: parseHexMask },
  ];
}

/**
 * Query field order. `name` goes LAST so a GPU name containing ", " can't shift the numeric columns.
 * Use with `--format=csv,noheader,nounits`.
 */
export function queryFields(reasonField: ReasonField): string[] {
  return [...metricSpecs(reasonField).map((s) => s.field), 'name'];
}

export interface ParsedRow {
  readonly gpuName: string;
  /** metric name -> value; metrics whose raw value was [N/A] etc. are absent. */
  readonly values: ReadonlyMap<string, { value: number; unit: string }>;
}

/** Parse one `csv,noheader,nounits` line. Returns null for blank/short/garbage lines. */
export function parseCsvLine(line: string, reasonField: ReasonField): ParsedRow | null {
  const specs = metricSpecs(reasonField);
  const cells = line.trim().split(',').map((c) => c.trim());
  if (cells.length < specs.length + 1) return null;
  const gpuName = cells.slice(specs.length).join(', ').trim();
  const values = new Map<string, { value: number; unit: string }>();
  specs.forEach((spec, i) => {
    const v = spec.parse(cells[i] ?? '');
    if (v !== null) values.set(spec.metric, { value: v, unit: spec.unit });
  });
  if (values.size === 0) return null;
  return { gpuName, values };
}

export interface EventContext {
  readonly runId: string;
  readonly sourceId: string;
  readonly sourceKind: 'hardware' | 'replay';
  readonly observedUnixMs: number;
  /** Returns the next strictly increasing source_seq. */
  readonly nextSeq: () => number;
  readonly host: string;
  readonly extraLabels?: Readonly<Record<string, string>>;
}

/** One TelemetryEvent per present metric. sim_time_ms is 0: the reducer stamps the run clock. */
export function rowToEvents(row: ParsedRow, ctx: EventContext): TelemetryEvent[] {
  const prefix = ctx.sourceKind === 'hardware' ? 'hw' : 'replay';
  const labels: Record<string, string> = {
    collector: COLLECTOR_LABEL,
    gpu_name: row.gpuName || 'unknown',
    host: ctx.host,
    ...ctx.extraLabels,
  };
  return [...row.values.entries()].map(([metric, { value, unit }]) => ({
    schema_version: '1.1.0',
    event_id: `${prefix}.${ctx.observedUnixMs}.${RESOURCE_ID}.${metric}`,
    run_id: ctx.runId,
    resource_id: RESOURCE_ID,
    source_kind: ctx.sourceKind,
    source_id: ctx.sourceId,
    source_seq: ctx.nextSeq(),
    observed_unix_ms: ctx.observedUnixMs,
    sim_time_ms: 0,
    metric,
    value,
    unit,
    quality: 'good',
    labels: { ...labels },
  }));
}

/** Strictly increasing counter, seeded from Date.now() so restarts/reconnects never go backwards. */
export function createSeq(seed: number = Date.now()): () => number {
  let last = Math.floor(seed);
  return () => {
    last += 1;
    return last;
  };
}

/** Strictly increasing observed_unix_ms, so event_ids stay unique even if two lines land in the same ms. */
export function createMonotonicClock(now: () => number = Date.now): () => number {
  let last = 0;
  return () => {
    last = Math.max(now(), last + 1);
    return last;
  };
}
