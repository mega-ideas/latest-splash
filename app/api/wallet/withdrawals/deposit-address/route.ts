import { readJsonBody } from '@/lib/server/http';
import { limitWalletRequests, refusal, requireOwner } from '@/lib/server/wallet-route';
import { requestPartnerDepositAddress, requestTestDeposit, withdrawalDepositAddress } from '@/lib/server/withdrawals';
import { withdrawalResponse, withdrawalRoute } from '@/lib/server/withdrawals-deps';

export const dynamic = 'force-dynamic';

/**
 * The business's fixed deposit address with the payout partner.
 *
 * GET                                   the address and where its verification is.
 * POST { action: 'request' }            an owner asks the partner for it (unverified).
 * POST { action: 'test_deposit' }       an owner opens the 1 USDC test deposit for the
 *                                       owners to sign; the partner's signed confirmation
 *                                       of that exact deposit verifies the address.
 */
export async function GET(request: Request) {
  const gate = await withdrawalRoute(request);
  if (gate.response) return gate.response;
  return withdrawalResponse({ ok: true, depositAddress: await withdrawalDepositAddress(gate.deps) });
}

export async function POST(request: Request) {
  const gate = await withdrawalRoute(request);
  if (gate.response) return gate.response;
  const owner = requireOwner(gate.route, 'set up withdrawals');
  if (owner) return owner;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  if (body.action === 'request') {
    const result = await requestPartnerDepositAddress(gate.deps, gate.route.authority.userId);
    return withdrawalResponse(result, result.ok && result.created ? 201 : 200);
  }
  if (body.action === 'test_deposit') return withdrawalResponse(await requestTestDeposit(gate.deps, gate.route.authority.userId), 201);
  return refusal(400, "Say 'request' or 'test_deposit'.", 'bad_action');
}
