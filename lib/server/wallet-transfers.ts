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
 *   staff     a staff member whose rule covers the amount, the recipient and
 *             the time window pays alone (`staff_rule`): one transaction
 *             through splash_spend, signed by that person's own passkey. The
 *             server reads the rule from the chain and runs the same check
 *             the page ran (lib/transfer/plan.ts) before it builds anything,
 *             counting what this person has already asked for and the chain
 *             has not (the claim and the in-flight read are one step under a
 *             lock, so two sends cannot both take the last of a cap).
 *             Anything outside the rule asks the owners
 *             (lib/server/payment-approval-asks.ts) with the reasons; a
 *             person who insisted on paying alone (`via: 'rule'`) is refused
 *             in words instead, and nothing is stored. Without the chain
 *             client for spending rules nothing is built: the owners are
 *             asked, or, if the person insisted, 503.
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

import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { suppliers, walletApprovalAsks, walletSigningRequests, walletTransferDisclosures, walletTransfers } from '../db/schema.ts';
import { disclosureText, exchangePurpose, type DisclosureText } from '../compliance/exchange-disclosure.ts';
import type { TravelRuleProvider } from '../compliance/sumsub.ts';
import type { PartnerId } from '../partners/signed-partners.ts';
import { validClientKey } from '../funding/wallet-funding.ts';
import { moveDeliveryOf, MOVE_KIND, type DeliveryKind } from '../recipients/wallet-recipients.ts';
import { FEE_CEILING_BPS, BPS_DENOM } from '../fees/schedule.ts';
import { approvalPlan, approvalReasonLines, APPROVAL_REASON_TEXT, SETTLE_WINDOW_MS, U64_MAX, type ApprovalPlan, type ApprovalReason, type InFlight, type PlanPayee } from '../transfer/plan.ts';
import { openStaffRulePayment, readStaffRule, type SpendContext, type StaffRuleRead } from './spend-rules.ts';
import { askOwnersToApprove, type ApprovalAsk, type AskNotifier, type AskPolicy } from './payment-approval-asks.ts';
import {
  attachSigningRequest,
  buildExchangeDisclosure,
  exchangeMessageStateOf,
  paymentRefHex,
  readStoredDisclosure,
  sendStoredExchangeMessage as sendMessage,
  storeExchangeDisclosure,
  transferCommitmentHex,
  travelRuleProviderFor,
  type ExchangeMessageState,
} from './exchange-disclosure.ts';
import { recipientPayable, requestWalletPayment, type WalletContext, type WalletMembers } from './business-wallet.ts';
import type { PaymentRecorder } from './payment-record.ts';
import { buildPaymentTrail } from './payment-trail.ts';
import { cancelSigningRequest, readRequestForSigner, type RequestView } from './wallet-signing.ts';
import { exchangeAloneOf } from './exchange-alone.ts';
import { askDeclinerOf, declinersOfRequests, endedByPeople, type DrizzleDb } from './wallet-signing-store.ts';
import type { Decliners } from '../team/declined-by.ts';

/** The message a staff member must read again, with the hash to confirm. */
export type DisclosureShown = { hash: string; text: DisclosureText };
export type TransferFailure = { ok: false; status: number; code: string; error: string; feeMinor?: string; reasons?: ApprovalReason[]; disclosure?: DisclosureShown };
const fail = (status: number, code: string, error: string, more: { feeMinor?: string; reasons?: ApprovalReason[]; disclosure?: DisclosureShown } = {}): TransferFailure => ({ ok: false, status, code, error, ...more });

/** Said when a staff member is not allowed to pay an exchange account alone. */
export const EXCHANGE_ALONE_OFF_TEXT = 'Paying an exchange account alone is turned off for you. An owner can turn it on in Settings; until then the owners send this payment, with its Travel Rule message.';

/** How long the owners have to sign before the quote behind the payment lapses. */
export const TRANSFER_SETTLE_WINDOW_MS = SETTLE_WINDOW_MS;
/** A claim on an intent id that has no request and no ask after this long was left by a request that died: it is reclaimed. */
export const TRANSFER_CLAIM_TTL_MS = 2 * 60_000;
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
  /**
   * The chain client for this business's spending rules (lib/server/spend-rules.ts), or a function that makes it.
   * Without it nothing is read or built for a payment under a rule; a context for another business is refused.
   */
  spend?: SpendContext | (() => Promise<SpendContext | null>);
  /** The person's active passkey that can sign on this site: its compressed public key (base64) and Sui address. */
  staffSigner?: (userId: string) => Promise<{ publicKey: string; address: string } | null>;
  /** How long a second request on a key waits for the first to finish before answering "in progress" (default 3 s). */
  claimWaitMs?: number;
  /** May this staff member or approver pay an exchange account alone, right now? An owner's switch, read from the database (lib/server/exchange-alone.ts). Absent means no. */
  payExchangeAlone?: (userId: string) => Promise<boolean>;
  /** The Travel Rule provider. Absent: the environment's, which in production without Sumsub's Travel Rule configured refuses. */
  travelRule?: () => TravelRuleProvider;
  /** Kept for callers that still pass it. The confirmation no longer names the exchange's company at all (it names the payment network, lib/compliance/payment-networks.ts), so it is not read. */
  signedPartners?: ReadonlySet<PartnerId>;
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
  /** Staff only. 'rule': pay alone under my rule, or refuse in words (never silently ask). 'ask': ask the owners. Absent: the server decides. */
  via?: unknown;
  /** The asset the payment moves. Absent means USDC, the only asset a payment moves (D6); anything else is refused. */
  asset?: unknown;
  /** Staff paying an exchange account alone: `{ purpose, confirmedHash }`, the purpose they picked and the hash of the message they read. */
  exchangeDisclosure?: unknown;
};

export type TransferStatus = 'awaiting_signatures' | 'asked_owners' | 'on_the_way' | 'settled' | 'failed' | 'declined' | 'expired' | 'withdrawn';

export type TransferView = {
  id: string;
  paymentRef: string;
  route: 'owners_sign' | 'asked_owners' | 'staff_rule';
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
  /** Present only when the owners declined it: who, by the signing request's own record (or the ask's), plain names in the order they declined. Said by lib/team/declined-by.ts. */
  declinedBy?: Decliners;
};

type Row = typeof walletTransfers.$inferSelect;

/** Who approves, and why, in the words the person is shown. */
export type TransferPlan = { route: 'owners_sign' | 'staff_rule' | 'ask_owners'; reasons: ApprovalReason[]; lines: string[] };

export type CreateTransferResult =
  | TransferFailure
  | { ok: true; created: boolean; transfer: TransferView; signingRequest: RequestView | null; ask: ApprovalAsk | null; plan: TransferPlan; exchange?: ExchangeOfPayment };

/** A staff member's exchange payment: where its Travel Rule message stands, and, on a replay that confirmed another purpose, which purpose was already shared. */
export type ExchangeOfPayment = { travelRule: ExchangeMessageState; notice?: string };

const digits = (value: unknown): bigint | null => {
  const s = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,20}$/.test(s)) return null;
  const n = BigInt(s);
  return n <= U64_MAX ? n : null;
};

const sha = (text: string) => createHash('sha256').update(text).digest();
export const maskAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function statusOf(deps: TransferDeps, row: Row): Promise<TransferStatus> {
  if ((row.route === 'owners_sign' || row.route === 'staff_rule') && row.signingRequestId) {
    const [r] = await deps.db.select({ status: walletSigningRequests.status, error: walletSigningRequests.error }).from(walletSigningRequests).where(and(eq(walletSigningRequests.orgId, row.orgId), eq(walletSigningRequests.id, row.signingRequestId))).limit(1);
    switch (r?.status) {
      case 'collecting': return 'awaiting_signatures';
      case 'submitting':
      case 'unknown': return 'on_the_way';
      case 'executed': return 'settled';
      case 'expired': return 'expired';
      // A request the sender took back, or the owners declined, is a person's own no, never a failure.
      case 'cancelled': return endedByPeople(r.error);
      default: return 'failed';
    }
  }
  if (row.askId) {
    const [a] = await deps.db.select({ status: walletApprovalAsks.status, signingRequestId: walletApprovalAsks.signingRequestId }).from(walletApprovalAsks).where(and(eq(walletApprovalAsks.orgId, row.orgId), eq(walletApprovalAsks.id, row.askId))).limit(1);
    switch (a?.status) {
      case 'open': return 'asked_owners';
      case 'signing': {
        // The owners accepted: the request they sign says where it is. A request that died hands the ask back to the owners.
        if (!a.signingRequestId) return 'awaiting_signatures';
        const [r] = await deps.db.select({ status: walletSigningRequests.status }).from(walletSigningRequests).where(and(eq(walletSigningRequests.orgId, row.orgId), eq(walletSigningRequests.id, a.signingRequestId))).limit(1);
        if (r?.status === 'submitting' || r?.status === 'unknown') return 'on_the_way';
        if (r?.status === 'executed') return 'settled';
        if (r?.status === 'collecting') return 'awaiting_signatures';
        return 'asked_owners';
      }
      case 'approved': return 'settled';
      case 'declined': return 'declined';
      case 'expired': return 'expired';
      case 'withdrawn': return 'withdrawn';
      default: return 'failed';
    }
  }
  return 'failed';
}

/** Who declined a payment the owners declined, from the record of the request or the ask that ended it. This business's own record only. */
async function declinersOf(deps: TransferDeps, row: Row): Promise<Decliners> {
  if ((row.route === 'owners_sign' || row.route === 'staff_rule') && row.signingRequestId) {
    return (await declinersOfRequests(deps.db, row.orgId, [row.signingRequestId])).get(row.signingRequestId) ?? { names: [], unnamed: 0 };
  }
  return (row.askId ? await askDeclinerOf(deps.db, row.orgId, row.askId) : null) ?? { names: [], unnamed: 0 };
}

async function viewOf(deps: TransferDeps, row: Row): Promise<TransferView> {
  const status = await statusOf(deps, row);
  return {
    id: row.id,
    paymentRef: row.paymentRef,
    route: row.route as TransferView['route'],
    status,
    ...(status === 'declined' ? { declinedBy: await declinersOf(deps, row) } : {}),
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

export type Resolved = {
  payeeKind: 'splash_business' | 'exchange' | 'self_custody';
  recipientId: string | null;
  businessId: string | null;
  name: string;
  country: string | null;
  address: string;
  kind: number;
  /** When the saved recipient was added (a Splash business has none). */
  addedAt: Date | null;
};

export async function resolvePayee(deps: TransferDeps, payee: PayeeInput): Promise<Resolved | TransferFailure> {
  if (payee.kind === 'splash_business') {
    const businessId = String(payee.businessId ?? '');
    if (!businessId) return fail(400, 'bad_payee', 'Choose the business you are paying.');
    if (businessId === deps.orgId) return fail(400, 'own_wallet', 'That is your own business. Pay another business.');
    const found = await deps.businessWallet(businessId);
    if (!found) return fail(404, 'business_not_found', 'That business is not on Splash, or has no Splash Wallet yet.');
    const wallet = normalizeSuiAddress(found.wallet);
    if (!(await deps.isBusinessWallet(wallet))) return fail(409, 'not_a_splash_wallet', 'Splash does not list that wallet as a business wallet, so it cannot be paid as a Splash business.');
    return { payeeKind: 'splash_business', recipientId: null, businessId, name: found.name, country: found.country, address: wallet, kind: MOVE_KIND.SPLASH_BUSINESS, addedAt: null };
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
    addedAt: row.createdAt ?? null,
  };
}

/** What the payment is: who, how much, and the reference. The fee bound is not part of it, so a retry after a lost response that carries a changed fee answers the payment already made. */
const requestHashOf = (input: { payee: PayeeInput; amount: bigint; reference: string | null }) =>
  sha(JSON.stringify(['transfer', input.payee, input.amount.toString(), input.reference])).toString('hex');

export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string }; message?: string } | null;
  return e?.code === '23505' || e?.cause?.code === '23505' || /unique|duplicate key/i.test(e?.message ?? '');
}

const RECLAIMED = Symbol('reclaimed');
const IN_PROGRESS = fail(409, 'in_progress', 'This payment is still being prepared. Wait a moment and try again; nothing is sent twice.');

/**
 * Where a staff member's exchange payment's Travel Rule message stands, for a payment that is shown again (a retried send, a reload). If the retry
 * confirmed another purpose than the one already shared, the words say which was shared: the payment is the one made, not a new one.
 */
async function exchangeOfReplay(deps: TransferDeps, row: Row, confirmation: unknown): Promise<ExchangeOfPayment | undefined> {
  if (row.route !== 'staff_rule' || row.payeeKind !== 'exchange' || !row.signingRequestId) return undefined;
  const stored = await readStoredDisclosure(deps.db, deps.orgId, { signingRequestId: row.signingRequestId });
  if (!stored) return undefined;
  const travelRule = await exchangeMessageStateOf(deps.db, deps.orgId, row.signingRequestId);
  const given = confirmation && typeof confirmation === 'object' ? exchangePurpose((confirmation as { purpose?: unknown }).purpose) : null;
  if (given && given.code !== stored.payload.purpose.code) {
    return { travelRule, notice: `This payment was already made, and the exchange was told it is for “${stored.payload.purpose.label}”, not “${given.label}”.` };
  }
  return { travelRule };
}

async function replay(deps: TransferDeps, actor: { userId: string }, row: Row, requestHash: string, confirmation?: unknown) {
  // An intent id answers the person who made the payment. Another member of the business, an owner or not, is shown
  // nothing of it: not its payee, its amount or its signing request, and is not told a payment exists for them.
  if (row.requestedBy !== actor.userId) return fail(409, 'idempotency_key_reused', 'That intent id was used for a different payment.');
  if (!row.signingRequestId && !row.askId) {
    // A claim with nothing behind it yet: another request is still making it, or it died.
    const settled = await settledClaim(deps, row.clientKey);
    if (!settled) return RECLAIMED;
    if (!settled.signingRequestId && !settled.askId) {
      if (deps.now().getTime() - settled.createdAt.getTime() < TRANSFER_CLAIM_TTL_MS) return IN_PROGRESS;
      const gone = await deps.db.delete(walletTransfers).where(and(eq(walletTransfers.id, settled.id), eq(walletTransfers.orgId, deps.orgId), isNull(walletTransfers.signingRequestId), isNull(walletTransfers.askId))).returning({ id: walletTransfers.id });
      return gone.length ? RECLAIMED : IN_PROGRESS;
    }
    row = settled;
  }
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
  const exchange = await exchangeOfReplay(deps, row, confirmation);
  return { ok: true as const, created: false, transfer, signingRequest, ask, plan: { route: row.route === 'asked_owners' ? ('ask_owners' as const) : (row.route as 'owners_sign' | 'staff_rule'), reasons: [], lines: [] }, ...(exchange ? { exchange } : {}) };
}

/** While another request holds the key, wait for its outcome: its payment, or its row gone (it was refused). */
async function settledClaim(deps: TransferDeps, clientKey: string): Promise<Row | null> {
  const tries = Math.max(1, Math.ceil((deps.claimWaitMs ?? 3000) / 100));
  for (let i = 0; i < tries; i += 1) {
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
  /** Who is paid, as the review shows it: the full address too, so approval is not on a name alone. `recentlyAdded`: saved in the last 24 hours. */
  payee: { kind: string; name: string; masked: string; address: string; country: string | null; recentlyAdded: boolean };
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
      payee: {
        kind: resolved.payeeKind,
        name: resolved.name,
        masked: maskAddress(resolved.address),
        address: normalizeSuiAddress(resolved.address),
        country: resolved.country,
        recentlyAdded: resolved.addedAt !== null && deps.now().getTime() - resolved.addedAt.getTime() < 24 * 3_600_000,
      },
    },
  };
}

export async function createTransfer(deps: TransferDeps, actor: { userId: string; role: string }, input: TransferInput, attempt = 0): Promise<CreateTransferResult> {
  if (actor.role !== 'OWNER' && actor.role !== 'MAKER' && actor.role !== 'APPROVER') {
    return fail(403, 'cannot_pay', 'Viewers can look at payments but cannot make them.');
  }
  const clientKey = validClientKey(input.clientKey);
  if (!clientKey) return fail(400, 'idempotency_key_required', 'An intent id (8 to 80 letters, digits, - or _) is needed.');
  const amount = digits(input.amountMinor);
  if (amount === null || amount <= 0n) return fail(400, 'bad_amount', 'Say how much USDC to pay: an amount above zero.');
  const maxFee = digits(input.maxFeeMinor);
  if (maxFee === null) return fail(400, 'bad_fee', 'The fee that was shown is needed with the payment.');
  // One payment asset: USDC (D6). No rule pays another, and the owners do not either.
  if (input.asset !== undefined && input.asset !== null && String(input.asset).trim().toUpperCase() !== 'USDC') {
    return fail(400, 'wrong_asset', `${APPROVAL_REASON_TEXT.wrong_asset} Nothing was sent.`);
  }
  const reference = typeof input.reference === 'string' && input.reference.trim() ? input.reference.trim().slice(0, 60) : null;
  const payeeKey: PayeeInput = input.payee.kind === 'splash_business' ? { kind: 'splash_business', businessId: String(input.payee.businessId ?? '') } : { kind: 'recipient', recipientId: String(input.payee.recipientId ?? '') };
  const requestHash = requestHashOf({ payee: payeeKey, amount, reference });
  if (attempt >= 3) return IN_PROGRESS;

  const prior = await getByKey(deps, clientKey);
  if (prior) {
    const again = await replay(deps, actor, prior, requestHash, input.exchangeDisclosure);
    if (again !== RECLAIMED) return again;
  }

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

  // Staff: does the payment fit their rule? Read from the chain now, judged by the rule the page showed (plan.ts), before anything is stored.
  const via = input.via === 'rule' ? 'rule' : input.via === 'ask' ? 'ask' : null;
  let staff: StaffDecision | null = null;
  // An owner's switch, read now from the database: default deny. It only widens what the rule allows, and only for an exchange account.
  const exchangeAlone = actor.role !== 'OWNER' && resolved.payeeKind === 'exchange' ? await exchangeAloneNow(deps, actor.userId) : false;
  if (actor.role !== 'OWNER') {
    const decided = await decideStaff(deps, actor, { resolved, address, amount, maxFee, via, exchangeAlone, exchangeDisclosure: input.exchangeDisclosure, clientKey });
    if ('ok' in decided) return decided;
    staff = decided;
  }

  if (actor.role === 'OWNER') {
    const screened = await recipientPayable(deps.ctx, deps.orgId, address, resolved.kind, actor.userId);
    if (screened) return fail(screened.status, screened.code, screened.error);
  }

  const id = `wtr_${randomUUID()}`;
  const paymentRef = Buffer.from(paymentRefHex(deps.orgId, clientKey), 'hex');
  const now = deps.now();
  let route: 'owners_sign' | 'asked_owners' | 'staff_rule' = actor.role === 'OWNER' ? 'owners_sign' : staff?.kind === 'rule' ? 'staff_rule' : 'asked_owners';
  const claim = {
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
  };
  const underRule = staff?.kind === 'rule' ? staff : null;
  try {
    if (underRule) {
      // The claim and the read of what has already been asked for are one step under a lock per business, so two
      // sends cannot both be told there is room for the last of a cap, or for the last of a recipient's second-approval
      // amount, which is shared by every person paying that recipient (the chain would refuse the second of the first
      // kind; this keeps the person from being told otherwise). The step is a read and an insert, so the lock is short.
      const outcome = await deps.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`staff-rule:${deps.orgId}`}))`);
        const flight = await inFlightFor(tx as unknown as DrizzleDb, deps, actor.userId, address, underRule.read.readAtMs);
        // The owner's switch is asked again here, on the claim's own connection and under the lock: the answer read before the chain
        // and screening may be older than an owner's change, and nothing is kept or sent on a stale yes.
        const aloneNow = resolved.payeeKind === 'exchange' ? (deps.payExchangeAlone ? await exchangeAloneOf(tx as unknown as DrizzleDb, deps.orgId, actor.userId) : false) : exchangeAlone;
        const plan = planFor(deps, actor, { resolved, address, amount, maxFee, read: underRule.read, inFlight: flight, exchangeAlone: aloneNow });
        if (plan.route !== 'staff_rule') return { plan, flight };
        await tx.insert(walletTransfers).values(claim);
        // The message the person confirmed is kept in the same step as the payment's claim: one never exists without the other.
        if (underRule.exchange) await storeExchangeDisclosure(tx as unknown as DrizzleDb, { orgId: deps.orgId, transferId: id, built: underRule.exchange.built, confirmedBy: actor.userId, now });
        return { plan: null, flight };
      });
      if (outcome.plan) {
        // What was in flight changed the answer: it is outside the rule now.
        const lines = linesFor(outcome.plan, underRule.read, amount, now, maxFee, outcome.flight);
        if (via === 'rule') return fail(409, 'outside_rule', outsideRuleText(lines), { reasons: outcome.plan.reasons });
        staff = { kind: 'ask', reasons: outcome.plan.reasons, lines };
        route = 'asked_owners';
        await deps.db.insert(walletTransfers).values({ ...claim, route });
      }
    } else {
      await deps.db.insert(walletTransfers).values(claim);
    }
  } catch (error) {
    // Only a clash on the key means another request holds it; anything else (a database fault) is not ours to swallow.
    if (!isUniqueViolation(error)) throw error;
    // Its payment is the answer, or, if it was refused, this one goes on.
    const other = await getByKey(deps, clientKey);
    if (other) {
      const again = await replay(deps, actor, other, requestHash, input.exchangeDisclosure);
      if (again !== RECLAIMED) return again;
    }
    return createTransfer(deps, actor, input, attempt + 1);
  }

  const release = () => deps.db.delete(walletTransfers).where(eq(walletTransfers.id, id)).then(() => undefined);
  try {
    const payer = await payerName(deps);
    // The sealed record always says who started the payment, when, by which route and under which rule, and which owners could approve it,
    // whatever the name-sharing switches say (those change only what an exchange is told). Each later decision is its own record (payment-trail.ts).
    const trail = await buildPaymentTrail(deps.db, { orgId: deps.orgId, actor, route, rule: underRule ? underRule.read.facts.rule : null, spender: underRule ? underRule.read.spender : null, at: now });
    const record = await deps.paymentRecord({ orgId: deps.orgId, transferId: id, payer, payee: resolved.name, amountMinor: amount.toString(), maxFeeMinor: maxFee.toString(), reference, trail });
    if (!record.ok) {
      await release();
      return fail(record.status, record.code, record.error);
    }
    // What the chain will anchor, kept with the payment so each decision record can name it.
    await deps.db.update(walletTransfers).set({ recordHash: Buffer.from(record.contentHash).toString('hex'), recordBlobId: Buffer.from(record.walrusBlobId).toString('hex') }).where(eq(walletTransfers.id, id));
    const commitment = Buffer.from(transferCommitmentHex({ orgId: deps.orgId, transferId: id, address, amountMinor: amount, maxFeeMinor: maxFee, kind: resolved.kind }), 'hex');
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
      return { ok: true as const, created: true, transfer: await viewOf(deps, row), signingRequest: opened.request, ask: null, plan: { route: 'owners_sign' as const, reasons: [], lines: [] } };
    }

    if (underRule && route === 'staff_rule') {
      // Inside the rule: one transaction, signed by this person's own passkey. The declared kind is the tag the owners verified:
      // a wallet, or an exchange account when an owner allowed this person to pay one alone.
      const declared: 1 | 2 = underRule.exchange ? 2 : 1;
      const exchangeHash = underRule.exchange ? underRule.exchange.built.hash : null;
      const opened = await openStaffRulePayment(await spendOf(deps) as SpendContext, {
        orgId: deps.orgId,
        userId: actor.userId,
        signer: underRule.signer,
        read: underRule.read,
        payment: {
          paymentRef: new Uint8Array(paymentRef),
          recipient: address,
          amountMinor: amount,
          targetCurrency: 'USDC',
          fxRateUsdLocal: 1_000_000n,
          kind: declared,
          // For an exchange account the commitment on chain covers the hash of the message the person confirmed; the signing gate derives it again from the bytes.
          commitment: new Uint8Array(Buffer.from(transferCommitmentHex({ orgId: deps.orgId, transferId: id, address, amountMinor: amount, maxFeeMinor: maxFee, kind: declared, ...(exchangeHash ? { messageHash: exchangeHash } : {}) }), 'hex')),
          railCommitment: new Uint8Array(sha(`splash-transfer-rail|${declared}`)),
          expiresAtMs,
          maxFeeMinor: maxFee,
          settleByMs: BigInt(now.getTime() + TRANSFER_SETTLE_WINDOW_MS),
          contentHash: record.contentHash,
          walrusBlobId: record.walrusBlobId,
        },
      });
      // Why this payment is the owners' after all, when it is: the network-fee share is used up, or an owner turned the switch off while it was being made.
      let handBack: 'staff_gas_share_used' | 'exchange_needs_owners' | null = null;
      if (opened.ok) {
        await deps.db.update(walletTransfers).set({ signingRequestId: opened.request.id, updatedAt: deps.now() }).where(eq(walletTransfers.id, id));
        let exchange: { travelRule: ExchangeMessageState } | undefined;
        if (underRule.exchange) {
          await attachSigningRequest(deps.db, { orgId: deps.orgId, transferId: id, signingRequestId: opened.request.id });
          // The owner's switch, read again immediately before anything is shared: an owner who turned it off after the first read stops the message
          // and the payment here, and the request just opened is withdrawn so it cannot be signed (the signing gate would refuse it in any case).
          if (await exchangeAloneNow(deps, actor.userId)) {
            // The message goes to the provider now, made from the payload just kept and nothing else. If it does not go, the payment cannot be signed
            // (the signing gate needs it with the provider), the person is told, and it can be sent again.
            const travelRule = await sendMessage({ db: deps.db, orgId: deps.orgId, now: deps.now, provider: underRule.exchange.provider }, underRule.exchange.built.disclosure, { signingRequestId: opened.request.id, createdBy: actor.userId });
            exchange = { travelRule };
          } else {
            await cancelSigningRequest(deps.ctx.signing, { orgId: deps.orgId, userId: actor.userId, id: opened.request.id });
            await deps.db.update(walletTransfers).set({ signingRequestId: null, updatedAt: deps.now() }).where(eq(walletTransfers.id, id));
            handBack = 'exchange_needs_owners';
          }
        }
        if (!handBack) {
          const row = (await getByKey(deps, clientKey)) as Row;
          return { ok: true as const, created: true, transfer: await viewOf(deps, row), signingRequest: opened.request, ask: null, plan: { route: 'staff_rule' as const, reasons: [], lines: [] }, ...(exchange ? { exchange } : {}) };
        }
      } else if (opened.code !== 'staff_gas_share_used') {
        await release();
        return fail(opened.status, opened.code, opened.error);
      } else {
        handBack = 'staff_gas_share_used';
      }
      // Staff payments together have used their share of the day's network-fee allowance, or an owner turned the switch off meanwhile. That is not
      // the person's fault and not an error: the owners are asked instead (a person who insisted on paying alone is told, and nothing is kept).
      const lines = [APPROVAL_REASON_TEXT[handBack]];
      // The owners send their own message, so nothing the person confirmed is kept for a payment that is no longer theirs.
      if (underRule.exchange) await deps.db.delete(walletTransferDisclosures).where(eq(walletTransferDisclosures.transferId, id));
      if (via === 'rule') {
        await release();
        return handBack === 'staff_gas_share_used'
          ? fail(429, 'staff_gas_share_used', `${lines[0]} Nothing was sent. Ask the owners to approve it instead.`, { reasons: ['staff_gas_share_used'] })
          : fail(409, 'outside_rule', outsideRuleText(lines), { reasons: [handBack] });
      }
      staff = { kind: 'ask', reasons: [handBack], lines };
      route = 'asked_owners';
      await deps.db.update(walletTransfers).set({ route, updatedAt: deps.now() }).where(eq(walletTransfers.id, id));
    }

    const why = staff?.kind === 'ask' ? staff : null;
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
          maxFeeMinor: maxFee,
        },
        contentHash: Buffer.from(record.contentHash).toString('hex'),
        walrusBlobId: Buffer.from(record.walrusBlobId).toString('hex'),
        requesterAddresses: await deps.requesterAddresses(actor.userId),
        note: `Fee shown: ${maxFee.toString()} (USDC minor units). ${reference ? `Reference ${reference}.` : ''}${why && why.lines.length ? ` Why it came to you: ${why.lines.join(' ')}` : ''}`.trim(),
      },
    );
    if (!asked.ok) {
      await release();
      return fail(asked.status, asked.code, asked.error);
    }
    await deps.db.update(walletTransfers).set({ askId: asked.ask.id, updatedAt: deps.now() }).where(eq(walletTransfers.id, id));
    const row = (await getByKey(deps, clientKey)) as Row;
    return { ok: true as const, created: true, transfer: await viewOf(deps, row), signingRequest: null, ask: asked.ask, plan: { route: 'ask_owners' as const, reasons: why?.reasons ?? [], lines: why?.lines ?? [] } };
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }
}

// ─── A staff member's payment: inside the rule, or the owners ──────────────

type StaffDecision =
  | { kind: 'rule'; read: StaffRuleRead; signer: { publicKey: string; address: string }; exchange: { built: BuiltDisclosure; provider: TravelRuleProvider } | null }
  | { kind: 'ask'; reasons: ApprovalReason[]; lines: string[] };

/** The chain client for this business's spending rules, or null: none configured, or one made for another business. */
async function spendOf(deps: TransferDeps): Promise<SpendContext | null> {
  const sc = typeof deps.spend === 'function' ? await deps.spend() : (deps.spend ?? null);
  return sc && sc.orgId === deps.orgId ? sc : null;
}

function planFor(
  deps: TransferDeps,
  actor: { role: string },
  c: { resolved: Resolved; address: string; amount: bigint; maxFee: bigint; read: StaffRuleRead; inFlight?: InFlight; exchangeAlone?: boolean },
): ApprovalPlan {
  const now = deps.now().getTime();
  const payee: PlanPayee =
    c.resolved.payeeKind === 'splash_business' ? { kind: 'splash_business', address: c.address } : { kind: 'wallet', wallet: c.resolved.payeeKind === 'exchange' ? 'exchange' : 'self_custody', address: c.address };
  const counted = c.read.facts.runningTotals[c.address.toLowerCase()];
  return approvalPlan({
    role: actor.role,
    amountMinor: c.amount,
    feeMinor: c.maxFee,
    payee,
    rule: c.read.facts.rule,
    policy: c.read.facts.policy,
    runningTotalMinor: counted ? BigInt(counted) : 0n,
    asset: 'USDC',
    nowMs: BigInt(now),
    settleByMs: BigInt(now + TRANSFER_SETTLE_WINDOW_MS),
    exchangeAlone: c.exchangeAlone === true,
    ...(c.inFlight ? { inFlight: c.inFlight } : {}),
  });
}

function linesFor(plan: ApprovalPlan, read: StaffRuleRead, amount: bigint, now: Date, fee: bigint, inFlight?: InFlight): string[] {
  return approvalReasonLines(plan, { rule: read.facts.rule, policy: read.facts.policy, amountMinor: amount, feeMinor: fee, ...(inFlight ? { inFlight } : {}), nowMs: now.getTime() });
}

const outsideRuleText = (lines: string[]) => `${lines.join(' ')} Nothing was sent. Ask the owners to approve it instead.`.trim();

/**
 * Does this staff payment fit the person's rule, judged by the chain now? Reads
 * only; stores nothing. Without the chain client nothing is judged: the owners
 * are asked (or, if the person insisted on paying alone, 503), and no stand-in
 * rule is ever used.
 */
async function decideStaff(
  deps: TransferDeps,
  actor: { userId: string; role: string },
  c: { resolved: Resolved; address: string; amount: bigint; maxFee: bigint; via: 'rule' | 'ask' | null; exchangeAlone: boolean; exchangeDisclosure: unknown; clientKey: string },
): Promise<StaffDecision | TransferFailure> {
  const ask = (reasons: ApprovalReason[]): StaffDecision => ({ kind: 'ask', reasons, lines: reasons.map((r) => APPROVAL_REASON_TEXT[r]) });
  if (c.via === 'ask') return { kind: 'ask', reasons: [], lines: [] };
  const sc = await spendOf(deps);
  if (!sc || !deps.staffSigner) {
    if (c.via === 'rule') return fail(503, 'staff_rule_unavailable', 'Paying under a rule is not set up for your business here, so nothing was sent. Ask the owners to approve this payment instead.');
    return ask(['staff_rule_not_wired']);
  }
  const read = await readStaffRule(sc, { addresses: await deps.requesterAddresses(actor.userId) });
  if (!read.ok) {
    if (c.via === 'rule') return fail(read.status >= 500 ? read.status : 502, 'rule_unreadable', 'Your spending rule could not be read from the chain, so nothing was sent. Try again in a moment, or ask the owners to approve this payment.');
    return ask(['policy_unreadable']);
  }
  const plan = planFor(deps, actor, { resolved: c.resolved, address: c.address, amount: c.amount, maxFee: c.maxFee, read: read.read, exchangeAlone: c.exchangeAlone });
  if (plan.route === 'blocked') return fail(403, 'cannot_pay', linesFor(plan, read.read, c.amount, deps.now(), c.maxFee).join(' '), { reasons: plan.reasons });
  if (plan.route === 'ask_owners') {
    const lines = linesFor(plan, read.read, c.amount, deps.now(), c.maxFee);
    if (c.via === 'rule') return fail(409, 'outside_rule', outsideRuleText(lines), { reasons: plan.reasons });
    return { kind: 'ask', reasons: plan.reasons, lines };
  }
  if (plan.route !== 'staff_rule') return fail(409, 'outside_rule', 'This payment is not one a rule pays. Nothing was sent.');

  // It fits. It is paid by this person's own passkey, so that passkey must be the rule's and must be one they can sign with here.
  const signer = await deps.staffSigner(actor.userId);
  if (!signer || !read.read.spender || normalizeSuiAddress(signer.address) !== read.read.spender) {
    if (c.via === 'rule') return fail(409, 'no_passkey_for_rule', "Your spending rule belongs to a passkey you can't sign with on this site, so nothing was sent. Ask the owners to approve this payment instead.");
    return ask(['rule_needs_passkey']);
  }
  if (!sc.wallet.signing.sponsor) {
    if (c.via === 'rule') return fail(503, 'no_sponsor', 'Paying under a rule needs Splash to cover the network fee, and that is not set up here, so nothing was sent. Ask the owners to approve this payment instead.');
    return ask(['staff_rule_not_wired']);
  }
  // The recipient is a fresh CLEAR here and a proven wallet (or a confirmed exchange account) the supplier holds, as it must be for the owners' own payment.
  // It is judged as the kind it is declared as (an exchange account, or a wallet), never as the kind its payee happens to resolve to: a Splash
  // business that is on a rule is not a saved wallet, and is refused here like any other wallet that is not saved.
  const declared = c.resolved.payeeKind === 'exchange' ? 2 : 1;
  const screened = await recipientPayable(deps.ctx, deps.orgId, c.address, declared, actor.userId);
  if (screened) return fail(screened.status, screened.code, screened.error);
  if (c.resolved.payeeKind !== 'exchange') return { kind: 'rule', read: read.read, signer, exchange: null };

  // An exchange account paid alone: the Travel Rule provider must be there (in production no sandbox stands in), and the person must have
  // read and confirmed exactly the message the server would send. Nothing is built, stored or sent before both.
  const provider = travelRuleProviderFor(deps);
  if (!provider.ok) return fail(provider.status, provider.code, provider.error);
  const checked = await confirmedDisclosure(deps, actor, { resolved: c.resolved, address: c.address, amount: c.amount, clientKey: c.clientKey, confirmation: c.exchangeDisclosure });
  if ('ok' in checked && !checked.ok) return checked;
  return { kind: 'rule', read: read.read, signer, exchange: { built: checked as BuiltDisclosure, provider: provider.provider } };
}

type BuiltDisclosure = { disclosure: import('../compliance/exchange-disclosure.ts').ExchangeDisclosure; canonical: string; hash: string; applicantId: string };

/** The owner's switch for this person, now. No switch wired means no. */
async function exchangeAloneNow(deps: TransferDeps, userId: string): Promise<boolean> {
  return deps.payExchangeAlone ? (await deps.payExchangeAlone(userId)) === true : false;
}

/** The message for a payment from what the server holds, for this business and this saved recipient only. */
async function buildDisclosureFor(
  deps: TransferDeps,
  actor: { userId: string },
  c: { resolved: Resolved; address: string; amount: bigint; clientKey: string; purpose: unknown },
): Promise<({ ok: true } & BuiltDisclosure) | TransferFailure> {
  const members = await deps.walletMembers();
  if (!members.ok) return fail(members.status, members.code, members.error);
  const [row] = c.resolved.recipientId
    ? await deps.db.select().from(suppliers).where(and(eq(suppliers.orgId, deps.orgId), eq(suppliers.id, c.resolved.recipientId))).limit(1)
    : [];
  if (!row) return fail(404, 'recipient_not_found', 'No such recipient.');
  const built = await buildExchangeDisclosure(deps.db, {
    orgId: deps.orgId,
    clientKey: c.clientKey,
    actor,
    recipient: {
      legalName: row.legalName || row.name,
      registrationNumber: row.registrationNumber ?? null,
      country: row.addressCountry || row.country || null,
      town: row.addressCity ?? null,
      street: row.addressLine1 ?? null,
      postCode: row.addressPostalCode ?? null,
      exchangeId: row.exchangeId ?? null,
      address: c.address,
    },
    amountMinor: c.amount,
    walletAddress: members.address,
    purpose: c.purpose,
  });
  return built.ok ? built : fail(built.status, built.code, built.error);
}

/** The person confirmed what the server would send: their purpose, and the hash of the text they read. Anything else is read again. */
async function confirmedDisclosure(
  deps: TransferDeps,
  actor: { userId: string },
  c: { resolved: Resolved; address: string; amount: bigint; clientKey: string; confirmation: unknown },
): Promise<BuiltDisclosure | TransferFailure> {
  const given = (c.confirmation && typeof c.confirmation === 'object' ? c.confirmation : null) as { purpose?: unknown; confirmedHash?: unknown } | null;
  if (!given || typeof given.confirmedHash !== 'string') {
    return fail(409, 'exchange_disclosure_required', 'Read what will be shared with the exchange and confirm it first. Nothing was sent and nothing was built.');
  }
  const built = await buildDisclosureFor(deps, actor, { resolved: c.resolved, address: c.address, amount: c.amount, clientKey: c.clientKey, purpose: given.purpose });
  if (!built.ok) return built;
  if (built.hash !== given.confirmedHash) {
    return fail(409, 'exchange_disclosure_changed', 'What will be shared with the exchange changed since you read it. Read it again and confirm. Nothing was sent.', { disclosure: { hash: built.hash, text: disclosureText(built.disclosure) } });
  }
  return built;
}

/**
 * What a staff member is shown before paying an exchange account alone: the message, in plain words, and the hash to confirm it
 * with. Built on the server from what it holds; stores nothing and shares nothing. Refused for a person who is not allowed, for an
 * owner (the owners send their own) and where the Travel Rule provider is not configured.
 */
export async function previewExchangeDisclosure(
  deps: TransferDeps,
  actor: { userId: string; role: string },
  input: { clientKey: unknown; payee: PayeeInput; amountMinor: unknown; purpose: unknown },
): Promise<({ ok: true; disclosure: BuiltDisclosure['disclosure']; text: DisclosureText; hash: string }) | TransferFailure> {
  if (actor.role === 'OWNER') return fail(409, 'owners_send_their_own', 'The owners send their own Travel Rule message when they pay an exchange account. This message is for staff who pay alone.');
  if (actor.role !== 'MAKER' && actor.role !== 'APPROVER') return fail(403, 'cannot_pay', 'Viewers can look at payments but cannot make them.');
  const clientKey = validClientKey(input.clientKey);
  if (!clientKey) return fail(400, 'idempotency_key_required', 'An intent id (8 to 80 letters, digits, - or _) is needed.');
  const amount = digits(input.amountMinor);
  if (amount === null || amount <= 0n) return fail(400, 'bad_amount', 'Say how much USDC to pay: an amount above zero.');
  if (!(await exchangeAloneNow(deps, actor.userId))) return fail(409, 'exchange_alone_off', EXCHANGE_ALONE_OFF_TEXT);
  const provider = travelRuleProviderFor(deps);
  if (!provider.ok) return fail(provider.status, provider.code, provider.error);
  const members = await deps.walletMembers();
  if (!members.ok) return fail(members.status, members.code, members.error);
  const resolved = await resolvePayee(deps, input.payee);
  if ('ok' in resolved) return resolved;
  if (resolved.payeeKind !== 'exchange') return fail(409, 'not_an_exchange_recipient', 'This recipient is not saved as an exchange account, so there is no Travel Rule message to confirm.');
  const built = await buildDisclosureFor(deps, actor, { resolved, address: normalizeSuiAddress(resolved.address), amount, clientKey, purpose: input.purpose });
  if (!built.ok) return built;
  return { ok: true, disclosure: built.disclosure, text: disclosureText(built.disclosure), hash: built.hash };
}

/**
 * Where the Travel Rule message of a staff member's own payment stands (its signing request id), so the payment can show it wherever it is shown
 * and offer to send it again. Null when the payment has no message (it is not an exchange payment). Only the person who made the payment; another
 * person's, or another business's, reads as absent.
 */
export async function readExchangeMessage(
  deps: TransferDeps,
  actor: { userId: string; role: string },
  input: { signingRequestId: string },
): Promise<{ ok: true; travelRule: ExchangeMessageState | null } | TransferFailure> {
  const [transfer] = await deps.db
    .select({ requestedBy: walletTransfers.requestedBy, route: walletTransfers.route })
    .from(walletTransfers)
    .where(and(eq(walletTransfers.orgId, deps.orgId), eq(walletTransfers.signingRequestId, input.signingRequestId)))
    .limit(1);
  if (!transfer || transfer.requestedBy !== actor.userId) return fail(404, 'not_found', 'No such payment.');
  if (transfer.route !== 'staff_rule') return { ok: true, travelRule: null };
  const stored = await readStoredDisclosure(deps.db, deps.orgId, { signingRequestId: input.signingRequestId });
  return { ok: true, travelRule: stored ? await exchangeMessageStateOf(deps.db, deps.orgId, input.signingRequestId) : null };
}

/**
 * Send the stored message for a staff member's own payment again (its signing request id): when the provider could not be reached the
 * first time. It is made from the payload kept with the payment and nothing else, goes once, and only for the person who made the
 * payment, while the owner's switch is still on. Another business's, or another person's, payment reads as absent.
 */
export async function sendStoredExchangeMessage(
  deps: TransferDeps,
  actor: { userId: string; role: string },
  input: { signingRequestId: string },
): Promise<{ ok: true; travelRule: ExchangeMessageState } | TransferFailure> {
  const [transfer] = await deps.db
    .select({ id: walletTransfers.id, requestedBy: walletTransfers.requestedBy, route: walletTransfers.route })
    .from(walletTransfers)
    .where(and(eq(walletTransfers.orgId, deps.orgId), eq(walletTransfers.signingRequestId, input.signingRequestId)))
    .limit(1);
  const stored = transfer && transfer.requestedBy === actor.userId && transfer.route === 'staff_rule' ? await readStoredDisclosure(deps.db, deps.orgId, { signingRequestId: input.signingRequestId }) : null;
  if (!stored) return fail(404, 'not_found', 'No such payment.');
  if (!(await exchangeAloneNow(deps, actor.userId))) return fail(409, 'exchange_alone_off', EXCHANGE_ALONE_OFF_TEXT);
  const provider = travelRuleProviderFor(deps);
  if (!provider.ok) return fail(provider.status, provider.code, provider.error);
  const travelRule = await sendMessage({ db: deps.db, orgId: deps.orgId, now: deps.now, provider: provider.provider }, stored.payload, { signingRequestId: input.signingRequestId, createdBy: actor.userId });
  return { ok: true, travelRule };
}

/**
 * A claim on an intent id that has no request yet still holds its cap this long. A request is made within seconds, or
 * after a slow upload of the audit bundle within minutes; one older than this was left by a request that died.
 */
export const TRANSFER_CLAIM_HOLD_MS = 15 * 60_000;

type Flight = { requestedBy: string; address: string; amount: bigint; total: bigint; waiting: boolean };

/**
 * Every staff payment under a rule in this business that the chain has not
 * counted yet: requests still collecting or on their way, a claim still being
 * made, and requests that executed after the rule was read. `waiting` marks
 * the ones still to be signed or on their way (not the ones already counted
 * by the time they executed).
 */
async function staffFlight(db: DrizzleDb, deps: Pick<TransferDeps, 'orgId' | 'now'>, readAtMs: bigint): Promise<Flight[]> {
  const nowMs = deps.now().getTime();
  const rows = await db
    .select({ amount: walletTransfers.amountMinor, fee: walletTransfers.maxFeeMinor, address: walletTransfers.address, requestedBy: walletTransfers.requestedBy, requestId: walletTransfers.signingRequestId, createdAt: walletTransfers.createdAt })
    .from(walletTransfers)
    .where(and(eq(walletTransfers.orgId, deps.orgId), eq(walletTransfers.route, 'staff_rule'), gte(walletTransfers.createdAt, new Date(nowMs - 24 * 3_600_000))));
  const ids = rows.map((r) => r.requestId).filter((v): v is string => Boolean(v));
  const requests = ids.length
    ? await db
        .select({ id: walletSigningRequests.id, status: walletSigningRequests.status, closedAt: walletSigningRequests.closedAt, expiresAt: walletSigningRequests.expiresAt })
        .from(walletSigningRequests)
        .where(and(eq(walletSigningRequests.orgId, deps.orgId), inArray(walletSigningRequests.id, ids)))
    : [];
  const byId = new Map(requests.map((r) => [r.id, r]));
  const out: Flight[] = [];
  for (const r of rows) {
    const req = r.requestId ? byId.get(r.requestId) : undefined;
    let counts = false;
    let waiting = true;
    if (!r.requestId) counts = nowMs - r.createdAt.getTime() < TRANSFER_CLAIM_HOLD_MS;
    // A request still collecting past its end can no longer be signed (the sweep has not closed it yet): it holds nothing.
    else if (req && req.status === 'collecting') counts = req.expiresAt.getTime() > nowMs;
    else if (req && ['submitting', 'unknown'].includes(String(req.status))) counts = true;
    else if (req && req.status === 'executed') {
      counts = (req.closedAt?.getTime() ?? 0) > Number(readAtMs);
      waiting = false;
    }
    if (counts) out.push({ requestedBy: r.requestedBy, address: normalizeSuiAddress(r.address), amount: r.amount, total: r.amount + r.fee, waiting });
  }
  return out;
}

/**
 * What this person has asked for under their rule that the chain has not
 * counted yet (their cap and their open payments), and what everyone in this
 * business has asked to pay this recipient (the second-approval amount is the
 * recipient's, not the person's). Only this business's.
 */
async function inFlightFor(db: DrizzleDb, deps: Pick<TransferDeps, 'orgId' | 'now'>, userId: string, address: string, readAtMs: bigint): Promise<InFlight> {
  const flight = await staffFlight(db, deps, readAtMs);
  let spender = 0n;
  let recipient = 0n;
  let open = 0;
  for (const f of flight) {
    if (f.requestedBy === userId) {
      spender += f.total;
      if (f.waiting) open += 1;
    }
    if (f.address === address) recipient += f.amount;
  }
  return { spenderMinor: spender, recipientMinor: recipient, openCount: open };
}

/**
 * What the Transfer page needs to plan with what is already on its way: the
 * caller's own total and open payments, and everyone's towards each recipient
 * (GET /api/wallet/transfers/context). `readAtMs` is taken before the chain
 * is read for the same figures.
 */
export async function staffInFlight(db: DrizzleDb, deps: Pick<TransferDeps, 'orgId' | 'now'>, userId: string, readAtMs: bigint): Promise<{ spenderMinor: string; openCount: number; byRecipient: Record<string, string> }> {
  const flight = await staffFlight(db, deps, readAtMs);
  const byRecipient: Record<string, bigint> = {};
  let spender = 0n;
  let open = 0;
  for (const f of flight) {
    if (f.requestedBy === userId) {
      spender += f.total;
      if (f.waiting) open += 1;
    }
    byRecipient[f.address] = (byRecipient[f.address] ?? 0n) + f.amount;
  }
  return { spenderMinor: spender.toString(), openCount: open, byRecipient: Object.fromEntries(Object.entries(byRecipient).map(([k, v]) => [k, v.toString()])) };
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
