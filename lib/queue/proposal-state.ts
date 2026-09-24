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

/**
 * Where a proposal can still become the payment it describes: awaiting
 * approval (the three statuses /queue shows as open work), or approved and not
 * yet handed to the executor. SUBMITTED is not here — from then on the
 * proposal has been carried out, whatever the outcome, and its approval is
 * spent.
 */
const resubmissionAbsorbingStatuses = new Set<ProposalStatus>([
  'SIMULATED',
  'POLICY_EVALUATED',
  'PENDING_APPROVAL',
  'APPROVED',
  'SIGNED',
]);

/**
 * Should a re-submission of the same payment find this proposal rather than
 * make a new one?
 *
 * Only while it can still be approved and carried out: in one of the statuses
 * above, and inside its approval window. It used to be ANY proposal with the
 * key. Once an approved payment's replay failed — balance, pause, peg, a
 * ceiling — the re-authorization the failure asked for got the spent proposal
 * back, and the 409 said it was in the approval queue when nothing there could
 * ever approve it. A rejected or expired payment was stuck the same way.
 */
export function absorbsResubmission(proposal: UnsignedProposal, nowMs = Date.now()): boolean {
  if (!resubmissionAbsorbingStatuses.has(proposal.status)) return false;
  const expiresAt = Date.parse(proposal.expiresAt);
  // Policy's rule, mirrored (lib/policy/evaluate.ts): blocked once the expiry
  // is past, and a proposal with no readable expiry is judged by policy.
  return !Number.isFinite(expiresAt) || expiresAt >= nowMs;
}

// ── Idempotency-key generations ─────────────────────────────────────────────
//
// A proposal's idempotency key names the payment: the same recipient, amount
// and currency, or the same payroll rows. It lets a re-submission find the
// proposal still waiting for approval. But the same payment can legitimately
// be made again — the retry after a failed attempt, next month's identical
// payroll — and both the store's key index and Postgres's unique index on
// (org_id, idempotency_key) keep a key for as long as its proposal exists,
// which is forever. So the next proposal for the same payment takes the next
// generation of the key: `key`, then `key#2`, `key#3`. Generation 1 is the bare
// key, so every proposal made before generations existed is generation 1.

export function idempotencyKeyForGeneration(baseKey: string, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new ProposalStateError(`key generation must be a positive integer, got ${generation}`);
  }
  return generation === 1 ? baseKey : `${baseKey}#${generation}`;
}

/** Which generation of `baseKey` this key is, or null when it is not one. */
export function idempotencyKeyGeneration(baseKey: string, key: string): number | null {
  if (key === baseKey) return 1;
  if (!key.startsWith(`${baseKey}#`)) return null;
  // Canonical digits only: a transfer key carries free text (the payee's
  // name), so another payment's key could begin with this one's plus '#' — but
  // what follows it then is never a bare number.
  const suffix = key.slice(baseKey.length + 1);
  if (!/^[1-9]\d{0,8}$/.test(suffix)) return null;
  const generation = Number(suffix);
  return generation >= 2 ? generation : null;
}

/** The first generation of `baseKey` above every one `usedKeys` has taken. */
export function nextIdempotencyKeyGeneration(baseKey: string, usedKeys: Iterable<string>): number {
  let highest = 0;
  for (const key of usedKeys) {
    const generation = idempotencyKeyGeneration(baseKey, key);
    if (generation !== null && generation > highest) highest = generation;
  }
  return highest + 1;
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
      assertTransition(proposal.status, ['DRAFTED', 'SIMULATED', 'POLICY_EVALUATED', 'PENDING_APPROVAL', 'APPROVED'], event.type);
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

export class InMemoryProposalStore {
  private readonly proposalsById = new Map<string, UnsignedProposal>();
  private readonly idsByIdempotencyKey = new Map<string, string>();
  /** W1 — durable write-through hook: called after every mutation with the
   *  latest proposal state. Persistence failures must not break the demo
   *  path, so the hook's promise is tracked (flush) but never thrown here. */
  private lastWrite: Promise<unknown> = Promise.resolve();
  private readonly onWrite?: (proposal: UnsignedProposal) => Promise<void>;

  constructor(onWrite?: (proposal: UnsignedProposal) => Promise<void>) {
    this.onWrite = onWrite;
  }

  private recordWrite(proposal: UnsignedProposal) {
    if (!this.onWrite) return;
    this.lastWrite = this.lastWrite
      .then(() => this.onWrite!(proposal))
      .catch((error) => {
        console.error('[proposal-store] persistence write failed', error);
      });
  }

  /** Await durable persistence of every mutation issued so far. Mutating API
   *  routes call this before responding so a crash right after the response
   *  cannot lose an approval. */
  flush(): Promise<unknown> {
    return this.lastWrite;
  }

  /** Boot hydration (W1): seed the hot in-memory map from the database
   *  without re-triggering writes. Existing entries win — live state is
   *  newer than anything loaded later. */
  hydrate(proposals: UnsignedProposal[]) {
    for (const proposal of proposals) {
      if (this.proposalsById.has(proposal.id)) continue;
      // Legacy rows without a stored hash get anchored now; rows WITH a
      // stored hash keep it verbatim so a drifted row fails assertCanonIntact.
      const anchored = proposal.approvalHash ? proposal : withApprovalCanon(proposal);
      this.proposalsById.set(anchored.id, anchored);
      this.idsByIdempotencyKey.set(anchored.idempotencyKey, anchored.id);
    }
  }

  create(proposal: UnsignedProposal): UnsignedProposal {
    const existingId = this.idsByIdempotencyKey.get(proposal.idempotencyKey);
    if (existingId) {
      const existing = this.proposalsById.get(existingId);
      if (!existing) throw new ProposalStateError('idempotency index points to a missing proposal');
      return existing;
    }

    if (this.proposalsById.has(proposal.id)) {
      throw new ProposalStateError(`proposal ${proposal.id} already exists`);
    }

    const anchored = withApprovalCanon(proposal);
    this.proposalsById.set(anchored.id, anchored);
    this.idsByIdempotencyKey.set(anchored.idempotencyKey, anchored.id);
    this.recordWrite(anchored);
    return anchored;
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
    this.proposalsById.set(id, next);
    this.recordWrite(next);
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
   */
  recordExecution(id: string, execution: NonNullable<UnsignedProposal['execution']>): UnsignedProposal {
    const proposal = this.proposalsById.get(id);
    if (!proposal) throw new ProposalStateError(`proposal ${id} was not found`);

    const next: UnsignedProposal = { ...proposal, execution };
    this.proposalsById.set(id, next);
    this.recordWrite(next);
    return next;
  }

  /** Track A §1.4 — canon mutation (quote/route refresh): version bump, hash
   *  recompute, all prior approvals voided. */
  revise(id: string, revision: CanonRevision): UnsignedProposal {
    const proposal = this.proposalsById.get(id);
    if (!proposal) throw new ProposalStateError(`proposal ${id} was not found`);

    const next = reviseProposalCanon(proposal, revision);
    this.proposalsById.set(id, next);
    this.recordWrite(next);
    return next;
  }
}
