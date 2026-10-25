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
/** A withdrawal intent lives a day; its quote holds five minutes. */
export const WITHDRAWAL_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

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

/** The sealing key, or null (no bank account can be added or paid). */
export function accountKey(env: NodeJS.ProcessEnv): Buffer | null {
  const raw = (env.WITHDRAWAL_ACCOUNT_KEY ?? '').trim();
  if (raw.length < ACCOUNT_KEY_MIN_LENGTH) return null;
  return createHash('sha256').update(`splash:withdrawal-account:v1:${raw}`).digest();
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

/** What a destination's sealed fields are bound to. */
export const destinationAad = (orgId: string, destinationId: string, field: 'account' | 'salt') => `withdrawal_destination:${orgId}:${destinationId}:${field}`;
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
