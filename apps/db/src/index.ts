// DataCenterOS SpacetimeDB module (lane P2). Tables and reducers grow in P2-3..P2-9;
// see apps/db/checkpoints/. Column names are snake_case to match @dcos/contracts.
import { schema, table, t } from 'spacetimedb/server';
import { makeRng } from '@dcos/physics';

const run = table(
  { name: 'run', public: true },
  {
    run_id: t.string().primaryKey(),
    seed: t.u32(),
    status: t.string(),
    sim_time_ms: t.u32(),
    tick_index: t.u32(),
    step_ms: t.u32(),
    wall_tick_ms: t.u32(),
    decision_epoch: t.u32(),
    paused: t.bool(),
    speed: t.u8(),
    profile_version: t.string(),
  }
);

const spacetimedb = schema({ run });
export default spacetimedb;

// Gate 0 smoke test: proves the module runs and that @dcos/physics bundles into it.
export const ping = spacetimedb.reducer((_ctx) => {
  const rng = makeRng(42);
  console.info(`pong: physics rng sample ${rng()}`);
});
