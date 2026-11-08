import { describe, expect, it } from 'vitest';
import examples from '../schema/example-payloads.json' with { type: 'json' };
import {
  CONTRACT_TYPE_NAMES,
  SCHEMA_VERSION,
  contractsSchema,
  validatePayload,
  type ContractTypeName,
  type HardwareSample,
} from '../src/index.js';

const EXAMPLE_TYPES: Record<string, ContractTypeName> = {
  telemetry_event: 'TelemetryEvent',
  hardware_sample: 'HardwareSample',
  hardware_sample_microphone: 'HardwareSample',
  action_command: 'ActionCommand',
  job_spec: 'JobSpec',
  fault_injection_private: 'FaultInjection',
  evaluation_result_provenance: 'EvaluationResult',
};

const fixtures = examples as Record<string, Record<string, unknown>>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('schema metadata', () => {
  it('is version 1.1.0 everywhere', () => {
    expect(SCHEMA_VERSION).toBe('1.1.0');
    expect(contractsSchema.$id).toContain('contracts-1.1.0.json');
    for (const payload of Object.values(fixtures)) expect(payload.schema_version).toBe('1.1.0');
  });

  it('generated a type name for every $def', () => {
    expect([...CONTRACT_TYPE_NAMES].sort()).toEqual(Object.keys(contractsSchema.$defs).sort());
  });

  it('maps every example payload to a type', () => {
    expect(Object.keys(fixtures).sort()).toEqual(Object.keys(EXAMPLE_TYPES).sort());
  });
});

describe('example payloads', () => {
  for (const [name, typeName] of Object.entries(EXAMPLE_TYPES)) {
    it(`${name} validates as ${typeName}`, () => {
      expect(validatePayload(typeName, fixtures[name])).toEqual({ ok: true });
    });
  }
});

describe('invalid payloads', () => {
  it('rejects a TelemetryEvent with a bad source_kind', () => {
    const bad = { ...clone(fixtures.telemetry_event), source_kind: 'carrier_pigeon' };
    const res = validatePayload('TelemetryEvent', bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join('\n')).toMatch(/source_kind/);
  });

  it('rejects a TelemetryEvent with a missing required field', () => {
    const { run_id: _dropped, ...bad } = clone(fixtures.telemetry_event);
    const res = validatePayload('TelemetryEvent', bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join('\n')).toMatch(/run_id/);
  });

  it('rejects an ActionCommand with an unknown operation', () => {
    const bad = { ...clone(fixtures.action_command), operation: 'reboot_datacenter' };
    const res = validatePayload('ActionCommand', bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join('\n')).toMatch(/operation/);
  });

  it('rejects a payload carrying the old 1.0.0 schema_version', () => {
    const bad = { ...clone(fixtures.job_spec), schema_version: '1.0.0' };
    expect(validatePayload('JobSpec', bad).ok).toBe(false);
  });

  it('rejects a HardwareSample without sensor_kind or with out-of-range sound_rms', () => {
    const { sensor_kind: _k, ...noKind } = clone(fixtures.hardware_sample_microphone);
    expect(validatePayload('HardwareSample', noKind).ok).toBe(false);
    const loud: HardwareSample = { ...(clone(fixtures.hardware_sample_microphone) as unknown as HardwareSample), sound_rms: 1.5 };
    expect(validatePayload('HardwareSample', loud).ok).toBe(false);
  });

  it('rejects extra properties and unknown type names', () => {
    const extra = { ...clone(fixtures.hardware_sample), surprise: true };
    expect(validatePayload('HardwareSample', extra).ok).toBe(false);
    expect(validatePayload('NotAType', {})).toEqual({ ok: false, errors: ['unknown contract type: NotAType'] });
  });
});

describe('EvaluationResult.provenance (CONTRACTS 0.14)', () => {
  const full = () => clone(fixtures.evaluation_result_provenance) as Record<string, any>;
  const legacy = () => {
    const { provenance: _p, ...rest } = full();
    return rest;
  };
  const withProv = (patch: Record<string, unknown>) => {
    const r = full();
    r.provenance = { ...r.provenance, ...patch };
    return r;
  };

  it('accepts a legacy row with no provenance', () => {
    expect(validatePayload('EvaluationResult', legacy())).toEqual({ ok: true });
  });

  it('accepts full provenance, including null model fields and empty id arrays', () => {
    expect(validatePayload('EvaluationResult', full())).toEqual({ ok: true });
    expect(
      validatePayload('EvaluationResult', withProv({ model_id: null, prompt_version: null, model_enabled: false, unfinished_job_ids: [] })).ok,
    ).toBe(true);
  });

  it('rejects provenance missing any one required field', () => {
    for (const key of Object.keys(full().provenance)) {
      const r = full();
      delete r.provenance[key];
      const res = validatePayload('EvaluationResult', r);
      expect(res.ok, `missing ${key}`).toBe(false);
    }
  });

  it('rejects wrong types and out-of-range values', () => {
    const bad: Record<string, unknown>[] = [
      { model_requests: '3' },
      { model_requests: -1 },
      { cache_hits: 1.5 },
      { model_enabled: 'yes' },
      { decision_wall_time_ms: -0.1 },
      { horizon_sim_s: 0 },
      { code_revision: '' },
      { latency_model: 'real_latency' },
      { unfinished_job_ids: 'job-2' },
      { failed_job_ids: ['job-1', 'job-1'] },
      { batch_id: 'bad id!' },
    ];
    for (const patch of bad) expect(validatePayload('EvaluationResult', withProv(patch)).ok, JSON.stringify(patch)).toBe(false);
  });

  it('rejects malformed trace_sha256', () => {
    for (const trace_sha256 of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
      expect(validatePayload('EvaluationResult', withProv({ trace_sha256 })).ok).toBe(false);
    }
  });

  it('rejects extra fields in provenance and null provenance', () => {
    expect(validatePayload('EvaluationResult', withProv({ surprise: 1 })).ok).toBe(false);
    expect(validatePayload('EvaluationResult', { ...legacy(), provenance: null }).ok).toBe(false);
  });

  it('keeps schema_version 1.1.0 and the policy enum', () => {
    expect(validatePayload('EvaluationResult', { ...full(), schema_version: '1.2.0' }).ok).toBe(false);
    expect(validatePayload('EvaluationResult', { ...full(), policy: 'oracle' }).ok).toBe(false);
  });
});
