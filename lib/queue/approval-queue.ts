import type { ProposalStatus, UnsignedProposal, UserRole } from '@/lib/agent/types';
import { AGENT_ACTOR_ID } from '@/lib/agent/identity';
import {
  InMemoryProposalStore,
  ProposalStateError,
  transitionProposal,
  type ProposalApproval,
} from './proposal-state.ts';

export type QueueLane =
  | 'PENDING_APPROVALS'
  | 'FAILED_SETTLEMENTS'
  | 'COMPLIANCE_HOLDS'
  | 'EXPIRING_QUOTES'
  | 'ANOMALY_HALTS';

export const queueLanes: QueueLane[] = [
  'PENDING_APPROVALS',
  'COMPLIANCE_HOLDS',
  'EXPIRING_QUOTES',
  'FAILED_SETTLEMENTS',
  'ANOMALY_HALTS',
];

export interface ApprovalActor {
  userId: string;
  role: UserRole;
}

export type ApprovalEligibility =
  | { ok: true }
  | { ok: false; reason: string };

export interface ApprovalQueueItem {
  lane: QueueLane;
  proposal: UnsignedProposal;
  reasons: string[];
  requiredApprovers: 0 | 1 | 2;
  approvalsCollected: number;
  approvalsRemaining: number;
  expiresInMs: number | null;
}

export interface ApprovalQueueView {
  generatedAt: string;
  lanes: Record<QueueLane, ApprovalQueueItem[]>;
  totals: Record<QueueLane, number> & { proposals: number };
}

export interface ApprovalQueueOptions {
  now?: Date;
  expiringWithinMs?: number;
}

const approverRoles = new Set<UserRole>(['OWNER', 'FINANCE_ADMIN', 'APPROVER']);
const terminalStatuses = new Set<ProposalStatus>(['ANCHORED', 'REJECTED', 'FAILED', 'EXPIRED', 'REVERSED']);
const defaultExpiringWithinMs = 30 * 60 * 1000;

function requiredApprovers(proposal: UnsignedProposal): 0 | 1 | 2 {
  if (proposal.explain.requiredApprovers === 0) return 0;
  if (proposal.explain.requiredApprovers === 1) return 1;
  if (proposal.explain.requiredApprovers === 2) return 2;
  throw new ProposalStateError('requiredApprovers must be 0, 1, or 2');
}

function distinctApprovalCount(proposal: UnsignedProposal) {
  return new Set(proposal.approvals.map((approval) => approval.userId)).size;
}

export function approvalsRemaining(proposal: UnsignedProposal) {
  return Math.max(0, requiredApprovers(proposal) - distinctApprovalCount(proposal));
}

export function canActorApprove(proposal: UnsignedProposal, actor: ApprovalActor): ApprovalEligibility {
  if (proposal.status !== 'PENDING_APPROVAL') {
    return { ok: false, reason: 'proposal is not pending approval' };
  }
  if (!approverRoles.has(actor.role)) {
    return { ok: false, reason: `${actor.role} cannot approve proposals` };
  }
  if (proposal.createdBy !== AGENT_ACTOR_ID && actor.userId === proposal.createdBy) {
    return { ok: false, reason: 'maker cannot approve their own proposal' };
  }
  if (proposal.approvals.some((approval) => approval.userId === actor.userId)) {
    return { ok: false, reason: 'approval must come from a distinct approver' };
  }
  if (approvalsRemaining(proposal) === 0) {
    return { ok: false, reason: 'approval requirement has already been met' };
  }
  return { ok: true };
}

export function approveQueuedProposal(
  proposal: UnsignedProposal,
  actor: ApprovalActor,
  signedAt = new Date().toISOString(),
): UnsignedProposal {
  const eligibility = canActorApprove(proposal, actor);
  if (!eligibility.ok) {
    throw new ProposalStateError(eligibility.reason);
  }

  const approval: ProposalApproval = { userId: actor.userId, role: actor.role, signedAt };
  return transitionProposal(proposal, { type: 'APPROVE', approval });
}

export function rejectQueuedProposal(proposal: UnsignedProposal): UnsignedProposal {
  if (proposal.status !== 'PENDING_APPROVAL') {
    throw new ProposalStateError('only pending proposals can be rejected from the queue');
  }
  return transitionProposal(proposal, { type: 'REJECT' });
}

function isActive(status: ProposalStatus) {
  return !terminalStatuses.has(status);
}

function expiresIn(proposal: UnsignedProposal, now: Date) {
  const expiresAt = Date.parse(proposal.expiresAt);
  if (!Number.isFinite(expiresAt)) return null;
  return expiresAt - now.getTime();
}

function hasComplianceHold(proposal: UnsignedProposal) {
  return proposal.explain.evidence.some((evidence) => evidence.source === 'COMPLIANCE' && !evidence.trusted);
}

function hasAnomalyHalt(proposal: UnsignedProposal) {
  return /anomaly|halt|paused|circuit breaker|velocity/i.test(proposal.simulation?.error ?? '');
}

function queueItem(
  lane: QueueLane,
  proposal: UnsignedProposal,
  reasons: string[],
  now: Date,
): ApprovalQueueItem {
  return {
    lane,
    proposal,
    reasons,
    requiredApprovers: requiredApprovers(proposal),
    approvalsCollected: distinctApprovalCount(proposal),
    approvalsRemaining: approvalsRemaining(proposal),
    expiresInMs: expiresIn(proposal, now),
  };
}

function emptyLanes(): Record<QueueLane, ApprovalQueueItem[]> {
  return {
    PENDING_APPROVALS: [],
    FAILED_SETTLEMENTS: [],
    COMPLIANCE_HOLDS: [],
    EXPIRING_QUOTES: [],
    ANOMALY_HALTS: [],
  };
}

function sortQueueItems(items: ApprovalQueueItem[]) {
  return items.sort((a, b) => {
    const aExpires = a.expiresInMs ?? Number.MAX_SAFE_INTEGER;
    const bExpires = b.expiresInMs ?? Number.MAX_SAFE_INTEGER;
    if (aExpires !== bExpires) return aExpires - bExpires;
    return a.proposal.createdAt.localeCompare(b.proposal.createdAt);
  });
}

export function buildApprovalQueue(
  proposals: UnsignedProposal[],
  options: ApprovalQueueOptions = {},
): ApprovalQueueView {
  const now = options.now ?? new Date();
  const expiringWithinMs = options.expiringWithinMs ?? defaultExpiringWithinMs;
  const lanes = emptyLanes();

  for (const proposal of proposals) {
    const remainingMs = expiresIn(proposal, now);

    if (proposal.status === 'PENDING_APPROVAL') {
      lanes.PENDING_APPROVALS.push(queueItem('PENDING_APPROVALS', proposal, ['approval required'], now));
    }

    if (proposal.status === 'FAILED') {
      lanes.FAILED_SETTLEMENTS.push(queueItem('FAILED_SETTLEMENTS', proposal, [proposal.simulation?.error ?? 'settlement failed'], now));
    }

    if (hasComplianceHold(proposal)) {
      lanes.COMPLIANCE_HOLDS.push(queueItem('COMPLIANCE_HOLDS', proposal, ['compliance evidence requires review'], now));
    }

    if (isActive(proposal.status) && remainingMs !== null && remainingMs >= 0 && remainingMs <= expiringWithinMs) {
      lanes.EXPIRING_QUOTES.push(queueItem('EXPIRING_QUOTES', proposal, ['quote expires soon'], now));
    }

    if (hasAnomalyHalt(proposal)) {
      lanes.ANOMALY_HALTS.push(queueItem('ANOMALY_HALTS', proposal, [proposal.simulation?.error ?? 'anomaly halt'], now));
    }
  }

  for (const lane of queueLanes) {
    sortQueueItems(lanes[lane]);
  }

  return {
    generatedAt: now.toISOString(),
    lanes,
    totals: {
      proposals: proposals.length,
      PENDING_APPROVALS: lanes.PENDING_APPROVALS.length,
      FAILED_SETTLEMENTS: lanes.FAILED_SETTLEMENTS.length,
      COMPLIANCE_HOLDS: lanes.COMPLIANCE_HOLDS.length,
      EXPIRING_QUOTES: lanes.EXPIRING_QUOTES.length,
      ANOMALY_HALTS: lanes.ANOMALY_HALTS.length,
    },
  };
}

export class InMemoryApprovalQueue {
  private readonly store: InMemoryProposalStore;

  constructor(store = new InMemoryProposalStore()) {
    this.store = store;
  }

  create(proposal: UnsignedProposal): UnsignedProposal {
    return this.store.create(proposal);
  }

  get(id: string): UnsignedProposal | null {
    return this.store.get(id);
  }

  approve(id: string, actor: ApprovalActor, signedAt = new Date().toISOString()): UnsignedProposal {
    const proposal = this.requireProposal(id);
    const eligibility = canActorApprove(proposal, actor);
    if (!eligibility.ok) {
      throw new ProposalStateError(eligibility.reason);
    }
    return this.store.transition(id, {
      type: 'APPROVE',
      approval: { userId: actor.userId, role: actor.role, signedAt },
    });
  }

  reject(id: string): UnsignedProposal {
    const proposal = this.requireProposal(id);
    if (proposal.status !== 'PENDING_APPROVAL') {
      throw new ProposalStateError('only pending proposals can be rejected from the queue');
    }
    return this.store.transition(id, { type: 'REJECT' });
  }

  view(options: ApprovalQueueOptions = {}): ApprovalQueueView {
    return buildApprovalQueue(this.store.list(), options);
  }

  private requireProposal(id: string) {
    const proposal = this.store.get(id);
    if (!proposal) throw new ProposalStateError(`proposal ${id} was not found`);
    return proposal;
  }
}
