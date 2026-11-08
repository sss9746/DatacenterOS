// P1-2: the v0 facility API moved to the `@dcos/physics/v0` subpath; the root is the GPU API.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as v0 from '../src/v0/index.js';
import { step as v0Step } from '../src/step.js';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
  exports: Record<string, { types: string; import: string }>;
  dependencies?: Record<string, string>;
};

function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('P1-2: package exports', () => {
  it('exports "." (GPU API) and "./v0" (facility API) from dist', () => {
    expect(pkg.exports['.']).toEqual({ types: './dist/index.d.ts', import: './dist/index.js' });
    expect(pkg.exports['./v0']).toEqual({ types: './dist/v0/index.d.ts', import: './dist/v0/index.js' });
    expect(pkg.dependencies?.['@dcos/contracts']).toBe('workspace:*');
  });

  it('the v0 subpath re-exports the unchanged facility step', () => {
    expect(v0.step).toBe(v0Step);
  });

  it('physics src only imports @dcos/contracts as types (no runtime ajv inside SpacetimeDB)', () => {
    const offenders: string[] = [];
    for (const file of srcFiles(join(PKG_DIR, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/^\s*(import|export)\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/gms)) {
        const [, kw, clause, spec] = m;
        if (spec!.startsWith('@dcos/contracts') && !/^type\b/.test(clause!.trim())) offenders.push(`${file}: ${kw} ${clause}`);
        if (spec!.includes('contracts/src')) offenders.push(`${file}: relative import of contracts source`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
