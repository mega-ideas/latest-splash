import { randomUUID } from 'node:crypto';

import type { UserRole } from '@/lib/agent/types';
import {
  DOMAIN_TAGS,
  newSalt,
  paymentCommitment,
  toHex,
  type PaymentCommitmentPayload,
} from '@/lib/evidence/commitment';
import {
  createTransferSettlementEvidence,
  sealAndStoreSettlementEvidence,
} from '@/lib/evidence/settlement';
import { shouldUseMockSeal } from '@/lib/server/seal';
import { assertSealWritable } from '@/lib/server/seal-health';
import {
  buildMemberTransactionBytes,
  confirmServiceOrderOnSui,
  readServiceOrderOnSui,
  relayMemberSignedTransactionOnSui,
  resolveServiceOrderRecipient,
  serviceOrderContract,
} from '@/lib/server/sui-settlement';
import { isValidSuiObjectId } from '@mysten/sui/utils';
import type { AuditReceipt } from '@/lib/server/operations';
import { SUI_NETWORK } from '@/lib/sui';
import {
  buildApprovePayoutTx,
  buildServiceOrderTx,
  serviceOrderWindow,
  signatureLedger,
  type SignatureParty,
  type SignatureRecord,
  type ServiceOrderWindow,
} from '@/lib/sui/service-orders';

/**
 * WS3 — the payout Splash funds, as three signatures by three parties.
 *
 * This module used to be `executeComposedPayment`: the operator key opened an
 * intent and paid it from its own gas coin in the next transaction, so the
 * chain saw one address authorise and fund its own payout. It is now the
 * service order's bookkeeping:
 *
 *   openServiceOrder       the maker pressed "Create payment"; the payment
 *                          is recorded, nothing is signed yet
 *   buildServiceOrderStep  compose signature one (the client member's
 *                          create_service_order) or two (a different
 *                          approver's approve_payout) for that member's wallet
 *   submitServiceOrderStep relay the member's signed bytes; after the
 *                          approval lands, the operator signs three
 *                          (confirmServiceOrderOnSui)
 *
 * WS5 still holds: the salt is drawn here, once, when the maker's address is
 * known (the commitment binds it), and travels only into the Seal bundle. The
 * chain gets the 32-byte commitment and nothing else.
 *
 * The record of an order in flight lives in this process. That is a stated
 * limit, not an oversight: the contract gives an order five minutes from
 * signature one, so a restart between signatures costs an order that expires
 * with nothing moved — the chain, not this map, is what holds money. Moving
 * it to Postgres is the same move funding sessions still owe.
 */

export type ServiceOrderStep = 'order' | 'approve';

export type ServiceOrderState =
  | 'AWAITING_ORDER_SIGNATURE'
  | 'AWAITING_APPROVAL'
  | 'SETTLING'
  | 'SETTLED'
  | 'FAILED';

type SignedBy = { address: string; digest: string; at: string; userId: string; role: UserRole };

type ServiceOrderRecord = {
  id: string;
  orgId: string;
  transferId: string;
  /** The client's shared on-chain BusinessAccount. */
  account: string;
  recipientAddress: string;
  recipientLabel: string;
  amountMinor: bigint;
  targetCurrency: string;
  fxRateScaled: bigint;
  funding?: AuditReceipt['funding'];
  makerUserId: string;
  commitment: {
    bytes: Uint8Array;
    hex: string;
    saltHex: string;
    payload: PaymentCommitmentPayload;
  } | null;
  /** The digest of the bytes built for the member now expected to sign. */
  pending: { step: ServiceOrderStep; signer: string; digest: string } | null;
  intentId: string | null;
  maker: SignedBy | null;
  approver: SignedBy | null;
  operator: { address: string; digest: string; at: string } | null;
  state: ServiceOrderState;
  failureReason: string | null;
  createdAt: string;
};

type Store = Map<string, ServiceOrderRecord>;
const globalStore = globalThis as typeof globalThis & { splashServiceOrders?: Store };
function store(): Store {
  globalStore.splashServiceOrders ??= new Map();
  return globalStore.splashServiceOrders;
}

export class ServiceOrderError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = 'ServiceOrderError';
    this.status = status;
  }
}

function scaleFxRate(rate: string | number | null | undefined): bigint {
  const parsed = Number(rate);
  return BigInt(Math.max(1, Math.round((Number.isFinite(parsed) ? parsed : 1) * 1_000_000)));
}

/** The evidence bundle's paymentMist is a JS number. Exact below 2^53; refused above rather than rounded. */
function exactSafeInteger(minor: bigint): number {
  if (minor < 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new ServiceOrderError('The order amount does not fit the evidence record exactly.', 422);
  return Number(minor);
}

function orderFor(orgId: string, orderId: string): ServiceOrderRecord {
  const order = store().get(orderId);
  // Another org's order is the same answer as no order: its id proves nothing.
  if (!order || order.orgId !== orgId) throw new ServiceOrderError('Service order not found.', 404);
  return order;
}

/**
 * "Create payment" pressed: record the order. Nothing is signed and nothing
 * is on chain until the maker's own wallet signs `create_service_order`.
 */
export async function openServiceOrder(input: {
  orgId: string;
  transferId: string;
  account: string;
  makerUserId: string;
  recipientAddress: string;
  recipientLabel: string;
  amountMinor: bigint;
  targetCurrency: string;
  fxRate: string | number | null | undefined;
  funding?: AuditReceipt['funding'];
}): Promise<{ orderId: string }> {
  // Fail before anyone signs if the audit encryption boundary cannot accept
  // the receipt: an approved order with nowhere to seal its evidence is one
  // the operator must refuse to pay.
  if (!shouldUseMockSeal()) await assertSealWritable();
  const id = `so_${randomUUID()}`;
  store().set(id, {
    id,
    orgId: input.orgId,
    transferId: input.transferId,
    account: input.account,
    recipientAddress: input.recipientAddress,
    recipientLabel: input.recipientLabel,
    amountMinor: input.amountMinor,
    targetCurrency: input.targetCurrency.toUpperCase(),
    fxRateScaled: scaleFxRate(input.fxRate),
    funding: input.funding,
    makerUserId: input.makerUserId,
    commitment: null,
    pending: null,
    intentId: null,
    maker: null,
    approver: null,
    operator: null,
    state: 'AWAITING_ORDER_SIGNATURE',
    failureReason: null,
    createdAt: new Date().toISOString(),
  });
  return { orderId: id };
}

/**
 * Compose signature one or two for the member who must give it, as unsigned
 * bytes with that member as sender. The member's wallet signs them in the
 * browser; this server never holds that key.
 */
export async function buildServiceOrderStep(input: {
  orgId: string;
  orderId: string;
  step: ServiceOrderStep;
  signer: string;
  userId: string;
}): Promise<{ bytes: string; digest: string; network: string }> {
  const order = orderFor(input.orgId, input.orderId);
  const contract = serviceOrderContract();

  let tx;
  if (input.step === 'order') {
    if (order.state !== 'AWAITING_ORDER_SIGNATURE') throw new ServiceOrderError('This order has already been signed by its maker.');
    if (input.userId !== order.makerUserId) {
      throw new ServiceOrderError('Only the member who created this payment can sign its order.', 403);
    }
    if (!isValidSuiObjectId(order.account)) {
      throw new ServiceOrderError(
        'This workspace has no on-chain business account, so there is nothing to order a payout from. ' +
          'Set organizations.sui_business_account_id for it.',
        409,
      );
    }
    // The payout partner's address, or the testnet override, with the same
    // mainnet refusal as every other payout path.
    order.recipientAddress = resolveServiceOrderRecipient(order.recipientAddress);
    // WS5. The salt is drawn once the maker's address is known, because the
    // commitment binds the address that opens the intent. A maker who changes
    // wallet before signing gets a fresh salt for the new address.
    const salt = newSalt();
    const payload: PaymentCommitmentPayload = {
      sender: input.signer,
      recipient: order.recipientAddress,
      beneficiaryRef: '',
      // Strings, not bigints: the payload is written into the Seal bundle as
      // JSON, and the BCS encoder reads either.
      amount: order.amountMinor.toString(),
      currency: contract.coinType,
      corridor: '',
      targetCurrency: order.targetCurrency,
      fxRateUsdLocal: order.fxRateScaled.toString(),
    };
    const commitment = paymentCommitment(payload, salt);
    order.commitment = { bytes: commitment, hex: toHex(commitment), saltHex: toHex(salt), payload };
    tx = buildServiceOrderTx({
      contract,
      account: order.account,
      recipient: order.recipientAddress,
      amountUsd: order.amountMinor,
      targetCurrency: order.targetCurrency,
      fxRate: order.fxRateScaled,
      commitment,
    });
  } else {
    if (order.state !== 'AWAITING_APPROVAL' || !order.intentId) {
      throw new ServiceOrderError('This order is not waiting for an approval.');
    }
    // The chain refuses the maker (abort 29) and the operator (abort 423).
    // Refused here first, so nobody is asked to sign a transaction that
    // cannot succeed.
    if (input.userId === order.makerUserId || input.signer === order.maker?.address) {
      throw new ServiceOrderError('The member who ordered this payment cannot also approve it. A different approver must sign.', 403);
    }
    tx = buildApprovePayoutTx({ packageId: contract.packageId, intentId: order.intentId, account: order.account });
  }

  const built = await buildMemberTransactionBytes(tx, input.signer);
  order.pending = { step: input.step, signer: input.signer, digest: built.digest };
  return { ...built, network: SUI_NETWORK };
}

function eventBySuffix(events: Array<{ type: string; data: Record<string, unknown> }>, suffix: string) {
  return events.find((event) => event.type.endsWith(suffix)) ?? null;
}

/**
 * Relay a member's signed bytes. After signature two lands, the operator
 * signs three: it seals the evidence, then settles with the approval it now
 * holds, for the amount on the intent.
 */
export async function submitServiceOrderStep(input: {
  orgId: string;
  orderId: string;
  step: ServiceOrderStep;
  bytes: string;
  signature: string;
  userId: string;
  role: UserRole;
}): Promise<ServiceOrderView> {
  const order = orderFor(input.orgId, input.orderId);
  const pending = order.pending;
  if (!pending || pending.step !== input.step) {
    throw new ServiceOrderError('Nothing was built for this step. Ask Splash to compose it again, then sign.');
  }
  const relayed = await relayMemberSignedTransactionOnSui({
    bytes: input.bytes,
    signature: input.signature,
    expectedDigest: pending.digest,
  });
  order.pending = null;
  const at = new Date().toISOString();

  if (input.step === 'order') {
    const created = eventBySuffix(relayed.events, '::payment_intent::IntentCreated');
    const intentId = typeof created?.data.intent_id === 'string' ? created.data.intent_id : '';
    if (!intentId) throw new ServiceOrderError(`The order was signed but IntentCreated is missing. Digest: ${relayed.digest}`, 502);
    order.intentId = intentId;
    order.maker = { address: pending.signer, digest: relayed.digest, at, userId: input.userId, role: input.role };
    order.state = 'AWAITING_APPROVAL';
    return viewOf(order);
  }

  if (!eventBySuffix(relayed.events, '::business_account::PayoutApproved')) {
    throw new ServiceOrderError(`The approval was signed but PayoutApproved is missing. Digest: ${relayed.digest}`, 502);
  }
  order.approver = { address: pending.signer, digest: relayed.digest, at, userId: input.userId, role: input.role };
  order.state = 'SETTLING';
  return viewOf(order);
}

export type ServiceOrderSettledResult = Awaited<ReturnType<typeof confirmServiceOrderOnSui>> & {
  auditHash: string;
  walrus: Awaited<ReturnType<typeof sealAndStoreSettlementEvidence>>['walrus'];
  sealPolicy: Awaited<ReturnType<typeof sealAndStoreSettlementEvidence>>['policy'];
  evidence: Awaited<ReturnType<typeof sealAndStoreSettlementEvidence>>['record'];
  transferId: string;
  intentCreateDigest: string;
};

/**
 * Signature three: seal the evidence, then let the operator pay what the
 * client ordered and the approver approved. Called once the approval lands.
 */
export async function settleServiceOrder(input: { orgId: string; orderId: string }): Promise<ServiceOrderSettledResult> {
  const order = orderFor(input.orgId, input.orderId);
  if (order.state !== 'SETTLING' || !order.intentId || !order.commitment || !order.maker || !order.approver) {
    throw new ServiceOrderError('This order is not approved yet, so the operator will not pay it.');
  }
  try {
    const createdAt = new Date().toISOString();
    const expectedAnchorId = `transfer:${order.transferId}`;
    const evidenceBundle = createTransferSettlementEvidence({
      transferId: order.transferId,
      recipient: order.recipientLabel,
      targetCurrency: order.targetCurrency,
      paymentMist: exactSafeInteger(order.amountMinor),
      paymentIntentId: order.intentId,
      intentCreateDigest: order.maker.digest,
      expectedAnchorId,
      commitment: {
        tag: DOMAIN_TAGS.payment,
        commitmentHex: order.commitment.hex,
        saltHex: order.commitment.saltHex,
        payload: order.commitment.payload,
      },
      // The two people who signed, as the chain recorded them.
      approvals: [
        { userId: order.maker.userId, role: order.maker.role, signedAt: order.maker.at },
        { userId: order.approver.userId, role: order.approver.role, signedAt: order.approver.at },
      ],
      reasoningTraceRef: `service-order:${order.id}`,
      funding: order.funding,
      createdAt,
    });
    const evidence = await sealAndStoreSettlementEvidence(evidenceBundle, [
      order.maker.address,
      order.approver.address,
      order.recipientLabel,
      'auditor',
    ]);
    const auditHash = evidence.record.ciphertextHash;
    const settled = await confirmServiceOrderOnSui({
      intentId: order.intentId,
      account: order.account,
      auditHash,
      anchorId: expectedAnchorId,
      backingBlobId: evidence.walrus.blobId,
    });
    order.operator = { address: settled.operator, digest: settled.digest, at: new Date().toISOString() };
    order.state = 'SETTLED';
    return {
      ...settled,
      auditHash,
      walrus: evidence.walrus,
      sealPolicy: evidence.policy,
      evidence: evidence.record,
      transferId: order.transferId,
      intentCreateDigest: order.maker.digest,
    };
  } catch (error) {
    order.state = 'FAILED';
    order.failureReason = error instanceof Error ? error.message : 'Unknown settlement error';
    throw error;
  }
}

// ─── What a screen shows ────────────────────────────────────────────────────

export type ServiceOrderView = {
  id: string;
  transferId: string;
  state: ServiceOrderState;
  recipientLabel: string;
  amountMinor: string;
  targetCurrency: string;
  intentId: string | null;
  makerUserId: string;
  signatures: SignatureParty[];
  /** Read off the intent on chain once it exists; null before signature one. */
  window: ServiceOrderWindow | null;
  expiresAtMs: number | null;
  failureReason: string | null;
};

function record(signed: { address: string; digest: string; at: string } | null): SignatureRecord {
  return signed ? { address: signed.address, digest: signed.digest, at: signed.at } : null;
}

function viewOf(order: ServiceOrderRecord, window: ServiceOrderWindow | null = null, expiresAtMs: number | null = null): ServiceOrderView {
  return {
    id: order.id,
    transferId: order.transferId,
    state: order.state,
    recipientLabel: order.recipientLabel,
    amountMinor: order.amountMinor.toString(),
    targetCurrency: order.targetCurrency,
    intentId: order.intentId,
    makerUserId: order.makerUserId,
    signatures: signatureLedger({ maker: record(order.maker), approver: record(order.approver), operator: record(order.operator) }),
    window,
    expiresAtMs,
    failureReason: order.failureReason,
  };
}

/**
 * One order as a screen shows it. The window is the CONTRACT's: read off the
 * intent's own `expires_at`, never computed from a constant here.
 */
export async function readServiceOrder(orgId: string, orderId: string): Promise<ServiceOrderView> {
  const order = orderFor(orgId, orderId);
  if (!order.intentId) return viewOf(order);
  try {
    const intent = await readServiceOrderOnSui(order.intentId);
    return viewOf(order, serviceOrderWindow(intent, Date.now()), intent.expiresAtMs);
  } catch {
    return viewOf(order);
  }
}

/** This org's orders in flight, newest first. */
export async function listServiceOrders(orgId: string): Promise<ServiceOrderView[]> {
  const mine = [...store().values()]
    .filter((order) => order.orgId === orgId && order.state !== 'SETTLED')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return Promise.all(mine.map((order) => readServiceOrder(orgId, order.id)));
}
