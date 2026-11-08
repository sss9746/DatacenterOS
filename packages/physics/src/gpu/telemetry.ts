// Observations emitted by a tick: TelemetryEvent gauges (at most one sample per (resource, metric) per tick, so
// ≤ 1 Hz per GPU at step_ms 1000) and discrete SignalEvents (XIDs are always signals, never gauges; event_type
// 'xid_error' per the schema enum). Every value is simulated: source_kind 'simulator', quality 'estimated'.
import type { PhysicsWorld, SignalEvent, TelemetryEvent } from '@dcos/contracts';
import {
  RUN_EPOCH_UNIX_MS,
  SEQ_PER_TICK,
  SHUTDOWN_C,
  SIGNAL_SEQ_BASE,
  SIM_SOURCE_ID,
  WIRE_SCHEMA_VERSION as V,
  round1,
} from './constants.js';
import type { SignalDraft, TickCtx } from './jobs.js';
import { isSimulatedGpu, rackInletC, type FaultConditions, type HiddenState, type Topology } from './world.js';

const unixMs = (simMs: number) => RUN_EPOCH_UNIX_MS + simMs;
const BASE_LABELS = { simulated: 'true', hardware_backed: 'false' } as const;

export function emitTelemetry(
  world: PhysicsWorld, h: HiddenState, topo: Topology, cond: FaultConditions, ctx: TickCtx,
): TelemetryEvent[] {
  const t = ctx.t1;
  const runId = world.run_id;
  const out: TelemetryEvent[] = [];
  const emit = (
    resource_id: string, metric: string, value: number, unit: string, quality: TelemetryEvent['quality'],
    extra: Record<string, string> = {},
  ) => {
    out.push({
      schema_version: V, event_id: `tel.${t}.${resource_id}.${metric}`, run_id: runId, resource_id,
      source_kind: 'simulator', source_id: SIM_SOURCE_ID, source_seq: ctx.tick * SEQ_PER_TICK + out.length,
      observed_unix_ms: unixMs(t), sim_time_ms: t, metric, value, unit, quality,
      labels: { ...BASE_LABELS, ...extra },
    });
  };

  for (const g of world.observable.gpus) {
    if (!isSimulatedGpu(g.resource_id, topo)) continue; // gpu-real-0's samples come from nvidia-smi, never the simulator
    const labels = { profile: topo.resources.get(g.resource_id)?.profile ?? 'demo_gpu', node_id: g.node_id };
    if (g.availability === 'unreachable') {
      // the GPU fell off the bus: one 'missing' sample carrying the last value seen (no clock/power/reasons)
      emit(g.resource_id, 'DCGM_FI_DEV_GPU_TEMP_CELSIUS', g.temp_c, 'degC', 'missing', labels);
      continue;
    }
    const q = cond.stale.has(g.resource_id) ? 'stale' : 'estimated';
    emit(g.resource_id, 'DCGM_FI_DEV_GPU_TEMP_CELSIUS', g.temp_c, 'degC', q, labels);
    emit(g.resource_id, 'DCGM_FI_DEV_SM_CLOCK', g.sm_clock_mhz, 'MHz', q, labels);
    emit(g.resource_id, 'DCGM_FI_DEV_POWER_USAGE', g.power_w, 'W', q, labels);
    emit(g.resource_id, 'DCGM_FI_DEV_CLOCKS_EVENT_REASONS', g.clocks_event_reasons, 'ratio', q, labels);
  }
  for (const rack of topo.racks) {
    const key = `${rack}|inlet_temp_c`;
    const live = round1(rackInletC(rack, h, topo));
    const stale = cond.stale.has(rack);
    if (stale && h.stale_values[key] === undefined) h.stale_values[key] = live;
    if (!stale) delete h.stale_values[key];
    emit(rack, 'rack.inlet_temp_c', stale ? h.stale_values[key]! : live, 'degC', stale ? 'stale' : 'estimated',
      { cooling_loop_id: topo.rackLoop.get(rack) ?? '' });
  }
  // pump.power_w is a pump metric: loop rows of cooling_current (CONTRACTS §0.11 #9) mirror their pump, no sample
  for (const c of world.observable.cooling) {
    if (topo.resources.get(c.resource_id)?.kind !== 'cooling_pump') continue;
    emit(c.resource_id, 'pump.power_w', c.pump_power_w, 'W', cond.stale.has(c.resource_id) ? 'stale' : 'estimated');
  }
  if (out.length >= SIGNAL_SEQ_BASE) throw new Error(`physics: ${out.length} telemetry samples overflow the per-tick source_seq block`);
  return out;
}

type SignalBody = Pick<SignalEvent, 'resource_id' | 'event_type' | 'xid_code' | 'severity' | 'message' | 'evidence'>;

function gpuWhere(world: PhysicsWorld, topo: Topology, gpuId: string) {
  const node = topo.gpuNode.get(gpuId) ?? world.observable.gpus.find((g) => g.resource_id === gpuId)?.node_id ?? null;
  return { gpu_id: gpuId, node_id: node, rack_id: topo.gpuRack.get(gpuId) ?? null };
}

function signalBody(world: PhysicsWorld, topo: Topology, d: SignalDraft): SignalBody | null {
  if (d.kind === 'thermal_shutdown') {
    return {
      resource_id: d.gpu_id, event_type: 'gpu_unreachable', xid_code: null, severity: 'critical',
      message: `GPU reached the ${SHUTDOWN_C} °C shutdown temperature and powered off (simulated)`,
      evidence: { ...gpuWhere(world, topo, d.gpu_id), temp_c: d.temp_c, shutdown_temp_c: SHUTDOWN_C, simulated: true },
    };
  }
  const f = d.fault;
  const target = f.target_resource_id;
  const kind = topo.resources.get(target)?.kind;
  if (d.kind === 'fault_cleared') {
    if (f.kind === 'gpu_thermal_load' || f.kind === 'sensor_stale' || f.kind.startsWith('gpu_xid')) return null;
    return {
      resource_id: target, event_type: 'resource_recovered', xid_code: null, severity: 'info',
      message: `${target} back to normal (simulated)`, evidence: { simulated: true },
    };
  }
  const storageDown = (): SignalBody => ({
    resource_id: target, event_type: 'equipment_alarm', xid_code: null, severity: 'warning',
    message: `${target} unreachable: checkpoints on it cannot be read or written (simulated)`,
    evidence: { accessible: false, simulated: true },
  });
  switch (f.kind) {
    case 'cooling_pump_degradation':
    case 'cooling_pump_outage': {
      const row = world.observable.cooling.find((c) => c.resource_id === target);
      const loop = topo.loops.find((l) => (topo.loopPumps.get(l) ?? []).includes(target)) ?? null;
      const outage = f.kind === 'cooling_pump_outage';
      return {
        resource_id: target, event_type: 'equipment_alarm', xid_code: null, severity: outage ? 'critical' : 'warning',
        message: outage
          ? `${target} stopped: no coolant flow (simulated)`
          : `${target} low-flow alarm: pump power below nominal (simulated)`,
        evidence: {
          operating_state: row?.operating_state ?? null, pump_power_w: row?.pump_power_w ?? null,
          nominal_pump_power_w: topo.pumpNominalPowerW.get(target) ?? null, cooling_loop_id: loop, simulated: true,
        },
      };
    }
    case 'gpu_xid_79':
    case 'gpu_xid_48':
    case 'gpu_xid_74': {
      const code = f.kind === 'gpu_xid_79' ? 79 : f.kind === 'gpu_xid_48' ? 48 : 74;
      const text = code === 79 ? 'GPU has fallen off the bus' : code === 48 ? 'double-bit ECC error' : 'NVLink error';
      return {
        resource_id: target, event_type: 'xid_error', xid_code: code, severity: code === 74 ? 'warning' : 'critical',
        message: `Xid ${code}: ${text} (simulated)`,
        evidence: { xid_code: code, ...gpuWhere(world, topo, target), dcgm_field: 'DCGM_FI_DEV_XID_ERROR', dcgm_field_id: 230, simulated: true },
      };
    }
    case 'node_crash':
      if (kind === 'checkpoint_store') return storageDown();
      return {
        resource_id: target, event_type: 'node_unreachable', xid_code: null, severity: 'critical',
        message: `${target} stopped responding (simulated)`, evidence: { simulated: true },
      };
    case 'network_link_down':
      if (kind === 'checkpoint_store') return storageDown();
      return {
        resource_id: target, event_type: 'equipment_alarm', xid_code: null, severity: 'warning',
        message: `${target} link down (simulated)`, evidence: { simulated: true },
      };
    default:
      return null; // gpu_thermal_load and sensor_stale show up only through telemetry
  }
}

/** Build the tick's SignalEvents from the drafts, against the final world (so evidence shows end-of-tick values). */
export function buildSignals(world: PhysicsWorld, topo: Topology, ctx: TickCtx): SignalEvent[] {
  const t = ctx.t1;
  const out: SignalEvent[] = [];
  const used = new Set<string>();
  for (const d of ctx.signals) {
    const body = signalBody(world, topo, d);
    if (!body) continue;
    let id = `sig.${t}.${body.resource_id}.${body.event_type}`;
    for (let n = 2; used.has(id); n++) id = `sig.${t}.${body.resource_id}.${body.event_type}.${n}`;
    used.add(id);
    out.push({
      schema_version: V, event_id: id, run_id: world.run_id, resource_id: body.resource_id,
      source_kind: 'simulator', source_id: SIM_SOURCE_ID, source_seq: ctx.tick * SEQ_PER_TICK + SIGNAL_SEQ_BASE + out.length,
      sim_time_ms: t, observed_unix_ms: unixMs(t), event_type: body.event_type, xid_code: body.xid_code,
      severity: body.severity, message: body.message, evidence: body.evidence,
    });
  }
  if (out.length > SEQ_PER_TICK - SIGNAL_SEQ_BASE) throw new Error('physics: too many signals in one tick');
  return out;
}
