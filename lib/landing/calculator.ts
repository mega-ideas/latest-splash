/**
 * The landing calculator's arithmetic, kept apart from the component so the
 * rows it shows can be checked to add up (v2 code review E2).
 *
 * A bank payout from the Splash Wallet:
 *   debit      = amount + Splash fee           (Splash's fee is added on top)
 *   converted  = amount - partner fee          (the partner's fee comes out
 *                                               of what it converts)
 * so the reader can see both sums on the card. A wallet payment has no
 * partner leg: nothing is converted and there is no partner fee.
 */

export type CalculatorMode = 'bank' | 'wallet';

export type SettlementLines = {
  principalMinor: bigint;
  splashFeeMinor: bigint;
  partnerFeeMinor: bigint | null;
  convertedMinor: bigint | null;
  debitMinor: bigint;
};

export function settlementLines(input: {
  mode: CalculatorMode;
  principalMinor: bigint;
  splashFeeMinor: bigint;
  partnerFeeMinor: bigint | null;
}): SettlementLines {
  const partnerFeeMinor = input.mode === 'bank' ? input.partnerFeeMinor : null;
  const convertedMinor = partnerFeeMinor === null ? null : input.principalMinor - partnerFeeMinor;
  return {
    principalMinor: input.principalMinor,
    splashFeeMinor: input.splashFeeMinor,
    partnerFeeMinor,
    convertedMinor,
    debitMinor: input.principalMinor + input.splashFeeMinor,
  };
}

/**
 * How long the partner's rate still holds, from its own TTL and the time since
 * the quote arrived. At zero the rate is expired and the chip says so; the
 * component asks again only while the calculator is on screen.
 */
export function rateChip(quote: { ttlSeconds: number }, elapsedMs: number): { state: 'held' | 'expired'; secondsLeft: number } {
  const secondsLeft = Math.max(0, Math.ceil(quote.ttlSeconds - elapsedMs / 1000));
  return secondsLeft > 0 ? { state: 'held', secondsLeft } : { state: 'expired', secondsLeft: 0 };
}

/** A rate as the partner sent it, with its whole part grouped: "16,250", "56.5". */
export function formatRate(rate: string): string {
  const [whole, fraction] = rate.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}
