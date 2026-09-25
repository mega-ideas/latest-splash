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

/**
 * Stablecoin transfers are free (decision of 2026-09-26).
 *
 *   To a Splash user's wallet    free, always: it never leaves Splash.
 *   To a wallet outside Splash   the audit-anchor fee — 0.02% with a 0.05 USDC
 *                                floor and a 5 USDC cap — pays for the record
 *                                Splash anchors for the transfer. Built, but
 *                                OFF until STABLECOIN_ANCHOR_FEE=on, so today
 *                                it is free too and the screens say so.
 *   x402                         no Splash fee (the seller sets the price).
 *
 * Network gas is separate, and on a wallet transfer there is none: see Gas
 * below. Local-currency payouts are priced elsewhere (lib/fx/corridors.ts,
 * 0.70%).
 *
 * A fee, when there is one, is charged ON TOP: the recipient receives exactly
 * the amount the business entered, and the business's wallet is debited
 * amount + fee. An invoice states what the payee must receive, and an x402
 * seller verifies it received exactly `amount` — a fee deducted from the
 * principal would break both. Rounded half-up, the house convention.
 */
export const ANCHOR_FEE_BPS = 2;
/** 0.05 USDC: covers the anchor's own cost on small transfers. */
export const ANCHOR_FEE_MIN_MINOR = 50_000n;
/** 5 USDC: keeps large treasury moves cheap. */
export const ANCHOR_FEE_CAP_MINOR = 5_000_000n;

/** Where the USDC goes: to a Splash user's wallet, or out of Splash. */
export type StablecoinDestination = 'SPLASH' | 'EXTERNAL';

export type StablecoinFeeKind = 'FREE' | 'AUDIT_ANCHOR';

/** The audit-anchor fee is charged only when switched on. Off by default. */
export function anchorFeeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.STABLECOIN_ANCHOR_FEE ?? '').trim().toLowerCase() === 'on';
}

export function stablecoinFeeMinor(
  principalMinor: bigint,
  destination: StablecoinDestination,
  anchorFeeOn: boolean,
): bigint {
  if (principalMinor <= 0n) throw new StablecoinLaneError('amount must be positive');
  if (destination === 'SPLASH' || !anchorFeeOn) return 0n;
  const proportional = applyBps(principalMinor, ANCHOR_FEE_BPS, 'half-up');
  if (proportional < ANCHOR_FEE_MIN_MINOR) return ANCHOR_FEE_MIN_MINOR;
  if (proportional > ANCHOR_FEE_CAP_MINOR) return ANCHOR_FEE_CAP_MINOR;
  return proportional;
}

/** Below this a wallet transfer is refused: 1.00 USDC. It keeps test-sized
 *  sends and typos off a mainnet ledger, and sits far above Sui's 0.01 floor
 *  for gasless transfers. x402 is exempt — the seller sets the price, and
 *  cents are the point of it. */
export const MIN_STABLECOIN_TRANSFER_MINOR = 1_000_000n;

// ─── Gas ────────────────────────────────────────────────────────────────────

/**
 * A wallet transfer carries no network fee. Since protocol 137, Sui runs a
 * transfer of an allowlisted stablecoin — native USDC among them — without
 * gas, when the transaction does nothing but move that coin with
 * 0x2::balance::send_funds (docs.sui.io, "Gasless Stablecoin Transfers").
 * The sending wallet needs no SUI and Splash pays nothing: no sponsor wallet,
 * no key on the server. Checked on mainnet with dry runs on 2026-09-26,
 * from a wallet holding only coin objects and from one holding an address
 * balance.
 *
 *   GASLESS      balance::send_funds for every leg, gas price 0, no gas coins.
 *                The recipient's USDC lands in its address balance, which
 *                wallets and Sui's own balance queries count with its coins.
 *   SENDER_PAYS  a coin transfer; the sending wallet pays a little SUI. Used
 *                for x402 (the seller's facilitator broadcasts that payment,
 *                so it stays the coin transfer the x402 Sui scheme was
 *                written against, and its price may sit under the floor),
 *                when gasless is switched off, and as the fallback when the
 *                network will not accept a gasless transfer. The quote says
 *                which, before anything is signed.
 *
 * Under congestion Sui serves gas-paying transactions first, so a gasless
 * transfer can take longer to land.
 */
export type GasMode = 'GASLESS' | 'SENDER_PAYS';

/** Sui refuses a gasless transfer under 0.01 of the coin (six decimals). */
export const GASLESS_MIN_LEG_MINOR = 10_000n;

/** The coins Splash sends gasless: the lane's own USDC. Sui's allowlist is
 *  longer (get_gasless_allowed_token_types); the lane only moves USDC. */
export const GASLESS_COIN_TYPES: readonly string[] = [SUI_USDC_COIN_TYPE.mainnet];

/** Gasless is on unless STABLECOIN_GASLESS=off — the switch for a protocol
 *  change or a wallet that mishandles it, without a deploy. */
export function gaslessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.STABLECOIN_GASLESS ?? '').trim().toLowerCase() !== 'off';
}

/**
 * Does the sending wallet need SUI for this send? Only where gas is paid:
 * every x402 payment, a transfer sent as a coin, any transfer while gasless
 * is switched off, and a quote that says the wallet pays — the quote's word
 * is final, since it may have fallen back.
 */
export function sendNeedsSui(input: { x402: boolean; gaslessOn: boolean; asCoin: boolean; quoteGas?: GasMode | null }): boolean {
  return input.x402 || !input.gaslessOn || input.asCoin || input.quoteGas === 'SENDER_PAYS';
}

/** Can these legs go without gas? Every leg must clear Sui's floor. */
export function gaslessEligible(coinType: string, legs: ReadonlyArray<{ amountMinor: bigint }>): boolean {
  const paying = legs.filter((leg) => leg.amountMinor > 0n);
  return GASLESS_COIN_TYPES.includes(coinType)
    && paying.length > 0
    && paying.every((leg) => leg.amountMinor >= GASLESS_MIN_LEG_MINOR);
}

export interface StablecoinQuote {
  principalMinor: bigint;
  feeMinor: bigint;
  totalDebitMinor: bigint;
  feeKind: StablecoinFeeKind;
  destination: StablecoinDestination;
}

export function quoteStablecoinTransfer(
  principalMinor: bigint,
  pricing: { destination: StablecoinDestination; anchorFeeOn: boolean },
): StablecoinQuote {
  if (principalMinor < MIN_STABLECOIN_TRANSFER_MINOR) {
    throw new StablecoinLaneError(
      `the minimum wallet transfer is ${formatMinor(MIN_STABLECOIN_TRANSFER_MINOR, USDC_DECIMALS)} USDC`,
    );
  }
  const feeMinor = stablecoinFeeMinor(principalMinor, pricing.destination, pricing.anchorFeeOn);
  return {
    principalMinor,
    feeMinor,
    totalDebitMinor: principalMinor + feeMinor,
    feeKind: feeMinor > 0n ? 'AUDIT_ANCHOR' : 'FREE',
    destination: pricing.destination,
  };
}

/** How a quote's fee reads to the person paying. */
export function describeStablecoinFee(quote: Pick<StablecoinQuote, 'feeMinor' | 'destination'>): string {
  if (quote.feeMinor === 0n) {
    return quote.destination === 'SPLASH' ? 'Free: to another Splash user' : 'Free';
  }
  return `Audit-anchor fee ${formatUsdc(quote.feeMinor)} USDC (0.02%, min 0.05, max 5)`;
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

/**
 * The local currency an invoice payout would be made in, or null for a USDC
 * payout: the question the FIAT_OUT_LOCAL lane answers. Both the record's
 * currency and the one read off the document count: an invoice re-typed as
 * USDC that still says PHP on its face is still a PHP invoice. A currency the
 * reader could not find is not a reading. `parseInvoice` returns '' for it,
 * and then the record alone decides. It used to return an invented 'USD',
 * which this would have treated as a USD payout.
 *
 * Invoice records are three-letter currencies today (/api/invoices), so a
 * USDC record cannot be created there yet; the USDC cases pin the rule for
 * when one can.
 */
export function invoiceLocalCurrency(
  recordCurrency: string | null | undefined,
  readCurrency: string | null | undefined,
): string | null {
  return (
    [recordCurrency, readCurrency]
      .map((currency) => String(currency ?? '').trim().toUpperCase())
      .find((currency) => currency && currency !== 'USDC') ?? null
  );
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
