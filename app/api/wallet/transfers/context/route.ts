import { NextResponse } from 'next/server';

import { resolveAuthorityForSession, UnauthorizedError } from '@/lib/auth/authority';
import { getDb } from '@/lib/db/client';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { exchangeAloneOf } from '@/lib/server/exchange-alone';
import { requireSessionAccount } from '@/lib/server/session-account';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';
import { orgMemberWalletAddresses } from '@/lib/server/wallet-deps';
import { liveWalletContext } from '@/lib/server/wallet-deps';
import { readSpendingRules } from '@/lib/server/spend-rules';
import { liveSpendContext } from '@/lib/server/spend-rules-deps';
import { NO_STORE } from '@/lib/server/wallet-route';
import { paysAlone, staffFactsFrom } from '@/lib/transfer/context';
import { staffInFlight } from '@/lib/server/wallet-transfers';

export const dynamic = 'force-dynamic';

/**
 * What Transfer needs to know before it asks anything (v2 brief 5.4): who the
 * caller is to this business (their role), whether the business has a Splash
 * Wallet and which, and, for staff, their own spending rule and the
 * business's policy (the second-approval threshold and its verified
 * recipients). The business is the session's.
 *
 * Whatever cannot be read is said so, never guessed: `walletState` is
 * `ready`, `none` (no wallet yet), `pending` (being set up), `off` (business
 * wallets are not switched on here) or `unavailable` (the chain did not
 * answer); `rule` and `policy` are null when they could not be read.
 */
export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  let authority;
  try {
    authority = await resolveAuthorityForSession(auth.session);
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: 'no membership' }, { status: 403, headers: NO_STORE });
    throw error;
  }
  if (authority.orgId !== accountCheck.account.orgId) return NextResponse.json({ error: 'no membership' }, { status: 403, headers: NO_STORE });

  // Whether this server can carry out a payment under a staff rule is a fact about this business right now, not a constant: it needs
  // splash_spend's ids, a gas sponsor and a registered wallet. Until all three are true the page sends such a payment to the owners.
  // An owner's switch for this person, read now (default off): whether they may pay an exchange account alone inside their rule.
  const payExchangeAlone = authority.role === 'OWNER' || authority.role === 'VIEWER' ? false : await exchangeAloneOf(getDb() as unknown as DrizzleDb, authority.orgId, authority.userId);
  const base = { role: authority.role, orgId: authority.orgId, staffRulePaymentsWired: false, payExchangeAlone };
  const live = await liveWalletContext(authority.orgId);
  if (!live.ok) {
    const walletState = live.status === 409 ? 'none' : live.status === 503 ? 'off' : 'unavailable';
    return NextResponse.json({ ...base, walletState, wallet: null, rule: null, policy: null, runningTotals: {}, spender: null, inFlight: { spenderMinor: '0', openCount: 0, byRecipient: {} } }, { headers: NO_STORE });
  }
  let wallet: string | null = null;
  let walletState: 'ready' | 'none' | 'pending' | 'unavailable' = 'none';
  try {
    const a = await live.ctx.readAccount();
    wallet = a.wallet;
    walletState = a.wallet ? 'ready' : a.pendingWallet || a.nominatedWallet ? 'pending' : 'none';
  } catch {
    walletState = 'unavailable';
  }
  let facts: ReturnType<typeof staffFactsFrom> = { rule: null, policy: null, runningTotals: {}, spender: null };
  let wired = false;
  let inFlight: Awaited<ReturnType<typeof staffInFlight>> = { spenderMinor: '0', openCount: 0, byRecipient: {} };
  if (wallet && authority.role !== 'OWNER' && authority.role !== 'VIEWER') {
    const sc = await liveSpendContext({ ctx: live.ctx, db: live.db, orgId: authority.orgId });
    if (sc.ok) {
      // The moment is taken before the chain is read, so a payment that lands in between is counted twice, not never.
      const readAtMs = BigInt(Date.now());
      const read = await readSpendingRules(sc.sc);
      if (read.ok) {
        const members = (await orgMemberWalletAddresses(live.db, authority.orgId)).filter((m) => m.userId === authority.userId);
        facts = staffFactsFrom(read.view as unknown as Parameters<typeof staffFactsFrom>[0], members.map((m) => m.address));
        // Paying alone needs the policy to exist, a sponsor for the gas, and the passkey the rule belongs to to be one the person can sign with on this site.
        wired = paysAlone({ hasPolicy: read.view.policy !== null, sponsored: Boolean(live.ctx.signing.sponsor), spender: facts.spender, members });
        // What the person, and their colleagues, have already asked for that the chain has not counted: the page plans with it, as the server does.
        inFlight = await staffInFlight(live.db, { orgId: authority.orgId, now: () => new Date() }, authority.userId, readAtMs);
      }
    }
  }
  return NextResponse.json({ ...base, staffRulePaymentsWired: wired, walletState, wallet, ...facts, inFlight }, { headers: NO_STORE });
}
