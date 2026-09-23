import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { requireSessionAccount } from '@/lib/server/session-account';
import { NO_LEDGER_RESPONSE } from '@/lib/server/stablecoin-deps';
import { liveX402Deps } from '@/lib/server/x402-deps';
import { probeX402 } from '@/lib/server/x402-pay';

export const dynamic = 'force-dynamic';

function respond(result: { ok: boolean; status?: number } & Record<string, unknown>, okStatus = 200) {
  if (!result.ok) {
    const { status, ...rest } = result;
    return NextResponse.json(rest, { status: status ?? 400, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json(result, { status: okStatus, headers: { 'Cache-Control': 'no-store' } });
}

/** Read an x402 resource's price — nothing is reserved, signed or paid. */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.stablecoinQuoteUser, key: auth.session.email });
  if (limited) return limited;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  const deps = await liveX402Deps();
  if (!deps) return NextResponse.json(NO_LEDGER_RESPONSE, { status: 503 });

  const body = await readJsonBody(request);
  const probe = await probeX402(deps, String(body.url ?? ''));
  if (!probe.ok) {
    const { pr, ...rest } = probe;
    return respond({ ...rest, offered: pr?.accepts.map((a) => ({ network: a.network, scheme: a.scheme, asset: a.asset, amountMinor: a.amountMinor.toString() })) ?? [] });
  }
  return respond({
    ok: true,
    x402Version: probe.pr.x402Version,
    resource: probe.pr.resource,
    amountMinor: probe.accept.amountMinor.toString(),
    payTo: probe.payTo,
    network: probe.accept.network,
    gasStation: typeof probe.accept.extra.gasStation === 'string',
  });
}
