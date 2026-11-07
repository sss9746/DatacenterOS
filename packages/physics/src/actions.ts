// Owned by S-2: LANE-S §3.2 applyAction.
import { TECH_REPAIR_TICKS } from './constants.js';
import { cloneState } from './internal/clone.js';
import type { Action, ComponentState, FacilityState } from './types.js';

function requireRack(c: ComponentState, kind: string): void {
  if (c.kind !== 'rack') throw new Error(`INVALID: ${kind} needs a rack target`);
}

function optionalKw(a: Action): number | undefined {
  const kw = a.params?.kw;
  if (kw === undefined || kw === null) return undefined;
  if (typeof kw !== 'number' || !Number.isFinite(kw) || kw < 0) throw new Error(`INVALID: ${a.kind} kw must be a number >= 0`);
  return kw;
}

function setStatus(c: ComponentState, st: ComponentState['true_status']): void {
  c.true_status = st;
  c.observed_status = st;
}

export function applyAction(s: FacilityState, a: Action): FacilityState {
  const target = s.components[a.target_id];
  if (!target) throw new Error(`NOT_FOUND: component ${a.target_id}`);
  const n = cloneState(s);
  const c = n.components[a.target_id]!;

  switch (a.kind) {
    case 'shutdown_component':
      setStatus(c, 'shutdown');
      break;
    case 'restore_component': {
      const faulted = n.failures.some(
        (f) => f.active && f.target_id === a.target_id && (f.kind === 'pump_fail' || f.kind === 'utility_loss'),
      );
      if (faulted) throw new Error(`INVALID: ${a.target_id} has an active fault; dispatch_tech required`);
      setStatus(c, 'online');
      break;
    }
    case 'shed_load': {
      requireRack(c, a.kind);
      const kw = optionalKw(a);
      c.load_kw = Math.max(0, c.load_kw - (kw ?? c.load_kw));
      break;
    }
    case 'migrate_load': {
      requireRack(c, a.kind);
      const to = a.params?.to;
      const dest = typeof to === 'string' && to !== a.target_id ? n.components[to] : undefined;
      if (!dest || dest.kind !== 'rack' || dest.true_status === 'shutdown') throw new Error('INVALID: migrate target');
      const kw = optionalKw(a);
      const moved = Math.min(kw ?? c.load_kw, c.load_kw);
      c.load_kw -= moved;
      dest.load_kw += moved;
      break;
    }
    case 'set_load': {
      requireRack(c, a.kind);
      const kw = optionalKw(a);
      if (kw === undefined) throw new Error('INVALID: set_load needs kw >= 0');
      c.load_kw = kw;
      break;
    }
    case 'dispatch_tech':
      c.repair_eta_tick = n.tick + TECH_REPAIR_TICKS;
      break;
    default:
      throw new Error(`INVALID: unknown action kind ${String((a as Action).kind)}`);
  }
  return n;
}
