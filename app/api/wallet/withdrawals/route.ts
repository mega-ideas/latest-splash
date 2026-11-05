import { validClientKey } from '@/lib/funding/wallet-funding';
import { readJsonBody } from '@/lib/server/http';
import { makePaymentRecorder } from '@/lib/server/payment-record';
import { sealAdapter } from '@/lib/server/seal';
import { fundsAccessOf } from '@/lib/server/team-admin';
import { limitWalletRequests, requireFundsAccess } from '@/lib/server/wallet-route';
import { storeEncryptedInvoice } from '@/lib/server/walrus';
import { createWithdrawal, listWithdrawalDestinations, listWithdrawals, parseBankPayoutRequest, withdrawalDepositAddress } from '@/lib/server/withdrawals';
import { withdrawalResponse, withdrawalRoute } from '@/lib/server/withdrawals-deps';
import { withdrawalByClientKey } from '@/lib/server/withdrawals-store';

export const dynamic = 'force-dynamic';

/**
 * Withdrawals to the business's own bank (v2 §4.4).
 *
 * GET   this business's withdrawals (amounts and statuses). Its own bank
 *       accounts and its deposit address with the partner go only to the
 *       owners and the members an owner let withdraw (Settings → Team);
 *       everyone else gets neither, and no account on the withdrawals.
 * POST  an owner, or a member an owner let withdraw and who is asking the
 *       owners to approve, withdraws: { destinationId, amountMinor, acceptedReceiveMinor,
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
  // Bank accounts and the deposit address are for the owners and the members an owner let withdraw; everyone else sees amounts and statuses only.
  if (!(await fundsAccessOf(gate.route.db, gate.route.orgId, gate.route.authority.userId)).withdraw) {
    return withdrawalResponse({ ok: true, withdrawals: withdrawals.map((w) => ({ ...w, destination: null })), destinations: [], depositAddress: null });
  }
  return withdrawalResponse({ ok: true, withdrawals, destinations, depositAddress });
}

export async function POST(request: Request) {
  const gate = await withdrawalRoute(request);
  if (gate.response) return gate.response;
  const noAccess = await requireFundsAccess(gate.route, 'withdraw', 'withdraw to your bank');
  if (noAccess) return noAccess;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const clientKey = validClientKey(request.headers.get('idempotency-key') ?? body.clientKey);
  // A retry of a withdrawal already made is answered before any bundle is
  // used, so it seals nothing a second time. A new request is sealed only
  // when the checks that need no partner already pass (the amounts, the
  // account, the verified deposit address): nothing is sealed for a request
  // about to be refused. No stand-in bundle is ever passed on: when nothing
  // was sealed, createWithdrawal is given none and refuses a new withdrawal.
  let bundle: { contentHash?: string; walrusBlobId?: string } = {};
  const prior = clientKey ? await withdrawalByClientKey(gate.route.db, gate.route.orgId, clientKey) : null;
  if (!prior && clientKey) {
    const parsed = parseBankPayoutRequest({ amountMinor: body.amountMinor, acceptedReceiveMinor: body.acceptedReceiveMinor, maxFeeMinor: body.maxFeeMinor }, 'withdraw');
    const destination = (await listWithdrawalDestinations(gate.deps)).find((d) => d.id === String(body.destinationId ?? '')) ?? null;
    const deposit = await withdrawalDepositAddress(gate.deps);
    if (!('ok' in parsed) && destination && deposit?.status === 'verified') {
      const record = await makePaymentRecorder({ seal: sealAdapter, store: storeEncryptedInvoice })({
        orgId: gate.route.orgId,
        transferId: clientKey,
        payer: (await gate.deps.companyName()) ?? gate.route.orgId,
        payee: destination.holderName,
        amountMinor: parsed.amount.toString(),
        maxFeeMinor: parsed.shownFee.toString(),
        reference: `Withdrawal to own bank account ${destination.id}; the bank receives at least ${parsed.accepted.toString()} ${destination.currency} (minor units)`,
      });
      if (!record.ok) return withdrawalResponse(record);
      bundle = { contentHash: Buffer.from(record.contentHash).toString('hex'), walrusBlobId: Buffer.from(record.walrusBlobId).toString('hex') };
    }
  }
  const result = await createWithdrawal(gate.deps, gate.route.authority.userId, {
    clientKey: request.headers.get('idempotency-key') ?? body.clientKey,
    destinationId: body.destinationId,
    amountMinor: body.amountMinor,
    acceptedReceiveMinor: body.acceptedReceiveMinor,
    maxFeeMinor: body.maxFeeMinor,
    contentHash: bundle.contentHash,
    walrusBlobId: bundle.walrusBlobId,
  });
  return withdrawalResponse(result, result.ok && result.created ? 201 : 200);
}
