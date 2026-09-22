/**
 * Commitments: what an event carries instead of the payment.
 *
 * `splash_core` publishes immutable, so an event struct's fields freeze at
 * publish. Until WS5 the payment lifecycle events carried the payment in
 * cleartext: sender, recipient, amount, currency, rate, beneficiary
 * reference. Now they carry a 32-byte commitment,
 *
 *     commitment = blake2b256( DOMAIN_TAG || bcs(payload) || salt )
 *
 * computed here, off-chain, before the intent is opened. Move asserts the
 * length and carries the bytes; it never sees the payload or the salt.
 *
 * The salt is mandatory. Amounts are small numbers, addresses are public,
 * and without 32 unpredictable bytes a commitment over them is a lookup
 * table. The salt is drawn once per payment, written only into the Seal
 * bundle beside the payload, and never logged or emitted. Whoever the Seal
 * policy admits to the bundle can recompute the commitment and check it
 * against the chain with `scripts/verify-commitment.mjs`; nobody else can
 * learn anything from the 32 bytes.
 *
 * Field order is fixed and documented in docs/commitments.md. The domain
 * tag is per commitment family: every lifecycle event of one payment
 * (created, confirmed, canceled, anchored, approved, approval consumed)
 * carries the payment's commitment, and a receipt carries the receipt's.
 *
 * What this does not hide: the base-layer coin transfer still shows sender,
 * recipient and amount. This removes Splash's business metadata, not the
 * transfer. See SECURITY.md.
 */
import { randomBytes } from 'node:crypto';

import { bcs } from '@mysten/sui/bcs';
import { blake2b } from '@noble/hashes/blake2.js';

/** A commitment is thirty-two bytes. Move asserts the same (E_BAD_COMMITMENT). */
export const COMMITMENT_BYTES = 32;
/** The salt is thirty-two CSPRNG bytes, drawn once per payment. */
export const SALT_BYTES = 32;

export const DOMAIN_TAGS = {
  /** Every lifecycle event of one payment intent. */
  payment: 'splash:payment:v1',
  /** A minted receipt (receipt_v2). */
  receipt: 'splash:receipt:v1',
} as const;
export type DomainTag = (typeof DOMAIN_TAGS)[keyof typeof DOMAIN_TAGS];

/** The documented BCS field order of a payment commitment. */
export const PAYMENT_PAYLOAD_FIELDS = [
  'sender',
  'recipient',
  'beneficiary_ref',
  'amount',
  'currency',
  'corridor',
  'target_currency',
  'fx_rate_usd_local',
] as const;

/** The documented BCS field order of a receipt commitment. */
export const RECEIPT_PAYLOAD_FIELDS = [
  'receipt_id',
  'sender',
  'recipient',
  'amount_usd',
  'target_currency',
  'target_amount',
  'fx_rate_usd_local',
  'tx_digest',
] as const;

/** What a payment's lifecycle events commit to. Integers may arrive as bigint, safe number or decimal string. */
export type PaymentCommitmentPayload = {
  /** The intent's sender: the address that opens and settles it. */
  sender: string;
  /** The on-chain recipient of the settlement coin. */
  recipient: string;
  /** The verified counterparty reference, UTF-8; empty when the path carries none. */
  beneficiaryRef: string;
  /** Minor units of the settlement asset, as the intent stores it. */
  amount: bigint | number | string;
  /** The settlement asset, e.g. `0x2::sui::SUI`; empty when the path carries none. */
  currency: string;
  /** The corridor tag, e.g. `MY-PH`; empty when the path carries none. */
  corridor: string;
  /** The payout currency, e.g. `PHP`. */
  targetCurrency: string;
  /** USD to local rate, scaled by 1e6, as the intent stores it. */
  fxRateUsdLocal: bigint | number | string;
};

export type ReceiptCommitmentPayload = {
  receiptId: string;
  sender: string;
  recipient: string;
  amountUsd: bigint | number | string;
  targetCurrency: string;
  targetAmount: bigint | number | string;
  fxRateUsdLocal: bigint | number | string;
  txDigest: string;
};

const PaymentLayout = bcs.struct('PaymentCommitmentPayload', {
  sender: bcs.Address,
  recipient: bcs.Address,
  beneficiary_ref: bcs.vector(bcs.u8()),
  amount: bcs.u64(),
  currency: bcs.string(),
  corridor: bcs.string(),
  target_currency: bcs.string(),
  fx_rate_usd_local: bcs.u64(),
});

const ReceiptLayout = bcs.struct('ReceiptCommitmentPayload', {
  receipt_id: bcs.string(),
  sender: bcs.Address,
  recipient: bcs.Address,
  amount_usd: bcs.u64(),
  target_currency: bcs.string(),
  target_amount: bcs.u64(),
  fx_rate_usd_local: bcs.u64(),
  tx_digest: bcs.string(),
});

const U64_MAX = (1n << 64n) - 1n;

function u64(value: bigint | number | string, name: string): bigint {
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer, got ${value}`);
    parsed = BigInt(value);
  } else if (typeof value === 'string' && /^\d+$/.test(value)) parsed = BigInt(value);
  else throw new RangeError(`${name} must be an unsigned integer, got ${String(value)}`);
  if (parsed < 0n || parsed > U64_MAX) throw new RangeError(`${name} is outside u64`);
  return parsed;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** BCS bytes of a payment payload, in the documented order. */
export function encodePaymentPayload(payload: PaymentCommitmentPayload): Uint8Array {
  return PaymentLayout.serialize({
    sender: payload.sender,
    recipient: payload.recipient,
    beneficiary_ref: Array.from(utf8(payload.beneficiaryRef ?? '')),
    amount: u64(payload.amount, 'amount'),
    currency: payload.currency ?? '',
    corridor: payload.corridor ?? '',
    target_currency: payload.targetCurrency,
    fx_rate_usd_local: u64(payload.fxRateUsdLocal, 'fx_rate_usd_local'),
  }).toBytes();
}

/** BCS bytes of a receipt payload, in the documented order. */
export function encodeReceiptPayload(payload: ReceiptCommitmentPayload): Uint8Array {
  return ReceiptLayout.serialize({
    receipt_id: payload.receiptId,
    sender: payload.sender,
    recipient: payload.recipient,
    amount_usd: u64(payload.amountUsd, 'amount_usd'),
    target_currency: payload.targetCurrency,
    target_amount: u64(payload.targetAmount, 'target_amount'),
    fx_rate_usd_local: u64(payload.fxRateUsdLocal, 'fx_rate_usd_local'),
    tx_digest: payload.txDigest,
  }).toBytes();
}

/** Thirty-two bytes from the operating system's CSPRNG. One per payment. */
export function newSalt(): Uint8Array {
  return new Uint8Array(randomBytes(SALT_BYTES));
}

export function assertSaltBytes(salt: Uint8Array): void {
  if (!(salt instanceof Uint8Array) || salt.length !== SALT_BYTES) {
    throw new RangeError(`a salt is ${SALT_BYTES} bytes, got ${salt?.length ?? 'none'}`);
  }
}

/** The check Move makes, made here first so a bad value never reaches a transaction. */
export function assertCommitmentBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== COMMITMENT_BYTES) {
    throw new RangeError(`a commitment is ${COMMITMENT_BYTES} bytes, got ${bytes?.length ?? 'none'}`);
  }
}

/** blake2b256(tag || payload || salt). The tag separates commitment families. */
export function commitmentBytes(tag: string, payload: Uint8Array, salt: Uint8Array): Uint8Array {
  if (!tag) throw new RangeError('a commitment needs a domain tag');
  assertSaltBytes(salt);
  const out = blake2b(concat(utf8(tag), payload, salt), { dkLen: COMMITMENT_BYTES });
  assertCommitmentBytes(out);
  return out;
}

export function paymentCommitment(payload: PaymentCommitmentPayload, salt: Uint8Array): Uint8Array {
  return commitmentBytes(DOMAIN_TAGS.payment, encodePaymentPayload(payload), salt);
}

export function receiptCommitment(payload: ReceiptCommitmentPayload, salt: Uint8Array): Uint8Array {
  return commitmentBytes(DOMAIN_TAGS.receipt, encodeReceiptPayload(payload), salt);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new RangeError('not hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * A `vector<u8>` as Sui's JSON renders it in `parsedJson`: an array of
 * numbers. Hex and base64 strings are accepted too, for fixtures and other
 * indexers. Null when the value is none of those.
 */
export function commitmentFromEventField(value: unknown): Uint8Array | null {
  if (Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) {
    return new Uint8Array(value as number[]);
  }
  if (typeof value === 'string') {
    const hex = value.startsWith('0x') ? value.slice(2) : value;
    if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) return fromHex(hex);
    try {
      const decoded = Buffer.from(value, 'base64');
      if (decoded.length > 0 && decoded.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '')) {
        return new Uint8Array(decoded);
      }
    } catch {
      return null;
    }
  }
  return null;
}
