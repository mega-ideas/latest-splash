/**
 * Finding approved payments with no recorded outcome, and recording one.
 *
 * lib/queue/stuck-payments.ts says what "stuck" means and what the approval's
 * spend proves. This reads the spends and carries out an approver's answer.
 *
 * ─── Recording an outcome ───────────────────────────────────────────────────
 *
 * An approver says whether the payment went, after checking the payment itself
 * where the records cannot settle it. The answer becomes the proposal's
 * `execution`: EXECUTED for "sent", FAILED for "not sent", naming who recorded
 * it and what the records showed. That finishes the proposal, so its payment's
 * idempotency key is free: the same payment can be requested again, and needs
 * new approvals (lib/queue/proposal-state.ts).
 *
 * Before anything is recorded, the approval is spent (`consumed_approvals`,
 * consumed_by 'reconciliation'). A proposal still SUBMITTED would otherwise
 * carry an approval nothing had used, and a request presenting it with the
 * same payment could still pay. A spend that is already there (the route's,
 * or the replay's close) is the same guarantee. A spend that cannot be
 * recorded stops it: nothing is recorded, and the payment stays in the lane.
 *
 * Who may answer: an approving role in the payment's org, and not the person
 * who requested it. "Not sent" frees the payment to be requested again, so it
 * gets the same maker-checker line as releasing one.
 */
import 'server-only';

import type { UnsignedProposal, UserRole } from '@/lib/agent/types';
import { AGENT_ACTOR_ID } from '@/lib/agent/identity';
import { canRoleApprove, type InMemoryProposalStore } from '@/lib/queue/proposal-state';
import {
  classifySpend,
  isStuckSubmission,
  stuckFrom,
  type SpendRecord,
  type StuckEvidence,
} from '@/lib/queue/stuck-payments';
import { findingText, outcomesAllowed, type ReconcileOutcome } from '@/lib/queue/stuck-payment-view';

/** Each proposal's approval spend, where one is on record. */
export type SpendReader = (proposalIds: string[]) => Promise<Map<string, SpendRecord>>;

/** Spend the approval for reconciliation. True when this call spent it, false when it already was. Throws when it cannot be recorded. */
export type SpendRecorder = (proposal: UnsignedProposal) => Promise<boolean>;

export type StuckPayment = { proposal: UnsignedProposal; evidence: StuckEvidence };

/**
 * The org's stuck payments, oldest first, each with what its spend shows. A
 * spend that cannot be read makes the evidence 'unreadable', and the lane
 * offers no answer for it: guessing is how a paid payment gets requested twice.
 */
export async function findStuckPayments(
  store: InMemoryProposalStore,
  orgId: string,
  now: Date,
  readSpends: SpendReader,
): Promise<StuckPayment[]> {
  const stuck = store
    .list()
    .filter((proposal) => proposal.orgId === orgId && isStuckSubmission(proposal, now.getTime()))
    .sort((a, b) => Date.parse(a.submittedAt ?? '') - Date.parse(b.submittedAt ?? ''));
  if (stuck.length === 0) return [];

  let spends: Map<string, SpendRecord> | null = null;
  try {
    spends = await readSpends(stuck.map((proposal) => proposal.id));
  } catch (error) {
    console.error('[stuck-payments] could not read approval spends', error instanceof Error ? error.message : error);
  }
  return stuck.map((proposal) => ({
    proposal,
    evidence: spends ? classifySpend(spends.get(proposal.id) ?? null) : { kind: 'unreadable' },
  }));
}

/**
 * Spends from Postgres, or from this process's own marks when there is no
 * Postgres. With Postgres the row is the record: the in-process mark is set
 * before the row is written, and a route whose row could not be written
 * refused the claim.
 */
export function liveSpendReader(store: InMemoryProposalStore): SpendReader {
  return async (ids) => {
    const { proposalPersistenceEnabled } = await import('@/lib/queue/proposal-persistence');
    if (!proposalPersistenceEnabled()) {
      return new Map(
        ids.map((id) => {
          const proposal = store.get(id);
          const spend: SpendRecord = proposal?.approvalConsumedBy
            ? { consumedBy: proposal.approvalConsumedBy, consumedAt: proposal.approvalConsumedAt ?? new Date(0).toISOString() }
            : null;
          return [id, spend];
        }),
      );
    }
    const { getDb } = await import('@/lib/db/client');
    const { loadApprovalSpends } = await import('@/lib/db/proposal-repo');
    const rows = await loadApprovalSpends(getDb(), ids);
    return new Map(
      ids.map((id) => {
        const row = rows.get(id);
        return [id, row ? { consumedBy: row.consumedBy, consumedAt: row.consumedAt.toISOString() } : null];
      }),
    );
  };
}

/** Spend in this process, then in Postgres, whose primary key is the record. */
export function liveSpendRecorder(store: InMemoryProposalStore, now: () => Date): SpendRecorder {
  return async (proposal) => {
    const spentHere = store.consumeApproval(proposal.id, { at: now().toISOString(), by: 'reconciliation' });
    const { proposalPersistenceEnabled } = await import('@/lib/queue/proposal-persistence');
    if (!proposalPersistenceEnabled()) return spentHere;
    const { getDb } = await import('@/lib/db/client');
    const { consumeApprovalRecord } = await import('@/lib/db/proposal-repo');
    return consumeApprovalRecord(getDb(), { proposalId: proposal.id, orgId: proposal.orgId, consumedBy: 'reconciliation' });
  };
}

export type ReconcileDeps = {
  store: InMemoryProposalStore;
  readSpends: SpendReader;
  recordSpend: SpendRecorder;
  now: () => Date;
};

export type ReconcileInput = {
  proposalId: string;
  /** From the session and the membership, never the request. */
  actor: { userId: string; role: UserRole; orgId: string };
  outcome: ReconcileOutcome;
  /** What to find the payment by, for one recorded as sent. */
  reference?: string;
};

export type ReconcileAnswer = { status: number; body: Record<string, unknown> };

function refuse(status: number, code: string, error: string): ReconcileAnswer {
  return { status, body: { code, error } };
}

function minutesUntil(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60000));
}

/** Record whether a stuck payment went. Never throws. */
export async function reconcileStuckPayment(deps: ReconcileDeps, input: ReconcileInput): Promise<ReconcileAnswer> {
  const { store } = deps;
  const proposal = store.get(input.proposalId);
  // Tenancy: a payment in another org does not exist for this approver.
  if (!proposal || proposal.orgId !== input.actor.orgId) return refuse(404, 'NOT_FOUND', 'Proposal not found');
  if (!canRoleApprove(input.actor.role)) {
    return refuse(403, 'NOT_AN_APPROVER', 'Only an approver can record what happened to a payment.');
  }
  if (proposal.createdBy !== AGENT_ACTOR_ID && proposal.createdBy === input.actor.userId) {
    return refuse(403, 'MAKER', 'You requested this payment, so another approver records what happened.');
  }
  if (proposal.execution) {
    return refuse(409, 'PROPOSAL_CLOSED', `This payment already has an outcome recorded: ${proposal.execution.detail}`);
  }
  if (proposal.status !== 'SUBMITTED') {
    return refuse(409, 'PROPOSAL_CLOSED', 'This payment was never sent for payment, so there is no outcome to record.');
  }
  const now = deps.now();
  if (!isStuckSubmission(proposal, now.getTime())) {
    const from = stuckFrom(proposal) ?? now.getTime();
    return refuse(
      409,
      'STILL_SENDING',
      `This payment went to the payment route moments ago and may still be going. Check again in ${minutesUntil(from - now.getTime())} minutes.`,
    );
  }

  let evidence: StuckEvidence;
  try {
    const spends = await deps.readSpends([proposal.id]);
    evidence = classifySpend(spends.get(proposal.id) ?? null);
  } catch (error) {
    console.error('[reconcile] could not read the approval spend', error instanceof Error ? error.message : error);
    return refuse(503, 'RECORDS_UNREADABLE', 'Splash could not read whether the payment route used this approval, so nothing was recorded. Try again.');
  }
  if (!outcomesAllowed(evidence).includes(input.outcome)) {
    return refuse(
      409,
      'NEVER_REACHED_ROUTE',
      'The payment route never used this approval, so it cannot have paid with it. Record it as not sent.',
    );
  }

  // Spent before the outcome is recorded: an outcome on a proposal whose
  // approval still works would leave a payment someone could still send.
  try {
    await deps.recordSpend(proposal);
  } catch (error) {
    console.error('[reconcile] could not spend the approval', error instanceof Error ? error.message : error);
    return refuse(503, 'SPEND_NOT_RECORDED', 'The approval could not be closed, so nothing was recorded. Try again.');
  }

  // Read again after the awaits: another request may have recorded an outcome.
  const current = store.get(proposal.id);
  if (!current || current.execution || current.status !== 'SUBMITTED') {
    return refuse(409, 'PROPOSAL_CLOSED', 'Someone recorded an outcome for this payment while you were deciding.');
  }

  const at = deps.now().toISOString();
  const finding = findingText(evidence, (iso) => iso);
  const reference = input.reference?.trim() || undefined;
  const execution: NonNullable<UnsignedProposal['execution']> = input.outcome === 'SENT'
    ? {
        state: 'EXECUTED',
        detail: `Recorded as sent by ${input.actor.userId}${reference ? `, reference ${reference}` : ''}, after its outcome went missing. ${finding}`,
        ...(reference ? { ref: reference } : {}),
        at,
      }
    : {
        state: 'FAILED',
        detail: `Recorded as not sent by ${input.actor.userId}, after its outcome went missing. ${finding}`,
        at,
      };
  const recorded = store.recordExecution(proposal.id, execution);
  if (await store.writeFailed(proposal.id)) {
    console.error(`[reconcile] ${proposal.id}: outcome not saved`);
    return refuse(
      503,
      'NOT_SAVED',
      'The outcome could not be saved. It will be back in this list after the next restart; record it again then.',
    );
  }

  console.info('[reconcile] outcome recorded', {
    proposalId: proposal.id,
    orgId: proposal.orgId,
    recordedBy: input.actor.userId,
    outcome: input.outcome,
    evidence: evidence.kind,
  });
  return { status: 200, body: { proposal: recorded, execution } };
}
