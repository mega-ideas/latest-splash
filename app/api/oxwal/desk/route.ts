import { NextResponse } from 'next/server';

import { getOxwalProposalStore } from '@/lib/agent/oxwal';
import { buildZekeDeskSnapshot, type DeskViewer } from '@/lib/agent/zeke-desk';
import { resolveAuthorityForSession, UnauthorizedError } from '@/lib/auth/authority';
import { ensureProposalStoreHydrated } from '@/lib/queue/proposal-persistence';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readGovernanceAlertCountForSession } from '@/lib/server/governance-alerts-store';
import { requireSessionAccount } from '@/lib/server/session-account';

export const dynamic = 'force-dynamic';

/**
 * What the Zeke page and the floating Zeke open with (v2 brief 5.3): how many
 * payments wait for a decision in this workspace, how many of those this
 * person could approve, when the soonest closes, their governance alerts, and
 * what Zeke prepared lately.
 *
 * A read. The workspace is the session's (requireSessionAccount), never a
 * parameter, and the store's other tenants are filtered out before anything
 * is counted (lib/agent/zeke-desk.ts). A signed-in account with no workspace
 * gets the 403 that says so, which the client shows as "not known" rather
 * than as zero. The viewer (user id and role) is the session's membership,
 * the same source /queue reads; when it cannot be read, "waiting for you" is
 * not known either. The alert count is the person's own deliveries.
 */
export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  const account = accountCheck.account;

  let viewer: DeskViewer | null = null;
  try {
    const authority = await resolveAuthorityForSession(auth.session);
    if (authority.orgId === account.orgId) viewer = { userId: authority.userId, role: authority.role };
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
  }

  const store = getOxwalProposalStore();
  await ensureProposalStoreHydrated(store);

  const snapshot = buildZekeDeskSnapshot({
    proposals: store.list(),
    orgId: account.orgId,
    now: new Date(),
    displayName: auth.session.name,
    viewer,
    alerts: await readGovernanceAlertCountForSession(auth.session),
  });
  return NextResponse.json(snapshot, { headers: { 'Cache-Control': 'no-store' } });
}
