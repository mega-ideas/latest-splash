/**
 * The payment itself (v2 brief 5.4): a payment from the Splash Wallet to a
 * Splash business or to a saved wallet or exchange recipient, started from
 * Transfer. (A bank payout is the supplier payout route, lib/server/
 * partner-payouts.ts, which instructs the partner first; USDC to another
 * chain needs a bridge adapter that is not registered, so it is refused here
 * by name.)
 *
 *   owners    the payment becomes a signing request for the owners'
 *             multisig; the quorum collects the signatures (§4.1).
 *   staff     ask the owners (lib/server/payment-approval-asks.ts). A payment
 *             under a staff rule is the splash_spend path, which this server
 *             does not carry out yet (lib/transfer/plan.ts), so staff always
 *             ask; the owners then pay it from the wallet.
 *
 * What must hold, and where:
 *   - The fee shown is the payment's max_fee, exactly. A fee above it is
 *     refused with the new fee (`fee_changed`), a bound above the ceiling
 *     (A1 §2.1, 1%) is refused, and Splash's fee comes from `deps.splashFee`
 *     (the schedule on chain), never from the request.
 *   - Idempotent by the intent id (the client's key, unique per business):
 *     the same key with the same payment answers the payment already made,
 *     the same key with another payment is a 409, two requests racing on one
 *     key make one payment, and a payment that was refused frees its key.
 *   - The sealed audit bundle is made here, after the cheap checks and the
 *     claim, and fails closed in production (lib/server/payment-record.ts).
 *   - Every read and write takes the org from the caller. Another business's
 *     recipient, payment or receipt reads as absent.
 *   - Splash's own addresses and the business's own wallet are refused.
 */
import { createHash, randomUUID } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { suppliers, walletApprovalAsks, walletSigningRequests, walletTransfers } from '../db/schema.ts';
import { validClientKey } from '../funding/wallet-funding.ts';
import { moveDeliveryOf, MOVE_KIND, type DeliveryKind } from '../recipients/wallet-recipients.ts';
import { FEE_CEILING_BPS, BPS_DENOM } from '../fees/schedule.ts';
import { U64_MAX } from '../transfer/plan.ts';
import { askOwnersToApprove, type ApprovalAsk, type AskNotifier, type AskPolicy } from './payment-approval-asks.ts';
import { recipientPayable, requestWalletPayment, type WalletContext, type WalletMembers } from './business-wallet.ts';
import type { PaymentRecorder } from './payment-record.ts';
import { readRequestForSigner, type RequestView } from './wallet-signing.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

export type TransferFailure = { ok: false; status: number; code: string; error: string; feeMinor?: string };
const fail = (status: number, code: string, error: string, more: { feeMinor?: string } = {}): TransferFailure => ({ ok: false, status, code, error, ...more });

/** How long the owners have to sign before the quote behind the payment lapses. */
export const TRANSFER_SETTLE_WINDOW_MS = 60 * 60 * 1000;
/** How long the intent stays open on chain. */
export const TRANSFER_INTENT_LIFETIME_MS = 7 * 24 * 3_600_000;

export type TransferDeps = {
  db: DrizzleDb;
  orgId: string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  ctx: WalletContext;
  walletMembers: () => Promise<{ ok: true; address: string; members: WalletMembers } | { ok: false; status: number; code: string; error: string }>;
  splashAddresses: () => Promise<string[]>;
  isBusinessWallet: (address: string) => Promise<boolean>;
  businessWallet: (businessId: string) => Promise<{ ok: true; name: string; wallet: string; country: string | null } | null>;
  searchBusinesses: (query: string) => Promise<Array<{ id: string; name: string; country: string | null }>>;
  splashFee: (input: { kind: number; principalMinor: bigint }) => Promise<{ feeMinor: bigint; feesOn: boolean }>;
  paymentRecord: PaymentRecorder;
  requesterAddresses: (userId: string) => Promise<string[]>;
  askPolicy?: () => Promise<AskPolicy | null>;
  notifyAsk?: AskNotifier;
};

export type PayeeInput = { kind: 'recipient'; recipientId?: string } | { kind: 'splash_business'; businessId?: string };

/** A payee from a request body: only the two shapes, nothing else carried over. */
export function payeeFromBody(value: unknown): PayeeInput {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return v.kind === 'splash_business' ? { kind: 'splash_business', businessId: String(v.businessId ?? '') } : { kind: 'recipient', recipientId: String(v.recipientId ?? '') };
}

export type TransferInput = {
  clientKey: unknown;
  payee: PayeeInput;
  amountMinor: unknown;
  maxFeeMinor: unknown;
  reference?: unknown;
};

export type TransferStatus = 'awaiting_signatures' | 'asked_owners' | 'on_the_way' | 'settled' | 'failed' | 'declined' | 'expired';

export type TransferView = {
  id: string;
  paymentRef: string;
  route: 'owners_sign' | 'asked_owners';
  status: TransferStatus;
  payeeKind: string;
  payeeName: string;
  payeeMasked: string | null;
  payeeCountry: string | null;
  amountMinor: string;
  feeMinor: string;
  feeKind: number;
  reference: string | null;
  signingRequestId: string | null;
  askId: string | null;
  createdAt: string;
};

type Row = typeof walletTransfers.$inferSelect;

const digits = (value: unknown): bigint | null => {
  const s = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,20}$/.test(s)) return null;
  const n = BigInt(s);
  return n <= U64_MAX ? n : null;
};

const sha = (text: string) => createHash('sha256').update(text).digest();
const maskAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function statusOf(deps: TransferDeps, row: Row): Promise<TransferStatus> {
  if (row.route === 'owners_sign' && row.signingRequestId) {
    const [r] = await deps.db.select({ status: walletSigningRequests.status }).from(walletSigningRequests).where(and(eq(walletSigningRequests.orgId, row.orgId), eq(walletSigningRequests.id, row.signingRequestId))).limit(1);
    switch (r?.status) {
      case 'collecting': return 'awaiting_signatures';
      case 'submitting':
      case 'unknown': return 'on_the_way';
      case 'executed': return 'settled';
      case 'expired': return 'expired';
      default: return 'failed';
    }
  }
  if (row.askId) {
    const [a] = await deps.db.select({ status: walletApprovalAsks.status, signingRequestId: walletApprovalAsks.signingRequestId }).from(walletApprovalAsks).where(and(eq(walletApprovalAsks.orgId, row.orgId), eq(walletApprovalAsks.id, row.askId))).limit(1);
    switch (a?.status) {
      case 'open': return 'asked_owners';
      case 'signing': return 'awaiting_signatures';
      case 'approved': return 'settled';
      case 'declined': return 'declined';
      case 'expired': return 'expired';
      default: return 'failed';
    }
  }
  return 'failed';
}

async function viewOf(deps: TransferDeps, row: Row): Promise<TransferView> {
  return {
    id: row.id,
    paymentRef: row.paymentRef,
    route: row.route as TransferView['route'],
    status: await statusOf(deps, row),
    payeeKind: row.payeeKind,
    payeeName: row.payeeName,
    payeeMasked: row.payeeMasked,
    payeeCountry: row.payeeCountry,
    amountMinor: row.amountMinor.toString(),
    feeMinor: row.maxFeeMinor.toString(),
    feeKind: row.feeKind,
    reference: row.reference,
    signingRequestId: row.signingRequestId,
    askId: row.askId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getTransfer(deps: TransferDeps, id: string): Promise<TransferView | null> {
  const [row] = await deps.db.select().from(walletTransfers).where(and(eq(walletTransfers.orgId, deps.orgId), eq(walletTransfers.id, id))).limit(1);
  return row ? viewOf(deps, row) : null;
}

/** A payment by its signing request id, its ask id or its payment reference: how a receipt finds it. */
export async function getTransferByRef(deps: Pick<TransferDeps, 'db' | 'orgId' | 'now' | 'ctx' | 'env'>, ref: string): Promise<Row | null> {
  const rows = await deps.db.select().from(walletTransfers).where(eq(walletTransfers.orgId, deps.orgId));
  return rows.find((r) => r.id === ref || r.signingRequestId === ref || r.askId === ref || r.paymentRef === ref) ?? null;
}

/**
 * The reference the receipt is read by (a signing request, a payout or an intent id): for a payment started here, the signing request the owners
 * signed, which exists once an owner started it or the owners accepted a staff member's ask. Null while there is none. Any other reference is
 * passed on as it is: the evidence lookup takes the org and finds this business's own or nothing.
 */
export async function receiptRefFor(deps: Pick<TransferDeps, 'db' | 'orgId'>, ref: string): Promise<string | null> {
  const rows = await deps.db.select().from(walletTransfers).where(eq(walletTransfers.orgId, deps.orgId));
  const row = rows.find((r) => r.id === ref || r.signingRequestId === ref || r.askId === ref || r.paymentRef === ref);
  if (!row) return ref;
  if (row.signingRequestId) return row.signingRequestId;
  if (row.askId) {
    const [ask] = await deps.db.select({ signingRequestId: walletApprovalAsks.signingRequestId }).from(walletApprovalAsks).where(and(eq(walletApprovalAsks.orgId, deps.orgId), eq(walletApprovalAsks.id, row.askId))).limit(1);
    return ask?.signingRequestId ?? null;
  }
  return null;
}

export async function listTransfers(deps: TransferDeps): Promise<TransferView[]> {
  const rows = await deps.db.select().from(walletTransfers).where(eq(walletTransfers.orgId, deps.orgId)).orderBy(desc(walletTransfers.createdAt));
  const out: TransferView[] = [];
  for (const row of rows) out.push(await viewOf(deps, row));
  return out;
}

/** Splash businesses by registered name. Too short a query, or no match, is an empty list; a business is never offered itself. */
export async function findBusinesses(deps: TransferDeps, query: string): Promise<{ ok: true; businesses: Array<{ id: string; name: string; country: string | null }> }> {
  const q = String(query ?? '').trim();
  if (q.length < 3) return { ok: true, businesses: [] };
  const found = await deps.searchBusinesses(q.slice(0, 80));
  return { ok: true, businesses: found.filter((b) => b.id !== deps.orgId).slice(0, 5) };
}

type Resolved = {
  payeeKind: 'splash_business' | 'exchange' | 'self_custody';
  recipientId: string | null;
  businessId: string | null;
  name: string;
  country: string | null;
  address: string;
  kind: number;
};

async function resolvePayee(deps: TransferDeps, payee: PayeeInput): Promise<Resolved | TransferFailure> {
  if (payee.kind === 'splash_business') {
    const businessId = String(payee.businessId ?? '');
    if (!businessId) return fail(400, 'bad_payee', 'Choose the business you are paying.');
    if (businessId === deps.orgId) return fail(400, 'own_wallet', 'That is your own business. Pay another business.');
    const found = await deps.businessWallet(businessId);
    if (!found) return fail(404, 'business_not_found', 'That business is not on Splash, or has no Splash Wallet yet.');
    const wallet = normalizeSuiAddress(found.wallet);
    if (!(await deps.isBusinessWallet(wallet))) return fail(409, 'not_a_splash_wallet', 'Splash does not list that wallet as a business wallet, so it cannot be paid as a Splash business.');
    return { payeeKind: 'splash_business', recipientId: null, businessId, name: found.name, country: found.country, address: wallet, kind: MOVE_KIND.SPLASH_BUSINESS };
  }
  const recipientId = String(payee.recipientId ?? '');
  if (!recipientId) return fail(400, 'bad_payee', 'Choose the recipient you are paying.');
  const [row] = await deps.db.select().from(suppliers).where(and(eq(suppliers.orgId, deps.orgId), eq(suppliers.id, recipientId))).limit(1);
  if (!row) return fail(404, 'recipient_not_found', 'No such recipient.');
  const deliveryKind = row.deliveryKind as DeliveryKind;
  if (deliveryKind === 'BANK') return fail(409, 'use_payout_route', "A bank account is paid with a bank payout, which tells the payout partner before the money moves. Choose “A business bank account”.");
  if (deliveryKind === 'CROSS_CHAIN') return fail(409, 'cross_chain_not_built', 'USDC to another chain is not switched on for your business yet, so nothing was sent.');
  const delivery = moveDeliveryOf({
    deliveryKind,
    walletAddress: row.walletAddress,
    exchangeId: row.exchangeId,
    destinationChain: row.destinationChain,
    destinationDomain: row.destinationDomain,
    mintRecipient: row.mintRecipient,
  });
  if (!delivery || delivery.kind === MOVE_KIND.CROSS_CHAIN) return fail(409, 'recipient_incomplete', "This recipient's details are incomplete. Open it in Recipients and finish them.");
  return {
    payeeKind: deliveryKind === 'EXCHANGE' ? 'exchange' : 'self_custody',
    recipientId,
    businessId: null,
    name: row.legalName || row.name,
    country: row.addressCountry || row.country || null,
    address: delivery.recipient,
    kind: delivery.kind,
  };
}

const requestHashOf = (input: { payee: PayeeInput; amount: bigint; maxFee: bigint; reference: string | null }) =>
  sha(JSON.stringify(['transfer', input.payee, input.amount.toString(), input.maxFee.toString(), input.reference])).toString('hex');

async function replay(deps: TransferDeps, actor: { userId: string }, row: Row, requestHash: string) {
  if (row.requestHash !== requestHash) return fail(409, 'idempotency_key_reused', 'That intent id was used for a different payment.');
  const transfer = await viewOf(deps, row);
  let signingRequest: RequestView | null = null;
  if (row.signingRequestId) {
    const read = await readRequestForSigner(deps.ctx.signing, { orgId: deps.orgId, userId: actor.userId, id: row.signingRequestId });
    if (read.ok) signingRequest = read.request;
  }
  let ask: ApprovalAsk | null = null;
  if (row.askId) {
    const { listApprovalAsks } = await import('./payment-approval-asks.ts');
    ask = (await listApprovalAsks(deps.db, { orgId: deps.orgId, userId: actor.userId, now: deps.now })).find((a) => a.id === row.askId) ?? null;
  }
  return { ok: true as const, created: false, transfer, signingRequest, ask };
}

/** While another request holds the key, wait for its outcome: its payment, or its row gone (it was refused). */
async function settledClaim(deps: TransferDeps, clientKey: string): Promise<Row | null> {
  for (let i = 0; i < 30; i += 1) {
    const [row] = await deps.db.select().from(walletTransfers).where(and(eq(walletTransfers.orgId, deps.orgId), eq(walletTransfers.clientKey, clientKey))).limit(1);
    if (!row) return null;
    if (row.signingRequestId || row.askId) return row;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const [row] = await deps.db.select().from(walletTransfers).where(and(eq(walletTransfers.orgId, deps.orgId), eq(walletTransfers.clientKey, clientKey))).limit(1);
  return row ?? null;
}

export type TransferQuote = {
  kind: number;
  principalMinor: string;
  feeMinor: string;
  feesOn: boolean;
  /** Exactly the fee shown: send it back as `maxFeeMinor`. */
  maxFeeMinor: string;
  totalDebitMinor: string;
  payee: { kind: string; name: string; masked: string; country: string | null };
};

/** The fee of a payment, before anything is made: Splash's fee for the kind this payee is paid as. Nothing is stored. */
export async function quoteTransfer(deps: TransferDeps, input: { payee: PayeeInput; amountMinor: unknown }): Promise<{ ok: true; quote: TransferQuote } | TransferFailure> {
  const amount = digits(input.amountMinor);
  if (amount === null || amount <= 0n) return fail(400, 'bad_amount', 'Say how much USDC to pay: an amount above zero.');
  const resolved = await resolvePayee(deps, input.payee);
  if ('ok' in resolved) return resolved;
  const fee = await deps.splashFee({ kind: resolved.kind, principalMinor: amount });
  return {
    ok: true,
    quote: {
      kind: resolved.kind,
      principalMinor: amount.toString(),
      feeMinor: fee.feeMinor.toString(),
      feesOn: fee.feesOn,
      maxFeeMinor: fee.feeMinor.toString(),
      totalDebitMinor: (amount + fee.feeMinor).toString(),
      payee: { kind: resolved.payeeKind, name: resolved.name, masked: maskAddress(resolved.address), country: resolved.country },
    },
  };
}

export async function createTransfer(deps: TransferDeps, actor: { userId: string; role: string }, input: TransferInput) {
  if (actor.role !== 'OWNER' && actor.role !== 'MAKER' && actor.role !== 'APPROVER') {
    return fail(403, 'cannot_pay', 'Viewers can look at payments but cannot make them.');
  }
  const clientKey = validClientKey(input.clientKey);
  if (!clientKey) return fail(400, 'idempotency_key_required', 'An intent id (8 to 80 letters, digits, - or _) is needed.');
  const amount = digits(input.amountMinor);
  if (amount === null || amount <= 0n) return fail(400, 'bad_amount', 'Say how much USDC to pay: an amount above zero.');
  const maxFee = digits(input.maxFeeMinor);
  if (maxFee === null) return fail(400, 'bad_fee', 'The fee that was shown is needed with the payment.');
  const reference = typeof input.reference === 'string' && input.reference.trim() ? input.reference.trim().slice(0, 60) : null;
  const payeeKey: PayeeInput = input.payee.kind === 'splash_business' ? { kind: 'splash_business', businessId: String(input.payee.businessId ?? '') } : { kind: 'recipient', recipientId: String(input.payee.recipientId ?? '') };
  const requestHash = requestHashOf({ payee: payeeKey, amount, maxFee, reference });

  const prior = await getByKey(deps, clientKey);
  if (prior) return replay(deps, actor, prior, requestHash);

  const members = await deps.walletMembers();
  if (!members.ok) return fail(members.status, members.code, members.error);
  const resolved = await resolvePayee(deps, input.payee);
  if ('ok' in resolved) return resolved;
  const address = normalizeSuiAddress(resolved.address);
  if (address === normalizeSuiAddress(members.address)) return fail(400, 'own_wallet', "That is this business's own wallet. Pay another recipient.");
  const splash = (await deps.splashAddresses()).map((a) => normalizeSuiAddress(a));
  if (splash.includes(address)) return fail(409, 'splash_controlled_address', 'That address belongs to Splash, so it cannot be paid as a recipient.');

  const fee = await deps.splashFee({ kind: resolved.kind, principalMinor: amount });
  if (maxFee * BPS_DENOM > amount * FEE_CEILING_BPS) return fail(400, 'fee_above_ceiling', 'The fee bound is above what Splash may ever charge on this payment.');
  if (maxFee < fee.feeMinor) return fail(409, 'fee_changed', 'The fee changed since it was shown. Check the new fee and approve again.', { feeMinor: fee.feeMinor.toString() });

  if (actor.role === 'OWNER') {
    const screened = await recipientPayable(deps.ctx, deps.orgId, address, resolved.kind, actor.userId);
    if (screened) return fail(screened.status, screened.code, screened.error);
  }

  const id = `wtr_${randomUUID()}`;
  const paymentRef = sha(`splash-transfer|${deps.orgId}|${clientKey}`);
  const now = deps.now();
  const route = actor.role === 'OWNER' ? 'owners_sign' : 'asked_owners';
  try {
    await deps.db.insert(walletTransfers).values({
      id,
      orgId: deps.orgId,
      clientKey,
      requestHash,
      paymentRef: paymentRef.toString('hex'),
      route,
      payeeKind: resolved.payeeKind,
      recipientId: resolved.recipientId,
      businessId: resolved.businessId,
      payeeName: resolved.name,
      payeeMasked: maskAddress(address),
      payeeCountry: resolved.country,
      address,
      amountMinor: amount,
      maxFeeMinor: maxFee,
      feeKind: resolved.kind,
      reference,
      requestedBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    // Another request holds this key: its payment is the answer, or, if it was refused, this one goes on.
    const other = await settledClaim(deps, clientKey);
    if (other) return replay(deps, actor, other, requestHash);
    return createTransfer(deps, actor, input);
  }

  const release = () => deps.db.delete(walletTransfers).where(eq(walletTransfers.id, id)).then(() => undefined);
  try {
    const payer = await payerName(deps);
    const record = await deps.paymentRecord({ orgId: deps.orgId, transferId: id, payer, payee: resolved.name, amountMinor: amount.toString(), maxFeeMinor: maxFee.toString(), reference });
    if (!record.ok) {
      await release();
      return fail(record.status, record.code, record.error);
    }
    const commitment = sha(JSON.stringify(['splash-transfer-commitment', deps.orgId, id, address, amount.toString(), maxFee.toString(), resolved.kind]));
    const railCommitment = sha(`splash-transfer-rail|${resolved.kind}`);
    const expiresAtMs = BigInt(now.getTime()) + BigInt(TRANSFER_INTENT_LIFETIME_MS);

    if (actor.role === 'OWNER') {
      const opened = await requestWalletPayment(deps.ctx, {
        orgId: deps.orgId,
        requestedBy: actor.userId,
        wallet: members.members,
        payment: {
          paymentRef: new Uint8Array(paymentRef),
          recipient: address,
          beneficiaryRef: new Uint8Array(),
          amountMinor: amount,
          targetCurrency: 'USDC',
          fxRateUsdLocal: 1_000_000n,
          commitment: new Uint8Array(commitment),
          kind: resolved.kind,
          railCommitment: new Uint8Array(railCommitment),
          expiresAtMs,
          maxFeeMinor: maxFee,
          settleByMs: BigInt(now.getTime() + TRANSFER_SETTLE_WINDOW_MS),
          contentHash: record.contentHash,
          walrusBlobId: record.walrusBlobId,
        },
      });
      if (!opened.ok) {
        await release();
        return fail(opened.status, opened.code, opened.error);
      }
      await deps.db.update(walletTransfers).set({ signingRequestId: opened.request.id, updatedAt: deps.now() }).where(eq(walletTransfers.id, id));
      const row = (await getByKey(deps, clientKey)) as Row;
      return { ok: true as const, created: true, transfer: await viewOf(deps, row), signingRequest: opened.request, ask: null };
    }

    const asked = await askOwnersToApprove(
      { db: deps.db, ctx: deps.ctx, now: deps.now, policy: deps.askPolicy, notify: deps.notifyAsk },
      {
        orgId: deps.orgId,
        userId: actor.userId,
        draft: {
          paymentRef: paymentRef.toString('hex'),
          recipient: address,
          amountMinor: amount,
          kind: resolved.kind,
          targetCurrency: 'USDC',
          fxRateUsdLocal: 1_000_000n,
          commitment: commitment.toString('hex'),
          railCommitment: railCommitment.toString('hex'),
          expiresAtMs,
        },
        contentHash: Buffer.from(record.contentHash).toString('hex'),
        walrusBlobId: Buffer.from(record.walrusBlobId).toString('hex'),
        requesterAddresses: await deps.requesterAddresses(actor.userId),
        note: `Fee shown: ${maxFee.toString()} (USDC minor units). ${reference ? `Reference ${reference}.` : ''}`.trim(),
      },
    );
    if (!asked.ok) {
      await release();
      return fail(asked.status, asked.code, asked.error);
    }
    await deps.db.update(walletTransfers).set({ askId: asked.ask.id, updatedAt: deps.now() }).where(eq(walletTransfers.id, id));
    const row = (await getByKey(deps, clientKey)) as Row;
    return { ok: true as const, created: true, transfer: await viewOf(deps, row), signingRequest: null, ask: asked.ask };
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }
}

async function getByKey(deps: TransferDeps, clientKey: string): Promise<Row | null> {
  const [row] = await deps.db.select().from(walletTransfers).where(and(eq(walletTransfers.orgId, deps.orgId), eq(walletTransfers.clientKey, clientKey))).limit(1);
  return row ?? null;
}

async function payerName(deps: TransferDeps): Promise<string> {
  const { organizations } = await import('../db/schema.ts');
  const [org] = await deps.db.select({ name: organizations.name, legalName: organizations.legalName }).from(organizations).where(eq(organizations.id, deps.orgId)).limit(1);
  return org?.legalName || org?.name || deps.orgId;
}
