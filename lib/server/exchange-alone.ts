/**
 * The owner's switch "Can pay exchange accounts alone" (v2 Phase 3, Sky's
 * decision), read from the database every time it matters.
 *
 * It is kept per member in `wallet_member_access` beside Add funds and
 * Withdraw (kind `pay_exchange_alone`, migration 0077), granted and taken back
 * by an owner only (lib/server/team-admin.ts `setMemberAccess`), instantly and
 * with a line on the append-only trail. Off for everyone until an owner turns
 * it on; nothing gives it to anyone who was already on the team.
 *
 * It only WIDENS what a person's spending rule already allows to include an
 * exchange account. The rule's per-payment maximum, caps, expiry and verified
 * recipients all still bind (lib/transfer/plan.ts), so this is the one extra
 * question, asked in the one place: is this person, in this business, allowed
 * right now? Default deny: a viewer, an owner (who has no use for it: the
 * owners' payments are signed by the quorum), a person of another business
 * and a stale row all read as no.
 */
import { and, eq, isNull } from 'drizzle-orm';

import { walletMemberAccess } from '../db/schema.ts';
import { memberRole } from './wallet-authority.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

export const PAY_EXCHANGE_ALONE = 'pay_exchange_alone' as const;

/** May this staff member or approver pay an exchange account alone, right now? */
export async function exchangeAloneOf(db: DrizzleDb, orgId: string, userId: string): Promise<boolean> {
  const role = await memberRole(db, orgId, userId);
  if (role !== 'maker' && role !== 'checker') return false;
  const [row] = await db
    .select({ id: walletMemberAccess.id })
    .from(walletMemberAccess)
    .where(and(eq(walletMemberAccess.orgId, orgId), eq(walletMemberAccess.userId, userId), eq(walletMemberAccess.access, PAY_EXCHANGE_ALONE), isNull(walletMemberAccess.revokedAt)))
    .limit(1);
  return Boolean(row);
}
