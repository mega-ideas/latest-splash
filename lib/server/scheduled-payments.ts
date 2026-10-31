/**
 * Scheduled batches (v2 Phase 3): what an owner (or the Finance lead, where
 * the role allows) does with a schedule, and what the Scheduled tab reads.
 *
 * A schedule is a batch of payments to verified recipients that falls due
 * once, every week or every month, in one of two modes an owner chooses:
 *
 *   ask    "Ask me first". The default. At the due time Splash prepares the
 *          batch and asks for approval (the existing Batch payouts signing
 *          request, to the owners' phones); nothing is paid until a passkey
 *          signs it.
 *   auto   "Pay automatically within my limits". At the due time Splash pays
 *          with no one present, only inside an allowance the owners signed to
 *          the scheduled payer (lib/server/scheduled-payer-signer.ts), only to
 *          recipients that were paid before, and only after every check in
 *          lib/schedule/auto-check.ts passes. Otherwise the run is handed
 *          back to "ask", and the owners are told why.
 *
 * This file is the management side: create, edit, skip, stop, resume, delete,
 * the kill switch, and asking the owners to give or take back the allowance.
 * The runner (lib/server/scheduled-runner.ts) does the paying.
 *
 * What must hold, and where:
 *   - Every read and write takes the org from the caller. Another business's
 *     schedule, run, recipient or allowance reads as absent (404).
 *   - Owners change anything, at once, with no cooldown. The Finance lead sets
 *     and changes "ask me first" schedules only: an automatic schedule, the
 *     kill switch and the allowance are an owner's alone.
 *   - A schedule pays a Splash business or a wallet this business saved and
 *     Splash screened. Never an exchange account (its Travel Rule message is
 *     per payment), a bank account or another chain. A sheet-style name can
 *     never introduce a payee: a payee is an id the business already has.
 *   - Idempotent by the client's key (8 to 80 letters, digits, - or _): the
 *     same key with the same schedule answers the schedule already made.
 *   - Nothing here moves money, signs, or calls a partner.
 */
import { createHash, randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { memberships, organizations, users } from '../db/schema.ts';
import { validClientKey } from '../funding/wallet-funding.ts';
import { MOVE_KIND } from '../recipients/wallet-recipients.ts';
import {
  ALLOWANCE_DEFAULTS,
  ASK_MIN_LEAD_MS,
  AUTO_MIN_LEAD_MS,
  CADENCES,
  MAX_START_AHEAD_MS,
  RUN_STATE,
  SCHEDULE_MAX_ITEMS,
  SCHEDULE_MODES,
  allowanceProblems,
  cadenceSummary,
  dueDateOf,
  nextDueAfter,
  type Cadence,
  type RunStatus,
  type ScheduleMode,
  type ScheduleStatus,
} from '../schedule/rules.ts';
import { scheduledRunPath, SCHEDULED_PATH, type ScheduleNotice } from '../schedule/notice.ts';
import type { AutomaticStatus, ItemView, RunView, ScheduleView } from '../schedule/views.ts';
import { parseAmountMinor } from '../transfer/plan.ts';
import { recipientPayable, type WalletContext } from './business-wallet.ts';
import { listOrgOwners } from './near-threshold-store.ts';
import {
  advanceSchedule,
  getRun,
  getRunForDate,
  getSchedule,
  getScheduleByKey,
  getSettings,
  insertRunOnce,
  insertSchedule,
  itemsOf,
  listRunPayments,
  listRuns,
  listSchedules,
  moveRun,
  saveSettings,
  autoPaidSince,
  updateSchedule,
  type RunRow,
  type ScheduleItem,
  type ScheduleRow,
} from './scheduled-store.ts';
import type { PayerResult } from './scheduled-payer-signer.ts';
import { changeSpendingRule, issueSpendingRule, readStaffRule, revokeSpendingRule, type SpendContext } from './spend-rules.ts';
import { cancelSigningRequest, type RequestView } from './wallet-signing.ts';
import { recordAuthorityEvent } from './wallet-authority.ts';
import { getBatch, type BatchDeps } from './wallet-batches.ts';
import { isUniqueViolation, maskAddress, resolvePayee, type PayeeInput } from './wallet-transfers.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

export type { AutomaticStatus, ItemView, RunView, ScheduleView };
export type Actor = { userId: string; role: string; financeLead?: boolean };
export type Fail = { ok: false; status: number; code: string; error: string; details?: Record<string, unknown> };
export const fail = (status: number, code: string, error: string, details?: Record<string, unknown>): Fail => ({ ok: false, status, code, error, ...(details ? { details } : {}) });

export type ScheduleDeps = BatchDeps & {
  /** The scheduled payer's signer, or why there is none (lib/server/scheduled-payer-signer.ts). */
  payer: () => Promise<PayerResult>;
  /** Tell the owners something about a schedule. A notice that does not go out never undoes what happened. */
  notify: (notice: ScheduleNotice) => Promise<void>;
};

// ─── Who may do what ────────────────────────────────────────────────────────

const isOwner = (a: Actor) => a.role === 'OWNER';
/** An owner changes any schedule; the Finance lead sets and changes "ask me first" schedules. Nobody else changes one. */
function mayManage(a: Actor, mode: ScheduleMode): boolean {
  return isOwner(a) || (a.financeLead === true && a.role === 'APPROVER' && mode === 'ask');
}
const ownersOnly = (what: string) => fail(403, 'owner_only', `Only an owner can ${what}.`);
const cannotManage = (mode: ScheduleMode) =>
  mode === 'auto' ? ownersOnly('set up or change a schedule that pays automatically') : fail(403, 'cannot_schedule', 'Only an owner or the Finance lead can set up a scheduled payment.');

// ─── Views ──────────────────────────────────────────────────────────────────

function itemView(i: ScheduleItem): ItemView {
  return {
    position: i.position,
    payeeKind: i.payee.kind,
    payeeId: i.payee.kind === 'splash_business' ? i.payee.businessId : i.payee.recipientId,
    name: i.name,
    masked: maskAddress(i.address),
    country: i.country,
    amountMinor: i.amountMinor,
    reference: i.reference,
    feeMinor: i.feeMinor,
  };
}

/** `plan` is what an unstarted run will be: a run that has not started has no totals of its own yet, so it shows its schedule's. */
export function runView(run: RunRow, scheduleName: string, payments: Awaited<ReturnType<typeof listRunPayments>> | null = null, plan: { itemCount: number; totalMinor: bigint; feeMinor: bigint } | null = null): RunView {
  const state = RUN_STATE[run.status as RunStatus];
  const started = (payments ?? []).some((p) => p.status === 'submitting' || p.status === 'paid');
  return {
    id: run.id,
    scheduleId: run.scheduleId,
    scheduleName,
    dueDate: run.dueDate,
    dueAt: run.dueAt.toISOString(),
    mode: run.mode as ScheduleMode,
    ranAs: (run.ranAs as ScheduleMode | null) ?? null,
    status: run.status as RunStatus,
    label: state.label,
    tone: state.tone,
    group: state.group,
    reason: run.reason ?? null,
    reasonCode: run.reasonCode ?? null,
    fallback: run.fallback,
    itemCount: run.itemCount || plan?.itemCount || 0,
    totalMinor: (run.totalMinor > 0n ? run.totalMinor : (plan?.totalMinor ?? 0n)).toString(),
    feeMinor: (run.totalMinor > 0n ? run.feeMinor : (plan?.feeMinor ?? 0n)).toString(),
    batchId: run.batchId ?? null,
    canSkip: (run.status === 'scheduled' || run.status === 'waiting_approval' || run.status === 'approved') && !started,
    receiptPath: run.status === 'paid' ? (run.ranAs === 'auto' || !run.batchId ? `/dashboard/history/scheduled/${encodeURIComponent(run.id)}` : `/dashboard/history/batch/${encodeURIComponent(run.batchId)}`) : null,
    payments: payments
      ? payments.map((p) => ({ position: p.position, payeeName: p.payeeName, masked: maskAddress(p.address), amountMinor: p.amountMinor.toString(), feeMinor: p.maxFeeMinor.toString(), status: p.status, digest: p.digest && !p.digest.startsWith('sandbox:') ? p.digest : null, error: p.error }))
      : null,
    createdAt: run.createdAt.toISOString(),
  };
}

async function scheduleView(deps: ScheduleDeps, actor: Actor, row: ScheduleRow, withRuns = true): Promise<ScheduleView> {
  const runs = withRuns ? await listRuns(deps.db, deps.orgId, 400) : [];
  const mine = runs.filter((r) => r.scheduleId === row.id).slice(0, 8);
  const views: RunView[] = [];
  for (const r of mine) views.push(runView(r, row.name, r.ranAs === 'auto' ? await listRunPayments(deps.db, deps.orgId, r.id) : null, { itemCount: row.itemCount, totalMinor: row.totalMinor, feeMinor: row.feeMinor }));
  const manage = mayManage(actor, row.mode as ScheduleMode);
  return {
    id: row.id,
    name: row.name,
    mode: row.mode as ScheduleMode,
    cadence: row.cadence as Cadence,
    cadenceText: cadenceSummary(row.cadence as Cadence, row.firstDueAt.getTime()),
    firstDueAt: row.firstDueAt.toISOString(),
    nextDueAt: row.nextDueAt ? row.nextDueAt.toISOString() : null,
    status: row.status as ScheduleStatus,
    createdBy: row.createdBy,
    createdAs: row.createdAs as 'owner' | 'finance_lead',
    itemCount: row.itemCount,
    totalMinor: row.totalMinor.toString(),
    feeMinor: row.feeMinor.toString(),
    items: itemsOf(row).map(itemView),
    version: row.version,
    can: { edit: manage, skip: manage, stop: manage, delete: manage },
    runs: views,
  };
}

/** This business's schedules with their latest runs. Another business's are never in it. */
export async function listScheduleViews(deps: ScheduleDeps, actor: Actor): Promise<ScheduleView[]> {
  const rows = await listSchedules(deps.db, deps.orgId);
  const out: ScheduleView[] = [];
  for (const row of rows) out.push(await scheduleView(deps, actor, row));
  return out;
}

export async function getScheduleView(deps: ScheduleDeps, actor: Actor, id: string): Promise<ScheduleView | null> {
  const row = await getSchedule(deps.db, deps.orgId, id);
  return row && row.status !== 'deleted' ? scheduleView(deps, actor, row) : null;
}

/** Every run of this business, newest first: what History lists. */
export async function listRunViews(deps: Pick<ScheduleDeps, 'db' | 'orgId'>, limit = 100): Promise<RunView[]> {
  const rows = await listRuns(deps.db, deps.orgId, limit);
  const known = new Map((await listSchedules(deps.db, deps.orgId)).map((s) => [s.id, s]));
  const out: RunView[] = [];
  for (const r of rows) {
    // A deleted schedule's runs stay in History under the name it had.
    const sch = known.get(r.scheduleId) ?? (await getSchedule(deps.db, deps.orgId, r.scheduleId));
    out.push(runView(r, sch?.name ?? 'Scheduled payment', r.ranAs === 'auto' ? await listRunPayments(deps.db, deps.orgId, r.id) : null, sch ? { itemCount: sch.itemCount, totalMinor: sch.totalMinor, feeMinor: sch.feeMinor } : null));
  }
  return out;
}

export async function getRunView(deps: Pick<ScheduleDeps, 'db' | 'orgId'>, id: string): Promise<RunView | null> {
  const run = await getRun(deps.db, deps.orgId, id);
  if (!run) return null;
  const sch = await getSchedule(deps.db, deps.orgId, run.scheduleId);
  return runView(run, sch?.name ?? 'Scheduled payment', run.ranAs === 'auto' ? await listRunPayments(deps.db, deps.orgId, run.id) : null, sch ? { itemCount: sch.itemCount, totalMinor: sch.totalMinor, feeMinor: sch.feeMinor } : null);
}

// ─── Making the items ───────────────────────────────────────────────────────

export type ItemInput = { recipientId?: unknown; businessId?: unknown; amount?: unknown; reference?: unknown };

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function nameOfUser(db: DrizzleDb, userId: string): Promise<string | null> {
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.name ?? null;
}

async function businessName(deps: Pick<ScheduleDeps, 'db' | 'orgId'>): Promise<string> {
  const [org] = await deps.db.select({ name: organizations.name, legalName: organizations.legalName }).from(organizations).where(eq(organizations.id, deps.orgId)).limit(1);
  return org?.legalName || org?.name || 'Your business';
}

/**
 * A schedule's recipients and amounts, checked the way a batch's rows are: a
 * payee the business already has (a saved recipient, or a Splash business
 * found by id), a Splash business or a wallet only, screened, priced from the
 * schedule on chain, never the business's own wallet or Splash's. The address
 * and the fee shown are kept, so a run can tell when either changed.
 */
async function makeItems(
  deps: ScheduleDeps,
  actor: Actor,
  raw: unknown,
  opts: { confirmNewPayees: boolean },
): Promise<{ ok: true; items: ScheduleItem[]; totalMinor: bigint; feeMinor: bigint; needsConfirmation: boolean } | Fail> {
  const list = Array.isArray(raw) ? (raw as ItemInput[]) : [];
  if (list.length === 0) return fail(400, 'no_items', 'Add at least one payment to the schedule.');
  if (list.length > SCHEDULE_MAX_ITEMS) return fail(400, 'too_many_items', `A scheduled batch pays at most ${SCHEDULE_MAX_ITEMS} recipients. Split it into smaller schedules.`);
  const members = await deps.walletMembers();
  const own = members.ok ? normalizeSuiAddress(members.address) : null;
  const splash = (await deps.splashAddresses()).map((a) => normalizeSuiAddress(a));
  const seen = new Set<string>();
  const items: ScheduleItem[] = [];
  let total = 0n;
  let fees = 0n;
  let needsConfirmation = false;
  for (let i = 0; i < list.length; i += 1) {
    const at = `Payment ${i + 1}: `;
    const input = list[i] ?? {};
    const businessId = typeof input.businessId === 'string' ? input.businessId.trim() : '';
    const recipientId = typeof input.recipientId === 'string' ? input.recipientId.trim() : '';
    if ((businessId ? 1 : 0) + (recipientId ? 1 : 0) !== 1) return fail(400, 'bad_payee', `${at}choose one recipient you have saved, or one business on Splash.`);
    const amount = parseAmountMinor(String(input.amount ?? ''));
    if (amount === null) return fail(400, 'bad_amount', `${at}say how much USDC to pay: an amount above zero, with at most six decimals.`);
    const reference = typeof input.reference === 'string' ? input.reference.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 60) : '';
    const payee: PayeeInput = businessId ? { kind: 'splash_business', businessId } : { kind: 'recipient', recipientId };
    const resolved = await resolvePayee(deps, payee);
    if ('ok' in resolved) return fail(resolved.status, resolved.code, `${at}${resolved.error}`);
    if (resolved.kind !== MOVE_KIND.SPLASH_BUSINESS && resolved.kind !== MOVE_KIND.WALLET) {
      return fail(409, 'not_payable_in_a_schedule', `${at}an exchange account is paid one at a time from Transfer, which sends the exchange its Travel Rule message first.`);
    }
    const address = normalizeSuiAddress(resolved.address);
    if (own && address === own) return fail(400, 'own_wallet', `${at}that is this business's own wallet.`);
    if (splash.includes(address)) return fail(409, 'splash_controlled_address', `${at}that address belongs to Splash.`);
    const dup = `${address}|${amount}|${reference}`;
    if (seen.has(dup)) return fail(409, 'duplicate_row', `${at}the same recipient, amount and reference appears twice. Remove one.`);
    const screened = await recipientPayable(deps.ctx as WalletContext, deps.orgId, address, resolved.kind, actor.userId);
    if (screened) return fail(screened.status, screened.code, `${at}${screened.error}`);
    const fee = await deps.splashFee({ kind: resolved.kind, principalMinor: amount });
    if (resolved.payeeKind === 'splash_business' && !opts.confirmNewPayees) needsConfirmation = true;
    seen.add(dup);
    total += amount;
    fees += fee.feeMinor;
    items.push({
      position: i + 1,
      payee: businessId ? { kind: 'splash_business', businessId } : { kind: 'recipient', recipientId },
      name: resolved.name,
      address,
      country: resolved.country,
      amountMinor: amount.toString(),
      reference,
      feeKind: resolved.kind,
      feeMinor: fee.feeMinor.toString(),
    });
  }
  return { ok: true, items, totalMinor: total, feeMinor: fees, needsConfirmation };
}

// ─── Create ─────────────────────────────────────────────────────────────────

export type ScheduleInput = {
  clientKey: unknown;
  name: unknown;
  mode: unknown;
  cadence: unknown;
  /** ISO time, or milliseconds. */
  firstDueAt: unknown;
  items: unknown;
  /** The person has seen the full address and country of each Splash business named by id, and means to pay it. */
  confirmNewPayees?: unknown;
};

const msOf = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Date.parse(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

const cleanName = (v: unknown): string => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 80);

const sameSchedule = (row: ScheduleRow, c: { name: string; mode: string; cadence: string; firstDueMs: number; items: ScheduleItem[] }) =>
  row.name === c.name &&
  row.mode === c.mode &&
  row.cadence === c.cadence &&
  row.firstDueAt.getTime() === c.firstDueMs &&
  JSON.stringify(itemsOf(row).map((i) => [i.payee, i.amountMinor, i.reference])) === JSON.stringify(c.items.map((i) => [i.payee, i.amountMinor, i.reference]));

/** Why a schedule's mode, cadence and first due time are or are not acceptable. */
function checkWhen(deps: Pick<ScheduleDeps, 'now'>, mode: ScheduleMode, firstDueMs: number): Fail | null {
  const now = deps.now().getTime();
  const lead = mode === 'auto' ? AUTO_MIN_LEAD_MS : ASK_MIN_LEAD_MS;
  if (firstDueMs < now + lead) {
    return fail(400, 'due_too_soon', mode === 'auto' ? 'An automatic schedule must fall due at least an hour from now, so your owners can read the notice first.' : 'Choose a time at least a few minutes from now.');
  }
  if (firstDueMs > now + MAX_START_AHEAD_MS) return fail(400, 'due_too_far', 'A schedule can start at most a year from now.');
  return null;
}

export async function createSchedule(
  deps: ScheduleDeps,
  actor: Actor,
  input: ScheduleInput,
): Promise<{ ok: true; created: boolean; schedule: ScheduleView; allowance: 'unknown' } | Fail> {
  const mode = SCHEDULE_MODES.includes(input.mode as ScheduleMode) ? (input.mode as ScheduleMode) : null;
  if (!mode) return fail(400, 'bad_mode', 'Choose “Ask me first” or “Pay automatically within my limits”.');
  if (!mayManage(actor, mode)) return cannotManage(mode);
  const clientKey = validClientKey(input.clientKey);
  if (!clientKey) return fail(400, 'idempotency_key_required', 'An id for this schedule (8 to 80 letters, digits, - or _) is needed.');
  const cadence = CADENCES.includes(input.cadence as Cadence) ? (input.cadence as Cadence) : null;
  if (!cadence) return fail(400, 'bad_cadence', 'Choose once, every week or every month.');
  const name = cleanName(input.name);
  if (!name) return fail(400, 'bad_name', 'Give the schedule a name.');
  const firstDueMs = msOf(input.firstDueAt);
  if (firstDueMs === null) return fail(400, 'bad_due', 'Choose when the first payment falls due.');

  const made = await makeItems(deps, actor, input.items, { confirmNewPayees: input.confirmNewPayees === true });
  if (!made.ok) return made;

  // A retry is answered from the schedule already made.
  const prior = await getScheduleByKey(deps.db, deps.orgId, clientKey);
  if (prior) {
    if (prior.createdBy !== actor.userId || !sameSchedule(prior, { name, mode, cadence, firstDueMs, items: made.items })) {
      return fail(409, 'idempotency_key_reused', 'That id was used for a different schedule.');
    }
    return { ok: true, created: false, schedule: await scheduleView(deps, actor, prior), allowance: 'unknown' };
  }

  const when = checkWhen(deps, mode, firstDueMs);
  if (when) return when;
  if (made.needsConfirmation) {
    return fail(409, 'new_payee_needs_confirmation', 'A business on Splash is in this schedule that nobody on your team has saved. Check its name, address and country, and confirm it is the one you mean to pay.', {
      payees: made.items.filter((i) => i.payee.kind === 'splash_business').map((i) => ({ name: i.name, address: i.address, country: i.country })),
    });
  }
  if (mode === 'auto') {
    // An automatic schedule needs the scheduled payer to exist here at all. (Whether the owners have signed the allowance is checked at every run.)
    const payer = await deps.payer();
    if (!payer.ok) return fail(409, 'auto_not_available', 'Automatic payments are not switched on for your business here yet, so this schedule would only ever ask for approval. Choose “Ask me first”.');
  }

  const id = `psc_${randomUUID()}`;
  const now = deps.now();
  try {
    await insertSchedule(deps.db, {
      id,
      orgId: deps.orgId,
      clientKey,
      name,
      mode,
      cadence,
      firstDueAt: new Date(firstDueMs),
      nextDueAt: new Date(firstDueMs),
      status: 'active',
      createdBy: actor.userId,
      createdAs: isOwner(actor) ? 'owner' : 'finance_lead',
      items: made.items,
      itemCount: made.items.length,
      totalMinor: made.totalMinor,
      feeMinor: made.feeMinor,
      confirmedNewPayees: made.items.some((i) => i.payee.kind === 'splash_business'),
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const other = await getScheduleByKey(deps.db, deps.orgId, clientKey);
    if (other && other.createdBy === actor.userId && sameSchedule(other, { name, mode, cadence, firstDueMs, items: made.items })) {
      return { ok: true, created: false, schedule: await scheduleView(deps, actor, other), allowance: 'unknown' };
    }
    return fail(409, 'idempotency_key_reused', 'That id was used for a different schedule.');
  }
  await recordAuthorityEvent(deps.db, { orgId: deps.orgId, actorUserId: actor.userId, action: 'schedule_created', ref: id, detail: { mode, cadence, items: made.items.length, totalMinor: made.totalMinor.toString() }, now: deps.now });
  return { ok: true, created: true, schedule: await scheduleView(deps, actor, (await getSchedule(deps.db, deps.orgId, id)) as ScheduleRow), allowance: 'unknown' };
}

// ─── Edit ───────────────────────────────────────────────────────────────────

export type SchedulePatch = Partial<Omit<ScheduleInput, 'clientKey'>>;

/**
 * Change a schedule, at once. Switching it to "ask me first" takes effect for
 * the very next run. Changing the time or the recipients of a run already
 * waiting for its due time takes that run back: the next one is made fresh.
 */
export async function editSchedule(deps: ScheduleDeps, actor: Actor, id: string, patch: SchedulePatch): Promise<{ ok: true; schedule: ScheduleView } | Fail> {
  const row = await getSchedule(deps.db, deps.orgId, id);
  if (!row || row.status === 'deleted') return fail(404, 'schedule_not_found', 'No such schedule.');
  const wasMode = row.mode as ScheduleMode;
  const mode = patch.mode === undefined ? wasMode : SCHEDULE_MODES.includes(patch.mode as ScheduleMode) ? (patch.mode as ScheduleMode) : null;
  if (!mode) return fail(400, 'bad_mode', 'Choose “Ask me first” or “Pay automatically within my limits”.');
  // The Finance lead may change an "ask me first" schedule and may not make one automatic.
  if (!mayManage(actor, wasMode) || !mayManage(actor, mode)) return cannotManage(wasMode === 'auto' || mode === 'auto' ? 'auto' : 'ask');

  const cadence = patch.cadence === undefined ? (row.cadence as Cadence) : CADENCES.includes(patch.cadence as Cadence) ? (patch.cadence as Cadence) : null;
  if (!cadence) return fail(400, 'bad_cadence', 'Choose once, every week or every month.');
  const name = patch.name === undefined ? row.name : cleanName(patch.name);
  if (!name) return fail(400, 'bad_name', 'Give the schedule a name.');
  const firstChanged = patch.firstDueAt !== undefined;
  const firstDueMs = firstChanged ? msOf(patch.firstDueAt) : row.firstDueAt.getTime();
  if (firstDueMs === null) return fail(400, 'bad_due', 'Choose when the first payment falls due.');
  const timeChanged = firstChanged || cadence !== row.cadence;
  // The time the schedule next falls due, after this change: the new first time, or the first one after now.
  const nextMs = timeChanged ? (cadence === 'once' ? firstDueMs : firstChanged && firstDueMs > deps.now().getTime() ? firstDueMs : nextDueAfter(cadence, firstDueMs, deps.now().getTime())) : (row.nextDueAt?.getTime() ?? null);
  if (firstChanged) {
    const when = checkWhen(deps, mode, firstDueMs);
    if (when) return when;
  }
  // An automatic schedule's coming run must leave the owners time to read the notice, however it became automatic.
  if (nextMs !== null && mode === 'auto' && (timeChanged || wasMode !== 'auto')) {
    const when = checkWhen(deps, mode, nextMs);
    if (when) return when;
  }

  let items = itemsOf(row);
  let total = row.totalMinor;
  let fees = row.feeMinor;
  let confirmed = row.confirmedNewPayees;
  if (patch.items !== undefined) {
    const made = await makeItems(deps, actor, patch.items, { confirmNewPayees: patch.confirmNewPayees === true });
    if (!made.ok) return made;
    if (made.needsConfirmation) {
      return fail(409, 'new_payee_needs_confirmation', 'A business on Splash is in this schedule that nobody on your team has saved. Check its name, address and country, and confirm it is the one you mean to pay.', {
        payees: made.items.filter((i) => i.payee.kind === 'splash_business').map((i) => ({ name: i.name, address: i.address, country: i.country })),
      });
    }
    items = made.items;
    total = made.totalMinor;
    fees = made.feeMinor;
    confirmed = made.items.some((i) => i.payee.kind === 'splash_business');
  }
  if (mode === 'auto') {
    const payer = await deps.payer();
    if (!payer.ok) return fail(409, 'auto_not_available', 'Automatic payments are not switched on for your business here yet. Choose “Ask me first”.');
  }

  const now = deps.now();
  const moved = timeChanged || patch.items !== undefined || mode !== wasMode;
  const updated = await updateSchedule(
    deps.db,
    deps.orgId,
    id,
    {
      name,
      mode,
      cadence,
      firstDueAt: new Date(firstDueMs),
      nextDueAt: nextMs === null ? null : new Date(nextMs),
      status: nextMs === null && row.status === 'active' ? 'completed' : row.status === 'completed' && nextMs !== null ? 'active' : row.status,
      items,
      itemCount: items.length,
      totalMinor: total,
      feeMinor: fees,
      confirmedNewPayees: confirmed,
      version: row.version + 1,
      updatedAt: now,
    },
    { from: ['active', 'stopped', 'completed'] },
  );
  if (!updated) return fail(409, 'schedule_changed', 'The schedule changed while you were editing it. Reload it and try again.');
  if (timeChanged) {
    // A run made for the old time that has not started is taken back; the new time makes its own.
    const stale = (await listRuns(deps.db, deps.orgId, 400)).filter((r) => r.scheduleId === id && r.status === 'scheduled' && (nextMs === null || dueDateOf(r.dueAt.getTime()) !== dueDateOf(nextMs)));
    for (const r of stale) await moveRun(deps.db, deps.orgId, r.id, { status: 'skipped', reasonCode: 'schedule_changed', reason: 'The schedule was changed, so this run was taken back. Nothing was paid.', skippedBy: actor.userId, skippedAt: now, updatedAt: now }, ['scheduled']);
  }
  if (moved) await recordAuthorityEvent(deps.db, { orgId: deps.orgId, actorUserId: actor.userId, action: 'schedule_changed', ref: id, detail: { mode, cadence, items: items.length }, now: deps.now });
  return { ok: true, schedule: await scheduleView(deps, actor, updated) };
}

// ─── Skip, stop, resume, delete ─────────────────────────────────────────────

/**
 * Skip one run, at once. With no run named, the next one that has not started.
 * A run waiting for approval has its request withdrawn; an automatic run is
 * skipped only while none of its payments has gone out.
 */
export async function skipRun(deps: ScheduleDeps, actor: Actor, scheduleId: string, which: { runId?: string } = {}): Promise<{ ok: true; run: RunView } | Fail> {
  const sch = await getSchedule(deps.db, deps.orgId, scheduleId);
  if (!sch || sch.status === 'deleted') return fail(404, 'schedule_not_found', 'No such schedule.');
  if (!mayManage(actor, sch.mode as ScheduleMode)) return cannotManage(sch.mode as ScheduleMode);
  const now = deps.now();

  let run: RunRow | null = null;
  if (which.runId) {
    run = await getRun(deps.db, deps.orgId, which.runId);
    if (!run || run.scheduleId !== sch.id) return fail(404, 'run_not_found', 'No such run.');
  } else {
    if (!sch.nextDueAt || sch.status !== 'active') return fail(409, 'nothing_to_skip', 'There is no coming run to skip.');
    const dueDate = dueDateOf(sch.nextDueAt.getTime());
    run = (await getRunForDate(deps.db, deps.orgId, sch.id, dueDate)) ?? (await insertRunOnce(deps.db, { id: `psr_${randomUUID()}`, scheduleId: sch.id, orgId: deps.orgId, dueDate, dueAt: sch.nextDueAt, mode: sch.mode, status: 'scheduled', createdAt: now, updatedAt: now })).run;
  }

  const patch = { status: 'skipped' as const, reasonCode: 'skipped', reason: 'An owner skipped this run. Nothing was paid.', skippedBy: actor.userId, skippedAt: now, updatedAt: now };
  let moved: RunRow | null = null;
  if (run.status === 'scheduled') {
    moved = await moveRun(deps.db, deps.orgId, run.id, patch, ['scheduled']);
  } else if (run.status === 'waiting_approval') {
    const batch = run.batchId ? await getBatch(deps, run.batchId) : null;
    if (batch?.signingRequestId) {
      const cancelled = await cancelSigningRequest(deps.ctx.signing, { orgId: deps.orgId, userId: batch.requestedBy, id: batch.signingRequestId });
      if (!cancelled.ok) return fail(409, 'cannot_withdraw', 'The owners already started signing this one, or it just closed, so it could not be skipped. Check its state and try again.');
    }
    moved = await moveRun(deps.db, deps.orgId, run.id, patch, ['waiting_approval']);
  } else if (run.status === 'approved') {
    const payments = await listRunPayments(deps.db, deps.orgId, run.id);
    if (payments.some((p) => p.status === 'submitting' || p.status === 'paid')) return fail(409, 'already_paying', 'Part of this run has already gone out, so it cannot be skipped. Nothing more will be started if you stop the schedule.');
    moved = await moveRun(deps.db, deps.orgId, run.id, patch, ['approved']);
  } else {
    return fail(409, 'run_finished', run.status === 'skipped' ? 'That run was already skipped.' : 'That run has already finished, so it cannot be skipped.');
  }
  if (!moved) return fail(409, 'run_moved', 'That run just changed. Reload it and check its state.');

  // A skipped run is a run made: the schedule moves on to its next time.
  if (sch.nextDueAt && sch.nextDueAt.getTime() === moved.dueAt.getTime()) {
    const next = nextDueAfter(sch.cadence as Cadence, sch.firstDueAt.getTime(), moved.dueAt.getTime());
    await advanceSchedule(deps.db, sch, moved.dueAt, next === null ? null : new Date(next), now);
  }
  await recordAuthorityEvent(deps.db, { orgId: deps.orgId, actorUserId: actor.userId, action: 'schedule_run_skipped', ref: moved.id, detail: { schedule: sch.id, dueDate: moved.dueDate }, now: deps.now });
  void notifySkip(deps, sch, moved, actor).catch(() => undefined);
  return { ok: true, run: runView(moved, sch.name) };
}

async function notifySkip(deps: ScheduleDeps, sch: ScheduleRow, run: RunRow, actor: Actor): Promise<void> {
  await deps.notify({
    kind: 'skipped',
    orgId: deps.orgId,
    businessName: await businessName(deps),
    scheduleId: sch.id,
    scheduleName: sch.name,
    runId: run.id,
    mode: sch.mode as ScheduleMode,
    dueAtMs: run.dueAt.getTime(),
    totalMinor: sch.totalMinor.toString(),
    feeMinor: sch.feeMinor.toString(),
    itemCount: sch.itemCount,
    reason: null,
    by: await nameOfUser(deps.db, actor.userId),
    path: scheduledRunPath(run.id),
  });
}

/** Stop a schedule, at once: no run starts until it is resumed. A run that is waiting to start, or prepared and not yet paid, is skipped with it. */
export async function stopSchedule(deps: ScheduleDeps, actor: Actor, id: string): Promise<{ ok: true; schedule: ScheduleView } | Fail> {
  const row = await getSchedule(deps.db, deps.orgId, id);
  if (!row || row.status === 'deleted') return fail(404, 'schedule_not_found', 'No such schedule.');
  if (!mayManage(actor, row.mode as ScheduleMode)) return cannotManage(row.mode as ScheduleMode);
  const now = deps.now();
  const stopped = await updateSchedule(deps.db, deps.orgId, id, { status: 'stopped', stoppedAt: now, stoppedBy: actor.userId, updatedAt: now }, { from: ['active', 'completed'] });
  if (!stopped) return row.status === 'stopped' ? { ok: true, schedule: await scheduleView(deps, actor, row) } : fail(409, 'schedule_changed', 'That schedule just changed. Reload it and try again.');
  // The run that is about to start does not.
  for (const r of (await listRuns(deps.db, deps.orgId, 400)).filter((x) => x.scheduleId === id && (x.status === 'scheduled' || x.status === 'approved'))) {
    const payments = r.status === 'approved' ? await listRunPayments(deps.db, deps.orgId, r.id) : [];
    if (payments.some((p) => p.status === 'submitting' || p.status === 'paid')) continue;
    await moveRun(deps.db, deps.orgId, r.id, { status: 'skipped', reasonCode: 'stopped', reason: 'The schedule was stopped, so this run was not started. Nothing was paid.', skippedBy: actor.userId, skippedAt: now, updatedAt: now }, [r.status as RunStatus]);
  }
  await recordAuthorityEvent(deps.db, { orgId: deps.orgId, actorUserId: actor.userId, action: 'schedule_stopped', ref: id, detail: {}, now: deps.now });
  return { ok: true, schedule: await scheduleView(deps, actor, stopped) };
}

/** Start a stopped schedule again. Its next run is the next time it falls due after now; nothing missed is run late. */
export async function resumeSchedule(deps: ScheduleDeps, actor: Actor, id: string): Promise<{ ok: true; schedule: ScheduleView } | Fail> {
  const row = await getSchedule(deps.db, deps.orgId, id);
  if (!row || row.status === 'deleted') return fail(404, 'schedule_not_found', 'No such schedule.');
  if (!mayManage(actor, row.mode as ScheduleMode)) return cannotManage(row.mode as ScheduleMode);
  if (row.status !== 'stopped') return fail(409, 'not_stopped', 'That schedule is not stopped.');
  const now = deps.now();
  const next = nextDueAfter(row.cadence as Cadence, row.firstDueAt.getTime(), now.getTime() + (row.mode === 'auto' ? AUTO_MIN_LEAD_MS : ASK_MIN_LEAD_MS) - 1);
  if (next === null) return fail(409, 'nothing_left', 'That schedule has no coming run. Edit its time to start it again.');
  const updated = await updateSchedule(deps.db, deps.orgId, id, { status: 'active', nextDueAt: new Date(next), stoppedAt: null, stoppedBy: null, updatedAt: now }, { from: ['stopped'] });
  if (!updated) return fail(409, 'schedule_changed', 'That schedule just changed. Reload it and try again.');
  await recordAuthorityEvent(deps.db, { orgId: deps.orgId, actorUserId: actor.userId, action: 'schedule_resumed', ref: id, detail: {}, now: deps.now });
  return { ok: true, schedule: await scheduleView(deps, actor, updated) };
}

/** Delete a schedule, at once. Its history stays; nothing more runs. */
export async function deleteSchedule(deps: ScheduleDeps, actor: Actor, id: string): Promise<{ ok: true } | Fail> {
  const row = await getSchedule(deps.db, deps.orgId, id);
  if (!row || row.status === 'deleted') return fail(404, 'schedule_not_found', 'No such schedule.');
  if (!mayManage(actor, row.mode as ScheduleMode)) return cannotManage(row.mode as ScheduleMode);
  const stopped = await stopSchedule(deps, actor, id);
  if (!stopped.ok && stopped.code !== 'schedule_changed') return stopped;
  const now = deps.now();
  await updateSchedule(deps.db, deps.orgId, id, { status: 'deleted', nextDueAt: null, updatedAt: now });
  await recordAuthorityEvent(deps.db, { orgId: deps.orgId, actorUserId: actor.userId, action: 'schedule_deleted', ref: id, detail: {}, now: deps.now });
  return { ok: true };
}

// ─── Automatic payments: the kill switch and the allowance ──────────────────

function spendOf(deps: ScheduleDeps): Promise<SpendContext | null> {
  const sc = typeof deps.spend === 'function' ? deps.spend() : Promise.resolve(deps.spend ?? null);
  return sc.then((c) => (c && c.orgId === deps.orgId ? c : null));
}

export async function automaticStatus(deps: ScheduleDeps): Promise<AutomaticStatus> {
  const settings = await getSettings(deps.db, deps.orgId);
  const payer = await deps.payer();
  const now = deps.now();
  const used = await autoPaidSince(deps.db, deps.orgId, new Date(now.getTime() - 24 * 3_600_000));
  let allowance: AutomaticStatus['allowance'] = { state: 'none' };
  if (payer.ok) {
    const sc = await spendOf(deps);
    if (!sc) {
      allowance = { state: 'unreadable' };
    } else {
      const read = await readStaffRule(sc, { addresses: [payer.payer.address] });
      if (!read.ok) allowance = { state: 'unreadable' };
      else if (read.read.facts.rule) {
        const r = read.read.facts.rule;
        allowance = {
          state: r.status === 'active' ? 'active' : r.status === 'expired' ? 'expired' : r.status === 'not_started' ? 'not_started' : 'revoked',
          perPaymentMaxMinor: r.perPaymentMaxMinor,
          spendableNowMinor: r.spendableNowMinor,
          startsAtMs: r.startsAtMs ?? null,
          expiresAtMs: r.expiresAtMs ?? null,
          renewsAtMs: r.renewsAtMs ?? null,
        };
      }
    }
  }
  return {
    payer: payer.ok ? { ready: true, kind: payer.payer.kind, reason: null, address: maskAddress(payer.payer.address) } : { ready: false, kind: null, reason: payer.reason, address: null },
    paused: settings?.autoPaused ?? false,
    pausedBy: settings?.pausedBy ?? null,
    pausedAt: settings?.pausedAt ? settings.pausedAt.toISOString() : null,
    dailyCapMinor: (settings?.dailyCapMinor ?? BigInt(ALLOWANCE_DEFAULTS.dailyUsdc) * 1_000_000n).toString(),
    dailyUsedMinor: used.toString(),
    allowance,
    defaults: ALLOWANCE_DEFAULTS,
  };
}

/** The kill switch: one owner pauses every automatic payment for the business, at once. The next automatic run comes to the owners instead. */
export async function pauseAutomatic(deps: ScheduleDeps, actor: Actor): Promise<{ ok: true; paused: true } | Fail> {
  if (!isOwner(actor)) return ownersOnly('pause automatic payments');
  const now = deps.now();
  await saveSettings(deps.db, deps.orgId, { autoPaused: true, pausedBy: actor.userId, pausedAt: now }, now);
  await recordAuthorityEvent(deps.db, { orgId: deps.orgId, actorUserId: actor.userId, action: 'automatic_payments_paused', ref: null, detail: {}, now: deps.now });
  void deps
    .notify({
      kind: 'paused',
      orgId: deps.orgId,
      businessName: await businessName(deps),
      scheduleId: null,
      scheduleName: 'Automatic payments',
      runId: null,
      mode: 'auto',
      dueAtMs: null,
      totalMinor: '0',
      feeMinor: '0',
      itemCount: 0,
      reason: null,
      by: await nameOfUser(deps.db, actor.userId),
      path: SCHEDULED_PATH,
    })
    .catch(() => undefined);
  return { ok: true, paused: true };
}

export async function resumeAutomatic(deps: ScheduleDeps, actor: Actor): Promise<{ ok: true; paused: false } | Fail> {
  if (!isOwner(actor)) return ownersOnly('turn automatic payments back on');
  const now = deps.now();
  await saveSettings(deps.db, deps.orgId, { autoPaused: false, pausedBy: null, pausedAt: null }, now);
  await recordAuthorityEvent(deps.db, { orgId: deps.orgId, actorUserId: actor.userId, action: 'automatic_payments_resumed', ref: null, detail: {}, now: deps.now });
  return { ok: true, paused: false };
}

export type AllowanceInput = { perPaymentUsdc: unknown; dailyUsdc: unknown; monthlyUsdc: unknown; expiresInDays: unknown };

/**
 * Ask the owners to sign an allowance to the scheduled payer (through the same
 * signed request flow as a spending rule): a per-payment maximum, a monthly
 * cap on chain, an expiry, and a daily limit Splash's server holds runs to.
 * It is revocable and expiring; it works only for recipients the owners
 * verified. The request goes to the owners' wallet; nothing is in force until
 * their passkeys sign it.
 */
export async function requestAllowance(deps: ScheduleDeps, actor: Actor, input: AllowanceInput): Promise<{ ok: true; request: RequestView } | Fail> {
  if (!isOwner(actor)) return ownersOnly('give Splash an allowance to pay automatically');
  const perPayment = parseAmountMinor(String(input.perPaymentUsdc ?? ''));
  const daily = parseAmountMinor(String(input.dailyUsdc ?? ''));
  const monthly = parseAmountMinor(String(input.monthlyUsdc ?? ''));
  const days = typeof input.expiresInDays === 'number' ? input.expiresInDays : Number(String(input.expiresInDays ?? ''));
  const problems = allowanceProblems({ perPaymentMinor: perPayment ?? 0n, dailyMinor: daily ?? 0n, monthlyMinor: monthly ?? 0n, expiresInDays: days });
  if (problems.length > 0) return fail(400, 'bad_allowance', problems.join(' '), { problems });
  const payer = await deps.payer();
  if (!payer.ok) return fail(409, 'payer_unavailable', 'Automatic payments are not switched on for your business here yet, so there is nothing to give an allowance to.');
  const sc = await spendOf(deps);
  if (!sc) return fail(503, 'spending_rules_unavailable', 'Spending rules are not set up for your business here, so an allowance cannot be asked for.');
  const members = await deps.walletMembers();
  if (!members.ok) return fail(members.status, members.code, members.error);
  const now = deps.now().getTime();
  const rule = {
    spender: payer.payer.address,
    perPaymentMaxMinor: perPayment as bigint,
    cap: { period: 'month' as const, limitMinor: monthly as bigint },
    expiresAtMs: BigInt(now) + BigInt(days) * 86_400_000n,
  };
  const args = { orgId: deps.orgId, requestedBy: actor.userId, wallet: members.members, rule };
  let opened = await issueSpendingRule(sc, args);
  // An allowance already exists: change it (revoke and reissue in one signed request), keeping what was spent.
  if (!opened.ok && opened.code === 'rule_exists') opened = await changeSpendingRule(sc, args);
  if (!opened.ok) return fail(opened.status, opened.code, opened.error, 'details' in opened ? (opened.details as Record<string, unknown> | undefined) : undefined);
  await saveSettings(deps.db, deps.orgId, { dailyCapMinor: daily as bigint }, deps.now());
  await recordAuthorityEvent(deps.db, { orgId: deps.orgId, actorUserId: actor.userId, action: 'automatic_allowance_requested', ref: opened.request.id, detail: { perPaymentMinor: perPayment?.toString(), dailyMinor: daily?.toString(), monthlyMinor: monthly?.toString(), days }, now: deps.now });
  return { ok: true, request: opened.request };
}

/** Ask the owners to sign the allowance's end. Taking effect when the owners sign; the kill switch and "ask me first" take effect at once. */
export async function revokeAllowance(deps: ScheduleDeps, actor: Actor): Promise<{ ok: true; request: RequestView } | Fail> {
  if (!isOwner(actor)) return ownersOnly('take back the allowance for automatic payments');
  const payer = await deps.payer();
  if (!payer.ok) return fail(409, 'payer_unavailable', 'Automatic payments are not switched on for your business here yet.');
  const sc = await spendOf(deps);
  if (!sc) return fail(503, 'spending_rules_unavailable', 'Spending rules are not set up for your business here.');
  const members = await deps.walletMembers();
  if (!members.ok) return fail(members.status, members.code, members.error);
  const opened = await revokeSpendingRule(sc, { orgId: deps.orgId, requestedBy: actor.userId, wallet: members.members, spender: payer.payer.address });
  if (!opened.ok) return fail(opened.status, opened.code, opened.error);
  await recordAuthorityEvent(deps.db, { orgId: deps.orgId, actorUserId: actor.userId, action: 'automatic_allowance_revoke_requested', ref: opened.request.id, detail: {}, now: deps.now });
  return { ok: true, request: opened.request };
}

/** Is this person an owner of this business now? The runner asks it of a schedule's creator at every automatic run. */
export async function isOwnerOf(db: DrizzleDb, orgId: string, userId: string): Promise<boolean> {
  const [m] = await db.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId))).limit(1);
  return m?.role === 'admin';
}

export { listOrgOwners, sha as scheduleHash, nameOfUser, businessName, spendOf };
