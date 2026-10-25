/**
 * Funding the Business Splash Wallet ("Add funds", v2 §4.3): the rules, with
 * no I/O. lib/server/wallet-funding.ts runs them against Postgres and the
 * chain.
 *
 * One destination. Every channel delivers USDC (or USDT / USDsui, converted
 * after arrival) to the business's own wallet: the multisig address its
 * BusinessAccount names on chain. Never an address Splash holds a key to or
 * chose (D1, D3). The destination is read from the chain for each request,
 * never taken from the client.
 *
 * Channels:
 *   provider  a funding partner (Halliday, Stripe, TransFi; Bridge stubbed)
 *             takes the business's bank transfer or card payment and delivers
 *             USDC on Sui to the wallet (lib/funding/providers.ts);
 *   wallet    any Sui wallet sends USDC (or USDT / USDsui) to the wallet;
 *   cctp      USDC burned on another chain with CCTP V2 and minted to the
 *             wallet (lib/payments/cctp.ts planFunding, mintRecipient = the
 *             wallet);
 *   swap      a non-USDC token on another chain, routed by Li.Fi or deBridge
 *             to USDC on Sui at the wallet (lib/funding/swap-routes.ts).
 *
 * Funds that arrive are facts read from the chain (a transaction's balance
 * changes), never from a webhook body or a request. A deposit is screened on
 * arrival (lib/compliance/kyt.ts) and attributed to a funding source. A
 * deposit from a source the business has not verified, from no identifiable
 * source, without a screening answer, or failing its source's first-use
 * check is HELD: Splash builds no payment that would spend it
 * (`spendableAfterHolds`). A sanctions hit BLOCKS it for good.
 */

import { createHash, createHmac } from 'node:crypto';

import { fromBase58, normalizeSuiAddress } from '@mysten/sui/utils';

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export const FUNDING_CHANNELS = ['provider', 'wallet', 'cctp', 'swap'] as const;
export type FundingChannel = (typeof FUNDING_CHANNELS)[number];

export const SOURCE_KINDS = ['bank_account', 'card', 'wallet'] as const;
export type FundingSourceKind = (typeof SOURCE_KINDS)[number];

/** pending: added, not yet verified. verified: usable. rejected / revoked: never again. */
export type SourceStatus = 'pending' | 'verified' | 'rejected' | 'revoked';

/**
 * arriving: money came for the top-up, but cleared USDC does not yet cover
 * the least it promised (some is held, or it fell short). arrived: cleared
 * USDC covers it, so Transfer step 3 may go on.
 */
export type IntentStatus = 'awaiting_funds' | 'provider_pending' | 'arriving' | 'arrived' | 'failed' | 'expired' | 'cancelled';

export type DepositStatus = 'held' | 'cleared' | 'blocked';

/** The assets that may arrive. Only USDC is spent; the other two are converted (D6). */
export type ArrivalAsset = 'USDC' | 'USDT' | 'USDSUI';

/** Chains a funding wallet can live on: Sui, or a CCTP V2 / swap source chain. */
export type SourceChain = 'SUI' | 'SOLANA' | 'EVM';

export type HoldReason =
  | 'source_unknown'
  | 'source_unverified'
  | 'first_use_failed'
  | 'payer_mismatch'
  | 'origin_unconfirmed'
  | 'not_screened'
  | 'screening_review';

export const HOLD_REASON_TEXT: Record<HoldReason, string> = {
  source_unknown: 'We could not tell which of your funding sources sent this.',
  source_unverified: 'It came from a funding source your business has not verified yet.',
  first_use_failed: 'The first payment from this source did not match your business.',
  payer_mismatch: 'The payer the provider reported is not the source this top-up named.',
  origin_unconfirmed: 'It came through a swap route, and which wallet sent it on the other chain is not confirmed yet.',
  not_screened: 'It has not been screened yet. It is screened again when you ask.',
  screening_review: 'Screening asked for a closer look before it can be used.',
};

// ─── State machines: no status ever goes backwards ─────────────────────────

/**
 * `arriving` and `arrived` are proven on chain (a transaction delivered to
 * the wallet), so they are reachable from every status before them: money
 * that came after a partner said "failed", after the intent lapsed or after
 * it was cancelled is still there, and still screened. `arrived` needs
 * cleared USDC covering the least the top-up promised; anything less is
 * `arriving`. Nothing leaves `arrived`, `arriving` only moves on to it, and a
 * reported status (pending, failed) never overrides either.
 */
const INTENT_NEXT: Record<IntentStatus, readonly IntentStatus[]> = {
  awaiting_funds: ['provider_pending', 'arriving', 'arrived', 'failed', 'expired', 'cancelled'],
  provider_pending: ['arriving', 'arrived', 'failed', 'expired'],
  arriving: ['arrived'],
  arrived: [],
  failed: ['arriving', 'arrived'],
  expired: ['arriving', 'arrived'],
  cancelled: ['arriving', 'arrived'],
};

export function canAdvanceIntent(from: IntentStatus, to: IntentStatus): boolean {
  return INTENT_NEXT[from]?.includes(to) ?? false;
}

export function intentIsOpen(status: IntentStatus): boolean {
  return status === 'awaiting_funds' || status === 'provider_pending';
}

/**
 * held → cleared once its source is verified and screening clears; held or
 * cleared → blocked on a sanctions hit. Nothing leaves blocked, and nothing
 * goes from cleared back to held.
 */
const DEPOSIT_NEXT: Record<DepositStatus, readonly DepositStatus[]> = {
  held: ['cleared', 'blocked'],
  cleared: ['blocked'],
  blocked: [],
};

export function canMoveDeposit(from: DepositStatus, to: DepositStatus): boolean {
  return DEPOSIT_NEXT[from]?.includes(to) ?? false;
}

// ─── The hold decision ──────────────────────────────────────────────────────

export type SourceFacts = {
  status: SourceStatus;
  /** null until the first deposit from the source has been checked. */
  firstUse: 'passed' | 'failed' | null;
};

export type ScreeningFacts = { verdict: 'CLEAR' | 'BLOCK' | 'REVIEW' | null };

/**
 * Held, cleared or blocked, and why. Pure: the caller has already attributed
 * the deposit to a source (or not), run the source's first-use check if this
 * is its first deposit, and screened the deposit.
 */
export function decideDeposit(input: {
  source: SourceFacts | null;
  screening: ScreeningFacts;
  /** False when a provider's reported payer is not the source the intent named. */
  payerMatches?: boolean;
  /** False when the origin cannot be seen on chain (a swap route's delivery). */
  originConfirmed?: boolean;
}): { status: DepositStatus; reasons: HoldReason[] } {
  if (input.screening.verdict === 'BLOCK') return { status: 'blocked', reasons: [] };
  const reasons: HoldReason[] = [];
  if (!input.source) reasons.push('source_unknown');
  else {
    if (input.source.status !== 'verified') reasons.push('source_unverified');
    if (input.source.firstUse === 'failed') reasons.push('first_use_failed');
  }
  if (input.payerMatches === false) reasons.push('payer_mismatch');
  if (input.originConfirmed === false) reasons.push('origin_unconfirmed');
  if (input.screening.verdict === null) reasons.push('not_screened');
  if (input.screening.verdict === 'REVIEW') reasons.push('screening_review');
  return { status: reasons.length ? 'held' : 'cleared', reasons };
}

/**
 * What a payment out of the wallet may use: its USDC less every held or
 * blocked USDC deposit still in it. Never negative.
 */
export function spendableAfterHolds(balanceMinor: bigint, heldMinor: bigint): bigint {
  const left = balanceMinor - heldMinor;
  return left > 0n ? left : 0n;
}

// ─── Funding sources ────────────────────────────────────────────────────────

const LEGAL_SUFFIXES: Array<[RegExp, string]> = [
  [/\bsendirian berhad\b/g, 'sdn bhd'],
  [/\bsdn\.? ?bhd\.?\b/g, 'sdn bhd'],
  [/\bprivate limited\b/g, 'pte ltd'],
  [/\bpte\.? ?ltd\.?\b/g, 'pte ltd'],
  [/\blimited\b/g, 'ltd'],
  [/\bincorporated\b/g, 'inc'],
  [/\bcorporation\b/g, 'corp'],
  [/\bcompany\b/g, 'co'],
  [/\bperseroan terbatas\b/g, 'pt'],
];

/**
 * A company name as a bank or card network prints it: case, punctuation,
 * accents and spacing folded, and the common legal suffixes written one way.
 * Nothing else is guessed: "Acme Trading" and "Acme" are different names.
 */
export function normalizeCompanyName(name: string): string {
  let s = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [pattern, canonical] of LEGAL_SUFFIXES) s = s.replace(pattern, canonical);
  return s.replace(/\s+/g, ' ').trim();
}

/** Whether a holder name is the business's own name. An empty name is never a match. */
export function sameCompany(holderName: string | null | undefined, companyName: string | null | undefined): boolean {
  const a = normalizeCompanyName(holderName ?? '');
  const b = normalizeCompanyName(companyName ?? '');
  return a.length > 0 && a === b;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export class FundingSourceError extends Error {
  readonly code: string;
  constructor(message: string, code = 'bad_source') {
    super(message);
    this.name = 'FundingSourceError';
    this.code = code;
  }
}

/** The least length of a fingerprint key: 32 characters, random. */
export const FINGERPRINT_KEY_MIN_LENGTH = 32;

/**
 * The server keys bank-account fingerprints are made with:
 * FUNDING_SOURCE_FINGERPRINT_KEY (current, used for new rows) and
 * FUNDING_SOURCE_FINGERPRINT_KEY_PREVIOUS (comma-separated, still matched
 * after a rotation). A key shorter than 32 characters is no key.
 */
export function fingerprintKeys(env: NodeJS.ProcessEnv): { current: string | null; all: string[] } {
  const ok = (k: string) => k.length >= FINGERPRINT_KEY_MIN_LENGTH;
  const current = (env.FUNDING_SOURCE_FINGERPRINT_KEY ?? '').trim();
  const previous = (env.FUNDING_SOURCE_FINGERPRINT_KEY_PREVIOUS ?? '').split(',').map((k) => k.trim()).filter(ok);
  const cur = ok(current) ? current : null;
  return { current: cur, all: [...(cur ? [cur] : []), ...previous.filter((k) => k !== cur)] };
}

/**
 * A bank account's identity without the account number: an HMAC-SHA256 of
 * its country, bank code and number under a server key, and the last four
 * digits. The full number is never stored, and without the key a stored
 * fingerprint cannot be brute-forced back to it (an account number has too
 * few candidates for a plain hash to hide it). A partner reports the payer's
 * account itself; Splash computes the fingerprint on receipt and discards
 * the number.
 */
export function bankAccountIdentity(input: { country: string; bankCode: string; accountNumber: string }, key: string): { fingerprint: string; last4: string } {
  if (!key || key.length < FINGERPRINT_KEY_MIN_LENGTH) throw new FundingSourceError('No bank-account fingerprint key is configured on this server.', 'fingerprint_key_missing');
  const country = String(input.country ?? '').trim().toUpperCase();
  const bankCode = String(input.bankCode ?? '').replace(/\s+/g, '').toUpperCase();
  const number = String(input.accountNumber ?? '').replace(/[\s-]+/g, '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new FundingSourceError('The bank country must be a two-letter code.');
  if (!/^[A-Z0-9]{2,20}$/.test(bankCode)) throw new FundingSourceError('The bank code is not valid.');
  if (!/^[A-Z0-9]{4,34}$/.test(number)) throw new FundingSourceError('The account number is not valid.');
  const mac = createHmac('sha256', key).update(`bank:${country}:${bankCode}:${number}`).digest('hex');
  return { fingerprint: `h1:${mac}`, last4: number.slice(-4) };
}

/** A card, by the fingerprint its provider gives it (never the card number). */
export function cardIdentity(input: { provider: string; providerFingerprint: string; last4: string }): { fingerprint: string; last4: string } {
  const fp = input.providerFingerprint.trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(fp)) throw new FundingSourceError('The card fingerprint is not valid.');
  if (!/^\d{4}$/.test(input.last4)) throw new FundingSourceError('A card is recorded by its last four digits only.');
  return { fingerprint: sha256(`card:${input.provider}:${fp}`), last4: input.last4 };
}

/**
 * A wallet address in the one form Splash compares: Sui 0x + 64 lowercase
 * hex; an EVM address lowercased; a Solana address as base58 of 32 bytes.
 */
export function normalizeSourceAddress(chain: SourceChain, address: string): string {
  const raw = address.trim();
  if (chain === 'SUI') {
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new FundingSourceError('A Sui address is 0x and 64 hex digits.');
    return normalizeSuiAddress(raw);
  }
  if (chain === 'EVM') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new FundingSourceError('An EVM address is 0x and 40 hex digits.');
    return raw.toLowerCase();
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase58(raw);
  } catch {
    throw new FundingSourceError('That is not a Solana address.');
  }
  if (bytes.length !== 32) throw new FundingSourceError('A Solana address is 32 bytes.');
  return raw;
}

export function walletIdentity(chain: SourceChain, address: string): { fingerprint: string; address: string } {
  const normalized = normalizeSourceAddress(chain, address);
  return { fingerprint: sha256(`wallet:${chain}:${normalized}`), address: normalized };
}

/** How long a wallet-ownership challenge may be signed for. */
export const WALLET_PROOF_TTL_MS = 15 * 60 * 1000;

/**
 * The fixed message a business signs with a wallet to prove it controls it.
 * It names the business, the chain and the address, and carries a single-use
 * nonce and an expiry, so a signature cannot be replayed for another
 * business, another address or later.
 */
export function walletProofMessage(input: { business: string; chain: SourceChain; address: string; nonce: string; expiresAt: Date }): string {
  return [
    'Splash funding source',
    `I confirm that ${input.business} controls this wallet and will fund its Splash wallet from it.`,
    `Chain: ${input.chain}`,
    `Address: ${input.address}`,
    `Nonce: ${input.nonce}`,
    `Expires: ${input.expiresAt.toISOString()}`,
  ].join('\n');
}

/** Which chains' wallet signatures Splash can verify today. */
export function walletProofSupported(chain: SourceChain): boolean {
  return chain === 'SUI' || chain === 'SOLANA';
}

// ─── Amounts ────────────────────────────────────────────────────────────────

/** A positive USDC amount in minor units (6 decimals) from a decimal string, or null. */
export function parseUsdcAmount(value: unknown): bigint | null {
  const s = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  const minor = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
  return minor > 0n ? minor : null;
}

/** The most one top-up may ask for: 10 million USDC. */
export const MAX_TOP_UP_MINOR = 10_000_000n * 1_000_000n;

/** A client idempotency key: what the browser sends so a retried click opens nothing new. */
export function validClientKey(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value) ? value : null;
}
