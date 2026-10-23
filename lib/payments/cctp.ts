import { keccak_256 } from '@noble/hashes/sha3.js';
import { fromBase58, fromHex, toBase58, toHex } from '@mysten/sui/utils';

import { formatUsdc, parseUsdcMinor } from './stablecoin-lane.ts';

/**
 * USDC between a Splash wallet on Sui and another chain, over Circle's CCTP
 * V2 — a planner, not a bridge. It says whether a route exists, what each
 * side does, how long Circle's attestation takes, what Circle may charge, and
 * what arrives. It moves nothing.
 *
 * It plans two directions:
 * - Funding (`planFunding`): burn USDC on another chain, mint it on Sui into
 *   the Splash wallet.
 * - Cross-chain recipients (`planCrossChainPayout`, decision D5(c)): burn
 *   USDC on Sui, mint it on the recipient's chain.
 *
 * ─── The facts it encodes ───────────────────────────────────────────────────
 *
 * Circle, "Supported blockchains and domains",
 * https://developers.circle.com/cctp/concepts/supported-chains-and-domains,
 * read 24 Oct 2026:
 * - 31 blockchains are listed, and every one of them is a destination. Each
 *   row says whether the chain is a standard source and a fast source. N/A in
 *   the fast column means standard attestation there is already fast, so
 *   Circle does not offer fast transfer from it.
 * - Sui is domain 8: a standard source, fast N/A. Circle's Sui packages are
 *   V2, and every package and state ID resolves on chain for mainnet and
 *   testnet (docs/mainnet-checks-2026-10.md, section 5, which records them).
 * - USDC is on every listed domain except BNB Smart Chain (domain 17), which
 *   carries USYC only. BNB Smart Chain is left out of the table below. That
 *   leaves 29 chains besides Sui.
 * - The page lists one chain that is on the legacy protocol only: Noble
 *   (domain 4). It is not on CCTP V2 and is left out.
 * - Circle's site has carried a contradicting line saying Sui still needs the
 *   legacy protocol. The Sui packages page and the chain say V2, and this
 *   file follows them. The legacy protocol is not used anywhere in Splash
 *   (decision D13; its shutdown runs 31 Oct to 1 Dec 2026).
 *
 * Circle, "Finality and block confirmations",
 * https://developers.circle.com/cctp/concepts/finality-and-block-confirmations,
 * read 24 Oct 2026: the average attestation waits in the table. A standard
 * transfer (minFinalityThreshold 2000) waits for hard finality on the source
 * chain. A fast transfer (minFinalityThreshold 1000) waits only for the block
 * to be confirmed, and draws on a global fast transfer allowance.
 *
 * Circle, "CCTP fees", https://developers.circle.com/cctp/concepts/fees,
 * read 24 Oct 2026:
 * - Circle charges a fee on fast transfers only. Its standard-transfer table
 *   lists 0 bps from every chain here, Sui included, except Stellar, which it
 *   does not list.
 * - Fast transfer fees run from 1 to 13 bps by source chain (table below),
 *   taken from the amount when the USDC is minted.
 * - Circle says not to hardcode fees: they change. Fetch the live fee
 *   (GET /v2/burn/USDC/fees/{source}/{destination}) before a burn, and set
 *   max_fee from it plus a buffer (Circle's example adds 20%). The fees here
 *   are for planning only.
 * - If Circle's fee is above max_fee, the page says the burn reverts on the
 *   source chain and nothing is burned, and that a fast transfer may be
 *   attested as standard instead.
 * - Some TokenMessengerV2 deployments carry a standard-transfer fee switch
 *   that can enforce a minimum fee at mint (Sei, today).
 *
 * Fast transfer INTO Sui: every chain is a destination, so fast transfer from
 * a chain Circle marks as a fast source appears available into Sui. Confirm
 * with Circle before relying on it (docs/mainnet-checks-2026-10.md, section 5).
 * Fast transfer FROM Sui is N/A: standard is already fast.
 *
 * ─── mint_recipient, per chain ──────────────────────────────────────────────
 *
 * Always 32 bytes.
 * - Sui: the 32-byte address as it is.
 * - EVM chains (the chains on Circle's EVM contract-addresses page,
 *   https://developers.circle.com/cctp/references/contract-addresses): the
 *   20-byte address, left-padded with zeros to 32 bytes. Circle's Sui and Arc
 *   quickstart says this for Sui's deposit_for_burn.
 * - Solana: the recipient's USDC token account (its associated token
 *   account), never the wallet key. The account must exist when the mint is
 *   submitted, or the mint reverts (Circle, Solana programs page). Deriving it
 *   needs the associated-token program's address derivation and an ed25519
 *   curve check, which this repository has no dependency for, so the caller
 *   derives it and passes it in. When Solana is the source, its
 *   deposit_for_burn takes the Sui address as a 32-byte public key in base58.
 * - Aptos: the 32-byte account address (Circle's Aptos page: mint_recipient
 *   is an `address`).
 * - Starknet: Circle shows Starknet only as a source, with deposit_for_burn
 *   taking the mint recipient as "a 32-byte felt". How a Starknet recipient is
 *   written is not stated, so Sui to Starknet is not planned.
 * - Stellar: Circle requires its CctpForwarder contract as both mint_recipient
 *   and destination_caller, with the real recipient in hook data; a wrong
 *   value strands the funds for good (Circle, CCTP on Stellar). Sui to
 *   Stellar is not planned.
 *
 * USDT never crosses. CCTP carries USDC only, so USDT is swapped to USDC on
 * the source chain first, with a slippage floor. There is no native USDT on
 * Sui.
 *
 * The recommended funding route stays the simplest one: send native USDC on
 * Sui straight to the Splash wallet address.
 */

export const CCTP_SOURCES = {
  supportedChains: 'https://developers.circle.com/cctp/concepts/supported-chains-and-domains',
  finality: 'https://developers.circle.com/cctp/concepts/finality-and-block-confirmations',
  fees: 'https://developers.circle.com/cctp/concepts/fees',
  readOn: '2026-10-24',
} as const;

/** Every CCTP V2 chain Circle lists with USDC, other than Sui. */
export type CctpPeerChain =
  | 'APTOS' | 'ARBITRUM' | 'ARC' | 'AVALANCHE' | 'BASE' | 'CODEX' | 'CRONOS' | 'EDGE'
  | 'ETHEREUM' | 'HYPEREVM' | 'INJECTIVE' | 'INK' | 'LINEA' | 'MONAD' | 'MORPH'
  | 'OP_MAINNET' | 'PHAROS' | 'PLASMA' | 'PLUME' | 'POLYGON_POS' | 'SEI' | 'SOLANA'
  | 'SONIC' | 'STARKNET' | 'STELLAR' | 'UNICHAIN' | 'WORLD_CHAIN' | 'X_LAYER' | 'XDC';
export type FundingChain = 'SUI' | CctpPeerChain;
export type FundingAsset = 'USDC' | 'USDT';
export type CctpTransfer = 'STANDARD' | 'FAST';
export type AddressFormat = 'EVM' | 'SOLANA' | 'APTOS' | 'STARKNET' | 'STELLAR';

export const SUI_CCTP_DOMAIN = 8;
/** Circle's thresholds: at most 1000 is fast, at least 2000 is standard. */
export const STANDARD_FINALITY_THRESHOLD = 2000;
export const FAST_FINALITY_THRESHOLD = 1000;
/** Anyone may submit the mint. The USDC still goes only to mint_recipient. */
export const ANY_DESTINATION_CALLER = `0x${'0'.repeat(64)}`;

/** Sui as a source: standard only, about 0.5 seconds, 0 bps listed. */
const SUI_STANDARD_WAIT = 'about 0.5 seconds';

interface ChainFacts {
  label: string;
  cctpDomain: number;
  addressFormat: AddressFormat;
  /** Circle's average wait for a standard attestation when this chain burns. */
  standardWait: string;
  /** Circle's listed standard-transfer fee from this chain, in tenths of a basis point; null where the fees page lists none. */
  standardFeeDeciBps: number | null;
  /** Fast transfer from this chain, as listed (fee in tenths of a basis point); null where Circle marks it N/A. */
  fast: { wait: string; feeDeciBps: number } | null;
}

const fast = (wait: string, feeDeciBps: number) => ({ wait, feeDeciBps });

/** Circle's table, read 24 Oct 2026 (see the header for the three pages). */
export const FUNDING_CHAINS: Record<CctpPeerChain, ChainFacts> = {
  APTOS: { label: 'Aptos', cctpDomain: 9, addressFormat: 'APTOS', standardWait: 'about 0.5 seconds', standardFeeDeciBps: 0, fast: null },
  ARBITRUM: { label: 'Arbitrum', cctpDomain: 3, addressFormat: 'EVM', standardWait: 'about 15–19 minutes', standardFeeDeciBps: 0, fast: fast('about 8 seconds', 14) },
  ARC: { label: 'Arc', cctpDomain: 26, addressFormat: 'EVM', standardWait: 'about 0.5 seconds', standardFeeDeciBps: 0, fast: null },
  AVALANCHE: { label: 'Avalanche', cctpDomain: 1, addressFormat: 'EVM', standardWait: 'about 8 seconds', standardFeeDeciBps: 0, fast: null },
  BASE: { label: 'Base', cctpDomain: 6, addressFormat: 'EVM', standardWait: 'about 15–19 minutes', standardFeeDeciBps: 0, fast: fast('about 8 seconds', 13) },
  CODEX: { label: 'Codex', cctpDomain: 12, addressFormat: 'EVM', standardWait: 'about 15–19 minutes', standardFeeDeciBps: 0, fast: fast('about 8 seconds', 15) },
  CRONOS: { label: 'Cronos', cctpDomain: 32, addressFormat: 'EVM', standardWait: 'about 0.5 seconds', standardFeeDeciBps: 0, fast: null },
  EDGE: { label: 'EDGE', cctpDomain: 28, addressFormat: 'EVM', standardWait: 'about 16–21 minutes', standardFeeDeciBps: 0, fast: fast('about 8 seconds', 15) },
  ETHEREUM: { label: 'Ethereum', cctpDomain: 0, addressFormat: 'EVM', standardWait: 'about 15–19 minutes', standardFeeDeciBps: 0, fast: fast('about 20 seconds', 10) },
  HYPEREVM: { label: 'HyperEVM', cctpDomain: 19, addressFormat: 'EVM', standardWait: 'about 5 seconds', standardFeeDeciBps: 0, fast: null },
  INJECTIVE: { label: 'Injective', cctpDomain: 29, addressFormat: 'EVM', standardWait: 'about 0.65 seconds', standardFeeDeciBps: 0, fast: null },
  INK: { label: 'Ink', cctpDomain: 21, addressFormat: 'EVM', standardWait: 'about 30 minutes', standardFeeDeciBps: 0, fast: fast('about 8 seconds', 20) },
  LINEA: { label: 'Linea', cctpDomain: 11, addressFormat: 'EVM', standardWait: 'about 6–32 hours', standardFeeDeciBps: 0, fast: fast('about 8 seconds', 130) },
  MONAD: { label: 'Monad', cctpDomain: 15, addressFormat: 'EVM', standardWait: 'about 5 seconds', standardFeeDeciBps: 0, fast: null },
  MORPH: { label: 'Morph', cctpDomain: 30, addressFormat: 'EVM', standardWait: 'about 20–30 minutes', standardFeeDeciBps: 0, fast: fast('about 8 seconds', 40) },
  OP_MAINNET: { label: 'OP Mainnet', cctpDomain: 2, addressFormat: 'EVM', standardWait: 'about 15–19 minutes', standardFeeDeciBps: 0, fast: fast('about 8 seconds', 13) },
  PHAROS: { label: 'Pharos', cctpDomain: 31, addressFormat: 'EVM', standardWait: 'about 7 seconds', standardFeeDeciBps: 0, fast: null },
  PLASMA: { label: 'Plasma', cctpDomain: 33, addressFormat: 'EVM', standardWait: 'about 1 second', standardFeeDeciBps: 0, fast: null },
  PLUME: { label: 'Plume', cctpDomain: 22, addressFormat: 'EVM', standardWait: 'about 15–19 minutes', standardFeeDeciBps: 0, fast: fast('about 8 seconds', 20) },
  POLYGON_POS: { label: 'Polygon PoS', cctpDomain: 7, addressFormat: 'EVM', standardWait: 'about 8 seconds', standardFeeDeciBps: 0, fast: null },
  SEI: { label: 'Sei', cctpDomain: 16, addressFormat: 'EVM', standardWait: 'about 5 seconds', standardFeeDeciBps: 0, fast: null },
  SOLANA: { label: 'Solana', cctpDomain: 5, addressFormat: 'SOLANA', standardWait: 'about 17 seconds', standardFeeDeciBps: 0, fast: fast('about 0.4–0.6 seconds', 10) },
  SONIC: { label: 'Sonic', cctpDomain: 13, addressFormat: 'EVM', standardWait: 'about 8 seconds', standardFeeDeciBps: 0, fast: null },
  STARKNET: { label: 'Starknet', cctpDomain: 25, addressFormat: 'STARKNET', standardWait: 'about 2–4 hours', standardFeeDeciBps: 0, fast: fast('about 20 seconds', 120) },
  STELLAR: { label: 'Stellar', cctpDomain: 27, addressFormat: 'STELLAR', standardWait: 'about 5 seconds', standardFeeDeciBps: null, fast: null },
  UNICHAIN: { label: 'Unichain', cctpDomain: 10, addressFormat: 'EVM', standardWait: 'about 15–19 minutes', standardFeeDeciBps: 0, fast: fast('about 8 seconds', 20) },
  WORLD_CHAIN: { label: 'World Chain', cctpDomain: 14, addressFormat: 'EVM', standardWait: 'about 15–19 minutes', standardFeeDeciBps: 0, fast: fast('about 8 seconds', 13) },
  X_LAYER: { label: 'X Layer', cctpDomain: 37, addressFormat: 'EVM', standardWait: 'about 15–19 minutes', standardFeeDeciBps: 0, fast: fast('about 8 seconds', 13) },
  XDC: { label: 'XDC', cctpDomain: 18, addressFormat: 'EVM', standardWait: 'about 10 seconds', standardFeeDeciBps: 0, fast: null },
};

export interface FundingStep {
  where: string;
  action: string;
}

/** The burn's parameters, as the source chain's CCTP V2 call takes them. */
export interface CctpBurn {
  sourceDomain: number;
  destinationDomain: number;
  /** 32 bytes, 0x-prefixed lowercase hex. */
  mintRecipient: string;
  /** Solana as the source only: the same 32 bytes as a base58 public key, the form Solana's deposit_for_burn takes. */
  mintRecipientBase58: string | null;
  destinationCaller: string;
  minFinalityThreshold: number;
  /** The most Circle may take, in USDC minor units. 0 for a standard transfer. */
  maxFeeMinor: bigint;
}

export type FundingPlan =
  | {
      available: true;
      route: 'DIRECT' | 'CCTP_V2';
      /** Null for a direct send on Sui. */
      transfer: CctpTransfer | null;
      source: FundingChain;
      asset: FundingAsset;
      amountMinor: bigint;
      /** The least that reaches the Splash wallet: after the swap floor and max_fee, before gas (paid separately in each chain's native token). */
      arrivesMinor: bigint;
      /** When USDT must first become USDC, the least USDC the swap may return. */
      minUsdcAfterSwapMinor: bigint | null;
      wait: string;
      steps: FundingStep[];
      warnings: string[];
      cctp: CctpBurn | null;
    }
  | { available: false; source: FundingChain; asset: FundingAsset; reason: string; alternatives: string[] };

export type CrossChainPayoutPlan =
  | {
      available: true;
      route: 'CCTP_V2';
      transfer: 'STANDARD';
      destinationChain: CctpPeerChain;
      amountMinor: bigint;
      /** The least the recipient receives (the amount less max_fee), before gas. */
      arrivesMinor: bigint;
      wait: string;
      steps: FundingStep[];
      warnings: string[];
      cctp: CctpBurn;
    }
  | { available: false; destinationChain: FundingChain; reason: string; alternatives: string[] };

export class FundingPlanError extends Error {}

// ─── Encoding ───────────────────────────────────────────────────────────────

/** A Sui address as CCTP's 32-byte mintRecipient. Sui addresses already are 32 bytes. */
export function suiMintRecipient(address: string): string {
  const hex = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hex)) throw new FundingPlanError('The Splash wallet address is not a 32-byte Sui address.');
  if (/^0x0{64}$/.test(hex)) throw new FundingPlanError('The zero address cannot receive USDC.');
  return hex;
}

/** EIP-55: a mixed-case EVM address carries a checksum in its letter case. */
function evmChecksumHolds(body: string): boolean {
  const lower = body.toLowerCase();
  const hash = toHex(keccak_256(new TextEncoder().encode(lower)));
  for (let i = 0; i < lower.length; i += 1) {
    const char = body[i];
    if (!/[a-fA-F]/.test(char)) continue;
    const upper = Number.parseInt(hash[i], 16) >= 8;
    if ((char === char.toUpperCase()) !== upper) return false;
  }
  return true;
}

/** A 20-byte EVM address, left-padded with zeros to CCTP's 32 bytes. */
export function evmMintRecipient(address: string): string {
  const raw = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new FundingPlanError('An EVM address is 0x followed by 40 hexadecimal characters.');
  const body = raw.slice(2);
  if (/^0{40}$/.test(body)) throw new FundingPlanError('The zero address cannot receive USDC.');
  const mixedCase = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixedCase && !evmChecksumHolds(body)) {
    throw new FundingPlanError('That EVM address fails its checksum. Copy it again from the recipient.');
  }
  return `0x${body.toLowerCase().padStart(64, '0')}`;
}

/** A Solana USDC token account (base58) as 32 bytes of hex. Not the wallet key. */
export function solanaTokenAccountMintRecipient(tokenAccount: string): string {
  const raw = tokenAccount.trim();
  let bytes: Uint8Array | null = null;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) {
    try {
      bytes = fromBase58(raw);
    } catch {
      bytes = null;
    }
  }
  if (!bytes || bytes.length !== 32) throw new FundingPlanError('A Solana address is 32 bytes written in base58 (32 to 44 characters).');
  if (bytes.every((b) => b === 0)) throw new FundingPlanError('The zero address cannot receive USDC.');
  return `0x${toHex(bytes)}`;
}

/** An Aptos account address, long form only, as CCTP's 32 bytes. */
export function aptosMintRecipient(address: string): string {
  const raw = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(raw)) {
    throw new FundingPlanError('An Aptos account address is 0x followed by 64 hexadecimal characters (the long form).');
  }
  if (/^0x0{64}$/.test(raw)) throw new FundingPlanError('The zero address cannot receive USDC.');
  return raw;
}

// ─── Fees and amounts ───────────────────────────────────────────────────────

function parseAmount(amount: string): bigint {
  let minor: bigint;
  try {
    minor = parseUsdcMinor(amount);
  } catch {
    throw new FundingPlanError('Enter an amount in USDC, with up to six decimals.');
  }
  if (minor <= 0n) throw new FundingPlanError('Enter an amount above zero.');
  return minor;
}

/** The listed fee on `amountMinor`, rounded up. `deciBps` is tenths of a basis point. */
function listedFeeMinor(amountMinor: bigint, deciBps: number): bigint {
  return (amountMinor * BigInt(deciBps) + 99_999n) / 100_000n;
}

/** max_fee for a fast burn: the listed fee plus 20%, rounded up (Circle's example buffer). */
function fastMaxFeeMinor(amountMinor: bigint, deciBps: number): bigint {
  return (listedFeeMinor(amountMinor, deciBps) * 120n + 99n) / 100n;
}

function bpsLabel(deciBps: number): string {
  return `${Math.trunc(deciBps / 10)}${deciBps % 10 === 0 ? '' : `.${deciBps % 10}`} bps`;
}

const FEES_READ = 'Circle’s fees page, read 24 Oct 2026';

function burnCall(format: AddressFormat): string {
  if (format === 'EVM') return 'TokenMessengerV2 depositForBurn';
  if (format === 'STELLAR') return 'the CCTP V2 burn on Stellar';
  return 'deposit_for_burn';
}

// ─── Funding: another chain → the Splash wallet on Sui ──────────────────────

/**
 * Plan getting `amount` of `asset` on `source` into the Splash wallet at
 * `destination`. `swapSlippageBps` bounds a USDT→USDC swap on the source
 * chain (the person's own DEX); it is ignored for USDC. `speed` asks for a
 * fast transfer where Circle offers one; the default is standard.
 */
export function planFunding(input: {
  source: FundingChain;
  asset: FundingAsset;
  amount: string;
  destination: string;
  swapSlippageBps?: number;
  speed?: CctpTransfer;
}): FundingPlan {
  const amountMinor = parseAmount(input.amount);
  const slippage = input.swapSlippageBps ?? 50;
  if (!Number.isInteger(slippage) || slippage < 0 || slippage > 500) throw new FundingPlanError('Swap slippage must be 0–5%.');
  const mintRecipient = suiMintRecipient(input.destination);

  if (input.source === 'SUI') {
    if (input.asset === 'USDT') {
      return {
        available: false,
        source: 'SUI',
        asset: 'USDT',
        reason: 'There is no native USDT on Sui — only bridge-wrapped versions, which Splash does not settle in.',
        alternatives: ['Send native USDC on Sui instead.', 'Swap to native USDC on Sui first, then send it.'],
      };
    }
    return {
      available: true,
      route: 'DIRECT',
      transfer: null,
      source: 'SUI',
      asset: 'USDC',
      amountMinor,
      arrivesMinor: amountMinor,
      minUsdcAfterSwapMinor: null,
      wait: 'seconds',
      steps: [{ where: 'Your Sui wallet or exchange', action: `Send ${formatUsdc(amountMinor)} native USDC on Sui to ${mintRecipient}.` }],
      warnings: ['Send USDC on the Sui network only. USDC sent on another network to this address is not recoverable by Splash.'],
      cctp: null,
    };
  }

  const chain = FUNDING_CHAINS[input.source];
  if (!chain) throw new FundingPlanError('Circle does not list that chain for CCTP V2 with USDC.');
  const where = `${chain.label} · your wallet`;
  const steps: FundingStep[] = [];
  const warnings: string[] = [];

  let usdcMinor = amountMinor;
  let minUsdcAfterSwapMinor: bigint | null = null;
  if (input.asset === 'USDT') {
    // A 1:1 swap is the fair value; the floor is what the person should
    // accept from their DEX at this slippage. Fees are the venue's.
    minUsdcAfterSwapMinor = (amountMinor * BigInt(10_000 - slippage)) / 10_000n;
    usdcMinor = minUsdcAfterSwapMinor;
    steps.push({
      where,
      action: `Swap ${formatUsdc(amountMinor)} USDT to USDC on ${chain.label}. Accept no less than ${formatUsdc(minUsdcAfterSwapMinor)} USDC (${slippage / 100}% slippage). CCTP carries USDC only.`,
    });
  }

  if (input.speed === 'FAST' && !chain.fast) {
    warnings.push(`Circle does not offer fast transfer from ${chain.label}: its standard attestation is already ${chain.standardWait}.`);
  }
  const transfer: CctpTransfer = input.speed === 'FAST' && chain.fast ? 'FAST' : 'STANDARD';
  const maxFeeMinor = transfer === 'FAST' && chain.fast ? fastMaxFeeMinor(usdcMinor, chain.fast.feeDeciBps) : 0n;
  if (maxFeeMinor >= usdcMinor) {
    throw new FundingPlanError(`${formatUsdc(usdcMinor)} USDC does not cover the fast transfer fee from ${chain.label}. Send more, or use a standard transfer.`);
  }
  const wait = transfer === 'FAST' && chain.fast ? chain.fast.wait : chain.standardWait;
  const threshold = transfer === 'FAST' ? FAST_FINALITY_THRESHOLD : STANDARD_FINALITY_THRESHOLD;
  const mintRecipientBase58 = chain.addressFormat === 'SOLANA' ? toBase58(fromHex(mintRecipient)) : null;
  const recipientLabel = mintRecipientBase58
    ? `mintRecipient ${mintRecipientBase58} (the Splash wallet address as a 32-byte Solana public key)`
    : `mintRecipient ${mintRecipient}`;

  steps.push(
    {
      where,
      action: `Burn ${input.asset === 'USDT' ? 'the' : formatUsdc(usdcMinor)} USDC with CCTP V2 (${burnCall(chain.addressFormat)}): destination domain ${SUI_CCTP_DOMAIN} (Sui), ${recipientLabel}, destinationCaller zero (anyone may submit the mint), maxFee ${formatUsdc(maxFeeMinor)} USDC, minFinalityThreshold ${threshold} (${transfer === 'FAST' ? 'fast' : 'standard'} transfer).`,
    },
    { where: 'Circle', action: `Wait for Circle’s attestation: ${wait} from ${chain.label}.` },
    { where: 'Sui · Splash wallet', action: 'Submit Circle’s message and attestation to CCTP V2 on Sui, which mints the USDC to the Splash wallet. This needs a little SUI for gas.' },
  );

  if (transfer === 'FAST' && chain.fast) {
    warnings.push(
      `Fast transfer from ${chain.label}: Circle lists the fee at ${bpsLabel(chain.fast.feeDeciBps)} (${FEES_READ}), taken from the amount at mint. maxFee here is that fee plus 20%. Fetch the live fee from Circle before the burn: fees change, and below the live fee the burn reverts or is attested as standard.`,
      `Into Sui, fast transfer appears available: Circle lists ${chain.label} as a fast source and every chain as a destination. Confirm with Circle before relying on it. Fast transfers also draw on Circle’s limited fast transfer allowance.`,
    );
  } else {
    warnings.push(
      chain.standardFeeDeciBps === null
        ? `Circle’s fees page does not list a standard-transfer fee from ${chain.label}. Check Circle’s fee API before the burn; with maxFee 0, a fee above it makes the burn revert on ${chain.label}.`
        : `Circle lists the standard-transfer fee from ${chain.label} at ${bpsLabel(chain.standardFeeDeciBps)} (${FEES_READ}). Fees can change; with maxFee 0, a fee above it makes the burn revert on ${chain.label}, and nothing is burned.`,
    );
    if (chain.fast) {
      warnings.push(
        `Faster option: a fast transfer from ${chain.label} takes ${chain.fast.wait}, for a listed fee of ${bpsLabel(chain.fast.feeDeciBps)}. Into Sui it appears available; confirm with Circle before relying on it.`,
      );
    }
  }
  if (chain.addressFormat === 'STELLAR') {
    warnings.push('Stellar USDC has seven decimals and CCTP carries six. The burn takes the first six; anything in the seventh stays on Stellar.');
  }
  if (chain.addressFormat === 'STARKNET') {
    warnings.push('Circle’s Starknet guide shows deposit_for_burn taking the mint recipient as a 32-byte felt, with an EVM recipient only. Confirm with Circle how a full 32-byte Sui address is passed before the first transfer from Starknet.');
  }
  warnings.push(
    'The burn and the claim each cost gas on their own chain, paid in that chain’s native token.',
    'Send a small amount first the first time you use a chain, and wait for it to arrive.',
    'Sending USDC straight to the Splash wallet on Sui is faster and has no bridge step.',
  );

  return {
    available: true,
    route: 'CCTP_V2',
    transfer,
    source: input.source,
    asset: input.asset,
    amountMinor,
    arrivesMinor: usdcMinor - maxFeeMinor,
    minUsdcAfterSwapMinor,
    wait,
    steps,
    warnings,
    cctp: {
      sourceDomain: chain.cctpDomain,
      destinationDomain: SUI_CCTP_DOMAIN,
      mintRecipient,
      mintRecipientBase58,
      destinationCaller: ANY_DESTINATION_CALLER,
      minFinalityThreshold: threshold,
      maxFeeMinor,
    },
  };
}

// ─── Cross-chain recipients: the Splash wallet on Sui → another chain ───────

/**
 * Plan paying `amount` USDC from the Splash wallet on Sui to `recipient` on
 * `destinationChain`, for a cross-chain recipient (D5(c)). USDC only.
 *
 * `recipient` is the address USDC is minted to: an EVM address on an EVM
 * chain, a 64-hex account address on Aptos, and on Solana the recipient's
 * USDC token account. For Solana the caller must derive that associated
 * token account from the recipient's wallet and the USDC mint, confirm it
 * exists, and say so with `recipientIsUsdcTokenAccount: true`: a wallet key
 * there looks identical and loses the funds.
 */
export function planCrossChainPayout(input: {
  destinationChain: FundingChain;
  amount: string;
  recipient: string;
  recipientIsUsdcTokenAccount?: boolean;
}): CrossChainPayoutPlan {
  const amountMinor = parseAmount(input.amount);

  if (input.destinationChain === 'SUI') {
    return {
      available: false,
      destinationChain: 'SUI',
      reason: 'That recipient is on Sui. Send USDC on Sui directly; there is no bridge step.',
      alternatives: ['Pay the recipient’s Sui address with a normal USDC transfer.'],
    };
  }
  const chain = FUNDING_CHAINS[input.destinationChain];
  if (!chain) throw new FundingPlanError('Circle does not list that chain for CCTP V2 with USDC.');

  if (chain.addressFormat === 'STELLAR') {
    return {
      available: false,
      destinationChain: input.destinationChain,
      reason: 'Circle requires its forwarder contract, with the real recipient in hook data, for every transfer to Stellar. A wrong value strands the USDC for good, so Splash does not plan this route.',
      alternatives: ['Ask the recipient for an address on another chain Circle supports.'],
    };
  }
  if (chain.addressFormat === 'STARKNET') {
    return {
      available: false,
      destinationChain: input.destinationChain,
      reason: 'Circle does not state how a Starknet recipient is written as the mint recipient, so Splash does not plan this route.',
      alternatives: ['Ask the recipient for an address on another chain Circle supports.'],
    };
  }

  let mintRecipient: string;
  if (chain.addressFormat === 'EVM') mintRecipient = evmMintRecipient(input.recipient);
  else if (chain.addressFormat === 'APTOS') mintRecipient = aptosMintRecipient(input.recipient);
  else {
    if (input.recipientIsUsdcTokenAccount !== true) {
      throw new FundingPlanError(
        'For Solana, give the recipient’s USDC token account (their associated token account), not their wallet address. Derive it from the wallet and the USDC mint, and check it exists on Solana.',
      );
    }
    mintRecipient = solanaTokenAccountMintRecipient(input.recipient);
  }

  const maxFeeMinor = 0n;
  const mintStep: FundingStep =
    chain.addressFormat === 'EVM'
      ? { where: chain.label, action: `Submit the message and attestation to MessageTransmitterV2 receiveMessage on ${chain.label}, which mints the USDC to the recipient. Whoever submits pays the ${chain.label} gas.` }
      : chain.addressFormat === 'SOLANA'
        ? { where: 'Solana', action: 'Submit the message and attestation to receive_message on Solana, which mints the USDC to the recipient’s token account. That account must exist by then, or the mint reverts. Whoever submits pays the Solana fee.' }
        : { where: 'Aptos', action: 'Submit the message and attestation on Aptos: receive_message, prepare_mint and the stablecoin handler’s mint, in one transaction. Whoever submits pays the Aptos gas.' };

  const warnings = [
    'A burn cannot be undone. Confirm the chain and the address with the recipient first: USDC minted to a wrong address is not recoverable by Splash.',
  ];
  if (chain.addressFormat === 'EVM') {
    warnings.push(`An EVM address is the same on every EVM chain, but a smart-contract wallet exists only where it was deployed. Make sure the recipient controls this address on ${chain.label}.`);
  }
  if (chain.addressFormat === 'SOLANA') {
    warnings.push('The mint recipient is the recipient’s USDC token account, never their wallet address. Splash cannot tell the two apart offline.');
  }
  warnings.push(
    `Circle lists the standard-transfer fee from Sui at 0 bps (${FEES_READ}). Fees can change; with maxFee 0, a fee above it makes the burn revert on Sui, and nothing is burned.`,
    `Someone must submit the mint on ${chain.label} and pay its gas. destinationCaller is zero, so anyone can, and the USDC still goes only to the mint recipient.`,
  );

  return {
    available: true,
    route: 'CCTP_V2',
    transfer: 'STANDARD',
    destinationChain: input.destinationChain,
    amountMinor,
    arrivesMinor: amountMinor - maxFeeMinor,
    wait: SUI_STANDARD_WAIT,
    steps: [
      {
        where: 'Sui · Splash wallet',
        action: `Burn ${formatUsdc(amountMinor)} USDC on Sui with CCTP V2, in one transaction: deposit_for_burn (destination domain ${chain.cctpDomain} (${chain.label}), mint_recipient ${mintRecipient}, destination_caller zero, max_fee 0, min_finality_threshold ${STANDARD_FINALITY_THRESHOLD}), then create_complete_burn_ticket and complete_burn. This needs a little SUI for gas.`,
      },
      { where: 'Circle', action: `Wait for Circle’s attestation: ${SUI_STANDARD_WAIT} from Sui. Circle does not offer fast transfer from Sui; standard is already fast.` },
      mintStep,
    ],
    warnings,
    cctp: {
      sourceDomain: SUI_CCTP_DOMAIN,
      destinationDomain: chain.cctpDomain,
      mintRecipient,
      mintRecipientBase58: null,
      destinationCaller: ANY_DESTINATION_CALLER,
      minFinalityThreshold: STANDARD_FINALITY_THRESHOLD,
      maxFeeMinor,
    },
  };
}
