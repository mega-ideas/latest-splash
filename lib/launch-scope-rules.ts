/**
 * The launch scope, with no I/O.
 *
 * Splash can open for USDC on Sui alone (LAUNCH_SCOPE=stablecoin): the
 * wallet-to-wallet lane and x402, which the business's own wallet signs.
 * Everything that moves or records fiat, runs Splash's own settlement or
 * touches the treasury is refused in that scope, because those paths are
 * not connected to real partners yet (docs/GO-LIVE-HANDOVER.md).
 *
 * lib/server/launch-scope.ts reads the setting; what it means for a lane or
 * a proposal kind, and the sentence people are shown, live here so the
 * dashboard's locks, Zeke and the routes' 403 all say the same thing.
 *
 * Import-free on purpose: the dashboard shell ships it to the browser.
 */

export type LaunchScope = 'full' | 'stablecoin';

export const LAUNCH_SCOPE_CODE = 'not_in_launch_scope';

/** What is open and what is not, with no claim about what just happened. */
export const LAUNCH_SCOPE_WHY =
  'Splash is open for USDC on Sui only for now. USD collection, local-currency payouts, payout runs and the treasury ' +
  'are not open yet.';

/** Shown when a request is refused before anything happened. */
export const LAUNCH_SCOPE_REASON = `${LAUNCH_SCOPE_WHY} Nothing was sent or recorded. Send USDC from Send USDC.`;

/** Shown where an approval was recorded but its payment is not carried out. */
export const LAUNCH_SCOPE_NOT_SENT = `${LAUNCH_SCOPE_WHY} Nothing was sent. Send USDC from Send USDC.`;

/** Read a raw setting: anything but "stablecoin" is the full scope. */
export function parseLaunchScope(raw: string | undefined | null): LaunchScope {
  return (raw ?? '').trim().toLowerCase() === 'stablecoin' ? 'stablecoin' : 'full';
}

type Lane = 'FIAT_IN_USD' | 'FIAT_OUT_LOCAL' | 'TREASURY' | 'STABLECOIN_WALLET' | 'X402';

/** Whether a lane is open in the scope. KYB decides separately. */
export function laneInScope(lane: Lane | string, scope: LaunchScope): boolean {
  if (scope === 'full') return true;
  return lane === 'STABLECOIN_WALLET' || lane === 'X402';
}

/**
 * Whether Zeke may draft, and an approval may carry out, a proposal of this
 * kind in the scope. Every kind is listed, so a new kind has to be decided
 * here before the code compiles. X402_PAYMENT stays: it is settled by the
 * business's own wallet on the stablecoin lane, never by Splash.
 */
const KIND_IN_STABLECOIN_SCOPE = {
  PAYMENT: false,
  INTERNAL_TRANSFER: false,
  FX_CONVERT: false,
  TREASURY_ALLOCATE: false,
  TREASURY_REDEEM: false,
  BATCH_PAYOUT: false,
  NETTING_SETTLE: false,
  X402_PAYMENT: true,
} as const satisfies Record<
  'PAYMENT' | 'INTERNAL_TRANSFER' | 'FX_CONVERT' | 'TREASURY_ALLOCATE' | 'TREASURY_REDEEM' | 'BATCH_PAYOUT' | 'NETTING_SETTLE' | 'X402_PAYMENT',
  boolean
>;

export function kindInScope(kind: string, scope: LaunchScope): boolean {
  if (scope === 'full') return true;
  return (KIND_IN_STABLECOIN_SCOPE as Record<string, boolean>)[kind] === true;
}
