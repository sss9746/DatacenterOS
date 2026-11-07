// Owned by S-4: LANE-S §3.2 simulate. Pure: applyAction/step return new states, the input is never mutated.
import { applyAction } from './actions.js';
import { computeBalance } from './balance.js';
import { step } from './step.js';
import { T_AMBIENT_C } from './constants.js';
import type { Action, FacilityState, Outcome, Rng } from './types.js';

const SIM_DT_S = 1;

/** Internal (not exported from index): the Outcome plus the details checkAction needs for its reason strings. */
export interface SimTrace {
  outcome: Outcome;
  /** C and Q_it at the first tick where the margin hit its minimum. */
  worst_cooling_kw: number;
  worst_load_kw: number;
  /** The rack that reached peak_temp_c ('' if there are no racks). */
  peak_rack_id: string;
  /** Elapsed seconds at which the last distinct rack shut down (0 if none, or only ones already down at start). */
  shutdown_reached_s: number;
}

interface Tracker {
  minMargin: number;
  worstCooling: number;
  worstLoad: number;
  peak: number;
  peakRackId: string;
  degraded: Set<string>;
  shutdown: Set<string>;
  shutdownReachedS: number;
  downtime: number;
}

function rackIds(s: FacilityState): string[] {
  return Object.keys(s.components)
    .filter((id) => s.components[id].kind === 'rack')
    .sort();
}

/** Records one state (truth view). elapsedS = seconds since the start of the run. */
function observe(t: Tracker, s: FacilityState, racks: string[], elapsedS: number): number {
  const bal = computeBalance(s, 'true');
  if (bal.margin_kw < t.minMargin) {
    t.minMargin = bal.margin_kw;
    t.worstCooling = bal.cooling_kw;
    t.worstLoad = bal.load_kw;
  }
  let down = 0;
  for (const id of racks) {
    const c = s.components[id];
    if (c.true_temp_c > t.peak) {
      t.peak = c.true_temp_c;
      t.peakRackId = id;
    }
    if (c.true_status === 'shutdown') {
      down += 1;
      if (!t.shutdown.has(id)) {
        t.shutdown.add(id);
        t.shutdownReachedS = elapsedS;
      }
    } else if (c.true_status === 'degraded') {
      down += 1;
      t.degraded.add(id);
    }
  }
  return down;
}

/** simulate() with extra trace detail. Throws (via applyAction) on an invalid action. */
export function simulateTrace(s: FacilityState, actions: Action[], ticks: number, rng: Rng): SimTrace {
  if (!Number.isFinite(ticks) || ticks < 0) {
    throw new Error('INVALID: ticks must be a non-negative number');
  }
  const n = Math.floor(ticks);
  let cur = s;
  for (const a of actions) cur = applyAction(cur, a);

  const racks = rackIds(cur);
  const initial = computeBalance(cur, 'true');
  const t: Tracker = {
    minMargin: initial.margin_kw,
    worstCooling: initial.cooling_kw,
    worstLoad: initial.load_kw,
    peak: racks.length > 0 ? -Infinity : T_AMBIENT_C,
    peakRackId: '',
    degraded: new Set(),
    shutdown: new Set(),
    shutdownReachedS: 0,
    downtime: 0,
  };
  observe(t, cur, racks, 0);

  for (let k = 1; k <= n; k++) {
    cur = step(cur, SIM_DT_S, rng);
    t.downtime += SIM_DT_S * observe(t, cur, racks, k * SIM_DT_S);
  }

  let degradedOnly = 0;
  for (const id of t.degraded) if (!t.shutdown.has(id)) degradedOnly += 1;

  return {
    outcome: {
      min_cooling_margin_kw: t.minMargin,
      peak_temp_c: t.peak,
      racks_degraded: degradedOnly,
      racks_shutdown: t.shutdown.size,
      downtime_rack_s: t.downtime,
    },
    worst_cooling_kw: t.worstCooling,
    worst_load_kw: t.worstLoad,
    peak_rack_id: t.peakRackId,
    shutdown_reached_s: t.shutdownReachedS,
  };
}

/**
 * Counterfactual run: applies `actions` to a copy of `s`, then runs `ticks` steps with dt = 1 s on the TRUE state.
 * Returns only the Outcome (never hidden fields). An invalid action throws Error('INVALID: …' | 'NOT_FOUND: …').
 */
export function simulate(s: FacilityState, actions: Action[], ticks: number, rng: Rng): Outcome {
  return simulateTrace(s, actions, ticks, rng).outcome;
}
