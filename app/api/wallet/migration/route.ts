import { NextResponse } from 'next/server';

import { gaslessEnabled } from '@/lib/payments/stablecoin-lane';
import { collectCoins, detectMemberFunds, requestMigrationTransfer } from '@/lib/server/business-wallet';
import { orgMemberWalletAddresses, walletUsdcType } from '@/lib/server/wallet-deps';
import { asResponse, limitWalletRequests, NO_STORE, walletRoute } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * Moving from the per-person passkey wallets to the business wallet.
 *
 * GET   read-only: USDC still held at any passkey address of any member of
 *       this business (owners and staff, every passkey they have had,
 *       revoked or on another site included). `canMove` is false for an
 *       address whose passkey cannot sign here; its holder moves it from the
 *       site that passkey belongs to.
 * POST  the signed-in member's own "Move to your business wallet": one plain
 *       transfer of what their active passkey wallet here holds in USDC,
 *       which they sign alone (Sky's decision), gasless. Coin objects are
 *       read page by page; a wallet with more than one transfer's worth of
 *       coins moves the rest with a second request (`more`).
 *
 * The business wallet is the one the BusinessAccount names on chain.
 */

async function businessWallet(readAccount: () => Promise<{ wallet: string | null }>): Promise<string | null> {
  return (await readAccount()).wallet;
}

export async function GET(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const { orgId, db, ctx } = gate.route;
  let wallet: string | null;
  try {
    wallet = await businessWallet(ctx.readAccount);
  } catch {
    return NextResponse.json({ error: 'The business account could not be read from the chain.' }, { status: 502, headers: NO_STORE });
  }
  const addresses = (await orgMemberWalletAddresses(db, orgId)).filter((a) => a.address !== wallet);
  const read = ctx.readUsdc;
  if (!read) return NextResponse.json({ error: 'Balances cannot be read from the chain.' }, { status: 503, headers: NO_STORE });
  const found = await detectMemberFunds(read, addresses);
  const canSign = new Map(addresses.map((a) => [a.address, a.canSign]));
  return NextResponse.json(
    {
      businessWallet: wallet,
      members: found.map((f) => ({ userId: f.userId, address: f.address, usdcMinor: f.usdcMinor.toString(), canMove: canSign.get(f.address) === true })),
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const limited = await limitWalletRequests(route);
  if (limited) return limited;
  const { orgId, authority, ctx, db } = route;
  let wallet: string | null;
  try {
    wallet = await businessWallet(ctx.readAccount);
  } catch {
    return NextResponse.json({ error: 'The business account could not be read from the chain.' }, { status: 502, headers: NO_STORE });
  }
  if (!wallet) return NextResponse.json({ error: 'Register the business wallet first.' }, { status: 409, headers: NO_STORE });
  const me = (await orgMemberWalletAddresses(db, orgId)).find((a) => a.userId === authority.userId && a.canSign);
  if (!me) return NextResponse.json({ error: 'You have no passkey wallet on this site in this business.' }, { status: 404, headers: NO_STORE });

  const { suiClient } = await import('@/lib/sui');
  const coinType = walletUsdcType();
  const [{ coins, more }, funds] = await Promise.all([
    collectCoins(async (cursor) => {
      const page = await suiClient.core.listCoins({ owner: me.address, coinType, cursor });
      return { objects: page.objects.map((c) => ({ objectId: c.objectId, version: c.version, digest: c.digest })), hasNextPage: page.hasNextPage, cursor: page.cursor };
    }),
    ctx.readUsdc ? ctx.readUsdc(me.address) : Promise.resolve({ coinMinor: 0n, addressBalanceMinor: 0n }),
  ]);
  const result = await requestMigrationTransfer(ctx, {
    orgId,
    member: { userId: authority.userId, passkeyPublicKey: me.publicKey },
    businessWallet: wallet,
    coins,
    addressBalanceMinor: funds.addressBalanceMinor,
    gasless: gaslessEnabled(),
  });
  return asResponse(result, result.ok ? { request: result.request, more } : undefined);
}
