import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { liveOverviewDeps } from '@/lib/server/treasury-deps';
import { answer, treasuryCaller } from '@/lib/server/treasury-route';
import { handleTreasuryOverview } from '@/lib/server/treasury-wallet';

export const dynamic = 'force-dynamic';

/**
 * Treasury in the business's own wallet (v2 D9, brief 5.7). Not locked by
 * custody: USDY sits in the business wallet, and Splash holds nothing.
 *
 * GET
 *   what Treasury may do on this server (flags), whether the caller may hand
 *   a swap to the signers (canOrder, from the server's own role list), who
 *   the issuer and the fund manager are called here (their names only if
 *   signed, their roles otherwise), the USDY price and the modeled rate, this
 *   org's orders, and the business wallet's USDC and USDY from Sui.
 *
 *   The wallet is the org's own, resolved on the server from its
 *   BusinessAccount (lib/server/treasury-business-wallet.ts); no address in
 *   the request is read. Balances are public chain data, read and never
 *   stored, and a chain error is a fixed sentence, logged on the server.
 */
export async function GET(request: Request) {
  const gate = await treasuryCaller(request);
  if (gate.response) return gate.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.treasuryOverviewUser, key: gate.session.email });
  if (limited) return limited;
  return answer(await handleTreasuryOverview(gate.caller, liveOverviewDeps()));
}
