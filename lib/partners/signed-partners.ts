/**
 * Which partners may be named in shipped copy (brief §0.8, §3.9).
 *
 * A partner is named to a customer only once its agreement is signed. Until
 * then the product describes the role ("our Philippines payout partner"),
 * never the company. The list of signed partners is server-side configuration,
 * `SIGNED_PARTNERS` (comma-separated ids from `PARTNERS` below), and it is
 * EMPTY by default: a fresh deployment names nobody.
 *
 * Every surface that would show a partner's name asks `partnerLabel(id)`,
 * which returns the name only when the partner is signed and the role
 * otherwise. Hard-coding a partner's name in copy bypasses this, and the
 * landing and dashboard rebuilds (Phases 3 and 4) move every existing mention
 * onto it.
 */

/** Every partner the brief's decisions name (D4, D5, D7, D8, D9). */
export const PARTNERS = {
  pdax: { name: 'PDAX', role: 'our Philippines payout partner' },
  durianpay: { name: 'DurianPay', role: 'our Indonesia payout partner' },
  hata: { name: 'Hata', role: 'our Malaysia exchange partner' },
  fiuu: { name: 'Fiuu', role: 'our Malaysia bank-transfer partner' },
  tokocrypto: { name: 'Tokocrypto', role: 'an Indonesia exchange' },
  bitkub: { name: 'Bitkub', role: 'a Thailand exchange' },
  halliday: { name: 'Halliday', role: 'a funding partner' },
  stripe: { name: 'Stripe', role: 'a card funding partner' },
  transfi: { name: 'TransFi', role: 'a funding partner' },
  bridge: { name: 'Bridge', role: 'a funding partner' },
  sumsub: { name: 'Sumsub', role: 'our identity verification partner' },
  elliptic: { name: 'Elliptic', role: 'our transaction screening partner' },
  halogen: { name: 'Halogen', role: 'a fund manager' },
  ondo: { name: 'Ondo', role: 'a tokenized treasury issuer' },
} as const satisfies Record<string, { name: string; role: string }>;

export type PartnerId = keyof typeof PARTNERS;

export const PARTNER_IDS = Object.keys(PARTNERS) as PartnerId[];

export function isPartnerId(value: string): value is PartnerId {
  return Object.hasOwn(PARTNERS, value);
}

/**
 * Parse a `SIGNED_PARTNERS` value. Blank means none. An unknown id is an
 * error, not a skip: a typo would otherwise leave a signed partner unnamed and
 * nobody would notice, and a list that silently drops entries is not the list
 * that was configured.
 */
export function parseSignedPartners(raw: string | undefined): ReadonlySet<PartnerId> {
  const ids = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = ids.filter((id) => !isPartnerId(id));
  if (unknown.length > 0) {
    throw new Error(`SIGNED_PARTNERS names partners Splash does not know: ${unknown.join(', ')}. Known: ${PARTNER_IDS.join(', ')}.`);
  }
  return new Set(ids as PartnerId[]);
}

/** The name when the partner is signed; the role otherwise. */
export function partnerLabel(id: PartnerId, signed: ReadonlySet<PartnerId>): string {
  return signed.has(id) ? PARTNERS[id].name : PARTNERS[id].role;
}

/** Whether a partner may be named in copy. */
export function mayName(id: PartnerId, signed: ReadonlySet<PartnerId>): boolean {
  return signed.has(id);
}
