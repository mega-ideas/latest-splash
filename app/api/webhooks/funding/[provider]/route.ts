import { NextResponse } from 'next/server';

import { handleProviderWebhook } from '@/lib/server/wallet-funding';
import { fundingDepsForOrg } from '@/lib/server/wallet-funding-deps';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const MAX_BODY_BYTES = 64 * 1024;

/**
 * A funding partner's status update for one top-up (v2 §4.3).
 *
 * The raw body's signature is checked first, inside a five-minute replay
 * window; nothing is parsed or read before that. The event is matched to its
 * top-up by id and by the partner's own order reference, counted once per
 * event id, and never moves a status backwards. A delivery is recorded only
 * from the chain, by the Sui digest the partner names: a webhook cannot make
 * money appear. In production every partner refuses until its API is wired.
 */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'funding webhooks need the database' }, { status: 503, headers: NO_STORE });
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return NextResponse.json({ error: 'body too large' }, { status: 413, headers: NO_STORE });
  const { getDb } = await import('@/lib/db/client');
  const { status, body } = await handleProviderWebhook(
    { provider, rawBody, signature: request.headers.get('x-splash-funding-signature'), env: process.env, now: new Date(), db: getDb() as never },
    fundingDepsForOrg,
  );
  return NextResponse.json(body, { status, headers: NO_STORE });
}
