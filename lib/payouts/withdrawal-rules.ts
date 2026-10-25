/**
 * The rules of a withdrawal to the business's own bank (v2 §4.4), with no I/O.
 *
 *   status      what a withdrawal can move to, never backwards
 *   sealing     the account number and the salts kept at rest: AES-256-GCM
 *               under WITHDRAWAL_ACCOUNT_KEY, bound (as associated data) to
 *               the org and the row, so a sealed value moved to another row or
 *               another business does not open
 *   beneficiary the stable commitment (`beneficiary_ref`) a bank-payout
 *               intent carries, recomputed from the very fields the partner is
 *               sent; the instruction is refused when they differ
 *   intent id   the id `payment_intent::create_for_wallet` claims for a
 *               payment_ref (derived_object), so the instruction can be keyed
 *               by it before the intent exists
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { bcs } from '@mysten/sui/bcs';
import { deriveObjectID, normalizeSuiAddress } from '@mysten/sui/utils';

import { beneficiaryCommitment, toHex } from '../evidence/commitment.ts';
import { isProductionRuntime } from '../server/runtime-mode.ts';
import type { PayoutBeneficiary, PayoutPartnerId } from './partner.ts';

export type WithdrawalStatus = 'preparing' | 'awaiting_signatures' | 'sent' | 'partner_received' | 'paid_out' | 'failed' | 'returned' | 'cancelled';

const NEXT: Record<WithdrawalStatus, readonly WithdrawalStatus[]> = {
  preparing: ['awaiting_signatures', 'cancelled'],
  awaiting_signatures: ['sent', 'cancelled'],
  sent: ['partner_received', 'paid_out', 'failed'],
  partner_received: ['paid_out', 'failed'],
  failed: ['returned'],
  paid_out: [],
  returned: [],
  cancelled: [],
};

/** Whether a withdrawal may move from `from` to `to`. Nothing goes backwards; paid out, returned and cancelled are final. */
export function canAdvanceWithdrawal(from: WithdrawalStatus, to: WithdrawalStatus): boolean {
  return NEXT[from].includes(to);
}

/** Final: nothing more happens to it. */
export function withdrawalIsFinal(status: WithdrawalStatus): boolean {
  return NEXT[status].length === 0;
}

/** The test deposit that verifies a partner deposit address: 1 USDC. */
export const TEST_DEPOSIT_MINOR = 1_000_000n;
/** At most 1,000,000 USDC in one withdrawal; the tier ceilings on chain bind first. */
export const MAX_WITHDRAWAL_MINOR = 1_000_000n * 1_000_000n;
/** A withdrawal intent lives a day. */
export const WITHDRAWAL_INTENT_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long the owners have to sign a withdrawal: its `settle_by`. The
 * partner's quote holds five minutes, which no multisig quorum can be held
 * to, so the quote is NOT the deadline. The policy (docs/v2/phase2-withdrawals.md,
 * "The rate and the signing window"): the owners accept a least receive
 * amount; the partner converts at its rate when the deposit lands and pays at
 * least that, or treats the payout as failed and returns the USDC to the
 * business wallet. The window is the intent's own lifetime.
 */
export const WITHDRAWAL_SIGNING_WINDOW_MS = WITHDRAWAL_INTENT_TTL_MS;

export class WithdrawalRuleError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'WithdrawalRuleError';
    this.code = code;
  }
}

// ─── Sealing ────────────────────────────────────────────────────────────────

/** The least length of the sealing key: 32 characters, random. */
export const ACCOUNT_KEY_MIN_LENGTH = 32;

function deriveAccountKey(raw: string): Buffer | null {
  const v = raw.trim();
  if (v.length < ACCOUNT_KEY_MIN_LENGTH) return null;
  return createHash('sha256').update(`splash:withdrawal-account:v1:${v}`).digest();
}

/** The sealing key, or null (no bank account can be added or paid). */
export function accountKey(env: NodeJS.ProcessEnv): Buffer | null {
  return deriveAccountKey(env.WITHDRAWAL_ACCOUNT_KEY ?? '');
}

/**
 * The sealing keys: `current` seals, `all` opens (current first, then each
 * of WITHDRAWAL_ACCOUNT_KEY_PREVIOUS, comma-separated). Rotation: set the new
 * key, move the old one to _PREVIOUS; a value opened with an old key is
 * sealed again under the new one when it is next used, and _PREVIOUS can be
 * cleared once nothing opens with it.
 */
export function accountKeys(env: NodeJS.ProcessEnv): { current: Buffer | null; all: Buffer[] } {
  const current = accountKey(env);
  const previous = String(env.WITHDRAWAL_ACCOUNT_KEY_PREVIOUS ?? '')
    .split(',')
    .map((v) => deriveAccountKey(v))
    .filter((k): k is Buffer => k !== null);
  const all = current ? [current, ...previous.filter((k) => !k.equals(current))] : [];
  return { current, all };
}

/** `v1.<iv>.<tag>.<ciphertext>`, base64url, bound to `aad`. */
export function seal(plain: Uint8Array | string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : Buffer.from(plain)), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function open(sealed: string, key: Buffer, aad: string): Buffer {
  const [v, iv, tag, body] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || body === undefined) throw new WithdrawalRuleError('A sealed value could not be read.', 'sealed_unreadable');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]);
  } catch {
    throw new WithdrawalRuleError('A sealed value does not open with this key for this record.', 'sealed_unreadable');
  }
}

/** Open with the first key that opens it; `rotated` when that was not the current key. */
export function openWithAny(sealed: string, keys: Buffer[], aad: string): { plain: Buffer; rotated: boolean } {
  for (let i = 0; i < keys.length; i++) {
    try {
      return { plain: open(sealed, keys[i], aad), rotated: i > 0 };
    } catch {
      /* the next key */
    }
  }
  throw new WithdrawalRuleError('A sealed value does not open with any key for this record.', 'sealed_unreadable');
}

/** What a destination's sealed fields are bound to. */
export const destinationAad = (orgId: string, destinationId: string, field: 'account' | 'salt' | 'party') => `withdrawal_destination:${orgId}:${destinationId}:${field}`;
export const withdrawalAad = (orgId: string, withdrawalId: string) => `withdrawal:${orgId}:${withdrawalId}:commitment_salt`;

// ─── The beneficiary ────────────────────────────────────────────────────────

/** A bank account as the partner is sent it: folded the way banks print it. */
export function normalizeBeneficiary(b: PayoutBeneficiary): PayoutBeneficiary {
  const country = String(b.country ?? '').trim().toUpperCase();
  const bankCode = String(b.bankCode ?? '').replace(/\s+/g, '').toUpperCase();
  const accountNumber = String(b.accountNumber ?? '').replace(/[\s-]+/g, '').toUpperCase();
  const holderName = String(b.holderName ?? '').replace(/\s+/g, ' ').trim();
  if (!/^[A-Z]{2}$/.test(country)) throw new WithdrawalRuleError('The bank country must be a two-letter code.', 'bad_destination');
  if (!/^[A-Z0-9]{2,20}$/.test(bankCode)) throw new WithdrawalRuleError('The bank code is not valid.', 'bad_destination');
  if (!/^[A-Z0-9]{4,34}$/.test(accountNumber)) throw new WithdrawalRuleError('The account number is not valid.', 'bad_destination');
  if (holderName.length < 2 || holderName.length > 140) throw new WithdrawalRuleError('The account holder name is needed.', 'bad_destination');
  return { country, bankCode, accountNumber, holderName };
}

/** `beneficiary_ref`: the commitment over exactly what the partner pays, salted with the destination's own secret. */
export function beneficiaryRefOf(partner: PayoutPartnerId, b: PayoutBeneficiary, salt: Uint8Array): string {
  const n = normalizeBeneficiary(b);
  return toHex(beneficiaryCommitment({ partner, country: n.country, bankCode: n.bankCode, accountNumber: n.accountNumber, holderName: n.holderName }, salt));
}

/**
 * The instruction's beneficiary, only if it is the one the intent commits to.
 * The partner is never sent an account the intent's `beneficiary_ref` does not
 * name (fees.md, "the partner payout-instruction API").
 */
export function assertBeneficiaryMatches(partner: PayoutPartnerId, b: PayoutBeneficiary, salt: Uint8Array, intentBeneficiaryRef: string): PayoutBeneficiary {
  const recomputed = beneficiaryRefOf(partner, b, salt);
  if (recomputed !== intentBeneficiaryRef.toLowerCase().replace(/^0x/, '')) {
    throw new WithdrawalRuleError('The bank account the partner would be sent is not the one this withdrawal commits to. Nothing was sent.', 'beneficiary_mismatch');
  }
  return normalizeBeneficiary(b);
}

// ─── The intent id ──────────────────────────────────────────────────────────

/**
 * The id `payment_intent::create_for_wallet` gives the intent it opens for
 * `paymentRef`: `derived_object::claim(account, PaymentRef(payment_ref))`.
 * `corePackageId` is splash_core's ORIGINAL (defining) id, which a struct
 * type keeps across upgrades.
 */
export function withdrawalIntentId(input: { accountId: string; corePackageId: string; paymentRef: Uint8Array }): string {
  if (input.paymentRef.length !== 32) throw new WithdrawalRuleError('A payment reference is 32 bytes.', 'bad_payment_ref');
  const key = bcs.vector(bcs.u8()).serialize(Array.from(input.paymentRef)).toBytes();
  return normalizeSuiAddress(deriveObjectID(normalizeSuiAddress(input.accountId), `${normalizeSuiAddress(input.corePackageId)}::payment_intent::PaymentRef`, key));
}

/** A hash of what a withdrawal request asked for: a reused idempotency key must ask for the same thing. */
export function withdrawalRequestHash(input: { destinationId: string; amountMinor: bigint; acceptedReceiveMinor: bigint; maxFeeMinor: bigint }): string {
  return createHash('sha256').update(`${input.destinationId}|${input.amountMinor}|${input.acceptedReceiveMinor}|${input.maxFeeMinor}`).digest('hex');
}

/**
 * splash_core's ORIGINAL (defining) package id, the type tag the intent id is
 * derived under. In production it must be named explicitly: after the first
 * upgrade the current package id gives another id, one the chain never
 * creates, and the partner could not match the deposit. Outside production
 * the current id stands in (before any upgrade the two are the same).
 */
export function corePackageOriginalIdFor(env: NodeJS.ProcessEnv): string | null {
  const ok = (v: string | undefined) => (/^0x[0-9a-fA-F]{64}$/.test((v ?? '').trim()) ? normalizeSuiAddress((v ?? '').trim()) : null);
  const original = ok(env.SPLASH_CORE_ORIGINAL_PACKAGE_ID);
  if (original) return original;
  return isProductionRuntime(env) ? null : ok(env.SPLASH_CORE_PACKAGE_ID);
}

/** The intent ids an executed transaction's `payment_intent::IntentCreated` events name, for this package only. */
export function createdIntentIds(events: ReadonlyArray<{ eventType: string; json: unknown }>, corePackageOriginalId: string): string[] {
  const type = `${normalizeSuiAddress(corePackageOriginalId)}::payment_intent::IntentCreated`;
  const out: string[] = [];
  for (const e of events) {
    let t: string;
    try {
      const [addr, ...rest] = e.eventType.split('::');
      t = [normalizeSuiAddress(addr), ...rest].join('::');
    } catch {
      continue;
    }
    if (t !== type) continue;
    const id = (e.json as { intent_id?: unknown } | null)?.intent_id;
    if (typeof id === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(id)) out.push(normalizeSuiAddress(id));
  }
  return out;
}

/**
 * Every address Splash controls that must never be a deposit address: the
 * operator, the treasury, the test recipient, the gas sponsor, and FeeConfig's
 * fee recipient and pending recipient (read live by the caller).
 */
export function splashControlledAddresses(input: {
  env: NodeJS.ProcessEnv;
  sponsor?: string | null;
  feeConfig: { feeRecipient: string | null; pendingRecipient: { recipient: string } | null };
}): string[] {
  const raw = [
    input.env.OPERATOR_SUI_ADDRESS,
    input.env.TREASURY_ADDRESS,
    input.env.SPLASH_TEST_RECIPIENT_ADDRESS,
    input.sponsor ?? undefined,
    input.feeConfig.feeRecipient ?? undefined,
    input.feeConfig.pendingRecipient?.recipient,
  ];
  const out = new Set<string>();
  for (const a of raw) {
    if (typeof a === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(a.trim())) out.add(normalizeSuiAddress(a.trim()));
  }
  return [...out];
}

/**
 * Who may ASK for a withdrawal (Sky's decision: staff may ask owners to
 * approve). Asking opens the owners' signing request; only the owners' quorum
 * signs it. Bank accounts and the deposit address stay owner-only.
 */
export function canAskForWithdrawal(role: string): boolean {
  return role === 'OWNER' || role === 'APPROVER' || role === 'MAKER';
}
