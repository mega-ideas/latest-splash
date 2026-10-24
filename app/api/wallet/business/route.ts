import { NextResponse } from 'next/server';

import { startBusinessWallet } from '@/lib/server/business-wallet';
import { readJsonBody } from '@/lib/server/http';
import { orgOwnerPasskeys } from '@/lib/server/wallet-deps';
import { asResponse, NO_STORE, walletRoute } from '@/lib/server/wallet-route';
import { listSigningRequests } from '@/lib/server/wallet-signing-store';

export const dynamic = 'force-dynamic';

/**
 * The Business Splash Wallet for the signed-in person's org (v2 §4.1).
 *
 * GET   who can be a signer (owners with a passkey on this origin) and the
 *       org's wallet requests.
 * POST  the founder starts the wallet: Splash builds the multisig of every
 *       owner's passkey (2-of-N unless the business chose otherwise) and asks
 *       the founder to sign the nomination; the members are asked to sign the
 *       registration once it lands.
 */
export async function GET(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const { orgId, db } = gate.route;
  const [owners, requests] = await Promise.all([orgOwnerPasskeys(db, orgId), listSigningRequests(db, orgId)]);
  return NextResponse.json(
    {
      owners: owners.map((o) => ({ userId: o.userId, address: o.address, founder: o.founder })),
      requests: requests.map((r) => ({ id: r.id, purpose: r.purpose, status: r.status, digest: r.txDigest, expiresAt: r.expiresAt.toISOString(), executedDigest: r.executedDigest })),
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const { orgId, authority, ctx, db } = gate.route;
  if (authority.role !== 'OWNER') {
    return NextResponse.json({ error: 'Only an owner can set up the business wallet.' }, { status: 403, headers: NO_STORE });
  }
  const owners = await orgOwnerPasskeys(db, orgId);
  const founder = owners.find((o) => o.founder);
  if (!founder || founder.userId !== authority.userId) {
    return NextResponse.json({ error: 'The founder starts the business wallet, with their passkey.' }, { status: 403, headers: NO_STORE });
  }
  const body = await readJsonBody(request);
  const threshold = body.threshold === undefined ? undefined : Number(body.threshold);
  const result = await startBusinessWallet(ctx, {
    orgId,
    requestedBy: authority.userId,
    founder: { userId: founder.userId, passkeyPublicKey: founder.publicKey },
    owners: owners.map((o) => ({ userId: o.userId, publicKey: o.publicKey })),
    threshold,
    singleSignerChosen: body.singleSignerChosen === true,
  });
  return asResponse(result, result.ok ? { request: result.request } : undefined);
}
