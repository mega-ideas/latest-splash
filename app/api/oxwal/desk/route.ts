import { NextResponse } from 'next/server';

import { getOxwalProposalStore } from '@/lib/agent/oxwal';
import { buildZekeDeskSnapshot } from '@/lib/agent/zeke-desk';
import { ensureProposalStoreHydrated } from '@/lib/queue/proposal-persistence';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { requireSessionAccount } from '@/lib/server/session-account';

export const dynamic = 'force-dynamic';

/**
 * What the Zeke page and the floating Zeke open with (v2 brief 5.3): how many
 * payments wait for a decision in this workspace, when the soonest closes,
 * and what Zeke prepared lately.
 *
 * A read. The workspace is the session's (requireSessionAccount), never a
 * parameter, and the store's other tenants are filtered out before anything
 * is counted (lib/agent/zeke-desk.ts). A signed-in account with no workspace
 * gets the 403 that says so, which the client shows as "not known" rather
 * than as zero.
 */
export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  const account = accountCheck.account;

  const store = getOxwalProposalStore();
  await ensureProposalStoreHydrated(store);

  const snapshot = buildZekeDeskSnapshot({
    proposals: store.list(),
    orgId: account.orgId,
    now: new Date(),
    displayName: auth.session.name,
  });
  return NextResponse.json(snapshot, { headers: { 'Cache-Control': 'no-store' } });
}
