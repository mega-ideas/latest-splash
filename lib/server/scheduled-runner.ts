/**
 * The runner for scheduled batches (v2 Phase 3): what happens at the due time.
 *
 * `runScheduledPayments` is what the cron route calls (every few minutes,
 * protected by a bearer secret, failing closed when it is unset). It takes an
 * injected clock, and running it twice is running it once: a run is made once
 * per schedule and due date (a unique key), claimed with a lease before it is
 * worked on, and every step that moves it is a compare-and-set from the state
 * it expects.
 *
 *   1. Schedules. For each active schedule due within a day: make its run
 *      (durable first), send the automatic one's day-before notice, and once
 *      the due time has come, move the schedule on to its next time.
 *   2. Runs. Each open run: one waiting to start is started; one waiting for
 *      approval is followed through the batch's signing request; an automatic
 *      one in flight is settled from its payments.
 *
 * Starting a run, by the mode the schedule is in NOW:
 *
 *   ask   prepare the batch as the existing Batch payouts do and ask the
 *         owners (their phones, WhatsApp, the app). No partner is called; the
 *         owners sign before anything moves. If nobody approves it before the
 *         request ends, the run lapses, in plain words, with no fee.
 *   auto  run every check (lib/schedule/auto-check.ts) over the whole run. If
 *         they all pass, pay each payment in turn through splash_spend under
 *         the owners' allowance, signed by the scheduled payer's KMS key, with
 *         the operator sponsoring gas. If any fails, the run is handed back to
 *         "ask", and the owners are told why.
 *
 * The money-moving part is at-most-once. A payment is claimed (pending ->
 * submitting) with its digest written first and only while its run is still
 * `approved`; a payment whose outcome is unknown is read back from the chain
 * by that digest and never sent again; the payment reference is also the
 * intent's idempotency key on chain.
 *
 * The grace window (migration 0076). An automatic run that passes its checks
 * does not pay at once: it announces its window. The "starting" notice goes out
 * with the time the first payment may be claimed (GRACE minutes later, 10 by
 * default, 0 to 60 per business), the run stays `scheduled` and skippable, and
 * nothing is claimed or paid before that time (the payment claim itself refuses
 * to run early). At the window's end every check is made again; anything that no
 * longer passes, a changed schedule included, hands the run back to "ask me
 * first". A window of 0 pays at the due time as it always did.
 *
 * The window fails closed on delivery. The notice is recorded as sent only if it
 * reached at least one owner (the notifier says how many); when it reached no one
 * the window is closed again and the next pass opens a fresh one. A window that
 * ends with no notice recorded is never paid on: the run goes back to "ask me
 * first" (window_not_announced). If no owner can be told for a day, the run lapses.
 *
 * Fail closed. Without the scheduled payer's KMS key in production, without
 * the allowance, without the gas sponsor, with automatic payments paused, or
 * with the chain unreadable, nothing is paid automatically.
 */
import { createHash, randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { walletSigningRequests } from '../db/schema.ts';

import { describeWalletTransaction, WalletTxRefused } from '../wallet/wallet-tx-describe.ts';
import { evaluateAutoRun, type AutoItemFacts } from '../schedule/auto-check.ts';
import {
  APPROVAL_WINDOW_MS,
  LAPSED_REASON,
  LATE_LIMIT_MS,
  MINUTE_MS,
  NOTICE_LEAD_MS,
  NOT_STARTED_REASON,
  RUN_CLAIM_LEASE_MS,
  SUBMIT_LEASE_MS,
  dueDateOf,
  fallbackWords,
  nextDueAfter,
  runKey,
  type Cadence,
  type FallbackCode,
  type RunStatus,
  type ScheduleMode,
} from '../schedule/rules.ts';
import { scheduledRunPath, type NoticeKind, type ScheduleNotice } from '../schedule/notice.ts';
import { sheetRowsFromBody } from '../batch/sheet.ts';
import { effectiveDailyCap } from '../limits/rules.ts';
import { currentLimits } from './business-limits.ts';
import { recipientPayable } from './business-wallet.ts';
import { staffRulePaymentTx } from './spend-rules-builders.ts';
import { readStaffRule } from './spend-rules.ts';
import { isProductionRuntime } from './runtime-mode.ts';
import {
  advanceSchedule,
  autoPaidSince,
  claimPayment,
  claimRun,
  dailyCapOf,
  finishPayment,
  graceMinutesOf,
  getRun,
  getSchedule,
  getSettings,
  insertRunOnce,
  insertRunPayments,
  itemsOf,
  listDueSchedulesForStaff,
  listOpenRunsForStaff,
  listRunPayments,
  moveRun,
  openGraceWindow,
  closeGraceWindow,
  confirmGraceNotice,
  paidBefore,
  stampNotice,
  withLock,
  type RunPaymentRow,
  type RunRow,
  type ScheduleRow,
} from './scheduled-store.ts';
import { businessName, isOwnerOf, listOrgOwners, spendOf, type ScheduleDeps } from './scheduled-payments.ts';
import type { ScheduledPayer } from './scheduled-payer-signer.ts';
import type { SpendContext, StaffRuleRead } from './spend-rules.ts';
import { WALLET_SPONSOR_DAILY_BUDGET_MIST, assertPurposeShape } from './wallet-signing.ts';
import { sponsoredBudgetSince, type DrizzleDb } from './wallet-signing-store.ts';
import { assertSponsorable, SponsorRefused } from './wallet-sponsor.ts';
import { createBatch, getBatch, reviewBatch } from './wallet-batches.ts';
import { declinedByLabel } from '../team/declined-by.ts';
import { resolvePayee, TRANSFER_INTENT_LIFETIME_MS, type PayeeInput } from './wallet-transfers.ts';
import { buildPaymentTrail } from './payment-trail.ts';

/** How long the quote of an automatic payment lasts: it is paid within seconds. */
export const AUTO_SETTLE_WINDOW_MS = 15 * 60_000;

/** The window the business's monthly limit counts automatic payments over: any 30 days. */
const MONTHLY_WINDOW_MS = 30 * 24 * 3_600_000;
/** An unknown outcome is read back from the chain for this long, then given up on: the bytes can no longer land. */
export const SUBMIT_GIVE_UP_MS = 72 * 3_600_000;
/** The most missed occurrences made up in one pass: each lapses, and nothing is paid late. */
const MAX_CATCH_UP = 60;

const sha = (text: string) => createHash('sha256').update(text).digest();

export type RunnerDeps = {
  db: DrizzleDb;
  now: () => Date;
  /** One business's own context, or null when it cannot be worked on (no wallet, no database). Never another business's. */
  depsFor: (orgId: string) => Promise<ScheduleDeps | null>;
  env?: NodeJS.ProcessEnv;
  /**
   * How long, in real time, one pass may go on starting new work (default 40 seconds, inside the cron route's 60). Work not
   * reached is left for the next pass, which is every few minutes; nothing already begun is cut off in the middle.
   */
  budgetMs?: number;
};

export type RunnerResult = {
  ok: true;
  schedules: number;
  runsMade: number;
  started: number;
  followed: number;
  notices: number;
  /** The pass ran out of its time before reaching everything; the next pass carries on. */
  deferred: boolean;
  errors: Array<{ orgId: string; id: string; error: string }>;
};

/** What the cron answers: what could not be worked on is named by business and id, never by error text, which can carry a query. */
export function publicRunnerResult(result: RunnerResult): Omit<RunnerResult, 'errors'> & { errors: Array<{ orgId: string; id: string }> } {
  return { ...result, errors: result.errors.map((e) => ({ orgId: e.orgId, id: e.id })) };
}

/** Do what is due. Safe to run twice: the second finds the first's work done. */
export async function runScheduledPayments(deps: RunnerDeps): Promise<RunnerResult> {
  const result: RunnerResult = { ok: true, schedules: 0, runsMade: 0, started: 0, followed: 0, notices: 0, deferred: false, errors: [] };
  const began = performance.now();
  const budget = deps.budgetMs ?? 40_000;
  const outOfTime = () => {
    if (performance.now() - began <= budget) return false;
    result.deferred = true;
    return true;
  };
  const cache = new Map<string, ScheduleDeps | null>();
  const forOrg = async (orgId: string) => {
    if (!cache.has(orgId)) cache.set(orgId, await deps.depsFor(orgId));
    return cache.get(orgId) ?? null;
  };
  const guard = async (orgId: string, id: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      // One run's trouble never stops the others. The message carries no key and no secret.
      result.errors.push({ orgId, id, error: error instanceof Error ? error.message : String(error) });
    }
  };

  // 1. Schedules.
  const now = deps.now();
  for (const due of await listDueSchedulesForStaff(deps.db, now, NOTICE_LEAD_MS)) {
    if (outOfTime()) break;
    result.schedules += 1;
    await guard(due.orgId, due.id, async () => {
      const d = await forOrg(due.orgId);
      if (!d) return;
      const tally = await makeRuns(d, due.id);
      result.runsMade += tally.made;
      result.notices += tally.notices;
    });
  }

  // 2. Runs.
  for (const open of await listOpenRunsForStaff(deps.db)) {
    if (outOfTime()) break;
    await guard(open.orgId, open.id, async () => {
      const d = await forOrg(open.orgId);
      if (!d) return;
      const run = await getRun(d.db, d.orgId, open.id);
      if (!run) return;
      if (run.status === 'scheduled') {
        if (run.dueAt.getTime() > d.now().getTime()) return;
        // Its window is open and an owner was told: nothing is claimed or paid until it ends (a Skip or Stop can still end the run).
        // A window nobody was told about is not waited on: startRun opens a fresh one, with its full warning.
        if (run.startsAt && run.noticeRunningAt && run.startsAt.getTime() > d.now().getTime()) return;
        result.started += 1;
        result.notices += await startRun(d, run.id);
      } else if (run.status === 'waiting_approval' || (run.status === 'approved' && run.ranAs !== 'auto')) {
        result.followed += 1;
        result.notices += await followApproval(d, run.id);
      } else if (run.status === 'approved') {
        result.followed += 1;
        result.notices += await followAuto(d, run.id);
      }
    });
  }
  return result;
}

// ─── 1. Making the runs ─────────────────────────────────────────────────────

async function makeRuns(d: ScheduleDeps, scheduleId: string): Promise<{ made: number; notices: number }> {
  let made = 0;
  let notices = 0;
  for (let guard = 0; guard < MAX_CATCH_UP; guard += 1) {
    const sch = await getSchedule(d.db, d.orgId, scheduleId);
    if (!sch || sch.status !== 'active' || !sch.nextDueAt) break;
    const now = d.now();
    const dueAt = sch.nextDueAt;
    if (dueAt.getTime() - now.getTime() > NOTICE_LEAD_MS) break;
    const inserted = await insertRunOnce(d.db, {
      id: `psr_${randomUUID()}`,
      scheduleId: sch.id,
      orgId: d.orgId,
      dueDate: dueDateOf(dueAt.getTime()),
      dueAt,
      mode: sch.mode,
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
    });
    const created = inserted.created;
    let run = inserted.run;
    if (created) made += 1;
    // A run made for another time of this day (the time was moved) takes the schedule's time, so it is never started at the old one.
    if (!created && run.status === 'scheduled' && run.dueAt.getTime() !== dueAt.getTime()) {
      const retimed = await moveRun(d.db, d.orgId, run.id, { dueAt, claimedAt: null, noticeDayBeforeAt: null, startsAt: null, windowVersion: null, noticeRunningAt: null, updatedAt: now }, ['scheduled']);
      if (retimed) run = retimed;
    }
    // The day before: an automatic run says it is coming, once.
    if (sch.mode === 'auto' && run.status === 'scheduled' && now.getTime() < dueAt.getTime()) {
      if (await stampNotice(d.db, d.orgId, run.id, 'noticeDayBeforeAt', now)) {
        await tell(d, 'day_before', sch, run, { totalMinor: sch.totalMinor, feeMinor: sch.feeMinor, itemCount: sch.itemCount, graceMinutes: await graceMinutesOf(d.db, d.orgId) });
        notices += 1;
      }
    }
    if (now.getTime() < dueAt.getTime()) break;
    // The due time has come and its run exists: the schedule moves on to its next time.
    const next = nextDueAfter(sch.cadence as Cadence, sch.firstDueAt.getTime(), dueAt.getTime());
    const moved = await advanceSchedule(d.db, sch, dueAt, next === null ? null : new Date(next), now);
    if (!moved) break;
  }
  return { made, notices };
}

// ─── Notices ────────────────────────────────────────────────────────────────

async function tell(
  d: ScheduleDeps,
  kind: NoticeKind,
  sch: ScheduleRow,
  run: RunRow,
  more: { totalMinor?: bigint; feeMinor?: bigint; itemCount?: number; reason?: string | null; startsAtMs?: number | null; graceMinutes?: number | null } = {},
): Promise<number> {
  const notice: ScheduleNotice = {
    kind,
    orgId: d.orgId,
    businessName: await businessName(d),
    scheduleId: sch.id,
    scheduleName: sch.name,
    runId: run.id,
    mode: sch.mode as ScheduleMode,
    dueAtMs: run.dueAt.getTime(),
    totalMinor: (more.totalMinor ?? run.totalMinor).toString(),
    feeMinor: (more.feeMinor ?? run.feeMinor).toString(),
    itemCount: more.itemCount ?? run.itemCount,
    reason: more.reason === undefined ? (run.reason ?? null) : more.reason,
    by: null,
    path: scheduledRunPath(run.id),
    startsAtMs: more.startsAtMs ?? null,
    graceMinutes: more.graceMinutes ?? null,
  };
  // A notice that does not go out never undoes the run. How many owners it reached is the answer; a notifier that fails, or
  // that says nothing, reached no one.
  const reached = await d.notify(notice).catch(() => 0);
  return typeof reached === 'number' && reached > 0 ? reached : 0;
}

// ─── 2. Starting a run ──────────────────────────────────────────────────────

async function startRun(d: ScheduleDeps, runId: string): Promise<number> {
  const now = d.now();
  const run = await getRun(d.db, d.orgId, runId);
  if (!run || run.status !== 'scheduled') return 0;
  const sch = await getSchedule(d.db, d.orgId, run.scheduleId);
  if (!sch) return 0;

  // Not run late: a run Splash could not start within a day of its due time lapses, and nothing is paid.
  if (now.getTime() - run.dueAt.getTime() > LATE_LIMIT_MS) {
    const lapsed = await moveRun(d.db, d.orgId, run.id, { status: 'lapsed', reasonCode: 'not_started', reason: NOT_STARTED_REASON, updatedAt: now }, ['scheduled']);
    if (lapsed) {
      await tell(d, 'lapsed', sch, lapsed, { totalMinor: sch.totalMinor, feeMinor: sch.feeMinor, itemCount: sch.itemCount });
      return 1;
    }
    return 0;
  }

  // The window was announced to an owner and has not ended: there is nothing to start yet.
  if (run.startsAt && run.noticeRunningAt && run.startsAt.getTime() > now.getTime()) return 0;

  const claimed = await claimRun(d.db, d.orgId, run.id, now, RUN_CLAIM_LEASE_MS);
  if (!claimed) return 0;

  if (sch.status === 'stopped' || sch.status === 'deleted') {
    await moveRun(d.db, d.orgId, run.id, { status: 'skipped', reasonCode: 'stopped', reason: 'The schedule was stopped, so this run was not started. Nothing was paid.', updatedAt: now }, ['scheduled']);
    return 0;
  }

  // The mode the schedule is in now decides: switching to "ask me first" takes effect for this very run.
  if (sch.mode === 'auto') {
    let current = claimed;
    // The window protects the owners only if one of them was told. One that ended with no notice recorded is never paid on:
    // the run goes back to "ask me first". One still open, with no notice recorded (the runner stopped between opening it and
    // telling anyone), is closed and opened again, so the warning is a full one.
    if (current.startsAt && !current.noticeRunningAt) {
      if (current.startsAt.getTime() <= now.getTime()) {
        return prepareApproval(d, sch, current, { code: 'window_not_announced', text: fallbackWords('window_not_announced') });
      }
      const closed = await closeGraceWindow(d.db, d.orgId, current.id, current.startsAt, now, { keepLease: true });
      if (!closed) return 0;
      current = closed;
    }
    // Every check is made when the window opens (so nothing is announced that could not be paid) and again when it ends.
    const checked = await evaluateAuto(d, sch);
    if (!checked.ok) return prepareApproval(d, sch, current, { code: checked.code, text: checked.text });
    if (current.startsAt) {
      // The window has ended. What was announced is what is paid: a schedule changed since is handed back.
      if (current.windowVersion !== null && current.windowVersion !== sch.version) {
        return prepareApproval(d, sch, current, { code: 'changed_in_window', text: fallbackWords('changed_in_window') });
      }
      return executeAuto(d, sch, current, checked);
    }
    const grace = await graceMinutesOf(d.db, d.orgId);
    if (grace > 0) return openWindow(d, sch, current, checked, grace);
    return executeAuto(d, sch, current, checked);
  }
  return prepareApproval(d, sch, claimed, null);
}

// ─── The grace window ───────────────────────────────────────────────────────

/**
 * Open the window and tell the owners: the first payment may be claimed GRACE
 * minutes from now, the "starting" notice goes out with that time, and the run
 * stays "scheduled" (so a Skip or a Stop still ends it, with nothing paid). The
 * start is fixed here and a change to the setting later does not move it.
 *
 * The notice is recorded as sent only when it reached at least one owner. When it
 * reached no one (the mail provider is down, no owner has an address) the window
 * is closed again, so nothing is paid on the strength of a warning nobody
 * received, and the next pass opens a fresh window with its full length. The
 * lease on the run is held across the telling, so no other pass opens or closes
 * the window meanwhile.
 */
async function openWindow(d: ScheduleDeps, sch: ScheduleRow, run: RunRow, checked: CheckedRun, grace: number): Promise<number> {
  const now = d.now();
  const startsAt = new Date(now.getTime() + grace * MINUTE_MS);
  const opened = await openGraceWindow(d.db, d.orgId, run.id, { startsAt, windowVersion: sch.version, now });
  if (!opened) return 0;
  const reached = await tell(d, 'running', sch, opened, { totalMinor: checked.totalMinor, feeMinor: checked.feeMinor, itemCount: checked.rows.length, startsAtMs: startsAt.getTime(), graceMinutes: grace });
  if (reached > 0) {
    await confirmGraceNotice(d.db, d.orgId, opened.id, startsAt, d.now());
    return 1;
  }
  await closeGraceWindow(d.db, d.orgId, opened.id, startsAt, d.now());
  return 0;
}

// ─── Mode A: prepare the batch and ask ──────────────────────────────────────

const ctxCell = (item: ReturnType<typeof itemsOf>[number]) => (item.payee.kind === 'recipient' ? item.address : item.name);

async function actingOwner(d: ScheduleDeps, preferred: string): Promise<{ userId: string } | null> {
  const owners = await listOrgOwners(d.db, d.orgId);
  const chosen = owners.find((o) => o.userId === preferred) ?? owners[0];
  return chosen ? { userId: chosen.userId } : null;
}

const minorText = (minor: bigint) => `${minor / 1_000_000n}.${(minor % 1_000_000n).toString().padStart(6, '0')}`;

/**
 * Prepare the batch as the existing Batch payouts do, and ask the owners. The
 * batch's intent id is made from the schedule and the due date, so doing it
 * twice makes one batch. Nothing here calls a partner or moves money.
 */
async function prepareApproval(d: ScheduleDeps, sch: ScheduleRow, run: RunRow, handedBack: { code: FallbackCode; text: string } | null): Promise<number> {
  const now = d.now();
  const fail = async (code: string, said: string) => {
    // An automatic run handed back and then not preparable either says both: why it left automatic, and why it could not be asked.
    const reason = handedBack ? `${handedBack.text} It could not be prepared for approval either: ${said}` : said;
    const failed = await moveRun(d.db, d.orgId, run.id, { status: 'failed', ranAs: 'ask', reasonCode: code, reason, fallback: handedBack !== null, itemCount: sch.itemCount, totalMinor: sch.totalMinor, feeMinor: sch.feeMinor, updatedAt: now }, ['scheduled']);
    if (!failed) return 0;
    await tell(d, 'failed', sch, failed);
    return 1;
  };

  const owner = await actingOwner(d, sch.createdBy);
  if (!owner) return fail('no_owner', 'This business has no owner to ask. Nothing was paid.');
  const items = itemsOf(sch);
  const actor = { userId: owner.userId, role: 'OWNER' };
  const rows = sheetRowsFromBody(items.map((i) => ({ recipient: ctxCell(i), amount: minorText(BigInt(i.amountMinor)), reference: i.reference })));

  // The recipients are the ones the owner saved: a name or an address that now resolves to someone else is not paid.
  const review = await reviewBatch(d, actor, rows);
  if (!review.ok) return fail(review.code, review.error);
  for (let i = 0; i < items.length; i += 1) {
    const r = review.review.rows[i];
    if (!r?.ok) return fail(r?.code ?? 'row_not_payable', `${items[i].name}: ${r?.error ?? 'this payment cannot be prepared.'}`);
    const want = items[i].payee;
    const same = r.payee && normalizeSuiAddress(r.payee.address) === normalizeSuiAddress(items[i].address) && (want.kind === 'splash_business' ? r.payee.businessId === want.businessId : r.payee.recipientId === want.recipientId);
    if (!same) return fail('recipient_changed', `${items[i].name}: this recipient changed since the schedule was set up. Check the schedule and try again.`);
  }

  const created = await createBatch(d, actor, {
    clientKey: `sch-${runKey(sch.id, run.dueDate)}`,
    rows,
    maxFeeMinor: review.review.maxFeeMinor,
    label: sch.name,
    confirmDuplicates: true,
    confirmNewPayees: sch.confirmedNewPayees,
    settleWindowMs: APPROVAL_WINDOW_MS,
  });
  if (!created.ok) return fail(created.code, created.error);

  const moved = await moveRun(
    d.db,
    d.orgId,
    run.id,
    {
      status: 'waiting_approval',
      ranAs: 'ask',
      batchId: created.batch.id,
      fallback: handedBack !== null,
      reasonCode: handedBack?.code ?? null,
      reason: handedBack?.text ?? null,
      itemCount: items.length,
      totalMinor: BigInt(created.batch.totalMinor),
      feeMinor: BigInt(created.batch.feeMinor),
      updatedAt: now,
    },
    ['scheduled'],
  );
  if (!moved) return 0;
  await tell(d, 'approval_ready', sch, moved);
  return 1;
}

/** Follow a prepared batch to its end, through the batch's own signing request. */
async function followApproval(d: ScheduleDeps, runId: string): Promise<number> {
  const now = d.now();
  const run = await getRun(d.db, d.orgId, runId);
  if (!run || !run.batchId || (run.status !== 'waiting_approval' && run.status !== 'approved')) return 0;
  const sch = await getSchedule(d.db, d.orgId, run.scheduleId);
  if (!sch) return 0;
  const batch = await getBatch(d, run.batchId);
  if (!batch) return 0;
  const from: RunStatus[] = [run.status as RunStatus];
  let status = batch.status as string;
  // A request still collecting past its end can no longer be signed: it has lapsed, whether or not the sweep has closed it yet.
  if (status === 'awaiting_signatures' && batch.signingRequestId) {
    const [req] = await d.db
      .select({ status: walletSigningRequests.status, expiresAt: walletSigningRequests.expiresAt })
      .from(walletSigningRequests)
      .where(and(eq(walletSigningRequests.orgId, d.orgId), eq(walletSigningRequests.id, batch.signingRequestId)))
      .limit(1);
    if (req && req.status === 'collecting' && req.expiresAt.getTime() <= now.getTime()) status = 'expired';
  }
  switch (status) {
    case 'on_the_way': {
      const moved = await moveRun(d.db, d.orgId, run.id, { status: 'approved', updatedAt: now }, ['waiting_approval']);
      return moved ? 0 : 0;
    }
    case 'settled': {
      const paid = await moveRun(d.db, d.orgId, run.id, { status: 'paid', updatedAt: now }, from);
      if (!paid) return 0;
      if (await stampNotice(d.db, d.orgId, paid.id, 'noticeReceiptAt', now)) {
        await tell(d, 'paid', sch, paid, { reason: null });
        return 1;
      }
      return 0;
    }
    case 'failed': {
      const failed = await moveRun(d.db, d.orgId, run.id, { status: 'failed', reasonCode: 'batch_failed', reason: 'The owners signed, but the network did not take the payments, so nothing was paid. Check your balance and the recipients, then pay it from Batch payouts.', updatedAt: now }, from);
      if (!failed) return 0;
      await tell(d, 'failed', sch, failed);
      return 1;
    }
    case 'expired': {
      const lapsed = await moveRun(d.db, d.orgId, run.id, { status: 'lapsed', reasonCode: 'lapsed', reason: LAPSED_REASON, updatedAt: now }, from);
      if (!lapsed) return 0;
      await tell(d, 'lapsed', sch, lapsed);
      return 1;
    }
    case 'declined':
    case 'withdrawn': {
      const skipped = await moveRun(d.db, d.orgId, run.id, { status: 'skipped', reasonCode: status, reason: status === 'declined' ? `${declinedByLabel(batch.declinedBy)}. Nothing was paid.` :'The request was withdrawn. Nothing was paid.', updatedAt: now }, from);
      return skipped ? 0 : 0;
    }
    default:
      return 0;
  }
}

// ─── Mode B: the checks ─────────────────────────────────────────────────────

type CheckedRun = Extract<ReturnType<typeof evaluateAutoRun>, { ok: true }> & { payer: ScheduledPayer; sc: SpendContext };

async function evaluateAuto(d: ScheduleDeps, sch: ScheduleRow): Promise<CheckedRun | { ok: false; code: FallbackCode; text: string }> {
  const now = d.now();
  const items = itemsOf(sch);
  const settings = await getSettings(d.db, d.orgId);
  const payerResult = await d.payer();
  const sc = await spendOf(d);
  const ownerCreated = sch.createdAs === 'owner' && (await isOwnerOf(d.db, d.orgId, sch.createdBy));

  let ruleReadable = false;
  let rule: StaffRuleRead | null = null;
  if (sc && payerResult.ok) {
    const read = await readStaffRule(sc, { addresses: [payerResult.payer.address] });
    if (read.ok) {
      ruleReadable = true;
      rule = read.read;
    }
  }

  const itemFacts: AutoItemFacts[] = [];
  for (const item of items) {
    const payee: PayeeInput = item.payee.kind === 'splash_business' ? { kind: 'splash_business', businessId: item.payee.businessId } : { kind: 'recipient', recipientId: item.payee.recipientId };
    const resolved = await resolvePayee(d, payee);
    const known = 'ok' in resolved ? null : { address: normalizeSuiAddress(resolved.address), kind: resolved.kind };
    const owner = sch.createdBy;
    const cleared = known ? (await recipientPayable(d.ctx, d.orgId, known.address, known.kind, owner)) === null : false;
    const fee = known ? await d.splashFee({ kind: known.kind, principalMinor: BigInt(item.amountMinor) }) : { feeMinor: 0n };
    itemFacts.push({
      position: item.position,
      name: item.name,
      saved: { address: item.address, amountMinor: BigInt(item.amountMinor), feeMinor: BigInt(item.feeMinor), feeKind: item.feeKind },
      now: known,
      paidBefore: known ? await paidBefore(d.db, d.orgId, known.address) : false,
      cleared,
      currentFeeMinor: fee.feeMinor,
    });
  }

  // The business's own limits (Settings, Limits) hold too: the owners' daily limit never lifts the business's.
  const limits = await currentLimits(d.db, d.orgId, d.now);
  const dailyCap = effectiveDailyCap((await dailyCapOf(d.db, d.orgId)).capMinor, limits);
  const dailyUsed = await autoPaidSince(d.db, d.orgId, new Date(now.getTime() - 24 * 3_600_000));
  const monthlyUsed = await autoPaidSince(d.db, d.orgId, new Date(now.getTime() - MONTHLY_WINDOW_MS));
  const balance = d.walletBalance ? await d.walletBalance().catch(() => null) : null;
  const verdict = evaluateAutoRun(
    {
      nowMs: now.getTime(),
      settleWindowMs: AUTO_SETTLE_WINDOW_MS,
      paused: settings?.autoPaused ?? false,
      ownerCreated,
      // A sandbox payer signs nothing on any network and does not exist in production: nothing is announced or paid with one.
      payerReady: payerResult.ok && !(payerResult.payer.kind === 'sandbox' && isProductionRuntime(d.env ?? process.env)),
      sponsorReady: Boolean(sc?.wallet.signing.sponsor),
      ruleReadable,
      rule: rule?.facts.rule ?? null,
      policy: rule?.facts.policy ?? null,
      runningTotals: rule?.facts.runningTotals ?? {},
      dailyCapMinor: dailyCap,
      perPaymentLimitMinor: limits.per_payment,
      monthlyLimitMinor: limits.monthly,
      dailyUsedMinor: dailyUsed,
      monthlyUsedMinor: monthlyUsed,
      walletBalanceMinor: balance,
    },
    itemFacts,
  );
  if (!verdict.ok) return { ok: false, code: verdict.code, text: verdict.text };
  // A rule that reads as active but names no allowance or policy to build on cannot pay.
  if (!payerResult.ok || !sc || !rule || !rule.allowance || !rule.policy || rule.spender !== normalizeSuiAddress(payerResult.payer.address)) {
    return { ok: false, code: 'no_allowance', text: 'You have not given Splash an allowance to pay automatically, so this one needs your approval.' };
  }
  return { ...verdict, payer: payerResult.payer, sc };
}

// ─── Mode B: paying ─────────────────────────────────────────────────────────

async function executeAuto(d: ScheduleDeps, sch: ScheduleRow, run: RunRow, checked: CheckedRun): Promise<number> {
  const now = d.now();
  const items = itemsOf(sch);
  const key = runKey(sch.id, run.dueDate);
  const payments = checked.rows.map((r) => {
    const item = items.find((i) => i.position === r.position) as ReturnType<typeof itemsOf>[number];
    return {
      id: `psp_${randomUUID()}`,
      runId: run.id,
      orgId: d.orgId,
      position: r.position,
      paymentRef: sha(`splash-scheduled-payment|${d.orgId}|${key}|${r.position}`).toString('hex'),
      recipientId: item.payee.kind === 'recipient' ? item.payee.recipientId : null,
      businessId: item.payee.kind === 'splash_business' ? item.payee.businessId : null,
      payeeName: item.name,
      address: r.address,
      amountMinor: r.amountMinor,
      maxFeeMinor: r.feeMinor,
      feeKind: r.kind,
      reference: item.reference || null,
      status: 'pending' as const,
      createdAt: now,
      updatedAt: now,
    };
  });
  // Reserve the run under the daily limit: one business's runners take this lock one after the other, each counting what the
  // earlier ones have set aside, so two runs working different schedules cannot both pass a limit that fits only one.
  const businessLimits = await currentLimits(d.db, d.orgId, d.now);
  const cap = effectiveDailyCap((await dailyCapOf(d.db, d.orgId)).capMinor, businessLimits);
  const reserved = await withLock(d.db, `scheduled-cap|${d.orgId}`, async (tx) => {
    const used = await autoPaidSince(tx, d.orgId, new Date(now.getTime() - 24 * 3_600_000));
    if (used + checked.totalMinor + checked.feeMinor > cap) return 'over_cap' as const;
    // The same for the business's monthly limit: the last 30 days, counting what the runs before this one have set aside.
    const usedMonth = await autoPaidSince(tx, d.orgId, new Date(now.getTime() - MONTHLY_WINDOW_MS));
    if (usedMonth + checked.totalMinor + checked.feeMinor > businessLimits.monthly) return 'over_month' as const;
    // From here the run is the owners' allowance paying: a Skip or a pause moves it, and the payments below look first.
    const moved = await moveRun(tx, d.orgId, run.id, { status: 'approved', ranAs: 'auto', fallback: false, reasonCode: null, reason: null, itemCount: checked.rows.length, totalMinor: checked.totalMinor, feeMinor: checked.feeMinor, updatedAt: now }, ['scheduled']);
    if (!moved) return null;
    await insertRunPayments(tx, payments);
    return moved;
  });
  if (reserved === 'over_cap') return prepareApproval(d, sch, run, { code: 'daily_cap', text: fallbackWords('daily_cap') });
  if (reserved === 'over_month') return prepareApproval(d, sch, run, { code: 'monthly_limit', text: fallbackWords('monthly_limit') });
  if (!reserved) return 0;
  const started = reserved;
  let notices = 0;
  if (await stampNotice(d.db, d.orgId, started.id, 'noticeRunningAt', now)) {
    await tell(d, 'running', sch, started);
    notices += 1;
  }
  for (const row of await listRunPayments(d.db, d.orgId, started.id)) {
    if (row.status !== 'pending') continue;
    const outcome = await payOne(d, sch, started, checked, row);
    if (outcome === 'paid') continue;
    // One that did not go out ends the run: the rest are not sent after it. (An unknown outcome waits to be read back.)
    if (outcome !== 'unknown') {
      for (const rest of await listRunPayments(d.db, d.orgId, started.id)) {
        if (rest.status === 'pending') await finishPayment(d.db, d.orgId, rest.id, { status: 'failed', error: 'An earlier payment in this run did not go out, so this one was not sent.', now: d.now() }, ['pending']);
      }
    }
    break;
  }
  return notices + (await settleAuto(d, started.id));
}

type PayOutcome = 'paid' | 'failed' | 'unknown' | 'stopped';

/** Is the run still allowed to pay? Read fresh before every payment: a Skip, a Stop and the kill switch all take effect at once. */
async function stillAllowed(d: ScheduleDeps, sch: ScheduleRow, run: RunRow): Promise<string | null> {
  const [current, fresh, settings] = await Promise.all([getRun(d.db, d.orgId, run.id), getSchedule(d.db, d.orgId, sch.id), getSettings(d.db, d.orgId)]);
  if (!current || current.status !== 'approved') return 'The run was skipped before this payment went out.';
  if (current.startsAt && current.startsAt.getTime() > d.now().getTime()) return 'The run’s warning window has not ended, so this payment was not sent.';
  if (!fresh || fresh.status === 'stopped' || fresh.status === 'deleted') return 'The schedule was stopped before this payment went out.';
  if (settings?.autoPaused) return 'Automatic payments were paused before this payment went out.';
  if (fresh.mode !== 'auto') return 'The schedule was switched to “Ask me first” before this payment went out.';
  return null;
}

async function payOne(d: ScheduleDeps, sch: ScheduleRow, run: RunRow, checked: CheckedRun, row: RunPaymentRow): Promise<PayOutcome> {
  const now = () => d.now();
  const stop = async (reason: string): Promise<PayOutcome> => {
    await finishPayment(d.db, d.orgId, row.id, { status: 'failed', error: reason, now: now() }, ['pending']);
    return 'stopped';
  };
  const failRow = async (error: string): Promise<PayOutcome> => {
    await finishPayment(d.db, d.orgId, row.id, { status: 'failed', error, now: now() }, ['pending', 'submitting']);
    return 'failed';
  };

  const notAllowed = await stillAllowed(d, sch, run);
  if (notAllowed) return stop(notAllowed);

  // The fee is the fee that was checked and shown: a rise since is refused, never paid.
  const fee = await d.splashFee({ kind: row.feeKind, principalMinor: row.amountMinor });
  if (fee.feeMinor > row.maxFeeMinor) return failRow('Splash’s fee rose after the run was checked, so this payment was not sent.');

  const sc = checked.sc;
  const sponsor = sc.wallet.signing.sponsor;
  if (!sponsor) return failRow('No gas sponsor is configured, so this payment was not sent.');
  // The allowance, the policy and the running totals are read again for each payment: the previous one has been counted.
  const read = await readStaffRule(sc, { addresses: [checked.payer.address] });
  if (!read.ok || !read.read.allowance || !read.read.policy || read.read.spender !== normalizeSuiAddress(checked.payer.address)) {
    return failRow('The allowance could not be read from the network just before this payment, so it was not sent.');
  }
  const payer = await businessName(d);
  // The record says who set the schedule up (an owner: an automatic schedule is only made by one), when this payment was built, the allowance the
  // chain showed just now, and which owners can approve. The allowance is the approval; there is no per-payment signature to record.
  const trail = await buildPaymentTrail(d.db, { orgId: d.orgId, actor: { userId: sch.createdBy, role: 'OWNER' }, route: 'scheduled_auto', rule: read.read.facts.rule, spender: read.read.spender, at: now() });
  const record = await d.paymentRecord({ orgId: d.orgId, transferId: row.id, payer, payee: row.payeeName, amountMinor: row.amountMinor.toString(), maxFeeMinor: row.maxFeeMinor.toString(), reference: row.reference, trail });
  if (!record.ok) return failRow(record.error);

  const at = now();
  const gas = await sponsor.gasFor();
  const expiresAtMs = BigInt(at.getTime()) + BigInt(TRANSFER_INTENT_LIFETIME_MS);
  const settleByMs = BigInt(at.getTime() + AUTO_SETTLE_WINDOW_MS);
  const commitment = sha(JSON.stringify(['splash-scheduled-commitment', d.orgId, row.id, row.address, row.amountMinor.toString(), row.maxFeeMinor.toString(), 1]));
  let bytes: Uint8Array;
  try {
    bytes = await staffRulePaymentTx(sc.chain, {
      spender: checked.payer.address,
      account: sc.wallet.account,
      policy: read.read.policy,
      allowance: { objectId: read.read.allowance.objectId, initialSharedVersion: read.read.allowance.initialSharedVersion },
      funder: read.read.allowance.funder,
      paymentRef: new Uint8Array(Buffer.from(row.paymentRef, 'hex')),
      recipient: row.address,
      amountMinor: row.amountMinor,
      targetCurrency: 'USDC',
      fxRateUsdLocal: 1_000_000n,
      commitment: new Uint8Array(commitment),
      railCommitment: new Uint8Array(sha('splash-transfer-rail|1')),
      expiresAtMs,
      maxFeeMinor: row.maxFeeMinor,
      settleByMs,
      contentHash: record.contentHash,
      walrusBlobId: record.walrusBlobId,
      gas,
    });
  } catch (error) {
    return failRow(error instanceof Error ? error.message : 'the payment could not be built');
  }

  // The bytes are read back and held to exactly this payment, by the same rules a staff member's own payment is.
  const stored = { policyId: read.read.policy.objectId, allowanceId: read.read.allowance.objectId, funder: read.read.allowance.funder };
  let digest: string;
  let gasBudget: bigint;
  try {
    const description = describeWalletTransaction(bytes, { ...sc.wallet.signing.expect, staffPay: stored });
    if (description.sender !== normalizeSuiAddress(checked.payer.address)) throw new WalletTxRefused('the payment is not sent by the scheduled payer', 'wrong_sender');
    assertPurposeShape('staff_rule_payment', description, {
      staffPayment: { spender: checked.payer.address, recipient: row.address, amountMinor: row.amountMinor, maxFeeMinor: row.maxFeeMinor, policyId: stored.policyId, allowanceId: stored.allowanceId },
    });
    assertSponsorable(description, { sponsor: sponsor.address, senders: [checked.payer.address] });
    gasBudget = BigInt(description.gas.budget);
    const used = await sponsoredBudgetSince(d.db, d.orgId, new Date(at.getTime() - 24 * 3_600_000));
    if (used + gasBudget > (sc.wallet.signing.sponsorDailyBudgetMist ?? WALLET_SPONSOR_DAILY_BUDGET_MIST)) {
      return failRow('This business has used its network-fee allowance for the last 24 hours, so this payment was not sent.');
    }
    digest = description.digest;
  } catch (error) {
    if (error instanceof WalletTxRefused || error instanceof SponsorRefused) return failRow(`The payment did not match what was approved, so it was not sent: ${error.message}`);
    throw error;
  }

  const simulated = await sc.wallet.signing.chain.simulate(bytes);
  if (!simulated.success) return failRow(`The network's dry run refused this payment, so it was not sent: ${simulated.error ?? 'it would fail'}.`);

  // One caller sends it, once. The digest is written first, so a crash after this is read back from the chain, never sent again.
  // (The network-fee allowance is checked again under the claim's lock, so two payments of one business cannot both pass the last of it.)
  const feeAllowance = sc.wallet.signing.sponsorDailyBudgetMist ?? WALLET_SPONSOR_DAILY_BUDGET_MIST;
  const claimed = await claimPayment(d.db, d.orgId, row.id, { digest, gasBudgetMist: gasBudget, now: at }, async (tx) => (await sponsoredBudgetSince(tx, d.orgId, new Date(at.getTime() - 24 * 3_600_000))) + gasBudget <= feeAllowance);
  if (claimed === 'refused') return failRow('This business has used its network-fee allowance for the last 24 hours, so this payment was not sent.');
  if (!claimed) return 'stopped';

  let result: { digest: string; success: boolean; error?: string | null };
  try {
    if (checked.payer.kind === 'sandbox') {
      // The sandbox payer signs nothing on a network, and is not reachable in production.
      if (isProductionRuntime(d.env ?? process.env)) throw new Error('a sandbox payer cannot pay in production');
      result = { digest: `sandbox:${digest}`, success: true };
    } else {
      const senderSignature = await checked.payer.sign(bytes);
      const sponsorSignature = await sponsor.sign(bytes);
      try {
        result = await sc.wallet.signing.chain.execute(bytes, [senderSignature, sponsorSignature]);
      } catch {
        // The network did not answer: the bytes may have landed. Ask; if it has not seen them, the outcome is unknown, not failed.
        const seen = sc.wallet.signing.chain.read ? await sc.wallet.signing.chain.read(digest).catch(() => null) : null;
        if (!seen) return 'unknown';
        result = seen;
      }
    }
  } catch (error) {
    // Nothing was submitted (the key could not sign, or a sandbox payer was refused): the payment did not go out.
    await finishPayment(d.db, d.orgId, row.id, { status: 'failed', error: error instanceof Error ? error.message : 'the payment could not be signed', now: now() });
    return 'failed';
  }
  if (result.success) {
    await finishPayment(d.db, d.orgId, row.id, { status: 'paid', digest: result.digest || digest, now: now() });
    return 'paid';
  }
  await finishPayment(d.db, d.orgId, row.id, { status: 'failed', digest: result.digest || digest, error: `The network refused it: ${result.error ?? 'it failed'}.`, now: now() });
  return 'failed';
}

// ─── Mode B: settling the run ───────────────────────────────────────────────

/** Read back the payments whose outcome was unknown, and close the run when every payment has ended. */
async function followAuto(d: ScheduleDeps, runId: string): Promise<number> {
  const now = d.now();
  const run = await getRun(d.db, d.orgId, runId);
  if (!run || run.status !== 'approved' || run.ranAs !== 'auto') return 0;
  const sc = await spendOf(d);
  for (const p of await listRunPayments(d.db, d.orgId, run.id)) {
    if (p.status === 'submitting' && p.attemptedAt && now.getTime() - p.attemptedAt.getTime() >= SUBMIT_LEASE_MS && p.digest) {
      const chain = sc?.wallet.signing.chain;
      if (p.digest.startsWith('sandbox:')) continue;
      const seen = chain?.read ? await chain.read(p.digest).catch(() => null) : null;
      if (seen) await finishPayment(d.db, d.orgId, p.id, { status: seen.success ? 'paid' : 'failed', digest: seen.digest || p.digest, error: seen.success ? null : `The network refused it: ${seen.error ?? 'it failed'}.`, now });
      else if (now.getTime() - p.attemptedAt.getTime() >= SUBMIT_GIVE_UP_MS) {
        await finishPayment(d.db, d.orgId, p.id, { status: 'failed', error: 'It never reached the network and can no longer, so nothing was paid.', now });
      }
    }
    // A payment still pending after Splash stopped working on the run is not sent late.
    if (p.status === 'pending' && now.getTime() - run.updatedAt.getTime() >= RUN_CLAIM_LEASE_MS) {
      await finishPayment(d.db, d.orgId, p.id, { status: 'failed', error: 'Splash stopped before sending this payment, so it was not sent late. Nothing was paid for it.', now }, ['pending']);
    }
  }
  return settleAuto(d, run.id);
}

async function settleAuto(d: ScheduleDeps, runId: string): Promise<number> {
  const now = d.now();
  const run = await getRun(d.db, d.orgId, runId);
  if (!run || run.status !== 'approved') return 0;
  const sch = await getSchedule(d.db, d.orgId, run.scheduleId);
  if (!sch) return 0;
  const payments = await listRunPayments(d.db, d.orgId, run.id);
  if (payments.some((p) => p.status === 'pending' || p.status === 'submitting')) return 0;
  const paid = payments.filter((p) => p.status === 'paid');
  if (paid.length === payments.length && payments.length > 0) {
    const done = await moveRun(d.db, d.orgId, run.id, { status: 'paid', updatedAt: now }, ['approved']);
    if (done && (await stampNotice(d.db, d.orgId, done.id, 'noticeReceiptAt', now))) {
      await tell(d, 'paid', sch, done, { reason: null });
      return 1;
    }
    return 0;
  }
  const firstError = payments.find((p) => p.status === 'failed')?.error ?? 'It could not be completed.';
  const reason =
    paid.length === 0
      ? `Nothing was paid. ${firstError}`
      : `${paid.length} of ${payments.length} payments went out, and the rest did not. Nothing was paid twice. ${firstError} Pay the rest from Transfer.`;
  const failed = await moveRun(d.db, d.orgId, run.id, { status: 'failed', reasonCode: 'payment_failed', reason, updatedAt: now }, ['approved']);
  if (!failed) return 0;
  await tell(d, 'failed', sch, failed, { reason });
  return 1;
}
