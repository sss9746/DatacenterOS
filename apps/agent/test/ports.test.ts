import { describe, expect, it } from 'vitest';
import { DB_ERROR_CODES, DbError, dbErrorCode, isDbError } from '../src/ports.js';

describe('isDbError / dbErrorCode (CONTRACTS §0.11 #14: by code, never instanceof)', () => {
  it('recognises a plain db-client Error with a string code (not a DbError instance)', () => {
    const e = Object.assign(new Error('LEASE_HELD: x'), { code: 'LEASE_HELD' });
    expect(e instanceof DbError).toBe(false);
    expect(isDbError(e)).toBe(true);
    expect(isDbError(e, 'LEASE_HELD')).toBe(true);
    expect(isDbError(e, 'VERSION_CONFLICT')).toBe(false);
    expect(dbErrorCode(e)).toBe('LEASE_HELD');
  });

  it('parses the code from a code-less "<CODE>: ..." reducer message', () => {
    const e = new Error('STALE_FENCING_TOKEN: workflow wf-1 token 3');
    expect(isDbError(e, 'STALE_FENCING_TOKEN')).toBe(true);
    expect(dbErrorCode(e)).toBe('STALE_FENCING_TOKEN');
    expect(dbErrorCode('VERSION_CONFLICT: action k is v2')).toBe('VERSION_CONFLICT');
    expect(dbErrorCode(new Error('Error: LEASE_EXPIRED: wf-1'))).toBe('LEASE_EXPIRED');
  });

  it('knows UNAUTHORIZED and still accepts the DbError fake', () => {
    expect(DB_ERROR_CODES).toContain('UNAUTHORIZED');
    expect(isDbError(Object.assign(new Error('UNAUTHORIZED: agent role'), { code: 'UNAUTHORIZED' }), 'UNAUTHORIZED')).toBe(true);
    expect(isDbError(new DbError('NOT_FOUND', 'no action k'), 'NOT_FOUND')).toBe(true);
  });

  it('rejects non-DB errors: unknown codes, other coded errors, plain messages, non-objects', () => {
    expect(isDbError(new Error('db connection reset'))).toBe(false);
    expect(isDbError(Object.assign(new Error('LEASE_HELD: but coded otherwise'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isDbError(new Error('SOMETHING_ELSE: x'))).toBe(false);
    expect(isDbError({ code: 'NOPE' })).toBe(false);
    expect(isDbError(null)).toBe(false);
    expect(isDbError(42)).toBe(false);
  });
});
