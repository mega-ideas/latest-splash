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

/** A service result as a response. */
export function asResponse(result: { ok: true } | { ok: false; status: number; code: string; error: string }, body?: unknown): Response {
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status, headers: NO_STORE });
  return NextResponse.json(body ?? result, { headers: NO_STORE });
}
