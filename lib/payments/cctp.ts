import { formatUsdc, parseUsdcMinor } from './stablecoin-lane.ts';

/**
 * Funding a Splash wallet with USDC from another chain — a planner, not a
 * bridge. It says whether a route exists, what the person does on each side,
 * how long it waits, and what arrives. It moves nothing.
 *
 * ─── The facts it encodes (Circle developer docs, read 2026-09-24) ───────────
 *
 * - CCTP burns USDC on one chain and mints native USDC on another. It carries
 *   USDC only: USDT must be swapped to USDC on the source chain first.
 * - Sui is on CCTP **V1 (legacy) only**, domain 8. CCTP V2 is the canonical
 *   version everywhere else, and V1 has been in a manual phase-out since
 *   31 July 2026, ending in a full contract pause.
 * - V1 and V2 do not interoperate. Aptos is on V2 only, so there is **no
 *   CCTP route from Aptos to Sui** today.
 * - Ethereum (0), Arbitrum (3), Base (6) and Solana (5) still have V1
 *   contracts during the phase-out, so a V1 transfer to Sui is possible from
 *   them — for now. Circle can pause V1 on any of them; a large transfer
 *   should be checked against Circle's status first.
 * - V1 waits for hard finality on the source chain before Circle attests:
 *   about 13–20 minutes from Ethereum and the Ethereum rollups, well under a
 *   minute from Solana. Circle charges no fee on V1; each side's gas is paid
 *   by the person (SUI on the Sui side, to claim the mint).
 *
 * The recommended funding route stays the simplest one: send native USDC on
 * Sui straight to the Splash wallet address.
 */

export type FundingChain = 'SUI' | 'ETHEREUM' | 'ARBITRUM' | 'BASE' | 'SOLANA' | 'APTOS';
export type FundingAsset = 'USDC' | 'USDT';

export const SUI_CCTP_DOMAIN = 8;

interface ChainFacts {
  label: string;
  cctpDomain: number | null;
  /** Which CCTP versions have live contracts on this chain. */
  versions: ReadonlyArray<'V1' | 'V2'>;
  /** Rough wait for Circle's attestation on V1 (hard finality). */
  v1FinalityLabel: string;
  /** Wallets that sign on this chain. */
  wallet: string;
}

export const FUNDING_CHAINS: Record<Exclude<FundingChain, 'SUI'>, ChainFacts> = {
  ETHEREUM: { label: 'Ethereum', cctpDomain: 0, versions: ['V1', 'V2'], v1FinalityLabel: 'about 13–20 minutes', wallet: 'MetaMask' },
  ARBITRUM: { label: 'Arbitrum', cctpDomain: 3, versions: ['V1', 'V2'], v1FinalityLabel: 'about 13–20 minutes', wallet: 'MetaMask' },
  BASE: { label: 'Base', cctpDomain: 6, versions: ['V1', 'V2'], v1FinalityLabel: 'about 13–20 minutes', wallet: 'MetaMask' },
  SOLANA: { label: 'Solana', cctpDomain: 5, versions: ['V1', 'V2'], v1FinalityLabel: 'under a minute', wallet: 'a Solana wallet (Phantom, Solflare, or MetaMask for Solana)' },
  APTOS: { label: 'Aptos', cctpDomain: 9, versions: ['V2'], v1FinalityLabel: '—', wallet: 'an Aptos wallet (Petra)' },
};

/** Sui supports V1 only (Circle's supported-blockchains page). */
const SUI_VERSIONS: ReadonlyArray<'V1' | 'V2'> = ['V1'];

export interface FundingStep {
  where: string;
  action: string;
}

export type FundingPlan =
  | {
      available: true;
      route: 'DIRECT' | 'CCTP_V1';
      source: FundingChain;
      asset: FundingAsset;
      amountMinor: bigint;
      /** What reaches the Splash wallet, before gas (paid separately in each chain's native token). */
      arrivesMinor: bigint;
      /** When USDT must first become USDC, the least USDC the swap may return. */
      minUsdcAfterSwapMinor: bigint | null;
      wait: string;
      steps: FundingStep[];
      warnings: string[];
      cctp: { sourceDomain: number; destinationDomain: number; mintRecipient: string } | null;
    }
  | { available: false; source: FundingChain; asset: FundingAsset; reason: string; alternatives: string[] };

export class FundingPlanError extends Error {}

/** A Sui address as CCTP's 32-byte mintRecipient. Sui addresses already are 32 bytes. */
export function suiMintRecipient(address: string): string {
  const hex = address.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hex)) throw new FundingPlanError('The Splash wallet address is not a 32-byte Sui address.');
  return hex;
}

/**
 * Plan getting `amount` of `asset` on `source` into the Splash wallet at
 * `destination`. `swapSlippageBps` bounds a USDT→USDC swap on the source
 * chain (the person's own DEX); it is ignored for USDC.
 */
export function planFunding(input: {
  source: FundingChain;
  asset: FundingAsset;
  amount: string;
  destination: string;
  swapSlippageBps?: number;
}): FundingPlan {
  const amountMinor = parseUsdcMinor(input.amount);
  if (amountMinor <= 0n) throw new FundingPlanError('Enter an amount above zero.');
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
  const shared = chain.versions.filter((v) => SUI_VERSIONS.includes(v));
  if (shared.length === 0) {
    return {
      available: false,
      source: input.source,
      asset: input.asset,
      reason: `${chain.label} is on CCTP V2 only and Sui is on CCTP V1 only; the two versions do not interoperate, so there is no CCTP route from ${chain.label} to Sui today.`,
      alternatives: [
        `Move the USDC from ${chain.label} to Ethereum, Arbitrum, Base or Solana first, then use CCTP to Sui from there.`,
        'Buy or withdraw native USDC on Sui from an exchange and send it to the Splash wallet directly.',
      ],
    };
  }

  const steps: FundingStep[] = [];
  let usdcMinor = amountMinor;
  let minUsdcAfterSwapMinor: bigint | null = null;
  if (input.asset === 'USDT') {
    // A 1:1 swap is the fair value; the floor is what the person should
    // accept from their DEX at this slippage. Fees are the venue's.
    minUsdcAfterSwapMinor = (amountMinor * BigInt(10_000 - slippage)) / 10_000n;
    usdcMinor = minUsdcAfterSwapMinor;
    steps.push({
      where: `${chain.label} · ${chain.wallet}`,
      action: `Swap ${formatUsdc(amountMinor)} USDT to USDC on ${chain.label}. Accept no less than ${formatUsdc(minUsdcAfterSwapMinor)} USDC (${slippage / 100}% slippage). CCTP carries USDC only.`,
    });
  }
  steps.push(
    {
      where: `${chain.label} · ${chain.wallet}`,
      action: `Burn ${input.asset === 'USDT' ? 'the' : formatUsdc(usdcMinor)} USDC with CCTP V1 (depositForBurn): destination domain ${SUI_CCTP_DOMAIN} (Sui), mintRecipient ${mintRecipient}.`,
    },
    { where: 'Circle', action: `Wait for Circle's attestation — ${chain.v1FinalityLabel} on ${chain.label}.` },
    { where: 'Sui · Splash wallet', action: 'Claim the mint on Sui (receiveMessage with the attestation). This needs a little SUI for gas.' },
  );

  return {
    available: true,
    route: 'CCTP_V1',
    source: input.source,
    asset: input.asset,
    amountMinor,
    arrivesMinor: usdcMinor,
    minUsdcAfterSwapMinor,
    wait: chain.v1FinalityLabel,
    steps,
    warnings: [
      'Sui is on CCTP V1 only, and Circle has been phasing V1 out since 31 July 2026 toward a full contract pause. Check Circle’s status before a large transfer — V1 on a chain can stop.',
      'The burn and the claim each cost gas on their own chain, paid in that chain’s native token.',
      'Sending USDC straight to the Splash wallet on Sui is faster and has no bridge step.',
    ],
    cctp: { sourceDomain: chain.cctpDomain as number, destinationDomain: SUI_CCTP_DOMAIN, mintRecipient },
  };
}
