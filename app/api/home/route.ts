import { NextResponse } from 'next/server';

import { getOxwalProposalStore } from '@/lib/agent/oxwal';
import { buildHomeSummary } from '@/lib/dashboard/home';
import { ensureProposalStoreHydrated } from '@/lib/queue/proposal-persistence';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { requireSessionAccount } from '@/lib/server/session-account';
import { listTransfersFor } from '@/lib/server/transfers-store';
import { listUsdcRecords } from '@/lib/server/usdc-records';

export const dynamic = 'force-dynamic';

/** Matches /api/transfers: a bound that is stated, not implied. */
const MAX_TRANSFERS = 5_000;

/**
 * Home's figures for the signed-in person's org (v2 brief 5.2): Sent this
 * month, Needs approval and Recent payments, built in one pass from this
 * org's own records (lib/dashboard/home.ts).
 *
 *   transfers         listTransfersFor(orgId), as /api/transfers reads them
 *   wallet payments   listUsdcRecords(db, orgId), as the USDC export reads them
 *   approvals         the proposal store the approval queue (/queue) reads,
 *                     filtered to this org by buildHomeSummary
 *
 * The org comes from the session (requireSessionAccount), never the request.
 * The Splash Wallet balance is not here: the page reads it from the chain.
 */
export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  const { orgId } = accountCheck.account;

  const transfers = await listTransfersFor(orgId, MAX_TRANSFERS);

  // Wallet payments live only in Postgres. Reads run one after another: the
  // local dev database serves a single connection.
  let walletPayments: Awaited<ReturnType<typeof listUsdcRecords>> = [];
  if (process.env.DATABASE_URL) {
    const { getDb } = await import('@/lib/db/client');
    const db = getDb();
    walletPayments = await listUsdcRecords(db, orgId);
  }

  // Hydration lapses whatever has passed its expiry, as on /queue.
  const store = getOxwalProposalStore();
  await ensureProposalStoreHydrated(store);
  const proposals = store.list();

  const summary = buildHomeSummary({ orgId, now: new Date(), transfers, walletPayments, proposals });
  return NextResponse.json(summary, { headers: { 'Cache-Control': 'no-store' } });
}
