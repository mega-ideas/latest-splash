/**
 * The shared front of every /api/wallet route: a signed-in customer, their
 * org from the SESSION (requireSessionAccount, WS2), their own membership,
 * and the live wallet context for that org only. A route never reads an org,
 * an account or a user id from the request.
 */
import 'server-only';

import { NextResponse } from 'next/server';

import { canAskForWithdrawal } from '@/lib/payouts/withdrawal-rules';

import { resolveAuthorityForSession, type AuthorityContext } from '@/lib/auth/authority';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { requireSessionAccount } from '@/lib/server/session-account';
import { fundsAccessOf, teamManager } from '@/lib/server/team-admin';
import type { FundsAccessKind } from '@/lib/team/view';
import { liveWalletContext } from '@/lib/server/wallet-deps';
import { customerRefusal, refusalLogLine } from '@/lib/server/wallet-refusal';
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
  if (!live.ok) {
    // The reason is the operator's (a missing setting, a network); the customer is told in a sentence.
    const line = refusalLogLine(account.account.orgId, live.error);
    if (line) console.warn(line);
    const said = customerRefusal(live);
    return { route: null, response: NextResponse.json({ error: said.error }, { status: said.status, headers: NO_STORE }) };
  }
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

/** The reads that go to the chain (the overview, funds in personal wallets): limited per person. */
export async function limitWalletReads(userId: string): Promise<Response | null> {
  return enforceRateLimit({ rule: RATE_LIMITS.walletReadUser, key: userId, message: 'Too many requests. Try again shortly.' });
}

/**
 * Preparing a payment (a quote, a supplier payout, a batch review) may be
 * done by an owner or a staff member (Sky's decision: staff may ask owners to
 * approve); it opens the owners' signing request, and only their quorum signs.
 * A viewer cannot. This is the payment gate. Add funds and Withdraw to the
 * business's own bank are different: an owner grants those member by member
 * (`requireFundsAccess`).
 */
export function requireWithdrawalRequester(route: WalletRoute): Response | null {
  if (canAskForWithdrawal(route.authority.role)) return null;
  return NextResponse.json({ error: 'Only an owner or a staff member can ask for a withdrawal.' }, { status: 403, headers: NO_STORE });
}

/** Supplier payouts and suppliers' accounts are read by the owners and the staff who pay; a viewer does not see them. */
export function requirePayoutReader(route: WalletRoute): Response | null {
  if (canAskForWithdrawal(route.authority.role)) return null;
  return NextResponse.json({ error: "Only an owner or a staff member can see the business's payouts and suppliers." }, { status: 403, headers: NO_STORE });
}

/** Only an owner (role admin) changes the wallet or pays from it. */
export function requireOwner(route: WalletRoute, what: string): Response | null {
  if (route.authority.role === 'OWNER') return null;
  return NextResponse.json({ error: `Only an owner can ${what}.` }, { status: 403, headers: NO_STORE });
}

/**
 * An owner, or the business's Finance lead. Used for exactly one thing on the
 * wallet: starting a request to add a signer. The signers still sign it.
 */
export async function requireOwnerOrFinanceLead(route: WalletRoute, what: string): Promise<Response | null> {
  if (route.authority.role === 'OWNER') return null;
  if ((await teamManager(route.db, route.orgId, route.authority.userId)) === 'finance_lead') return null;
  return NextResponse.json({ error: `Only an owner or the Finance lead can ${what}.` }, { status: 403, headers: NO_STORE });
}

/**
 * Add funds and Withdraw to the business's own bank are for owners and for the
 * staff and approvers an owner has granted them to (Settings → Team). A viewer
 * never. The decision is read from the database on every request.
 */
export async function requireFundsAccess(route: WalletRoute, access: FundsAccessKind, what: string): Promise<Response | null> {
  const held = await fundsAccessOf(route.db, route.orgId, route.authority.userId);
  if (access === 'add_funds' ? held.addFunds : held.withdraw) return null;
  if (route.authority.role === 'VIEWER') return NextResponse.json({ error: `A viewer cannot ${what}.`, code: 'viewer' }, { status: 403, headers: NO_STORE });
  return NextResponse.json({ error: `You do not have access to ${what}. An owner can turn it on for you in Settings.`, code: 'no_funds_access' }, { status: 403, headers: NO_STORE });
}

/** A non-negative integer field (minor units, milliseconds) as a bigint, or null if absent or malformed. */
export function bigintField(value: unknown): bigint | null {
  const s = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,20}$/.test(s)) return null;
  const n = BigInt(s);
  return n <= 18_446_744_073_709_551_615n ? n : null;
}

/** A refusal in the shape every wallet route answers with. */
export function refusal(status: number, error: string, code?: string): Response {
  return NextResponse.json({ error, ...(code ? { code } : {}) }, { status, headers: NO_STORE });
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
