/**
 * The chain-touching half of what follows an owner's approval of a request to
 * leave (the order, the record and the words are lib/server/team-leave-followup.ts).
 *
 * After the approving transaction commits the person has no access to the
 * business. Two things on the chain wait for the wallet's owners, who sign on
 * their own devices:
 *
 *   revokeRules   the person's spending rule, through the spending-rules revoke
 *                 path: `revokeOrphanedRules` builds one transaction that
 *                 revokes every rule whose holder is no longer a member and
 *                 removes them from the policy (lib/server/spend-rules.ts). This
 *                 opens that request. 'opened', 'none' (nothing to take back) or
 *                 'not_opened' (no wallet, the chain unreadable, no gas sponsor).
 *   signerState   whether the person is still one of the business wallet's
 *                 signers. Leaving the team does not remove a signer; a change of
 *                 signers is a separate request the owners sign. This only READS
 *                 the wallet's recorded members.
 *
 * Only an owner's approval gets here (the Finance lead decides no request to
 * leave), and the session is read again so the call is made as that owner, in
 * that business. Nothing here signs anything.
 */
import 'server-only';

import { currentWalletMembers } from '@/lib/server/business-wallet';
import { revokeOrphanedRules } from '@/lib/server/spend-rules';
import { spendRoute, walletMembersOr } from '@/lib/server/spend-rules-route';
import { limitWalletRequests } from '@/lib/server/wallet-route';
import type { LeaveFollowUpDeps } from '@/lib/server/team-leave-followup';

/** The real chain steps for one approval, as the owner who approved. They never throw. */
export function leaveFollowUpDeps(request: Request, who: { orgId: string; actorUserId: string; leaverUserId: string }): LeaveFollowUpDeps {
  // The route and the wallet's members are read once and shared by both steps.
  const opened = (async () => {
    const gate = await spendRoute(request);
    if (gate.response) return null;
    const route = gate.route;
    // The same person in the same business, read again from the session.
    if (route.orgId !== who.orgId || route.authority.userId !== who.actorUserId || route.authority.role !== 'OWNER') return null;
    return route;
  })().catch(() => null);

  return {
    async revokeRules() {
      try {
        const route = await opened;
        if (!route) return 'not_opened';
        if (await limitWalletRequests(route)) return 'not_opened';
        const members = await walletMembersOr(route);
        if (members.response) return 'not_opened';
        const result = await revokeOrphanedRules(route.sc, { orgId: who.orgId, requestedBy: who.actorUserId, wallet: members.wallet });
        if (result.ok) return 'opened';
        return result.code === 'nothing_orphaned' ? 'none' : 'not_opened';
      } catch {
        return 'not_opened';
      }
    },
    async signerState() {
      try {
        const route = await opened;
        if (!route) return 'unknown';
        const current = await currentWalletMembers(route.ctx, route.db, route.orgId);
        // No wallet yet: nobody signs for it, so there is no signer to remove. Any other failure is "could not tell".
        if (!current.ok) return current.code === 'no_wallet' ? 'not_a_signer' : 'unknown';
        return current.members.members.some((m) => m.userId === who.leaverUserId) ? 'still_signer' : 'not_a_signer';
      } catch {
        return 'unknown';
      }
    },
  };
}
