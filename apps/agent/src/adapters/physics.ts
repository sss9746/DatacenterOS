// PhysicsPort over P1's @dcos/physics GPU functions (CONTRACTS §0.6). Imported dynamically so apps/agent
// typechecks without the package; when it (or the three functions) is missing we throw AdapterNotReadyError.
// @dcos/physics is a workspace:* dependency of `agent`; P1's exports match PhysicsPort with no shim (see test/integration).

import type { PhysicsPort } from '../ports.js';
import { AdapterNotReadyError, defaultImporter, isModuleNotFound, missingFunctions, type Importer } from './errors.js';

export const PHYSICS_PACKAGE = '@dcos/physics';
export const PHYSICS_FUNCTIONS = ['simulatePlan', 'evaluateSafety', 'thresholdPolicy'] as const;
export const PHYSICS_NOT_READY_MESSAGE =
  'P1 GPU physics not shipped yet: need simulatePlan, evaluateSafety, thresholdPolicy from @dcos/physics';

export async function createPhysicsPort(importer: Importer = defaultImporter): Promise<PhysicsPort> {
  let mod: Record<string, unknown>;
  try {
    mod = await importer(PHYSICS_PACKAGE);
  } catch (e) {
    if (isModuleNotFound(e)) {
      throw new AdapterNotReadyError(PHYSICS_PACKAGE, `${PHYSICS_NOT_READY_MESSAGE} (package not resolvable from apps/agent)`);
    }
    throw e;
  }
  const missing = missingFunctions(mod, PHYSICS_FUNCTIONS);
  if (missing.length > 0) {
    throw new AdapterNotReadyError(PHYSICS_PACKAGE, `${PHYSICS_NOT_READY_MESSAGE} (missing: ${missing.join(', ')})`);
  }
  const fn = <K extends keyof PhysicsPort>(name: K) => mod[name] as PhysicsPort[K];
  const simulatePlan = fn('simulatePlan');
  const evaluateSafety = fn('evaluateSafety');
  const thresholdPolicy = fn('thresholdPolicy');
  return {
    simulatePlan: (obs, plan, opts) => simulatePlan(obs, plan, opts),
    evaluateSafety: (obs, cmd, ctx) => evaluateSafety(obs, cmd, ctx),
    thresholdPolicy: (obs) => thresholdPolicy(obs),
  };
}
