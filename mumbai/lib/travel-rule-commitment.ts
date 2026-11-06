/**
 * The travel-rule commitment.
 *
 * A 32-byte salted hash of the travel-rule record Splash already builds
 * offchain. Only the hash goes onchain, on every chain, so one payment can be
 * followed across Sepolia, Arc and Sui by a single value.
 *
 * The scheme reproduces `latest-splash`'s `lib/evidence/commitment.ts` exactly:
 *
 *     commitment = blake2b256( utf8(tag) || bcs(payload) || salt )
 *
 * with a 32-byte salt and fixed-order BCS encoding. The domain tag separates
 * commitment families, so a travel-rule commitment can never collide with a
 * payment or receipt commitment even on identical bytes.
 *
 * The beneficiary institution recomputes this value from the record and the
 * salt it received offchain. That recomputation is what its acknowledgement
 * proves: it holds the record, not merely the hash.
 */
import { bcs } from '@mysten/bcs';
import { blake2b } from '@noble/hashes/blake2.js';
import { randomBytes } from 'node:crypto';

export const DOMAIN_TAG = 'splash:travel-rule:v1';
export const COMMITMENT_BYTES = 32;
export const SALT_BYTES = 32;

/**
 * A travel-rule record, in the order it is committed.
 *
 * Field order is part of the scheme: BCS is not self-describing, so a reordered
 * struct hashes differently and the beneficiary's recomputation would not match.
 */
export const TravelRuleLayout = bcs.struct('TravelRuleCommitmentPayload', {
  payment_ref: bcs.string(),
  originator_name: bcs.string(),
  originator_identifier: bcs.string(),
  originator_account: bcs.string(),
  originator_country: bcs.string(),
  beneficiary_name: bcs.string(),
  beneficiary_identifier: bcs.string(),
  beneficiary_account: bcs.string(),
  beneficiary_agent: bcs.string(),
  beneficiary_country: bcs.string(),
  purpose_code: bcs.string(),
  amount: bcs.u64(),
  currency: bcs.string(),
  corridor: bcs.string(),
});

export type TravelRuleRecord = {
  /** Splash's own payment reference. Never the CCIP message id: that exists only after the send. */
  paymentRef: string;
  originatorName: string;
  originatorIdentifier: string;
  originatorAccount: string;
  originatorCountry: string;
  beneficiaryName: string;
  beneficiaryIdentifier: string;
  beneficiaryAccount: string;
  beneficiaryAgent: string;
  beneficiaryCountry: string;
  purposeCode: string;
  /** Minor units. u64, as the Move side stores it. */
  amount: bigint | string | number;
  currency: string;
  corridor: string;
};

/** Required by the scheme: an empty value here would make two different records hash alike. */
const REQUIRED: (keyof TravelRuleRecord)[] = [
  'paymentRef',
  'originatorName',
  'beneficiaryName',
  'beneficiaryAccount',
  'currency',
  'corridor',
];

const U64_MAX = (1n << 64n) - 1n;

/**
 * BCS bytes of a travel-rule record, in the documented order.
 *
 * Optional fields encode as '' rather than being omitted, so the layout is the
 * same width for every record and a missing value is explicit rather than
 * ambiguous. Required fields throw instead.
 */
export function encodeTravelRulePayload(record: TravelRuleRecord): Uint8Array {
  for (const name of REQUIRED) {
    const v = record[name];
    if (v === undefined || v === null || String(v).trim() === '') {
      throw new RangeError(`a travel-rule commitment needs ${name}`);
    }
  }
  const amount = BigInt(record.amount ?? 0);
  if (amount < 0n || amount > U64_MAX) throw new RangeError('amount is outside u64');

  const s = (v: string | undefined) => (v ?? '').trim();
  return TravelRuleLayout.serialize({
    payment_ref: s(record.paymentRef),
    originator_name: s(record.originatorName),
    originator_identifier: s(record.originatorIdentifier),
    originator_account: s(record.originatorAccount),
    originator_country: s(record.originatorCountry),
    beneficiary_name: s(record.beneficiaryName),
    beneficiary_identifier: s(record.beneficiaryIdentifier),
    beneficiary_account: s(record.beneficiaryAccount),
    beneficiary_agent: s(record.beneficiaryAgent),
    beneficiary_country: s(record.beneficiaryCountry),
    purpose_code: s(record.purposeCode),
    amount,
    currency: s(record.currency),
    corridor: s(record.corridor),
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

export function assertCommitmentBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== COMMITMENT_BYTES) {
    throw new RangeError(`a commitment is ${COMMITMENT_BYTES} bytes, got ${bytes?.length ?? 'none'}`);
  }
}

const utf8 = (s: string) => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** blake2b256(tag || payload || salt). The tag separates commitment families. */
export function commitmentBytes(tag: string, payload: Uint8Array, salt: Uint8Array): Uint8Array {
  if (!tag) throw new RangeError('a commitment needs a domain tag');
  assertSaltBytes(salt);
  const out = blake2b(concat(utf8(tag), payload, salt), { dkLen: COMMITMENT_BYTES });
  assertCommitmentBytes(out);
  return out;
}

/** The travel-rule commitment for a record, under `splash:travel-rule:v1`. */
export function travelRuleCommitment(record: TravelRuleRecord, salt: Uint8Array): Uint8Array {
  return commitmentBytes(DOMAIN_TAG, encodeTravelRulePayload(record), salt);
}

export const toHex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;
export const fromHex = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ''), 'hex'));

/** Everything a beneficiary needs to recompute the commitment, and the value itself. */
export function commitPayment(record: TravelRuleRecord, salt: Uint8Array = newSalt()) {
  const payload = encodeTravelRulePayload(record);
  const commitment = commitmentBytes(DOMAIN_TAG, payload, salt);
  return {
    tag: DOMAIN_TAG,
    record,
    salt: toHex(salt),
    payloadHex: toHex(payload),
    commitment: toHex(commitment),
  };
}
