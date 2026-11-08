#!/usr/bin/env tsx
// Mint role identities (CONTRACTS §0.9) and grant their roles (P2-8).
//
//   pnpm --filter db bootstrap [db] [--roles agent,gateway,admin] [--create-run]
//     db           default dcos-dev
//     --roles      which identities to mint (default: agent,gateway,admin)
//     --create-run also call create_run('run-demo-1', 42, 'gpu_demo_8')
//
// Tokens are NEVER printed and never written inside the repo: they go to
// ~/.dcos-tokens/<db>.env (mode 600; <db>.<server>.env for a non-Maincloud STDB_SERVER, e.g. local)
// as STDB_<ROLE>_TOKEN lines. stdout shows identities only.
// Offline: STDB_HTTP=http://127.0.0.1:3000 STDB_URI=ws://127.0.0.1:3000 STDB_SERVER=local pnpm bootstrap dcos --create-run
// The granting caller is the database owner / an admin: STDB_ADMIN_TOKEN, else the spacetime CLI
// login token. The owner's own token is never handed out; `admin` here is a NEW identity (presenter).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Identity } from 'spacetimedb';
import { DbConnection } from '@dcos/db-client/generated';

const args = process.argv.slice(2);
const DB = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--roles') ?? 'dcos-dev';
const ROLES = (args.includes('--roles') ? args[args.indexOf('--roles') + 1]! : 'agent,gateway,admin').split(',').map((r) => r.trim());
const HTTP = process.env.STDB_HTTP ?? 'https://maincloud.spacetimedb.com';
const URI = process.env.STDB_URI ?? 'wss://maincloud.spacetimedb.com';
const SERVER = process.env.STDB_SERVER ?? 'maincloud'; // spacetime CLI server nickname, for the SQL check

for (const r of ROLES) if (!['agent', 'gateway', 'admin'].includes(r)) throw new Error(`unknown role ${r}`);

function ownerToken(): string {
  if (process.env.STDB_ADMIN_TOKEN) return process.env.STDB_ADMIN_TOKEN;
  const toml = readFileSync(join(homedir(), '.config', 'spacetime', 'cli.toml'), 'utf8');
  const m = /^spacetimedb_token\s*=\s*"([^"]+)"/m.exec(toml);
  if (!m) throw new Error('no STDB_ADMIN_TOKEN and no spacetime CLI login token');
  return m[1]!;
}

async function mint(): Promise<{ identity: string; token: string }> {
  const res = await fetch(`${HTTP}/v1/identity`, { method: 'POST' });
  if (!res.ok) throw new Error(`POST /v1/identity → ${res.status}`);
  const j = (await res.json()) as { identity?: string; token?: string };
  if (!j.identity || !j.token) throw new Error('POST /v1/identity: unexpected response');
  return { identity: j.identity, token: j.token };
}

async function main(): Promise<void> {
  const conn = await new Promise<DbConnection>((resolve, reject) => {
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .withToken(ownerToken())
      .onConnect((c) => resolve(c))
      .onConnectError((_c, e) => reject(new Error(`connect ${DB}: ${String(e)}`)))
      .build();
  });

  const lines: string[] = [`# DataCenterOS role tokens for ${DB} (minted ${new Date().toISOString()}). Do not commit.`, `STDB_DB=${DB}`, `STDB_URI=${URI}`];
  const minted: Array<{ role: string; identity: string }> = [];
  for (const role of ROLES) {
    const { identity, token } = await mint();
    await conn.reducers.grantRole({ identity: new Identity(identity), role });
    lines.push(`STDB_${role.toUpperCase()}_TOKEN=${token}`, `STDB_${role.toUpperCase()}_IDENTITY=${identity}`);
    minted.push({ role, identity });
    console.log(`granted ${role.padEnd(7)} → ${identity}`);
  }

  if (args.includes('--create-run')) {
    await conn.reducers.createRun({ runId: 'run-demo-1', seed: 42, presetId: 'gpu_demo_8' });
    console.log('create_run run-demo-1 42 gpu_demo_8');
  }
  conn.disconnect();

  const dir = join(homedir(), '.dcos-tokens');
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  // Non-Maincloud servers get their own file so local rehearsal tokens never shadow prod ones.
  const file = join(dir, SERVER === 'maincloud' ? `${DB}.env` : `${DB}.${SERVER}.env`);
  // Keep saved credentials for roles not minted this time (their grants are still active).
  if (existsSync(file)) {
    const fresh = new Set(ROLES.map((r) => r.toUpperCase()));
    for (const l of readFileSync(file, 'utf8').split('\n')) {
      const m = /^STDB_([A-Z]+)_(TOKEN|IDENTITY)=/.exec(l);
      if (m && !fresh.has(m[1]!)) lines.push(l);
    }
  }
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`tokens written to ${file} (mode 600; never committed, never printed)`);

  // Check the grants as the owner (role_grant is private; the owner's CLI can read it).
  const sql = spawnSync('spacetime', ['sql', '-s', SERVER, '--format', 'json', DB, 'SELECT * FROM role_grant'], { encoding: 'utf8' });
  if (sql.status === 0) {
    const text = sql.stdout.toLowerCase();
    for (const m of minted) console.log(`role_grant has ${m.role}: ${text.includes(m.identity.toLowerCase()) && text.includes(`"${m.role}"`) ? 'yes' : 'NO'}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('bootstrap failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
