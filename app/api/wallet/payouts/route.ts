import { readJsonBody } from '@/lib/server/http';
import { createPartnerPayout, listPartnerPayouts, listPayoutBeneficiaries, SUPPLIER_PAYOUT_PARTNERS } from '@/lib/server/partner-payouts';
import { limitWalletRequests, requirePayoutReader, requireWithdrawalRequester } from '@/lib/server/wallet-route';
import { withdrawalDepositAddress } from '@/lib/server/withdrawals';
import { withdrawalResponse, withdrawalRoute } from '@/lib/server/withdrawals-deps';

export const dynamic = 'force-dynamic';

/**
 * Payouts to a supplier's bank through the payout partners (v2 §4.5).
 *
 * GET   this business's supplier payouts, its suppliers' accounts and its
 *       deposit address with each route's partner.
 * POST  an owner, or a staff member asking the owners to approve, pays:
 *       { beneficiaryId, amountMinor, acceptedReceiveMinor, maxFeeMinor,
 *       purposeCode, sourceOfFunds, remittanceInfo?, contentHash,
 *       walrusBlobId } with an Idempotency-Key header (or `clientKey`). The
 *       partner is instructed first, then the owners are asked to sign; the
 *       answer carries the signing request.
 */
export async function GET(request: Request) {
  const gate = await withdrawalRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  const [payouts, beneficiaries, ...addresses] = await Promise.all([
    listPartnerPayouts(gate.deps),
    listPayoutBeneficiaries(gate.deps),
    ...SUPPLIER_PAYOUT_PARTNERS.map((p) => withdrawalDepositAddress(gate.deps, p)),
  ]);
  return withdrawalResponse({ ok: true, payouts, beneficiaries, depositAddresses: addresses.filter(Boolean) });
}

export async function POST(request: Request) {
  const gate = await withdrawalRoute(request);
  if (gate.response) return gate.response;
  const asker = requireWithdrawalRequester(gate.route);
  if (asker) return asker;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const result = await createPartnerPayout(gate.deps, gate.route.authority.userId, {
    clientKey: request.headers.get('idempotency-key') ?? body.clientKey,
    beneficiaryId: body.beneficiaryId,
    amountMinor: body.amountMinor,
    acceptedReceiveMinor: body.acceptedReceiveMinor,
    maxFeeMinor: body.maxFeeMinor,
    purposeCode: body.purposeCode,
    sourceOfFunds: body.sourceOfFunds,
    remittanceInfo: body.remittanceInfo,
    contentHash: body.contentHash,
    walrusBlobId: body.walrusBlobId,
  });
  return withdrawalResponse(result, result.ok && result.created ? 201 : 200);
}
