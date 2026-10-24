import { NextResponse } from 'next/server';

import { getOxwalProposalStore } from '@/lib/agent/oxwal';
import { resolveAuthorityForSession, UnauthorizedError, type AuthorityContext } from '@/lib/auth/authority';
import { buildHomeSummary, RECENT_LIMIT, SETTLED_STATES, startOfMonthUtc, type HomeWalletPayment } from '@/lib/dashboard/home';
import { ensureProposalStoreHydrated } from '@/lib/queue/proposal-persistence';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { requireSessionAccount } from '@/lib/server/session-account';
import { listTransfersFor, settledTimesFor } from '@/lib/server/transfers-store';
import { listHomeOutflows } from '@/lib/server/usdc-records';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** Matches /api/transfers: a bound that is stated, not implied. */
const MAX_TRANSFERS = 5_000;

/**
 * Home's figures for the signed-in person's org (v2 brief 5.2): Sent this
 * month, Needs approval and Recent payments, built in one pass from this
 * org's own records (lib/dashboard/home.ts).
 *
 *   transfers         listTransfersFor(orgId), as /api/transfers reads them,
 *                     with when each settled (settledTimesFor)
 *   wallet payments   listHomeOutflows(db, orgId, …): this month's confirmed
 *                     and the newest few, never a quote nobody sent
 *   approvals         the proposal store the approval queue (/queue) reads,
 *                     filtered to this org and to what the viewer can approve
 *
 * The org comes from the session (requireSessionAccount), never the request.
 * The viewer (who, in what role) comes from the same membership the queue
 * reads, and a mismatch between the two refuses, as the wallet routes do.
 * The Splash Wallet balance is not here: the page reads it from the chain.
 */
export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  const { orgId } = accountCheck.account;

  let authority: AuthorityContext;
  try {
    authority = await resolveAuthorityForSession(auth.session);
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return NextResponse.json({ error: 'no membership' }, { status: 403, headers: NO_STORE });
  }
  if (authority.orgId !== orgId) {
    return NextResponse.json({ error: 'no membership' }, { status: 403, headers: NO_STORE });
  }

  const limited = await enforceRateLimit({ rule: RATE_LIMITS.homeSummaryUser, key: authority.userId, message: 'Home is refreshing too often. Try again shortly.' });
  if (limited) return limited;

  const now = new Date();
  const transfers = await listTransfersFor(orgId, MAX_TRANSFERS);
  const settled = transfers.filter((t) => !t.demo && SETTLED_STATES.includes(t.state)).map((t) => t.id);
  const settledAt = await settledTimesFor(orgId, settled, SETTLED_STATES);

  // Wallet payments live only in Postgres. Reads run one after another: the
  // local dev database serves a single connection.
  let walletPayments: HomeWalletPayment[] = [];
  if (process.env.DATABASE_URL) {
    const { getDb } = await import('@/lib/db/client');
    const db = getDb();
    walletPayments = await listHomeOutflows(db, orgId, { since: startOfMonthUtc(now), recent: RECENT_LIMIT });
  }

  // Hydration lapses whatever has passed its expiry, as on /queue.
  const store = getOxwalProposalStore();
  await ensureProposalStoreHydrated(store);
  const proposals = store.list();
  const withSettledAt = transfers.map((t) => ({ ...t, settledAt: settledAt.get(t.id) ?? null }));

  const summary = buildHomeSummary({
    orgId,
    now,
    transfers: withSettledAt,
    walletPayments,
    proposals,
    viewer: { userId: authority.userId, role: authority.role },
  });
  return NextResponse.json(summary, { headers: NO_STORE });
}
