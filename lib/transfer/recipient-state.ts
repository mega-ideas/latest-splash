/**
 * Whether a saved recipient can be paid from Transfer now, and if not, why in
 * words (the page shows the reason; the server refuses the same cases, so
 * this only saves a round trip). Pure and client-safe.
 */
export type RecipientFacts = {
  deliveryKind: 'BANK' | 'EXCHANGE' | 'SELF_CUSTODY' | 'CROSS_CHAIN';
  ownershipStatus?: string | null;
  screeningVerdict?: string | null;
};

export function blockedReason(r: RecipientFacts): string | null {
  if (r.deliveryKind === 'BANK') return 'A bank account is paid from “A business bank account”.';
  if (r.deliveryKind === 'CROSS_CHAIN') return 'USDC to another chain is not switched on for your business yet, so it cannot be paid from here.';
  if (r.screeningVerdict === 'BLOCK') return 'This address did not pass screening, so it cannot be paid.';
  if (r.deliveryKind === 'SELF_CUSTODY' && r.ownershipStatus !== 'proven') {
    return 'The supplier has not yet proven they hold this wallet. Send them the proof link from Recipients; you can pay it once they have signed.';
  }
  return null;
}
