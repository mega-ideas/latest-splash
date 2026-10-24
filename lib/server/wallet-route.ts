/**
 * The shared front of every /api/wallet route: a signed-in customer, their
 * org from the SESSION (requireSessionAccount, WS2), their own membership,
 * and the live wallet context for that org only. A route never reads an org,
 * an account or a user id from the request.
 */
import 'server-only';

import { NextResponse } from 'next/server';

import { resolveAuthorityForSession, type AuthorityContext } from '@/lib/auth/authority';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { requireSessionAccount } from '@/lib/server/session-account';
import { liveWalletContext } from '@/lib/server/wallet-deps';
import type { WalletContext } from '@/lib/server/business-wallet';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export type WalletRoute = { orgId: string; authority: AuthorityContext; ctx: WalletContext; db: DrizzleDb };

export async function walletRoute(request: Request): Promise<{ route: WalletRoute; response: null } | { route: null; response: Response }> {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return { route: null, response: auth.response };
  const account = await requireSessionAccount(auth.session);
  if (account.response) return { route: null, response: account.response };
  let authority: AuthorityContext;
  try {
    authority = await resolveAuthorityForSession(auth.session);
  } catch {
    return { route: null, response: NextResponse.json({ error: 'no membership' }, { status: 403, headers: NO_STORE }) };
  }
  if (authority.orgId !== account.account.orgId) {
    return { route: null, response: NextResponse.json({ error: 'no membership' }, { status: 403, headers: NO_STORE }) };
  }
  const live = await liveWalletContext(account.account.orgId);
  if (!live.ok) return { route: null, response: NextResponse.json({ error: live.error }, { status: live.status, headers: NO_STORE }) };
  return { route: { orgId: account.account.orgId, authority, ctx: live.ctx, db: live.db }, response: null };
}

/**
 * Every route that opens a wallet request (and so reads the chain, simulates,
 * and may spend the sponsor's gas) is limited per person and per business.
 */
export async function limitWalletRequests(route: WalletRoute): Promise<Response | null> {
  const message = 'Too many wallet requests. Try again shortly.';
  return (
    (await enforceRateLimit({ rule: RATE_LIMITS.walletRequestUser, key: route.authority.userId, message })) ??
    (await enforceRateLimit({ rule: RATE_LIMITS.walletRequestOrg, key: route.orgId, message }))
  );
}

/** Only an owner (role admin) changes the wallet or pays from it. */
export function requireOwner(route: WalletRoute, what: string): Response | null {
  if (route.authority.role === 'OWNER') return null;
  return NextResponse.json({ error: `Only an owner can ${what}.` }, { status: 403, headers: NO_STORE });
}

/** A service result as a response. A refusal's `details` (who is missing, say) go with it. */
export function asResponse(
  result: { ok: true } | { ok: false; status: number; code: string; error: string; details?: Record<string, unknown> },
  body?: unknown,
): Response {
  if (!result.ok) {
    return NextResponse.json({ error: result.error, code: result.code, ...(result.details ? { details: result.details } : {}) }, { status: result.status, headers: NO_STORE });
  }
  return NextResponse.json(body ?? result, { headers: NO_STORE });
}
