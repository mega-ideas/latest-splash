/**
 * What Settings → Team offers each person, what the Wallet page, Transfer and
 * Home offer about Add funds and Withdraw, and the words for both (v2 Phase 3).
 *
 * Pure and client-safe. The server decides (lib/server/team-admin.ts); this
 * only decides what to OFFER, and offers nothing the server would refuse. A
 * button that is not here cannot be pressed, and one that is still meets the
 * same server rule.
 */
import type { MembershipRole } from '../membership-roles.ts';

export const FINANCE_LEAD_NAME = 'Finance lead';

export type Manager = 'owner' | 'finance_lead' | null;
export type FundsAccessKind = 'add_funds' | 'withdraw';

/** One person on the team, as the team route sends it to someone who manages the team. */
export type TeamMemberWire = {
  userId: string;
  name: string;
  email: string;
  role: MembershipRole;
  financeLead: boolean;
  inCharge: boolean;
  addFunds: boolean;
  withdraw: boolean;
};

export type TeamActivityWire = { id: string; action: string; createdAt: string; actorName: string; subjectName: string | null; summary: string };

/** One open invitation, as a manager sees it. The full address is here; the trail keeps only a masked one. */
export type InvitationWire = { id: string; email: string; role: MembershipRole; invitedByName: string; createdAt: string; expiresAt: string; canWithdraw: boolean };

/** One open request to leave, as a manager sees it, with whether this manager may decide it. */
export type LeaveRequestWire = { id: string; userId: string; name: string; email: string; role: MembershipRole; createdAt: string; canDecide: boolean; whyNot: string | null };

/** The signed-in person's own leave state. `message` is the sentence to show. */
export type LeaveStatusWire = {
  state: 'none' | 'pending' | 'declined';
  canRequest: boolean;
  message: string | null;
  requestedAt: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
};

/** What GET /api/team answers. `members`, `activity`, `invitations` and `leaveRequests` go to a manager only. */
export type TeamWire = {
  you: { userId: string; role: MembershipRole | null; manager: Manager; addFunds: boolean; withdraw: boolean };
  members: TeamMemberWire[];
  activity: TeamActivityWire[];
  invitations: InvitationWire[];
  leaveRequests: LeaveRequestWire[];
  leave: LeaveStatusWire;
};

/** An invitation as the invited person sees it after signing in. Never names any other business. */
export type MyInvitationWire = {
  id: string;
  businessName: string;
  role: MembershipRole;
  invitedByName: string;
  /** The sender's address, masked ("d***@acme.com"): enough to tell a real sender from a look-alike name, never the address. */
  invitedByEmailMask: string;
  expiresAt: string;
  canAccept: boolean;
  blockedReason: string | null;
};

/** How long an invitation stays open, in days. The server's INVITATION_TTL_MS is this many days. */
export const INVITATION_DAYS = 7;

/** How long a person's own page keeps saying that a request to leave was declined. They can ask again at any time. */
export const LEAVE_DECLINED_SHOWN_DAYS = 14;

/** A date that cannot be read two ways ("8 Nov 2026"), for LocalTime. */
export const PLAIN_DATE = { day: 'numeric', month: 'short', year: 'numeric' } as const;

/** "a***@example.com": enough to recognise, never the address. The trail is append-only, so it keeps only this. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}${'*'.repeat(Math.min(Math.max(at - 1, 1), 6))}${email.slice(at)}`;
}

/** The answer when the invited person already belongs to a business. It names no business. */
export const ON_A_BUSINESS =
  'You already belong to a business, and a person can belong to one business at a time. You cannot accept this invitation. You can decline it.';

/** How the owner chooses between the two ways to add someone, in plain words. */
export const ADD_CHOICES = {
  invite: {
    title: 'Send an invitation',
    body: 'They see it after they sign in and choose to accept or decline. It ends after 7 days, and you can withdraw it before then.',
    action: 'Send invitation',
  },
  direct: {
    title: 'Add directly',
    body: 'They join straight away, with no step on their side. Choose this only when you are sure of the person.',
    action: 'Add to team',
    confirm: 'I have checked that this is the right person.',
  },
} as const;

/**
 * May this manager decide this person's request to leave? The server and the
 * page use this one rule. Sky's decision: a member cannot leave without the
 * approval of the highest authority, an owner. Nobody decides their own, and
 * the Finance lead decides none: approving ends access at once but cannot take
 * the person's spending rule back (the wallet's owners sign that), so a lead's
 * approval would leave a live rule behind. The lead still sees every request.
 */
export type LeaveDecisionRefusal = 'not_a_manager' | 'own_request' | 'owner_only';
export function leaveDecisionRefusal(ctx: {
  manager: Manager;
  actorUserId: string;
  leaver: Pick<TeamMemberWire, 'userId'>;
}): LeaveDecisionRefusal | null {
  if (!ctx.manager) return 'not_a_manager';
  if (ctx.leaver.userId === ctx.actorUserId) return 'own_request';
  if (ctx.manager === 'owner') return null;
  return 'owner_only';
}

/** Said next to a request the signed-in manager may not decide. */
export const LEAVE_WHY_NOT: Record<LeaveDecisionRefusal, string> = {
  not_a_manager: 'Only an owner decides.',
  own_request: 'Another owner decides your own request.',
  owner_only: 'Only an owner decides a request to leave.',
};

// ─── What follows an owner's approval ───────────────────────────────────────

/** Whether the person's spending rule was taken back: a request opened, nothing to take back, or it could not be opened. */
export type RuleRevoke = 'opened' | 'none' | 'not_opened';
/** Whether the person still signs for the business wallet. 'unknown' when the chain or the wallet could not be read. */
export type SignerState = 'still_signer' | 'not_a_signer' | 'unknown';

/**
 * What an owner is told, in words, once a person has left: what became of the
 * spending rule, and that leaving the team does not remove a signer (the
 * wallet's owners change the signers, signing on their own devices).
 */
export function leaveFollowUpNote(o: { rules: RuleRevoke; signer: SignerState }): string {
  const rule =
    o.rules === 'opened'
      ? 'Their spending rule is being taken back. The owners sign that request on their own devices; until they do, the rule still exists on the chain.'
      : o.rules === 'none'
        ? 'They held no spending rule, so there is nothing to take back.'
        : 'Their spending rule could not be taken back automatically. If they held one, an owner takes it back under Spending rules in Settings, where it shows as belonging to a former member.';
  const signer =
    o.signer === 'still_signer'
      ? 'They are still a signer on the business wallet and can co-sign its requests from their own device. Changing the signers is a separate request the owners sign.'
      : o.signer === 'unknown'
        ? 'If they signed for the business wallet, they still do. Changing the signers is a separate request the owners sign.'
        : '';
  return [rule, signer].filter(Boolean).join(' ');
}

/** The sentence a person reads about their own request to leave. */
export function leaveSentence(state: 'none' | 'pending' | 'declined', decidedBy?: string | null): string | null {
  if (state === 'pending') return 'Your request to leave is with the owners. You keep your access, and any spending rule you hold, until an owner approves it.';
  if (state === 'declined') return `${decidedBy ?? 'An owner'} declined your request to leave. You are still on the team, with the same access as before. You can ask again.`;
  return null;
}

/** Said to the only owner of a business, who cannot ask to leave. */
export const LAST_OWNER_SENTENCE = 'You are the only owner, so you cannot ask to leave. Make someone else an owner first, then ask.';

/** The four roles in the words a customer uses. */
export const ROLE_NAME: Record<MembershipRole, string> = { viewer: 'Viewer', maker: 'Staff', checker: 'Approver', admin: 'Owner' };

/** What each role can do, in a sentence. */
export const ROLE_SENTENCE: Record<MembershipRole, string> = {
  viewer: 'Reads the workspace and changes nothing.',
  maker: 'Prepares payments and pays within the rule they hold. Anything above it goes to the owners.',
  checker: 'Approves payments, and prepares them like staff. Can be made the Finance lead.',
  admin: 'Full authority in the workspace, including Add funds and Withdraw. Signs for the wallet once added as a signer.',
};

const ALL_ROLES: readonly MembershipRole[] = ['viewer', 'maker', 'checker', 'admin'];
const BELOW_OWNER: readonly MembershipRole[] = ['viewer', 'maker', 'checker'];

/**
 * What moving someone to this role ends, said before it is saved. Only a move
 * to viewer or owner ends anything; the words also say what does NOT end: a
 * spending rule lives on the chain, so it stays valid until the owners take it back.
 */
export function roleChangeNote(role: MembershipRole): string | null {
  if (role === 'viewer') {
    return `Moving someone to viewer ends their place in charge, the ${FINANCE_LEAD_NAME} role and any Add funds or Withdraw access they hold. A spending rule they already hold stays valid until the owners take it back; it shows under their name until then.`;
  }
  if (role === 'admin') {
    return `An owner already has Add funds and Withdraw, so any place in charge, ${FINANCE_LEAD_NAME} role or access they held ends. A spending rule they hold stays as it is.`;
  }
  return null;
}

/** The roles a manager may give. */
export function roleChoicesFor(manager: Manager): MembershipRole[] {
  if (manager === 'owner') return [...ALL_ROLES];
  if (manager === 'finance_lead') return [...BELOW_OWNER];
  return [];
}

export type RowControls = {
  roles: MembershipRole[];
  remove: boolean;
  /** Add funds and Withdraw switches: an owner's to give, to staff and approvers. */
  access: boolean;
  financeLead: 'appoint' | 'take_back' | null;
};

const NONE: RowControls = { roles: [], remove: false, access: false, financeLead: null };

/** Is this staff member or approver in charge of sign-offs, or granted Add funds or Withdraw? Only an owner moves or removes them. */
export function holdsGrantedAuthority(row: Pick<TeamMemberWire, 'role' | 'inCharge' | 'addFunds' | 'withdraw'>): boolean {
  return row.role !== 'admin' && row.role !== 'viewer' && (row.inCharge || row.addFunds || row.withdraw);
}

/** What the signed-in manager is offered on one person's row. */
export function rowControls(ctx: { manager: Manager; youUserId: string }, row: Pick<TeamMemberWire, 'userId' | 'role' | 'financeLead' | 'inCharge' | 'addFunds' | 'withdraw'>): RowControls {
  if (!ctx.manager || row.userId === ctx.youUserId) return NONE;
  if (ctx.manager === 'finance_lead') {
    // Never an owner, and never someone an owner put in charge or gave Add funds or Withdraw: ending that is the owners'.
    if (row.role === 'admin' || holdsGrantedAuthority(row)) return NONE;
    return { roles: roleChoicesFor('finance_lead'), remove: true, access: false, financeLead: null };
  }
  return {
    roles: roleChoicesFor('owner'),
    remove: true,
    access: row.role === 'maker' || row.role === 'checker',
    financeLead: row.financeLead ? 'take_back' : row.role === 'checker' ? 'appoint' : null,
  };
}

/** What the Finance lead can and cannot do, in the words a customer reads. */
export function financeLeadWords(): { can: string[]; cannot: string[]; chain: string } {
  return {
    can: [
      'Send an invitation to a person, or add them directly, and choose whether they are a viewer, staff or an approver.',
      'Withdraw an invitation for a viewer, staff member or approver.',
      'See requests to leave. An owner decides them.',
      'Change the role of a viewer, a staff member or an approver, and remove one.',
      'Start a request to add a signer to the business wallet, for a person an owner has already made an owner.',
      'Sign a wallet request only when they are one of the wallet’s signers. The role adds no signing power.',
    ],
    cannot: [
      'Make anyone an owner, or change or remove an owner.',
      'Change the wallet signers, or how many signatures are needed.',
      'Add or remove a bank account.',
      'Give or take away Add funds and Withdraw access, their own included.',
      'Change spending rules or limits, their own included.',
      'Put someone in charge of sign-offs, or change or take back this role.',
      'Change or remove someone who is in charge of sign-offs or who can add funds or withdraw. An owner does that, and takes the access back first.',
      'Approve or decline a request to leave. An owner decides every one, and no one decides their own.',
      'Take back a spending rule. A person moved to viewer, removed or allowed to leave keeps the rule they hold until the owners revoke it.',
    ],
    chain:
      'Nothing about the business wallet changes on the chain. Its owners’ signers control it: when a signer is added, the owners sign that request on their own devices and read exactly what it does first. The Finance lead can start the request. Splash holds no key.',
  };
}

/** What a member is shown about Add funds and Withdraw. Unknown access offers nothing. */
export function walletActions(access: { addFunds: boolean; withdraw: boolean } | null | undefined): { addFunds: boolean; withdraw: boolean; notice: string | null } {
  if (!access) return { addFunds: false, withdraw: false, notice: null };
  const none = !access.addFunds && !access.withdraw;
  return {
    addFunds: access.addFunds,
    withdraw: access.withdraw,
    notice: none ? 'Adding funds and withdrawing are turned on by an owner. Ask an owner to give you access in Settings.' : null,
  };
}

/**
 * Said to owners in Settings, Team (Sky's decision): staff and approvers who were already on the team start
 * without Add funds and Withdraw, and nothing is granted for them. An owner turns each on under Manage.
 */
export const EXISTING_MEMBERS_FUNDS_NOTE = 'Staff and approvers who were already on the team do not have Add funds or Withdraw until an owner turns them on, one person at a time, under Manage.';

/** Said where a member without Add funds would otherwise be offered a top-up. */
export const ADD_FUNDS_ASK = 'Adding funds is turned on by an owner. Ask an owner to add funds, or to give you access in Settings.';

// ─── The activity line ──────────────────────────────────────────────────────

const A_ROLE: Record<string, string> = { viewer: 'a viewer', maker: 'staff', checker: 'an approver', admin: 'an owner' };
const BARE_ROLE: Record<string, string> = { viewer: 'viewer', maker: 'staff', checker: 'approver', admin: 'owner' };

/** "an approver", "staff", "a viewer", "an owner". */
export function roleWithArticle(role: string): string {
  return A_ROLE[role] ?? 'a member';
}

export const TEAM_ACTIONS = [
  'member_added',
  'member_role_changed',
  'member_removed',
  'finance_lead_appointed',
  'finance_lead_revoked',
  'member_access_granted',
  'member_access_revoked',
  'person_in_charge_appointed',
  'person_in_charge_revoked',
  'team_invitation_sent',
  'team_invitation_accepted',
  'team_invitation_declined',
  'team_invitation_withdrawn',
  'team_invitation_expired',
  'leave_requested',
  'leave_withdrawn',
  'leave_approved',
  'leave_declined',
  'leave_follow_up',
] as const;

/** One trail line in plain words: who did what to whom. */
export function activitySummary(e: { action: string; detail: unknown; actorName: string; subjectName: string | null }): string {
  const d = (e.detail && typeof e.detail === 'object' ? e.detail : {}) as Record<string, unknown>;
  const who = e.subjectName ?? 'a member';
  switch (e.action) {
    case 'member_added':
      return `${e.actorName} added ${who} as ${A_ROLE[String(d.role)] ?? 'a member'}.`;
    case 'member_role_changed':
      return `${e.actorName} changed ${who} from ${BARE_ROLE[String(d.from)] ?? 'a role'} to ${BARE_ROLE[String(d.to)] ?? 'another role'}.`;
    case 'member_removed':
      return `${e.actorName} removed ${who}${d.role ? ` (${A_ROLE[String(d.role)] ?? 'a member'})` : ''}.`;
    case 'finance_lead_appointed':
      return `${e.actorName} made ${who} the ${FINANCE_LEAD_NAME}.`;
    case 'finance_lead_revoked':
      return `${e.actorName} took the ${FINANCE_LEAD_NAME} role back from ${who}.`;
    case 'member_access_granted':
      return `${e.actorName} let ${who} ${d.access === 'withdraw' ? 'withdraw' : 'add funds'}.`;
    case 'member_access_revoked':
      return `${e.actorName} stopped ${who} ${d.access === 'withdraw' ? 'withdrawing' : 'adding funds'}.`;
    case 'person_in_charge_appointed':
      return `${e.actorName} put ${who} in charge of signing off moves.`;
    case 'person_in_charge_revoked':
      return `${e.actorName} took ${who} out of charge of signing off moves.`;
    case 'team_invitation_sent':
      return `${e.actorName} invited ${String(d.emailMask ?? 'a person')} as ${A_ROLE[String(d.role)] ?? 'a member'}.`;
    case 'team_invitation_accepted':
      return `${e.actorName} accepted the invitation and joined as ${A_ROLE[String(d.role)] ?? 'a member'}.`;
    case 'team_invitation_declined':
      return `${e.actorName} declined the invitation to join as ${A_ROLE[String(d.role)] ?? 'a member'}.`;
    case 'team_invitation_withdrawn':
      return d.reason === 'inviter_no_longer_manages'
        ? `The invitation to ${String(d.emailMask ?? 'a person')} was closed because the person who sent it no longer manages the team.`
        : d.reason === 'added_directly'
          ? `The invitation to ${String(d.emailMask ?? 'a person')} was closed because ${e.actorName} added them directly.`
          : `${e.actorName} withdrew the invitation to ${String(d.emailMask ?? 'a person')}.`;
    case 'team_invitation_expired':
      return `The invitation to ${String(d.emailMask ?? 'a person')} ended after ${INVITATION_DAYS} days without an answer.`;
    case 'leave_requested':
      return `${e.actorName} asked to leave the team.`;
    case 'leave_withdrawn':
      return `${e.actorName} withdrew their request to leave.`;
    case 'leave_approved':
      return `${e.actorName} approved ${who}’s request to leave. ${who} no longer has access.`;
    case 'leave_declined':
      return `${e.actorName} declined ${who}’s request to leave. ${who} is still on the team.`;
    case 'leave_follow_up': {
      const rules = d.rules === 'opened' || d.rules === 'none' ? d.rules : 'not_opened';
      const signer = d.signer === 'still_signer' || d.signer === 'not_a_signer' ? d.signer : 'unknown';
      return `After ${who} left: ${leaveFollowUpNote({ rules, signer })}`;
    }
    default:
      return `${e.actorName} changed the team.`;
  }
}
