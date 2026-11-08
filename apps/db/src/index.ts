// DataCenterOS SpacetimeDB module (lane P2). Entry point: re-exports the schema (default export)
// and every reducer. Tables live in schema.ts; see apps/db/checkpoints/ for what each file owns.
import { validatePayload } from '@dcos/contracts';
import { makeRng } from '@dcos/physics';
import spacetimedb from './schema';

export default spacetimedb;
export { init, grant_role } from './auth';
export { create_run, pause_run, configure_run } from './run';
export { advance_tick } from './tick';
export { inject_fault } from './faults';

// Smoke test: proves the module runs, @dcos/physics bundles, and @dcos/contracts' validator
// (ajv) works inside the SpacetimeDB runtime.
export const ping = spacetimedb.reducer((_ctx) => {
  const rng = makeRng(42);
  const ok = validatePayload('RunClock', {
    sim_time_ms: 0, tick_index: 0, step_ms: 1000, wall_tick_ms: 1000, paused: false, decision_epoch: 0,
  });
  const bad = validatePayload('RunClock', { sim_time_ms: -1 });
  console.info(`pong: physics rng ${rng()}; validatePayload ok=${ok.ok} bad=${bad.ok}`);
});
