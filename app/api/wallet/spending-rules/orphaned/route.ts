import { revokeOrphanedRules } from '@/lib/server/spend-rules';
import { spendRoute, walletMembersOr } from '@/lib/server/spend-rules-route';
import { asResponse, limitWalletRequests, requireOwner } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * Offboarding (v2 §4.2): a spending rule lives on chain, so removing a member
 * or making them a viewer does not stop it. GET /api/wallet/spending-rules
 * lists those rules as `orphaned`, each with its `standing`.
 *
 * POST {}   an owner takes every orphaned rule back in one transaction:
 *           their allowances revoked and the spenders removed from the
 *           policy, signed by the wallet's quorum.
 */
export async function POST(request: Request) {
  const gate = await spendRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const notOwner = requireOwner(route, 'take back spending rules');
  if (notOwner) return notOwner;
  const limited = await limitWalletRequests(route);
  if (limited) return limited;
  const members = await walletMembersOr(route);
  if (members.response) return members.response;
  const result = await revokeOrphanedRules(route.sc, { orgId: route.orgId, requestedBy: route.authority.userId, wallet: members.wallet });
  return asResponse(result, result.ok ? { request: result.request } : undefined);
}
