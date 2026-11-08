import { describe, expect, it } from 'vitest';
import { ArgsError, CASE_IDS, DEFAULT_TIMEOUT_S, isProdDb, parseArgs, parseCases, resolveTarget } from '../../scripts/live/args.js';

describe('live harness args', () => {
  it('requires --db', () => {
    expect(() => parseArgs([])).toThrow(ArgsError);
    expect(() => parseArgs(['--case', 'L1'])).toThrow(/--db is required/);
  });

  it('parses defaults and every flag', () => {
    const a = parseArgs(['--db', 'dcos-dev']);
    expect(a.db).toBe('dcos-dev');
    expect(a.cases).toEqual([...CASE_IDS]);
    expect(a.seed).toBe(42);
    expect(a.speed).toBe(2);
    expect(a.timeoutS).toBe(DEFAULT_TIMEOUT_S);
    expect(a.runId).toBe('run-demo-1');
    expect(a.noLlm).toBe(false);
    expect(a.skipReset).toBe(false);

    const b = parseArgs(['--db=dcos-r-local', '--case', 'l3,L1', '--seed', '7', '--speed', '1', '--timeout-s', '300', '--out', 'x/y', '--no-llm', '--skip-reset', '--run-id', 'run-x']);
    expect(b.db).toBe('dcos-r-local');
    expect(b.cases).toEqual(['L3', 'L1']);
    expect(b.seed).toBe(7);
    expect(b.speed).toBe(1);
    expect(b.timeoutS).toBe(300);
    expect(b.outDir).toBe('x/y');
    expect(b.noLlm).toBe(true);
    expect(b.skipReset).toBe(true);
    expect(b.runId).toBe('run-x');
  });

  it('rejects bad values and unknown flags', () => {
    expect(() => parseArgs(['--db', 'd', '--seed', '-1'])).toThrow(/--seed/);
    expect(() => parseArgs(['--db', 'd', '--speed', '0'])).toThrow(/--speed/);
    expect(() => parseArgs(['--db', 'd', '--timeout-s', '5'])).toThrow(/--timeout-s/);
    expect(() => parseArgs(['--db', 'd', '--case', 'L9'])).toThrow(/unknown case/);
    expect(() => parseArgs(['--db', 'd', '--bogus'])).toThrow(/unknown argument/);
    expect(() => parseCases('')).toThrow(/at least one/);
    expect(parseCases('all')).toEqual([...CASE_IDS]);
  });

  it('identifies prod by exact name (case/space insensitive) only', () => {
    expect(isProdDb('dcos')).toBe(true);
    expect(isProdDb(' DCOS ')).toBe(true);
    expect(isProdDb('dcos-dev')).toBe(false);
    expect(isProdDb('dcos-eval')).toBe(false);
  });

  it('refuses prod without acknowledgement, refuses prod reset even with it', () => {
    expect(() => resolveTarget({ db: 'dcos', skipReset: false, acknowledgedProd: false })).toThrow(/refusing to run against production/);
    expect(() => resolveTarget({ db: 'dcos', skipReset: true, acknowledgedProd: false })).toThrow(/refusing to run against production/);
    expect(() => resolveTarget({ db: 'dcos', skipReset: false, acknowledgedProd: true })).toThrow(/refusing to RESET production/);
    const t = resolveTarget({ db: 'dcos', skipReset: true, acknowledgedProd: true });
    expect(t).toEqual({ db: 'dcos', isProd: true, resetAllowed: false, willReset: false });
  });

  it('allows dev with a reset by default, and without when --skip-reset', () => {
    expect(resolveTarget({ db: 'dcos-dev', skipReset: false, acknowledgedProd: false })).toEqual({ db: 'dcos-dev', isProd: false, resetAllowed: true, willReset: true });
    expect(resolveTarget({ db: 'dcos-dev', skipReset: true, acknowledgedProd: false }).willReset).toBe(false);
  });
});
