/**
 * What happens when the last approver answers, by WhatsApp or by code.
 *
 * A WhatsApp reply, a code typed into Splash and a click in the app are three
 * ways of asking one question. The channel decides how the question was put;
 * it must not decide what an answer is worth. So the walk here is the submit
 * route's (lib/queue/approval-walk.ts): policy, quote expiry and compliance
 * re-evaluated at the moment of approval, SIMULATED → POLICY_EVALUATED →
 * PENDING_APPROVAL, then one APPROVE per ballot through the state machine.
 *
 * ─── Why this never paid anything ───────────────────────────────────────────
 *
 * It applied APPROVE to the SIMULATED proposal a money route leaves behind.
 * The state machine takes APPROVE only from PENDING_APPROVAL, so every ballot
 * was refused and the refusal swallowed; SIGN then threw from SIMULATED, and
 * every approver was told "Approved, but the payment could not be completed."
 *
 * ─── Who may release the money ──────────────────────────────────────────────
 *
 * A vote can arrive without a session. A payment does not leave without one.
 *
 * WhatsApp proves which handset a message came from, not who was holding it or
 * whether they are signed in. This path used to carry the payment out from the
 * webhook anyway, by replaying the money route with an empty cookie. The route
 * reads its session through `cookies()`, found none, and refused. It could have
 * been handed an identity instead. It is not given one: a replay that
 * authenticates as "the approval" is a second way into the two money routes
 * with no person behind it, and a SIM swap or an unlocked phone would then be
 * enough to move money past maker-checker.
 *
 * So:
 *
 *   a unanimous reply takes the payment as far as APPROVED, every ballot
 *   recorded on it, and stops there. It waits for a signed-in approver;
 *
 *   a code typed into Splash arrives with a session. When it completes the
 *   vote, that approver releases the payment, provided they hold an approving
 *   role in the payment's own org, did not make it, and are signed in to that
 *   org, because the replay runs as their session;
 *
 *   a signed-in approver can also release a payment approved over WhatsApp,
 *   in the app, through proposals/[id]/submit, which runs the same walk.
 *
 * The money moves only through a replay of the real authorize route, so every
 * guard runs again against current state (lib/server/approval-execution.ts).
 */
import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import type { ComplianceResult, UnsignedProposal, UserRole } from '@/lib/agent/types';
import { mapDbRole } from '@/lib/auth/authority';
import { approvalTokens, memberships } from '@/lib/db/schema';
import type * as schemaModule from '@/lib/db/schema';
import { loadOrgPolicy } from '@/lib/policy/org-policy';
import {
  evaluateAtApproval,
  recordApprovals,
  rejectUnlessReleased,
  releaseApproved,
  type ApprovalActor,
} from '@/lib/queue/approval-walk';
import { canRoleApprove, type InMemoryProposalStore } from '@/lib/queue/proposal-state';
import { kindInScope, launchScope, LAUNCH_SCOPE_NOT_SENT } from '@/lib/server/launch-scope';
import {
  APPROVAL_NOT_SAVED,
  type ExecutionContext,
  type ExecutionOutcome,
} from '@/lib/server/approval-execution';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

/** How the final answer arrived. An in-app approval settles through
 *  proposals/[id]/submit. */
export type SettleChannel = 'code' | 'whatsapp';

export type SettleStage =
  /** Released here, and the payment route took it. */
  | 'SENT'
  /** Released here, and the payment route refused, failed or skipped it. */
  | 'NOT_SENT'
  /** Everyone approved; a signed-in approver still has to send it. */
  | 'AWAITING_RELEASE'
  /** Policy wants more approvals than the ballots supplied. */
  | 'NEEDS_APPROVER'
  /** Policy refused it at the moment of approval. */
  | 'BLOCKED'
  /** Not every ballot has said yes. */
  | 'WAITING'
  /** An earlier approval already released it. It is never released twice. */
  | 'ALREADY_RELEASED'
  /** Rejected, failed or expired. */
  | 'CLOSED'
  | 'NOT_FOUND'
  | 'ERROR';

/** `settled` is true when the payment has been sent, by this call or an
 *  earlier one. */
export type SettleOutcome = { settled: boolean; stage: SettleStage; message: string };

/**
 * The signed-in approver whose request completed the vote. Only the code
 * channel has one: a webhook has no session to offer.
 */
export type Releaser = {
  userId: string;
  /** The org their session resolves to, which is the org the replayed money
   *  route will act in. It must be the payment's own. */
  sessionOrgId: string;
} & ExecutionContext;

/** A ballot that said yes, with the role its user holds in the proposal's
 *  org today. */
export type Ballot = { userId: string; role: UserRole; decidedAt: Date };

export type BallotRound =
  /** Every ballot issued for this proposal said yes. */
  | { state: 'UNANIMOUS'; ballots: Ballot[] }
  /** Someone said no. Final. */
  | { state: 'REFUSED' }
  /** Someone has not answered, or nobody was asked. */
  | { state: 'OPEN' };

export type SettleDeps = {
  store: InMemoryProposalStore;
  db: DrizzleDb;
  compliance: (proposal: UnsignedProposal) => ComplianceResult;
  /** The KYB money gate, for the payment's org. Checked before anything is
   *  signed: the replayed route would refuse later, after the approval had
   *  been spent on the attempt. */
  canMoveMoney: (orgId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  execute: (proposal: UnsignedProposal, context: ExecutionContext) => Promise<ExecutionOutcome>;
  /** Spend an approval nothing may present again (approved-proposal.ts). */
  closeClaim: (proposalId: string, orgId: string) => Promise<void>;
  now: () => Date;
};

const REJECTED_MESSAGE = 'Rejected. The payment will not be sent, and no further approvals can change that.';

function outcome(stage: SettleStage, message: string, settled = false): SettleOutcome {
  return { settled, stage, message };
}

/**
 * The ballots on this proposal and where the vote stands, read from the rows.
 *
 * Scoped to the proposal's org twice over: the ballots, and each voter's role.
 * A person can hold memberships in more than one workspace, and only the role
 * they hold in this payment's org is theirs to use on it. A voter with no
 * membership here counts as a viewer, which cannot approve.
 */
export async function readBallotRound(
  db: DrizzleDb,
  proposal: { id: string; orgId: string },
): Promise<BallotRound> {
  const rows = await db
    .select({
      userId: approvalTokens.userId,
      decision: approvalTokens.decision,
      decidedAt: approvalTokens.decidedAt,
    })
    .from(approvalTokens)
    .where(and(eq(approvalTokens.proposalId, proposal.id), eq(approvalTokens.orgId, proposal.orgId)));

  if (rows.length === 0) return { state: 'OPEN' };
  if (rows.some((row) => row.decision === 'REJECT')) return { state: 'REFUSED' };
  if (rows.some((row) => row.decision !== 'APPROVE')) return { state: 'OPEN' };

  const roles = await db
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, proposal.orgId),
        inArray(
          memberships.userId,
          rows.map((row) => row.userId),
        ),
      ),
    );
  const roleOf = new Map(roles.map((row) => [row.userId, mapDbRole(row.role)]));

  const ballots = rows
    .map((row) => ({
      userId: row.userId,
      role: roleOf.get(row.userId) ?? ('VIEWER' as const),
      decidedAt: row.decidedAt ?? new Date(0),
    }))
    .sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime());
  return { state: 'UNANIMOUS', ballots };
}

/** A proposal the vote can no longer move, or null when it still can. SIGNED
 *  is not here: a release that stopped between SIGN and SUBMIT is resumed by
 *  the next signed-in approver, as the submit route resumes one. */
function finished(proposal: UnsignedProposal): SettleOutcome | null {
  switch (proposal.status) {
    case 'SUBMITTED':
    case 'SETTLED':
    case 'ANCHORED':
    case 'REVERSED': {
      // A duplicate delivery, or an approver answering after someone else
      // released it: say what happened, and never release it again.
      const execution = proposal.execution;
      if (execution?.state === 'EXECUTED') {
        return outcome('ALREADY_RELEASED', 'Already approved. The payment has been sent.', true);
      }
      if (execution) {
        return outcome('ALREADY_RELEASED', `Already approved, and not sent again. ${execution.detail}`);
      }
      return outcome('ALREADY_RELEASED', 'Already approved. The payment is being sent and will not be sent twice.');
    }
    case 'REJECTED':
    case 'FAILED':
    case 'EXPIRED':
      return outcome('CLOSED', `This payment is ${proposal.status.toLowerCase()} and can no longer be approved.`);
    default:
      return null;
  }
}

async function roleInOrg(db: DrizzleDb, userId: string, orgId: string): Promise<UserRole | null> {
  const rows = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    .limit(1);
  return rows[0] ? mapDbRole(rows[0].role) : null;
}

type ReleaseCheck = { ok: true; actor: ApprovalActor } | { ok: false; reason: string };

/**
 * May this signed-in approver release this payment, now?
 *
 * Their session's org must be the payment's: the replay runs as their session,
 * and the money route resolves the paying account from the session. Signed in
 * to another workspace, the same payload would be carried out there, from
 * that workspace's money.
 */
async function checkReleaser(
  deps: SettleDeps,
  proposal: UnsignedProposal,
  releaser: Releaser,
): Promise<ReleaseCheck> {
  if (releaser.sessionOrgId !== proposal.orgId) {
    return { ok: false, reason: 'It can only be sent from the workspace it belongs to.' };
  }
  if (releaser.userId === proposal.createdBy) {
    return { ok: false, reason: 'The person who asked for a payment cannot send it themselves.' };
  }
  const role = await roleInOrg(deps.db, releaser.userId, proposal.orgId);
  if (!role || !canRoleApprove(role)) {
    return { ok: false, reason: 'Only an approver in this workspace can send it.' };
  }
  const gate = await deps.canMoveMoney(proposal.orgId);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  // Nothing outside this launch is released (lib/launch-scope-rules.ts).
  if (!kindInScope(proposal.kind, launchScope())) return { ok: false, reason: LAUNCH_SCOPE_NOT_SENT };
  return { ok: true, actor: { userId: releaser.userId, role } };
}

/** Who the policy check is run as when nobody is releasing: the latest ballot
 *  from someone who may approve and is not the maker. */
function latestApprover(ballots: Ballot[], proposal: UnsignedProposal): ApprovalActor | null {
  const ballot = [...ballots]
    .reverse()
    .find((candidate) => canRoleApprove(candidate.role) && candidate.userId !== proposal.createdBy);
  return ballot ? { userId: ballot.userId, role: ballot.role } : null;
}

/**
 * Settle a vote with every dependency handed in. The routes use
 * `settleFullyApprovedProposal`; the tests drive this against PGlite.
 */
export async function settleBallots(
  deps: SettleDeps,
  input: { proposalId: string; channel: SettleChannel; releaser: Releaser | null },
): Promise<SettleOutcome> {
  const { store } = deps;
  const found = store.get(input.proposalId);
  if (!found) return outcome('NOT_FOUND', 'That payment could not be found.');
  const early = finished(found);
  if (early) return early;

  // The caller's tally said unanimous. The rows say it again here, because
  // this is the step that matters and it must not rest on a count taken
  // somewhere else.
  const round = await readBallotRound(deps.db, found);
  if (round.state === 'REFUSED') return outcome('CLOSED', REJECTED_MESSAGE);
  if (round.state === 'OPEN') return outcome('WAITING', 'Recorded. Not every approver has answered yet.');

  const policy = await loadOrgPolicy(deps.db, found.orgId);
  const releaser = input.releaser;
  const release = releaser ? await checkReleaser(deps, found, releaser) : null;

  // From here to SUBMIT nothing awaits. Another request in this process may
  // have moved the proposal during the reads above, so it is read again, and
  // then every check and transition sees the same record.
  const current = store.get(found.id);
  if (!current) return outcome('NOT_FOUND', 'That payment could not be found.');
  const meanwhile = finished(current);
  if (meanwhile) return meanwhile;

  const actor = release?.ok ? release.actor : latestApprover(round.ballots, current);
  if (!actor) return outcome('NEEDS_APPROVER', 'Recorded. The payment still needs another approver.');

  const signatureRef = `${input.channel}:${current.id}`;
  const now = deps.now();
  let submitted: UnsignedProposal;
  let context: ExecutionContext;
  try {
    const { decision } = evaluateAtApproval(store, {
      proposalId: current.id,
      actor,
      policy,
      compliance: deps.compliance,
      signatureRef,
      now,
    });

    // Every ballot that said yes becomes an approval on the proposal, recorded
    // against the USER. The number a reply came from never appears: it is not
    // an identity and must not read as one in an audit trail.
    const counted = recordApprovals(
      store,
      current.id,
      round.ballots.map((ballot) => ({
        userId: ballot.userId,
        role: ballot.role,
        signedAt: ballot.decidedAt.toISOString(),
      })),
    );
    for (const refused of counted.refused) {
      console.warn('[approval-settle] ballot not counted', { proposalId: current.id, ...refused });
    }

    if (counted.proposal.status === 'PENDING_APPROVAL') {
      await store.flush();
      return outcome('NEEDS_APPROVER', 'Recorded. The payment still needs another approver.');
    }
    if (!release || !releaser) {
      await store.flush();
      return outcome(
        'AWAITING_RELEASE',
        'Approved by everyone. A signed-in approver sends it from Splash; a WhatsApp reply cannot send a payment.',
      );
    }
    if (!release.ok) {
      await store.flush();
      return outcome('AWAITING_RELEASE', `Approved by everyone, but not sent. ${release.reason}`);
    }

    submitted = releaseApproved(store, current.id, { releaser: release.actor, signatureRef, decision, now });
    context = { cookie: releaser.cookie, origin: releaser.origin };
  } catch (error) {
    // A policy block (nothing moved), or a transition the state machine
    // refused. The submit route's answer, in the approver's words.
    await store.flush();
    const reason = error instanceof Error ? error.message : 'the approval could not be applied';
    return outcome('BLOCKED', `Approved, but the payment cannot go: ${reason}.`);
  }
  // Saved before anything moves, as in the submit route: an approval held only
  // in memory loses who approved it at the next restart and comes back as
  // still pending for a payment already made. So nothing is sent, and the
  // claim is closed the way the replay closes one a route refused, so nothing
  // can present it later. `writeFailed` awaits the same writes `flush` would.
  if (await store.writeFailed(submitted.id)) {
    console.error(`[approval-settle] ${submitted.id}: approval not saved, payment withheld`);
    await deps.closeClaim(submitted.id, submitted.orgId);
    store.recordExecution(submitted.id, { ...APPROVAL_NOT_SAVED, at: deps.now().toISOString() });
    await store.flush();
    return outcome('NOT_SENT', `Approved, but the payment did not go: ${APPROVAL_NOT_SAVED.detail}`);
  }

  const execution = await deps.execute(submitted, context);
  store.recordExecution(submitted.id, { ...execution, at: deps.now().toISOString() });
  await store.flush();

  if (execution.state === 'EXECUTED') {
    return outcome('SENT', 'Approved by everyone. The payment has been sent.', true);
  }
  if (execution.state === 'SKIPPED') return outcome('NOT_SENT', execution.detail);
  return outcome('NOT_SENT', `Approved, but the payment did not go: ${execution.detail}`);
}

/** The KYB money gate the routes apply, as a yes or a reason. */
async function orgCanMoveMoney(orgId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { kybGateEnabled, readOrgKybState } = await import('@/lib/compliance/org-kyb');
  const { canMoveMoney, kybGateReason } = await import('@/lib/compliance/kyb-state');
  if (!kybGateEnabled()) return { ok: true };
  const state = await readOrgKybState(orgId);
  return canMoveMoney(state) ? { ok: true } : { ok: false, reason: kybGateReason(state) };
}

/**
 * Settle a vote every approver has answered.
 *
 * `releaser` is the signed-in approver whose code completed the vote, or null
 * for a WhatsApp reply, which records approvals and never releases money.
 *
 * Never throws. An approval that could not be carried out is reported as such:
 * the failure this sequence exists to remove is an approval that silently does
 * nothing, and one that silently fails would be the same bug.
 */
export async function settleFullyApprovedProposal(
  proposalId: string,
  options: { channel: SettleChannel; releaser: Releaser | null },
): Promise<SettleOutcome> {
  try {
    const { getOxwalProposalStore } = await import('@/lib/agent/oxwal');
    const { ensureProposalStoreHydrated } = await import('@/lib/queue/proposal-persistence');
    const { resolveComplianceForProposal } = await import('@/lib/compliance/proposal-screening');
    const { executeApprovedProposal } = await import('@/lib/server/approval-execution');
    const { closeApprovalClaim } = await import('@/lib/server/approved-proposal');
    const { getDb } = await import('@/lib/db/client');

    const store = getOxwalProposalStore();
    await ensureProposalStoreHydrated(store);

    return await settleBallots(
      {
        store,
        db: getDb() as unknown as DrizzleDb,
        compliance: resolveComplianceForProposal,
        canMoveMoney: orgCanMoveMoney,
        execute: (proposal, context) => executeApprovedProposal(proposal, proposal.executionPayload ?? null, context),
        closeClaim: closeApprovalClaim,
        now: () => new Date(),
      },
      { proposalId, channel: options.channel, releaser: options.releaser },
    );
  } catch (error) {
    console.error('[approval-settle] failed', error);
    return outcome('ERROR', 'Your answer is recorded, but the payment could not be completed.');
  }
}

/**
 * Close the proposal a ballot refused, with the answer the refusing approver
 * is owed. The store is handed in so the tests can drive it.
 */
export function refuseWith(store: InMemoryProposalStore, proposalId: string): { rejected: boolean; message: string } {
  const result = rejectUnlessReleased(store, proposalId, 'rejected by an approver');
  if (result.state === 'ALREADY_RELEASED') {
    return {
      rejected: false,
      message: 'Your rejection is recorded, but this payment had already been released before it arrived.',
    };
  }
  return { rejected: result.state === 'REJECTED', message: REJECTED_MESSAGE };
}

/**
 * A ballot said no. The tally already stops counting; this closes the
 * proposal too, so no other path can release it. Never throws.
 */
export async function refuseFromBallot(proposalId: string): Promise<{ rejected: boolean; message: string }> {
  try {
    const { getOxwalProposalStore } = await import('@/lib/agent/oxwal');
    const { ensureProposalStoreHydrated } = await import('@/lib/queue/proposal-persistence');
    const store = getOxwalProposalStore();
    await ensureProposalStoreHydrated(store);
    const result = refuseWith(store, proposalId);
    await store.flush();
    return result;
  } catch (error) {
    console.error('[approval-settle] could not close a refused proposal', error);
    return {
      rejected: false,
      message: 'Your rejection is recorded, but the payment could not be closed here. Check the approval queue.',
    };
  }
}
