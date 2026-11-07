// Owned by S-4: LANE-S §3.2 checkAction. Reason prefixes are frozen by CONTRACTS §2 (C's agents parse them).
import { SAFETY_HORIZON_TICKS, T_DEGRADED_C } from './constants.js';
import { simulateTrace, type SimTrace } from './simulate.js';
import type { Action, FacilityState, Rng, SafetyResult } from './types.js';

/** The projection length used for the "; projected: …" suffix of a BLOCKED reason. */
const PROJECTION_TICKS = 600;
const PEAK_TOLERANCE_C = 0.5;
const MARGIN_TOLERANCE_KW = 1;

// LANE-S §3.2 fmt. TODO(S-2 merge): switch to `import { fmt } from './internal/format.js'` once S-2 lands it.
const fmt = (x: number): string => String(Math.round(x * 10) / 10);

function shutdownPhrase(tr: SimTrace): string {
  return `${tr.outcome.racks_shutdown} racks shut down within ${fmt(tr.shutdown_reached_s)} s`;
}

function blockedReason(act: SimTrace, base: SimTrace): string | null {
  const a = act.outcome;
  const b = base.outcome;
  if (a.racks_shutdown > b.racks_shutdown) {
    return `BLOCKED: ${shutdownPhrase(act)}`;
  }
  if (a.peak_temp_c > T_DEGRADED_C && a.peak_temp_c > b.peak_temp_c + PEAK_TOLERANCE_C) {
    return `BLOCKED: rack ${act.peak_rack_id} exceeds ${T_DEGRADED_C} °C`;
  }
  if (a.min_cooling_margin_kw < -MARGIN_TOLERANCE_KW && a.min_cooling_margin_kw < b.min_cooling_margin_kw - MARGIN_TOLERANCE_KW) {
    return `BLOCKED: cooling ${fmt(act.worst_cooling_kw)} kW < load ${fmt(act.worst_load_kw)} kW`;
  }
  return null;
}

function projectionSuffix(s: FacilityState, a: Action, rng: Rng): string {
  const proj = simulateTrace(s, [a], PROJECTION_TICKS, rng);
  if (proj.outcome.racks_shutdown > 0) return `; projected: ${shutdownPhrase(proj)}`;
  return `; projected: peak ${fmt(proj.outcome.peak_temp_c)} °C in ${PROJECTION_TICKS} s`;
}

/**
 * The safety engine behind request_action (run on the TRUE state). Blocks only when the action is worse than doing
 * nothing over the horizon, so a helpful action in an already-bad state stays allowed. Never throws for a bad action.
 */
export function checkAction(s: FacilityState, a: Action, rng: Rng, horizonTicks: number = SAFETY_HORIZON_TICKS): SafetyResult {
  const h = horizonTicks;
  const base = simulateTrace(s, [], h, rng);

  let act: SimTrace;
  try {
    act = simulateTrace(s, [a], h, rng);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `BLOCKED: invalid action: ${msg}`, predicted: base.outcome };
  }

  const blocked = blockedReason(act, base);
  if (blocked !== null) {
    return { ok: false, reason: blocked + projectionSuffix(s, a, rng), predicted: act.outcome };
  }
  const o = act.outcome;
  return {
    ok: true,
    reason: `OK: margin ${fmt(o.min_cooling_margin_kw)} kW, peak ${fmt(o.peak_temp_c)} °C over ${fmt(h)} s`,
    predicted: o,
  };
}
