// One fencing-token allocator for every lease kind (action claims and workflow claims).
// A single strictly increasing sequence means a token can never be valid for two things at once:
// cancel_action accepts an action token OR a workflow token (§0.11 #13), so separate counters would
// let an old workflow token `1` match some action's `lease_token` `1`.
import type { Ctx } from './schema';

export function nextFencingToken(ctx: Ctx): bigint {
  let max = 0n;
  for (const a of ctx.db.action.iter()) if (a.lease_token > max) max = a.lease_token;
  for (const l of ctx.db.resource_lease.iter()) if (l.fencing_token > max) max = l.fencing_token;
  for (const w of ctx.db.workflow.iter()) if (w.fencing_token > max) max = w.fencing_token;
  return max + 1n;
}
