// @dcos/contracts: the one shared wire-contract type set for every DataCenterOS service.
// Types are generated from schema/contracts.schema.json (run `pnpm contracts:gen`);
// runtime validation uses Ajv's Draft 2020-12 build against the same schema.

import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import schemaJson from '../schema/contracts.schema.json' with { type: 'json' };
import { CONTRACT_TYPE_NAMES, type ContractTypeName } from './generated.js';

export * from './generated.js';

export const SCHEMA_VERSION = '1.1.0' as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

/** The canonical JSON Schema document (Draft 2020-12, all types under $defs). */
export const contractsSchema = schemaJson as {
  $schema: string;
  $id: string;
  title: string;
  description: string;
  $defs: Record<ContractTypeName, Record<string, unknown>>;
};

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

const TYPE_NAME_SET: ReadonlySet<string> = new Set(CONTRACT_TYPE_NAMES);

export function isContractTypeName(name: string): name is ContractTypeName {
  return TYPE_NAME_SET.has(name);
}

let ajv: Ajv2020 | undefined;
const validators = new Map<ContractTypeName, ValidateFunction>();

function getAjv(): Ajv2020 {
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, strict: false });
    ajv.addSchema(contractsSchema);
  }
  return ajv;
}

function getValidator(typeName: ContractTypeName): ValidateFunction {
  const cached = validators.get(typeName);
  if (cached) return cached;
  const fn = getAjv().getSchema(`${contractsSchema.$id}#/$defs/${typeName}`);
  if (!fn) throw new Error(`@dcos/contracts: no schema for type ${typeName}`);
  validators.set(typeName, fn);
  return fn;
}

/** Validate an unknown payload against one contract type. Validators compile lazily and are cached per type. */
export function validatePayload(typeName: ContractTypeName | string, payload: unknown): ValidationResult {
  if (!isContractTypeName(typeName)) {
    return { ok: false, errors: [`unknown contract type: ${typeName}`] };
  }
  const validate = getValidator(typeName);
  if (validate(payload)) return { ok: true };
  const errors = (validate.errors ?? []).map((e) => {
    const where = e.instancePath || '/';
    const extra =
      e.keyword === 'additionalProperties'
        ? ` (${String((e.params as { additionalProperty?: string }).additionalProperty)})`
        : e.keyword === 'enum'
          ? ` (allowed: ${JSON.stringify((e.params as { allowedValues?: unknown }).allowedValues)})`
          : '';
    return `${where} ${e.message ?? e.keyword}${extra}`;
  });
  return { ok: false, errors: errors.length > 0 ? errors : ['payload is invalid'] };
}
