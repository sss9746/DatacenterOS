// @dcos/db-client (lane P2): one DbClient API, two backends.
//   createMockClient()  in-memory, fixture-backed (P3/P4 build against this first)
//   connect()           live SpacetimeDB (P2-7): subscribes to all public tables, reducer calls read back from the cache
// Wire types come from @dcos/contracts; DB-side types (workflow, evidence, errors) come from here.
// Generated bindings use camelCase fields; this wrapper exposes snake_case contract shapes only.

export type * from './client.js';
export * from './types.js';
export { createMockClient, MOCK_FIXTURES } from './mock.js';
export type { MockCall, MockClientOptions, MockDbClient, MockSnapshotName } from './mock.js';
export { connect } from './live.js';
export { controlledReset } from './reset.js';
export type { ControlledResetOptions, ControlledResetResult } from './reset.js';
