import { readJsonBody } from '@/lib/server/http';
import { quotePartnerPayout } from '@/lib/server/partner-payouts';
import { limitWalletRequests, requireWithdrawalRequester } from '@/lib/server/wallet-route';
import { withdrawalResponse, withdrawalRoute } from '@/lib/server/withdrawals-deps';

export const dynamic = 'force-dynamic';

/**
 * POST { beneficiaryId, amountMinor }: a quote for a supplier payout, only
 * once the wallet holds the USDC and Splash's fee. The partner's rate and
 * each of its own fee lines, Splash's bank-payout fee (`maxFeeMinor`, to be
 * sent back as shown) and when the rate lapses. Nothing is stored.
 */
export async function POST(request: Request) {
  const gate = await withdrawalRoute(request);
  if (gate.response) return gate.response;
  const asker = requireWithdrawalRequester(gate.route);
  if (asker) return asker;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  return withdrawalResponse(await quotePartnerPayout(gate.deps, { beneficiaryId: body.beneficiaryId, amountMinor: body.amountMinor }));
}
