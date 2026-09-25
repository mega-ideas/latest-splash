/**
 * The stuck-payments lane's words and wire format, safe for the browser.
 *
 * lib/queue/stuck-payments.ts decides which payments are stuck and what their
 * records show; it reaches the proposal store, which is server-only. This is
 * the part the lane itself needs: what each finding says, which outcomes an
 * approver may record, and what the reconcile route's answer means. Nothing in
 * it claims a payment went unless the route says the outcome was recorded.
 */

export type ReconcileOutcome = 'SENT' | 'NOT_SENT';

export type StuckEvidence =
  /** Nothing used the approval. */
  | { kind: 'never-used' }
  /** Closed without a money route spending it. */
  | { kind: 'closed-unused'; at: string }
  /** A money route passed its claim check with it. Whether it then paid is not on record. */
  | { kind: 'route-used'; route: string; at: string }
  /** Marked spent when spends started being recorded (drizzle/0023). Whether it paid is not on record. */
  | { kind: 'backfilled'; at: string }
  /** The spend, or the saved payment, could not be read. */
  | { kind: 'unreadable' };

/** A row of the queue's stuck-payments lane. Serializable: no bigint, no Date. */
export type StuckPaymentItem = {
  id: string;
  kind: string;
  recommendation: string;
  amountLabel: string;
  /** How long ago it went to the payment route. */
  waitingLabel: string;
  evidence: StuckEvidence;
  outcomes: ReconcileOutcome[];
  /** Where to look for the payment itself, when the records cannot settle it. */
  checkHint: { label: string; href: string } | null;
  /** Why this viewer cannot record it, or null when they can. The route decides either way. */
  blockedReason: string | null;
};

/** Whether the records alone say nothing was sent. */
export function recordsShowNotSent(evidence: StuckEvidence): boolean {
  return evidence.kind === 'never-used' || evidence.kind === 'closed-unused';
}

/**
 * What an approver may record. Not sent, whenever the records allow it. Sent,
 * only when a money route used the approval: one that never did cannot have
 * paid with it, and recording "sent" there would close a payment nobody made.
 */
export function outcomesAllowed(evidence: StuckEvidence): ReconcileOutcome[] {
  switch (evidence.kind) {
    case 'never-used':
    case 'closed-unused':
      return ['NOT_SENT'];
    case 'route-used':
    case 'backfilled':
      return ['SENT', 'NOT_SENT'];
    case 'unreadable':
      return [];
  }
}

/** What the records show, in one sentence. `at` renders a recorded time. */
export function findingText(evidence: StuckEvidence, at: (iso: string) => string): string {
  switch (evidence.kind) {
    case 'never-used':
      return 'The payment route never used this approval, so nothing was sent.';
    case 'closed-unused':
      return 'The approval was closed without the payment route using it, so nothing was sent.';
    case 'route-used':
      return `The payment route accepted this approval at ${at(evidence.at)}. Whether it then paid is not on record.`;
    case 'backfilled':
      return `This approval was marked used at ${at(evidence.at)}, before Splash recorded which route used it. Whether it paid is not on record.`;
    case 'unreadable':
      return 'Splash could not read the records for this payment. Reload to try again.';
  }
}

/** Where to look for the payment itself, by kind. */
export function whereToCheck(kind: string): { label: string; href: string } | null {
  switch (kind) {
    case 'PAYMENT':
      return { label: 'Check payment history', href: '/dashboard/history' };
    case 'BATCH_PAYOUT':
      return { label: 'Check payroll runs', href: '/dashboard/batch' };
    case 'TREASURY_ALLOCATE':
    case 'TREASURY_REDEEM':
      return { label: 'Check Smart Treasury', href: '/dashboard/treasury' };
    default:
      return null;
  }
}

export function reconcilePath(id: string): string {
  return `/api/proposals/${encodeURIComponent(id)}/reconcile`;
}

/** The request body: the approver's answer and, for a payment that went, what to find it by. Nothing about who they are. */
export function reconcileRequestBody(
  outcome: ReconcileOutcome,
  reference?: string,
): { outcome: ReconcileOutcome; reference?: string } {
  const trimmed = reference?.trim();
  return { outcome, ...(outcome === 'SENT' && trimmed ? { reference: trimmed } : {}) };
}

export type ReconcileResult =
  /** The outcome is on the payment now. */
  | { kind: 'recorded'; outcome: ReconcileOutcome; message: string }
  /** Something else recorded an outcome first. */
  | { kind: 'closed'; message: string }
  /** It went to the payment route too recently to call it stuck. */
  | { kind: 'still-sending'; message: string }
  | { kind: 'refused'; message: string }
  | { kind: 'signed-out'; message: string }
  /** No answer: it may or may not have been recorded. */
  | { kind: 'unreachable'; message: string };

/** Results after which the payment has left the lane. */
export function leavesLane(result: ReconcileResult): boolean {
  return result.kind === 'recorded' || result.kind === 'closed';
}

type Body = Record<string, unknown> | null;

/** What came of recording an outcome. `status` 0 means no response arrived. */
export function interpretReconcileResponse(status: number, body: Body, outcome: ReconcileOutcome): ReconcileResult {
  if (status === 0) {
    return {
      kind: 'unreachable',
      message: 'Splash could not be reached, so it is not known whether your answer was recorded. Reload the queue to check.',
    };
  }
  if (status === 401) return { kind: 'signed-out', message: 'Your session has ended. Sign in again to record this.' };

  if (status >= 200 && status < 300) {
    return outcome === 'SENT'
      ? { kind: 'recorded', outcome, message: 'Recorded as sent. It is closed, and nothing more will be sent.' }
      : {
          kind: 'recorded',
          outcome,
          message: 'Recorded as not sent. The payment can be requested again, and it will need new approvals.',
        };
  }

  const error = typeof body?.error === 'string' ? body.error.trim() : '';
  const code = typeof body?.code === 'string' ? body.code : '';
  if (status === 409 && code === 'PROPOSAL_CLOSED') {
    return { kind: 'closed', message: error || 'This payment already has an outcome recorded.' };
  }
  if (status === 409 && code === 'STILL_SENDING') {
    return { kind: 'still-sending', message: error || 'This payment may still be going. Check again in a few minutes.' };
  }
  if (status === 404) return { kind: 'refused', message: 'This payment is no longer available to you.' };
  return { kind: 'refused', message: error || `Splash did not record it (HTTP ${status}).` };
}
