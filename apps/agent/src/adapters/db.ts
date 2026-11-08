// DbPort over P2's @dcos/db-client (CONTRACTS §0.6 frozen wrapper names + §0.11 #7/#10 additions).
// Imported dynamically so apps/agent typechecks before the package exists. P2's client must match the
// shapes in src/ports.ts; we only verify that every wrapper name is present.
// @dcos/db-client is a workspace:* dependency of `agent`; createMockClient() and connect() both satisfy DbPort.

import type { DbPort } from '../ports.js';
import { AdapterNotReadyError, defaultImporter, isModuleNotFound, missingFunctions, type Importer } from './errors.js';

export const DB_CLIENT_PACKAGE = '@dcos/db-client';
export const DB_NOT_READY_MESSAGE = 'P2 @dcos/db-client not shipped yet';

/** Every DbPort method the agent calls (§0.6 agent names + getWorkflow/listOpenWorkflows/listIncidents/upsertSymptoms/onChange). */
export const DB_PORT_METHODS = [
  'getObservedSnapshot',
  'getEvidence',
  'getActionStatus',
  'requestAction',
  'claimAction',
  'startAction',
  'cancelAction',
  'verifyAction',
  'claimWorkflow',
  'heartbeatWorkflow',
  'updateWorkflow',
  'getWorkflow',
  'listOpenWorkflows',
  'upsertIncident',
  'listIncidents',
  'upsertSymptoms',
  'submitPlan',
  'publishAgentEvent',
  'onChange',
] as const satisfies readonly (keyof DbPort)[];

export interface DbConnectConfig {
  uri: string;
  db: string;
  token: string;
}

/** Load @dcos/db-client and check it exports `connect`. Throws AdapterNotReadyError when it is not there. */
export async function loadDbClient(importer: Importer = defaultImporter): Promise<Record<string, unknown>> {
  let mod: Record<string, unknown>;
  try {
    mod = await importer(DB_CLIENT_PACKAGE);
  } catch (e) {
    if (isModuleNotFound(e)) throw new AdapterNotReadyError(DB_CLIENT_PACKAGE, `${DB_NOT_READY_MESSAGE} (package not resolvable from apps/agent)`);
    throw e;
  }
  if (typeof mod.connect !== 'function') {
    throw new AdapterNotReadyError(DB_CLIENT_PACKAGE, `${DB_NOT_READY_MESSAGE} (no connect() export)`);
  }
  return mod;
}

/** Connect as the agent role and return the client as a DbPort (every wrapper name verified). */
export async function createDbPort(cfg: DbConnectConfig, importer: Importer = defaultImporter): Promise<DbPort> {
  const mod = await loadDbClient(importer);
  const connect = mod.connect as (opts: DbConnectConfig) => Promise<unknown> | unknown;
  const client = (await connect({ uri: cfg.uri, db: cfg.db, token: cfg.token })) as Record<string, unknown> | null;
  const missing = missingFunctions(client, DB_PORT_METHODS);
  if (missing.length > 0) {
    throw new AdapterNotReadyError(DB_CLIENT_PACKAGE, `${DB_CLIENT_PACKAGE} client is missing wrapper(s): ${missing.join(', ')}`);
  }
  const port = {} as Record<string, unknown>;
  for (const name of DB_PORT_METHODS) port[name] = (client![name] as (...a: unknown[]) => unknown).bind(client);
  return port as unknown as DbPort;
}
