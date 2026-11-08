import type { ObservedSnapshot } from '@dcos/contracts';
import {
  CHECKPOINT_DURATION_MS, IDLE_LOAD, LOOP_SUPPLY_C, PLANNER_HORIZON_S, POWER_CAP_CLOCK_FACTOR, POWER_CAP_W, POWER_LIMIT_W,
  R6_INLET_OFFSET_C, REQUIRED_THERMAL_HEADROOM_C, RESTART_DURATION_MS, RUN_START_SIM_MS, SAFETY_LOOKAHEAD_S, SHUTDOWN_C,
  SLOWDOWN_C, SM_CLOCK_NOMINAL_MHZ, STEP_MS, THROTTLE_CLOCK_FACTOR,
} from '@dcos/physics';
import { Badge } from '../ui/panel';
import { number } from '../../lib/utils';

/**
 * Scope §2 numeric model contract. Every value is read from the P1 physics package (or, for pump capacity, from the
 * observed cooling rows), so this panel cannot drift from the engine. Read-only: nothing here is editable.
 */
export function ModelAssumptions({ snapshot }: { snapshot: ObservedSnapshot }) {
  const pump = (id: string) => snapshot.cooling.find((row) => row.resource_id === id)?.nominal_capacity_w;
  const kw = (w: number | undefined) => (w === undefined ? 'not reported' : `${number(w / 1000, 0)} kW`);
  const rows: Array<[string, string]> = [
    ['Run start / tick', `${number(RUN_START_SIM_MS)} sim-ms / ${number(STEP_MS)} sim-ms`],
    ['GPU draw: nominal / idle / capped', `${POWER_LIMIT_W} W / ${number(POWER_LIMIT_W * IDLE_LOAD)} W / ${POWER_CAP_W} W`],
    ['Clock: nominal / thermal / cap factor', `${number(SM_CLOCK_NOMINAL_MHZ)} MHz / ${THROTTLE_CLOCK_FACTOR} / ${POWER_CAP_CLOCK_FACTOR}`],
    ['Healthy inlet / hot rack 6 offset', `${LOOP_SUPPLY_C} °C / +${R6_INLET_OFFSET_C} °C`],
    ['Slowdown / shutdown', `${SLOWDOWN_C} °C / ${SHUTDOWN_C} °C`],
    ['Pump capacity (nominal)', `A ${kw(pump('pump-a'))} · B ${kw(pump('pump-b'))}`],
    ['Checkpoint / restart', `${CHECKPOINT_DURATION_MS / 1000} / ${RESTART_DURATION_MS / 1000} sim-s`],
    ['Plan horizon / safety look-ahead', `${PLANNER_HORIZON_S} / ${SAFETY_LOOKAHEAD_S} sim-s`],
    ['Required destination thermal margin', `${REQUIRED_THERMAL_HEADROOM_C} °C`],
  ];
  return <details className="sim-more model-assumptions" id="model-assumptions">
    <summary>Model assumptions <Badge>Simulated defaults</Badge></summary>
    <dl className="model-assumptions-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p className="model-assumptions-note">Illustrative GPU profile, not calibrated hardware. Power is modeled GPU draw only, not rack input. Forecasts assume no hidden future faults. These values are fixed for the demonstration.</p>
  </details>;
}
