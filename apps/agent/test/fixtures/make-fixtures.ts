// Regenerates the committed JSON fixtures: `pnpm --filter agent fixtures`.
// fixtures.test.ts fails if the committed JSON drifts from these builders.
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_BUILDERS } from './gpu-demo-8.js';

const here = dirname(fileURLToPath(import.meta.url));

export function serializeFixture(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

for (const [name, build] of Object.entries(FIXTURE_BUILDERS)) {
  const path = resolve(here, `${name}.json`);
  writeFileSync(path, serializeFixture(build()));
  console.log(`wrote ${path}`);
}
