// Hand-written deep clone of FacilityState (LANE-S §3: no built-in structured clone, no JSON round-trip).
import type { ComponentState, Edge, FacilityState, Failure } from '../types.js';

export function cloneComponent(c: ComponentState): ComponentState {
  return { ...c, params: { ...c.params } };
}

export function cloneFailure(f: Failure): Failure {
  return { ...f, params: { ...f.params } };
}

export function cloneEdge(e: Edge): Edge {
  return { ...e };
}

export function cloneState(s: FacilityState): FacilityState {
  const components: Record<string, ComponentState> = {};
  for (const id of Object.keys(s.components)) components[id] = cloneComponent(s.components[id]!);
  return {
    name: s.name,
    template: s.template,
    seed: s.seed,
    tick: s.tick,
    sim_time_s: s.sim_time_s,
    components,
    edges: s.edges.map(cloneEdge),
    failures: s.failures.map(cloneFailure),
  };
}
