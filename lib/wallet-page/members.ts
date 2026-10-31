/**
 * People on the Wallet page (v2 brief 5.5): names, roles, and who may be put
 * in charge of signing off a staff member's move to the business wallet.
 * Pure and client-safe.
 */

/** `hasPasskey` is sent to an owner only, with the people to choose from: a rule is given to a passkey on this site, so who has none matters before the last question. */
export type Member = { userId: string; name: string; role: string; hasPasskey?: boolean };

const ROLES: Record<string, string> = { admin: 'Owner', maker: 'Staff', checker: 'Approver', viewer: 'Viewer' };

export function roleLabel(role: string): string {
  return ROLES[role] ?? 'Member';
}

/**
 * The person in charge is a role an owner gives to a member who makes or
 * approves payments (lib/server/wallet-authority.ts `highestAuthority`): an
 * owner has the authority already and a viewer never does.
 */
export function personsInChargeView(members: Member[], current: Array<{ userId: string }>): { inCharge: Member[]; candidates: Member[] } {
  const charged = new Set(current.map((c) => c.userId));
  const eligible = members.filter((m) => m.role === 'maker' || m.role === 'checker');
  return { inCharge: eligible.filter((m) => charged.has(m.userId)), candidates: eligible.filter((m) => !charged.has(m.userId)) };
}
