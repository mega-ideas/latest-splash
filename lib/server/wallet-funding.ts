/**
 * "Add funds" for the Business Splash Wallet (v2 §4.3): one interface over
 * every way money comes in, and the API Transfer's step 3 "Top up and
 * continue" (§5.4) reuses as is.
 *
 *   fundingOptions        what this business can fund with, and from which
 *                         of its sources
 *   quoteFunding          the quote, first: what arrives, the least that may
 *                         arrive, each partner's or Circle's own fee line,
 *                         and when the rate lapses
 *   createFundingIntent   one top-up, idempotent by the client's key; a fresh
 *                         quote worse than the one the business accepted is
 *                         refused, never silently taken
 *   recordDeposit         money that arrived, read from the chain by digest
 *                         (amount, coin and sender from the transaction, never
 *                         from the caller), screened, attributed to a source
 *                         and held or cleared
 *   syncWalletDeposits    the deposit watcher: every transaction that touched
 *                         the wallet is read and its arrivals recorded, so
 *                         nobody has to report a deposit for it to be
 *                         screened and held
 *   walletFundsWithheld   what a payment may not use: held, blocked, and
 *                         anything the watcher has not accounted for
 *   handleProviderWebhook a partner's signed status update; status never
 *                         goes backwards and each event counts once
 *   sources               add a bank account or card in the company's name,
 *                         or a wallet, and prove a wallet by signature
 *
 * Every function runs within ONE org, the session's (`deps.orgId`), and the
 * destination is always the wallet that org's BusinessAccount names on
 * chain. Splash never receives the funds: no address Splash controls is ever
 * a destination (D1, D3), and the Phase 1 mainnet refusals on the old
 * deposit-address path (lib/server/funding-sessions.ts) are untouched.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { normalizeStructTag, normalizeSuiAddress, fromBase58, fromBase64, fromHex } from '@mysten/sui/utils';

import type { KytProvider, KytScreening } from '../compliance/kyt.ts';
import {
  bankAccountIdentity,
  canAdvanceIntent,
  canMoveDeposit,
  cardIdentity,
  decideDeposit,
  fingerprintKeys,
  FundingSourceError,
  intentIsOpen,
  MAX_TOP_UP_MINOR,
  parseUsdcAmount,
  sameCompany,
  validClientKey,
  WALLET_PROOF_TTL_MS,
  walletIdentity,
  walletProofMessage,
  walletProofSupported,
  type ArrivalAsset,
  type FundingChannel,
  type FundingSourceKind,
  type HoldReason,
  type IntentStatus,
  type SourceChain,
} from '../funding/wallet-funding.ts';
import {
  fundingProvider,
  FundingProviderUnavailable,
  isFundingProviderId,
  providerDeliveryAddresses,
  providerEnabled,
  providerFacts,
  FUNDING_PROVIDER_IDS,
  WebhookRejected,
  type FeeLine,
  type FundingMethod,
  type FundingProviderId,
  type ReportedPayer,
} from '../funding/providers.ts';
import { isSwapRouteId, isUsdcSymbol, swapRoute, swapRouteEnabled, swapRouteLabel, SwapRouteUnavailable, SWAP_ROUTE_IDS } from '../funding/swap-routes.ts';
import { partnerLabel, type PartnerId } from '../partners/signed-partners.ts';
import {
  burnerAddress,
  chainForDomain,
  decodeBurnMessageV2,
  FUNDING_CHAINS,
  FundingPlanError,
  isCircleMessageReceived,
  mintedAmount,
  planFunding,
  type CctpPeerChain,
  type CctpTransfer,
} from '../payments/cctp.ts';
import { quoteConversion, type BookReader, type ConvertibleAsset } from './funding-conversion.ts';
import * as store from './wallet-funding-store.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

// ─── Dependencies ───────────────────────────────────────────────────────────

/** A Sui transaction as funding needs it. */
export type FundingChainTx = {
  digest: string;
  success: boolean;
  sender: string | null;
  timestampMs: number | null;
  balanceChanges: Array<{ address: string; coinType: string; amount: string }>;
  events: Array<{ packageId: string; eventType: string; json: Record<string, unknown> | null }>;
};

export type FundingDeps = {
  db: DrizzleDb;
  /** The session's org. Never from a request. */
  orgId: string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  network: 'mainnet' | 'testnet';
  /** The wallet the org's BusinessAccount names on chain, now. */
  readWallet: () => Promise<string | null>;
  readTransaction: (digest: string) => Promise<FundingChainTx | null>;
  kyt: KytProvider;
  /** The business's registered (legal) name, for "in the company's name". */
  companyName: () => Promise<string | null>;
  coinTypes: { USDC: string; USDT?: string | null; USDSUI?: string | null };
  /** Addresses Splash controls (operator, sponsor, treasury): never a destination. */
  splashAddresses: string[];
  signedPartners: ReadonlySet<PartnerId>;
  bookReader?: BookReader;
  /** Verifies a Sui personal-message signature by `address` (tests inject one). */
  verifySuiSignature?: (message: Uint8Array, signature: string, address: string) => Promise<boolean>;
  /**
   * The deposit watcher's source: every transaction that touched `wallet`,
   * oldest first, a page at a time after `after` (the indexer's cursor; null
   * for the start of the wallet's history). Without it nothing is spendable
   * that the watcher would have to account for.
   */
  listWalletDigests?: (wallet: string, after: string | null) => Promise<{ digests: string[]; cursor: string | null; hasMore: boolean }>;
  /** The business's earlier wallets (before a rotation): a transfer from one is the business's own money moving, not a deposit. */
  earlierWallets?: () => Promise<string[]>;
};

export type Refusal = { ok: false; status: number; code: string; error: string };
const refuse = (status: number, code: string, error: string): Refusal => ({ ok: false, status, code, error });

const INTENT_TTL_MS = 24 * 60 * 60 * 1000;
const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ─── The destination: the business wallet, from chain ───────────────────────

export async function fundingDestination(deps: FundingDeps): Promise<{ ok: true; wallet: string } | Refusal> {
  let wallet: string | null;
  try {
    wallet = await deps.readWallet();
  } catch {
    return refuse(502, 'wallet_unreadable', 'The business wallet could not be read from the chain, so nothing was made.');
  }
  if (!wallet) return refuse(409, 'no_business_wallet', 'This business has no Splash wallet yet. Set one up first; funds only ever go to it.');
  const address = normalizeSuiAddress(wallet);
  if (deps.splashAddresses.some((a) => normalizeSuiAddress(a) === address)) {
    // Cannot happen with a registered multisig; refused all the same (D3).
    return refuse(500, 'destination_refused', 'Funds never go to an address Splash controls. Nothing was made.');
  }
  return { ok: true, wallet: address };
}

// ─── Options ────────────────────────────────────────────────────────────────

const CONVERTIBLE: Record<'USDT' | 'USDSUI', ConvertibleAsset> = { USDT: 'USDT', USDSUI: 'USDSUI' };

export async function fundingOptions(deps: FundingDeps) {
  const dest = await fundingDestination(deps);
  if (!dest.ok) return dest;
  const providers = FUNDING_PROVIDER_IDS.filter((id) => providerEnabled(id, deps.env)).map((id) => {
    let available = true;
    let reason: string | null = null;
    try {
      const adapter = fundingProvider(id, deps.env);
      if (adapter.mode === 'live') {
        // Production: the live adapter refuses until the partner is wired.
        available = false;
        reason = 'Not connected on this server yet.';
      }
    } catch (error) {
      available = false;
      reason = error instanceof Error ? error.message : 'Unavailable.';
    }
    return { id, label: partnerLabel(providerFacts(id).partner, deps.signedPartners), methods: providerFacts(id).methods, available, reason };
  });
  const sources = await store.listSources(deps.db, deps.orgId);
  const held = await store.heldUsdcMinor(deps.db, { orgId: deps.orgId, walletAddress: dest.wallet, usdcType: normalizeStructTag(deps.coinTypes.USDC) });
  return {
    ok: true as const,
    wallet: dest.wallet,
    channels: {
      provider: providers,
      wallet: {
        address: dest.wallet,
        assets: [
          { asset: 'USDC', converts: false },
          ...(deps.coinTypes.USDT ? [{ asset: 'USDT', converts: true }] : []),
          ...(deps.coinTypes.USDSUI ? [{ asset: 'USDSUI', converts: true }] : []),
        ],
      },
      cctp: { chains: (Object.keys(FUNDING_CHAINS) as CctpPeerChain[]).map((c) => ({ chain: c, label: FUNDING_CHAINS[c].label, fast: Boolean(FUNDING_CHAINS[c].fast) })) },
      swap: { routes: SWAP_ROUTE_IDS.filter((r) => swapRouteEnabled(r, deps.env)).map((r) => ({ id: r, label: swapRouteLabel(r) })) },
    },
    sources: sources.map(sourceView),
    heldMinor: held.toString(),
  };
}

// ─── Quotes ─────────────────────────────────────────────────────────────────

export type QuoteInput = {
  channel: FundingChannel;
  /** USDC to arrive (provider, wallet, cctp), as a decimal string. */
  amount?: string;
  provider?: string;
  method?: string;
  /** wallet: the coin sent (USDC, USDT, USDSUI). cctp: USDC or USDT on the source chain. */
  asset?: string;
  sourceChain?: string;
  speed?: string;
  /** swap: the token on the source chain, its decimals and the amount in its own units. */
  fromToken?: string;
  fromDecimals?: number;
  amountIn?: string;
  route?: string;
  slippageBps?: number;
};

export type FundingQuote = {
  channel: FundingChannel;
  destination: string;
  asset: string;
  /** Requested, in USDC minor units (or the source token's units for a swap). */
  amountMinor: string;
  /** The least USDC that reaches the wallet. */
  arrivesMinMinor: string;
  lines: Array<{ payee: FeeLine['payee']; label: string; amountMinor: string }>;
  expiresAt: string | null;
  sandbox: boolean;
  detail: Record<string, unknown>;
};

const line = (l: FeeLine) => ({ payee: l.payee, label: l.label, amountMinor: l.amountMinor.toString() });

export async function quoteFunding(deps: FundingDeps, input: QuoteInput): Promise<{ ok: true; quote: FundingQuote } | Refusal> {
  const dest = await fundingDestination(deps);
  if (!dest.ok) return dest;
  const now = deps.now();
  try {
    switch (input.channel) {
      case 'provider': {
        if (!isFundingProviderId(input.provider)) return refuse(400, 'bad_provider', 'Choose a funding partner.');
        const method = input.method === 'card' ? 'card' : input.method === 'bank' ? 'bank' : null;
        if (!method) return refuse(400, 'bad_method', 'Choose a bank transfer or a card.');
        const amount = amountOrRefuse(input.amount);
        if (!amount.ok) return amount;
        const q = await fundingProvider(input.provider, deps.env).quote({ method, deliverMinor: amount.minor, walletAddress: dest.wallet, now });
        return {
          ok: true,
          quote: {
            channel: 'provider',
            destination: dest.wallet,
            asset: 'USDC',
            amountMinor: amount.minor.toString(),
            arrivesMinMinor: q.deliverMinor.toString(),
            lines: q.lines.map(line),
            expiresAt: q.expiresAt.toISOString(),
            sandbox: q.sandbox,
            detail: { provider: q.provider, label: partnerLabel(providerFacts(q.provider).partner, deps.signedPartners), method: q.method, payUsdCents: q.payUsdCents.toString(), quoteRef: q.quoteRef },
          },
        };
      }
      case 'wallet': {
        const asset = (input.asset ?? 'USDC').toUpperCase();
        const amount = amountOrRefuse(input.amount);
        if (!amount.ok) return amount;
        if (asset === 'USDC') {
          return { ok: true, quote: { channel: 'wallet', destination: dest.wallet, asset, amountMinor: amount.minor.toString(), arrivesMinMinor: amount.minor.toString(), lines: [], expiresAt: null, sandbox: false, detail: { network: 'Sui' } } };
        }
        if (asset !== 'USDT' && asset !== 'USDSUI') return refuse(400, 'bad_asset', 'Send USDC, USDT or USDsui on Sui.');
        if (!deps.coinTypes[asset]) return refuse(400, 'asset_not_accepted', `${asset} is not accepted on this server.`);
        // The conversion's quote is shown first, and the peg guard decides.
        const conv = await quoteConversion({ asset: CONVERTIBLE[asset], amountInMinor: amount.minor, slippageBps: input.slippageBps, now }, deps.bookReader);
        if (!conv.ok) return conv;
        const c = conv.quote;
        return {
          ok: true,
          quote: {
            channel: 'wallet',
            destination: dest.wallet,
            asset,
            amountMinor: amount.minor.toString(),
            arrivesMinMinor: c.minOutMinor.toString(),
            lines: [],
            expiresAt: c.expiresAt.toISOString(),
            sandbox: c.source === 'mock',
            detail: { conversion: { pool: c.pool, rate: c.rate, estimatedOutMinor: c.estimatedOutMinor.toString(), minOutMinor: c.minOutMinor.toString(), slippageBps: c.slippageBps, pegDeviationBps: c.pegDeviationBps.toString(), quoteRef: c.quoteRef } },
          },
        };
      }
      case 'cctp': {
        const chain = (input.sourceChain ?? '').toUpperCase() as CctpPeerChain;
        if (!FUNDING_CHAINS[chain]) return refuse(400, 'bad_chain', 'Choose a chain Circle lists for CCTP V2.');
        const asset = (input.asset ?? 'USDC').toUpperCase();
        if (asset !== 'USDC' && asset !== 'USDT') return refuse(400, 'bad_asset', 'CCTP carries USDC; USDT is swapped to USDC on its own chain first.');
        if (!input.amount || !parseUsdcAmount(input.amount)) return refuse(400, 'bad_amount', 'Enter an amount.');
        if (asset === 'USDT') {
          const peg = await quoteConversion({ asset: 'USDT', amountInMinor: parseUsdcAmount(input.amount)!, now }, deps.bookReader);
          if (!peg.ok) return peg;
        }
        const speed: CctpTransfer = input.speed === 'FAST' ? 'FAST' : 'STANDARD';
        const plan = planFunding({ source: chain, asset: asset as 'USDC' | 'USDT', amount: input.amount, destination: dest.wallet, speed, swapSlippageBps: input.slippageBps });
        if (!plan.available) return refuse(409, 'route_unavailable', plan.reason);
        if (plan.cctp && normalizeSuiAddress(plan.cctp.mintRecipient) !== dest.wallet) return refuse(500, 'destination_refused', 'The mint recipient is not the business wallet. Nothing was made.');
        const circleFee = plan.cctp?.maxFeeMinor ?? 0n;
        return {
          ok: true,
          quote: {
            channel: 'cctp',
            destination: dest.wallet,
            asset,
            amountMinor: plan.amountMinor.toString(),
            arrivesMinMinor: plan.arrivesMinor.toString(),
            lines: circleFee > 0n ? [line({ payee: 'circle', label: 'Circle fast transfer fee, at most', amountMinor: circleFee })] : [],
            expiresAt: null,
            sandbox: false,
            detail: {
              sourceChain: chain,
              transfer: plan.transfer,
              wait: plan.wait,
              steps: plan.steps,
              warnings: plan.warnings,
              cctp: plan.cctp ? { ...plan.cctp, maxFeeMinor: plan.cctp.maxFeeMinor.toString() } : null,
            },
          },
        };
      }
      case 'swap': {
        if (!isSwapRouteId(input.route)) return refuse(400, 'bad_route', 'Choose a swap route.');
        const fromToken = String(input.fromToken ?? '');
        if (isUsdcSymbol(fromToken)) return refuse(400, 'bad_swap', 'USDC needs no swap: send it by CCTP or straight to the wallet.');
        const amountIn = /^\d{1,40}$/.test(String(input.amountIn ?? '')) ? BigInt(String(input.amountIn)) : 0n;
        if (isUsdtLike(fromToken)) {
          const scaled = scaleTo6(amountIn, Number(input.fromDecimals ?? 6));
          const peg = await quoteConversion({ asset: 'USDT', amountInMinor: scaled > 0n ? scaled : 1n, now }, deps.bookReader);
          if (!peg.ok) return peg;
        }
        const q = await swapRoute(input.route, deps.env).quote({
          fromChain: String(input.sourceChain ?? ''),
          fromToken,
          fromDecimals: Number(input.fromDecimals ?? NaN),
          amountIn,
          toAddress: dest.wallet,
          slippageBps: Number(input.slippageBps ?? 50),
          now,
        });
        if (normalizeSuiAddress(q.toAddress) !== dest.wallet) return refuse(500, 'destination_refused', 'The route does not deliver to the business wallet. Nothing was made.');
        return {
          ok: true,
          quote: {
            channel: 'swap',
            destination: dest.wallet,
            asset: q.fromToken,
            amountMinor: q.amountIn.toString(),
            arrivesMinMinor: q.minOutMinor.toString(),
            lines: q.lines.map(line),
            expiresAt: q.expiresAt.toISOString(),
            sandbox: q.sandbox,
            detail: { route: q.route, label: swapRouteLabel(q.route), fromChain: q.fromChain, fromDecimals: q.fromDecimals, estimatedOutMinor: q.estimatedOutMinor.toString(), slippageBps: q.slippageBps, quoteRef: q.quoteRef },
          },
        };
      }
      default:
        return refuse(400, 'bad_channel', 'Choose how to add funds.');
    }
  } catch (error) {
    return adapterRefusal(error);
  }
}

function adapterRefusal(error: unknown): Refusal {
  if (error instanceof FundingProviderUnavailable) return refuse(error.status, error.code, error.message);
  if (error instanceof SwapRouteUnavailable) return refuse(error.status, error.code, error.message);
  if (error instanceof FundingPlanError) return refuse(400, 'bad_plan', error.message);
  throw error;
}

function amountOrRefuse(value: unknown): { ok: true; minor: bigint } | Refusal {
  const minor = parseUsdcAmount(value);
  if (!minor) return refuse(400, 'bad_amount', 'Enter an amount in USDC, up to six decimals.');
  if (minor > MAX_TOP_UP_MINOR) return refuse(400, 'too_large', 'That is more than one top-up can be.');
  return { ok: true, minor };
}

/**
 * Whether a source-chain token is a USDT, for the peg guard: any symbol
 * naming USDT (USDT0, USDT.e, USDt0, axlUSDT, USD₮), not only the exact
 * "USDT". A route's own token list carries no peg, so a wrapped or bridged
 * USDT is guarded like USDT itself.
 */
export function isUsdtLike(symbol: string): boolean {
  return /usd[t₮]/i.test(symbol.normalize('NFKC'));
}

function scaleTo6(amount: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 24) return 0n;
  return decimals >= 6 ? amount / 10n ** BigInt(decimals - 6) : amount * 10n ** BigInt(6 - decimals);
}

// ─── Intents ────────────────────────────────────────────────────────────────

export type IntentInput = QuoteInput & {
  userId: string;
  clientKey: unknown;
  purpose?: 'top_up' | 'transfer_top_up';
  /** Transfer step 3: the transfer this top-up is for. */
  transferRef?: string;
  sourceId?: string;
  /** The least the business accepted when it saw the quote. A fresh quote below it is refused. */
  acceptedArrivesMinMinor?: string;
};

function requestFingerprint(input: IntentInput): string {
  const fields = [input.channel, input.amount, input.provider, input.method, input.asset, input.sourceChain, input.speed, input.fromToken, input.fromDecimals, input.amountIn, input.route, input.sourceId, input.purpose, input.transferRef, input.slippageBps ?? null, input.acceptedArrivesMinMinor ?? null];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/**
 * Where the rate can move between the quote and the order (a partner, a swap
 * route, a USDT or USDsui conversion, USDT over CCTP), the business must send
 * the least it accepted when it saw the quote: the server never prices an
 * intent at a quote nobody was shown.
 */
function acceptedQuoteRequired(input: IntentInput): boolean {
  const asset = String(input.asset ?? 'USDC').toUpperCase();
  if (input.channel === 'provider' || input.channel === 'swap') return true;
  if (input.channel === 'wallet') return asset !== 'USDC';
  if (input.channel === 'cctp') return asset !== 'USDC';
  return false;
}

export async function createFundingIntent(deps: FundingDeps, input: IntentInput) {
  const clientKey = validClientKey(input.clientKey);
  if (!clientKey) return refuse(400, 'idempotency_key_required', 'Send an Idempotency-Key (8 to 80 letters, digits, - or _).');
  const fingerprint = requestFingerprint(input);
  const existing = await store.intentByClientKey(deps.db, deps.orgId, clientKey);
  if (existing) return sameRequestOr409(existing, fingerprint);
  if (acceptedQuoteRequired(input) && (input.acceptedArrivesMinMinor === undefined || input.acceptedArrivesMinMinor === null || input.acceptedArrivesMinMinor === '')) {
    return refuse(400, 'accepted_quote_required', 'Show the quote first, and send the least that arrives as you accepted it.');
  }

  const purpose = input.purpose === 'transfer_top_up' ? 'transfer_top_up' : 'top_up';
  if (purpose === 'transfer_top_up' && !/^[A-Za-z0-9_:-]{4,80}$/.test(input.transferRef ?? '')) {
    return refuse(400, 'transfer_ref_required', 'A top-up for a transfer names the transfer.');
  }

  let sourceId: string | null = null;
  if (input.sourceId) {
    const source = await store.getSource(deps.db, deps.orgId, input.sourceId);
    if (!source) return refuse(404, 'not_found', 'No such funding source.');
    if (source.status === 'rejected' || source.status === 'revoked') return refuse(409, 'source_closed', 'That funding source can no longer be used.');
    const fits = input.channel === 'provider'
      ? (input.method === 'card' ? source.kind === 'card' : source.kind === 'bank_account')
      : source.kind === 'wallet';
    if (!fits) return refuse(400, 'source_mismatch', 'That funding source does not fit this way of adding funds.');
    sourceId = source.id;
  }

  const quoted = await quoteFunding(deps, input);
  if (!quoted.ok) return quoted;
  const quote = quoted.quote;
  if (input.acceptedArrivesMinMinor !== undefined) {
    const accepted = /^\d{1,30}$/.test(String(input.acceptedArrivesMinMinor)) ? BigInt(String(input.acceptedArrivesMinMinor)) : null;
    if (accepted === null) return refuse(400, 'bad_accepted_quote', 'The accepted quote is not a whole number of minor units.');
    if (BigInt(quote.arrivesMinMinor) < accepted) {
      return { ...refuse(409, 'quote_changed', 'The rate moved below the one you accepted. Look at the new quote before going on.'), quote };
    }
  }

  const now = deps.now();
  const id = `fi_${randomUUID()}`;
  const { row, created } = await store.insertIntent(deps.db, {
    id,
    orgId: deps.orgId,
    clientKey,
    channel: input.channel,
    provider: input.channel === 'provider' ? String(input.provider) : input.channel === 'swap' ? String(input.route) : null,
    method: input.channel === 'provider' ? String(input.method) : null,
    sourceId,
    asset: quote.asset,
    sourceChain: input.channel === 'cctp' || input.channel === 'swap' ? String(input.sourceChain ?? '').toUpperCase() : 'SUI',
    amountMinor: BigInt(quote.amountMinor),
    walletAddress: quote.destination,
    quote: { ...quote, requestFingerprint: fingerprint },
    instructions: instructionsFor(quote),
    status: 'awaiting_funds',
    purpose,
    transferRef: input.transferRef ?? null,
    createdBy: input.userId,
    expiresAt: new Date(now.getTime() + INTENT_TTL_MS),
  });
  if (!created) return sameRequestOr409(row, fingerprint);

  if (input.channel !== 'provider') return { ok: true as const, intent: intentView(row), created: true };

  // The partner's order, keyed by the intent id: a retry makes the same order.
  try {
    const adapter = fundingProvider(input.provider as FundingProviderId, deps.env);
    const order = await adapter.createOrder({ intentId: row.id, method: input.method as FundingMethod, deliverMinor: BigInt(quote.arrivesMinMinor), walletAddress: quote.destination, quoteRef: String(quote.detail.quoteRef ?? ''), now });
    const advanced = await store.advanceIntent(deps.db, {
      orgId: deps.orgId,
      id: row.id,
      from: ['awaiting_funds'],
      to: 'provider_pending',
      patch: { providerRef: order.providerRef, instructions: { kind: 'provider', destination: quote.destination, next: order.next, sandbox: order.sandbox } },
      now,
    });
    return { ok: true as const, intent: intentView(advanced ?? row), created: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'the partner refused the order';
    await store.advanceIntent(deps.db, { orgId: deps.orgId, id: row.id, from: ['awaiting_funds'], to: 'failed', patch: { failure: message }, now });
    if (error instanceof FundingProviderUnavailable) return refuse(error.status, error.code, error.message);
    return refuse(502, 'provider_error', 'The funding partner did not take the order. Nothing was charged by Splash.');
  }
}

function sameRequestOr409(row: store.IntentRow, fingerprint: string) {
  const stored = (row.quote as { requestFingerprint?: string } | null)?.requestFingerprint;
  if (stored !== fingerprint) return refuse(409, 'idempotency_key_reused', 'That Idempotency-Key was used for a different top-up.');
  return { ok: true as const, intent: intentView(row), created: false };
}

function instructionsFor(quote: FundingQuote): Record<string, unknown> {
  if (quote.channel === 'wallet') {
    const minor = BigInt(quote.amountMinor);
    const amount = `${minor / 1_000_000n}.${(minor % 1_000_000n).toString().padStart(6, '0')}`;
    return { kind: 'wallet', destination: quote.destination, network: 'Sui', asset: quote.asset, uri: `sui:${quote.destination}?asset=${quote.asset}&amount=${amount}` };
  }
  if (quote.channel === 'cctp') return { kind: 'cctp', destination: quote.destination, ...quote.detail };
  if (quote.channel === 'swap') return { kind: 'swap', destination: quote.destination, ...quote.detail };
  return { kind: 'provider', destination: quote.destination };
}

export async function getFundingIntent(deps: FundingDeps, id: string) {
  const row = await expireIfLapsed(deps, await store.getIntent(deps.db, deps.orgId, id));
  if (!row) return refuse(404, 'not_found', 'No such top-up.');
  const totals = await store.intentUsdcTotals(deps.db, { orgId: deps.orgId, intentId: row.id, usdcType: normalizeStructTag(deps.coinTypes.USDC) });
  return { ok: true as const, intent: { ...intentView(row), progress: { expectedMinMinor: expectedMin(row).toString(), clearedMinor: totals.clearedMinor.toString(), heldMinor: totals.heldMinor.toString() } } };
}

/** The least USDC a top-up promised: its quote's floor, else its amount. */
function expectedMin(row: store.IntentRow): bigint {
  const q = (row.quote as { arrivesMinMinor?: string } | null)?.arrivesMinMinor;
  return q && /^\d+$/.test(q) ? BigInt(q) : row.amountMinor;
}

/**
 * Where a top-up stands after a deposit for it moved: `arrived` once cleared
 * USDC covers the least it promised, `arriving` while anything less (held,
 * blocked, short, or not USDC) has come. Never backwards.
 */
async function refreshIntent(deps: FundingDeps, intentId: string, depositId: string | null): Promise<void> {
  const intent = await store.getIntent(deps.db, deps.orgId, intentId);
  if (!intent) return;
  const totals = await store.intentUsdcTotals(deps.db, { orgId: deps.orgId, intentId, usdcType: normalizeStructTag(deps.coinTypes.USDC) });
  if (totals.count === 0 && !(await store.intentHasDeposits(deps.db, deps.orgId, intentId))) return;
  const target = expectedMin(intent);
  const to: IntentStatus = target > 0n && totals.clearedMinor >= target ? 'arrived' : 'arriving';
  const from = (['awaiting_funds', 'provider_pending', 'arriving', 'failed', 'expired', 'cancelled'] as IntentStatus[]).filter((s) => canAdvanceIntent(s, to));
  await store.advanceIntent(deps.db, { orgId: deps.orgId, id: intentId, from, to, patch: to === 'arrived' && depositId ? { arrivedDepositId: depositId } : {}, now: deps.now() });
}

export async function listFundingIntents(deps: FundingDeps) {
  const rows = await store.listIntents(deps.db, deps.orgId);
  const out = [];
  for (const r of rows) out.push(intentView((await expireIfLapsed(deps, r))!));
  return out;
}

export async function cancelFundingIntent(deps: FundingDeps, id: string) {
  const row = await store.getIntent(deps.db, deps.orgId, id);
  if (!row) return refuse(404, 'not_found', 'No such top-up.');
  if (row.status !== 'awaiting_funds') return refuse(409, 'not_cancellable', 'Only a top-up still waiting for funds can be cancelled here.');
  const done = await store.advanceIntent(deps.db, { orgId: deps.orgId, id, from: ['awaiting_funds'], to: 'cancelled', now: deps.now() });
  return done ? { ok: true as const, intent: intentView(done) } : refuse(409, 'not_cancellable', 'The top-up changed while it was being cancelled.');
}

async function expireIfLapsed(deps: FundingDeps, row: store.IntentRow | null): Promise<store.IntentRow | null> {
  if (!row || !intentIsOpen(row.status as IntentStatus) || row.expiresAt.getTime() > deps.now().getTime()) return row;
  // A partner order may still deliver after this; its arrival is still recorded (by digest) and screened.
  return (await store.advanceIntent(deps.db, { orgId: deps.orgId, id: row.id, from: [row.status as IntentStatus], to: 'expired', now: deps.now() })) ?? row;
}

// ─── Deposits: read from the chain ──────────────────────────────────────────

function assetFor(deps: FundingDeps, coinType: string): ArrivalAsset | null {
  const t = normalizeStructTag(coinType);
  if (t === normalizeStructTag(deps.coinTypes.USDC)) return 'USDC';
  if (deps.coinTypes.USDT && t === normalizeStructTag(deps.coinTypes.USDT)) return 'USDT';
  if (deps.coinTypes.USDSUI && t === normalizeStructTag(deps.coinTypes.USDSUI)) return 'USDSUI';
  return null;
}

function bytesOf(v: unknown): Uint8Array | null {
  if (Array.isArray(v)) return Uint8Array.from(v.map(Number));
  if (typeof v === 'string') {
    if (/^0x[0-9a-fA-F]*$/.test(v)) return fromHex(v);
    try {
      return fromBase64(v);
    } catch {
      return null;
    }
  }
  return null;
}

export type CctpMint =
  | { kind: 'none' }
  /** Exactly one of Circle's mints, to this wallet: who burned, and what Circle minted. */
  | { kind: 'mint'; chain: CctpPeerChain; burner: string | null; mintedMinor: bigint }
  /** Circle's event is there, but it credits nobody: two mints, another recipient, or a body that cannot be read. */
  | { kind: 'unattributable'; reason: string };

/**
 * The CCTP V2 mint in this transaction, from Circle's own MessageReceived
 * only (by the event TYPE's original package, lib/payments/cctp.ts). A mint
 * credits its burner only when there is exactly one, its burn names this
 * wallet as the recipient, and its body reads; it credits at most what
 * Circle minted (amount less feeExecuted). Anything else the transaction
 * moved in is not the burner's.
 */
export function cctpMint(tx: FundingChainTx, network: 'mainnet' | 'testnet', wallet: string): CctpMint {
  const received = tx.events.filter((e) => isCircleMessageReceived(e.eventType, network));
  if (received.length === 0) return { kind: 'none' };
  if (received.length > 1) return { kind: 'unattributable', reason: 'more than one CCTP mint in one transaction' };
  const json = received[0].json ?? {};
  const domain = Number(json.source_domain ?? json.sourceDomain);
  const chain = Number.isInteger(domain) ? chainForDomain(domain) : null;
  if (!chain) return { kind: 'unattributable', reason: 'a source domain Splash does not fund from' };
  const body = bytesOf(json.message_body ?? json.messageBody);
  const burn = body ? decodeBurnMessageV2(body) : null;
  if (!burn) return { kind: 'unattributable', reason: 'the burn message could not be read' };
  let recipient: string;
  try {
    recipient = normalizeSuiAddress(burn.mintRecipient);
  } catch {
    return { kind: 'unattributable', reason: 'the burn names no Sui recipient' };
  }
  if (recipient !== wallet) return { kind: 'unattributable', reason: 'the burn names another recipient' };
  return { kind: 'mint', chain, burner: burnerAddress(chain, burn.messageSender), mintedMinor: mintedAmount(burn) };
}

function sourceChainOf(chain: CctpPeerChain): SourceChain | null {
  const f = FUNDING_CHAINS[chain]?.addressFormat;
  return f === 'EVM' ? 'EVM' : f === 'SOLANA' ? 'SOLANA' : null;
}

async function walletSourceFor(deps: FundingDeps, chain: SourceChain, address: string | null): Promise<store.SourceRow | null> {
  if (!address) return null;
  let fp: string;
  try {
    fp = walletIdentity(chain, address).fingerprint;
  } catch {
    return null;
  }
  return store.sourceByFingerprint(deps.db, deps.orgId, 'wallet', fp);
}

/** The bank account's fingerprints under every configured key (current and previous). Empty without a key. */
function bankFingerprints(deps: FundingDeps, account: { country: string; bankCode: string; accountNumber: string }): string[] {
  const out: string[] = [];
  for (const key of fingerprintKeys(deps.env).all) {
    try {
      out.push(bankAccountIdentity(account, key).fingerprint);
    } catch {
      return [];
    }
  }
  return out;
}

async function payerSourceFor(deps: FundingDeps, intent: store.IntentRow | null, payer: ReportedPayer | undefined): Promise<store.SourceRow | null> {
  if (!payer) return null;
  try {
    if (payer.kind === 'card') {
      const fingerprint = cardIdentity({ provider: intent?.provider ?? '', providerFingerprint: payer.fingerprint, last4: payer.last4 }).fingerprint;
      return store.sourceByFingerprint(deps.db, deps.orgId, 'card', fingerprint);
    }
    // The partner reports the account; Splash keys it here and keeps nothing of the number.
    return store.sourceByFingerprint(deps.db, deps.orgId, 'bank_account', bankFingerprints(deps, payer));
  } catch {
    return null;
  }
}

/** A source's first-use check, run once, on its first deposit. */
async function firstUseCheck(
  deps: FundingDeps,
  source: store.SourceRow,
  facts: { payer?: ReportedPayer; originChain: string | null; originAddress: string | null },
): Promise<store.SourceRow> {
  if (source.firstUseAt || source.status === 'rejected' || source.status === 'revoked') return source;
  const at = deps.now();
  let result: { result: 'passed' | 'failed'; detail: string; promote: boolean } | null = null;
  if (source.kind === 'wallet') {
    if (source.status !== 'verified') return source; // an unproven wallet waits for its signature
    const s = await deps.kyt.screen({ chain: source.chain ?? 'SUI', address: source.address ?? '', direction: 'deposit' });
    if (s.verdict === null) return source; // no answer: check again next time
    result = { result: s.verdict === 'CLEAR' ? 'passed' : 'failed', detail: `screened ${s.provider}: ${s.verdict}`, promote: false };
  } else {
    // A bank account or card: the partner's reported payer must be this source, in the company's name.
    const payer = facts.payer;
    if (!payer) return source;
    const nameOk = sameCompany(payer.holderName, await deps.companyName());
    result = { result: nameOk ? 'passed' : 'failed', detail: nameOk ? 'the payer is the business' : 'the payer’s name is not the business’s', promote: nameOk && source.status === 'pending' };
  }
  const before = source.firstUseAt;
  const row = (await store.recordFirstUse(deps.db, deps.orgId, source.id, { ...result, at })) ?? source;
  if (!before && row.firstUseAt && row.firstUseAt.getTime() === at.getTime()) {
    await store.recordSourceEvent(deps.db, { orgId: deps.orgId, sourceId: source.id, actorUserId: 'system', action: result.result === 'passed' ? 'first_use_passed' : 'first_use_failed', detail: { detail: result.detail, promoted: result.promote }, at });
  }
  return row;
}

export type RecordDepositInput = {
  digest: string;
  intentId?: string;
  /** From a verified partner webhook only. */
  payer?: ReportedPayer;
};

/** One deposit row a transaction makes: who it is attributed to and how much. */
type Part = {
  part: 'arrival' | 'remainder';
  coinType: string;
  asset: ArrivalAsset;
  amount: bigint;
  channel: FundingChannel;
  originChain: string | null;
  originAddress: string | null;
  /** The source the deposit is attributed to, looked up below. */
  lookup: () => Promise<store.SourceRow | null>;
  payerMatchesFor?: (source: store.SourceRow | null) => boolean | undefined;
  originConfirmed?: boolean;
  /** USDC beside a Circle mint that credits nobody: held, whoever sent the transaction. */
  mintUnattributable?: boolean;
  forIntent: boolean;
};

/** The wallet's net change in one coin type in this transaction. */
function netChange(tx: FundingChainTx, wallet: string, coinType: string): bigint {
  let net = 0n;
  for (const bc of tx.balanceChanges) {
    if (normalizeSuiAddress(bc.address) !== wallet || !/^-?\d+$/.test(bc.amount)) continue;
    if (normalizeStructTag(bc.coinType) === coinType) net += BigInt(bc.amount);
  }
  return net;
}

/**
 * Record what a Sui transaction delivered to the business wallet. The
 * caller names a digest; everything else comes from the chain. Each
 * (transaction, coin type, part) is recorded once.
 */
export async function recordDeposit(deps: FundingDeps, input: RecordDepositInput) {
  if (!DIGEST.test(input.digest)) return refuse(400, 'bad_digest', 'That is not a Sui transaction digest.');
  const dest = await fundingDestination(deps);
  if (!dest.ok) return dest;

  let intent: store.IntentRow | null = null;
  if (input.intentId) {
    intent = await store.getIntent(deps.db, deps.orgId, input.intentId);
    if (!intent) return refuse(404, 'not_found', 'No such top-up.');
  }

  let tx: FundingChainTx | null;
  try {
    tx = await deps.readTransaction(input.digest);
  } catch {
    return refuse(502, 'chain_unreadable', 'The transaction could not be read from the chain. Try again shortly.');
  }
  if (!tx) return refuse(404, 'not_on_chain', 'The chain does not know that transaction yet.');
  if (!tx.success) return refuse(409, 'failed_transaction', 'That transaction failed on chain; nothing arrived.');
  return recordTransaction(deps, { tx, wallet: dest.wallet, intent, payer: input.payer });
}

async function recordTransaction(
  deps: FundingDeps,
  input: { tx: FundingChainTx; wallet: string; intent: store.IntentRow | null; payer?: ReportedPayer },
) {
  const { tx, wallet, intent } = input;
  const sender = tx.sender ? normalizeSuiAddress(tx.sender) : null;
  const earlier = new Set(((await deps.earlierWallets?.()) ?? []).map((a) => normalizeSuiAddress(a)));
  if (sender && earlier.has(sender)) {
    // The business's own earlier wallet moving its funds over after a
    // rotation: not a deposit. Its holds already count (by business).
    return refuse(409, 'own_wallet_transfer', 'That is your earlier wallet moving its funds to this one, not a deposit. Funds on hold stay on hold.');
  }

  const arrivals = new Map<string, { asset: ArrivalAsset; amount: bigint }>();
  for (const bc of tx.balanceChanges) {
    if (normalizeSuiAddress(bc.address) !== wallet) continue;
    const asset = assetFor(deps, bc.coinType);
    if (!asset || !/^-?\d+$/.test(bc.amount)) continue;
    const key = normalizeStructTag(bc.coinType);
    arrivals.set(key, { asset, amount: (arrivals.get(key)?.amount ?? 0n) + BigInt(bc.amount) });
  }
  const positive = [...arrivals.entries()].filter(([, v]) => v.amount > 0n);
  if (positive.length === 0) return refuse(409, 'nothing_arrived', 'That transaction delivered no USDC, USDT or USDsui to your wallet.');

  const mint = cctpMint(tx, deps.network, wallet);
  // The sender's own deposit: a plain transfer, or what is left of a mixed CCTP transaction.
  const senderPart = (coinType: string, asset: ArrivalAsset, amount: bigint, part: Part['part'], forIntent: boolean): Part => ({
    part, coinType, asset, amount, channel: 'wallet', originChain: 'SUI', originAddress: sender, lookup: () => walletSourceFor(deps, 'SUI', sender), forIntent,
  });

  const parts: Part[] = [];
  if (intent?.channel === 'provider') {
    // A partner delivers from its own Sui address, or it is not the partner's delivery.
    const senders = isFundingProviderId(intent.provider) ? providerDeliveryAddresses(intent.provider, deps.env) : [];
    if (!sender || !senders.includes(sender)) {
      return refuse(409, 'not_partner_delivery', "That transaction was not sent from the funding partner's own address, so it is not this top-up's delivery.");
    }
    for (const [coinType, { asset, amount }] of positive) {
      parts.push({
        part: 'arrival', coinType, asset, amount, channel: 'provider', originChain: 'SUI', originAddress: sender,
        lookup: () => payerSourceFor(deps, intent, input.payer),
        payerMatchesFor: (s) => (intent.sourceId ? Boolean(s && s.id === intent.sourceId) : undefined),
        forIntent: true,
      });
    }
  } else if (intent?.channel === 'swap') {
    // A route's solver delivers on Sui, so the Sui sender is not the business,
    // and the chain cannot show which wallet paid on the other side. The
    // source the top-up named is recorded, but the deposit is held until the
    // route confirms the origin: naming a proven wallet must not be enough to
    // clear money anyone could have sent.
    for (const [coinType, { asset, amount }] of positive) {
      parts.push({
        part: 'arrival', coinType, asset, amount, channel: 'swap', originChain: 'SUI', originAddress: sender,
        lookup: async () => (intent.sourceId ? store.getSource(deps.db, deps.orgId, intent.sourceId) : null),
        originConfirmed: false,
        forIntent: true,
      });
    }
  } else {
    // A plain report, a wallet top-up or a CCTP top-up: Circle's mint, if
    // there is one, is the burner's up to what Circle minted; the rest is
    // the sender's.
    if (intent?.channel === 'cctp' && mint.kind !== 'mint') {
      return refuse(409, 'not_a_cctp_mint', mint.kind === 'none' ? 'That transaction is not a CCTP mint from Circle.' : `That CCTP mint cannot be attributed: ${mint.reason}.`);
    }
    const usdc = normalizeStructTag(deps.coinTypes.USDC);
    for (const [coinType, { asset, amount }] of positive) {
      if (mint.kind === 'mint' && coinType === usdc) {
        const minted = amount < mint.mintedMinor ? amount : mint.mintedMinor;
        const sc = sourceChainOf(mint.chain);
        if (minted > 0n) {
          parts.push({
            part: 'arrival', coinType, asset, amount: minted, channel: 'cctp', originChain: mint.chain, originAddress: mint.burner,
            lookup: () => (sc ? walletSourceFor(deps, sc, mint.burner) : Promise.resolve(null)),
            forIntent: true,
          });
        }
        if (amount > minted) parts.push(senderPart(coinType, asset, amount - minted, minted > 0n ? 'remainder' : 'arrival', minted === 0n));
      } else if (mint.kind === 'unattributable' && coinType === usdc) {
        // Circle minted in this transaction, but no single burn to this
        // wallet accounts for it, so no burner was screened. The sender's
        // word (even a proven wallet's) does not make it the sender's money.
        parts.push({ ...senderPart(coinType, asset, amount, 'arrival', true), mintUnattributable: true });
      } else {
        parts.push(senderPart(coinType, asset, amount, 'arrival', intent?.channel !== 'cctp'));
      }
    }
    if (intent?.channel === 'wallet' && intent.sourceId) {
      // A top-up that named its source accepts only that source's money.
      const named = await store.getSource(deps.db, deps.orgId, intent.sourceId);
      const intentParts = parts.filter((p) => p.forIntent);
      const fits = named && intentParts.length > 0 && intentParts.every((p) => {
        if (!p.originAddress || !named.address) return false;
        const chain = p.channel === 'cctp' ? sourceChainOf(p.originChain as CctpPeerChain) : 'SUI';
        if (chain !== named.chain) return false;
        try {
          return walletIdentity(chain as SourceChain, p.originAddress).address === named.address;
        } catch {
          return false;
        }
      });
      if (!fits) return refuse(409, 'not_from_named_source', 'That transaction did not come from the funding source this top-up named.');
    }
  }

  const recorded: Array<{ row: store.DepositRow; created: boolean; reattributed: boolean }> = [];
  for (const p of parts) {
    let source = await p.lookup();
    let firstUse = false;
    if (source && !source.firstUseAt) {
      firstUse = true;
      source = await firstUseCheck(deps, source, { payer: input.payer, originChain: p.originChain, originAddress: p.originAddress });
    }
    const screening: KytScreening = p.originAddress
      ? await deps.kyt.screen({ chain: p.originChain ?? 'SUI', address: p.originAddress, direction: 'deposit', txRef: tx.digest })
      : { provider: deps.kyt.id, verdict: null, reference: null, detail: 'There was no sender to screen.', screenedAt: null };
    const decision = decideDeposit({
      source: source ? { status: source.status as 'pending' | 'verified' | 'rejected' | 'revoked', firstUse: (source.firstUseResult as 'passed' | 'failed' | null) ?? null } : null,
      screening,
      payerMatches: p.payerMatchesFor?.(source),
      originConfirmed: p.originConfirmed,
      mintUnattributable: p.mintUnattributable,
    });
    const attach = intent && p.forIntent ? intent.id : null;
    const { row, created } = await store.insertDeposit(deps.db, {
      id: `dep_${randomUUID()}`,
      orgId: deps.orgId,
      walletAddress: wallet,
      suiDigest: tx.digest,
      coinType: p.coinType,
      asset: p.asset,
      amountMinor: p.amount,
      channel: p.channel,
      intentId: attach,
      sourceId: source?.id ?? null,
      sender,
      originChain: p.originChain,
      originAddress: p.originAddress,
      status: decision.status,
      holdReasons: decision.reasons,
      screening,
      firstUse,
      arrivedAt: tx.timestampMs ? new Date(tx.timestampMs) : null,
      part: p.part,
    });
    if (created || !intent || !attach || row.intentId === intent.id || row.intentId !== null) {
      recorded.push({ row, created, reattributed: false });
      continue;
    }
    // Recorded before the top-up was named (by the watcher, or someone who
    // reported the digest first): the top-up is attached now. A partner's
    // verified facts (who paid) replace the first reading only while the
    // deposit is held, only for a delivery already shown to come from the
    // partner's own address (above), only for a row first read as a plain
    // transfer or as this partner's delivery, and only when it covers the
    // order: a webhook cannot turn an arbitrary inflow into verified money.
    const covers = p.asset === 'USDC' && row.amountMinor >= expectedMin(intent);
    if (p.channel === 'provider' && input.payer && row.status === 'held' && (row.channel === 'wallet' || row.channel === 'provider') && covers) {
      const redone = await store.reattributeDeposit(deps.db, {
        orgId: deps.orgId,
        id: row.id,
        channel: p.channel,
        intentId: intent.id,
        sourceId: source?.id ?? null,
        status: decision.status,
        holdReasons: decision.reasons,
        screening,
        firstUse: firstUse || row.firstUse,
        now: deps.now(),
      });
      recorded.push({ row: redone ?? row, created: false, reattributed: Boolean(redone) });
      continue;
    }
    if (row.channel === p.channel) {
      const attached = await store.attachDepositIntent(deps.db, { orgId: deps.orgId, id: row.id, intentId: intent.id, now: deps.now() });
      recorded.push({ row: attached ?? row, created: false, reattributed: Boolean(attached) });
      continue;
    }
    recorded.push({ row, created: false, reattributed: false });
  }

  if (intent && recorded.some((r) => r.row.intentId === intent.id)) {
    const cleared = recorded.find((r) => r.row.intentId === intent.id && r.row.status === 'cleared');
    await refreshIntent(deps, intent.id, cleared?.row.id ?? null);
  }
  return { ok: true as const, deposits: recorded.map((r) => ({ ...depositView(r.row), created: r.created })) };
}

/**
 * Look at a held deposit again: its source may have been verified since, or
 * the screening provider may answer now. Never clears a blocked deposit, and
 * never clears one without a provider's answer.
 */
export async function recheckDeposit(deps: FundingDeps, id: string) {
  const row = await store.getDeposit(deps.db, deps.orgId, id);
  if (!row) return refuse(404, 'not_found', 'No such deposit.');
  if (row.status === 'blocked') return refuse(409, 'blocked', 'This deposit was blocked by screening and stays blocked.');
  if (row.status === 'cleared') return { ok: true as const, deposit: depositView(row) };

  let source = row.sourceId ? await store.getSource(deps.db, deps.orgId, row.sourceId) : null;
  if (!source && row.channel !== 'provider' && row.channel !== 'swap') {
    const chain: SourceChain | null = row.originChain === 'SUI' ? 'SUI' : row.originChain ? sourceChainOf(row.originChain as CctpPeerChain) : null;
    source = chain ? await walletSourceFor(deps, chain, row.originAddress) : null;
  }
  if (source && !source.firstUseAt) source = await firstUseCheck(deps, source, { originChain: row.originChain, originAddress: row.originAddress });
  const prev = row.screening as KytScreening;
  const screening = prev.verdict === 'CLEAR' || prev.verdict === 'BLOCK' || !row.originAddress
    ? prev
    : await deps.kyt.screen({ chain: row.originChain ?? 'SUI', address: row.originAddress, direction: 'deposit', txRef: row.suiDigest });
  const keptMismatch = (row.holdReasons as HoldReason[]).includes('payer_mismatch') ? false : undefined;
  const decision = decideDeposit({
    source: source ? { status: source.status as 'pending' | 'verified', firstUse: (source.firstUseResult as 'passed' | 'failed' | null) ?? null } : null,
    screening,
    payerMatches: keptMismatch,
    originConfirmed: row.channel === 'swap' ? false : undefined,
    // Kept for good: no later fact ties it to one burn.
    mintUnattributable: (row.holdReasons as HoldReason[]).includes('mint_unattributable') || undefined,
  });
  let out: store.DepositRow | null;
  if (decision.status === row.status) {
    out = await store.moveDeposit(deps.db, { orgId: deps.orgId, id, from: ['held'], to: 'held', holdReasons: decision.reasons, screening, sourceId: source?.id ?? null, now: deps.now() });
  } else if (!canMoveDeposit(row.status as 'held', decision.status)) {
    out = row;
  } else {
    out = await store.moveDeposit(deps.db, { orgId: deps.orgId, id, from: ['held'], to: decision.status, holdReasons: decision.reasons, screening, sourceId: source?.id ?? null, now: deps.now() });
  }
  const final = out ?? row;
  if (final.intentId && final.status !== row.status) await refreshIntent(deps, final.intentId, final.status === 'cleared' ? final.id : null);
  return { ok: true as const, deposit: depositView(final) };
}

export async function listWalletDeposits(deps: FundingDeps) {
  return (await store.listDeposits(deps.db, deps.orgId)).map(depositView);
}

// ─── The deposit watcher: holds fail closed ─────────────────────────────────

/** Pages one sync reads before it stops (the next sync goes on from there). */
const SYNC_MAX_PAGES = 40;

/**
 * Read every transaction that touched the business wallet since the last
 * sync, oldest first, and record each arrival as a deposit (screened and
 * held or cleared, exactly as if someone had reported it). Nobody has to
 * report a deposit for it to be screened and, if it must be, held. Also
 * counts the net USDC each transaction moved, so the balance can be checked
 * against what the watcher has accounted for (`walletFundsWithheld`).
 *
 * Safe to run concurrently: a page counts only for the watcher that moves
 * the cursor from where it read it.
 */
export async function syncWalletDeposits(deps: FundingDeps, opts: { wallet?: string } = {}) {
  if (!deps.listWalletDigests) return refuse(503, 'deposits_unreadable', 'Deposits to the wallet cannot be read on this server, so nothing is counted as spendable.');
  let wallet: string;
  if (opts.wallet) wallet = normalizeSuiAddress(opts.wallet);
  else {
    const dest = await fundingDestination(deps);
    if (!dest.ok) return dest;
    wallet = dest.wallet;
  }
  const usdcType = normalizeStructTag(deps.coinTypes.USDC);
  let scanned = 0;
  let recorded = 0;
  for (let page = 0; page < SYNC_MAX_PAGES; page++) {
    const row = await store.syncRow(deps.db, { orgId: deps.orgId, walletAddress: wallet, usdcType });
    let listed: { digests: string[]; cursor: string | null; hasMore: boolean };
    try {
      listed = await deps.listWalletDigests(wallet, row.cursor);
    } catch {
      return refuse(503, 'deposits_unreadable', 'The wallet’s transactions could not be read from the chain, so nothing is counted as spendable.');
    }
    if (listed.digests.length === 0) {
      await store.touchSync(deps.db, { orgId: deps.orgId, walletAddress: wallet, now: deps.now() });
      return { ok: true as const, wallet, scanned, recorded, complete: true };
    }
    if (!listed.cursor) return refuse(503, 'deposits_unreadable', 'The indexer gave no place to continue from, so nothing is counted as spendable.');
    let delta = 0n;
    for (const digest of listed.digests) {
      let tx: FundingChainTx | null;
      try {
        tx = await deps.readTransaction(digest);
      } catch {
        tx = null;
      }
      // Listed by the indexer but not readable from the node yet: stop here, and try again later.
      if (!tx) return refuse(503, 'deposits_unreadable', 'A transaction of the wallet could not be read yet, so nothing is counted as spendable.');
      delta += netChange(tx, wallet, usdcType);
      if (!tx.success) continue;
      const r = await recordTransaction(deps, { tx, wallet, intent: null });
      if (r.ok) recorded += r.deposits.filter((d) => d.created).length;
    }
    const moved = await store.advanceSync(deps.db, { orgId: deps.orgId, walletAddress: wallet, fromCursor: row.cursor, toCursor: listed.cursor, netDeltaMinor: delta, txs: listed.digests.length, now: deps.now() });
    if (!moved) continue; // another watcher counted this page; read on from where it left off
    scanned += listed.digests.length;
    if (!listed.hasMore) return { ok: true as const, wallet, scanned, recorded, complete: true };
  }
  return { ok: true as const, wallet, scanned, recorded, complete: false };
}

/**
 * What a payment out of the wallet may not use, with the balance it read:
 * every held or blocked USDC deposit of the business (at any of its wallets,
 * so a rotation does not release them), plus any USDC the balance shows
 * beyond what the watcher has accounted for (an arrival nobody reported and
 * the indexer has not listed yet is withheld like held money, never spent).
 */
export async function walletFundsWithheld(deps: FundingDeps, balanceMinor: bigint, wallet?: string) {
  const sync = await syncWalletDeposits(deps, { wallet });
  if (!sync.ok) return sync;
  const usdcType = normalizeStructTag(deps.coinTypes.USDC);
  const held = await store.heldUsdcMinor(deps.db, { orgId: deps.orgId, usdcType });
  const row = await store.syncRow(deps.db, { orgId: deps.orgId, walletAddress: sync.wallet, usdcType });
  const unreconciled = balanceMinor > row.netUsdcMinor ? balanceMinor - row.netUsdcMinor : 0n;
  // A read that stopped before the newest transaction has not screened what
  // lies beyond it, and the net so far says nothing about it (an unscreened
  // arrival and a later outflow cancel out). Nothing is spendable until the
  // watcher has caught up; each call reads on from where the last stopped.
  const withheld = sync.complete ? held + unreconciled : balanceMinor > held + unreconciled ? balanceMinor : held + unreconciled;
  return {
    ok: true as const,
    heldMinor: held.toString(),
    unreconciledMinor: unreconciled.toString(),
    withheldMinor: withheld.toString(),
    complete: sync.complete,
  };
}

// ─── Partner webhooks ───────────────────────────────────────────────────────

/**
 * A partner's signed status update. Verified (signature, replay window)
 * before anything is read; matched to its intent by id AND the partner's own
 * order reference; counted once per event id; never moves a status
 * backwards. A delivery is recorded only from the chain, by the digest the
 * partner reports, and only when that transaction was sent from the
 * partner's own Sui address.
 */
export async function handleProviderWebhook(
  input: { provider: string; rawBody: string; signature: string | null; env: NodeJS.ProcessEnv; now: Date; db: DrizzleDb },
  depsFor: (orgId: string) => Promise<FundingDeps | Refusal>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!isFundingProviderId(input.provider)) return { status: 404, body: { error: 'unknown funding partner' } };
  let event;
  try {
    event = fundingProvider(input.provider, input.env).verifyWebhook({ rawBody: input.rawBody, signature: input.signature, now: input.now });
  } catch (error) {
    if (error instanceof WebhookRejected) return { status: 401, body: { error: error.message, code: error.code } };
    if (error instanceof FundingProviderUnavailable) return { status: error.status, body: { error: error.message, code: error.code } };
    throw error;
  }
  if (await store.providerEventSeen(input.db, input.provider, event.eventId)) return { status: 200, body: { duplicate: true } };
  const intent = await store.intentForWebhook(input.db, event.intentId);
  if (!intent || intent.provider !== input.provider || intent.providerRef !== event.providerRef) {
    // Unknown or mismatched orders are acknowledged and ignored: nothing moves.
    return { status: 200, body: { ignored: true } };
  }
  const deps = await depsFor(intent.orgId);
  if ('ok' in deps && deps.ok === false) return { status: deps.status, body: { error: deps.error, code: deps.code } };
  const d = deps as FundingDeps;

  if (event.status === 'pending') {
    if (canAdvanceIntent(intent.status as IntentStatus, 'provider_pending')) {
      await store.advanceIntent(d.db, { orgId: intent.orgId, id: intent.id, from: [intent.status as IntentStatus], to: 'provider_pending', now: input.now });
    }
  } else if (event.status === 'failed') {
    if (canAdvanceIntent(intent.status as IntentStatus, 'failed')) {
      await store.advanceIntent(d.db, { orgId: intent.orgId, id: intent.id, from: [intent.status as IntentStatus], to: 'failed', patch: { failure: 'the partner reported the order failed' }, now: input.now });
    }
  } else {
    if (!event.suiDigest) return { status: 400, body: { error: 'a delivery names its Sui transaction' } };
    const rec = await recordDeposit(d, { digest: event.suiDigest, intentId: intent.id, payer: event.payer });
    // Not on chain yet: ask the partner to retry; the event is not marked seen.
    if (!rec.ok && (rec.code === 'not_on_chain' || rec.code === 'chain_unreadable')) return { status: 503, body: { error: rec.error, code: rec.code } };
    if (!rec.ok) {
      await store.recordProviderEvent(input.db, { provider: input.provider, eventId: event.eventId, orgId: intent.orgId, intentId: intent.id, status: `rejected:${rec.code}` });
      return { status: 200, body: { recorded: false, code: rec.code } };
    }
  }
  await store.recordProviderEvent(input.db, { provider: input.provider, eventId: event.eventId, orgId: intent.orgId, intentId: intent.id, status: event.status });
  return { status: 200, body: { ok: true } };
}

// ─── Funding sources ────────────────────────────────────────────────────────

export type AddSourceInput =
  | { kind: 'bank_account'; holderName: string; country: string; bankCode: string; accountNumber: string; label?: string }
  | { kind: 'card'; provider: string; providerFingerprint: string; last4: string; holderName: string; label?: string }
  | { kind: 'wallet'; chain: string; address: string; label?: string };

export async function addFundingSource(deps: FundingDeps, userId: string, input: AddSourceInput) {
  try {
    const company = await deps.companyName();
    if (input.kind === 'bank_account' || input.kind === 'card') {
      if (!company) return refuse(409, 'no_company_name', 'Your business has no registered name on file yet, so a bank account or card cannot be checked against it.');
      if (!sameCompany(input.holderName, company)) {
        return refuse(400, 'not_company_name', 'A bank account or card must be in the company’s own name.');
      }
    }
    let row: Parameters<typeof store.insertSource>[1];
    const base = { id: `fsrc_${randomUUID()}`, orgId: deps.orgId, status: 'pending', createdBy: userId };
    if (input.kind === 'bank_account') {
      const keys = fingerprintKeys(deps.env);
      if (!keys.current) return refuse(503, 'fingerprint_key_missing', 'Bank accounts cannot be added on this server yet: its fingerprint key is not configured.');
      const id = bankAccountIdentity(input, keys.current);
      // The same account added under an earlier key is the same source.
      const known = await store.sourceByFingerprint(deps.db, deps.orgId, 'bank_account', bankFingerprints(deps, input));
      if (known && known.status !== 'revoked') {
        return known.status === 'rejected' ? refuse(409, 'source_closed', 'That funding source was rejected and cannot be used.') : { ok: true as const, source: sourceView(known), created: false };
      }
      row = { ...base, kind: 'bank_account', fingerprint: id.fingerprint, last4: id.last4, holderName: input.holderName.trim(), label: cleanLabel(input.label) ?? `Bank account ending ${id.last4}`, method: 'company_name' };
    } else if (input.kind === 'card') {
      if (!isFundingProviderId(input.provider)) return refuse(400, 'bad_provider', 'A card is added through a funding partner.');
      const id = cardIdentity(input);
      row = { ...base, kind: 'card', fingerprint: id.fingerprint, last4: id.last4, holderName: input.holderName.trim(), provider: input.provider, label: cleanLabel(input.label) ?? `Card ending ${id.last4}`, method: 'company_name' };
    } else if (input.kind === 'wallet') {
      const chain = String(input.chain).toUpperCase() as SourceChain;
      if (!['SUI', 'SOLANA', 'EVM'].includes(chain)) return refuse(400, 'bad_chain', 'A funding wallet is on Sui, Solana or an EVM chain.');
      const id = walletIdentity(chain, input.address);
      const dest = await fundingDestination(deps);
      if (dest.ok && chain === 'SUI' && id.address === dest.wallet) return refuse(400, 'own_wallet', 'That is the business wallet itself.');
      if (chain === 'SUI' && deps.splashAddresses.some((a) => normalizeSuiAddress(a) === id.address)) return refuse(400, 'splash_address', 'That address is not the business’s.');
      row = { ...base, kind: 'wallet', fingerprint: id.fingerprint, chain, address: id.address, label: cleanLabel(input.label) ?? `${chain === 'EVM' ? 'EVM' : chain === 'SUI' ? 'Sui' : 'Solana'} wallet ${id.address.slice(0, 6)}…${id.address.slice(-4)}`, method: 'wallet_signature' };
    } else {
      return refuse(400, 'bad_kind', 'A funding source is a bank account, a card or a wallet.');
    }
    // A revoked source may be added again: a new pending row, needing fresh proof.
    const { row: stored, created } = await store.insertSource(deps.db, row);
    if (!created && stored.status === 'rejected') {
      return refuse(409, 'source_closed', 'That funding source was rejected and cannot be used.');
    }
    if (created) {
      await store.recordSourceEvent(deps.db, { orgId: deps.orgId, sourceId: stored.id, actorUserId: userId, action: 'added', detail: { kind: stored.kind, label: stored.label, chain: stored.chain, last4: stored.last4 }, at: deps.now() });
    }
    return { ok: true as const, source: sourceView(stored), created };
  } catch (error) {
    if (error instanceof FundingSourceError) return refuse(400, error.code, error.message);
    throw error;
  }
}

function cleanLabel(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const s = label.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
  return s || null;
}

/** The message to sign with a wallet, single-use, valid for 15 minutes. */
export async function walletSourceChallenge(deps: FundingDeps, sourceId: string) {
  const source = await store.getSource(deps.db, deps.orgId, sourceId);
  if (!source || source.kind !== 'wallet') return refuse(404, 'not_found', 'No such funding wallet.');
  if (source.status !== 'pending') return refuse(409, 'not_pending', source.status === 'verified' ? 'This wallet is already verified.' : 'This wallet can no longer be verified.');
  const chain = source.chain as SourceChain;
  if (!walletProofSupported(chain)) {
    return refuse(501, 'proof_not_supported', 'Splash cannot check signatures from EVM wallets yet. Fund from a Sui or Solana wallet, or by bank.');
  }
  const company = (await deps.companyName()) ?? 'this business';
  const now = deps.now();
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = new Date(now.getTime() + WALLET_PROOF_TTL_MS);
  const message = walletProofMessage({ business: company, chain, address: source.address ?? '', nonce, expiresAt });
  const row = await store.insertChallenge(deps.db, { id: `fch_${randomUUID()}`, orgId: deps.orgId, sourceId, message, nonce, expiresAt });
  return { ok: true as const, challenge: { id: row.id, message, expiresAt: expiresAt.toISOString() } };
}

function signatureBytes(signature: string): Uint8Array | null {
  const s = signature.trim();
  try {
    if (/^0x[0-9a-fA-F]+$/.test(s)) return fromHex(s);
    if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return fromBase58(s);
    return fromBase64(s);
  } catch {
    return null;
  }
}

/**
 * Prove the wallet: the challenge is spent first (single-use, even when the
 * signature is wrong), then the signature over its exact message is checked
 * against the source's address.
 */
export async function verifyWalletSource(deps: FundingDeps, input: { userId: string; sourceId: string; challengeId: string; signature: string }) {
  const source = await store.getSource(deps.db, deps.orgId, input.sourceId);
  if (!source || source.kind !== 'wallet') return refuse(404, 'not_found', 'No such funding wallet.');
  if (source.status !== 'pending') return refuse(409, 'not_pending', 'This wallet is not waiting to be verified.');
  const challenge = await store.useChallenge(deps.db, { orgId: deps.orgId, id: input.challengeId, sourceId: source.id, now: deps.now() });
  if (!challenge) return refuse(409, 'challenge_spent', 'That message has expired or was already used. Ask for a new one.');
  const message = new TextEncoder().encode(challenge.message);
  let valid = false;
  try {
    if (source.chain === 'SUI') {
      const verify = deps.verifySuiSignature ?? (async (m: Uint8Array, s: string, a: string) => {
        const { verifyPersonalMessageSignature } = await import('@mysten/sui/verify');
        await verifyPersonalMessageSignature(m, s, { address: a });
        return true;
      });
      valid = await verify(message, input.signature, source.address ?? '');
    } else if (source.chain === 'SOLANA') {
      const sig = signatureBytes(input.signature);
      const { Ed25519PublicKey } = await import('@mysten/sui/keypairs/ed25519');
      valid = Boolean(sig && sig.length === 64 && (await new Ed25519PublicKey(fromBase58(source.address ?? '')).verify(message, sig)));
    }
  } catch {
    valid = false;
  }
  if (!valid) return refuse(400, 'bad_signature', 'The signature does not match this wallet and message.');
  const evidenceSha256 = createHash('sha256').update(`${challenge.message}\n${input.signature}`).digest('hex');
  const verified = await store.updateSource(
    deps.db,
    deps.orgId,
    source.id,
    { status: 'verified', method: 'wallet_signature', verifiedAt: deps.now(), verifiedBy: input.userId, evidenceSha256 },
    ['pending'],
  );
  if (!verified) return refuse(409, 'not_pending', 'This wallet changed while it was being verified.');
  await store.recordSourceEvent(deps.db, { orgId: deps.orgId, sourceId: source.id, actorUserId: input.userId, action: 'verified', evidenceSha256, detail: { method: 'wallet_signature', challengeId: challenge.id }, at: deps.now() });
  // Deposits it already sent, held as unverified, are looked at again.
  for (const d of await store.heldDepositsFromSource(deps.db, deps.orgId, source.id)) await recheckDeposit(deps, d.id);
  return { ok: true as const, source: sourceView(verified) };
}

export async function revokeFundingSource(deps: FundingDeps, sourceId: string, userId: string) {
  const done = await store.updateSource(deps.db, deps.orgId, sourceId, { status: 'revoked', revokedAt: deps.now() }, ['pending', 'verified']);
  if (!done) return refuse(404, 'not_found', 'No such funding source.');
  await store.recordSourceEvent(deps.db, { orgId: deps.orgId, sourceId, actorUserId: userId, action: 'revoked', at: deps.now() });
  return { ok: true as const, source: sourceView(done) };
}

export async function listFundingSources(deps: FundingDeps) {
  return (await store.listSources(deps.db, deps.orgId)).map(sourceView);
}

// ─── Views: what a client sees ──────────────────────────────────────────────

export function sourceView(s: store.SourceRow) {
  return {
    id: s.id,
    kind: s.kind as FundingSourceKind,
    label: s.label,
    status: s.status,
    last4: s.last4,
    chain: s.chain,
    address: s.address,
    provider: s.provider,
    verifiedAt: s.verifiedAt?.toISOString() ?? null,
    firstUse: s.firstUseResult ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

export function intentView(i: store.IntentRow) {
  const quote = { ...((i.quote as Record<string, unknown> | null) ?? {}) };
  delete quote.requestFingerprint;
  return {
    id: i.id,
    channel: i.channel,
    provider: i.provider,
    method: i.method,
    sourceId: i.sourceId,
    asset: i.asset,
    sourceChain: i.sourceChain,
    amountMinor: i.amountMinor.toString(),
    destination: i.walletAddress,
    quote,
    instructions: i.instructions,
    status: i.status,
    purpose: i.purpose,
    transferRef: i.transferRef,
    arrivedDepositId: i.arrivedDepositId,
    failure: i.failure,
    expiresAt: i.expiresAt.toISOString(),
    createdAt: i.createdAt.toISOString(),
  };
}

export function depositView(d: store.DepositRow) {
  const screening = d.screening as KytScreening;
  return {
    id: d.id,
    digest: d.suiDigest,
    asset: d.asset,
    amountMinor: d.amountMinor.toString(),
    channel: d.channel,
    intentId: d.intentId,
    sourceId: d.sourceId,
    originChain: d.originChain,
    originAddress: d.originAddress,
    status: d.status,
    holdReasons: d.holdReasons as HoldReason[],
    screening: { provider: screening.provider, verdict: screening.verdict, reference: screening.reference, screenedAt: screening.screenedAt },
    firstUse: d.firstUse,
    arrivedAt: d.arrivedAt?.toISOString() ?? null,
  };
}
