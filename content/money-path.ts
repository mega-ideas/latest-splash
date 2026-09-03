/**
 * W9.4 — "Where your money sits" trust panel content.
 *
 * ONE config drives every mount of components/compliance/MoneyPathPanel.tsx
 * (treasury, funding flow, receipt verify link) so partner names and license
 * status update in exactly one place.
 *
 * CLAIMS RULES:
 * - `REQUIRED_HONESTY_SENTENCE` is locked copy and may NOT be paraphrased;
 *   scripts/check-copy.mjs fails the build if it disappears from this file.
 * - Partner names here are partners of record — never add a partner that has
 *   not signed, and never upgrade the license language without 0xSky.
 */

export const MONEY_PATH_HEADER = 'Splash orchestrates — we never hold your funds.';

export const REQUIRED_HONESTY_SENTENCE =
  'Labuan FSA license in process. Splash is not yet a licensed money-services business.';

export type MoneyPathStep = {
  /** Partner of record (or Splash itself for the orchestration step). */
  partner: string;
  /** What this hop does with the money, in operator language. */
  role: string;
  /** One-line detail below the role. */
  detail: string;
  /**
   * Is Splash a party to the money at this hop?
   *
   * The header claim is "Splash orchestrates — we never hold your funds", and
   * this field is what makes that claim checkable rather than rhetorical: it
   * must be `true` on exactly ONE step (orchestration), and that step must move
   * no money. `tests/money-path.test.mjs` asserts the count, so adding a hop
   * where Splash touches client funds fails the build instead of quietly
   * contradicting the panel above it.
   */
  splashIsParty: boolean;
};

/** PHP payout rails — render the ACTIVE one. Per this file's own rule above,
 *  a rail is listed only once it is a partner of record. An inactive entry is
 *  still a published name the moment someone flips the boolean, so unsigned
 *  rails do not sit here waiting. Add the next rail when it signs. */
export const PH_PAYOUT_RAILS = [
  { name: 'PDAX · via GCash', active: true },
] as const;

const activePhRail = PH_PAYOUT_RAILS.find((rail) => rail.active) ?? PH_PAYOUT_RAILS[0];

export const MONEY_PATH_STEPS: MoneyPathStep[] = [
  {
    partner: 'Airwallex',
    role: 'Collection',
    detail: 'Your USD arrives into partner-held accounts.',
    splashIsParty: false,
  },
  // The conversion hop previously named a venue that is not a partner of record.
  // Per this file's own rule — "never add a partner that has not signed" — it is
  // removed rather than relabelled. Do not reinstate a conversion step until a
  // signed venue exists to name, and route it past 0xSky when it does.
  {
    partner: activePhRail.name,
    role: 'PHP payout',
    detail: 'Licensed local rail delivers to your supplier.',
    splashIsParty: false,
  },
  {
    partner: 'Splash',
    role: 'Orchestrates and proves',
    detail: REQUIRED_HONESTY_SENTENCE,
    // The ONLY step where Splash is a party — and it moves no money. This is
    // the header claim, expressed as data.
    splashIsParty: true,
  },
];
