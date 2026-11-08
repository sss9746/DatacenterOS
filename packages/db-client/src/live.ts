// connect(): the live client over the generated SpacetimeDB bindings.
// The live tables and reducers land in P2-3 (tables, create_run), P2-4 (tick, faults),
// P2-5 (actions) and P2-6 (workflow, incidents). Until then connect() rejects clearly,
// so P3/P4 stay on createMockClient() (VITE_DATA_MODE=mock).

import type { ConnectOptions, DbClient } from './client.js';

export async function connect(opts: ConnectOptions): Promise<DbClient> {
  throw new Error(
    `@dcos/db-client: connect(${opts.db}) is not available yet (live tables land in P2-3..P2-6). Use createMockClient().`,
  );
}
