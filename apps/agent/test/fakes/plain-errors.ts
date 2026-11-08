// ===========================================================================
//  TEST-ONLY. Wraps a DbPort so every DbError rejection becomes what the real
//  @dcos/db-client produces (CONTRACTS §0.11 #14): a plain Error, never an
//  instance of our DbError class.
//    'coded'   -> Object.assign(new Error('LEASE_HELD: ...'), { code: 'LEASE_HELD', violations })
//    'message' -> new Error('LEASE_HELD: ...') with no `code` (the raw reducer error string)
// ===========================================================================

import { DbError, type DbPort } from '../../src/ports.js';

export type PlainErrorMode = 'coded' | 'message';

export function toPlainError(e: unknown, mode: PlainErrorMode): unknown {
  if (!(e instanceof DbError)) return e;
  const plain = new Error(e.message); // message is already "<CODE>: ..."
  return mode === 'coded' ? Object.assign(plain, { code: e.code, violations: e.violations }) : plain;
}

export function withPlainErrors<T extends DbPort>(db: T, mode: PlainErrorMode = 'coded'): T {
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        let out: unknown;
        try {
          out = (v as (...a: unknown[]) => unknown).apply(target, args);
        } catch (e) {
          throw toPlainError(e, mode);
        }
        return out instanceof Promise ? out.catch((e: unknown) => Promise.reject(toPlainError(e, mode))) : out;
      };
    },
  });
}
