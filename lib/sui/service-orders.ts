import { Transaction } from '@mysten/sui/transactions';
import { isValidSuiAddress, isValidSuiObjectId, normalizeSuiAddress } from '@mysten/sui/utils';

/**
 * WS3 — a service order is three signatures by three parties.
 *
 *   1. buildServiceOrderTx      a member of the client's business account,
 *                               in their own wallet (zkLogin through Slush,
 *                               or the Splash passkey)
 *   2. buildApprovePayoutTx     a DIFFERENT approver of that account
 *   3. confirmServiceOrderOnSui the operator, server-side, paying exactly
 *                               what 1 opened and 2 approved
 *                               (lib/server/sui-settlement.ts)
 *
 * Before WS3 the operator key opened the intent and paid it, so the chain saw
 * one address authorise and fund its own payout. These builders compose the
 * first two signatures for the member who must give them; nothing here holds
 * or reads a key. They are pure, and safe to import in the browser.
 *
 * The expiry window is deliberately not a constant in this file: the intent
 * records `expires_at` when it is opened, and `parseIntentObject` reads it.
 */

/** The shared Clock. */
export const CLOCK_OBJECT_ID = '0x6';
/** A commitment is thirty-two bytes (payment_intent::E_BAD_COMMITMENT, 420). */
const COMMITMENT_LENGTH = 32;
const U64_MAX = (1n << 64n) - 1n;

/** What the builders need to know about the published package. */
export type ServiceOrderContract = {
  /** The splash_core package. */
  packageId: string;
  /** The shared SettlementPolicy (SPLASH_SETTLEMENT_POLICY_ID). */
  policyId: string;
  /** The coin the intent binds and the operator pays in. */
  coinType: string;
};

export type ServiceOrderInput = {
  contract: ServiceOrderContract;
  /** The client's shared BusinessAccount. The signer must be an owner or approver of it. */
  account: string;
  recipient: string;
  /** Minor units of the settlement asset, as the intent stores them. */
  amountUsd: bigint;
  /** ISO 4217 payout currency, e.g. PHP. */
  targetCurrency: string;
  /** USD to local rate, scaled by 1e6. */
  fxRate: bigint;
  /** blake2b256(tag || bcs(payload) || salt), drawn server-side (lib/evidence/commitment.ts). */
  commitment: Uint8Array;
};

function objectId(value: string, label: string): string {
  const normalized = normalizeSuiAddress((value ?? '').trim());
  if (!value || !value.trim() || !isValidSuiObjectId(normalized)) {
    throw new Error(`${label} is not a Sui object id.`);
  }
  return normalized;
}

function u64(value: bigint, label: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > U64_MAX) {
    throw new Error(`${label} must be a positive u64, in minor units.`);
  }
  return value;
}

/**
 * Signature 1 of 3: the client member opens the order.
 *
 * One call and no coin. The member's signature authorises a payout from the
 * client's account; it spends nothing of Splash's and nothing of their own.
 */
export function buildServiceOrderTx(input: ServiceOrderInput): Transaction {
  const packageId = objectId(input.contract.packageId, 'The splash_core package');
  const policyId = objectId(input.contract.policyId, 'The SettlementPolicy (SPLASH_SETTLEMENT_POLICY_ID)');
  const account = objectId(input.account, 'The business account');
  const recipient = normalizeSuiAddress((input.recipient ?? '').trim());
  if (!isValidSuiAddress(recipient) || recipient === normalizeSuiAddress('0x0')) {
    throw new Error('The recipient is not a Sui address.');
  }
  const amount = u64(input.amountUsd, 'The amount');
  const fxRate = u64(input.fxRate, 'The FX rate');
  const currency = (input.targetCurrency ?? '').trim().toUpperCase();
  if (!currency) throw new Error('The target currency is empty.');
  if (!(input.commitment instanceof Uint8Array) || input.commitment.length !== COMMITMENT_LENGTH) {
    throw new Error(`A commitment is ${COMMITMENT_LENGTH} bytes; this one is not.`);
  }
  const coinType = (input.contract.coinType ?? '').trim();
  if (!coinType) throw new Error('The settlement coin type is empty.');

  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::payment_intent::create_service_order`,
    typeArguments: [coinType],
    arguments: [
      tx.object(account),
      tx.object(policyId),
      tx.pure.address(recipient),
      tx.pure.u64(amount),
      tx.pure.string(currency),
      tx.pure.u64(fxRate),
      tx.pure.vector('u8', Array.from(input.commitment)),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Signature 2 of 3: a different approver approves.
 *
 * The amount and the maker are read off the intent on chain, so there is
 * nothing here for a caller to get wrong. The chain refuses the maker (four
 * eyes, abort 29) and the operator (abort 423); the approval it mints is
 * transferred to the operator, who is the only party that can settle.
 */
export function buildApprovePayoutTx(input: { packageId: string; intentId: string; account: string }): Transaction {
  const packageId = objectId(input.packageId, 'The splash_core package');
  const intentId = objectId(input.intentId, 'The service order');
  const account = objectId(input.account, 'The business account');
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::payment_intent::approve_payout`,
    arguments: [tx.object(intentId), tx.object(account), tx.object(CLOCK_OBJECT_ID)],
  });
  return tx;
}

// ─── Reading an order back off the chain ────────────────────────────────────

export type IntentView = {
  intentId: string;
  account: string | null;
  maker: string;
  payer: string;
  isServiceOrder: boolean;
  amountMinor: bigint;
  createdAtMs: number;
  expiresAtMs: number;
  /** pending 0, confirmed 1, expired 2, canceled 3. */
  status: number;
};

function field(json: Record<string, unknown>, key: string): unknown {
  if (!(key in json)) throw new Error(`The intent object has no ${key} field; is this a WS3 payment_intent?`);
  return json[key];
}

function optionId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value ? normalizeSuiAddress(value) : null;
  if (Array.isArray(value)) return value.length ? optionId(value[0]) : null;
  if (typeof value === 'object') {
    const some = (value as { vec?: unknown[]; Some?: unknown }).vec ?? (value as { Some?: unknown }).Some;
    return optionId(some);
  }
  return null;
}

/** The fields a PaymentIntent object carries, as the node's JSON renders them. */
export function parseIntentObject(json: Record<string, unknown>): IntentView {
  const maker = normalizeSuiAddress(String(field(json, 'sender')));
  const payer = normalizeSuiAddress(String(field(json, 'payer')));
  const id = json.id;
  const intentId = typeof id === 'string' ? id : String((id as { id?: string } | undefined)?.id ?? '');
  return {
    intentId: intentId ? normalizeSuiAddress(intentId) : '',
    account: optionId(json.account),
    maker,
    payer,
    isServiceOrder: maker !== payer,
    amountMinor: BigInt(String(field(json, 'amount_usd'))),
    createdAtMs: Number(field(json, 'created_at')),
    expiresAtMs: Number(field(json, 'expires_at')),
    status: Number(field(json, 'status')),
  };
}

export type ServiceOrderWindow = {
  remainingMs: number;
  /** The window the contract opened the order with: expires_at − created_at. */
  totalMs: number;
  expired: boolean;
  label: string;
};

/**
 * What is left of the window, from the order's own timestamps. The contract
 * decides the window; this only subtracts. `nowMs` should be chain-adjacent
 * wall time — the chain's clock, not this one, decides the boundary, so the
 * label says "closed" at the instant the contract would refuse.
 */
export function serviceOrderWindow(
  intent: Pick<IntentView, 'createdAtMs' | 'expiresAtMs'>,
  nowMs: number,
): ServiceOrderWindow {
  const totalMs = Math.max(0, intent.expiresAtMs - intent.createdAtMs);
  const remainingMs = Math.max(0, intent.expiresAtMs - nowMs);
  const expired = remainingMs === 0;
  if (expired) return { remainingMs, totalMs, expired, label: 'Window closed' };
  const seconds = Math.ceil(remainingMs / 1000);
  const label = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`;
  return { remainingMs, totalMs, expired, label };
}

/**
 * What the countdown says to a person. With motion it ticks m:ss; under
 * prefers-reduced-motion the words change once a minute, so nothing rewrites
 * itself every second. The boundary is the window's either way.
 */
export function serviceOrderCountdownText(left: ServiceOrderWindow, options: { reducedMotion: boolean }): string {
  if (left.expired) {
    return 'The approval window closed before a second approver signed. Nothing was paid. Create the payment again to send it.';
  }
  if (!options.reducedMotion) return `${left.label} for a second approver to sign`;
  const minutes = Math.ceil(left.remainingMs / 60_000);
  return minutes <= 1
    ? 'Under a minute left for a second approver to sign'
    : `${minutes} minutes left for a second approver to sign`;
}

// ─── Who has signed ─────────────────────────────────────────────────────────

export type SignatureRecord = { address: string; digest: string; at?: string } | null;

export type SignatureParty = {
  role: 'maker' | 'approver' | 'operator';
  title: string;
  signed: boolean;
  address: string | null;
  digest: string | null;
  label: string;
};

const PARTY_TITLES: Record<SignatureParty['role'], string> = {
  maker: 'Client member orders',
  approver: 'A second approver approves',
  operator: 'Splash pays',
};

function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address;
}

/** The three signatures, in order, each saying plainly whether it exists. */
export function signatureLedger(order: {
  maker: SignatureRecord;
  approver: SignatureRecord;
  operator: SignatureRecord;
}): SignatureParty[] {
  return (['maker', 'approver', 'operator'] as const).map((role) => {
    const record = order[role];
    return {
      role,
      title: PARTY_TITLES[role],
      signed: Boolean(record),
      address: record?.address ?? null,
      digest: record?.digest ?? null,
      label: record ? `Signed by ${shortAddress(record.address)}` : 'Waiting for signature',
    };
  });
}
