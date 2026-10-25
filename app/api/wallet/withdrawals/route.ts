import { readJsonBody } from '@/lib/server/http';
import { limitWalletRequests, requireOwner } from '@/lib/server/wallet-route';
import { createWithdrawal, listWithdrawalDestinations, listWithdrawals, withdrawalDepositAddress } from '@/lib/server/withdrawals';
import { withdrawalResponse, withdrawalRoute } from '@/lib/server/withdrawals-deps';

export const dynamic = 'force-dynamic';

/**
 * Withdrawals to the business's own bank (v2 §4.4).
 *
 * GET   this business's withdrawals, its own bank accounts and its deposit
 *       address with the partner.
 * POST  an owner withdraws: { destinationId, amountMinor, acceptedReceiveMinor,
 *       maxFeeMinor, contentHash, walrusBlobId } with an Idempotency-Key
 *       header (or `clientKey`). `acceptedReceiveMinor` and `maxFeeMinor` are
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
  const owner = requireOwner(gate.route, 'withdraw from the business wallet');
  if (owner) return owner;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const result = await createWithdrawal(gate.deps, gate.route.authority.userId, {
    clientKey: request.headers.get('idempotency-key') ?? body.clientKey,
    destinationId: body.destinationId,
    amountMinor: body.amountMinor,
    acceptedReceiveMinor: body.acceptedReceiveMinor,
    maxFeeMinor: body.maxFeeMinor,
    contentHash: body.contentHash,
    walrusBlobId: body.walrusBlobId,
  });
  return withdrawalResponse(result, result.ok && result.created ? 201 : 200);
}
