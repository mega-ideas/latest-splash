/**
 * Resolve the ledger account a request may act on — from the SESSION, never
 * from the request.
 *
 * Audit finding: `businessAccountId` was read out of the request body in
 * `transfers/authorize` and `funding/sessions`, and out of the query string in
 * `funding/options` and `ledger`. `requireCustomerRequest` proves *who* is
 * calling and `requireActiveOrg` proves the org is KYB-ACTIVE, but neither
 * binds the account being debited to the caller. Any session holder could name
 * another org's funded account and spend it — Invariant #8 (the client is never
 * authoritative) applied to the one field that decides whose money moves.
 *
 * The resolution order deliberately mirrors what the routes did before, minus
 * the client input, so existing single-tenant ledger balances keep their key:
 *   1. `organizations.sui_business_account_id` for the caller's org (multi-tenant)
 *   2. `SPLASH_BUSINESS_ACCOUNT_ID` (the single-tenant demo workspace)
 *   3. `dashboard-primary` (no chain config at all — local dev)
 */
import { UnauthorizedError, resolveAuthorityForSession } from '@/lib/auth/authority';
import { resolveBusinessAccountId } from '@/lib/compliance/org-kyb';
import type { CustomerSession } from '@/lib/server/customer-auth';

/** Last-resort key, matching the literal the routes previously defaulted to. */
const FALLBACK_ACCOUNT_ID = 'dashboard-primary';

export type SessionAccount = {
  orgId: string;
  /** Ledger + funding-session account key for this org. */
  accountId: string;
};

export async function resolveSessionAccount(session: CustomerSession): Promise<SessionAccount> {
  const ctx = await resolveAuthorityForSession(session);
  try {
    return { orgId: ctx.orgId, accountId: await resolveBusinessAccountId(ctx.orgId) };
  } catch {
    // `resolveBusinessAccountId` throws when the org has no on-chain account and
    // no env fallback. That is a legitimate local-dev state, not an auth
    // failure — but it must never widen into "use whatever the client asked
    // for", so it collapses to a single fixed key.
    return { orgId: ctx.orgId, accountId: FALLBACK_ACCOUNT_ID };
  }
}

/**
 * True when a client-supplied account id names something other than the
 * caller's own account. Routes use this to answer 400 instead of silently
 * ignoring the field, so a probing client gets told rather than misled.
 */
export function isForeignAccountId(supplied: string | null | undefined, resolved: string): boolean {
  const value = (supplied ?? '').trim();
  return value.length > 0 && value !== resolved;
}

/**
 * `resolveSessionAccount`, but answering the caller instead of crashing.
 *
 * `resolveAuthorityForSession` throws `UnauthorizedError` when the signed-in
 * account has no membership — which is correct and is Phase 3's fail-closed
 * behaviour. What was wrong is that nothing caught it: all six routes reached
 * for `resolveSessionAccount` directly, so a perfectly ordinary state (signed
 * up, waiting for an administrator to grant access) surfaced as a 500. Two of
 * those routes were `transfers/authorize` and `batches/authorize`, so a user
 * whose membership had just been revoked was told the server was broken rather
 * than that they no longer hold approval rights.
 *
 * Shaped like `requireCustomerRequest` — `{ account, response }`, one of which
 * is null — so a route reads the same way whichever check fails first.
 */
export async function requireSessionAccount(
  session: CustomerSession,
): Promise<{ account: SessionAccount; response: null } | { account: null; response: Response }> {
  try {
    return { account: await resolveSessionAccount(session), response: null };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return {
        account: null,
        response: Response.json(
          {
            error:
              'This account has no workspace membership yet, so it cannot read or move money. ' +
              'An administrator grants access from the Splash staff console.',
            code: 'no_membership',
          },
          { status: 403 },
        ),
      };
    }
    throw error;
  }
}
