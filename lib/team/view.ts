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

/** What GET /api/team answers. `members` and `activity` go to a manager only. */
export type TeamWire = {
  you: { userId: string; role: MembershipRole | null; manager: Manager; addFunds: boolean; withdraw: boolean };
  members: TeamMemberWire[];
  activity: TeamActivityWire[];
};

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
      'Add a person to the team and choose whether they are a viewer, staff or an approver.',
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
      'Take back a spending rule. A person moved to viewer or removed keeps the rule they hold until the owners revoke it.',
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
    default:
      return `${e.actorName} changed the team.`;
  }
}
