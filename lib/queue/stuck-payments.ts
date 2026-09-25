/**
 * Approved payments whose outcome nobody recorded.
 *
 * Carrying out an approval is three steps: the proposal goes SUBMITTED, the
 * real payment route is replayed with it, and what happened is recorded on it
 * (`execution`). They are separate writes. A process that stops between them
 * (a deploy, a crash, a write that did not land) leaves the proposal SUBMITTED
 * with no outcome. The payment may have gone or not. The proposal holds its
 * payment's idempotency key, so the same payment cannot be requested again,
 * and no lane of the queue showed it.
 *
 * This finds them and says what the records show. The queue lists them
 * (components/queue/StuckPaymentsLane.tsx), and an approver records what
 * happened (app/api/proposals/[id]/reconcile), which frees the payment to be
 * requested again or closes it as carried out.
 *
 * ─── What the records can and cannot say ────────────────────────────────────
 *
 * A money route spends the approval (`consumed_approvals`) at its claim check,
 * before any money step, and names itself as the spender. The replay closes an
 * approval the route did not spend, as 'execution'. So:
 *
 *   no spend, or one closed by 'execution': the route never passed the claim
 *   check with this approval, and nothing was paid with it. Settled by the
 *   records.
 *
 *   a spend by a route: the claim check passed. The route may have paid, or
 *   refused at a later check. Only the downstream record (the transfer, the
 *   payroll run) says which, so a person looks before recording it.
 */
import type { UnsignedProposal, UserRole } from '../agent/types.ts';
import { canRoleApprove } from './proposal-state.ts';
import {
  outcomesAllowed,
  recordsShowNotSent,
  whereToCheck,
  type StuckEvidence,
  type StuckPaymentItem,
} from './stuck-payment-view.ts';
import { AGENT_ACTOR_ID } from '@/lib/agent/identity';

export type { ReconcileOutcome, StuckEvidence, StuckPaymentItem } from './stuck-payment-view.ts';

/**
 * How long a payment may take to come back from the payment route before its
 * outcome counts as missing. The replay runs inside one request and answers in
 * seconds; ten minutes is margin, not an estimate. Before this, it may still
 * be going, and nobody is asked to guess.
 */
export const STUCK_AFTER_MS = 10 * 60 * 1000;

/** SUBMITTED, no outcome recorded, and past the time any request would still be carrying it out. */
export function isStuckSubmission(proposal: UnsignedProposal, nowMs: number): boolean {
  if (proposal.status !== 'SUBMITTED' || proposal.execution) return false;
  const submittedAt = Date.parse(proposal.submittedAt ?? '');
  // A row submitted before the time was recorded has been waiting at least since then.
  return !Number.isFinite(submittedAt) || nowMs - submittedAt > STUCK_AFTER_MS;
}

/** When a submission stops being one that may still be sending, or null if the time is not on record. */
export function stuckFrom(proposal: UnsignedProposal): number | null {
  const submittedAt = Date.parse(proposal.submittedAt ?? '');
  return Number.isFinite(submittedAt) ? submittedAt + STUCK_AFTER_MS : null;
}

/** An approval's spend, as lib/server/approved-proposal.ts records it. */
export type SpendRecord = { consumedBy: string; consumedAt: string } | null;

/** Spenders that are not a money route: the replay closing an approval, and reconciliation. */
const CLOSED_WITHOUT_ROUTE = new Set(['execution', 'reconciliation']);
/** Marked spent by drizzle/0023 for approvals carried out before spends were recorded. */
const BACKFILLED = 'backfill';

export function classifySpend(spend: SpendRecord): StuckEvidence {
  if (!spend) return { kind: 'never-used' };
  if (CLOSED_WITHOUT_ROUTE.has(spend.consumedBy)) return { kind: 'closed-unused', at: spend.consumedAt };
  if (spend.consumedBy === BACKFILLED) return { kind: 'backfilled', at: spend.consumedAt };
  return { kind: 'route-used', route: spend.consumedBy, at: spend.consumedAt };
}

/** The person looking at the queue, as their membership says. */
export type StuckViewer = { orgId: string; userId: string; role: UserRole };

/** Why this viewer cannot record the outcome, or null when they can. The route decides either way. */
export function reconcileBlockedReason(proposal: UnsignedProposal, viewer: StuckViewer): string | null {
  if (proposal.createdBy !== AGENT_ACTOR_ID && proposal.createdBy === viewer.userId) {
    return 'You requested this payment, so another approver records what happened.';
  }
  if (!canRoleApprove(viewer.role)) return 'Only an approver can record what happened.';
  return null;
}

const MICRO = BigInt(1_000_000);

/**
 * The amount an approver signed for. `financialImpact` is in micro units; the
 * integer arithmetic keeps a large payment exact (app/queue/page.tsx formats
 * it the same way).
 */
export function amountLabel(proposal: UnsignedProposal): string {
  const impact = proposal.explain.financialImpact;
  const [amountMicro, currency] = impact.amountOut !== undefined
    ? [impact.amountOut, impact.currencyOut ?? impact.currencyIn ?? 'USD']
    : [impact.amountIn ?? BigInt(0), impact.currencyIn ?? 'USD'];
  const negative = amountMicro < BigInt(0);
  const abs = negative ? -amountMicro : amountMicro;
  const whole = abs / MICRO;
  const cents = (abs % MICRO) / BigInt(10_000);
  return `${currency} ${negative ? '-' : ''}${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`;
}

/** "3h 12m", for how long it has waited. */
function elapsed(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)} days`;
}

export function stuckPaymentItem(
  proposal: UnsignedProposal,
  evidence: StuckEvidence,
  viewer: StuckViewer,
  now: Date,
): StuckPaymentItem {
  const submittedAt = Date.parse(proposal.submittedAt ?? '');
  return {
    id: proposal.id,
    kind: proposal.kind,
    recommendation: proposal.explain.recommendation,
    amountLabel: amountLabel(proposal),
    waitingLabel: Number.isFinite(submittedAt)
      ? `Sent for payment ${elapsed(now.getTime() - submittedAt)} ago`
      : 'Sent for payment before submission times were recorded',
    evidence,
    outcomes: outcomesAllowed(evidence),
    // Only worth a look when the records cannot settle it.
    checkHint: recordsShowNotSent(evidence) || evidence.kind === 'unreadable' ? null : whereToCheck(proposal.kind),
    blockedReason: reconcileBlockedReason(proposal, viewer),
  };
}
