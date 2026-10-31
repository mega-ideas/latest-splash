import { validClientKey } from '@/lib/funding/wallet-funding';
import { readJsonBody } from '@/lib/server/http';
import { makePaymentRecorder } from '@/lib/server/payment-record';
import { sealAdapter } from '@/lib/server/seal';
import { bigintField, limitWalletRequests, requireWithdrawalRequester } from '@/lib/server/wallet-route';
import { storeEncryptedInvoice } from '@/lib/server/walrus';
import { createWithdrawal, listWithdrawalDestinations, listWithdrawals, withdrawalDepositAddress } from '@/lib/server/withdrawals';
import { withdrawalResponse, withdrawalRoute } from '@/lib/server/withdrawals-deps';
import { withdrawalByClientKey } from '@/lib/server/withdrawals-store';

export const dynamic = 'force-dynamic';

/**
 * Withdrawals to the business's own bank (v2 §4.4).
 *
 * GET   this business's withdrawals, its own bank accounts and its deposit
 *       address with the partner.
 * POST  an owner, or a staff member asking the owners to approve, withdraws: { destinationId, amountMinor, acceptedReceiveMinor,
 *       maxFeeMinor } with an Idempotency-Key header (or `clientKey`). The
 *       sealed audit bundle behind the receipt (its content hash and blob id)
 *       is made here, by the server, and fails closed in production
 *       (lib/server/payment-record.ts): a bundle a client names is ignored. `acceptedReceiveMinor` and `maxFeeMinor` are
 *       the quote's receive amount and Splash fee as shown; a worse rate or a
 *       higher fee is refused. The partner is instructed, then the owners are
 *       asked to sign; the answer carries the signing request.
 */
export async function GET(request: Request) {
  const gate = await withdrawalRoute(request);
  if (gate.response) return gate.response;
  const [withdrawals, destinations, depositAddress] = await Promise.all([
    listWithdrawals(gate.deps),
    listWithdrawalDestinations(gate.deps),
    withdrawalDepositAddress(gate.deps),
  ]);
  return withdrawalResponse({ ok: true, withdrawals, destinations, depositAddress });
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
  // A retry of a withdrawal already made is answered before any bundle is
  // used, so it seals nothing a second time. The cheap checks come first:
  // nothing is sealed for a request about to be refused.
  let contentHash = '00'.repeat(32);
  let walrusBlobId = '00';
  const prior = clientKey ? await withdrawalByClientKey(gate.route.db, gate.route.orgId, clientKey) : null;
  if (!prior && clientKey) {
    const amount = bigintField(body.amountMinor);
    const maxFee = bigintField(body.maxFeeMinor);
    const holder = (await listWithdrawalDestinations(gate.deps)).find((d) => d.id === String(body.destinationId ?? ''))?.holderName ?? null;
    if (holder && amount !== null && amount > 0n && maxFee !== null) {
      const record = await makePaymentRecorder({ seal: sealAdapter, store: storeEncryptedInvoice })({
        orgId: gate.route.orgId,
        transferId: clientKey,
        payer: (await gate.deps.companyName()) ?? gate.route.orgId,
        payee: holder,
        amountMinor: amount.toString(),
        maxFeeMinor: maxFee.toString(),
        reference: 'Withdrawal to own bank account',
      });
      if (!record.ok) return withdrawalResponse(record);
      contentHash = Buffer.from(record.contentHash).toString('hex');
      walrusBlobId = Buffer.from(record.walrusBlobId).toString('hex');
    }
  }
  const result = await createWithdrawal(gate.deps, gate.route.authority.userId, {
    clientKey: request.headers.get('idempotency-key') ?? body.clientKey,
    destinationId: body.destinationId,
    amountMinor: body.amountMinor,
    acceptedReceiveMinor: body.acceptedReceiveMinor,
    maxFeeMinor: body.maxFeeMinor,
    contentHash,
    walrusBlobId,
  });
  return withdrawalResponse(result, result.ok && result.created ? 201 : 200);
}
