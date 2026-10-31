import { complianceResponse, exchangePaymentDepsFor, travelRuleProviderOrRefusal } from '@/lib/server/compliance-deps';
import { travelRuleForPayment } from '@/lib/server/exchange-payment-compliance';
import { readJsonBody } from '@/lib/server/http';
import { limitWalletRequests, requireWithdrawalRequester, walletRoute } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * Send the Travel Rule message for a wallet payment to an exchange
 * recipient (v2 §4.6), once: `{ exchange, purpose? }` for the payment named
 * by its signing request. The payment, the payer, the supplier and the
 * business's applicant are read on the server; the recipient's newest
 * screening must be CLEAR. A retry answers the same transfer. Production
 * without Sumsub's Travel Rule configured refuses (503) and records nothing.
 */
export async function POST(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const asker = requireWithdrawalRequester(gate.route);
  if (asker) return asker;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const tr = travelRuleProviderOrRefusal();
  if (tr.response) return tr.response;
  const { ref } = await params;
  const body = await readJsonBody(request);
  const result = await travelRuleForPayment(
    { ...exchangePaymentDepsFor(gate.route), provider: tr.provider },
    { requestId: ref, exchange: body.exchange, purpose: body.purpose, createdBy: gate.route.authority.userId },
  );
  return complianceResponse(result, result.ok && result.created ? 201 : 200);
}
