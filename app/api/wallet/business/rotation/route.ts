import { NextResponse } from 'next/server';

import { cancelWalletRotation, currentWalletMembers, planBusinessWallet, startWalletRotation } from '@/lib/server/business-wallet';
import { readJsonBody } from '@/lib/server/http';
import { orgWalletMembers } from '@/lib/server/wallet-deps';
import { asResponse, limitWalletRequests, NO_STORE, requireOwner, walletRoute } from '@/lib/server/wallet-route';
import { singleSignerConsents } from '@/lib/server/wallet-signing-store';

export const dynamic = 'force-dynamic';

/**
 * Change the business wallet's signers (v2 §4.1, §5.9 "wallet rotation").
 *
 * POST    an owner proposes the wallet today's owners' passkeys make (the
 *         same rules as creating one: nobody left out silently, and a
 *         single-signer wallet only with every other owner's consent). The
 *         CURRENT wallet, as the BusinessAccount names it on chain, signs
 *         `rotate_wallet`; when that lands the new wallet's quorum is asked
 *         to confirm, and then the old wallet's quorum to move its USDC to
 *         the new one.
 * DELETE  the current wallet withdraws a rotation not yet confirmed.
 */
export async function POST(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const notOwner = requireOwner(route, 'change the wallet signers');
  if (notOwner) return notOwner;
  const limited = await limitWalletRequests(route);
  if (limited) return limited;
  const { orgId, authority, ctx, db } = route;

  const current = await currentWalletMembers(ctx, db, orgId);
  if (!current.ok) return asResponse(current);
  if (current.account.pendingWallet) {
    return NextResponse.json({ error: 'A change of signers is already waiting to be confirmed.' }, { status: 409, headers: NO_STORE });
  }
  const body = await readJsonBody(request);
  const { candidates, missing } = await orgWalletMembers(db, orgId, current.account);
  const ask = {
    requestedBy: authority.userId,
    candidates,
    missing,
    rotation: true,
    threshold: body.threshold === undefined ? undefined : Number(body.threshold),
    singleSignerChosen: body.singleSignerChosen === true,
    confirmExcluded: Array.isArray(body.confirmExcluded) ? body.confirmExcluded.map(String) : undefined,
  };
  let plan = planBusinessWallet(ask);
  if (!plan.ok && plan.code === 'consent_needed') {
    plan = planBusinessWallet({ ...ask, consents: await singleSignerConsents(db, orgId, String(plan.details?.wallet ?? '')) });
  }
  if (!plan.ok) return asResponse(plan);

  const result = await startWalletRotation(ctx, {
    orgId,
    requestedBy: authority.userId,
    current: current.members,
    owners: plan.owners,
    threshold: ask.threshold,
    singleSignerChosen: ask.singleSignerChosen,
  });
  return asResponse(result, result.ok ? { request: result.request } : undefined);
}

export async function DELETE(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const notOwner = requireOwner(route, 'withdraw a change of signers');
  if (notOwner) return notOwner;
  const limited = await limitWalletRequests(route);
  if (limited) return limited;
  const current = await currentWalletMembers(route.ctx, route.db, route.orgId);
  if (!current.ok) return asResponse(current);
  if (!current.account.pendingWallet) {
    return NextResponse.json({ error: 'No change of signers is waiting.' }, { status: 409, headers: NO_STORE });
  }
  const result = await cancelWalletRotation(route.ctx, { orgId: route.orgId, requestedBy: route.authority.userId, current: current.members });
  return asResponse(result, result.ok ? { request: result.request } : undefined);
}
