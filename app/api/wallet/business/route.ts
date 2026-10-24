import { NextResponse } from 'next/server';

import { planBusinessWallet, startBusinessWallet } from '@/lib/server/business-wallet';
import { readJsonBody } from '@/lib/server/http';
import { orgWalletMembers } from '@/lib/server/wallet-deps';
import { asResponse, limitWalletRequests, NO_STORE, requireOwner, walletRoute } from '@/lib/server/wallet-route';
import { listSigningRequests, singleSignerConsents } from '@/lib/server/wallet-signing-store';

export const dynamic = 'force-dynamic';

/**
 * The Business Splash Wallet for the signed-in person's org (v2 §4.1).
 *
 * GET   the wallet the BusinessAccount names on chain, who can be a signer
 *       (owners with a passkey on this site), who cannot yet, and the org's
 *       wallet requests.
 * POST  the founder (the account's on-chain owner) starts the wallet: Splash
 *       builds the multisig of every owner's passkey (2-of-N unless the
 *       business chose otherwise, and a single-signer wallet only once every
 *       other owner agreed), and asks the founder to sign one transaction
 *       that makes each member an on-chain owner and nominates the wallet.
 *       An owner without a passkey blocks it until the founder confirms, by
 *       name, that they are left out (`confirmExcluded`).
 */
export async function GET(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const { orgId, db, ctx } = gate.route;
  let account;
  try {
    account = await ctx.readAccount();
  } catch {
    return NextResponse.json({ error: 'The business account could not be read from the chain.' }, { status: 502, headers: NO_STORE });
  }
  const [{ candidates, missing }, requests] = await Promise.all([orgWalletMembers(db, orgId, account), listSigningRequests(db, orgId)]);
  return NextResponse.json(
    {
      wallet: account.wallet,
      pendingWallet: account.pendingWallet,
      owners: candidates.map((o) => ({ userId: o.userId, address: o.address, founder: o.founder, onChainOwner: o.onChainOwner })),
      ownersWithoutPasskey: missing,
      requests: requests.map((r) => ({ id: r.id, purpose: r.purpose, status: r.status, digest: r.txDigest, expiresAt: r.expiresAt.toISOString(), executedDigest: r.executedDigest })),
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const notOwner = requireOwner(route, 'set up the business wallet');
  if (notOwner) return notOwner;
  const limited = await limitWalletRequests(route);
  if (limited) return limited;

  const { orgId, authority, ctx, db } = route;
  let account;
  try {
    account = await ctx.readAccount();
  } catch {
    return NextResponse.json({ error: 'The business account could not be read from the chain.' }, { status: 502, headers: NO_STORE });
  }
  const body = await readJsonBody(request);
  const { candidates, missing } = await orgWalletMembers(db, orgId, account);
  const ask = {
    requestedBy: authority.userId,
    candidates,
    missing,
    threshold: body.threshold === undefined ? undefined : Number(body.threshold),
    singleSignerChosen: body.singleSignerChosen === true,
    confirmExcluded: Array.isArray(body.confirmExcluded) ? body.confirmExcluded.map(String) : undefined,
  };
  let plan = planBusinessWallet(ask);
  if (!plan.ok && plan.code === 'consent_needed') {
    const wallet = String(plan.details?.wallet ?? '');
    plan = planBusinessWallet({ ...ask, consents: await singleSignerConsents(db, orgId, wallet) });
  }
  if (!plan.ok) return asResponse(plan);

  const founder = plan.founder as NonNullable<typeof plan.founder>;
  const result = await startBusinessWallet(ctx, {
    orgId,
    requestedBy: authority.userId,
    founder: { userId: founder.userId, passkeyPublicKey: founder.publicKey },
    owners: plan.owners,
    threshold: ask.threshold,
    singleSignerChosen: ask.singleSignerChosen,
  });
  return asResponse(result, result.ok ? { request: result.request } : undefined);
}
