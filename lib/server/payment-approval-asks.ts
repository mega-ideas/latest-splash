/**
 * Asking the owners to approve a payment (v2 §4.1; Sky, 25 Oct: "Staff can
 * ask for approval").
 *
 * A staff member's payment that their spending rule does not cover, or one
 * above the second-approval threshold, needs the owners. Anyone in the
 * business but a viewer may ask. There are two kinds of ask:
 *
 *   draft     A payment the rule does not allow at all: over the per-payment
 *             maximum, or to a recipient the policy does not list.
 *             `splash_spend::create_intent` refuses those, so no intent can
 *             exist; the staff member asks with the payment itself (payee,
 *             amount, kind, rate, its commitments and expiry). Splash checks
 *             its shape and, from the policy, shows the owners why it came to
 *             them (the payee is not verified, it is over the asker's
 *             maximum). Only the quorum can pay it: create_for_wallet +
 *             confirm_from_business_wallet_balance.
 *   intent    A payment opened under the rule (the intent's on-chain maker is
 *             one of the asker's passkey addresses; an owner may ask about
 *             any) that still needs the owners: the rule's cap is used up, or
 *             it is above the second-approval threshold. The intent is read
 *             from the chain: this business's, still waiting, unexpired, in
 *             USDC, not cross-chain. What owners are shown is that reading,
 *             never what the client sent.
 *
 * One open ask per payment (per intent, or per draft's payment reference).
 *
 *   accept    An OWNER turns the ask into a signing request:
 *               wallet_pays     the quorum pays it from the business wallet
 *                               (a draft: requestWalletPayment; an intent:
 *                               requestOpenIntentPayment);
 *               second_approval one owner's `splash_spend::approve_payout`,
 *                               for an intent within the rule but above the
 *                               second-approval threshold (§4.2,
 *                               lib/server/spend-rules.ts). Not for a draft.
 *             The ask is claimed before anything is built, so two owners
 *             accepting at once open one request, not two. When that request
 *             executes the ask is approved. If it fails or expires, the ask
 *             can be accepted again.
 *   decline   An owner, while the ask is open.
 *   withdraw  Only the person who asked, while it is open.
 *
 * Every step is in the audit trail (lib/server/wallet-authority.ts). Every
 * read takes the caller's org; another org's ask reads as absent.
 */
import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';

import { memberships, walletApprovalAsks, walletSigningRequests } from '../db/schema.ts';
import { MAX_INTENT_LIFETIME_MS, V2_KIND } from './sui-v2-builders.ts';
import { memberRole, recordAuthorityEvent } from './wallet-authority.ts';
import type { IntentState, WalletContext, WalletMembers } from './business-wallet.ts';
import type { RequestView } from './wallet-signing.ts';
import type { DrizzleDb, StoredRequest } from './wallet-signing-store.ts';

export type AskFailure = { ok: false; status: number; code: string; error: string };
const fail = (status: number, code: string, error: string): AskFailure => ({ ok: false, status, code, error });
type Clock = () => Date;

export type AskIntent = {
  /** 'intent': an intent on chain. 'draft': a payment the rule cannot open (older rows have no source: an intent). */
  source?: 'intent' | 'draft';
  /** The intent's id, or for a draft `draft:` and its payment reference. */
  intentId: string;
  maker: string | null;
  recipient: string;
  amountMinor: string;
  kind: number;
  targetCurrency: string;
  fxRateUsdLocal: string;
  expiresAtMs: string;
  /** A draft's own fields, hex: what create_for_wallet is given. */
  paymentRef?: string;
  beneficiaryRef?: string;
  commitment?: string;
  railCommitment?: string;
  /** Why it needs the owners, from the policy; null where the policy could not be read. */
  checks?: { recipientVerified: boolean | null; overPerPaymentMax: boolean | null; makerPerPaymentMaxMinor: string | null };
};

/** A payment the rule cannot open, as the staff member's device composed it. */
export type AskDraft = {
  /** 32 bytes, hex: the business's commitment over its payment id (one intent per reference, ever). */
  paymentRef: string;
  recipient: string;
  /** 32 bytes, hex, on a bank payout; empty otherwise. */
  beneficiaryRef?: string;
  amountMinor: bigint | string;
  kind: number;
  targetCurrency: string;
  fxRateUsdLocal: bigint | string;
  commitment: string;
  railCommitment: string;
  expiresAtMs: bigint | string;
};

/** What the policy says, for showing a draft's reasons. */
export type AskPolicy = {
  perPaymentMax: bigint;
  spenders: Array<{ spender: string; perPaymentMax: bigint }>;
  recipients: Array<{ address: string }>;
  beneficiaries: Array<{ commitment: string }>;
};

export type AskStatus = 'open' | 'signing' | 'approved' | 'declined' | 'withdrawn' | 'expired';

export type ApprovalAsk = {
  id: string;
  intentId: string;
  requestedBy: string;
  intent: AskIntent;
  note: string | null;
  status: AskStatus;
  signingRequestId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string;
  createdAt: string;
};

/** Requests that are still collecting or on their way; anything else is over. */
const LIVE_REQUEST = new Set(['collecting', 'submitting', 'unknown']);

type AskRow = typeof walletApprovalAsks.$inferSelect;

/** An accept that claimed the ask and never wrote its request (it crashed) frees the ask after this. */
const CLAIM_TTL_MS = 120_000;

/** Whether a 'signing' ask is really over: its request is dead, or the claim was never completed. */
function signingIsDead(row: AskRow, requestStatus: string | null, now: Date): boolean {
  if (row.status !== 'signing') return false;
  if (row.signingRequestId === null) return row.updatedAt.getTime() + CLAIM_TTL_MS <= now.getTime();
  return requestStatus !== null && !LIVE_REQUEST.has(requestStatus) && requestStatus !== 'executed';
}

function viewOf(row: AskRow, requestStatus: string | null, now: Date): ApprovalAsk {
  let status = row.status as AskStatus;
  // A signing request that failed, expired or was withdrawn hands the ask back.
  if (signingIsDead(row, requestStatus, now)) status = 'open';
  if (status === 'open' && row.expiresAt.getTime() <= now.getTime()) status = 'expired';
  return {
    id: row.id,
    intentId: row.intentId,
    requestedBy: row.requestedBy,
    intent: row.intent as AskIntent,
    note: row.note,
    status,
    signingRequestId: row.signingRequestId,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decisionNote: row.decisionNote,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

async function requestStatuses(db: DrizzleDb, orgId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: walletSigningRequests.id, status: walletSigningRequests.status })
    .from(walletSigningRequests)
    .where(and(eq(walletSigningRequests.orgId, orgId), inArray(walletSigningRequests.id, ids)));
  return new Map(rows.map((r) => [r.id, String(r.status)]));
}

async function readAsk(db: DrizzleDb, orgId: string, id: string): Promise<AskRow | null> {
  const [row] = await db.select().from(walletApprovalAsks).where(and(eq(walletApprovalAsks.orgId, orgId), eq(walletApprovalAsks.id, String(id)))).limit(1);
  return row ?? null;
}

async function viewOne(db: DrizzleDb, row: AskRow, now: Date): Promise<ApprovalAsk> {
  const statuses = await requestStatuses(db, row.orgId, row.signingRequestId ? [row.signingRequestId] : []);
  return viewOf(row, row.signingRequestId ? (statuses.get(row.signingRequestId) ?? null) : null, now);
}

function isHex(value: string, minBytes: number, maxBytes: number): boolean {
  return /^([0-9a-f]{2})+$/.test(value) && value.length / 2 >= minBytes && value.length / 2 <= maxBytes;
}

const U64_MAX = 18_446_744_073_709_551_615n;

function bigintOf(v: bigint | string | number | null | undefined): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^\d{1,20}$/.test(v)) return BigInt(v);
  return null;
}

/** A draft's shape, checked before anything is stored or built. */
function readDraft(d: AskDraft, now: Date): AskIntent | AskFailure {
  const hex = (v: unknown) => String(v ?? '').toLowerCase().replace(/^0x/, '');
  const paymentRef = hex(d.paymentRef);
  const commitment = hex(d.commitment);
  const railCommitment = hex(d.railCommitment);
  const beneficiaryRef = hex(d.beneficiaryRef ?? '');
  const amount = bigintOf(d.amountMinor);
  const fx = bigintOf(d.fxRateUsdLocal);
  const expires = bigintOf(d.expiresAtMs);
  const kind = Number(d.kind);
  const nowMs = BigInt(now.getTime());
  if (!isHex(paymentRef, 32, 32) || !isHex(commitment, 32, 32) || !isHex(railCommitment, 32, 32)) {
    return fail(400, 'bad_draft', "the payment's references could not be read");
  }
  if (kind === V2_KIND.CROSS_CHAIN) return fail(400, 'cross_chain_not_built', 'a cross-chain payment is paid through a bridge adapter, which is not registered yet');
  if (![V2_KIND.SPLASH_BUSINESS, V2_KIND.WALLET, V2_KIND.EXCHANGE, V2_KIND.BANK_PAYOUT].includes(kind as 0)) return fail(400, 'bad_draft', 'the kind of payment could not be read');
  if (kind === V2_KIND.BANK_PAYOUT ? !isHex(beneficiaryRef, 32, 32) : beneficiaryRef !== '') return fail(400, 'bad_draft', 'a bank payout names its beneficiary, and nothing else does');
  if (amount === null || amount <= 0n || amount > U64_MAX) return fail(400, 'bad_draft', 'the amount must be above zero');
  if (fx === null || fx <= 0n || fx > U64_MAX) return fail(400, 'bad_draft', 'the rate could not be read');
  if (expires === null || expires <= nowMs || expires > nowMs + MAX_INTENT_LIFETIME_MS) return fail(400, 'bad_draft', 'the payment must expire in the future, within 30 days');
  const currency = String(d.targetCurrency ?? '');
  if (!/^[A-Z]{3,5}$/.test(currency)) return fail(400, 'bad_draft', 'the target currency could not be read');
  let recipient: string;
  try {
    recipient = normalizeSuiAddress(String(d.recipient ?? ''));
  } catch {
    return fail(400, 'bad_draft', 'the payee could not be read');
  }
  if (!/^0x[0-9a-f]{64}$/.test(recipient) || /^0x0+$/.test(recipient)) return fail(400, 'bad_draft', 'the payee could not be read');
  return {
    source: 'draft',
    intentId: `draft:${paymentRef}`,
    maker: null,
    recipient,
    amountMinor: amount.toString(),
    kind,
    targetCurrency: currency,
    fxRateUsdLocal: fx.toString(),
    expiresAtMs: expires.toString(),
    paymentRef,
    beneficiaryRef,
    commitment,
    railCommitment,
  };
}

/** Why a draft needs the owners, from the current policy. Never refuses: the owners decide. */
async function draftChecks(policy: (() => Promise<AskPolicy | null>) | undefined, shown: AskIntent, requesterAddresses: string[]): Promise<NonNullable<AskIntent['checks']>> {
  let p: AskPolicy | null = null;
  try {
    p = policy ? await policy() : null;
  } catch {
    p = null;
  }
  if (!p) return { recipientVerified: null, overPerPaymentMax: null, makerPerPaymentMaxMinor: null };
  const mine = new Set(requesterAddresses.map((a) => normalizeSuiAddress(a)));
  const own = p.spenders.filter((s) => mine.has(normalizeSuiAddress(s.spender)));
  const ownMax = own.length ? own.reduce((m, s) => (s.perPaymentMax > m ? s.perPaymentMax : m), 0n) : null;
  const amount = BigInt(shown.amountMinor);
  const verified =
    shown.kind === V2_KIND.BANK_PAYOUT
      ? p.beneficiaries.some((b) => b.commitment.toLowerCase() === shown.beneficiaryRef)
      : p.recipients.some((r) => normalizeSuiAddress(r.address) === shown.recipient);
  return {
    recipientVerified: verified,
    overPerPaymentMax: amount > p.perPaymentMax || (ownMax !== null && amount > ownMax),
    makerPerPaymentMaxMinor: ownMax === null ? null : ownMax.toString(),
  };
}

/**
 * Ask the owners to approve one payment: an open intent (`intentId`) or a
 * draft the rule cannot open (`draft`). `requesterAddresses` are the asker's
 * own passkey addresses, read by the caller from Postgres.
 */
export async function askOwnersToApprove(
  deps: { db: DrizzleDb; ctx: WalletContext; now?: Clock; policy?: () => Promise<AskPolicy | null>; notify?: AskNotifier },
  input: { orgId: string; userId: string; intentId?: string; draft?: AskDraft; contentHash: string; walrusBlobId: string; requesterAddresses: string[]; note?: string | null },
): Promise<{ ok: true; ask: ApprovalAsk } | AskFailure> {
  const now = (deps.now ?? deps.ctx.signing.now ?? (() => new Date()))();
  const role = await memberRole(deps.db, input.orgId, input.userId);
  if (role === null || role === 'viewer') return fail(403, 'cannot_ask', 'only a member who makes or approves payments can ask the owners');
  const contentHash = String(input.contentHash ?? '').toLowerCase();
  const blob = String(input.walrusBlobId ?? '').toLowerCase();
  if (!isHex(contentHash, 32, 32) || !isHex(blob, 1, 128)) return fail(400, 'bad_audit_bundle', "the payment's audit bundle reference could not be read");
  const note = input.note == null ? null : String(input.note).slice(0, 500);
  if ((input.draft == null) === (input.intentId == null || input.intentId === '')) {
    return fail(400, 'bad_ask', 'ask about one payment: an open one, or a draft');
  }
  if (input.draft) {
    const shown = readDraft(input.draft, now);
    if ('ok' in shown) return shown;
    shown.checks = await draftChecks(deps.policy, shown, input.requesterAddresses);
    return storeAsk(deps.db, deps.notify, { orgId: input.orgId, userId: input.userId, shown, note, contentHash, blob, now });
  }
  if (!deps.ctx.readIntent) return fail(503, 'no_chain', 'the payment cannot be read from the chain');

  let intent: IntentState | null;
  try {
    intent = await deps.ctx.readIntent(normalizeSuiAddress(String(input.intentId)));
  } catch {
    return fail(502, 'intent_unreadable', 'the payment could not be read from the chain');
  }
  if (!intent || !intent.account || normalizeSuiAddress(intent.account) !== normalizeSuiAddress(deps.ctx.account.objectId)) {
    return fail(404, 'not_found', 'no such payment');
  }
  if (role !== 'admin') {
    const mine = new Set(input.requesterAddresses.map((a) => normalizeSuiAddress(a)));
    if (!intent.maker || !mine.has(normalizeSuiAddress(intent.maker))) {
      return fail(403, 'not_your_payment', 'you can ask the owners about a payment you opened yourself');
    }
  }
  if (intent.status !== 0) return fail(409, 'intent_not_open', 'this payment is no longer waiting to be paid');
  if (intent.expiresAtMs <= BigInt(now.getTime())) return fail(409, 'intent_expired', 'this payment has expired');
  if (normalizeStructTag(intent.asset) !== normalizeStructTag(deps.ctx.chain.usdcType)) return fail(400, 'wrong_asset', 'a payment may move USDC only');
  if (intent.kind === V2_KIND.CROSS_CHAIN) return fail(400, 'cross_chain_not_built', 'a cross-chain payment is paid through a bridge adapter, which is not registered yet');

  const shown: AskIntent = {
    source: 'intent',
    intentId: normalizeSuiAddress(intent.id),
    maker: intent.maker ? normalizeSuiAddress(intent.maker) : null,
    recipient: normalizeSuiAddress(intent.recipient),
    amountMinor: intent.amountMinor.toString(),
    kind: intent.kind,
    targetCurrency: intent.targetCurrency,
    fxRateUsdLocal: intent.fxRateUsdLocal.toString(),
    expiresAtMs: intent.expiresAtMs.toString(),
  };
  return storeAsk(deps.db, deps.notify, { orgId: input.orgId, userId: input.userId, shown, note, contentHash, blob, now });
}

/**
 * Tells the owners an ask is waiting (the live route sends it on their
 * approver channels). Best effort: the ask stands whatever the channel does.
 */
export type AskNotifier = (n: { orgId: string; ask: ApprovalAsk; ownerUserIds: string[] }) => Promise<void>;

async function ownersBut(db: DrizzleDb, orgId: string, userId: string): Promise<string[]> {
  const rows = await db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'admin')));
  return rows.map((r) => r.userId).filter((u) => u !== userId).sort();
}

async function storeAsk(
  db: DrizzleDb,
  notify: AskNotifier | undefined,
  a: { orgId: string; userId: string; shown: AskIntent; note: string | null; contentHash: string; blob: string; now: Date },
): Promise<{ ok: true; ask: ApprovalAsk } | AskFailure> {
  const stored = await insertAsk(db, a);
  if (stored.ok && notify) {
    try {
      await notify({ orgId: a.orgId, ask: stored.ask, ownerUserIds: await ownersBut(db, a.orgId, a.userId) });
    } catch {
      // The ask is in the owners' inbox in the app either way.
    }
  }
  return stored;
}

async function insertAsk(
  db: DrizzleDb,
  a: { orgId: string; userId: string; shown: AskIntent; note: string | null; contentHash: string; blob: string; now: Date },
): Promise<{ ok: true; ask: ApprovalAsk } | AskFailure> {
  const id = `wpa_${randomUUID()}`;
  try {
    await db.insert(walletApprovalAsks).values({
      id,
      orgId: a.orgId,
      intentId: a.shown.intentId,
      requestedBy: a.userId,
      intent: a.shown,
      note: a.note,
      contentHash: a.contentHash,
      walrusBlobId: a.blob,
      status: 'open',
      expiresAt: new Date(Number(a.shown.expiresAtMs)),
      createdAt: a.now,
      updatedAt: a.now,
    });
  } catch {
    return fail(409, 'ask_open', 'the owners have already been asked about this payment');
  }
  await recordAuthorityEvent(db, {
    orgId: a.orgId,
    actorUserId: a.userId,
    action: 'approval_requested',
    ref: id,
    detail: { source: a.shown.source, intentId: a.shown.intentId, amountMinor: a.shown.amountMinor, recipient: a.shown.recipient, ...(a.shown.checks ? { checks: a.shown.checks } : {}) },
    now: () => a.now,
  });
  const row = (await readAsk(db, a.orgId, id)) as AskRow;
  return { ok: true, ask: viewOf(row, null, a.now) };
}

/** Owners and approvers see every ask in the business; anyone else, their own. */
export async function listApprovalAsks(db: DrizzleDb, input: { orgId: string; userId: string; now?: Clock }): Promise<ApprovalAsk[]> {
  const now = (input.now ?? (() => new Date()))();
  const role = await memberRole(db, input.orgId, input.userId);
  if (role === null) return [];
  const seesAll = role === 'admin' || role === 'checker';
  const rows = await db
    .select()
    .from(walletApprovalAsks)
    .where(seesAll ? eq(walletApprovalAsks.orgId, input.orgId) : and(eq(walletApprovalAsks.orgId, input.orgId), eq(walletApprovalAsks.requestedBy, input.userId)));
  const statuses = await requestStatuses(db, input.orgId, rows.map((r) => r.signingRequestId).filter((x): x is string => Boolean(x)));
  return rows
    .map((r) => viewOf(r, r.signingRequestId ? (statuses.get(r.signingRequestId) ?? null) : null, now))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export type AcceptMode = 'wallet_pays' | 'second_approval';

/**
 * Hooks the second-approval path in (lib/server/spend-rules.ts), so this
 * module does not import the spending-rule builders.
 */
export type SecondApprovalOpener = (input: {
  orgId: string;
  ownerUserId: string;
  intentId: string;
  payer: string;
  maxFeeMinor: bigint;
  settleByMs: bigint;
}) => Promise<{ ok: true; request: RequestView } | AskFailure>;

/** An owner turns an open ask into the signing request that approves it. */
export async function acceptApprovalAsk(
  deps: { db: DrizzleDb; ctx: WalletContext; now?: Clock; secondApproval?: SecondApprovalOpener },
  input: { orgId: string; userId: string; askId: string; mode: AcceptMode; wallet?: WalletMembers; maxFeeMinor: bigint; settleByMs: bigint },
): Promise<{ ok: true; ask: ApprovalAsk; request: RequestView } | AskFailure> {
  const now = (deps.now ?? deps.ctx.signing.now ?? (() => new Date()))();
  const row = await readAsk(deps.db, input.orgId, input.askId);
  if (!row) return fail(404, 'not_found', 'no such ask');
  if ((await memberRole(deps.db, input.orgId, input.userId)) !== 'admin') return fail(403, 'not_an_owner', 'only an owner approves a payment');
  const current = await viewOne(deps.db, row, now);
  if (current.status !== 'open') return fail(409, 'not_open', `this ask is ${current.status}`);
  const isDraft = current.intent.source === 'draft';
  if (input.mode !== 'wallet_pays' && input.mode !== 'second_approval') return fail(400, 'bad_mode', 'the owners either pay it from the business wallet or give a second approval');
  if (input.mode === 'wallet_pays' && !input.wallet) return fail(409, 'no_wallet', 'register the business wallet first');
  if (input.mode === 'second_approval' && isDraft) return fail(409, 'no_intent', 'a second approval is for a payment already opened under a rule; pay this one from the business wallet');
  if (input.mode === 'second_approval' && !deps.secondApproval) return fail(503, 'no_spending_rules', 'spending rules are not set up for this business');

  // Claim the ask before building anything: of two owners accepting at once,
  // one wins. The claim is compare-and-swap on the state just read.
  const claimed = await deps.db
    .update(walletApprovalAsks)
    .set({ status: 'signing', signingRequestId: null, decidedBy: input.userId, decidedAt: now, updatedAt: now })
    .where(
      and(
        eq(walletApprovalAsks.orgId, input.orgId),
        eq(walletApprovalAsks.id, row.id),
        eq(walletApprovalAsks.status, row.status),
        row.signingRequestId === null ? isNull(walletApprovalAsks.signingRequestId) : eq(walletApprovalAsks.signingRequestId, row.signingRequestId),
        // Taking over a claim that never completed: only the one just read
        // (every write here stamps updatedAt from the same clock).
        ...(row.status === 'signing' && row.signingRequestId === null ? [eq(walletApprovalAsks.updatedAt, row.updatedAt)] : []),
      ),
    )
    .returning({ id: walletApprovalAsks.id });
  if (claimed.length === 0) return fail(409, 'not_open', 'another owner is already deciding this ask');
  const release = () =>
    deps.db
      .update(walletApprovalAsks)
      .set({ status: 'open', decidedBy: null, decidedAt: null, updatedAt: now })
      .where(and(eq(walletApprovalAsks.orgId, input.orgId), eq(walletApprovalAsks.id, row.id), eq(walletApprovalAsks.status, 'signing'), isNull(walletApprovalAsks.signingRequestId), eq(walletApprovalAsks.decidedBy, input.userId)));

  let opened: { ok: true; request: RequestView } | AskFailure;
  try {
    opened = await openFor(deps, input, row, current);
  } catch (error) {
    await release();
    throw error;
  }
  if (!opened.ok) {
    await release();
    return opened;
  }

  await deps.db
    .update(walletApprovalAsks)
    .set({ signingRequestId: opened.request.id, updatedAt: now })
    .where(and(eq(walletApprovalAsks.orgId, input.orgId), eq(walletApprovalAsks.id, row.id), eq(walletApprovalAsks.status, 'signing'), eq(walletApprovalAsks.decidedBy, input.userId)));
  await recordAuthorityEvent(deps.db, {
    orgId: input.orgId,
    actorUserId: input.userId,
    action: 'approval_accepted',
    subjectUserId: row.requestedBy,
    ref: row.id,
    detail: { mode: input.mode, signingRequestId: opened.request.id },
    now: () => now,
  });
  const after = (await readAsk(deps.db, input.orgId, row.id)) as AskRow;
  return { ok: true, ask: await viewOne(deps.db, after, now), request: opened.request };
}

/** The signing request an accepted ask opens. */
async function openFor(
  deps: { db: DrizzleDb; ctx: WalletContext; secondApproval?: SecondApprovalOpener },
  input: { orgId: string; userId: string; mode: AcceptMode; wallet?: WalletMembers; maxFeeMinor: bigint; settleByMs: bigint },
  row: AskRow,
  current: ApprovalAsk,
): Promise<{ ok: true; request: RequestView } | AskFailure> {
  const contentHash = new Uint8Array(Buffer.from(row.contentHash, 'hex'));
  const walrusBlobId = new Uint8Array(Buffer.from(row.walrusBlobId, 'hex'));
  if (input.mode === 'wallet_pays' && current.intent.source === 'draft') {
    const d = current.intent;
    const { requestWalletPayment } = await import('./business-wallet.ts');
    const result = await requestWalletPayment(deps.ctx, {
      orgId: input.orgId,
      requestedBy: input.userId,
      wallet: input.wallet as WalletMembers,
      payment: {
        paymentRef: new Uint8Array(Buffer.from(d.paymentRef ?? '', 'hex')),
        recipient: d.recipient,
        beneficiaryRef: new Uint8Array(Buffer.from(d.beneficiaryRef ?? '', 'hex')),
        amountMinor: BigInt(d.amountMinor),
        targetCurrency: d.targetCurrency,
        fxRateUsdLocal: BigInt(d.fxRateUsdLocal),
        commitment: new Uint8Array(Buffer.from(d.commitment ?? '', 'hex')),
        kind: d.kind,
        railCommitment: new Uint8Array(Buffer.from(d.railCommitment ?? '', 'hex')),
        expiresAtMs: BigInt(d.expiresAtMs),
        maxFeeMinor: input.maxFeeMinor,
        settleByMs: input.settleByMs,
        contentHash,
        walrusBlobId,
      },
    });
    return result.ok ? { ok: true, request: result.request } : fail(result.status, result.code, result.error);
  }
  if (input.mode === 'wallet_pays') {
    const { requestOpenIntentPayment } = await import('./business-wallet.ts');
    const result = await requestOpenIntentPayment(deps.ctx, {
      orgId: input.orgId,
      requestedBy: input.userId,
      wallet: input.wallet as WalletMembers,
      intentId: row.intentId,
      maxFeeMinor: input.maxFeeMinor,
      settleByMs: input.settleByMs,
      contentHash,
      walrusBlobId,
    });
    return result.ok ? { ok: true, request: result.request } : fail(result.status, result.code, result.error);
  }
  const payer = current.intent.maker;
  if (!payer) return fail(409, 'no_maker', 'this payment names no maker to approve it for');
  return (deps.secondApproval as SecondApprovalOpener)({ orgId: input.orgId, ownerUserId: input.userId, intentId: row.intentId, payer, maxFeeMinor: input.maxFeeMinor, settleByMs: input.settleByMs });
}

/** An owner declines an open ask. */
export async function declineApprovalAsk(
  db: DrizzleDb,
  input: { orgId: string; userId: string; askId: string; reason?: string | null; now?: Clock },
): Promise<{ ok: true } | AskFailure> {
  const now = (input.now ?? (() => new Date()))();
  const row = await readAsk(db, input.orgId, input.askId);
  if (!row) return fail(404, 'not_found', 'no such ask');
  if ((await memberRole(db, input.orgId, input.userId)) !== 'admin') return fail(403, 'not_an_owner', 'only an owner declines a payment');
  const current = await viewOne(db, row, now);
  if (current.status !== 'open') return fail(409, 'not_open', `this ask is ${current.status}`);
  const reason = input.reason == null ? null : String(input.reason).slice(0, 500);
  await db
    .update(walletApprovalAsks)
    .set({ status: 'declined', decidedBy: input.userId, decidedAt: now, decisionNote: reason, updatedAt: now })
    .where(and(eq(walletApprovalAsks.orgId, input.orgId), eq(walletApprovalAsks.id, row.id)));
  await recordAuthorityEvent(db, { orgId: input.orgId, actorUserId: input.userId, action: 'approval_declined', subjectUserId: row.requestedBy, ref: row.id, detail: reason ? { reason } : {}, now: () => now });
  return { ok: true };
}

/** The person who asked withdraws an open ask. */
export async function cancelApprovalAsk(
  db: DrizzleDb,
  input: { orgId: string; userId: string; askId: string; now?: Clock },
): Promise<{ ok: true } | AskFailure> {
  const now = (input.now ?? (() => new Date()))();
  const row = await readAsk(db, input.orgId, input.askId);
  if (!row) return fail(404, 'not_found', 'no such ask');
  if (row.requestedBy !== input.userId) return fail(403, 'not_requester', 'only the person who asked can withdraw this; an owner can decline it');
  const current = await viewOne(db, row, now);
  if (current.status !== 'open') return fail(409, 'not_open', `this ask is ${current.status}`);
  await db
    .update(walletApprovalAsks)
    .set({ status: 'withdrawn', updatedAt: now })
    .where(and(eq(walletApprovalAsks.orgId, input.orgId), eq(walletApprovalAsks.id, row.id)));
  await recordAuthorityEvent(db, { orgId: input.orgId, actorUserId: input.userId, action: 'approval_withdrawn', ref: row.id, now: () => now });
  return { ok: true };
}

/** After a signing request executes: the ask it answered is approved. */
export async function settleApprovalAsks(db: DrizzleDb, request: Pick<StoredRequest, 'id' | 'orgId' | 'status'>): Promise<number> {
  if (request.status !== 'executed') return 0;
  const done = await db
    .update(walletApprovalAsks)
    .set({ status: 'approved', updatedAt: new Date() })
    .where(and(eq(walletApprovalAsks.orgId, request.orgId), eq(walletApprovalAsks.signingRequestId, request.id), eq(walletApprovalAsks.status, 'signing')))
    .returning({ id: walletApprovalAsks.id, decidedBy: walletApprovalAsks.decidedBy, requestedBy: walletApprovalAsks.requestedBy });
  for (const d of done) {
    await recordAuthorityEvent(db, { orgId: request.orgId, actorUserId: d.decidedBy ?? d.requestedBy, action: 'approval_completed', subjectUserId: d.requestedBy, ref: d.id, detail: { signingRequestId: request.id } });
  }
  return done.length;
}
