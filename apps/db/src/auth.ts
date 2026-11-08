// Roles (CONTRACTS §0.9) and the shared rejection helper.
//
// Every write reducer starts with `requireRole(ctx, …)`. `admin` passes every role check (so the
// judge panel and the P2-7 gate script can drive the whole flow with one token); scheduled reducers
// (`ctx.senderAuth.isInternal`) pass too.
//
// Rejections throw `SenderError("<CODE>: <message>")`. The db-client parses the leading code into
// `err.code` (CONTRACTS §0.11 #14).
import { SenderError, t } from 'spacetimedb/server';
import spacetimedb, { type Ctx } from './schema';

export const ROLES = ['admin', 'agent', 'gateway'] as const;
export type Role = (typeof ROLES)[number];

/** Stable codes: §0.11 #14 plus the §0.7 safety codes surfaced elsewhere. */
export type RejectCode =
  | 'UNAUTHORIZED'
  | 'INVALID_PAYLOAD'
  | 'NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'VERSION_CONFLICT'
  | 'COMMAND_KEY_COLLISION'
  | 'STALE_FENCING_TOKEN'
  | 'LEASE_HELD'
  | 'LEASE_EXPIRED';

export function reject(code: RejectCode, message: string): never {
  throw new SenderError(`${code}: ${message}`);
}

export function roleOf(ctx: Ctx): Role | undefined {
  const row = ctx.db.role_grant.identity.find(ctx.sender);
  return row ? (row.role as Role) : undefined;
}

/** Throws UNAUTHORIZED unless the caller holds one of `allowed` (admin and internal calls always pass). */
export function requireRole(ctx: Ctx, ...allowed: Role[]): void {
  if (ctx.senderAuth.isInternal) return;
  const role = roleOf(ctx);
  if (role === 'admin' || (role !== undefined && allowed.includes(role))) return;
  reject(
    'UNAUTHORIZED',
    `caller ${ctx.sender.toHexString().slice(0, 12)}… has role ${role ?? 'none'}; needs ${allowed.join(' | ') || 'admin'}`
  );
}

/** First publish: the database owner (init's sender) becomes admin. */
export const init = spacetimedb.init((ctx) => {
  ctx.db.role_grant.insert({ identity: ctx.sender, role: 'admin', granted_by: ctx.sender });
  console.info(`init: owner ${ctx.sender.toHexString()} granted admin`);
});

/**
 * grant_role(identity, role): admin only. `role = ""` revokes. An admin can't revoke or demote
 * itself, so the database always keeps at least the caller as admin.
 */
export const grant_role = spacetimedb.reducer(
  { identity: t.identity(), role: t.string() },
  (ctx, { identity, role }) => {
    requireRole(ctx, 'admin');
    if (role !== '' && !(ROLES as readonly string[]).includes(role)) {
      reject('INVALID_PAYLOAD', `role must be one of ${ROLES.join(', ')} (or "" to revoke)`);
    }
    if (identity.isEqual(ctx.sender) && role !== 'admin') {
      reject('INVALID_TRANSITION', 'an admin cannot revoke or demote itself');
    }
    const existing = ctx.db.role_grant.identity.find(identity);
    if (role === '') {
      if (existing) ctx.db.role_grant.identity.delete(identity);
    } else if (existing) {
      ctx.db.role_grant.identity.update({ ...existing, role, granted_by: ctx.sender });
    } else {
      ctx.db.role_grant.insert({ identity, role, granted_by: ctx.sender });
    }
    console.info(`grant_role: ${identity.toHexString().slice(0, 12)}… → ${role || '(revoked)'}`);
  }
);
