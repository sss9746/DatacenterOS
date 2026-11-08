#!/usr/bin/env node
// Compiles every $defs entry of schema/contracts.schema.json into exported TS types in
// src/generated.ts. Deterministic: same schema in, same file out.
//
//   pnpm --filter @dcos/contracts gen

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = join(PKG, 'schema', 'contracts.schema.json');
const OUT_PATH = join(PKG, 'src', 'generated.ts');
const ROOT_NAME = 'DcosContractsRoot';

const HEADER = [
  '/* eslint-disable */',
  '// GENERATED — do not edit; run pnpm --filter @dcos/contracts gen',
  '// Source: packages/contracts/schema/contracts.schema.json',
].join('\n');

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const defNames = Object.keys(schema.$defs).sort();

// A synthetic root that references every $def, so each one is emitted under its own name.
const root = {
  title: ROOT_NAME,
  type: 'object',
  properties: Object.fromEntries(defNames.map((n) => [n, { $ref: `#/$defs/${n}` }])),
  required: defNames,
  additionalProperties: false,
  $defs: Object.fromEntries(
    defNames.map((n) => [n, { ...schema.$defs[n], title: n }]),
  ),
};

let ts = await compile(root, ROOT_NAME, {
  bannerComment: '',
  additionalProperties: false,
  declareExternallyReferenced: true,
  enableConstEnums: false,
  strictIndexSignatures: false,
  unknownAny: true,
  format: true,
  style: { singleQuote: true, printWidth: 100 },
});

// Drop the synthetic root interface; it only exists to reach the $defs.
ts = ts.replace(new RegExp(String.raw`export interface ${ROOT_NAME} \{[\s\S]*?\n\}\n`), '');
if (ts.includes(ROOT_NAME)) {
  console.error('gen-types: failed to strip the synthetic root interface');
  process.exit(1);
}

for (const n of defNames) {
  if (!new RegExp(String.raw`export (type|interface) ${n}\b`).test(ts)) {
    console.error(`gen-types: ${n} was not emitted`);
    process.exit(1);
  }
}

writeFileSync(OUT_PATH, `${HEADER}\n\n${ts.trim()}\n\nexport const CONTRACT_TYPE_NAMES = ${JSON.stringify(defNames, null, 2).replace(/"/g, "'")} as const;\n\nexport type ContractTypeName = (typeof CONTRACT_TYPE_NAMES)[number];\n`);
console.log(`gen-types: wrote ${defNames.length} types -> src/generated.ts`);
