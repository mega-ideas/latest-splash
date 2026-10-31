import { NextResponse } from 'next/server';

import { resolveAuthorityForSession, UnauthorizedError } from '@/lib/auth/authority';
import { currentWalletMembers, walletRegistration } from '@/lib/server/business-wallet';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { orgMemberNames } from '@/lib/server/org-member-names';
import { requireSessionAccount } from '@/lib/server/session-account';
import { liveWalletContext } from '@/lib/server/wallet-deps';
import { buildWalletOverview } from '@/lib/server/wallet-overview';
import { NO_STORE } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * What the Wallet page reads first (v2 brief 5.5): the caller's role, whether
 * the business has a Splash Wallet and which, its USDC balance with what is
 * held, and its signers and threshold. The business is the session's
 * (requireSessionAccount, WS2); nothing is read from the request.
 *
 * `walletState` is `ready`, `none` (no wallet yet), `pending` (being set up),
 * `off` (business wallets are not switched on here) or `unavailable` (the
 * chain did not answer). Whatever cannot be read is said so, never guessed.
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

  const live = await liveWalletContext(authority.orgId);
  if (!live.ok) {
    const walletState = live.status === 409 ? 'none' : live.status === 503 ? 'off' : 'unavailable';
    return NextResponse.json(
      { role: authority.role, walletState, wallet: null, balance: null, balanceError: null, signers: null, canManage: authority.role === 'OWNER' },
      { headers: NO_STORE },
    );
  }
  const { ctx, db } = live;
  const orgId = authority.orgId;
  const overview = await buildWalletOverview({
    userId: authority.userId,
    role: authority.role,
    readAccount: () => ctx.readAccount(),
    readUsdc: ctx.readUsdc,
    heldUsdc: ctx.heldUsdc,
    signers: async () => {
      const current = await currentWalletMembers(ctx, db, orgId);
      if (!current.ok) return null;
      const registration = walletRegistration(current.members);
      return { threshold: registration.threshold, singleSigner: registration.singleSigner, members: current.members.members.map((m) => ({ userId: m.userId, weight: m.weight })) };
    },
    // Names of members of THIS business only: the membership join keeps another business's people out.
    namesOf: (ids) => orgMemberNames(db, orgId, ids),
  });
  return NextResponse.json(overview, { headers: NO_STORE });
}
