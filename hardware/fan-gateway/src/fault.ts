import type { FaultInjection } from '@dcos/contracts';

export const TARGET_PUMP = 'pump-a';
export const PUMP_LOSS = 0.6; // the dashboard's default preset
const STEP_MS = 1000; // @dcos/physics STEP_MS: "delay 0" = next tick, as the dashboard does

/** Same payload the presenter's pump-a fault control builds (apps/web fault-form.ts buildFaultInjection). */
export function buildStallFault(runId: string, simTimeMs: number, nowEpochMs: number): FaultInjection {
  return {
    schema_version: '1.1.0', run_id: runId, fault_id: `fan-stall-${nowEpochMs}`, target_resource_id: TARGET_PUMP,
    kind: 'cooling_pump_degradation', start_sim_time_ms: simTimeMs + STEP_MS, duration_sim_ms: null,
    severity: PUMP_LOSS, parameters: { capacity_factor: Math.round((1 - PUMP_LOSS) * 100) / 100 }, seed_offset: 0,
  };
}
