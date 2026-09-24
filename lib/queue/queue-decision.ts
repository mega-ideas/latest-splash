/**
 * An approver's decision on the queue, and what the server says came of it.
 *
 * The queue board's Approve and Reject used to change React state and toast
 * "Approved & queued for settlement" without calling the server at all. The
 * proposal stayed where it was, and the approver walked away believing the
 * payment had gone — the one outcome an approval flow must never produce
 * (lib/server/approval-execution.ts says why).
 *
 * The decision now goes to `POST /api/proposals/[id]/submit`, the route the
 * chat's approve button uses, and this module turns its answer into what the
 * approver is told. Every outcome is the server's, word for word where the
 * server's words are the right ones: nothing here claims a payment went unless
 * the response carries an EXECUTED execution.
 */

export type QueueDecision = 'APPROVE' | 'REJECT';

export type DecisionOutcome =
  /** Approved, and the payment was carried out. */
  | { kind: 'executed'; message: string; ref?: string }
  /** Approved, and the approval is spent — but no money moved. */
  | { kind: 'approved-not-sent'; message: string }
  | { kind: 'rejected'; message: string }
  /** This approver's signature is on it; another is still needed. */
  | { kind: 'recorded'; message: string; approvalsCollected: number; requiredApprovers: number }
  /** Stopped at the approval-time compliance check. */
  | { kind: 'held'; message: string; reasons: string[] }
  /** The proposal changed after the page loaded it: the approver would be
   *  signing something they have not seen. */
  | { kind: 'changed'; message: string }
  | { kind: 'refused'; message: string }
  | { kind: 'signed-out'; message: string }
  /** No answer. The decision may or may not have been recorded. */
  | { kind: 'unreachable'; message: string };

/** Outcomes after which the proposal has left the approval queue. */
export function isFinal(outcome: DecisionOutcome): boolean {
  return outcome.kind === 'executed' || outcome.kind === 'approved-not-sent' || outcome.kind === 'rejected';
}

/**
 * The request body. The client sends its decision, a signature reference and
 * the hash of what the approver reviewed — nothing that says who they are or
 * what they may do (the submit route derives that from the session).
 */
export function submitRequestBody(
  item: { id: string; approvalHash?: string },
  decision: QueueDecision,
): { signatureRef: string; decision: QueueDecision; approvalHash?: string } {
  return {
    signatureRef: `sig_queue_${item.id}`,
    decision,
    ...(item.approvalHash ? { approvalHash: item.approvalHash } : {}),
  };
}

export function submitPath(id: string): string {
  return `/api/proposals/${encodeURIComponent(id)}/submit`;
}

type Body = Record<string, unknown> | null;

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function approvalsOn(body: Body): { collected: number; required: number } | null {
  const proposal = body?.proposal as { approvals?: unknown; explain?: { requiredApprovers?: unknown } } | undefined;
  if (!proposal || !Array.isArray(proposal.approvals)) return null;
  const collected = new Set(
    proposal.approvals.map((approval) => (approval as { userId?: unknown })?.userId).filter(Boolean),
  ).size;
  const required = Number(proposal.explain?.requiredApprovers);
  return { collected, required: Number.isFinite(required) && required > 0 ? required : Math.max(collected + 1, 2) };
}

/** A few of the state machine's refusals, in the approver's terms. The rest
 *  are shown as the server wrote them. */
function refusalMessage(error: string): string {
  if (/distinct approver/i.test(error)) {
    return 'You have already approved this payment. It needs a different approver.';
  }
  if (/not allowed from (SUBMITTED|SETTLED|ANCHORED)/.test(error)) {
    return 'This payment was already approved and carried out. Nothing more was sent.';
  }
  if (/not allowed from (REJECTED|EXPIRED|FAILED)/.test(error)) {
    return 'This proposal is closed and can no longer be approved.';
  }
  if (/quote expired/i.test(error)) {
    return 'The approval window for this payment has closed. Ask the maker to authorize it again.';
  }
  if (/circuit breaker/i.test(error)) {
    return 'Payments are paused by a circuit breaker, so nothing was approved.';
  }
  return error;
}

/**
 * What came of a decision. `status` 0 means no response arrived.
 */
export function interpretSubmitResponse(status: number, body: Body, decision: QueueDecision): DecisionOutcome {
  if (status === 0) {
    return {
      kind: 'unreachable',
      message:
        'Splash could not be reached, so it is not known whether your decision was recorded. ' +
        'Reload the queue to check before trying again.',
    };
  }

  const error = textOf(body?.error);
  const code = textOf(body?.code);

  if (status === 401) {
    return { kind: 'signed-out', message: 'Your session has ended. Sign in again to approve payments.' };
  }

  if (status >= 200 && status < 300) {
    if (decision === 'REJECT') {
      return { kind: 'rejected', message: 'Rejected. It went back to the maker, and nothing was sent.' };
    }
    const execution = body?.execution as { state?: unknown; detail?: unknown; ref?: unknown } | undefined;
    const detail = textOf(execution?.detail);
    if (execution?.state === 'EXECUTED') {
      return {
        kind: 'executed',
        message: `Approved. ${detail || 'The payment was carried out.'}`,
        ref: textOf(execution.ref) || undefined,
      };
    }
    if (execution?.state === 'SKIPPED') {
      // The executor's own words already begin with what happened.
      return { kind: 'approved-not-sent', message: detail || 'Approved and recorded. Nothing was sent.' };
    }
    if (execution?.state === 'FAILED') {
      return {
        kind: 'approved-not-sent',
        message: `Approved, but the payment did not go: ${detail || 'the reason was not recorded.'}`,
      };
    }
    // A success with no execution record is not a payment that went.
    return {
      kind: 'approved-not-sent',
      message: 'Approved, but Splash did not report the payment as sent. Check the transfers list before acting on it.',
    };
  }

  if (status === 409 && code === 'compliance_hold') {
    const reasons = Array.isArray(body?.holdReasons)
      ? (body?.holdReasons as unknown[]).filter((reason): reason is string => typeof reason === 'string')
      : [];
    // The route appends the reasons in plain words, in parentheses; the text
    // before them is the policy engine's, which an approver cannot act on.
    const why = /\(([^()]+)\)\s*$/.exec(error)?.[1]?.trim();
    return {
      kind: 'held',
      message: why
        ? `Held for compliance: ${why}. Nothing was approved or sent.`
        : 'Held for compliance. Nothing was approved or sent.',
      reasons,
    };
  }

  if (status === 409 && code === 'APPROVAL_HASH_MISMATCH') {
    return {
      kind: 'changed',
      message: 'This proposal changed after the queue loaded. Reload to review the current version before deciding.',
    };
  }

  if (status === 409) {
    const approvals = approvalsOn(body);
    if (approvals && /second approver/i.test(error)) {
      const remaining = Math.max(approvals.required - approvals.collected, 1);
      return {
        kind: 'recorded',
        message:
          `Your approval is recorded. It needs ${remaining} more approver${remaining === 1 ? '' : 's'} ` +
          'before anything is sent.',
        approvalsCollected: approvals.collected,
        requiredApprovers: approvals.required,
      };
    }
  }

  if (status === 403 && /maker cannot approve/i.test(error)) {
    return { kind: 'refused', message: 'You proposed this payment, so a different approver has to sign it.' };
  }
  if (status === 404) {
    return { kind: 'refused', message: 'This proposal is no longer available to you.' };
  }

  return { kind: 'refused', message: refusalMessage(error || `The decision was refused (HTTP ${status}).`) };
}

/** A proposal kind as an approver would name it. */
export function kindLabel(kind: string): string {
  switch (kind) {
    case 'PAYMENT':
      return 'Payment';
    case 'BATCH_PAYOUT':
      return 'Payroll run';
    case 'X402_PAYMENT':
      return 'x402 payment';
    case 'TREASURY_ALLOCATE':
      return 'Treasury allocation';
    case 'TREASURY_REDEEM':
      return 'Treasury withdrawal';
    case 'FX_CONVERT':
      return 'FX conversion';
    case 'INTERNAL_TRANSFER':
      return 'Internal transfer';
    case 'NETTING_SETTLE':
      return 'Netting settlement';
    default:
      return kind;
  }
}
