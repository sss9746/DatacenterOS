// toObserved(world): the planner-visible ObservedSnapshot. A fresh deep copy of world.observable with every
// private key removed (defense in depth: physics never writes them into the observable in the first place).
import type { ObservedSnapshot, PhysicsWorld } from '@dcos/contracts';
import { cloneJson } from './world.js';

/** Keys that must never reach an agent, a public subscription or PlanMetrics (CONTRACTS §D, LANE-P1 rules). */
export const PRIVATE_KEYS: readonly string[] = ['active_faults_private', 'hidden_physics_state_json', 'due_faults_private'];

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      if (!PRIVATE_KEYS.includes(k)) out[k] = strip((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function toObserved(world: PhysicsWorld): ObservedSnapshot {
  return strip(cloneJson(world.observable)) as ObservedSnapshot;
}
