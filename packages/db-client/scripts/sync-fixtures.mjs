#!/usr/bin/env node
// Copies P1's GPU fixtures into the mock: packages/physics/fixtures/gpu -> packages/db-client/src/mock/fixtures.
// Run after P1 regenerates them:  pnpm --filter @dcos/db-client sync:fixtures
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC = join(ROOT, 'packages', 'physics', 'fixtures', 'gpu');
const DST = join(ROOT, 'packages', 'db-client', 'src', 'mock', 'fixtures');
const FILES = ['observed_snapshot_demo.json', 'observed_snapshot_pump_degraded.json', 'signal_xid79.json'];

let missing = 0;
for (const f of FILES) {
  if (!existsSync(join(SRC, f))) {
    console.error(`sync-fixtures: missing ${f} in packages/physics/fixtures/gpu (is P1-1 merged?)`);
    missing++;
    continue;
  }
  copyFileSync(join(SRC, f), join(DST, f));
  console.log(`sync-fixtures: ${f}`);
}
process.exitCode = missing ? 1 : 0;
