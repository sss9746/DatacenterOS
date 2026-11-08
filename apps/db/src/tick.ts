// advance_tick: scheduled by `tick_schedule` (P2-4 fills the body).
// Declared now so the scheduled-table binding is part of the schema from P2-3 on; changing a
// table's schedule later could force --delete-data.
import spacetimedb, { tick_schedule } from './schema';

export const advance_tick = spacetimedb.reducer(
  { onSchedule: tick_schedule },
  { arg: tick_schedule.rowType },
  (ctx, { arg }) => {
    // Not browser-callable: only the scheduler (the database itself) may run it.
    if (!ctx.senderAuth.isInternal) return;
    console.debug(`advance_tick(${arg.run_id}): no-op until P2-4`);
  }
);
