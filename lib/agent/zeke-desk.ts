import { AGENT_ACTOR_ID } from '@/lib/agent/identity';
import type { ProposalStatus } from '@/lib/agent/types';

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
 * transaction bytes or approval hashes leave the store through it.
 */

/** A proposal as far as the desk needs it. */
export type DeskProposal = {
  id: string;
  orgId: string;
  status: ProposalStatus;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  explain: { recommendation: string };
};

export type ZekeRecentState = 'waiting' | 'approved' | 'sent' | 'rejected' | 'expired' | 'failed' | 'draft';

export type ZekeRecentItem = { id: string; title: string; state: ZekeRecentState; label: string };

export type ZekeDeskSnapshot = {
  /** False when the workspace could not be read: then every count is 0 and means nothing. */
  known: boolean;
  firstName: string | null;
  /** Proposals in this workspace waiting for a decision, whoever made them. */
  waiting: number;
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
}): ZekeDeskSnapshot {
  const firstName = firstNameOf(input.displayName);
  const orgId = input.orgId?.trim() ?? '';
  if (!orgId) return { known: false, firstName, waiting: 0, drafts: 0, soonestCloseMs: null, recent: [] };

  const mine = input.proposals.filter((proposal) => proposal.orgId === orgId);
  const waiting = mine.filter((proposal) => isWaiting(proposal, input.now));
  const closes = waiting.map((proposal) => closesInMs(proposal, input.now)).filter(Number.isFinite);

  const recent = mine
    .filter((proposal) => proposal.createdBy === AGENT_ACTOR_ID)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, RECENT_LIMIT)
    .map((proposal) => {
      const state = stateOf(proposal, input.now);
      return { id: proposal.id, title: proposal.explain.recommendation, state, label: STATE_LABEL[state] };
    });

  return {
    known: true,
    firstName,
    waiting: waiting.length,
    drafts: waiting.filter((proposal) => proposal.createdBy === AGENT_ACTOR_ID).length,
    soonestCloseMs: closes.length > 0 ? Math.min(...closes) : null,
    recent,
  };
}

function waitingSentence(count: number): string {
  if (count === 0) return 'Nothing is waiting for your approval';
  return count === 1 ? '1 payment is waiting for approval' : `${count} payments are waiting for approval`;
}

/** "3 minutes", for a window under an hour; longer windows are not news. */
function closesSoon(ms: number | null): string | null {
  if (ms === null || ms <= 0 || ms >= 60 * 60_000) return null;
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** The floating Zeke's first message. Numbers only from a snapshot that was read. */
export function zekeGreeting(snapshot: ZekeDeskSnapshot | null): string {
  const hello = snapshot?.firstName ? `Hi ${snapshot.firstName}.` : 'Hi.';
  const ask = 'What would you like to look at?';
  if (!snapshot?.known) return `${hello} ${ask}`;
  const soon = snapshot.waiting > 0 ? closesSoon(snapshot.soonestCloseMs) : null;
  const closing = soon ? `, and ${snapshot.waiting === 1 ? 'it' : 'one'} closes in ${soon}` : '';
  return `${hello} ${waitingSentence(snapshot.waiting)}${closing}. ${ask}`;
}

/** The line under "What's on the agenda today?": the queue and the wallet, each only if read. */
export function deskSubtitle(snapshot: ZekeDeskSnapshot | null, walletUsdc: string | null): string {
  const parts: string[] = [];
  if (snapshot?.known) parts.push(`${waitingSentence(snapshot.waiting)}.`);
  if (walletUsdc !== null) parts.push(`Your wallet holds ${walletUsdc} USDC.`);
  return parts.length > 0
    ? parts.join(' ')
    : 'Ask about your money, prepare a payment for approval, or check what needs a decision.';
}
