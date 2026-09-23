import { applyBps, formatMinor, MICRO_DECIMALS, parseMinor, sumMinor } from '../money.ts';
import type { KybLifecycleState } from '../compliance/kyb-state.ts';
import { suiScanTxUrlOn } from '../explorer.ts';

/**
 * The stablecoin lane — what a business may send before, and after, it is
 * verified.
 *
 * ─── The asset ──────────────────────────────────────────────────────────────
 * Settlement is native USDC on Sui, and only that. Businesses may FUND from
 * USDC on other chains through Circle's CCTP (see lib/payments/cctp.ts), but
 * what moves between wallets here is Circle's native Sui USDC. There is no
 * native Tether USDT on Sui — only bridge-wrapped versions — and settling in a
 * bridge wrapper adds a bridge's failure modes to every payment for no gain.
 *
 * ─── Who may use it ─────────────────────────────────────────────────────────
 * A business still in onboarding (REGISTERED through KYB_ADMIN_APPROVED) may
 * send USDC on Sui to wallet recipients it has saved, up to a cap. USD in and
 * local-currency payouts stay locked until verification completes, because
 * those rails move value through regulated partners on the business's behalf.
 *
 * A business that was REJECTED or SUSPENDED gets nothing here. A suspension is
 * a compliance action; an "unverified allowance" that survived it would be the
 * first thing a suspended actor reached for.
 *
 * ─── Why the business signs ─────────────────────────────────────────────────
 * The business signs every transfer itself — with its Splash wallet (the Sui
 * address of its own passkey), or in Slush, or MetaMask with the Sui Snap —
 * and the principal goes wallet to wallet in one transaction —
 * it never passes through an address Splash controls. Splash quotes, reserves
 * allowance, and verifies the executed transaction against the chain. That is
 * what lets an unverified business use it at all: Splash is not moving money
 * for a party it has not verified, it is recording what that party did itself.
 * (Whether that is enough for a given jurisdiction is counsel's call, not this
 * comment's — it describes the mechanism, not a regulatory status.)
 */

// ─── The asset ──────────────────────────────────────────────────────────────

export type SuiNetwork = 'mainnet' | 'testnet';

/**
 * The stablecoin lane settles on Sui MAINNET, always. There is no stablecoin
 * sandbox: the sandbox covers USD in and local-currency out, where the
 * partners offer one, and a testnet USDC transfer proves nothing a business
 * can rely on. The testnet coin type below stays as a verified fact (x402
 * challenges name networks), not as a lane.
 */
export const STABLECOIN_NETWORK = 'mainnet' as const satisfies SuiNetwork;

/** Circle native USDC. Mainnet type verified against Circle's own announcement;
 *  testnet against the same source. Six decimals on both. */
export const SUI_USDC_COIN_TYPE: Record<SuiNetwork, string> = {
  mainnet: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  testnet: '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC',
};

export const USDC_DECIMALS = MICRO_DECIMALS;

/** The wallet-standard chain id a wallet is asked to sign for. */
export function suiChain(network: SuiNetwork): `sui:${SuiNetwork}` {
  return `sui:${network}`;
}

/** Where a person can look a transaction up themselves — on the lane's own
 *  network, not the app's (lib/explorer.ts). */
export function explorerTxUrl(network: SuiNetwork, digest: string): string {
  return suiScanTxUrlOn(network, digest);
}

// ─── Price ──────────────────────────────────────────────────────────────────

/** "From 0.80%": the published Splash fee, applied to wallet transfers. */
export const STABLECOIN_FEE_BPS = 80;

/**
 * The fee is charged ON TOP: the recipient receives exactly the amount the
 * business entered, and the business's wallet is debited amount + fee. An
 * invoice states what the payee must receive, and an x402 seller verifies it
 * received exactly `amount` — a fee deducted from the principal would break
 * both. Rounded half-up, the house convention (lib/fx/calculator.ts).
 */
export function stablecoinFeeMinor(principalMinor: bigint): bigint {
  if (principalMinor <= 0n) throw new StablecoinLaneError('amount must be positive');
  return applyBps(principalMinor, STABLECOIN_FEE_BPS, 'half-up');
}

/** Below this a wallet transfer is refused: the fee rounds to noise and the
 *  gas outweighs the payment. 1.00 USDC. x402 is exempt — the seller sets the
 *  price, and cents are the point of it. */
export const MIN_STABLECOIN_TRANSFER_MINOR = 1_000_000n;

export interface StablecoinQuote {
  principalMinor: bigint;
  feeMinor: bigint;
  totalDebitMinor: bigint;
  feeBps: number;
}

export function quoteStablecoinTransfer(principalMinor: bigint): StablecoinQuote {
  if (principalMinor < MIN_STABLECOIN_TRANSFER_MINOR) {
    throw new StablecoinLaneError(
      `the minimum wallet transfer is ${formatMinor(MIN_STABLECOIN_TRANSFER_MINOR, USDC_DECIMALS)} USDC`,
    );
  }
  const feeMinor = stablecoinFeeMinor(principalMinor);
  return { principalMinor, feeMinor, totalDebitMinor: principalMinor + feeMinor, feeBps: STABLECOIN_FEE_BPS };
}

// ─── Limits ─────────────────────────────────────────────────────────────────

/** 5,000 USDC for a business still in onboarding. */
export const UNVERIFIED_STABLECOIN_CAP_MINOR = 5_000_000_000n;

/**
 * A ROLLING 30-day window, not a calendar month. A calendar month resets on
 * the 1st, so an unverified business could send 5,000 on the 31st and 5,000 on
 * the 1st — 10,000 in two days against a "5,000 a month" rule. The same reason
 * splash_meter's SpendMeter uses sliding buckets rather than a tumbling window.
 */
export const STABLECOIN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** A verified business on the stablecoin lane gets the on-chain Tier 3
 *  defaults from business_account.move: 20,000 per transfer, 500,000 over
 *  the window. Mirrored, not invented. */
export const VERIFIED_PER_TRANSFER_MINOR = 20_000_000_000n;
export const VERIFIED_WINDOW_CAP_MINOR = 500_000_000_000n;

export interface StablecoinLimits {
  perTransferMinor: bigint;
  windowCapMinor: bigint;
  windowMs: number;
}

// ─── Who may use which lane ─────────────────────────────────────────────────

export type Lane =
  | 'FIAT_IN_USD'
  | 'FIAT_OUT_LOCAL'
  | 'STABLECOIN_WALLET'
  | 'X402'
  | 'TREASURY';

export interface LaneAccess {
  allowed: boolean;
  reason: string;
}

const ONBOARDING_STATES: ReadonlySet<KybLifecycleState> = new Set([
  'REGISTERED',
  'KYB_SUBMITTED',
  'KYB_PROVIDER_APPROVED',
  'KYB_ADMIN_APPROVED',
]);

export const FIAT_LOCKED_REASON =
  'USD in and local-currency payouts unlock when your business is verified. Until then you can send USDC on Sui to a wallet recipient you have saved — up to 5,000 USDC in any 30 days.';

export function isOnboarding(state: KybLifecycleState): boolean {
  return ONBOARDING_STATES.has(state);
}

export function laneAccess(state: KybLifecycleState, lane: Lane): LaneAccess {
  if (state === 'SUSPENDED') {
    return { allowed: false, reason: 'This workspace is suspended. No money can move until support restores it.' };
  }
  if (state === 'REJECTED') {
    return { allowed: false, reason: 'Verification was declined. Re-submit KYB to continue — no lane is open until then.' };
  }
  if (state === 'ACTIVE') return { allowed: true, reason: '' };

  // Onboarding.
  switch (lane) {
    case 'STABLECOIN_WALLET':
    case 'X402':
      return { allowed: true, reason: '' };
    case 'FIAT_IN_USD':
    case 'FIAT_OUT_LOCAL':
      return { allowed: false, reason: FIAT_LOCKED_REASON };
    case 'TREASURY':
      return {
        allowed: false,
        reason: 'Treasury is for verified businesses. Finish verification in Account setup to open it.',
      };
  }
}

export function stablecoinLimitsFor(state: KybLifecycleState): StablecoinLimits | null {
  if (state === 'ACTIVE') {
    return {
      perTransferMinor: VERIFIED_PER_TRANSFER_MINOR,
      windowCapMinor: VERIFIED_WINDOW_CAP_MINOR,
      windowMs: STABLECOIN_WINDOW_MS,
    };
  }
  if (isOnboarding(state)) {
    return {
      perTransferMinor: UNVERIFIED_STABLECOIN_CAP_MINOR,
      windowCapMinor: UNVERIFIED_STABLECOIN_CAP_MINOR,
      windowMs: STABLECOIN_WINDOW_MS,
    };
  }
  return null; // REJECTED, SUSPENDED
}

// ─── The allowance ──────────────────────────────────────────────────────────

/** One prior outflow as the window sees it. Transfers AND x402 payments — the
 *  cap is shared. Only the principal counts: the fee is Splash's price, not
 *  value sent to a third party. */
export interface PriorOutflow {
  principalMinor: bigint;
  atMs: number;
}

export interface AllowanceCheck {
  ok: boolean;
  usedMinor: bigint;
  remainingMinor: bigint;
  windowCapMinor: bigint;
  reason: string;
}

export function checkStablecoinAllowance(input: {
  state: KybLifecycleState;
  principalMinor: bigint;
  prior: PriorOutflow[];
  nowMs: number;
}): AllowanceCheck {
  const limits = stablecoinLimitsFor(input.state);
  if (!limits) {
    return {
      ok: false,
      usedMinor: 0n,
      remainingMinor: 0n,
      windowCapMinor: 0n,
      reason: laneAccess(input.state, 'STABLECOIN_WALLET').reason,
    };
  }
  if (input.principalMinor <= 0n) throw new StablecoinLaneError('amount must be positive');

  const windowStart = input.nowMs - limits.windowMs;
  const usedMinor = sumMinor(input.prior.filter((o) => o.atMs > windowStart).map((o) => o.principalMinor));
  const remainingMinor = usedMinor >= limits.windowCapMinor ? 0n : limits.windowCapMinor - usedMinor;

  const fmt = (m: bigint) => `${formatMinor(m, USDC_DECIMALS)} USDC`;
  if (input.principalMinor > limits.perTransferMinor) {
    return {
      ok: false,
      usedMinor,
      remainingMinor,
      windowCapMinor: limits.windowCapMinor,
      reason: `A single transfer can be at most ${fmt(limits.perTransferMinor)} at your verification level.`,
    };
  }
  if (input.principalMinor > remainingMinor) {
    return {
      ok: false,
      usedMinor,
      remainingMinor,
      windowCapMinor: limits.windowCapMinor,
      reason: isOnboarding(input.state)
        ? `Unverified businesses can send up to ${fmt(limits.windowCapMinor)} in any 30 days. You have ${fmt(remainingMinor)} left. Finish verification to lift the limit.`
        : `This would exceed your 30-day limit of ${fmt(limits.windowCapMinor)}. You have ${fmt(remainingMinor)} left.`,
    };
  }
  return { ok: true, usedMinor, remainingMinor, windowCapMinor: limits.windowCapMinor, reason: '' };
}

// ─── Recipient wallets ──────────────────────────────────────────────────────

/** The wallets Splash accepts for a Sui address. Phantom ended Sui support on
 *  24 September 2026; MetaMask reaches Sui only through the Sui Snap. */
export const WALLET_PROVIDERS = ['SLUSH', 'METAMASK_SUI_SNAP'] as const;
export type WalletProvider = (typeof WALLET_PROVIDERS)[number];

const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Validate a recipient's Sui address, and refuse — never "fix" — an Ethereum
 * one. A 20-byte EVM address left-padded to 32 bytes IS a syntactically valid
 * Sui address; nobody holds its key, and USDC sent there is gone. MetaMask
 * shows an Ethereum address by default, so this is the likeliest paste error
 * in the whole lane.
 */
export function normaliseSuiAddress(input: string): string {
  const raw = input.trim();
  if (EVM_ADDRESS.test(raw)) {
    throw new StablecoinLaneError(
      'That is an Ethereum address. Splash settles in USDC on Sui — ask your recipient for their Sui address (from Slush, or MetaMask with the Sui Snap).',
    );
  }
  if (!SUI_ADDRESS.test(raw)) {
    throw new StablecoinLaneError('A Sui address is 0x followed by 64 hexadecimal characters.');
  }
  if (/^0x0{64}$/.test(raw)) throw new StablecoinLaneError('The zero address cannot receive a payment.');
  return raw.toLowerCase();
}

// ─── Display ────────────────────────────────────────────────────────────────

/** 1_250_500_000n → "1,250.50"; 1_234_567n → "1.234567". Exact: at least two
 *  decimals, never rounded, trailing zeros past the cents dropped. */
export function formatUsdc(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = (abs / 1_000_000n).toLocaleString('en-US');
  let frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/** 0x1234…cdef — enough to confirm, not to copy. */
export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/** "1250.5" USDC → 1_250_500_000n. More than six decimals is refused, not rounded. */
export function parseUsdcMinor(input: string): bigint {
  return parseMinor(input, USDC_DECIMALS);
}

export class StablecoinLaneError extends Error {}
