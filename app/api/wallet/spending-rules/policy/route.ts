import { readJsonBody } from '@/lib/server/http';
import { changePolicyLimits, startSpendPolicy } from '@/lib/server/spend-rules';
import { spendRoute, walletMembersOr } from '@/lib/server/spend-rules-route';
import { asResponse, bigintField, limitWalletRequests, refusal, requireOwner } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * The business-wide spending policy (v2 §4.2), signed by the wallet's quorum.
 *
 * POST  { perPaymentMaxMinor }: create the policy for the current wallet
 *       generation (once per wallet; after a rotation, use
 *       POST /api/wallet/spending-rules/reissue instead).
 * PATCH { perPaymentMaxMinor?, secondApprovalThresholdMinor?, runningWindowMs? }:
 *       change the per-payment maximum, the second-approval threshold
 *       (default 10,000 USDC) or the running-total window (an hour to thirty days).
 */
export async function POST(request: Request) {
  const gate = await spendRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const notOwner = requireOwner(route, 'set up spending rules');
  if (notOwner) return notOwner;
  const limited = await limitWalletRequests(route);
  if (limited) return limited;
  const perPaymentMaxMinor = bigintField((await readJsonBody(request)).perPaymentMaxMinor);
  if (perPaymentMaxMinor === null) return refusal(400, 'Give the most any one payment under a rule may be.');
  const members = await walletMembersOr(route);
  if (members.response) return members.response;
  const result = await startSpendPolicy(route.sc, { orgId: route.orgId, requestedBy: route.authority.userId, wallet: members.wallet, perPaymentMaxMinor });
  return asResponse(result, result.ok ? { request: result.request } : undefined);
}

export async function PATCH(request: Request) {
  const gate = await spendRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const notOwner = requireOwner(route, 'change the spending limits');
  if (notOwner) return notOwner;
  const limited = await limitWalletRequests(route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const read = (key: string) => (body[key] == null ? undefined : bigintField(body[key]));
  const perPaymentMaxMinor = read('perPaymentMaxMinor');
  const secondApprovalThresholdMinor = read('secondApprovalThresholdMinor');
  const runningWindowMs = read('runningWindowMs');
  if (perPaymentMaxMinor === null || secondApprovalThresholdMinor === null || runningWindowMs === null) return refusal(400, 'A limit could not be read.');
  const members = await walletMembersOr(route);
  if (members.response) return members.response;
  const result = await changePolicyLimits(route.sc, {
    orgId: route.orgId,
    requestedBy: route.authority.userId,
    wallet: members.wallet,
    perPaymentMaxMinor,
    secondApprovalThresholdMinor,
    runningWindowMs,
  });
  return asResponse(result, result.ok ? { request: result.request } : undefined);
}
