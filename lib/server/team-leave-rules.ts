/**
 * After an owner approves a request to leave, the person's spending rule (an
 * allowance on the chain) is taken back through the spending-rules revoke path:
 * `revokeOrphanedRules` builds one transaction that revokes every rule whose
 * holder is no longer a member and removes them from the policy, and the
 * wallet's owners sign it on their own devices (lib/server/spend-rules.ts).
 *
 * The membership has ended before this runs (approving commits first), so the
 * person has no access to the business the moment the owner approves. The rule
 * on the chain stops only when the owners sign the revoke. This module opens
 * that request and says in words which of three things happened; if it cannot
 * be opened (no wallet, the chain unreadable, a missing gas sponsor) nothing is
 * lost: the rule shows in Settings as belonging to a former member, and the
 * same button takes it back.
 *
 * Only an owner opens it: the Finance lead cannot take a rule back, so their
 * approval leaves it for an owner.
 */
import 'server-only';

import { revokeOrphanedRules } from '@/lib/server/spend-rules';
import { spendRoute, walletMembersOr } from '@/lib/server/spend-rules-route';
import { limitWalletRequests } from '@/lib/server/wallet-route';

export type RuleRevoke = 'opened' | 'none' | 'not_opened' | 'by_owner';

/** The sentence for the owner who approved. */
export function ruleRevokeNote(outcome: RuleRevoke): string {
  switch (outcome) {
    case 'opened':
      return 'Their spending rule is being taken back. The owners sign that request on their own devices; until they do, the rule still exists on the chain.';
    case 'none':
      return 'They held no spending rule, so there is nothing to take back.';
    case 'by_owner':
      return 'If they held a spending rule, an owner takes it back under Spending rules in Settings, where it shows as belonging to a former member.';
    default:
      return 'If they held a spending rule, it could not be taken back just now. Take it back under Spending rules in Settings, where it shows as belonging to a former member.';
  }
}

export async function revokeLeaverRules(request: Request, who: { orgId: string; actorUserId: string }): Promise<RuleRevoke> {
  try {
    const gate = await spendRoute(request);
    if (gate.response) return 'not_opened';
    const route = gate.route;
    // The same person in the same business, read again from the session.
    if (route.orgId !== who.orgId || route.authority.userId !== who.actorUserId || route.authority.role !== 'OWNER') return 'not_opened';
    if (await limitWalletRequests(route)) return 'not_opened';
    const members = await walletMembersOr(route);
    if (members.response) return 'not_opened';
    const result = await revokeOrphanedRules(route.sc, { orgId: who.orgId, requestedBy: who.actorUserId, wallet: members.wallet });
    if (result.ok) return 'opened';
    return result.code === 'nothing_orphaned' ? 'none' : 'not_opened';
  } catch {
    return 'not_opened';
  }
}
