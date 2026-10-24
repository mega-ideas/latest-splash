import { readJsonBody } from '@/lib/server/http';
import { changeSpendingRule, revokeSpendingRule } from '@/lib/server/spend-rules';
import { ruleFromBody, spendRoute, staffSpender, walletMembersOr } from '@/lib/server/spend-rules-route';
import { asResponse, limitWalletRequests, refusal, requireOwner } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ staffUserId: string }> };

/**
 * One staff member's rule (v2 §4.2). Both are signed by the wallet's quorum.
 *
 * PUT     change it: the rule's allowance is revoked and a new one issued in
 *         the same transaction (the same body as POST /api/wallet/spending-rules).
 * DELETE  take it back: every allowance the wallet gave this person is
 *         revoked and they are removed from the policy.
 */
export async function PUT(request: Request, { params }: Params) {
  const gate = await spendRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const notOwner = requireOwner(route, 'change a spending rule');
  if (notOwner) return notOwner;
  const limited = await limitWalletRequests(route);
  if (limited) return limited;
  const { staffUserId } = await params;
  const staff = await staffSpender(route, staffUserId);
  if (staff.response) return staff.response;
  const rule = ruleFromBody(await readJsonBody(request), staff.address);
  if (typeof rule === 'string') return refusal(400, rule);
  const members = await walletMembersOr(route);
  if (members.response) return members.response;
  const result = await changeSpendingRule(route.sc, { orgId: route.orgId, requestedBy: route.authority.userId, wallet: members.wallet, rule });
  return asResponse(result, result.ok ? { request: result.request } : undefined);
}

export async function DELETE(request: Request, { params }: Params) {
  const gate = await spendRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const notOwner = requireOwner(route, 'take back a spending rule');
  if (notOwner) return notOwner;
  const limited = await limitWalletRequests(route);
  if (limited) return limited;
  const { staffUserId } = await params;
  const staff = await staffSpender(route, staffUserId);
  if (staff.response) return staff.response;
  const members = await walletMembersOr(route);
  if (members.response) return members.response;
  const result = await revokeSpendingRule(route.sc, { orgId: route.orgId, requestedBy: route.authority.userId, wallet: members.wallet, spender: staff.address });
  return asResponse(result, result.ok ? { request: result.request } : undefined);
}
