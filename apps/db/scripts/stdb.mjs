// Shared helpers for the live smoke tests: call reducers and run SQL through the `spacetime` CLI.
import { spawnSync } from 'node:child_process';

export function connectCli(db, server = 'maincloud') {
  const SERVER = ['-s', server];
  let failures = 0;

  /** Reducer call. Each arg is passed as JSON text (the CLI parses every argument as JSON). */
  function call(reducer, args = [], { anonymous = false } = {}) {
    const r = spawnSync('spacetime', ['call', ...SERVER, ...(anonymous ? ['--anonymous'] : []), db, reducer, ...args], { encoding: 'utf8' });
    const out = `${r.stdout}\n${r.stderr}`;
    const m = /Response text: (.*)/.exec(out);
    return { ok: r.status === 0 && !m, error: m ? m[1].trim() : r.status === 0 ? null : out.trim() };
  }

  /** SQL query → array of row objects; option columns unwrapped to value | null. */
  function sql(query) {
    const r = spawnSync('spacetime', ['sql', ...SERVER, '--format', 'json', db, query], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`sql failed: ${query}\n${r.stderr}`);
    const [res] = JSON.parse(r.stdout);
    const cols = res.schema.elements.map((e) => e.name.some);
    const unopt = (v) => (Array.isArray(v) && v.length === 2 && (v[0] === 0 || v[0] === 1) ? (v[0] === 0 ? v[1] : null) : v);
    return res.rows.map((row) => Object.fromEntries(row.map((v, i) => [cols[i], unopt(v)])));
  }

  function check(name, cond, detail = '') {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!cond) failures++;
  }
  const expectError = (name, res, code) => check(name, !res.ok && res.error?.startsWith(`${code}:`), res.error ?? 'no error');

  function done() {
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  }

  return { call, sql, check, expectError, done };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const arg = (v) => JSON.stringify(v);
/** A string reducer argument that holds JSON. */
export const jsonArg = (obj) => JSON.stringify(JSON.stringify(obj));

export async function waitFor(name, fn, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${name}`);
}
