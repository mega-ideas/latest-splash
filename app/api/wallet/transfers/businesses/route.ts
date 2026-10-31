import { NextResponse } from 'next/server';

import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { findBusinesses } from '@/lib/server/wallet-transfers';
import { transferRoute } from '@/lib/server/wallet-transfers-deps';
import { NO_STORE, requireWithdrawalRequester } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * GET ?q=: Splash businesses by registered name (a prefix, at least three
 * letters, five at most). Only businesses that have finished verification and
 * have an account on chain are found, a business is never offered itself, and
 * only a name, a country and an id are returned: a search cannot list or
 * describe anyone. Limited per person.
 */
export async function GET(request: Request) {
  const gate = await transferRoute(request);
  if (gate.response) return gate.response;
  const asker = requireWithdrawalRequester(gate.route);
  if (asker) return asker;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.transferSearchUser, key: gate.route.authority.userId });
  if (limited) return limited;
  const q = new URL(request.url).searchParams.get('q') ?? '';
  return NextResponse.json(await findBusinesses(gate.deps, q), { headers: NO_STORE });
}
