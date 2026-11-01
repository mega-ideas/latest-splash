/**
 * What follows an owner's approval of a request to leave (v2 Phase 3 review).
 *
 * The approving transaction ends the person's membership. Two things on the
 * chain are not ended by it, because only the wallet's owners can change them,
 * signing on their own devices:
 *
 *   - the person's spending rule, taken back through the spending-rules revoke
 *     path (a request the owners sign), and
 *   - their place among the business wallet's SIGNERS. Leaving the team does
 *     not remove a signer. For an owner who leaves this is the step that
 *     matters most, so the answer says so in words and points the owners to the
 *     signer change they sign themselves.
 *
 * Both are best effort, and used to be invisible when they failed. Now every
 * outcome is a line of the append-only trail (`leave_follow_up`: what happened
 * to the rule, and whether the person is still a signer), so a step that was
 * skipped or could not be opened is on record, appears in Settings > Team >
 * Recent changes, and is not only a sentence in one response. The state itself
 * is shown regardless: a rule that outlives its holder reads as orphaned on the
 * wallet page and in Settings, so a follow-up lost between the commit and this
 * call cannot hide it.
 *
 * The chain-touching parts arrive as `deps` (lib/server/team-leave-rules.ts
 * builds the real ones); nothing in here reads or signs anything. Neither dep
 * may throw into the caller: a throw is recorded as "not opened" or "unknown".
 */
import { and, eq } from 'drizzle-orm';

import { walletAuthorityEvents } from '../db/schema.ts';
import { leaveFollowUpNote, type RuleRevoke, type SignerState } from '../team/view.ts';
import { recordAuthorityEvent } from './wallet-authority.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

export type LeaveFollowUpDeps = {
  /** Open the spending-rules revoke request. */
  revokeRules: () => Promise<RuleRevoke>;
  /** Is the person still one of the business wallet's signers? */
  signerState: () => Promise<SignerState>;
};

export type LeaveFollowUp = { rules: RuleRevoke; signer: SignerState; note: string };

const RULES: readonly RuleRevoke[] = ['opened', 'none', 'not_opened'];
const SIGNERS: readonly SignerState[] = ['still_signer', 'not_a_signer', 'unknown'];

async function settled<T>(read: () => Promise<T>, allowed: readonly T[], otherwise: T): Promise<T> {
  try {
    const value = await read();
    return allowed.includes(value) ? value : otherwise;
  } catch {
    return otherwise;
  }
}

export async function runLeaveFollowUp(
  db: DrizzleDb,
  input: { orgId: string; actorUserId: string; requestId: string; leaverUserId: string; deps: LeaveFollowUpDeps; now?: () => Date },
): Promise<LeaveFollowUp> {
  // A repeat of the same request writes no second line and does not run the chain steps again.
  const [existing] = await db
    .select({ detail: walletAuthorityEvents.detail })
    .from(walletAuthorityEvents)
    .where(and(eq(walletAuthorityEvents.orgId, input.orgId), eq(walletAuthorityEvents.action, 'leave_follow_up'), eq(walletAuthorityEvents.ref, input.requestId)))
    .limit(1);
  if (existing) {
    const d = (existing.detail ?? {}) as { rules?: RuleRevoke; signer?: SignerState };
    const rules = RULES.includes(d.rules as RuleRevoke) ? (d.rules as RuleRevoke) : 'not_opened';
    const signer = SIGNERS.includes(d.signer as SignerState) ? (d.signer as SignerState) : 'unknown';
    return { rules, signer, note: leaveFollowUpNote({ rules, signer }) };
  }

  const rules = await settled(input.deps.revokeRules, RULES, 'not_opened');
  const signer = await settled(input.deps.signerState, SIGNERS, 'unknown');
  try {
    await recordAuthorityEvent(db, {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'leave_follow_up',
      subjectUserId: input.leaverUserId,
      ref: input.requestId,
      detail: { rules, signer },
      now: input.now,
    });
  } catch {
    // The approval has committed and the chain request (if any) is open; failing to write this line must not undo or hide either.
  }
  return { rules, signer, note: leaveFollowUpNote({ rules, signer }) };
}
