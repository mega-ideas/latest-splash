import { NextResponse } from 'next/server';

import { resolveAuthorityForSession, UnauthorizedError } from '@/lib/auth/authority';
import { explorerTxUrl, normaliseSuiAddress, StablecoinLaneError } from '@/lib/payments/stablecoin-lane';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { requireSessionAccount } from '@/lib/server/session-account';
import { loadActivityLabels } from '@/lib/server/usdc-records';
import { labelMovements, readUsdcActivity } from '@/lib/server/wallet-activity';

export const dynamic = 'force-dynamic';

/**
 * A wallet's USDC activity on Sui mainnet — money in as well as money out —
 * named from this workspace's records where it can be. Read-only.
 *
 * With no `address`: the caller's Splash wallet (their passkey's address).
 * With `address`: a connected wallet's public chain history. `before` pages
 * back to older activity.
 */
export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.stablecoinActivityUser, key: auth.session.email });
  if (limited) return limited;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'Wallet activity needs the database.' }, { status: 503 });

  const url = new URL(request.url);
  const asked = url.searchParams.get('address');
  const before = url.searchParams.get('before');
  if (before !== null && !/^[A-Za-z0-9+/=_-]{1,256}$/.test(before)) {
    return NextResponse.json({ error: 'That page cursor is not valid.' }, { status: 400 });
  }

  const { getDb } = await import('@/lib/db/client');
  const db = getDb();
  let address: string;
  if (asked) {
    try {
      address = normaliseSuiAddress(asked);
    } catch (error) {
      if (error instanceof StablecoinLaneError) return NextResponse.json({ error: error.message }, { status: 400 });
      throw error;
    }
  } else {
    let userId: string;
    try {
      userId = (await resolveAuthorityForSession(auth.session)).userId;
    } catch (error) {
      if (error instanceof UnauthorizedError) return NextResponse.json({ error: 'No workspace membership yet.' }, { status: 403 });
      throw error;
    }
    const { findCredential, relyingPartyId } = await import('@/lib/auth/passkey');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const credential = await findCredential(db as any, { userId, rpId: relyingPartyId() });
    if (!credential) {
      return NextResponse.json({ address: null, available: true, movements: [], olderCursor: null, reason: 'No Splash wallet yet: create or restore a passkey in Settings → Security.' });
    }
    address = normaliseSuiAddress(credential.suiAddress);
  }

  const page = await readUsdcActivity(address, { before, limit: 15 });
  if (!page.available) {
    return NextResponse.json({ address, available: false, reason: page.reason }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const { outflowsByDigest, recipientsByAddress, invoicesByDigest } = await loadActivityLabels(
    db,
    accountCheck.account.orgId,
    page.movements.map((m) => m.digest),
  );
  const movements = labelMovements(page.movements, outflowsByDigest, recipientsByAddress, { splashWallet: !asked, invoicesByDigest });
  return NextResponse.json({
    address,
    available: true,
    olderCursor: page.olderCursor,
    movements: movements.map((m) => ({
      digest: m.digest,
      timestamp: m.timestamp,
      success: m.success,
      direction: m.direction,
      amountMinor: m.amountMinor.toString(),
      feeMinor: m.feeMinor?.toString() ?? null,
      counterparty: m.counterparty,
      label: m.label,
      origin: m.origin,
      explorerUrl: explorerTxUrl('mainnet', m.digest),
    })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
