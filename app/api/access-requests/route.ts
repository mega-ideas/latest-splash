import { NextResponse } from 'next/server';

import { parseAccessRequest } from '@/lib/landing/access-request';
import { recordAccessRequest } from '@/lib/server/access-requests';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, clientIp, enforceRateLimit } from '@/lib/server/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A request for pilot access to a route that is not live yet (v2 brief D16),
 * from the landing calculator: email, company, and one of MYR, VND, THB, SGD.
 *
 * Public and write-only: validated (lib/landing/access-request.ts), rate
 * limited by network, stored once per email and route
 * (lib/server/access-requests.ts). A repeat and a honeypot hit get the same
 * answer as a first request, so the response says nothing about who asked
 * before. Nothing here reads the requests back.
 */
export async function POST(request: Request) {
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.accessRequestIp, key: clientIp(request), message: 'Too many requests from this network. Try again later.' });
  if (limited) return limited;

  const parsed = parseAccessRequest(await readJsonBody(request));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 400 });
  if (!parsed.spam) await recordAccessRequest(parsed.value);
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
