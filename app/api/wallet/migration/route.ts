import { NextResponse } from 'next/server';

import { gaslessEnabled } from '@/lib/payments/stablecoin-lane';
import { detectMemberFunds, requestMigrationTransfer } from '@/lib/server/business-wallet';
import { orgOwnerPasskeys, walletUsdcType } from '@/lib/server/wallet-deps';
import { asResponse, NO_STORE, walletRoute } from '@/lib/server/wallet-route';
import { listSigningRequests } from '@/lib/server/wallet-signing-store';

export const dynamic = 'force-dynamic';

/**
 * Moving from the per-person passkey wallets to the business wallet.
 *
 * GET   read-only: USDC still held at each owner's own passkey address.
 * POST  the signed-in owner's own "Move to your business wallet": one plain
 *       transfer of everything their passkey wallet holds in USDC, which they
 *       sign alone (Sky's decision), gasless.
 */

/** The wallet the last executed registration or rotation made current. */
async function businessWallet(db: Parameters<typeof listSigningRequests>[0], orgId: string): Promise<string | null> {
  const executed = await listSigningRequests(db, orgId, ['executed']);
  const latest = executed.find((r) => r.purpose === 'register_wallet' || r.purpose === 'confirm_wallet_rotation');
  return latest ? latest.senderAddress : null;
}

async function usdcAt(address: string) {
  const { suiClient } = await import('@/lib/sui');
  const { balance } = await suiClient.core.getBalance({ owner: address, coinType: walletUsdcType() });
  return { coinMinor: BigInt(balance.coinBalance), addressBalanceMinor: BigInt(balance.addressBalance) };
}

export async function GET(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const { orgId, db } = gate.route;
  const wallet = await businessWallet(db, orgId);
  const owners = await orgOwnerPasskeys(db, orgId);
  const found = await detectMemberFunds(usdcAt, owners.filter((o) => o.address !== wallet).map((o) => ({ userId: o.userId, address: o.address })));
  return NextResponse.json(
    { businessWallet: wallet, members: found.map((f) => ({ userId: f.userId, address: f.address, usdcMinor: f.usdcMinor.toString() })) },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const { orgId, authority, ctx, db } = gate.route;
  const wallet = await businessWallet(db, orgId);
  if (!wallet) return NextResponse.json({ error: 'Register the business wallet first.' }, { status: 409, headers: NO_STORE });
  const me = (await orgOwnerPasskeys(db, orgId)).find((o) => o.userId === authority.userId);
  if (!me) return NextResponse.json({ error: 'You have no passkey wallet in this business.' }, { status: 404, headers: NO_STORE });

  const { suiClient } = await import('@/lib/sui');
  const [{ objects }, funds] = await Promise.all([suiClient.core.listCoins({ owner: me.address, coinType: walletUsdcType() }), usdcAt(me.address)]);
  const result = await requestMigrationTransfer(ctx, {
    orgId,
    member: { userId: me.userId, passkeyPublicKey: me.publicKey },
    businessWallet: wallet,
    coins: objects.map((c) => ({ objectId: c.objectId, version: c.version, digest: c.digest })),
    addressBalanceMinor: funds.addressBalanceMinor,
    gasless: gaslessEnabled(),
  });
  return asResponse(result, result.ok ? { request: result.request } : undefined);
}
