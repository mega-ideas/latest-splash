/**
 * How Transfer sends a payment, and what it does when the server turns a staff
 * member away from paying alone. Pure and client-safe.
 *
 * A page that says "within your spending rule" asks to pay alone (`via: 'rule'`)
 * so a stale page is refused in words and never quietly sends the owners a
 * request. Every one of those refusals stores nothing, so the same intent id
 * can be sent again as a request to the owners (`via: 'ask'`): the person is
 * never left on a button the server keeps refusing.
 */

export type SendVia = 'rule' | 'ask' | undefined;

/** The codes (with their status) the server answers a staff payment with when it will not be paid alone but the owners can still be asked. */
const ASKABLE: Array<[number, string]> = [
  [409, 'outside_rule'],
  [409, 'no_passkey_for_rule'],
  [503, 'staff_rule_unavailable'],
  [503, 'no_sponsor'],
  [502, 'rule_unreadable'],
  [429, 'staff_gas_share_used'],
  // Paying an exchange account alone needs the Travel Rule provider and a verified business: where either is missing the owners can still be asked.
  [503, 'travel_rule_not_configured'],
  [409, 'originator_incomplete'],
  [409, 'kyb_not_approved'],
  [409, 'kyb_applicant_missing'],
];

export function refusalAsksOwners(status: number, code: string | undefined): boolean {
  return ASKABLE.some(([s, c]) => s === status && c === code);
}

/** What to send as `via`: a payment the page planned under the rule asks to pay alone, until the server has refused it; then it asks the owners. */
export function viaFor(route: string | undefined, askInstead: boolean): SendVia {
  if (askInstead) return 'ask';
  return route === 'staff_rule' ? 'rule' : undefined;
}
