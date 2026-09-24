import { NextResponse } from 'next/server';

import { relyingPartyId } from '@/lib/auth/passkey';
import { RATE_LIMITS, clientIp, enforceRateLimit } from '@/lib/server/rate-limit';
import { checkInvoiceUsdcPayment, invoiceUsdcBySlug } from '@/lib/server/usdc-invoice-payments';

/**
 * "I've sent it — check": has this invoice been paid in USDC on Sui?
 *
 * Public, like the pay link it belongs to — the slug is the capability — and
 * limited by network before the slug is looked up. It reads the issuer's
 * wallet from chain and records the matching transfer once
 * (lib/server/usdc-invoice-payments.ts). It moves nothing.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const limited = await enforceRateLimit({
    rule: RATE_LIMITS.payLinkUsdcIp,
    key: clientIp(request),
    message: 'Too many payment checks from this network. Try again shortly.',
  });
  if (limited) return limited;
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'USDC payments need the database.' }, { status: 503 });
  }

  const { slug } = await params;
  const { getDb } = await import('@/lib/db/client');
  const db = getDb();
  const row = await invoiceUsdcBySlug(db, slug);
  if (!row) return NextResponse.json({ error: 'Payment request not found' }, { status: 404 });

  const result = await checkInvoiceUsdcPayment(db, row, { rpId: relyingPartyId() });
  const body = result.status === 'NOT_SEEN' ? { ...result, expectedMinor: result.expectedMinor.toString() } : result;
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
