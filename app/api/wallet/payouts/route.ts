import { validClientKey } from '@/lib/funding/wallet-funding';
import { readJsonBody } from '@/lib/server/http';
import { createPartnerPayout, listPartnerPayouts, listPayoutBeneficiaries, SUPPLIER_PAYOUT_PARTNERS } from '@/lib/server/partner-payouts';
import { makePaymentRecorder } from '@/lib/server/payment-record';
import { sealAdapter } from '@/lib/server/seal';
import { limitWalletRequests, requirePayoutReader, requireWithdrawalRequester } from '@/lib/server/wallet-route';
import { storeEncryptedInvoice } from '@/lib/server/walrus';
import { withdrawalDepositAddress } from '@/lib/server/withdrawals';
import { withdrawalResponse, withdrawalRoute } from '@/lib/server/withdrawals-deps';
import { withdrawalByClientKey } from '@/lib/server/withdrawals-store';

export const dynamic = 'force-dynamic';

/**
 * Payouts to a supplier's bank through the payout partners (v2 §4.5).
 *
 * GET   this business's supplier payouts, its suppliers' accounts and its
 *       deposit address with each route's partner.
 * POST  an owner, or a staff member asking the owners to approve, pays:
 *       { beneficiaryId, amountMinor, acceptedReceiveMinor, maxFeeMinor,
 *       purposeCode, sourceOfFunds, remittanceInfo? } with an Idempotency-Key
 *       header (or `clientKey`). The sealed audit bundle behind the receipt
 *       (its content hash and blob id) is made here, by the server, and fails
 *       closed in production (lib/server/payment-record.ts): a bundle a client
 *       names is ignored. The partner is instructed first, then the owners are
 *       asked to sign; the answer carries the signing request.
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
  const clientKey = validClientKey(request.headers.get('idempotency-key') ?? body.clientKey);
  // The bundle is the server's to make. A retry of a payout already made is
  // answered before any bundle is used, so it seals nothing a second time.
  let contentHash = '00'.repeat(32);
  let walrusBlobId = '00';
  const prior = clientKey ? await withdrawalByClientKey(gate.route.db, gate.route.orgId, clientKey) : null;
  if (!prior) {
    const holder = (await listPayoutBeneficiaries(gate.deps)).find((b) => b.id === String(body.beneficiaryId ?? ''))?.holderName ?? 'Supplier';
    const record = await makePaymentRecorder({ seal: sealAdapter, store: storeEncryptedInvoice })({
      orgId: gate.route.orgId,
      transferId: clientKey ?? 'no-key',
      payer: (await gate.deps.companyName()) ?? gate.route.orgId,
      payee: holder,
      amountMinor: String(body.amountMinor ?? ''),
      maxFeeMinor: String(body.maxFeeMinor ?? ''),
      reference: typeof body.remittanceInfo === 'string' ? body.remittanceInfo : null,
    });
    if (!record.ok) return withdrawalResponse(record);
    contentHash = Buffer.from(record.contentHash).toString('hex');
    walrusBlobId = Buffer.from(record.walrusBlobId).toString('hex');
  }
  const result = await createPartnerPayout(gate.deps, gate.route.authority.userId, {
    clientKey: request.headers.get('idempotency-key') ?? body.clientKey,
    beneficiaryId: body.beneficiaryId,
    amountMinor: body.amountMinor,
    acceptedReceiveMinor: body.acceptedReceiveMinor,
    maxFeeMinor: body.maxFeeMinor,
    purposeCode: body.purposeCode,
    sourceOfFunds: body.sourceOfFunds,
    remittanceInfo: body.remittanceInfo,
    contentHash,
    walrusBlobId,
  });
  return withdrawalResponse(result, result.ok && result.created ? 201 : 200);
}
