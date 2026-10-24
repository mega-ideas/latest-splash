/**
 * Asking the owners to approve a payment (v2 §4.1; Sky, 25 Oct: "Staff can
 * ask for approval").
 *
 * A staff member's payment that their spending rule does not cover (over its
 * per-payment maximum, outside its window, to a recipient it does not list),
 * or one above the second-approval threshold, needs the owners. Anyone in the
 * business but a viewer may ask; a staff member only about a payment they
 * opened themselves (the intent's on-chain maker is one of their passkey
 * addresses). An owner may ask about any of the business's payments.
 *
 *   ask       The intent is read from the chain: it must be this business's,
 *             still waiting, unexpired, in USDC, and not cross-chain. What
 *             owners are shown (payee, principal, kind, rate, expiry) is that
 *             reading, stored with the ask, never what the client sent. One
 *             open ask per payment.
 *   accept    An OWNER turns the ask into a signing request:
 *               wallet_pays     the quorum pays the intent from the business
 *                               wallet (requestOpenIntentPayment), which
 *                               covers anything over the rule;
 *               second_approval one owner's `splash_spend::approve_payout`,
 *                               for a payment within the rule but above the
 *                               second-approval threshold (§4.2,
 *                               lib/server/spend-rules.ts).
 *             When that request executes the ask is approved. If it fails or
 *             expires, the ask can be accepted again.
 *   decline   An owner, while the ask is open.
 *   withdraw  Only the person who asked, while it is open.
 *
 * Every step is in the audit trail (lib/server/wallet-authority.ts). Every
 * read takes the caller's org; another org's ask reads as absent.
 */
import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';

import { walletApprovalAsks, walletSigningRequests } from '../db/schema.ts';
import { V2_KIND } from './sui-v2-builders.ts';
import { memberRole, recordAuthorityEvent } from './wallet-authority.ts';
import type { IntentState, WalletContext, WalletMembers } from './business-wallet.ts';
import type { RequestView } from './wallet-signing.ts';
import type { DrizzleDb, StoredRequest } from './wallet-signing-store.ts';

export type AskFailure = { ok: false; status: number; code: string; error: string };
const fail = (status: number, code: string, error: string): AskFailure => ({ ok: false, status, code, error });
type Clock = () => Date;

export type AskIntent = {
  intentId: string;
  maker: string | null;
  recipient: string;
  amountMinor: string;
  kind: number;
  targetCurrency: string;
  fxRateUsdLocal: string;
  expiresAtMs: string;
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

function viewOf(row: AskRow, requestStatus: string | null, now: Date): ApprovalAsk {
  let status = row.status as AskStatus;
  // A signing request that failed, expired or was withdrawn hands the ask back.
  if (status === 'signing' && requestStatus !== null && !LIVE_REQUEST.has(requestStatus) && requestStatus !== 'executed') status = 'open';
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

/**
 * Ask the owners to approve one open payment. `requesterAddresses` are the
 * asker's own passkey addresses, read by the caller from Postgres.
 */
export async function askOwnersToApprove(
  deps: { db: DrizzleDb; ctx: WalletContext; now?: Clock },
  input: { orgId: string; userId: string; intentId: string; contentHash: string; walrusBlobId: string; requesterAddresses: string[]; note?: string | null },
): Promise<{ ok: true; ask: ApprovalAsk } | AskFailure> {
  const now = (deps.now ?? deps.ctx.signing.now ?? (() => new Date()))();
  const role = await memberRole(deps.db, input.orgId, input.userId);
  if (role === null || role === 'viewer') return fail(403, 'cannot_ask', 'only a member who makes or approves payments can ask the owners');
  const contentHash = String(input.contentHash ?? '').toLowerCase();
  const blob = String(input.walrusBlobId ?? '').toLowerCase();
  if (!isHex(contentHash, 32, 32) || !isHex(blob, 1, 128)) return fail(400, 'bad_audit_bundle', "the payment's audit bundle reference could not be read");
  const note = input.note == null ? null : String(input.note).slice(0, 500);
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
  if (normalizeStructTag(intent.asset) !== normalizeStructTag(deps.ctx.chain.usdcType)) return fail(400, 'wrong_asset', 'a payment may move USDC only (D6)');
  if (intent.kind === V2_KIND.CROSS_CHAIN) return fail(400, 'cross_chain_not_built', 'a cross-chain payment is paid through a bridge adapter, which is not registered yet');

  const shown: AskIntent = {
    intentId: normalizeSuiAddress(intent.id),
    maker: intent.maker ? normalizeSuiAddress(intent.maker) : null,
    recipient: normalizeSuiAddress(intent.recipient),
    amountMinor: intent.amountMinor.toString(),
    kind: intent.kind,
    targetCurrency: intent.targetCurrency,
    fxRateUsdLocal: intent.fxRateUsdLocal.toString(),
    expiresAtMs: intent.expiresAtMs.toString(),
  };
  const id = `wpa_${randomUUID()}`;
  try {
    await deps.db.insert(walletApprovalAsks).values({
      id,
      orgId: input.orgId,
      intentId: shown.intentId,
      requestedBy: input.userId,
      intent: shown,
      note,
      contentHash,
      walrusBlobId: blob,
      status: 'open',
      expiresAt: new Date(Number(intent.expiresAtMs)),
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    return fail(409, 'ask_open', 'the owners have already been asked about this payment');
  }
  await recordAuthorityEvent(deps.db, {
    orgId: input.orgId,
    actorUserId: input.userId,
    action: 'approval_requested',
    ref: id,
    detail: { intentId: shown.intentId, amountMinor: shown.amountMinor, recipient: shown.recipient },
    now: () => now,
  });
  const row = (await readAsk(deps.db, input.orgId, id)) as AskRow;
  return { ok: true, ask: viewOf(row, null, now) };
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

  let opened: { ok: true; request: RequestView } | AskFailure;
  if (input.mode === 'wallet_pays') {
    if (!input.wallet) return fail(409, 'no_wallet', 'register the business wallet first');
    const { requestOpenIntentPayment } = await import('./business-wallet.ts');
    const result = await requestOpenIntentPayment(deps.ctx, {
      orgId: input.orgId,
      requestedBy: input.userId,
      wallet: input.wallet,
      intentId: row.intentId,
      maxFeeMinor: input.maxFeeMinor,
      settleByMs: input.settleByMs,
      contentHash: new Uint8Array(Buffer.from(row.contentHash, 'hex')),
      walrusBlobId: new Uint8Array(Buffer.from(row.walrusBlobId, 'hex')),
    });
    opened = result.ok ? { ok: true, request: result.request } : fail(result.status, result.code, result.error);
  } else if (input.mode === 'second_approval') {
    if (!deps.secondApproval) return fail(503, 'no_spending_rules', 'spending rules are not set up for this business');
    const payer = current.intent.maker;
    if (!payer) return fail(409, 'no_maker', 'this payment names no maker to approve it for');
    opened = await deps.secondApproval({ orgId: input.orgId, ownerUserId: input.userId, intentId: row.intentId, payer, maxFeeMinor: input.maxFeeMinor, settleByMs: input.settleByMs });
  } else {
    return fail(400, 'bad_mode', 'the owners either pay it from the business wallet or give a second approval');
  }
  if (!opened.ok) return opened;

  await deps.db
    .update(walletApprovalAsks)
    .set({ status: 'signing', signingRequestId: opened.request.id, decidedBy: input.userId, decidedAt: now, updatedAt: now })
    .where(and(eq(walletApprovalAsks.orgId, input.orgId), eq(walletApprovalAsks.id, row.id), inArray(walletApprovalAsks.status, ['open', 'signing'])));
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
