import { readJsonBody } from '@/lib/server/http';
import { limitWalletRequests, requireFundsAccess } from '@/lib/server/wallet-route';
import { quoteWithdrawal } from '@/lib/server/withdrawals';
import { withdrawalResponse, withdrawalRoute } from '@/lib/server/withdrawals-deps';

export const dynamic = 'force-dynamic';

/**
 * POST { destinationId, amountMinor }: a quote for an owner or a staff
 * member about to ask the owners, first, and only once
 * the wallet holds the USDC and Splash's fee. The partner's rate and each of
 * its own fee lines, Splash's bank-payout fee (`maxFeeMinor`, to be sent back
 * as shown) and when the rate lapses. Nothing is stored.
 */
export async function POST(request: Request) {
  const gate = await withdrawalRoute(request);
  if (gate.response) return gate.response;
  const noAccess = await requireFundsAccess(gate.route, 'withdraw', 'withdraw to your bank');
  if (noAccess) return noAccess;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  return withdrawalResponse(await quoteWithdrawal(gate.deps, { destinationId: String(body.destinationId ?? ''), amountMinor: body.amountMinor }));
}
