/**
 * "This payment already has its approvers" — verified, bound to one payment,
 * spent once, and never read from anything a client can send.
 *
 * ─── Where a claim comes from ───────────────────────────────────────────────
 *
 * Only from the replay. When an approved proposal is carried out, the executor
 * runs the real authorize route in-process on a Request it builds itself and
 * binds a replay identity to that exact object (approval-replay-identity.ts).
 * A request that arrived over HTTP was never bound, so it carries no claim,
 * whatever it sends.
 *
 * This module used to read the claim from an `x-splash-approved-proposal`
 * header and resolve it against the store. The header is now ignored, because
 * resolving it was not enough: the batch route never compared the claim with
 * the rows it was about to pay, so any member of an org could attach an
 * approved batch's id to a DIFFERENT batch and skip the second approver; and
 * nothing spent a claim, so an approved transfer could be sent again by
 * re-posting it with the header and a fresh code.
 *
 * ─── What a claim must prove ────────────────────────────────────────────────
 *
 *   verified       the proposal exists in the caller's org, is in an approved
 *                  status, carries at least the required number of distinct
 *                  approvals — the maker's never counts — and they are the
 *                  approvals the replay was issued for;
 *   payment-bound  the request body is the payment the approvers signed: every
 *                  field of the payout, every row of the batch;
 *   single-use     spent atomically in Postgres (`proposals.executed_at`)
 *                  after every other guard has passed and immediately before
 *                  the payment record is created, so a second replay — a
 *                  duplicate webhook, two approvers answering together, a
 *                  retry — cannot release a second payment.
 *
 * ─── What it lifts: a decision, written down ────────────────────────────────
 *
 * A verified claim lifts two requirements and nothing else.
 *
 * 1. The second approver. The approvals are the second approver.
 *
 * 2. The maker's second factor (the authenticator code, or in WhatsApp style
 *    a WhatsApp code and passkey). This one is a trade-off:
 *
 *    FOR. The maker's factor was verified at the moment the maker authorized
 *    this exact payment: both routes check it BEFORE `proposeForApproval`
 *    stores the payload, and the stored payload is what the claim is bound to.
 *    It cannot be verified a second time. A TOTP is good for about ninety
 *    seconds and each step is single-use (`markStepConsumed`); a WhatsApp
 *    approval is spent when it is used. So "check the maker's code again on
 *    replay" is not a stricter control. It is a control nobody can pass:
 *    every approved batch, and every approved transfer on a code rail, was
 *    recorded FAILED. A control that always fails teaches operators to split
 *    payments under the threshold. Asking the maker for a FRESH code when the
 *    approvers sign would make the maker a participant in the checker's act,
 *    which defeats asynchronous maker-checker, and proves nothing about the
 *    approvers.
 *
 *    AGAINST, and why each is accepted:
 *      - A stolen maker session still needs the maker's factor to create the
 *        proposal, and then approvers who are not the maker. That is the same
 *        exposure as before the replay existed.
 *      - A stolen approver session (in-app, code) or handset (reply) is one
 *        signature. Reply approval is unanimous, and the replay re-checks
 *        that every approver still holds an approving role in THIS org and
 *        the maker is still a member.
 *      - If `requireTotp` was off when the maker proposed and is on when the
 *        approvers sign, the payment goes without a maker code ever having
 *        been checked. The approvers are the control at that point. Accepted.
 *      - The second factor itself is not replaced for anyone else: a session
 *        request carries no claim, so it meets the code and the approval
 *        threshold exactly as before.
 *
 * The claim never lifts a guard that reads the world. KYB, the terms, the
 * minimum, the row cap, the travel rule, both ceilings, the compliance pause,
 * the funding session, the balance, the peg and the batch replay key all run
 * again on replay, against current state.
 */
import 'server-only';

import type { UnsignedProposal } from '@/lib/agent/types';
import type { RecipientRecord } from '@/lib/server/operations';
import {
  approvalReplayOf,
  type ApprovalReplayIdentity,
  type ReplayKind,
} from '@/lib/server/approval-replay-identity';
import { subjectDigest } from '@/lib/server/step-up';
import { batchPaymentSubstance, fiatPaymentSubstance } from '@/lib/server/step-up-subjects';

/** Statuses that mean the humans have signed. */
const APPROVED_STATUSES = new Set(['APPROVED', 'SIGNED', 'SUBMITTED', 'SETTLED', 'ANCHORED']);

/** The header this module used to trust. Read only so a probe shows in the
 *  log; it never changes an answer. */
const RETIRED_HEADER = 'x-splash-approved-proposal';

export type ApprovalClaim = {
  /** True only when a real, approved, same-org proposal backs THIS replay of
   *  THIS payment. */
  approved: boolean;
  proposalId: string | null;
  /** The org the approval was spent against. Set only when approved. */
  orgId?: string;
  /** The request the approvers signed off. */
  payload?: Record<string, unknown> | null;
  /** The beneficiaries the proposal names (its COUNTERPARTY evidence) — part
   *  of the canonical approval hash, so exactly what the approvers signed. */
  beneficiaryIds?: string[];
  /** Why it was refused. Only a server-side replay can reach a refusal, so
   *  the reason is the operator's to read, not a client's to probe. */
  reason?: string;
};

/** What the route is about to pay, so the claim can be bound to it. */
export type ClaimedPayment = { kind: ReplayKind; payment: Record<string, unknown> };

function refused(reason: string): ApprovalClaim {
  return { approved: false, proposalId: null, reason };
}

/** The substance of a payment, digested: who, where, how much, in what, from
 *  what — and for a batch, every row. */
export function approvalPaymentDigest(kind: ReplayKind, payload: Record<string, unknown>): string {
  return subjectDigest(
    kind === 'BATCH_PAYOUT' ? batchPaymentSubstance(payload) : fiatPaymentSubstance(payload),
  );
}

function sameApprovers(onProposal: Set<string>, onReplay: readonly string[]): boolean {
  const replayed = new Set(onReplay);
  return replayed.size === onProposal.size && [...replayed].every((userId) => onProposal.has(userId));
}

/**
 * Does this proposal back this replay, for this payment? Pure: the store read
 * and the clock are the caller's.
 */
export function verifyApprovalClaim(input: {
  proposal: UnsignedProposal | null;
  replay: ApprovalReplayIdentity;
  orgId: string;
  expected: ClaimedPayment;
  now?: number;
}): ApprovalClaim {
  const { proposal, replay, orgId, expected } = input;

  if (!proposal || proposal.id !== replay.proposalId) return refused('no such proposal');
  // Tenancy: an approval in another org is not an approval here.
  if (proposal.orgId !== orgId || replay.orgId !== orgId) {
    return refused('proposal belongs to another org');
  }
  if (proposal.kind !== expected.kind || replay.kind !== expected.kind) {
    return refused(`a ${proposal.kind} approval cannot release a ${expected.kind}`);
  }
  if (!APPROVED_STATUSES.has(proposal.status)) {
    return refused(`status is ${proposal.status}`);
  }
  // Read the way `evaluatePolicy` reads it: a window that has closed ends the
  // approval; a proposal with no window is judged by policy, not here.
  const expiresAt = Date.parse(proposal.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= (input.now ?? Date.now())) {
    return refused('the approval window has closed');
  }
  if (proposal.createdBy !== replay.makerUserId) {
    return refused('the maker on the proposal is not the maker the replay names');
  }

  // The signatures themselves, not just the status — a status can be reached
  // by a transition; the approval rows are the evidence humans acted. The
  // maker's own signature never counts, and one is always required.
  const approvers = new Set(
    proposal.approvals.map((approval) => approval.userId).filter((userId) => userId !== proposal.createdBy),
  );
  const distinctApprovers = approvers.size;
  const required = Math.max(1, proposal.explain.requiredApprovers ?? 1);
  if (distinctApprovers < required) {
    return refused(`${distinctApprovers} of ${required} approvers signed`);
  }
  if (!sameApprovers(approvers, replay.approverUserIds)) {
    return refused('the approvals changed after the replay was issued');
  }

  // Payment-bound: the claim counts for the payment the approvers signed and
  // for nothing else, however similar.
  const payload = proposal.executionPayload ?? null;
  if (!payload) return refused('the approved payment details are missing');
  if (approvalPaymentDigest(expected.kind, payload) !== approvalPaymentDigest(expected.kind, expected.payment)) {
    return refused('the approval is for a different payment');
  }

  return {
    approved: true,
    proposalId: proposal.id,
    orgId: proposal.orgId,
    payload,
    beneficiaryIds: proposal.explain.evidence.filter((item) => item.source === 'COUNTERPARTY').map((item) => item.ref),
  };
}

/** The payee as a transfer body states it (the zod-parsed `recipient`). */
export type BeneficiaryInput = {
  name: string;
  country: string;
  bank?: { swift?: string; account?: string };
  travelRule?: Record<string, unknown>;
};

type BeneficiaryRecord = Pick<RecipientRecord, 'id' | 'name' | 'country' | 'swift' | 'account'>;

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/**
 * Is this saved record the payee the body names? Compared the way the record
 * was stored from a body (lib/server/repository/recipients.ts): the travel-rule
 * account number and a SWIFT_BIC bank id win over the plain bank fields, so
 * either spelling of the same payee matches and nothing else does.
 */
export function beneficiaryMatches(record: BeneficiaryRecord, payee: BeneficiaryInput): boolean {
  const travelRule = (payee.travelRule ?? {}) as Record<string, unknown>;
  const accounts = new Set([text(payee.bank?.account), text(travelRule.bankAccountNumber)].filter(Boolean));
  const swifts = new Set(
    [text(payee.bank?.swift), travelRule.bankIdScheme === 'SWIFT_BIC' ? text(travelRule.bankIdValue) : '']
      .filter(Boolean)
      .map((swift) => swift.toUpperCase()),
  );
  return (
    text(record.name) === text(payee.name) &&
    text(record.country).toUpperCase() === text(payee.country).toUpperCase() &&
    (accounts.size === 0 ? text(record.account) === '' : accounts.has(text(record.account))) &&
    (swifts.size === 0 ? text(record.swift) === '' : swifts.has(text(record.swift).toUpperCase()))
  );
}

async function readSavedRecipient(orgId: string, recipientId: string) {
  const { readRecipient } = await import('@/lib/server/recipients-store');
  return readRecipient(orgId, recipientId);
}

/**
 * The beneficiary an approved transfer was approved for: the saved record its
 * proposal names, reused — not a fresh one built from the body.
 *
 * The replay used to call `persistRecipient(buildRecipient(...))` like any
 * payment, minting a new `rcpt_` id, so the executed transfer named a
 * different beneficiary than the proposal the approvers signed and any
 * screening recorded against it. Now it is the same record, or nothing: a
 * record that has been deleted, or no longer matches the payee in the body,
 * refuses the payment (`approvalBeneficiaryRefusal`) rather than paying
 * someone the approval did not name.
 */
export async function approvedBeneficiary(
  orgId: string,
  claim: ApprovalClaim,
  payee: BeneficiaryInput,
  read: (orgId: string, recipientId: string) => Promise<RecipientRecord | null> = readSavedRecipient,
): Promise<RecipientRecord | null> {
  if (!claim.approved) return null;
  const ids = (claim.beneficiaryIds ?? []).filter((id) => /^rcpt_[A-Za-z0-9_-]+$/.test(id));
  // A transfer names one beneficiary. Anything else is not a transfer approval.
  if (ids.length !== 1) return null;
  const record = await read(orgId, ids[0]);
  return record && record.id === ids[0] && beneficiaryMatches(record, payee) ? record : null;
}

export function approvalBeneficiaryRefusal(): Response {
  return Response.json(
    {
      error:
        'The beneficiary this payment was approved for is no longer on record as approved, so nothing was sent. ' +
        'Re-authorize the payment to try again.',
      code: 'approval_beneficiary_missing',
    },
    { status: 409 },
  );
}

/**
 * The claim this request carries, if any.
 *
 * `expected` is the payment the route is about to make. A route that cannot
 * say what it is paying cannot have it approved, so without it the answer is
 * always no — which is what the treasury route gets.
 */
export async function resolveApprovalClaim(
  request: Request,
  orgId: string,
  expected?: ClaimedPayment,
): Promise<ApprovalClaim> {
  const replay = approvalReplayOf(request);
  if (!replay) {
    if (request.headers.has(RETIRED_HEADER)) {
      // A probe or a stale client. It changes nothing, and the value is not
      // logged — only that someone sent it.
      console.warn('[approval] ignored a client-supplied approved-proposal header');
    }
    return { approved: false, proposalId: null };
  }
  if (!expected) return refused('this route does not bind an approval to a payment');

  try {
    const { getOxwalProposalStore } = await import('@/lib/agent/oxwal');
    const { ensureProposalStoreHydrated } = await import('@/lib/queue/proposal-persistence');

    const store = getOxwalProposalStore();
    await ensureProposalStoreHydrated(store);
    const claim = verifyApprovalClaim({ proposal: store.get(replay.proposalId), replay, orgId, expected });
    if (!claim.approved) {
      console.warn('[approval] replay claim refused', {
        proposalId: replay.proposalId,
        channel: replay.channel,
        reason: claim.reason,
      });
    }
    return claim;
  } catch (error) {
    // Unreadable store means unverifiable claim means not approved.
    console.error('[approval] could not verify the approval claim', error);
    return { approved: false, proposalId: null, reason: 'store unavailable' };
  }
}

export type SpendOutcome = 'spent' | 'already-spent' | 'unrecorded';

/**
 * Spend a verified claim, once. The route calls this after every other guard
 * has passed and immediately before the payment record exists; anything but
 * `spent` means nothing is created.
 *
 * Without the database there is nothing durable to spend it against, and "we
 * could not record it" must never behave like "it has not been used".
 */
export async function spendApprovalClaim(claim: ApprovalClaim): Promise<SpendOutcome> {
  if (!claim.approved || !claim.proposalId || !claim.orgId) return 'unrecorded';
  if (!process.env.DATABASE_URL) return 'unrecorded';

  try {
    const { getDb } = await import('@/lib/db/client');
    const { claimProposalExecution } = await import('@/lib/db/proposal-repo');
    const result = await claimProposalExecution(getDb() as never, {
      proposalId: claim.proposalId,
      orgId: claim.orgId,
      at: new Date(),
    });
    if (result === 'claimed') return 'spent';
    return result === 'already-claimed' ? 'already-spent' : 'unrecorded';
  } catch (error) {
    console.error('[approval] could not record the approval as spent', error);
    return 'unrecorded';
  }
}

/**
 * A replay whose claim did not verify. There is no session to fall back to and
 * no maker present to send the payment for approval again, so nothing happens.
 */
export function approvalClaimRefusal(claim: ApprovalClaim): Response {
  return Response.json(
    {
      error:
        `This approval does not cover this payment (${claim.reason ?? 'unverified'}), so nothing was sent. ` +
        'Re-authorize the payment to try again.',
      code: 'approval_claim_refused',
    },
    { status: 403 },
  );
}

/** The claim verified but could not be spent: nothing was created. */
export function approvalSpendRefusal(outcome: Exclude<SpendOutcome, 'spent'>): Response {
  return outcome === 'already-spent'
    ? Response.json(
        {
          error: 'This approval has already released its payment. It cannot release another.',
          code: 'approval_already_used',
        },
        { status: 409 },
      )
    : Response.json(
        {
          error:
            'The approval could not be recorded as used, so nothing was sent. ' +
            'Re-authorize the payment to try again.',
          code: 'approval_unrecorded',
        },
        { status: 503 },
      );
}
