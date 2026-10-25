import { AGENT_ACTOR_ID } from '@/lib/agent/identity';
import type { ProposalKind, ProposalStatus, UserRole } from '@/lib/agent/types';
import { kindLabel } from '@/lib/queue/queue-decision';

/**
 * What the Zeke page and the floating Zeke say before anyone asks anything
 * (v2 brief 5.3): how many payments wait for a decision, when the soonest
 * window closes, and what Zeke prepared lately.
 *
 * Pure, and fed by GET /api/oxwal/desk with the session's workspace. The
 * proposal store holds every tenant's proposals, so the workspace filter is
 * the first thing this does, and a missing workspace is "nothing known", not
 * "nothing waiting": a count of 0 shown to someone whose workspace could not
 * be read would be a number nobody measured.
 *
 * The result is labels and counts only. No amounts, payees, account details,
 * transaction bytes or approval hashes leave the store through it. A recent
 * row's title is a fixed label for its kind ("Payment", "x402 payment"),
 * never `explain.recommendation`: that is the agent's free text, and it holds
 * amounts, pay-to addresses, counterparty and org ids, and for an x402
 * request a description the seller wrote.
 */

/** A proposal as far as the desk needs it. */
export type DeskProposal = {
  id: string;
  orgId: string;
  status: ProposalStatus;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  kind: ProposalKind | string;
  approvals?: readonly { userId: string }[];
  explain: { requiredApprovers?: number };
};

/** The signed-in person, as their membership says. */
export type DeskViewer = { userId: string; role: UserRole };

export type ZekeRecentState = 'waiting' | 'approved' | 'sent' | 'rejected' | 'expired' | 'failed' | 'draft';

/** `when` is how long ago it was prepared ("3 minutes ago"), so rows of one kind can be told apart. */
export type ZekeRecentItem = { id: string; title: string; state: ZekeRecentState; label: string; when: string };

export type ZekeDeskSnapshot = {
  /** False when the workspace could not be read: then every count is 0 and means nothing. */
  known: boolean;
  firstName: string | null;
  /** Proposals in this workspace waiting for a decision, whoever made them. */
  waiting: number;
  /**
   * Of those, the ones past simulation and policy, at PENDING_APPROVAL: what
   * "waiting for approval" means. A SIMULATED proposal is not waiting for an
   * approver yet.
   */
  awaitingApproval: { count: number; soonestCloseMs: number | null };
  /**
   * Of those, the ones this viewer could approve now: past simulation, not
   * their own (Zeke's are exempt from maker-checker), not one they already
   * approved, and only for a role that approves. Null when the membership
   * could not be read.
   */
  forViewer: { waiting: number; soonestCloseMs: number | null } | null;
  /** This person's active governance alerts; null when they could not be read. */
  alerts: number | null;
  /** Of those, the ones Zeke prepared. */
  drafts: number;
  /** Milliseconds until the soonest waiting proposal's window closes. */
  soonestCloseMs: number | null;
  /** What Zeke prepared, newest first, three at most. */
  recent: ZekeRecentItem[];
};

const WAITING: ReadonlySet<ProposalStatus> = new Set(['SIMULATED', 'POLICY_EVALUATED', 'PENDING_APPROVAL']);
const SENT: ReadonlySet<ProposalStatus> = new Set(['SUBMITTED', 'SETTLED', 'ANCHORED']);
const APPROVED: ReadonlySet<ProposalStatus> = new Set(['APPROVED', 'SIGNED']);

const STATE_LABEL: Record<ZekeRecentState, string> = {
  waiting: 'Waiting for approval',
  approved: 'Approved, not sent',
  sent: 'Sent',
  rejected: 'Rejected',
  expired: 'Expired',
  failed: 'Not sent',
  draft: 'Draft',
};

const RECENT_LIMIT = 3;

function closesInMs(proposal: DeskProposal, now: Date): number {
  const at = Date.parse(proposal.expiresAt);
  return Number.isFinite(at) ? at - now.getTime() : Number.POSITIVE_INFINITY;
}

function isWaiting(proposal: DeskProposal, now: Date): boolean {
  return WAITING.has(proposal.status) && closesInMs(proposal, now) > 0;
}

const APPROVER_ROLES: ReadonlySet<UserRole> = new Set(['OWNER', 'FINANCE_ADMIN', 'APPROVER']);

/** The same test the queue's APPROVE applies (lib/queue/approval-queue.ts canActorApprove). */
function viewerCanApprove(proposal: DeskProposal, viewer: DeskViewer): boolean {
  if (proposal.status !== 'PENDING_APPROVAL') return false;
  if (!APPROVER_ROLES.has(viewer.role)) return false;
  if (proposal.createdBy !== AGENT_ACTOR_ID && proposal.createdBy === viewer.userId) return false;
  const approvals = proposal.approvals ?? [];
  if (approvals.some((approval) => approval.userId === viewer.userId)) return false;
  const required = proposal.explain.requiredApprovers ?? 1;
  return new Set(approvals.map((approval) => approval.userId)).size < required;
}

/** A fixed label per kind. An unknown kind is "Proposal", never the raw value. */
function titleOf(proposal: DeskProposal): string {
  const label = kindLabel(String(proposal.kind));
  return label === proposal.kind ? 'Proposal' : label;
}

function soonest(proposals: readonly DeskProposal[], now: Date): number | null {
  const closes = proposals.map((proposal) => closesInMs(proposal, now)).filter(Number.isFinite);
  return closes.length > 0 ? Math.min(...closes) : null;
}

function stateOf(proposal: DeskProposal, now: Date): ZekeRecentState {
  if (WAITING.has(proposal.status)) return closesInMs(proposal, now) > 0 ? 'waiting' : 'expired';
  if (SENT.has(proposal.status)) return 'sent';
  if (APPROVED.has(proposal.status)) return 'approved';
  if (proposal.status === 'REJECTED') return 'rejected';
  if (proposal.status === 'EXPIRED') return 'expired';
  if (proposal.status === 'FAILED') return 'failed';
  return 'draft';
}

/** "Nadia Rahman" → "Nadia". An email address, or a 40-character "word", is not a first name. */
export function firstNameOf(displayName: string | null | undefined): string | null {
  const first = (displayName ?? '').trim().split(/\s+/)[0] ?? '';
  if (!first || first.includes('@') || first.length > 40) return null;
  return first;
}

export function buildZekeDeskSnapshot(input: {
  proposals: readonly DeskProposal[];
  orgId: string | null;
  now: Date;
  displayName: string | null | undefined;
  viewer?: DeskViewer | null;
  alerts?: number | null;
}): ZekeDeskSnapshot {
  const firstName = firstNameOf(input.displayName);
  const alerts = input.alerts ?? null;
  const orgId = input.orgId?.trim() ?? '';
  if (!orgId) {
    return {
      known: false,
      firstName,
      waiting: 0,
      awaitingApproval: { count: 0, soonestCloseMs: null },
      forViewer: null,
      alerts,
      drafts: 0,
      soonestCloseMs: null,
      recent: [],
    };
  }

  const mine = input.proposals.filter((proposal) => proposal.orgId === orgId);
  const waiting = mine.filter((proposal) => isWaiting(proposal, input.now));
  const viewer = input.viewer ?? null;
  const viewerWaiting = viewer ? waiting.filter((proposal) => viewerCanApprove(proposal, viewer)) : null;
  const awaiting = waiting.filter((proposal) => proposal.status === 'PENDING_APPROVAL');

  const recent = mine
    .filter((proposal) => proposal.createdBy === AGENT_ACTOR_ID)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, RECENT_LIMIT)
    .map((proposal) => {
      const state = stateOf(proposal, input.now);
      return { id: proposal.id, title: titleOf(proposal), state, label: STATE_LABEL[state], when: agoLabel(proposal.createdAt, input.now) };
    });

  return {
    known: true,
    firstName,
    waiting: waiting.length,
    awaitingApproval: { count: awaiting.length, soonestCloseMs: soonest(awaiting, input.now) },
    forViewer: viewerWaiting ? { waiting: viewerWaiting.length, soonestCloseMs: soonest(viewerWaiting, input.now) } : null,
    alerts,
    drafts: waiting.filter((proposal) => proposal.createdBy === AGENT_ACTOR_ID).length,
    soonestCloseMs: soonest(waiting, input.now),
    recent,
  };
}

/** "3 minutes ago", "1 hour ago", "Yesterday", "4 days ago". An unreadable time is "Earlier". */
export function agoLabel(at: string, now: Date): string {
  const ms = now.getTime() - Date.parse(at);
  if (!Number.isFinite(ms)) return 'Earlier';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Yesterday' : `${days} days ago`;
}

function payments(count: number): string {
  return count === 1 ? '1 payment' : `${count} payments`;
}

/** The workspace's count, when whose turn it is could not be read. */
function waitingSentence(count: number): string {
  if (count === 0) return 'Nothing is waiting for your approval';
  return `${payments(count)} ${count === 1 ? 'is' : 'are'} waiting for approval`;
}

/** What this viewer can approve, then the rest of the workspace's as context. */
function viewerSentences(mine: number, others: number, closing: string): string {
  const own = mine === 0 ? 'Nothing is waiting for you.' : `${payments(mine)} ${mine === 1 ? 'is' : 'are'} waiting for you${closing}.`;
  if (others === 0) return own;
  const rest = mine === 0 ? payments(others) : `${others} more`;
  return `${own} ${rest} ${others === 1 ? 'is with another approver' : 'are with other approvers'}.`;
}

/**
 * The greeting's and subtitle's count. When the membership was read, it is
 * what this person can approve, with the soonest of those closing; the
 * workspace's other approvals are said as someone else's. When it was not,
 * the workspace's PENDING_APPROVAL count, which is all that can be said.
 */
function queueSentence(snapshot: ZekeDeskSnapshot, withClosing: boolean): string {
  const forViewer = snapshot.forViewer;
  if (forViewer) {
    const soon = withClosing && forViewer.waiting > 0 ? closesSoon(forViewer.soonestCloseMs) : null;
    const closing = soon ? `, and ${forViewer.waiting === 1 ? 'it' : 'one'} closes in ${soon}` : '';
    return viewerSentences(forViewer.waiting, Math.max(0, snapshot.awaitingApproval.count - forViewer.waiting), closing);
  }
  const count = snapshot.awaitingApproval.count;
  const soon = withClosing && count > 0 ? closesSoon(snapshot.awaitingApproval.soonestCloseMs) : null;
  const closing = soon ? `, and ${count === 1 ? 'it' : 'one'} closes in ${soon}` : '';
  return `${waitingSentence(count)}${closing}.`;
}

/** "3 minutes", for a window under an hour; longer windows are not news. */
function closesSoon(ms: number | null): string | null {
  if (ms === null || ms <= 0 || ms >= 60 * 60_000) return null;
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * The limit, in the floating Zeke's first message. The fixed "cannot send"
 * strip went with the 5.3 board, which moves the sentence into the
 * conversation; until the intent classifier says it per request, the
 * greeting does, so nobody can ask the panel to send money without having
 * been told it cannot.
 */
export const ZEKE_LIMIT = 'I can prepare payments for approval, but I can’t approve or send them.';

/** The floating Zeke's first message. Numbers only from a snapshot that was read. */
export function zekeGreeting(snapshot: ZekeDeskSnapshot | null): string {
  const hello = snapshot?.firstName ? `Hi ${snapshot.firstName}.` : 'Hi.';
  const ask = `${ZEKE_LIMIT} What would you like to look at?`;
  if (!snapshot?.known) return `${hello} ${ask}`;
  return `${hello} ${queueSentence(snapshot, true)} ${ask}`;
}

/** The line under "What's on the agenda today?": the queue and the wallet, each only if read. */
export function deskSubtitle(snapshot: ZekeDeskSnapshot | null, walletUsdc: string | null): string {
  const parts: string[] = [];
  if (snapshot?.known) parts.push(queueSentence(snapshot, false));
  if (walletUsdc !== null) parts.push(`Your wallet holds ${walletUsdc} USDC.`);
  return parts.length > 0
    ? parts.join(' ')
    : 'Ask about your money, prepare a payment for approval, or check what needs a decision.';
}
