import type { FinancialImpact, ProposalStatus, SimulationResult, UnsignedProposal, UserRole } from '@/lib/agent/types';
import { proposalApprovalHash } from '../proposals/canonical-hash.ts';
import { recordProposalTransition } from '../observability/proposals.ts';
import { AGENT_ACTOR_ID } from '@/lib/agent/identity';

export class ProposalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalStateError';
  }
}

export type ProposalApproval = UnsignedProposal['approvals'][number];

export type ProposalTransitionEvent =
  | { type: 'SIMULATION_COMPLETED'; simulation: SimulationResult }
  | { type: 'POLICY_EVALUATED'; requiredApprovers: 0 | 1 | 2 }
  | { type: 'QUEUE_FOR_APPROVAL' }
  | { type: 'MARK_APPROVED' }
  | { type: 'APPROVE'; approval: ProposalApproval }
  | { type: 'SIGN'; signatureRef: string; signedBy: string; policyAuthorized: boolean; signedAt: string }
  | { type: 'SUBMIT' }
  | { type: 'SETTLE'; settlement: NonNullable<UnsignedProposal['settlement']> }
  | { type: 'ANCHOR' }
  | { type: 'REJECT'; reason?: string }
  | { type: 'FAIL'; reason: string }
  | { type: 'EXPIRE' }
  | { type: 'REVERSE'; reason: string };

const terminalStatuses = new Set<ProposalStatus>(['ANCHORED', 'REJECTED', 'FAILED', 'EXPIRED', 'REVERSED']);
const approverRoles = new Set<UserRole>(['OWNER', 'FINANCE_ADMIN', 'APPROVER']);

/** Whether an approval from this role counts. The state machine's own set,
 *  exported so a channel asks the question the APPROVE transition will. */
export function canRoleApprove(role: UserRole): boolean {
  return approverRoles.has(role);
}

/**
 * Where EXPIRE is legal: anywhere before the proposal is signed. Past that the
 * payment is being carried out, or has been, and "expired" would misdescribe
 * money that may already have moved.
 */
const expirableStatuses = new Set<ProposalStatus>(['DRAFTED', 'SIMULATED', 'POLICY_EVALUATED', 'PENDING_APPROVAL', 'APPROVED']);

/** Every approval collected, on the way to being carried out. */
const committedStatuses = new Set<ProposalStatus>(['APPROVED', 'SIGNED', 'SUBMITTED']);

export function isTerminalProposalStatus(status: ProposalStatus): boolean {
  return terminalStatuses.has(status);
}

/**
 * Still in flight: not finished, and not yet carried out.
 *
 * A proposal is finished when it reaches a terminal status, when it settles, or
 * when an execution outcome is recorded against it: an approved payment that
 * was sent, refused on replay, or skipped. SUBMITTED alone is not finished.
 * That is the window while the payment is being carried out, and an outcome
 * nobody recorded is an unknown outcome, not a failure.
 *
 * This is what an idempotency key covers. A proposal holds its key while it is
 * in flight, so a re-submission of the same payment finds it instead of making a
 * second. Once it is finished, the same payment again is a new attempt and gets
 * a proposal of its own. The partial unique index
 * `proposals_open_idempotency_unique` (drizzle/0025) says the same in Postgres,
 * and tests/proposal-idempotency.test.mjs holds the two together.
 */
export function isProposalInFlight(proposal: UnsignedProposal): boolean {
  if (terminalStatuses.has(proposal.status) || proposal.status === 'SETTLED') return false;
  return proposal.execution === undefined;
}

/**
 * Past its expiry, and still at a point where lapsing it is legal.
 *
 * The policy engine already refuses to approve a proposal whose `expiresAt` has
 * passed (lib/policy/evaluate.ts, "quote expired"), by the same comparison.
 * Nothing moved the status, though, so the proposal went on reading as pending:
 * in the queue, to a re-submission it absorbed, and on every boot.
 */
export function isStaleProposal(proposal: UnsignedProposal, nowMs: number): boolean {
  if (!expirableStatuses.has(proposal.status)) return false;
  const expiresAt = Date.parse(proposal.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt < nowMs;
}

/**
 * How long a payment everyone approved stays in view after its window closes.
 * Approved and not sent is when someone most needs to see it, and the queue's
 * ready-to-send lane says why it can no longer go (lib/queue/ready-to-send.ts).
 * A re-submission of the same payment replaces it at once (`create`); this only
 * bounds how long it lingers when nobody does.
 */
const APPROVED_LINGER_MS = 24 * 60 * 60 * 1000;

/** Stale, and past being shown: what reads and hydration lapse. */
function isDueToLapse(proposal: UnsignedProposal, nowMs: number): boolean {
  if (!isStaleProposal(proposal, nowMs)) return false;
  if (proposal.status !== 'APPROVED') return true;
  return Date.parse(proposal.expiresAt) + APPROVED_LINGER_MS < nowMs;
}

function assertTransition(current: ProposalStatus, allowed: ProposalStatus[], eventType: ProposalTransitionEvent['type']) {
  if (!allowed.includes(current)) {
    throw new ProposalStateError(`${eventType} is not allowed from ${current}`);
  }
}

function assertNotTerminal(status: ProposalStatus, eventType: ProposalTransitionEvent['type']) {
  if (terminalStatuses.has(status)) {
    throw new ProposalStateError(`${eventType} is not allowed after ${status}`);
  }
}

function requiredApprovers(proposal: UnsignedProposal): 0 | 1 | 2 {
  if (proposal.explain.requiredApprovers === 0) return 0;
  if (proposal.explain.requiredApprovers === 1) return 1;
  if (proposal.explain.requiredApprovers === 2) return 2;
  throw new ProposalStateError('requiredApprovers must be 0, 1, or 2');
}

function hasMetApprovalRequirement(proposal: UnsignedProposal) {
  return new Set(proposal.approvals.map((approval) => approval.userId)).size >= requiredApprovers(proposal);
}

function assertApprovalAllowed(proposal: UnsignedProposal, approval: ProposalApproval) {
  if (!approverRoles.has(approval.role)) {
    throw new ProposalStateError(`${approval.role} cannot approve proposals`);
  }
  if (proposal.createdBy !== AGENT_ACTOR_ID && approval.userId === proposal.createdBy) {
    throw new ProposalStateError('maker cannot approve their own proposal');
  }
  if (proposal.approvals.some((item) => item.userId === approval.userId)) {
    throw new ProposalStateError('approval must come from a distinct approver');
  }
}

function markApprovedIfReady(proposal: UnsignedProposal): UnsignedProposal {
  return hasMetApprovalRequirement(proposal)
    ? { ...proposal, status: 'APPROVED' }
    : proposal;
}

function rejectIfUnsignedOutboundSubmission(proposal: UnsignedProposal, event: ProposalTransitionEvent) {
  if (event.type !== 'SUBMIT') return;
  if (proposal.status !== 'SIGNED') {
    throw new ProposalStateError('proposal must be signed before submission');
  }
}

/** Track A §1.4 — anchor the canon: version defaults to 1 and the approval
 *  hash is (re)computed server-side. Called on create and hydrate. */
export function withApprovalCanon(proposal: UnsignedProposal): UnsignedProposal {
  const versioned = { ...proposal, version: proposal.version ?? 1 };
  return { ...versioned, approvalHash: proposalApprovalHash(versioned) };
}

/** Approval-time integrity: the stored hash must equal a fresh recompute of
 *  the stored row. A mismatch means a canon field was mutated without going
 *  through reviseProposalCanon — approvals must not attach to it. */
function assertCanonIntact(proposal: UnsignedProposal, eventType: ProposalTransitionEvent['type']) {
  if (!proposal.approvalHash) return; // legacy row — canon anchored on next write
  const recomputed = proposalApprovalHash(proposal);
  if (recomputed !== proposal.approvalHash) {
    throw new ProposalStateError(
      `${eventType} rejected: approval hash mismatch — the proposal changed since it was hashed; re-approval is required`,
    );
  }
}

export type CanonRevision = {
  financialImpact?: Partial<FinancialImpact>;
  expiresAt?: string;
  corridor?: string;
};

/** Track A §1.4 — the ONLY legal way to mutate a canon field (e.g. a quote or
 *  route refresh): bumps the version, recomputes the hash, and voids ALL
 *  prior approvals. Approvals never survive a mutation. */
export function reviseProposalCanon(proposal: UnsignedProposal, revision: CanonRevision): UnsignedProposal {
  const revised: UnsignedProposal = {
    ...proposal,
    corridor: revision.corridor ?? proposal.corridor,
    expiresAt: revision.expiresAt ?? proposal.expiresAt,
    explain: {
      ...proposal.explain,
      financialImpact: { ...proposal.explain.financialImpact, ...revision.financialImpact },
    },
    version: (proposal.version ?? 1) + 1,
    approvals: [],
    // Collected approvals are void; the proposal re-enters the flow before
    // the approval gate (policy re-evaluates on the next submission).
    status: proposal.status === 'PENDING_APPROVAL' || proposal.status === 'APPROVED' || proposal.status === 'POLICY_EVALUATED'
      ? 'SIMULATED'
      : proposal.status,
  };
  return { ...revised, approvalHash: proposalApprovalHash(revised) };
}

function actorForEvent(event: ProposalTransitionEvent) {
  if (event.type === 'APPROVE') return event.approval.userId;
  if (event.type === 'SIGN') return event.signedBy;
  return 'system';
}

function applyProposalTransition(
  proposal: UnsignedProposal,
  event: ProposalTransitionEvent,
): UnsignedProposal {
  rejectIfUnsignedOutboundSubmission(proposal, event);

  switch (event.type) {
    case 'SIMULATION_COMPLETED':
      assertTransition(proposal.status, ['DRAFTED'], event.type);
      return {
        ...proposal,
        status: event.simulation.ok ? 'SIMULATED' : 'FAILED',
        simulation: event.simulation,
      };
    case 'POLICY_EVALUATED':
      assertTransition(proposal.status, ['SIMULATED'], event.type);
      return {
        ...proposal,
        status: 'POLICY_EVALUATED',
        explain: { ...proposal.explain, requiredApprovers: event.requiredApprovers },
      };
    case 'QUEUE_FOR_APPROVAL':
      assertTransition(proposal.status, ['POLICY_EVALUATED'], event.type);
      if (requiredApprovers(proposal) === 0) {
        throw new ProposalStateError('proposal with zero required approvers should be marked approved');
      }
      return { ...proposal, status: 'PENDING_APPROVAL' };
    case 'MARK_APPROVED':
      assertTransition(proposal.status, ['POLICY_EVALUATED', 'PENDING_APPROVAL'], event.type);
      if (!hasMetApprovalRequirement(proposal)) {
        throw new ProposalStateError('approval requirement has not been met');
      }
      return { ...proposal, status: 'APPROVED' };
    case 'APPROVE': {
      assertTransition(proposal.status, ['PENDING_APPROVAL'], event.type);
      assertCanonIntact(proposal, event.type);
      assertApprovalAllowed(proposal, event.approval);
      return markApprovedIfReady({
        ...proposal,
        approvals: [...proposal.approvals, event.approval],
      });
    }
    case 'SIGN':
      assertTransition(proposal.status, ['APPROVED'], event.type);
      assertCanonIntact(proposal, event.type);
      if (!event.policyAuthorized) {
        throw new ProposalStateError('policy authorization is required before signing');
      }
      if (!event.signatureRef || !event.signedBy || event.signedBy === AGENT_ACTOR_ID || !event.signedAt) {
        throw new ProposalStateError('a human signature reference is required before signing');
      }
      if (!hasMetApprovalRequirement(proposal)) {
        throw new ProposalStateError('approval requirement has not been met');
      }
      return { ...proposal, status: 'SIGNED' };
    case 'SUBMIT':
      assertTransition(proposal.status, ['SIGNED'], event.type);
      return { ...proposal, status: 'SUBMITTED' };
    case 'SETTLE':
      assertTransition(proposal.status, ['SUBMITTED'], event.type);
      return { ...proposal, status: 'SETTLED', settlement: event.settlement };
    case 'ANCHOR':
      assertTransition(proposal.status, ['SETTLED'], event.type);
      return { ...proposal, status: 'ANCHORED' };
    case 'REJECT':
      assertNotTerminal(proposal.status, event.type);
      return { ...proposal, status: 'REJECTED' };
    case 'FAIL':
      assertNotTerminal(proposal.status, event.type);
      return { ...proposal, status: 'FAILED' };
    case 'EXPIRE':
      assertTransition(proposal.status, [...expirableStatuses], event.type);
      return { ...proposal, status: 'EXPIRED' };
    case 'REVERSE':
      assertTransition(proposal.status, ['SETTLED', 'ANCHORED'], event.type);
      return { ...proposal, status: 'REVERSED' };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

export function transitionProposal(
  proposal: UnsignedProposal,
  event: ProposalTransitionEvent,
): UnsignedProposal {
  const startedAt = Date.now();
  const next = applyProposalTransition(proposal, event);
  if (next.status !== proposal.status) {
    recordProposalTransition({
      proposalId: proposal.id,
      kind: proposal.kind,
      tier: proposal.tier,
      from: proposal.status,
      to: next.status,
      eventType: event.type,
      actor: actorForEvent(event),
      latencyMs: Date.now() - startedAt,
      at: new Date().toISOString(),
    });
  }
  return next;
}

/** Why a write failed, without the statement. drizzle wraps the driver error in
 *  one whose message is the whole query and its parameters — for a proposal,
 *  the explain, the simulation and the execution payload with the beneficiary
 *  in it — and a failure log is no place for those. */
function writeFailureReason(error: unknown): string {
  if (error instanceof Error && error.cause instanceof Error) return error.cause.message;
  return error instanceof Error ? error.message : String(error);
}

/** The key index's slot for one org's idempotency key. Keys are compared within
 *  an org, as the unique index compares them: the same key in two orgs is two
 *  payments, and one org must never be handed the other's proposal. */
function keySlot(orgId: string, idempotencyKey: string): string {
  return `${orgId}\u0000${idempotencyKey}`;
}

export type ProposalStoreOptions = {
  /** The clock expiry is judged by, in epoch ms. The app runs on the wall
   *  clock; tests pin it. */
  now?: () => number;
};

export class InMemoryProposalStore {
  private readonly proposalsById = new Map<string, UnsignedProposal>();
  /**
   * (org, idempotency key) → the proposal in flight under it.
   *
   * Only in flight. This used to map every key any proposal had carried, for
   * the life of the process, on the key alone: a payment that had been
   * rejected, had expired or had been carried out came back as its old
   * proposal every time it was proposed again. A proposal leaves the index when
   * it finishes (`isProposalInFlight`), and the key is free for the next attempt.
   */
  private readonly keyHolders = new Map<string, string>();
  /** W1 — durable write-through hook: called after every mutation with the
   *  latest proposal state. Persistence failures must not break the demo
   *  path, so the hook's promise is tracked (flush) but never thrown here. */
  private lastWrite: Promise<unknown> = Promise.resolve();
  private readonly onWrite?: (proposal: UnsignedProposal) => Promise<void>;
  /** Proposals whose most recent write failed, so Postgres holds an older
   *  state of them or none at all. Every write is the whole row, so the next
   *  write of the same proposal that lands clears its entry. */
  private readonly unwritten = new Set<string>();
  private readonly now: () => number;

  constructor(onWrite?: (proposal: UnsignedProposal) => Promise<void>, options: ProposalStoreOptions = {}) {
    this.onWrite = onWrite;
    this.now = options.now ?? (() => Date.now());
  }

  private recordWrite(proposal: UnsignedProposal) {
    if (!this.onWrite) return;
    const { id } = proposal;
    this.lastWrite = this.lastWrite
      .then(() => this.onWrite!(proposal))
      .then(
        () => {
          this.unwritten.delete(id);
        },
        (error) => {
          this.unwritten.add(id);
          console.error(`[proposal-store] persistence write failed for ${id}: ${writeFailureReason(error)}`);
        },
      );
  }

  /** Await durable persistence of every mutation issued so far. Mutating API
   *  routes call this before responding so a crash right after the response
   *  cannot lose an approval. Never rejects: a failed write is logged, and
   *  `writeFailed` is how a caller finds out about it. */
  flush(): Promise<unknown> {
    return this.lastWrite;
  }

  /**
   * Whether this proposal's latest state failed to reach the database, asked
   * once every write issued so far has settled.
   *
   * `flush` cannot tell you: it resolves either way, so that a database outage
   * never breaks reading or drafting. That is the wrong default for moving
   * money. An approval held only in memory comes back from Postgres after a
   * restart as whatever state last landed — still pending, say — without the
   * signatures that authorised whatever it paid. Anything about to act on an
   * approval asks this first.
   *
   * False with no writer (no DATABASE_URL): nothing was attempted, so nothing
   * failed, and nothing was durable to begin with.
   */
  async writeFailed(id: string): Promise<boolean> {
    await this.lastWrite;
    return this.unwritten.has(id);
  }

  /**
   * Boot hydration (W1): seed the hot in-memory map from the database. Existing
   * entries win — live state is newer than anything loaded later.
   *
   * Two things here write, on purpose:
   *
   * - A loaded proposal past its expiry is lapsed (EXPIRE) and the lapse
   *   written back, by the rule reads use (`isDueToLapse`). Nothing else
   *   dispatched EXPIRE, so it read as pending forever and came back on every
   *   boot.
   * - A loaded proposal in flight under a key a live proposal already holds is
   *   a duplicate: two attempts at one payment, which the database will not
   *   store side by side. One of them gives way (`adoptKey`).
   */
  hydrate(proposals: UnsignedProposal[]) {
    const now = this.now();
    for (const proposal of proposals) {
      if (this.proposalsById.has(proposal.id)) continue;
      // Legacy rows without a stored hash get anchored now; rows WITH a
      // stored hash keep it verbatim so a drifted row fails assertCanonIntact.
      const anchored = proposal.approvalHash ? proposal : withApprovalCanon(proposal);
      this.proposalsById.set(anchored.id, anchored);
      if (isDueToLapse(anchored, now)) {
        this.transition(anchored.id, { type: 'EXPIRE' });
      } else if (isProposalInFlight(anchored)) {
        this.adoptKey(anchored, now);
      }
    }
  }

  /**
   * Seat a loaded, in-flight proposal in the key index.
   *
   * A live proposal already holding the key is a duplicate, proposed while
   * this process could not see the database (hydration had failed, or had not
   * run yet). The unique index has refused its writes since. Leaving both is
   * two cards for one payment.
   *
   * The loaded one keeps the key: it is the one in Postgres, and the approvals
   * and approval requests already made name its id. The live one lapses.
   * Unless the live one already has every approval (and is not past its
   * expiry): then it is the one being carried out, and the loaded one lapses.
   */
  private adoptKey(loaded: UnsignedProposal, now: number) {
    const slot = keySlot(loaded.orgId, loaded.idempotencyKey);
    const liveId = this.keyHolders.get(slot);
    const live = liveId ? this.proposalsById.get(liveId) : undefined;
    if (!live) {
      this.keyHolders.set(slot, loaded.id);
      return;
    }
    if (!committedStatuses.has(live.status) || isStaleProposal(live, now)) {
      this.keyHolders.set(slot, loaded.id);
      this.transition(live.id, { type: 'EXPIRE' });
      return;
    }
    if (expirableStatuses.has(loaded.status)) {
      this.transition(loaded.id, { type: 'EXPIRE' });
      return;
    }
    // Both past signing: two executions of one payment were started. Lapsing
    // either would misdescribe money that may have moved, so both stay for a
    // person to reconcile.
    console.error(
      `[proposal-store] ${live.id} and ${loaded.id} are both being carried out under one idempotency key`,
    );
  }

  /** The proposal in flight for this org and key, if there is one. */
  private keyHolder(orgId: string, idempotencyKey: string): UnsignedProposal | null {
    const id = this.keyHolders.get(keySlot(orgId, idempotencyKey));
    if (!id) return null;
    const holder = this.proposalsById.get(id);
    if (!holder) throw new ProposalStateError('idempotency index points to a missing proposal');
    return holder;
  }

  /**
   * Create a proposal, or return the one already in flight for the same
   * payment: same org, same idempotency key.
   *
   * A holder past its expiry does not count. Policy would refuse to approve it,
   * so it is lapsed here and the new proposal takes the key.
   */
  create(proposal: UnsignedProposal): UnsignedProposal {
    const holder = this.keyHolder(proposal.orgId, proposal.idempotencyKey);
    if (holder && !isStaleProposal(holder, this.now())) return holder;

    if (this.proposalsById.has(proposal.id)) {
      throw new ProposalStateError(`proposal ${proposal.id} already exists`);
    }
    // Written before the new proposal, so the database sees the old attempt
    // finished before the new one claims the key.
    if (holder) this.transition(holder.id, { type: 'EXPIRE' });

    const anchored = withApprovalCanon(proposal);
    this.proposalsById.set(anchored.id, anchored);
    if (isProposalInFlight(anchored)) {
      this.keyHolders.set(keySlot(anchored.orgId, anchored.idempotencyKey), anchored.id);
    }
    this.recordWrite(anchored);
    return anchored;
  }

  /**
   * Lapse every proposal past its expiry that has not been signed, and return
   * the ones lapsed. `ensureProposalStoreHydrated` runs this before the store
   * is read, so an expired proposal stops showing in the pending lane and stops
   * absorbing re-submissions of its payment. One everyone approved lingers a
   * day first (`APPROVED_LINGER_MS`).
   */
  expireStale(): UnsignedProposal[] {
    const now = this.now();
    return [...this.proposalsById.values()]
      .filter((proposal) => isDueToLapse(proposal, now))
      .map((proposal) => this.transition(proposal.id, { type: 'EXPIRE' }));
  }

  /** Keep a new state of a proposal, give its key back if it just finished,
   *  and write it through. */
  private commit(next: UnsignedProposal) {
    this.proposalsById.set(next.id, next);
    if (!isProposalInFlight(next)) {
      const slot = keySlot(next.orgId, next.idempotencyKey);
      if (this.keyHolders.get(slot) === next.id) this.keyHolders.delete(slot);
    }
    this.recordWrite(next);
  }

  get(id: string): UnsignedProposal | null {
    return this.proposalsById.get(id) ?? null;
  }

  list(): UnsignedProposal[] {
    return [...this.proposalsById.values()];
  }

  transition(id: string, event: ProposalTransitionEvent): UnsignedProposal {
    const proposal = this.proposalsById.get(id);
    if (!proposal) throw new ProposalStateError(`proposal ${id} was not found`);

    const next = transitionProposal(proposal, event);
    this.commit(next);
    return next;
  }

  /**
   * Record what happened when an approved proposal was carried out.
   *
   * Deliberately NOT `revise`. A canon revision voids every approval, which
   * is right for a quote refresh and catastrophic here: the execution
   * outcome arrives immediately AFTER the approvals were collected, and
   * writing it through `revise` would delete the signatures that authorised
   * the payment it is reporting on.
   *
   * `execution` is not a canon field — it is an observation about a decision
   * already made — so nothing is versioned and no approval is touched.
   *
   * It does finish the proposal: its idempotency key is free again, so the same
   * payment proposed after this is a new attempt, not this one returned.
   */
  recordExecution(id: string, execution: NonNullable<UnsignedProposal['execution']>): UnsignedProposal {
    const proposal = this.proposalsById.get(id);
    if (!proposal) throw new ProposalStateError(`proposal ${id} was not found`);

    const next: UnsignedProposal = { ...proposal, execution };
    this.commit(next);
    return next;
  }

  /**
   * Spend the approval on one execution. True exactly once per proposal.
   *
   * The check and the mark are one synchronous step, so two requests racing
   * through this process cannot both find it unspent. Across processes the
   * `consumed_approvals` row decides (lib/server/approved-proposal.ts); this is
   * the in-process half, and it is not written through: the upsert does not
   * carry the mark, so a stale copy elsewhere cannot write it away.
   */
  consumeApproval(id: string, consumption: { at: string; by: string }): boolean {
    const proposal = this.proposalsById.get(id);
    if (!proposal || proposal.approvalConsumedAt) return false;

    this.proposalsById.set(id, {
      ...proposal,
      approvalConsumedAt: consumption.at,
      approvalConsumedBy: consumption.by,
    });
    return true;
  }

  /** Track A §1.4 — canon mutation (quote/route refresh): version bump, hash
   *  recompute, all prior approvals voided. */
  revise(id: string, revision: CanonRevision): UnsignedProposal {
    const proposal = this.proposalsById.get(id);
    if (!proposal) throw new ProposalStateError(`proposal ${id} was not found`);

    const next = reviseProposalCanon(proposal, revision);
    this.commit(next);
    return next;
  }
}
