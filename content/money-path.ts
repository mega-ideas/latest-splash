/**
 * W9.4 — "Where your money sits" trust panel content.
 *
 * ONE config drives every mount of components/compliance/MoneyPathPanel.tsx
 * (treasury, funding flow, receipt verify link) so partner labels and license
 * status update in exactly one place.
 *
 * CLAIMS RULES:
 * - `REQUIRED_HONESTY_SENTENCE` is locked copy and may NOT be paraphrased;
 *   scripts/check-copy.mjs fails the build if it disappears from this file.
 * - Disclosure policy D5: in-product surfaces show GENERIC partner labels
 *   ("Licensed payout partner · PHP"). A partner's legal name is shown only on
 *   receipts, to the transaction parties, via `legalName`. Never add a partner
 *   that has not signed, and never upgrade the license language without 0xSky.
 */

export const MONEY_PATH_HEADER = 'Splash orchestrates — we never hold your funds.';

export const REQUIRED_HONESTY_SENTENCE =
  'Labuan FSA license in process. Splash is not yet a licensed money-services business.';

export type MoneyPathStep = {
  /** Generic partner label for in-product display (or Splash itself for the orchestration step). */
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

export type PayoutRail = {
  /** In-product display label. Generic by policy; never a legal name. */
  name: string;
  /** Legal name, receipt fine print only (transaction parties). Empty until signed. */
  legalName: string;
  /** ISO currency the rail delivers. */
  currency: 'PHP' | 'IDR';
  active: boolean;
};

/** Payout rails per corridor — render the ACTIVE one for each currency. When a
 *  rail goes live, flip `active` here and every mount updates. Corridors launch
 *  in a staggered order: first-ready first. */
export const PH_PAYOUT_RAILS: PayoutRail[] = [
  { name: 'Licensed payout partner · PHP', legalName: '', currency: 'PHP', active: true },
];

export const ID_PAYOUT_RAILS: PayoutRail[] = [
  { name: 'Licensed payout partner · IDR', legalName: '', currency: 'IDR', active: true },
];

const activePhRail = PH_PAYOUT_RAILS.find((rail) => rail.active) ?? PH_PAYOUT_RAILS[0];
const activeIdRail = ID_PAYOUT_RAILS.find((rail) => rail.active) ?? ID_PAYOUT_RAILS[0];

export const MONEY_PATH_STEPS: MoneyPathStep[] = [
  {
    partner: 'Licensed collection partner · USD',
    role: 'Collection',
    detail: 'Your USD arrives into partner-held accounts.',
    splashIsParty: false,
  },
  // The conversion hop previously named a venue that is not a partner of record.
  // Per this file's own rule — "never add a partner that has not signed" — it is
  // removed rather than relabelled. Do not reinstate a conversion step until a
  // signed venue exists, and route it past 0xSky when it does.
  {
    partner: activePhRail.name,
    role: 'PHP payout',
    detail: 'Licensed local rail delivers to your supplier in the Philippines.',
    splashIsParty: false,
  },
  {
    partner: activeIdRail.name,
    role: 'IDR payout',
    detail: 'Licensed local rail delivers to your supplier in Indonesia.',
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
