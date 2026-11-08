#!/usr/bin/env tsx
// Controlled reset of run-demo-1 (K3). Stop the agent and wait for it to exit BEFORE running this.
//
//   pnpm --filter db exec tsx scripts/reset-run.ts <db> [--confirm-prod]
//
// The database argument is required. Prod `dcos` needs --confirm-prod. Token: STDB_ADMIN_TOKEN, else
// the spacetime CLI login token. Never printed.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, controlledReset } from '@dcos/db-client';

const DB = process.argv[2];
if (!DB || DB.startsWith('--')) {
  console.error('usage: reset-run.ts <db> [--confirm-prod]');
  process.exit(2);
}
const allowProd = process.argv.includes('--confirm-prod');
if (DB === 'dcos' && !allowProd) {
  console.error('refusing to reset prod dcos without --confirm-prod');
  process.exit(2);
}

function adminToken(): string {
  if (process.env.STDB_ADMIN_TOKEN) return process.env.STDB_ADMIN_TOKEN;
  const toml = readFileSync(join(homedir(), '.config', 'spacetime', 'cli.toml'), 'utf8');
  const m = /^spacetimedb_token\s*=\s*"([^"]+)"/m.exec(toml);
  if (!m) throw new Error('no STDB_ADMIN_TOKEN and no spacetime CLI login token');
  return m[1]!;
}

const client = await connect({ uri: process.env.STDB_URI ?? 'wss://maincloud.spacetimedb.com', db: DB, token: adminToken() });
try {
  console.log(JSON.stringify({ db: DB, ...(await controlledReset(client, { db: DB, allowProd })) }));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  client.close();
}
process.exit(process.exitCode ?? 0);
