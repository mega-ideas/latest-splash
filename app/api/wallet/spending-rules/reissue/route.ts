import { readJsonBody } from '@/lib/server/http';
import { reissueAfterRotation, revokeStaleAllowances } from '@/lib/server/spend-rules';
import { spendRoute, walletMembersOr } from '@/lib/server/spend-rules-route';
import { asResponse, limitWalletRequests, refusal, requireOwner } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * After a wallet rotation (v2 §4.1 → §4.2): an earlier generation's policy
 * and its rules can no longer pay.
 *
 * POST {}                     reissue them under the new wallet: its policy
 *                             first if needed (the reissue follows when that
 *                             lands), then the limits, recipients,
 *                             beneficiaries, spenders and unexpired rules,
 *                             signed by the new wallet's quorum. What could
 *                             not be carried is listed in `skipped`.
 * POST { revokeStaleFrom }    the OLD wallet's quorum revokes the allowances
 *                             it funded (they cannot pay; storage is refunded).
 */
export async function POST(request: Request) {
  const gate = await spendRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const notOwner = requireOwner(route, 'reissue spending rules');
  if (notOwner) return notOwner;
  const limited = await limitWalletRequests(route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  if (body.revokeStaleFrom != null) {
    const oldWallet = String(body.revokeStaleFrom);
    if (!/^0x[0-9a-fA-F]{64}$/.test(oldWallet)) return refusal(400, 'Name the earlier wallet by its address.');
    const result = await revokeStaleAllowances(route.sc, { orgId: route.orgId, requestedBy: route.authority.userId, oldWallet });
    return asResponse(result, result.ok ? { request: result.request } : undefined);
  }
  const members = await walletMembersOr(route);
  if (members.response) return members.response;
  const result = await reissueAfterRotation(route.sc, { orgId: route.orgId, requestedBy: route.authority.userId, wallet: members.wallet });
  return asResponse(result, result.ok ? { request: result.request, skipped: 'skipped' in result ? (result.skipped ?? []) : [] } : undefined);
}
