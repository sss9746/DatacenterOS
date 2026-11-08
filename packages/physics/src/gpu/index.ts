// GPU layer public API (CONTRACTS §0.6). Re-exported by the package root `@dcos/physics`.
// Physics src only ever does `import type` from @dcos/contracts: no runtime ajv here (this code runs inside SpacetimeDB).
export * from './constants.js';
export { buildPreset, type PresetId } from './preset.js';
export { toObserved, PRIVATE_KEYS } from './observe.js';
export { step } from './step.js';
export { enqueueCommands, inFlightCommands, commandOutcome, type InFlightView } from './actions.js';
export type { CommandOutcome } from './world.js';
export {
  evaluateSafety,
  SAFETY_REASON_CODES,
  SAFETY_LOOKAHEAD_S,
  REQUIRED_THERMAL_HEADROOM_C,
  type SafetyContext,
} from './safety.js';
export { simulatePlan, simulatePlanWithReference, estimateWorld, type PlanMetrics } from './simulate.js';
export { loadScenarios, scenarioWorld, scenarioRunId, dueFaults, scenarioTickInput, type Scenario, type ScenarioInitialOverrides } from './scenarios.js';
export { reactivePolicy, thresholdPolicy, THRESHOLD_TEMP_C, type Policy } from './policies.js';
