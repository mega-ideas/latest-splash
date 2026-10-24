import { readJsonBody } from '@/lib/server/http';
import { changeRecipients } from '@/lib/server/spend-rules';
import { recipientsFromBody, spendRoute, walletMembersOr } from '@/lib/server/spend-rules-route';
import { asResponse, limitWalletRequests, requireOwner } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * The recipients staff may pay under their rules (v2 §4.2), signed by the
 * wallet's quorum.
 *
 * POST { add: [{ address, tag: 'wallet' | 'exchange' }], remove: [address],
 *        addBeneficiaries: [{ commitment, partnerDeposit }], removeBeneficiaries: [commitment] }
 *
 * A1 §2.3: the WALLET tag only for an address whose owner has signed the
 * ownership proof (§4.7); otherwise the change is refused before anything is
 * built (409 ownership_not_proven).
 */
export async function POST(request: Request) {
  const gate = await spendRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const notOwner = requireOwner(route, 'change who staff may pay');
  if (notOwner) return notOwner;
  const limited = await limitWalletRequests(route);
  if (limited) return limited;
  const change = recipientsFromBody(await readJsonBody(request));
  const members = await walletMembersOr(route);
  if (members.response) return members.response;
  const result = await changeRecipients(route.sc, { orgId: route.orgId, requestedBy: route.authority.userId, wallet: members.wallet, change });
  return asResponse(result, result.ok ? { request: result.request } : undefined);
}
