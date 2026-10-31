/**
 * Batch payouts (v2 Phase 3, brief 5.6): up to BATCH_MAX_PAYMENTS payments from
 * the Splash Wallet in ONE transaction the owners sign once.
 *
 *   Upload     a sheet of recipient, amount and reference (lib/batch/sheet.ts).
 *   Review     every row is matched to a recipient THIS business already saved
 *              (or to a business on Splash by its registered name), screened,
 *              priced from the schedule on chain, and given its own error. A
 *              sheet is untrusted data: it can never introduce a payee, an
 *              account or a fee.
 *   Approve    the owners' multisig signs the whole batch once. A batch a staff
 *              member prepared waits for an owner to start the signatures.
 *              A batch scheduled to run later under a rule is not carried out
 *              on this server yet (BATCH_SCHEDULE_WIRED), and says so.
 *   Send       the signed transaction is submitted at the threshold: all the
 *              payments, or none.
 *   Receipts   one receipt per payment (lib/server/batch-receipts.ts).
 *
 * What must hold, and where:
 *   - Idempotent by the batch's intent id (the client's key, unique per
 *     business): the same key with the same batch answers the batch already
 *     made, the same key with another batch is a 409, two requests racing on
 *     one key make one batch. A retry is answered from the stored batch before
 *     anything is checked again (the batch is its normalised cells), so it still
 *     answers once a recipient, a fee or the balance has moved. Each row's
 *     payment reference is unique per business, which only stops one row being
 *     stored twice.
 *   - The same sheet under a NEW intent id is a new batch on purpose, so the
 *     review compares every row (address, amount, reference) with the rows of
 *     this business's batches of the last DUPLICATE_WINDOW_DAYS days that have
 *     not lapsed or failed, and the batch is made only when the person has said
 *     yes to the repeats (`confirmDuplicates`). Batches already out for
 *     signatures are counted against the wallet balance.
 *   - A Splash business a sheet names only by its registered name is a payee
 *     nobody on the team has saved: it is shown with its full address and
 *     country, and the batch is made only once the person has confirmed it
 *     (`confirmNewPayees`).
 *   - The fee shown is the batch's fee bound: a fee above it is refused with
 *     the new fee (`fee_changed`), a bound above the ceiling is refused, and
 *     every row's fee comes from `deps.splashFee` (the schedule on chain).
 *   - The review is done again, by the server, at creation and again when the
 *     signatures are started: nothing the page sent about a row is believed.
 *   - Every read and write takes the org from the caller. Another business's
 *     recipient, batch or receipt reads as absent.
 *   - The sealed audit bundle is made here and fails closed in production
 *     (lib/server/payment-record.ts); no stand-in is ever anchored.
 *   - Splash's own addresses, the business's own wallet, a bank account,
 *     USDC to another chain and an exchange account are never paid in a batch.
 */
import { createHash, randomUUID } from 'node:crypto';

import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';

import { organizations, suppliers, walletBatches, walletBatchRows, walletSigningRequests } from '../db/schema.ts';
import { BATCH_MAX_PAYMENTS, PROBLEM_TEXT, problemsOf, type SheetRow } from '../batch/sheet.ts';
import { FEE_CEILING_BPS, BPS_DENOM } from '../fees/schedule.ts';
import { MOVE_KIND } from '../recipients/wallet-recipients.ts';
import { parseAmountMinor, U64_MAX } from '../transfer/plan.ts';
import { validClientKey } from '../funding/wallet-funding.ts';
import { recipientPayable, requestWalletBatch, type WalletMembers } from './business-wallet.ts';
import { readRequestForSigner, type RequestView } from './wallet-signing.ts';
import { resolvePayee, isUniqueViolation, maskAddress, TRANSFER_INTENT_LIFETIME_MS, TRANSFER_SETTLE_WINDOW_MS, type PayeeInput, type TransferDeps } from './wallet-transfers.ts';

/** A batch to run later under a rule (splash_spend, the operator named as executor by an owner) is not built on this server yet. */
export const BATCH_SCHEDULE_WIRED = false;

export type BatchFailure = { ok: false; status: number; code: string; error: string; feeMinor?: string; rows?: RowReview[] };
const fail = (status: number, code: string, error: string, more: { feeMinor?: string; rows?: RowReview[] } = {}): BatchFailure => ({ ok: false, status, code, error, ...more });

export type BatchDeps = TransferDeps & {
  /** What the wallet can spend now (USDC minor units), or null when it cannot be read. Absent: the balance is not checked here. */
  walletBalance?: () => Promise<bigint | null>;
  /** Tells the owners a staff member's batch is waiting. A notice that does not go out does not undo the batch. */
  notifyBatch?: (n: { batchId: string; rowCount: number; totalMinor: bigint; requestedBy: string }) => Promise<void>;
};

export type RowReview = {
  line: number;
  recipient: string;
  amount: string;
  reference: string;
  ok: boolean;
  code: string | null;
  error: string | null;
  payee: { kind: 'splash_business' | 'self_custody'; name: string; masked: string; address: string; country: string | null; recipientId: string | null; businessId: string | null } | null;
  /** A Splash business found by the registered name in the sheet, not one this business saved: it must be confirmed. */
  newPayee: boolean;
  /** The earlier batch that already pays this same recipient, amount and reference, or null. */
  duplicateOf: { batchId: string; position: number } | null;
  amountMinor: string | null;
  feeMinor: string | null;
  feeKind: number | null;
};

export type BatchReview = {
  rows: RowReview[];
  okCount: number;
  errorCount: number;
  totalMinor: string;
  feeMinor: string;
  feesOn: boolean;
  /** Exactly the fee shown: send it back as `maxFeeMinor`. */
  maxFeeMinor: string;
  totalDebitMinor: string;
  maxPayments: number;
  /** Rows that repeat a payment of a batch already made or out for signatures. */
  duplicateCount: number;
  /** Rows paying a Splash business the sheet named by its registered name. */
  newPayeeCount: number;
  balance: { state: 'ok'; usdcMinor: string; shortByMinor: string; heldMinor: string } | { state: 'unknown' };
  /** Nothing is wrong with any row, and there is at least one. */
  ready: boolean;
};

export type BatchStatus = 'prepared' | 'awaiting_signatures' | 'on_the_way' | 'settled' | 'failed' | 'expired';

export type BatchView = {
  id: string;
  label: string | null;
  status: BatchStatus;
  rowCount: number;
  totalMinor: string;
  feeMinor: string;
  signingRequestId: string | null;
  requestedBy: string;
  createdAt: string;
  rows: Array<{ position: number; paymentRef: string; payeeKind: string; payeeName: string; payeeMasked: string | null; address: string; payeeCountry: string | null; amountMinor: string; feeMinor: string; feeKind: number; reference: string | null }>;
};

type BatchRow = typeof walletBatches.$inferSelect;
type RowRow = typeof walletBatchRows.$inferSelect;

const sha = (text: string) => createHash('sha256').update(text).digest();

/** How far back a repeated payment is looked for. */
export const DUPLICATE_WINDOW_DAYS = 30;
const ownerError = 'Only an owner starts the signatures for a batch.';

function digitsOf(value: unknown): bigint | null {
  const s = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,20}$/.test(s)) return null;
  const n = BigInt(s);
  return n <= U64_MAX ? n : null;
}

// ─── Review ─────────────────────────────────────────────────────────────────

type Saved = { id: string; name: string; legalName: string | null; walletAddress: string | null; deliveryKind: string };

async function savedRecipients(deps: BatchDeps): Promise<Saved[]> {
  const rows = await deps.db
    .select({ id: suppliers.id, name: suppliers.name, legalName: suppliers.legalName, walletAddress: suppliers.walletAddress, deliveryKind: suppliers.deliveryKind })
    .from(suppliers)
    .where(eq(suppliers.orgId, deps.orgId));
  return rows;
}

const same = (a: string | null | undefined, b: string) => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

/** What one cell of the sheet names: a recipient this business saved, or a business on Splash. Never anything else. */
async function payeeFromCell(deps: BatchDeps, saved: Saved[], cell: string): Promise<{ ok: true; payee: PayeeInput; byName: boolean } | { ok: false; code: string; error: string }> {
  const asAddress = /^0x/i.test(cell.trim());
  if (asAddress) {
    let address: string;
    try {
      address = normalizeSuiAddress(cell.trim());
    } catch {
      return { ok: false, code: 'bad_address', error: 'That is not a valid Sui address.' };
    }
    if (!isValidSuiAddress(address)) return { ok: false, code: 'bad_address', error: 'That is not a valid Sui address.' };
    const hit = saved.filter((s) => s.walletAddress && normalizeSuiAddress(s.walletAddress) === address);
    if (hit.length === 1) return { ok: true, payee: { kind: 'recipient', recipientId: hit[0].id }, byName: false };
    if (hit.length > 1) return { ok: false, code: 'ambiguous_recipient', error: 'More than one saved recipient has this address. Fix it in Recipients.' };
    return { ok: false, code: 'recipient_not_saved', error: 'This address is not one of your saved recipients. A batch pays only recipients you have saved and Splash has screened: add it in Recipients first.' };
  }
  const hits = saved.filter((s) => same(s.name, cell) || same(s.legalName, cell));
  if (hits.length === 1) return { ok: true, payee: { kind: 'recipient', recipientId: hits[0].id }, byName: false };
  if (hits.length > 1) return { ok: false, code: 'ambiguous_recipient', error: 'More than one saved recipient has this name. Use the wallet address instead.' };
  if (cell.trim().length >= 3) {
    const found = (await deps.searchBusinesses(cell.trim().slice(0, 80))).filter((b) => b.id !== deps.orgId && same(b.name, cell));
    if (found.length === 1) return { ok: true, payee: { kind: 'splash_business', businessId: found[0].id }, byName: true };
  }
  return { ok: false, code: 'recipient_not_found', error: 'No saved recipient or Splash business has this name. A batch pays only recipients you have saved: add it in Recipients first.' };
}

type Earlier = { rows: Map<string, { batchId: string; position: number }>; heldMinor: bigint };

/**
 * What this business's earlier batches (of the last DUPLICATE_WINDOW_DAYS days,
 * not failed or lapsed) already pay, and how much the ones still out for
 * signatures hold of the wallet. A repeated sheet under a new intent id would
 * otherwise be a second batch that pays everything again.
 */
async function earlierBatches(deps: BatchDeps): Promise<Earlier> {
  const since = new Date(deps.now().getTime() - DUPLICATE_WINDOW_DAYS * 86_400_000);
  const batches = await deps.db.select().from(walletBatches).where(and(eq(walletBatches.orgId, deps.orgId), gte(walletBatches.createdAt, since))).orderBy(asc(walletBatches.createdAt)).limit(200);
  const live: string[] = [];
  let held = 0n;
  for (const b of batches) {
    const linked = await withLink(deps, b);
    const status = await requestStatusOf(deps, linked);
    if (status === 'failed' || status === 'expired') continue;
    live.push(b.id);
    if (status === 'awaiting_signatures' || status === 'on_the_way') held += b.totalAmountMinor + b.totalMaxFeeMinor;
  }
  const rows = new Map<string, { batchId: string; position: number }>();
  if (live.length > 0) {
    const stored = await deps.db.select().from(walletBatchRows).where(and(eq(walletBatchRows.orgId, deps.orgId), inArray(walletBatchRows.batchId, live))).orderBy(asc(walletBatchRows.createdAt), asc(walletBatchRows.position));
    for (const r of stored) {
      const key = `${normalizeSuiAddress(r.address)}|${r.amountMinor}|${r.reference ?? ''}`;
      if (!rows.has(key)) rows.set(key, { batchId: r.batchId, position: r.position });
    }
  }
  return { rows, heldMinor: held };
}

const rowFail = (row: SheetRow, code: string, error: string): RowReview => ({ line: row.line, recipient: row.recipient, amount: row.amount, reference: row.reference, ok: false, code, error, payee: null, newPayee: false, duplicateOf: null, amountMinor: null, feeMinor: null, feeKind: null });

/**
 * Every row of a sheet, checked: its cells, its payee, its screening, its fee.
 * Reads only: nothing is stored, and nothing in a cell is read as an instruction.
 */
export async function reviewBatch(deps: BatchDeps, actor: { userId: string; role: string }, sheet: SheetRow[]): Promise<{ ok: true; review: BatchReview } | BatchFailure> {
  if (actor.role !== 'OWNER' && actor.role !== 'MAKER' && actor.role !== 'APPROVER') return fail(403, 'cannot_pay', 'Viewers can look at payments but cannot make them.');
  if (sheet.length === 0) return fail(400, 'empty_sheet', 'The sheet has no rows. Add at least one payment.');
  if (sheet.length > BATCH_MAX_PAYMENTS) return fail(400, 'too_many_rows', `A batch pays at most ${BATCH_MAX_PAYMENTS} recipients, and this sheet has ${sheet.length}. Split it into smaller batches.`);

  const members = await deps.walletMembers();
  const own = members.ok ? normalizeSuiAddress(members.address) : null;
  const splash = (await deps.splashAddresses()).map((a) => normalizeSuiAddress(a));
  const saved = await savedRecipients(deps);
  const earlier = await earlierBatches(deps);
  const seen = new Set<string>();
  const out: RowReview[] = [];
  let total = 0n;
  let fees = 0n;
  let feesOn = true;

  for (const row of sheet) {
    const problems = problemsOf(row);
    if (problems.length > 0) {
      out.push(rowFail(row, problems[0], PROBLEM_TEXT[problems[0]]));
      continue;
    }
    const amount = parseAmountMinor(row.amount) as bigint;
    const cell = await payeeFromCell(deps, saved, row.recipient);
    if (!cell.ok) {
      out.push(rowFail(row, cell.code, cell.error));
      continue;
    }
    const resolved = await resolvePayee(deps, cell.payee);
    if ('ok' in resolved) {
      out.push(rowFail(row, resolved.code, resolved.error));
      continue;
    }
    if (resolved.kind !== MOVE_KIND.SPLASH_BUSINESS && resolved.kind !== MOVE_KIND.WALLET) {
      out.push(rowFail(row, 'not_payable_in_a_batch', 'An exchange account is paid one at a time from Transfer, which sends the exchange its Travel Rule message first.'));
      continue;
    }
    const address = normalizeSuiAddress(resolved.address);
    if (own && address === own) {
      out.push(rowFail(row, 'own_wallet', "That is this business's own wallet. Pay another recipient."));
      continue;
    }
    if (splash.includes(address)) {
      out.push(rowFail(row, 'splash_controlled_address', 'That address belongs to Splash, so it cannot be paid as a recipient.'));
      continue;
    }
    const dupKey = `${address}|${amount}|${row.reference}`;
    if (seen.has(dupKey)) {
      out.push(rowFail(row, 'duplicate_row', 'This payment appears twice in the sheet: the same recipient, amount and reference. Remove one.'));
      continue;
    }
    // The screening and the recipient's own rule (v2 §4.6, §4.7): a fresh CLEAR, and a wallet proven.
    const screened = await recipientPayable(deps.ctx, deps.orgId, address, resolved.kind, actor.userId);
    if (screened) {
      out.push(rowFail(row, screened.code, screened.error));
      continue;
    }
    const fee = await deps.splashFee({ kind: resolved.kind, principalMinor: amount });
    feesOn = fee.feesOn;
    seen.add(dupKey);
    total += amount;
    fees += fee.feeMinor;
    out.push({
      line: row.line,
      recipient: row.recipient,
      amount: row.amount,
      reference: row.reference,
      ok: true,
      code: null,
      error: null,
      payee: { kind: resolved.payeeKind === 'splash_business' ? 'splash_business' : 'self_custody', name: resolved.name, masked: maskAddress(address), address, country: resolved.country, recipientId: resolved.recipientId, businessId: resolved.businessId },
      newPayee: cell.byName,
      duplicateOf: earlier.rows.get(dupKey) ?? null,
      amountMinor: amount.toString(),
      feeMinor: fee.feeMinor.toString(),
      feeKind: resolved.kind,
    });
  }

  const okCount = out.filter((r) => r.ok).length;
  const errorCount = out.length - okCount;
  let balance: BatchReview['balance'] = { state: 'unknown' };
  if (deps.walletBalance) {
    const have = await deps.walletBalance().catch(() => null);
    if (have !== null) {
      // What batches already out for signatures will take is not free to spend again.
      const need = total + fees + earlier.heldMinor;
      balance = { state: 'ok', usdcMinor: have.toString(), shortByMinor: (need > have ? need - have : 0n).toString(), heldMinor: earlier.heldMinor.toString() };
    }
  }
  return {
    ok: true,
    review: {
      rows: out,
      okCount,
      errorCount,
      totalMinor: total.toString(),
      feeMinor: fees.toString(),
      feesOn,
      maxFeeMinor: fees.toString(),
      totalDebitMinor: (total + fees).toString(),
      maxPayments: BATCH_MAX_PAYMENTS,
      duplicateCount: out.filter((r) => r.duplicateOf).length,
      newPayeeCount: out.filter((r) => r.newPayee).length,
      balance,
      ready: errorCount === 0 && okCount > 0,
    },
  };
}

// ─── The batch ──────────────────────────────────────────────────────────────

/**
 * The batch's own request, found by its dedupe key `batch:<id>` when the stored
 * link is missing or older than the newest request (a link that failed to save
 * after the request opened must not leave a batch reading "prepared" while
 * owners hold a live request). The link is written again, best effort.
 */
async function withLink(deps: Pick<BatchDeps, 'db'>, row: BatchRow): Promise<BatchRow> {
  const [newest] = await deps.db
    .select({ id: walletSigningRequests.id })
    .from(walletSigningRequests)
    .where(and(eq(walletSigningRequests.orgId, row.orgId), eq(walletSigningRequests.dedupeKey, `batch:${row.id}`)))
    .orderBy(desc(walletSigningRequests.createdAt))
    .limit(1);
  if (!newest || newest.id === row.signingRequestId) return row;
  await deps.db.update(walletBatches).set({ signingRequestId: newest.id, updatedAt: new Date() }).where(and(eq(walletBatches.id, row.id), eq(walletBatches.orgId, row.orgId))).catch(() => {});
  return { ...row, signingRequestId: newest.id };
}

async function requestStatusOf(deps: BatchDeps, row: BatchRow): Promise<BatchStatus> {
  if (!row.signingRequestId) return 'prepared';
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

async function rowsOf(deps: Pick<BatchDeps, 'db'>, orgId: string, batchId: string): Promise<RowRow[]> {
  return deps.db.select().from(walletBatchRows).where(and(eq(walletBatchRows.orgId, orgId), eq(walletBatchRows.batchId, batchId))).orderBy(asc(walletBatchRows.position));
}

async function viewOf(deps: BatchDeps, row: BatchRow): Promise<BatchView> {
  const rows = await rowsOf(deps, row.orgId, row.id);
  return {
    id: row.id,
    label: row.label,
    status: await requestStatusOf(deps, row),
    rowCount: row.rowCount,
    totalMinor: row.totalAmountMinor.toString(),
    feeMinor: row.totalMaxFeeMinor.toString(),
    signingRequestId: row.signingRequestId,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt.toISOString(),
    rows: rows.map((r) => ({
      position: r.position,
      paymentRef: r.paymentRef,
      payeeKind: r.payeeKind,
      payeeName: r.payeeName,
      payeeMasked: r.payeeMasked,
      address: r.address,
      payeeCountry: r.payeeCountry,
      amountMinor: r.amountMinor.toString(),
      feeMinor: r.maxFeeMinor.toString(),
      feeKind: r.feeKind,
      reference: r.reference,
    })),
  };
}

async function getRow(deps: Pick<BatchDeps, 'db' | 'orgId'>, id: string): Promise<BatchRow | null> {
  const [row] = await deps.db.select().from(walletBatches).where(and(eq(walletBatches.orgId, deps.orgId), eq(walletBatches.id, id))).limit(1);
  return row ? withLink(deps, row) : null;
}

async function getByKey(deps: Pick<BatchDeps, 'db' | 'orgId'>, clientKey: string): Promise<BatchRow | null> {
  const [row] = await deps.db.select().from(walletBatches).where(and(eq(walletBatches.orgId, deps.orgId), eq(walletBatches.clientKey, clientKey))).limit(1);
  return row ? withLink(deps, row) : null;
}

export async function getBatch(deps: BatchDeps, id: string): Promise<BatchView | null> {
  const row = await getRow(deps, id);
  return row ? viewOf(deps, row) : null;
}

export async function listBatches(deps: BatchDeps): Promise<BatchView[]> {
  const rows = await deps.db.select().from(walletBatches).where(eq(walletBatches.orgId, deps.orgId)).orderBy(desc(walletBatches.createdAt)).limit(50);
  const out: BatchView[] = [];
  for (const row of rows) out.push(await viewOf(deps, await withLink(deps, row)));
  return out;
}

/**
 * What the batch IS, read from what was SUBMITTED: who (the cell, trimmed and
 * lower-cased), how much (as an amount when it reads as one), the reference,
 * in order. Nothing that was looked up is part of it, so a retry can be
 * answered without reviewing again; the fee bound is not part of it either.
 */
const requestHashOf = (rows: SheetRow[]) =>
  sha(
    JSON.stringify([
      'batch-cells',
      rows.map((r) => [String(r.recipient ?? '').trim().toLowerCase(), parseAmountMinor(String(r.amount ?? ''))?.toString() ?? String(r.amount ?? '').trim(), String(r.reference ?? '').trim()]),
    ]),
  ).toString('hex');

export type CreateBatchResult = BatchFailure | { ok: true; created: boolean; batch: BatchView; signingRequest: RequestView | null };

export async function createBatch(
  deps: BatchDeps,
  actor: { userId: string; role: string },
  input: { clientKey: unknown; rows: SheetRow[]; maxFeeMinor: unknown; label?: unknown; confirmDuplicates?: unknown; confirmNewPayees?: unknown },
  attempt = 0,
): Promise<CreateBatchResult> {
  if (actor.role !== 'OWNER' && actor.role !== 'MAKER' && actor.role !== 'APPROVER') return fail(403, 'cannot_pay', 'Viewers can look at payments but cannot make them.');
  const clientKey = validClientKey(input.clientKey);
  if (!clientKey) return fail(400, 'idempotency_key_required', 'An intent id (8 to 80 letters, digits, - or _) is needed.');
  const rowsIn = Array.isArray(input.rows) ? input.rows : [];
  const requestHash = requestHashOf(rowsIn);
  // A retry is answered from the batch already made, before anything about the world is read again.
  const prior = await getByKey(deps, clientKey);
  if (prior) return replay(deps, actor, prior, requestHash);

  const maxFee = digitsOf(input.maxFeeMinor);
  if (maxFee === null) return fail(400, 'bad_fee', 'The fee that was shown is needed with the batch.');
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 80) : null;
  if (attempt >= 3) return fail(409, 'in_progress', 'This batch is still being prepared. Wait a moment and try again; nothing is sent twice.');

  const reviewed = await reviewBatch(deps, actor, rowsIn);
  if (!reviewed.ok) return reviewed;
  const { review } = reviewed;
  if (!review.ready) {
    return fail(422, 'rows_have_errors', 'Some rows cannot be paid. Fix or remove them: a batch is signed once, so every row in it must be cleared.', { rows: review.rows });
  }
  const total = BigInt(review.totalMinor);
  const fees = BigInt(review.feeMinor);
  if (maxFee * BPS_DENOM > total * FEE_CEILING_BPS) return fail(400, 'fee_above_ceiling', 'The fee bound is above what Splash may ever charge on this batch.');
  if (maxFee < fees) return fail(409, 'fee_changed', 'The fee changed since it was shown. Check the new fee and approve again.', { feeMinor: fees.toString() });
  if (review.balance.state === 'ok' && BigInt(review.balance.shortByMinor) > 0n) {
    return fail(409, 'insufficient_balance', 'The wallet does not hold enough for this batch and its fees. Add funds, or remove rows.', { feeMinor: fees.toString() });
  }

  if (review.duplicateCount > 0 && input.confirmDuplicates !== true) {
    return fail(409, 'duplicate_of_earlier_batch', 'Some of these payments are already in a batch you made. Paying them again sends the money twice: check the rows, and confirm if you mean to.', { rows: review.rows });
  }
  if (review.newPayeeCount > 0 && input.confirmNewPayees !== true) {
    return fail(409, 'new_payee_needs_confirmation', 'A business on Splash is named in this sheet that nobody on your team has saved. Check its name, address and country, and confirm it is the one you mean to pay.', { rows: review.rows });
  }

  const id = `wbt_${randomUUID()}`;
  const now = deps.now();
  try {
    await deps.db.transaction(async (tx) => {
      await tx.insert(walletBatches).values({
        id,
        orgId: deps.orgId,
        clientKey,
        requestHash,
        label,
        rowCount: review.rows.length,
        totalAmountMinor: total,
        totalMaxFeeMinor: fees,
        requestedBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(walletBatchRows).values(
        review.rows.map((r, i) => ({
          id: `wbr_${randomUUID()}`,
          batchId: id,
          orgId: deps.orgId,
          position: i + 1,
          paymentRef: sha(`splash-batch-row|${deps.orgId}|${clientKey}|${i + 1}`).toString('hex'),
          payeeKind: (r.payee as NonNullable<RowReview['payee']>).kind,
          recipientId: r.payee?.recipientId ?? null,
          businessId: r.payee?.businessId ?? null,
          payeeName: (r.payee as NonNullable<RowReview['payee']>).name,
          payeeMasked: r.payee?.masked ?? null,
          payeeCountry: r.payee?.country ?? null,
          address: (r.payee as NonNullable<RowReview['payee']>).address,
          amountMinor: BigInt(r.amountMinor as string),
          maxFeeMinor: BigInt(r.feeMinor as string),
          feeKind: r.feeKind as number,
          reference: r.reference || null,
          createdAt: now,
        })),
      );
    });
  } catch (error) {
    // Only a clash on the key means another request holds it; anything else (a database fault) is not ours to swallow.
    if (!isUniqueViolation(error)) throw error;
    const other = await getByKey(deps, clientKey);
    if (other) return replay(deps, actor, other, requestHash);
    return createBatch(deps, actor, input, attempt + 1);
  }

  const row = (await getByKey(deps, clientKey)) as BatchRow;
  if (actor.role !== 'OWNER') {
    // A staff member prepares; an owner starts the signatures. Owners are told.
    if (deps.notifyBatch) await deps.notifyBatch({ batchId: id, rowCount: review.rows.length, totalMinor: total, requestedBy: actor.userId }).catch(() => {});
    return { ok: true, created: true, batch: await viewOf(deps, row), signingRequest: null };
  }
  const started = await startBatchSigning(deps, actor, id);
  if (!started.ok) {
    // Nothing was asked of the owners: the batch is not left half made under a key a retry would find.
    await deps.db.delete(walletBatches).where(and(eq(walletBatches.id, id), eq(walletBatches.orgId, deps.orgId)));
    return started;
  }
  return { ok: true, created: true, batch: started.batch, signingRequest: started.signingRequest };
}

async function replay(deps: BatchDeps, actor: { userId: string }, row: BatchRow, requestHash: string): Promise<CreateBatchResult> {
  if (row.requestHash !== requestHash) return fail(409, 'idempotency_key_reused', 'That intent id was used for a different batch.');
  let signingRequest: RequestView | null = null;
  if (row.signingRequestId) {
    const read = await readRequestForSigner(deps.ctx.signing, { orgId: deps.orgId, userId: actor.userId, id: row.signingRequestId });
    if (read.ok) signingRequest = read.request;
  }
  return { ok: true, created: false, batch: await viewOf(deps, row), signingRequest };
}

/**
 * An owner starts the signatures for a batch (made by the owner, or prepared by
 * a staff member). Every row is checked again, against what is saved NOW: a
 * recipient who changed, was removed, or is no longer cleared stops the batch.
 * Idempotent: a batch already collecting or sent answers its request, and one
 * whose request lapsed opens a new one.
 */
export async function startBatchSigning(
  deps: BatchDeps,
  actor: { userId: string; role: string },
  batchId: string,
  opts: { schedule?: boolean } = {},
): Promise<{ ok: true; batch: BatchView; signingRequest: RequestView | null } | BatchFailure> {
  if (actor.role !== 'OWNER') return fail(403, 'owner_only', ownerError);
  if (opts.schedule && !BATCH_SCHEDULE_WIRED) {
    return fail(409, 'schedule_not_wired', 'Scheduled batches are not switched on for your business yet, so nothing was scheduled. Your owners can sign this batch now.');
  }
  const row = await getRow(deps, batchId);
  if (!row) return fail(404, 'batch_not_found', 'No such batch.');
  const rows = await rowsOf(deps, deps.orgId, batchId);
  const status = await requestStatusOf(deps, row);
  if (status === 'awaiting_signatures' || status === 'on_the_way' || status === 'settled') {
    const read = row.signingRequestId ? await readRequestForSigner(deps.ctx.signing, { orgId: deps.orgId, userId: actor.userId, id: row.signingRequestId }) : null;
    return { ok: true, batch: await viewOf(deps, row), signingRequest: read && read.ok ? read.request : null };
  }

  const members = await deps.walletMembers();
  if (!members.ok) return fail(members.status, members.code, members.error);
  const splash = (await deps.splashAddresses()).map((a) => normalizeSuiAddress(a));

  // Each row again, against what is saved now.
  let totalFee = 0n;
  for (const r of rows) {
    const payee: PayeeInput = r.businessId ? { kind: 'splash_business', businessId: r.businessId } : { kind: 'recipient', recipientId: r.recipientId ?? '' };
    const resolved = await resolvePayee(deps, payee);
    if ('ok' in resolved) return fail(resolved.status, resolved.code, `Payment ${r.position}: ${resolved.error}`);
    const address = normalizeSuiAddress(resolved.address);
    if (address !== normalizeSuiAddress(r.address) || resolved.kind !== r.feeKind) {
      return fail(409, 'recipient_changed', `Payment ${r.position}: the recipient changed since the batch was prepared. Prepare the batch again.`);
    }
    if (address === normalizeSuiAddress(members.address)) return fail(400, 'own_wallet', `Payment ${r.position}: that is this business's own wallet.`);
    if (splash.includes(address)) return fail(409, 'splash_controlled_address', `Payment ${r.position}: that address belongs to Splash.`);
    const fee = await deps.splashFee({ kind: resolved.kind, principalMinor: r.amountMinor });
    if (fee.feeMinor > r.maxFeeMinor) return fail(409, 'fee_changed', 'The fee changed since the batch was prepared. Check the new fee and prepare the batch again.', { feeMinor: fee.feeMinor.toString() });
    totalFee += r.maxFeeMinor;
  }

  const [org] = await deps.db.select({ name: organizations.name, legalName: organizations.legalName }).from(organizations).where(eq(organizations.id, deps.orgId)).limit(1);
  const payer = org?.legalName || org?.name || deps.orgId;
  const total = rows.reduce((sum, r) => sum + r.amountMinor, 0n);
  // One sealed bundle for the batch; each payment anchors it. It fails closed in production.
  const record = await deps.paymentRecord({ orgId: deps.orgId, transferId: batchId, payer, payee: `${rows.length} recipients`, amountMinor: total.toString(), maxFeeMinor: totalFee.toString(), reference: row.label });
  if (!record.ok) return fail(record.status, record.code, record.error);

  const now = deps.now();
  const expiresAtMs = BigInt(now.getTime()) + BigInt(TRANSFER_INTENT_LIFETIME_MS);
  const settleByMs = BigInt(now.getTime() + TRANSFER_SETTLE_WINDOW_MS);
  const opened = await requestWalletBatch(deps.ctx, {
    orgId: deps.orgId,
    requestedBy: actor.userId,
    wallet: members.members as WalletMembers,
    batchId,
    payments: rows.map((r) => ({
      paymentRef: new Uint8Array(Buffer.from(r.paymentRef, 'hex')),
      recipient: r.address,
      beneficiaryRef: new Uint8Array(),
      amountMinor: r.amountMinor,
      targetCurrency: 'USDC',
      fxRateUsdLocal: 1_000_000n,
      commitment: new Uint8Array(sha(JSON.stringify(['splash-batch-commitment', deps.orgId, batchId, r.position, r.address, r.amountMinor.toString(), r.maxFeeMinor.toString(), r.feeKind]))),
      kind: r.feeKind,
      railCommitment: new Uint8Array(sha(`splash-transfer-rail|${r.feeKind}`)),
      expiresAtMs,
      maxFeeMinor: r.maxFeeMinor,
      settleByMs,
      contentHash: record.contentHash,
      walrusBlobId: record.walrusBlobId,
    })),
  });
  if (!opened.ok) {
    if (opened.code === 'request_open') {
      // Another owner started it a moment ago: its request is the answer.
      const again = await getRow(deps, batchId);
      if (again?.signingRequestId) {
        const read = await readRequestForSigner(deps.ctx.signing, { orgId: deps.orgId, userId: actor.userId, id: again.signingRequestId });
        return { ok: true, batch: await viewOf(deps, again), signingRequest: read.ok ? read.request : null };
      }
      return fail(409, 'in_progress', 'The signatures for this batch are being started. Wait a moment and try again; nothing is sent twice.');
    }
    return fail(opened.status, opened.code, opened.error);
  }
  // The request carries the batch's dedupe key, so a link that fails to save here is found again (withLink), never orphaned.
  await deps.db.update(walletBatches).set({ signingRequestId: opened.request.id, updatedAt: deps.now() }).where(and(eq(walletBatches.id, batchId), eq(walletBatches.orgId, deps.orgId))).catch(() => {});
  const after = (await getRow(deps, batchId)) as BatchRow;
  return { ok: true, batch: await viewOf(deps, after), signingRequest: opened.request };
}
