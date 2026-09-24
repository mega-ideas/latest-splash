/**
 * What happens when the last approver says yes.
 *
 * A WhatsApp reply and a code typed into Splash reach the same place here, and
 * the place an in-app approval reaches through the submit route. The channel
 * decided how the question was asked; it must not decide what an approval is
 * worth, and a settlement path that differs by channel is two settlement paths
 * that will drift.
 *
 * ─── Why this never paid anything ───────────────────────────────────────────
 *
 * It recorded each ballot as an APPROVE transition and then signed. But a
 * proposal the money routes create sits in SIMULATED until something evaluates
 * policy and queues it, and only the in-app submit route did that. So every
 * APPROVE here threw — only PENDING_APPROVAL accepts one — and was swallowed,
 * SIGN threw from SIMULATED, and every approval by code or by reply ended in
 * "could not be completed" before a money route ran.
 *
 * Three more things were wrong behind that one:
 *
 *   it skipped the submit route's policy re-evaluation, so a reply would have
 *   been worth more than a click the moment it worked;
 *
 *   it read each ballot's role from whichever membership the user happened to
 *   hold, in any org — an admin elsewhere and a viewer here counted as admin;
 *
 *   called again for a proposal already submitted — a duplicate delivery, a
 *   second approver answering late — it replayed the payment again.
 *
 * Now it walks the proposal the way the submit route does: the same
 * `authorizeProposalSubmission` re-evaluation at the moment of the last
 * approval, then POLICY_EVALUATED → PENDING_APPROVAL → one APPROVE per ballot
 * → SIGN → SUBMIT, with roles read in the proposal's own org. Only the call
 * that performs the SUBMIT carries the payment out, and the replay runs as the
 * approval itself — no cookie, no header (approval-replay-identity.ts).
 */
import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import type { ComplianceResult, OrgPolicy, UnsignedProposal, UserRole } from '@/lib/agent/types';
import { mapDbRole } from '@/lib/auth/authority';
import { describeComplianceHold, resolveDurableComplianceForProposal } from '@/lib/compliance/proposal-screening';
import { approvalTokens, memberships } from '@/lib/db/schema';
import type * as schemaModule from '@/lib/db/schema';
import type { InMemoryProposalStore } from '@/lib/queue/proposal-state';
import { authorizeProposalSubmission } from '@/lib/safety/submit-guard';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

export type SettleOutcome = { settled: boolean; message: string };

/** The channels that settle here. An in-app approval settles through
 *  `proposals/[id]/submit`. */
export type SettleChannel = 'code' | 'whatsapp';

/** A ballot that said yes, with the role its user holds in the PROPOSAL's org. */
export type ApprovingBallot = { userId: string; role: UserRole; decidedAt: Date };

export type Advance =
  | { kind: 'submitted'; proposal: UnsignedProposal }
  | { kind: 'stopped'; outcome: SettleOutcome };

/** The payment has already been handed to the executor. */
const CARRIED_OUT = new Set(['SUBMITTED', 'SETTLED', 'ANCHORED', 'REVERSED']);
/** Nothing can be approved from here. */
const CLOSED = new Set(['REJECTED', 'FAILED', 'EXPIRED']);
/** The roles the state machine accepts an approval from. */
const APPROVING = new Set<UserRole>(['OWNER', 'FINANCE_ADMIN', 'APPROVER']);

function stopped(message: string): Advance {
  return { kind: 'stopped', outcome: { settled: false, message } };
}

/** Report on a payment an earlier approval already carried out. Never carry
 *  it out again. */
function carriedOut(proposal: UnsignedProposal): SettleOutcome {
  const execution = proposal.execution;
  if (execution?.state === 'EXECUTED') {
    return { settled: true, message: 'Already approved. The payment has been sent.' };
  }
  if (execution) {
    return { settled: false, message: `Already approved, and not sent again. ${execution.detail}` };
  }
  return { settled: false, message: 'Already approved. The payment is being carried out and will not be sent twice.' };
}

/**
 * Walk a proposal whose approvers have all said yes to SUBMITTED.
 *
 * Synchronous on purpose. Nothing awaits between reading the live status and
 * the SUBMIT transition, so of two approvals arriving together in one process
 * exactly one performs the SUBMIT and carries the payment out; the other finds
 * it SUBMITTED. Across processes, the database spend in approved-proposal.ts is
 * what stops a second payment.
 */
export function advanceToSubmission(
  store: InMemoryProposalStore,
  input: {
    proposalId: string;
    /** Oldest first. */
    ballots: ApprovingBallot[];
    policy: OrgPolicy;
    /** From what is on record for the proposal's payees, read before this
     *  runs (`resolveDurableComplianceForProposal`) — the walk never awaits. */
    compliance: ComplianceResult;
    channel: SettleChannel;
    now: Date;
  },
): Advance {
  const live = store.get(input.proposalId);
  if (!live) return stopped('That payment could not be found.');
  if (CARRIED_OUT.has(live.status)) return { kind: 'stopped', outcome: carriedOut(live) };
  if (CLOSED.has(live.status)) {
    return stopped(`This payment is ${live.status.toLowerCase()} and can no longer be approved.`);
  }
  if (!live.simulation) return stopped('This payment has not been simulated, so it cannot be approved.');
  // Who signs: the latest ballot from someone who may still approve here and
  // is not the maker. A ballot the state machine would refuse below is not
  // named as the signer either.
  const signer = [...input.ballots]
    .reverse()
    .find((ballot) => APPROVING.has(ballot.role) && ballot.userId !== live.createdBy);
  if (!signer) return stopped('Recorded. The payment still needs another approver.');

  const signatureRef = `${input.channel}:${live.id}`;
  try {
    // The submit route's §1.4 re-evaluation, run at the moment of the last
    // approval: circuit breaker, expiry, simulation, compliance screening,
    // minimum. A BLOCK throws, and nothing below it runs.
    const decision = authorizeProposalSubmission({
      proposal: live,
      actor: signer.role,
      policy: input.policy,
      simulation: live.simulation,
      compliance: input.compliance,
      signatureRef,
      signedBy: signer.userId,
      now: input.now.toISOString(),
    });

    let current = live;
    if (current.status === 'SIMULATED') {
      current = store.transition(current.id, {
        type: 'POLICY_EVALUATED',
        requiredApprovers: decision.outcome === 'REQUIRE_APPROVAL' ? decision.approvers : 0,
      });
    }
    if (current.status === 'POLICY_EVALUATED') {
      current = store.transition(
        current.id,
        current.explain.requiredApprovers === 0 ? { type: 'MARK_APPROVED' } : { type: 'QUEUE_FOR_APPROVAL' },
      );
    }

    // Every ballot that said yes becomes an approval on the proposal, recorded
    // against the USER. The number a reply came from never appears: it is not
    // an identity and must not read as one in an audit trail.
    for (const ballot of input.ballots) {
      if (current.status !== 'PENDING_APPROVAL') break;
      if (current.approvals.some((approval) => approval.userId === ballot.userId)) continue;
      try {
        // The state machine re-applies maker != checker, the approving roles
        // and the distinct-approver rule. A ballot cannot smuggle a vote past it.
        current = store.transition(current.id, {
          type: 'APPROVE',
          approval: { userId: ballot.userId, role: ballot.role, signedAt: ballot.decidedAt.toISOString() },
        });
      } catch {
        // Refused for this ballot. Not a reason to stop counting the rest.
        continue;
      }
    }

    if (current.status === 'PENDING_APPROVAL') {
      return stopped('Recorded. The payment still needs another approver.');
    }

    const signed =
      current.status === 'SIGNED'
        ? current
        : store.transition(current.id, {
            type: 'SIGN',
            signatureRef,
            signedBy: signer.userId,
            policyAuthorized: true,
            signedAt: input.now.toISOString(),
          });
    return { kind: 'submitted', proposal: store.transition(signed.id, { type: 'SUBMIT' }) };
  } catch (error) {
    // A policy block, or a transition the state machine refused. The same
    // answer the submit route gives, in the approver's words — and for a
    // compliance hold, why, since "compliance hold" alone gives an approver
    // nothing to act on.
    const reason = error instanceof Error ? error.message : 'the approval could not be applied';
    const why = /compliance hold/.test(reason) ? describeComplianceHold(input.compliance) : '';
    return stopped(`Approved, but the payment did not go: ${reason}${why ? ` (${why})` : ''}.`);
  }
}

/**
 * The ballots on this proposal that said yes, oldest first, each with the role
 * its user holds in the proposal's org. Read by org: a person can belong to
 * more than one workspace, and only this one's role is theirs to use here.
 */
async function approvingBallots(db: DrizzleDb, proposal: UnsignedProposal): Promise<ApprovingBallot[]> {
  const rows = await db
    .select({
      userId: approvalTokens.userId,
      decision: approvalTokens.decision,
      decidedAt: approvalTokens.decidedAt,
    })
    .from(approvalTokens)
    .where(and(eq(approvalTokens.proposalId, proposal.id), eq(approvalTokens.orgId, proposal.orgId)));
  const yes = rows
    .filter((row) => row.decision === 'APPROVE')
    .sort((a, b) => (a.decidedAt?.getTime() ?? 0) - (b.decidedAt?.getTime() ?? 0));
  if (yes.length === 0) return [];

  const roles = await db
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, proposal.orgId),
        inArray(
          memberships.userId,
          yes.map((row) => row.userId),
        ),
      ),
    );
  const roleOf = new Map(roles.map((row) => [row.userId, mapDbRole(row.role)]));

  return yes.map((row) => ({
    userId: row.userId,
    // No membership here means no role here: VIEWER, which cannot approve.
    role: roleOf.get(row.userId) ?? 'VIEWER',
    decidedAt: row.decidedAt ?? new Date(),
  }));
}

/**
 * Carry out a payment every approver has agreed to.
 *
 * Never throws. An approval that could not be carried out is reported as such
 * — the failure mode this whole sequence exists to remove is an approval that
 * silently does nothing, and replacing it with one that silently fails would be
 * the same bug wearing a different hat.
 */
export async function settleFullyApprovedProposal(
  proposalId: string,
  options: { channel?: SettleChannel } = {},
): Promise<SettleOutcome> {
  const channel = options.channel ?? 'whatsapp';
  try {
    const { getOxwalProposalStore } = await import('@/lib/agent/oxwal');
    const { ensureProposalStoreHydrated } = await import('@/lib/queue/proposal-persistence');
    const { executeApprovedProposal } = await import('@/lib/server/approval-execution');
    const { loadOrgPolicy } = await import('@/lib/policy/org-policy');
    const { getDb } = await import('@/lib/db/client');

    const store = getOxwalProposalStore();
    await ensureProposalStoreHydrated(store);
    const proposal = store.get(proposalId);
    if (!proposal) return { settled: false, message: 'That payment could not be found.' };
    // A duplicate delivery, or an approver answering after another carried it
    // out: say what happened, and do not carry it out again.
    if (CARRIED_OUT.has(proposal.status)) return carriedOut(proposal);

    const db = getDb() as unknown as DrizzleDb;
    const ballots = await approvingBallots(db, proposal);
    const policy = await loadOrgPolicy(db, proposal.orgId);
    // What is on record for the payees, read now — the approval moment.
    const compliance = await resolveDurableComplianceForProposal(proposal);

    const advance = advanceToSubmission(store, {
      proposalId,
      ballots,
      policy,
      compliance,
      channel,
      now: new Date(),
    });
    // Whatever was recorded is durable before anyone is told about it.
    await store.flush();
    if (advance.kind === 'stopped') return advance.outcome;

    const submitted = advance.proposal;
    const outcome = await executeApprovedProposal(submitted, submitted.executionPayload ?? null, {
      origin: (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
      channel,
    });

    store.recordExecution(submitted.id, { ...outcome, at: new Date().toISOString() });
    await store.flush();

    if (outcome.state === 'EXECUTED') {
      return { settled: true, message: 'Approved by everyone. The payment has been sent.' };
    }
    if (outcome.state === 'SKIPPED') return { settled: false, message: outcome.detail };
    return { settled: false, message: `Approved, but the payment did not go: ${outcome.detail}` };
  } catch (error) {
    console.error('[approval-settle] failed', error);
    return {
      settled: false,
      message: 'Approved, but the payment could not be completed. An operator has been alerted.',
    };
  }
}
