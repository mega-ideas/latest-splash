import { NextResponse } from 'next/server';

import { PAYOUT_SIGNATURE_HEADER } from '@/lib/payouts/partner';
import { walletUsdcType } from '@/lib/server/wallet-deps';
import { handlePayoutWebhook } from '@/lib/server/withdrawals';
import { readWithdrawalTransaction } from '@/lib/server/withdrawals-deps';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const MAX_BODY_BYTES = 64 * 1024;

/**
 * A payout partner's status update (v2 §4.4, §4.5): a test deposit it
 * credited, or a payout it received, paid out, failed or returned.
 *
 * The raw body's signature is checked first, inside a five-minute replay
 * window; nothing is parsed or read before that. Each event counts once, by
 * its id. A status never goes backwards. A test deposit and a return are
 * believed only from the chain, by the digest the partner names. In
 * production every partner refuses until its API is wired.
 */
export async function POST(request: Request, { params }: { params: Promise<{ partner: string }> }) {
  const { partner } = await params;
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'payout webhooks need the database' }, { status: 503, headers: NO_STORE });
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return NextResponse.json({ error: 'body too large' }, { status: 413, headers: NO_STORE });
  const { getDb } = await import('@/lib/db/client');
  const { status, body } = await handlePayoutWebhook({
    partner,
    rawBody,
    signature: request.headers.get(PAYOUT_SIGNATURE_HEADER),
    env: process.env,
    now: new Date(),
    db: getDb() as never,
    readTransaction: readWithdrawalTransaction,
    usdcType: walletUsdcType(),
  });
  return NextResponse.json(body, { status, headers: NO_STORE });
}
