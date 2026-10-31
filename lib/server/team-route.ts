/**
 * The front of every /api/team route: a signed-in customer, their business
 * from the SESSION (requireSessionAccount, WS2), and their own membership.
 * A route never reads a business or an actor from the request.
 *
 * Unlike the wallet routes this does not open the business wallet: the team is
 * managed from the database alone, so an owner can add people before a wallet
 * exists, and a chain outage never stops them seeing who has access.
 */
import 'server-only';

import { NextResponse } from 'next/server';

import { resolveAuthorityForSession, type AuthorityContext } from '@/lib/auth/authority';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { requireSessionAccount } from '@/lib/server/session-account';
import type { TeamFailure } from '@/lib/server/team-admin';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export type TeamRoute = { orgId: string; authority: AuthorityContext; db: DrizzleDb };

export async function teamRoute(request: Request): Promise<{ route: TeamRoute; response: null } | { route: null; response: Response }> {
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
  const { getDb } = await import('@/lib/db/client');
  return { route: { orgId: authority.orgId, authority, db: getDb() as unknown as DrizzleDb }, response: null };
}

/** Every change to the team is limited per person and per business. */
export async function limitTeamChanges(route: TeamRoute): Promise<Response | null> {
  const message = 'Too many team changes. Try again shortly.';
  return (
    (await enforceRateLimit({ rule: RATE_LIMITS.teamChangeUser, key: route.authority.userId, message })) ??
    (await enforceRateLimit({ rule: RATE_LIMITS.teamChangeOrg, key: route.orgId, message }))
  );
}

/** A service result as a response. */
export function teamResponse(result: { ok: true } | TeamFailure, body?: unknown, okStatus = 200): Response {
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status, headers: NO_STORE });
  return NextResponse.json(body ?? { ok: true }, { status: okStatus, headers: NO_STORE });
}
