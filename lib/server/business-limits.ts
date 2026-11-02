/**
 * A business's limits on automatic payments, and asking Splash for higher ones
 * (v2 Phase 3, Sky's decision). The words and the figures are lib/limits/rules.ts;
 * this is the part that reads and writes them.
 *
 *   Owner      asks for a higher limit (a figure and a reason), cancels a request
 *              until it starts, and lowers a limit at once. Nothing is asked to
 *              lower. Lowering a limit also cancels any request still open for it,
 *              so a limit an owner just lowered is never raised behind their back.
 *   Finance lead  sees the limits and the requests. Asks for nothing: the limits
 *              belong with the spending policy, which stays with owners.
 *   Splash staff  (compliance or operations; support is refused) approve a request,
 *              approve a smaller figure, or decline with a reason in plain words.
 *              Every decision is a line on the trail under `operator:<email>`. A grant
 *              above a large-grant line (LARGE_GRANT_LINES) takes two different people,
 *              one from each role; see decideLimitRequestForStaff.
 *
 * How a business's limits START (its answers, the proposal) is lib/server/limit-start.ts.
 *
 * An approval does not change the limit. It starts a 24 hour notice, the notice
 * Splash keeps for its own changes; the owners are told when it is approved and
 * when it starts, and any owner can cancel before then. When the notice has
 * passed, the limit changes (`applyDue`, run by every read here and by the cron),
 * in one transaction with the request's last state. Until then a pending or
 * approved request changes nothing anywhere.
 *
 * Every function takes the business from the caller (the session, in the routes)
 * and reads and writes only that business; a request of another business reads as
 * absent (404). The staff functions are cross-tenant and say so (`*ForStaff`,
 * `*ForCron`). An id is an idempotency key: asking twice with one key asks once,
 * deciding twice the same way decides once, cancelling twice cancels once. Each
 * change writes its line to the trail (wallet_authority_events) in the same
 * transaction. Nothing here moves money.
 */
import { randomUUID } from 'node:crypto';

import { and, desc, eq, gt, gte, inArray, isNull, lte, or } from 'drizzle-orm';

import { businessLimitAnswers, businessLimitRequests, businessLimits, organizations, paymentScheduleRunPayments, users } from '../db/schema.ts';
import {
  DEFAULT_LIMITS,
  LARGE_GRANT_LINES,
  LIMIT_FLOORS,
  LIMIT_KINDS,
  LIMIT_NOTICE_MS,
  LIMIT_SANITY_MAX,
  LIMIT_WORDS,
  REASON_MAX,
  askNote,
  cleanReason,
  effectiveAtMs,
  formatLimit,
  grantProblems,
  isLimitKind,
  lowerProblems,
  needsTwoApprovals,
  parseLimitValue,
  raiseProblems,
  reasonProblems,
  restoreProblems,
  requestPhase,
  requestSentence,
  DECLINE_REASON_MIN,
  type LimitKind,
  type LimitValues,
  type RequestPhase,
  type RequestStatus,
} from '../limits/rules.ts';
import { START_KINDS, proposalFromStored, startWhy, startWords, type StartKind } from '../limits/start.ts';
import { limitNoticeText, LIMITS_PATH, type LimitNotice } from '../limits/notice.ts';
import { dayMonthYearWords } from '../schedule/rules.ts';
import { inTransaction, teamManager } from './team-admin.ts';
import { recordAuthorityEvent } from './wallet-authority.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

type Clock = () => Date;
const clock = (now?: Clock) => (now ?? (() => new Date()))();

export type LimitFailure = { ok: false; status: number; code: string; error: string; details?: Record<string, unknown> };
const fail = (status: number, code: string, error: string, details?: Record<string, unknown>): LimitFailure => ({ ok: false, status, code, error, ...(details ? { details } : {}) });

/** Splash staff roles that may decide a request. Support does not: this is a risk decision, and support's console is for customers' questions. */
export const LIMIT_DECIDER_ROLES = ['compliance', 'operations'] as const;
export type StaffActor = { email: string; role: string };
const isDecider = (role: string) => (LIMIT_DECIDER_ROLES as readonly string[]).includes(role);

const KEY = /^[A-Za-z0-9_.:-]{8,100}$/;

type RequestRow = typeof businessLimitRequests.$inferSelect;

// ─── What the limits are now ────────────────────────────────────────────────

/**
 * The standard limits, with any change the business has made or Splash has approved and that has started. `held` is the
 * highest figure the business has legitimately held for each limit (never below the standard or the limit now): an owner
 * puts a limit they lowered back up to it at once.
 */
export async function valuesOf(db: DrizzleDb, orgId: string): Promise<{ values: LimitValues; held: LimitValues; rows: Map<LimitKind, typeof businessLimits.$inferSelect> }> {
  const rows = await db.select().from(businessLimits).where(eq(businessLimits.orgId, orgId));
  const values: LimitValues = { ...DEFAULT_LIMITS };
  const held: LimitValues = { ...DEFAULT_LIMITS };
  const byKind = new Map<LimitKind, typeof businessLimits.$inferSelect>();
  for (const r of rows) {
    if (!isLimitKind(r.kind)) continue;
    // A stored figure past the sanity maximum is never believed.
    const max = LIMIT_SANITY_MAX[r.kind];
    values[r.kind] = r.value > max ? max : r.value;
    let top = r.heldMax > max ? max : r.heldMax;
    // What a business has held is never below what it has now. It is NOT lifted to the starting figure: a business that
    // started lower, or that ran on less before, does not get to put a limit back to a figure it never held.
    if (top < values[r.kind]) top = values[r.kind];
    held[r.kind] = top;
    byKind.set(r.kind, r);
  }
  return { values, held, rows: byKind };
}

/**
 * Make real every approved increase whose notice has passed. Idempotent and safe to
 * run from anywhere at once: a request is applied by the one statement that moves it
 * from `approved` to `applied`, and only the winner writes the limit.
 */
async function applyDue(db: DrizzleDb, orgId: string | null, now: Date): Promise<number> {
  const where = orgId == null
    ? and(eq(businessLimitRequests.status, 'approved'), lte(businessLimitRequests.effectiveAt, now))
    : and(eq(businessLimitRequests.orgId, orgId), eq(businessLimitRequests.status, 'approved'), lte(businessLimitRequests.effectiveAt, now));
  const due = await db.select({ id: businessLimitRequests.id }).from(businessLimitRequests).where(where);
  let applied = 0;
  for (const { id } of due) {
    const did = await inTransaction(db, async (tx) => {
      const [r] = await tx
        .update(businessLimitRequests)
        .set({ status: 'applied', appliedAt: now, updatedAt: now })
        .where(and(eq(businessLimitRequests.id, id), eq(businessLimitRequests.status, 'approved'), lte(businessLimitRequests.effectiveAt, now)))
        .returning();
      if (!r || !isLimitKind(r.kind) || r.grantedValue == null) return false;
      const kind = r.kind;
      const now0 = await valuesOf(tx, r.orgId);
      const before = now0.values[kind];
      // Defence in depth: never past the sanity maximum, never lower than the business already has.
      let value = r.grantedValue > LIMIT_SANITY_MAX[kind] ? LIMIT_SANITY_MAX[kind] : r.grantedValue;
      if (value < before) value = before;
      // What the business has now held at most: it can put the limit back to this after lowering it.
      const heldMax = value > now0.held[kind] ? value : now0.held[kind];
      await tx
        .insert(businessLimits)
        .values({ orgId: r.orgId, kind, value, source: 'raised', changedBy: 'system:limits', requestId: r.id, heldMax, updatedAt: now })
        .onConflictDoUpdate({ target: [businessLimits.orgId, businessLimits.kind], set: { value, source: 'raised', changedBy: 'system:limits', requestId: r.id, heldMax, updatedAt: now } });
      await recordAuthorityEvent(tx, {
        orgId: r.orgId,
        actorUserId: 'system:limits',
        action: 'limit_change_applied',
        ref: r.id,
        detail: { kind, before: before.toString(), after: value.toString(), approvedBy: r.decidedBy, ...(r.firstApprovedBy ? { firstApprovedBy: r.firstApprovedBy } : {}) },
        now: () => now,
      });
      return true;
    });
    if (did) applied += 1;
  }
  return applied;
}

/**
 * The limits that hold for this business right now. Every place a limit is enforced
 * reads them here. A request that is pending, or approved and still inside its notice,
 * has changed nothing.
 */
export async function currentLimits(db: DrizzleDb, orgId: string, now?: Clock): Promise<LimitValues> {
  const at = clock(now);
  await applyDue(db, orgId, at);
  return (await valuesOf(db, orgId)).values;
}

// ─── What an owner sees ─────────────────────────────────────────────────────

export type RequestWire = {
  id: string;
  kind: LimitKind;
  phase: RequestPhase;
  requested: string;
  requestedWords: string;
  granted: string | null;
  grantedWords: string | null;
  reason: string;
  declineReason: string | null;
  requestedAt: string;
  decidedAt: string | null;
  effectiveAt: string | null;
  /** True while an owner can still cancel it. */
  cancellable: boolean;
  /** One sentence in plain words. */
  says: string;
};

export type LimitWire = {
  kind: LimitKind;
  label: string;
  says: string;
  unit: 'usdc' | 'days';
  current: string;
  currentWords: string;
  standard: string;
  standardWords: string;
  floor: string;
  /** A true ceiling, only for the length of an allowance (a year); null for an amount, which has none (Splash decides on request). */
  ceiling: string | null;
  ceilingWords: string | null;
  /** What the request sheet says about how much can be asked for, in place of a ceiling. */
  askNote: string;
  /** The highest figure the business has held for this limit: an owner can put the limit back up to it at once. */
  held: string;
  heldWords: string;
  /** True for an owner when the limit is below what the business has held, so there is something to put back. */
  canRestore: boolean;
  /** standard (the starting figure); starting (worked out from the owners' answers); raised (Splash approved it); kept (the business ran on it before the starting figures); lowered or restored (an owner). */
  source: 'standard' | 'starting' | 'raised' | 'kept' | 'lowered' | 'restored';
  /** Why the limit is what it is, in plain words. */
  why: string;
  /** The request still open for this limit, if any. */
  open: RequestWire | null;
  /** The last request that ended, if any, so a decline is not missed. */
  last: RequestWire | null;
};

/** How this business's limits started, in the owner's own terms (the answers and the proposal), or the chance to answer. */
export type StartWire = {
  /** True once the business has given its answers. */
  answered: boolean;
  /** True when an owner can answer now: the business has not answered yet. */
  ask: boolean;
  /** True when the business was started at the proposal (a new business); false when it already ran on limits. */
  applied: boolean;
  /** "We started you at ... because you told us ...", or what a new business like it would be started at. Null until answered. */
  headline: string | null;
  /** Said when the answers asked for more than the starting figures. */
  capped: string | null;
  /** True for an owner when "Ask for higher limits" has something to ask for. */
  canAskHigher: boolean;
  /** The answers as the owner wrote them. */
  answers: { monthlyText: string; perWeekText: string; firstText: string } | null;
  proposal: Record<StartKind, string> | null;
  wanted: Record<StartKind, string> | null;
};

export type LimitsWire = { canAsk: boolean; manager: 'owner' | 'finance_lead'; limits: LimitWire[]; start: StartWire };

type AnswersRow = typeof businessLimitAnswers.$inferSelect;

/** The proposal behind a business's stored answers. */
export function proposalOf(row: AnswersRow) {
  return proposalFromStored({
    monthlyMinor: row.monthlyMinor,
    paymentsPerWeek: row.perWeek,
    firstTransferMinor: row.firstMinor,
    texts: { monthlyUsdc: row.monthlyText, paymentsPerWeek: row.perWeekText, firstTransferUsdc: row.firstText },
    proposed: { per_payment: row.proposedPerPayment, daily: row.proposedDaily, monthly: row.proposedMonthly },
    wanted: { per_payment: row.wantedPerPayment, daily: row.wantedDaily, monthly: row.wantedMonthly },
    formulaVersion: row.formulaVersion,
  });
}

export async function answersOf(db: DrizzleDb, orgId: string): Promise<AnswersRow | null> {
  const [row] = await db.select().from(businessLimitAnswers).where(eq(businessLimitAnswers.orgId, orgId)).limit(1);
  return row ?? null;
}

function requestWire(r: RequestRow, current: bigint, nowMs: number): RequestWire | null {
  if (!isLimitKind(r.kind)) return null;
  const facts = { status: r.status as RequestStatus, requestedValue: r.requestedValue, grantedValue: r.grantedValue, effectiveAtMs: r.effectiveAt?.getTime() ?? null, declineReason: r.declineReason };
  const phase = requestPhase(facts, nowMs);
  return {
    id: r.id,
    kind: r.kind,
    phase,
    requested: r.requestedValue.toString(),
    requestedWords: formatLimit(r.kind, r.requestedValue),
    granted: r.grantedValue?.toString() ?? null,
    grantedWords: r.grantedValue != null ? formatLimit(r.kind, r.grantedValue) : null,
    reason: r.reason,
    declineReason: r.declineReason,
    requestedAt: r.requestedAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    effectiveAt: r.effectiveAt?.toISOString() ?? null,
    cancellable: phase === 'asked' || phase === 'waiting',
    says: requestSentence(r.kind, facts, current, nowMs),
  };
}

function whyWords(kind: LimitKind, source: LimitWire['source'], changedAt: Date | null, held: bigint, current: bigint, answers: AnswersRow | null): string {
  const date = changedAt ? ` on ${dayMonthYearWords(changedAt.getTime())}` : '';
  const start = formatLimit(kind, DEFAULT_LIMITS[kind]);
  if (source === 'starting' && answers && kind !== 'days') return startWhy(proposalOf(answers), kind as StartKind);
  if (source === 'raised') return `Splash approved a higher limit${date}, because you asked for it.`;
  if (source === 'kept') return `Your business already ran on this before the new starting figures, so it keeps it. A new business starts at ${start}${DEFAULT_LIMITS[kind] > current ? ', and you can ask Splash for the same' : ''}.`;
  if (source === 'lowered') return `An owner of your business lowered it${date}. You can put it back to ${formatLimit(kind, held)} at any time.`;
  if (source === 'restored') return `An owner of your business put it back${date}. The most your business has held is ${formatLimit(kind, held)}.`;
  return `This is where a new business starts, and you have told us nothing yet that would change it. It can go up or down on request.`;
}

/** The business's start, in words: the answers and the proposal, or the chance to answer. */
function startWire(manager: 'owner' | 'finance_lead', answers: AnswersRow | null, values: LimitValues, held: LimitValues, openKinds: Set<LimitKind>): StartWire {
  if (!answers) return { answered: false, ask: manager === 'owner', applied: false, headline: null, capped: null, canAskHigher: false, answers: null, proposal: null, wanted: null };
  const proposal = proposalOf(answers);
  const applied = answers.appliedAt != null;
  const words = startWords(proposal, { applied });
  const wantsMore = START_KINDS.some((kind) => proposal.wanted[kind] > values[kind] && proposal.wanted[kind] > held[kind] && !openKinds.has(kind));
  return {
    answered: true,
    ask: false,
    applied,
    headline: words.headline,
    capped: words.capped,
    canAskHigher: manager === 'owner' && wantsMore,
    answers: { monthlyText: answers.monthlyText, perWeekText: answers.perWeekText, firstText: answers.firstText },
    proposal: words.proposal,
    wanted: words.wanted,
  };
}

/** How this business's limits started, as the page shows it: for an owner or the Finance lead (`manager`). */
export async function readStartWire(db: DrizzleDb, orgId: string, manager: 'owner' | 'finance_lead'): Promise<StartWire> {
  const answers = await answersOf(db, orgId);
  const { values, held } = await valuesOf(db, orgId);
  const open = await db
    .select({ kind: businessLimitRequests.kind })
    .from(businessLimitRequests)
    .where(and(eq(businessLimitRequests.orgId, orgId), inArray(businessLimitRequests.status, ['pending', 'approved'])));
  const openKinds = new Set<LimitKind>(open.map((r: { kind: string }) => r.kind).filter(isLimitKind));
  return startWire(manager, answers, values, held, openKinds);
}

/** Owner or Finance lead: the limits, each in plain words with where it stands. Anyone else is refused. */
export async function readLimitsView(db: DrizzleDb, input: { orgId: string; userId: string; now?: Clock }): Promise<{ ok: true; view: LimitsWire } | LimitFailure> {
  const manager = await teamManager(db, input.orgId, input.userId);
  if (!manager) return fail(403, 'not_allowed', 'Only an owner or the Finance lead can see the limits.');
  const at = clock(input.now);
  await applyDue(db, input.orgId, at);
  const { values, held, rows } = await valuesOf(db, input.orgId);
  const requests = await db
    .select()
    .from(businessLimitRequests)
    .where(eq(businessLimitRequests.orgId, input.orgId))
    .orderBy(desc(businessLimitRequests.requestedAt));
  const nowMs = at.getTime();
  const answers = await answersOf(db, input.orgId);
  const limits: LimitWire[] = LIMIT_KINDS.map((kind) => {
    const stored = rows.get(kind);
    const source: LimitWire['source'] = !stored ? 'standard' : stored.source === 'starting' ? 'starting' : stored.source === 'raised' ? (stored.changedBy === 'system:migration' ? 'kept' : 'raised') : stored.source === 'restored' ? 'restored' : 'lowered';
    const mine = requests.filter((r) => r.kind === kind);
    const openRow = mine.find((r) => r.status === 'pending' || r.status === 'approved');
    const lastRow = mine.find((r) => r.status === 'declined' || r.status === 'cancelled' || r.status === 'applied');
    return {
      kind,
      label: LIMIT_WORDS[kind].label,
      says: LIMIT_WORDS[kind].says,
      unit: LIMIT_WORDS[kind].unit,
      current: values[kind].toString(),
      currentWords: formatLimit(kind, values[kind]),
      standard: DEFAULT_LIMITS[kind].toString(),
      standardWords: formatLimit(kind, DEFAULT_LIMITS[kind]),
      floor: LIMIT_FLOORS[kind].toString(),
      ceiling: kind === 'days' ? LIMIT_SANITY_MAX.days.toString() : null,
      ceilingWords: kind === 'days' ? formatLimit(kind, LIMIT_SANITY_MAX.days) : null,
      askNote: askNote(kind),
      held: held[kind].toString(),
      heldWords: formatLimit(kind, held[kind]),
      canRestore: manager === 'owner' && values[kind] < held[kind],
      source,
      why: whyWords(kind, source, stored?.updatedAt ?? null, held[kind], values[kind], answers),
      open: openRow ? requestWire(openRow, values[kind], nowMs) : null,
      last: lastRow ? requestWire(lastRow, values[kind], nowMs) : null,
    };
  });
  const openKinds = new Set<LimitKind>(limits.filter((l) => l.open).map((l) => l.kind));
  return { ok: true, view: { canAsk: manager === 'owner', manager, limits, start: startWire(manager, answers, values, held, openKinds) } };
}

// ─── An owner asks for a higher limit ───────────────────────────────────────

export type AskInput = { orgId: string; actorUserId: string; kind: unknown; requested: unknown; reason: unknown; requestKey: unknown; now?: Clock };

function samePayload(row: RequestRow, kind: LimitKind, requested: bigint, reason: string, actorUserId: string): boolean {
  return row.kind === kind && row.requestedValue === requested && row.reason === reason && row.requestedBy === actorUserId;
}

export async function requestHigherLimit(db: DrizzleDb, input: AskInput): Promise<{ ok: true; request: RequestWire; replayed: boolean } | LimitFailure> {
  const manager = await teamManager(db, input.orgId, input.actorUserId);
  if (manager !== 'owner') {
    return manager === 'finance_lead'
      ? fail(403, 'owner_only', 'Only an owner can ask Splash for a higher limit. You can see the limits and any request.')
      : fail(403, 'not_allowed', 'Only an owner can ask Splash for a higher limit.');
  }
  if (!isLimitKind(input.kind)) return fail(400, 'bad_limit', 'Say which limit you want raised.');
  const kind = input.kind;
  const key = typeof input.requestKey === 'string' ? input.requestKey.trim() : '';
  if (!KEY.test(key)) return fail(400, 'bad_key', 'The request needs an idempotency key of 8 to 100 letters, digits or - _ . :');
  const requested = parseLimitValue(kind, input.requested);
  if (requested == null) return fail(400, 'bad_figure', kind === 'days' ? 'Give a whole number of days.' : 'Give an amount in USDC, for example 3,000.');
  const reasonList = reasonProblems(input.reason);
  if (reasonList.length > 0) return fail(400, 'bad_reason', reasonList.join(' '));
  const reason = cleanReason(input.reason);
  const at = clock(input.now);

  return inTransaction(db, async (tx) => {
    await applyDue(tx, input.orgId, at);
    // The same key is the same request: a retry, a double click, a second tab.
    const [same] = await tx.select().from(businessLimitRequests).where(and(eq(businessLimitRequests.orgId, input.orgId), eq(businessLimitRequests.requestKey, key))).limit(1);
    const { values, held } = await valuesOf(tx, input.orgId);
    if (same) {
      if (!samePayload(same, kind, requested, reason, input.actorUserId)) return fail(409, 'key_reused', 'That key was used for a different request. Start the request again.');
      const wire = requestWire(same, values[kind], at.getTime());
      return wire ? { ok: true as const, request: wire, replayed: true } : fail(500, 'unreadable', 'The request could not be read.');
    }
    const problems = raiseProblems(kind, requested, values[kind]);
    if (problems.length > 0) return fail(400, 'bad_figure', problems.join(' '), { max: LIMIT_SANITY_MAX[kind].toString() });
    // A figure the business already held is not Splash's to grant again: the owner puts it back at once.
    if (requested <= held[kind]) {
      return fail(409, 'restore_instead', `Your business has held ${formatLimit(kind, held[kind])} before, so you can put it back yourself: choose Restore on this limit. There is nothing to ask Splash.`, { held: held[kind].toString() });
    }
    const id = `blr_${randomUUID()}`;
    const [row] = await tx
      .insert(businessLimitRequests)
      .values({ id, orgId: input.orgId, kind, requestedValue: requested, currentValue: values[kind], reason, requestKey: key, requestedBy: input.actorUserId, requestedAt: at, status: 'pending', createdAt: at, updatedAt: at })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      // A key or an open request got there first.
      const [again] = await tx.select().from(businessLimitRequests).where(and(eq(businessLimitRequests.orgId, input.orgId), eq(businessLimitRequests.requestKey, key))).limit(1);
      if (again && samePayload(again, kind, requested, reason, input.actorUserId)) {
        const wire = requestWire(again, values[kind], at.getTime());
        if (wire) return { ok: true as const, request: wire, replayed: true };
      }
      return fail(409, 'already_open', `You already have a request open for this limit (${LIMIT_WORDS[kind].label}). Cancel it first, or wait for Splash to answer.`);
    }
    await recordAuthorityEvent(tx, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'limit_raise_requested', ref: id, detail: { kind, current: values[kind].toString(), requested: requested.toString(), reason }, now: () => at });
    const wire = requestWire(row, values[kind], at.getTime());
    return wire ? { ok: true as const, request: wire, replayed: false } : fail(500, 'unreadable', 'The request could not be read.');
  });
}

// ─── An owner lowers a limit: at once, nothing asked ────────────────────────

export async function lowerLimit(db: DrizzleDb, input: { orgId: string; actorUserId: string; kind: unknown; value: unknown; now?: Clock }): Promise<{ ok: true; current: string; unchanged: boolean } | LimitFailure> {
  const manager = await teamManager(db, input.orgId, input.actorUserId);
  if (manager !== 'owner') return manager === 'finance_lead' ? fail(403, 'owner_only', 'Only an owner can lower a limit.') : fail(403, 'not_allowed', 'Only an owner can lower a limit.');
  if (!isLimitKind(input.kind)) return fail(400, 'bad_limit', 'Say which limit you want to lower.');
  const kind = input.kind;
  const value = parseLimitValue(kind, input.value);
  if (value == null) return fail(400, 'bad_figure', kind === 'days' ? 'Give a whole number of days.' : 'Give an amount in USDC, for example 1,500.');
  const at = clock(input.now);
  return inTransaction(db, async (tx) => {
    await applyDue(tx, input.orgId, at);
    const { values, held, rows } = await valuesOf(tx, input.orgId);
    // Lowering to the figure it was just lowered to is the same call again.
    if (values[kind] === value && rows.get(kind)?.source === 'lowered') return { ok: true as const, current: value.toString(), unchanged: true };
    const problems = lowerProblems(kind, value, values[kind]);
    if (problems.length > 0) return fail(400, 'bad_figure', problems.join(' '));
    // A request still open for this limit would raise it again later. The owner has just said they want it lower.
    const open = await tx
      .update(businessLimitRequests)
      .set({ status: 'cancelled', cancelledBy: input.actorUserId, cancelledAt: at, updatedAt: at })
      .where(and(eq(businessLimitRequests.orgId, input.orgId), eq(businessLimitRequests.kind, kind), inArray(businessLimitRequests.status, ['pending', 'approved'])))
      .returning({ id: businessLimitRequests.id });
    for (const r of open) {
      await recordAuthorityEvent(tx, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'limit_request_cancelled', ref: r.id, detail: { kind, because: 'the owner lowered the limit' }, now: () => at });
    }
    await tx
      .insert(businessLimits)
      .values({ orgId: input.orgId, kind, value, source: 'lowered', changedBy: input.actorUserId, requestId: null, heldMax: held[kind], updatedAt: at })
      .onConflictDoUpdate({ target: [businessLimits.orgId, businessLimits.kind], set: { value, source: 'lowered', changedBy: input.actorUserId, requestId: null, heldMax: held[kind], updatedAt: at } });
    await recordAuthorityEvent(tx, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'limit_lowered', detail: { kind, before: values[kind].toString(), after: value.toString(), canRestoreTo: held[kind].toString() }, now: () => at });
    return { ok: true as const, current: value.toString(), unchanged: false };
  });
}

// ─── An owner puts a lowered limit back: at once, nothing asked ──────────────

/**
 * Put a limit back up, to no more than the highest figure the business has held. An owner who lowers a limit by mistake is
 * not made to wait for Splash to give back what they had. Anything above that figure is a request, as before.
 */
export async function restoreLimit(db: DrizzleDb, input: { orgId: string; actorUserId: string; kind: unknown; value: unknown; now?: Clock }): Promise<{ ok: true; current: string; held: string } | LimitFailure> {
  const manager = await teamManager(db, input.orgId, input.actorUserId);
  if (manager !== 'owner') return manager === 'finance_lead' ? fail(403, 'owner_only', 'Only an owner can put a limit back.') : fail(403, 'not_allowed', 'Only an owner can put a limit back.');
  if (!isLimitKind(input.kind)) return fail(400, 'bad_limit', 'Say which limit you want to put back.');
  const kind = input.kind;
  const value = parseLimitValue(kind, input.value);
  if (value == null) return fail(400, 'bad_figure', kind === 'days' ? 'Give a whole number of days.' : 'Give an amount in USDC, for example 2,000.');
  const at = clock(input.now);
  return inTransaction(db, async (tx) => {
    await applyDue(tx, input.orgId, at);
    const { values, held, rows } = await valuesOf(tx, input.orgId);
    // Putting it back to the figure it was just put back to is the same call again (a double click, a second tab).
    if (values[kind] === value && rows.get(kind)?.source === 'restored') return { ok: true as const, current: value.toString(), held: held[kind].toString() };
    const problems = restoreProblems(kind, value, values[kind], held[kind]);
    if (problems.length > 0) return fail(400, value > held[kind] ? 'above_held' : 'bad_figure', problems.join(' '), { held: held[kind].toString() });
    // A request still open for a figure the limit now meets has nothing left to do; one for more than that stays.
    const open = await tx
      .select()
      .from(businessLimitRequests)
      .where(and(eq(businessLimitRequests.orgId, input.orgId), eq(businessLimitRequests.kind, kind), inArray(businessLimitRequests.status, ['pending', 'approved'])));
    for (const r of open) {
      if ((r.grantedValue ?? r.requestedValue) > value) continue;
      const [gone] = await tx
        .update(businessLimitRequests)
        .set({ status: 'cancelled', cancelledBy: input.actorUserId, cancelledAt: at, updatedAt: at })
        .where(and(eq(businessLimitRequests.id, r.id), inArray(businessLimitRequests.status, ['pending', 'approved'])))
        .returning({ id: businessLimitRequests.id });
      if (gone) await recordAuthorityEvent(tx, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'limit_request_cancelled', ref: r.id, detail: { kind, because: 'the owner put the limit back to a figure that already meets it' }, now: () => at });
    }
    await tx
      .insert(businessLimits)
      .values({ orgId: input.orgId, kind, value, source: 'restored', changedBy: input.actorUserId, requestId: null, heldMax: held[kind], updatedAt: at })
      .onConflictDoUpdate({ target: [businessLimits.orgId, businessLimits.kind], set: { value, source: 'restored', changedBy: input.actorUserId, requestId: null, heldMax: held[kind], updatedAt: at } });
    await recordAuthorityEvent(tx, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'limit_restored', detail: { kind, before: values[kind].toString(), after: value.toString(), heldMax: held[kind].toString() }, now: () => at });
    return { ok: true as const, current: value.toString(), held: held[kind].toString() };
  });
}

// ─── An owner cancels before it starts ──────────────────────────────────────

export async function cancelLimitRequest(db: DrizzleDb, input: { orgId: string; actorUserId: string; requestId: string; now?: Clock }): Promise<{ ok: true; replayed: boolean } | LimitFailure> {
  const manager = await teamManager(db, input.orgId, input.actorUserId);
  if (manager !== 'owner') return manager === 'finance_lead' ? fail(403, 'owner_only', 'Only an owner can cancel a request.') : fail(403, 'not_allowed', 'Only an owner can cancel a request.');
  const at = clock(input.now);
  return inTransaction(db, async (tx) => {
    await applyDue(tx, input.orgId, at);
    const [row] = await tx.select().from(businessLimitRequests).where(and(eq(businessLimitRequests.orgId, input.orgId), eq(businessLimitRequests.id, input.requestId))).limit(1);
    if (!row) return fail(404, 'not_found', 'That request was not found.');
    if (row.status === 'cancelled') return { ok: true as const, replayed: true };
    if (row.status === 'declined') return fail(409, 'already_decided', 'Splash already declined this request, so there is nothing to cancel.');
    if (row.status === 'applied') return fail(409, 'already_started', 'The higher limit has already started. To go back, lower the limit.');
    const [done] = await tx
      .update(businessLimitRequests)
      .set({ status: 'cancelled', cancelledBy: input.actorUserId, cancelledAt: at, updatedAt: at })
      .where(and(eq(businessLimitRequests.id, row.id), or(eq(businessLimitRequests.status, 'pending'), and(eq(businessLimitRequests.status, 'approved'), gt(businessLimitRequests.effectiveAt, at)))))
      .returning({ id: businessLimitRequests.id });
    if (!done) return fail(409, 'already_started', 'The higher limit has already started. To go back, lower the limit.');
    await recordAuthorityEvent(tx, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'limit_request_cancelled', ref: row.id, detail: { kind: row.kind, was: row.status }, now: () => at });
    return { ok: true as const, replayed: false };
  });
}

// ─── Splash staff decide ────────────────────────────────────────────────────

/** How a business has used automatic payments in the last 30 days, in words, for the person deciding. */
export type UseWire = {
  /** "the 30 days to 2 November 2026". */
  windowWords: string;
  /** Automatic payments made (paid or on their way) in that time. */
  payments: number;
  totalWords: string;
  largestWords: string;
  busiestDayWords: string;
};

export type StaffContextWire = {
  /** The business's KYB lifecycle state and what it means, in words. */
  kybState: string;
  kybStateWords: string;
  /** The tier recorded on the business, as stored; null when none is recorded. */
  kybTier: string | null;
  /** The answers the business gave and the proposal beside them; null when it has given none. */
  answers: null | {
    monthlyText: string;
    perWeekText: string;
    firstText: string;
    proposedWords: Record<StartKind, string>;
    wantedWords: Record<StartKind, string>;
    /** True when the business was started at the proposal; false when it already ran on limits. */
    startedFromAnswers: boolean;
    answeredAt: string;
  };
  use30: UseWire;
};

/** What approving this request takes, and where it stands. */
export type ApprovalsWire = {
  /** 1, or 2 when the figure (as asked, or as the first approver approved it) is above a large-grant line. */
  needed: 1 | 2;
  /** The lines above which two people are needed, in USDC minor units. */
  lines: { daily: string; monthly: string };
  /** The first approval, when there is one: `by` is the staff address. */
  first: null | { by: string; role: string; at: string; figure: string; figureWords: string };
  /** The role the second approval has to come from, once there is a first. */
  waitingFor: 'compliance' | 'operations' | null;
  /** True when the person looking is the first approver: they cannot approve it again. */
  youApprovedFirst: boolean;
};

export type StaffRequestWire = RequestWire & {
  org: { id: string; name: string };
  requestedBy: string;
  currentWords: string;
  decidedBy: string | null;
  label: string;
  /** When the request last changed hands: decided, or cancelled by the owner, or asked. The queue sorts by it. */
  settledAt: string;
  /** How many requests this business made before this one, of any limit and any answer. */
  earlierRequests: number;
  context: StaffContextWire;
  approvals: ApprovalsWire;
};

const KYB_WORDS: Record<string, string> = {
  REGISTERED: 'Not verified yet: registered, nothing submitted',
  KYB_SUBMITTED: 'Verification submitted, with the provider',
  KYB_PROVIDER_APPROVED: 'The provider approved; waiting for Splash staff',
  KYB_ADMIN_APPROVED: 'Approved by Splash staff; not yet active',
  ACTIVE: 'Verified (active)',
  REJECTED: 'Verification was declined',
  SUSPENDED: 'Suspended',
};

const THIRTY_DAYS_MS = 30 * 24 * 3_600_000;

/** A business's automatic payments over the last 30 days: how many, how much, the largest, the busiest UTC day. Payments that failed are not use. */
async function usageOf(db: DrizzleDb, orgId: string, at: Date): Promise<UseWire> {
  const since = new Date(at.getTime() - THIRTY_DAYS_MS);
  const rows: Array<{ amount: bigint; attemptedAt: Date | null }> = await db
    .select({ amount: paymentScheduleRunPayments.amountMinor, attemptedAt: paymentScheduleRunPayments.attemptedAt })
    .from(paymentScheduleRunPayments)
    .where(and(eq(paymentScheduleRunPayments.orgId, orgId), inArray(paymentScheduleRunPayments.status, ['submitting', 'paid']), gte(paymentScheduleRunPayments.attemptedAt, since), lte(paymentScheduleRunPayments.attemptedAt, at)));
  let total = 0n;
  let largest = 0n;
  const days = new Map<string, bigint>();
  for (const r of rows) {
    total += r.amount;
    if (r.amount > largest) largest = r.amount;
    const day = (r.attemptedAt ?? at).toISOString().slice(0, 10);
    days.set(day, (days.get(day) ?? 0n) + r.amount);
  }
  let busiest = 0n;
  let busiestDay = '';
  for (const [day, sum] of days) {
    if (sum > busiest) {
      busiest = sum;
      busiestDay = day;
    }
  }
  return {
    windowWords: `the 30 days to ${dayMonthYearWords(at.getTime())}`,
    payments: rows.length,
    totalWords: formatLimit('daily', total),
    largestWords: formatLimit('daily', largest),
    busiestDayWords: busiest > 0n ? `${formatLimit('daily', busiest)} on ${dayMonthYearWords(Date.parse(`${busiestDay}T00:00:00Z`))}` : formatLimit('daily', 0n),
  };
}

const ROLES = ['compliance', 'operations'] as const;
const otherRole = (role: string): 'compliance' | 'operations' => (role === 'compliance' ? 'operations' : 'compliance');
const bareEmail = (by: string | null): string => (by ?? '').replace(/^operator:/, '');
const staffId = (email: string): string => `operator:${email.trim().toLowerCase()}`;

function approvalsWire(r: RequestRow, kind: LimitKind, staff: StaffActor): ApprovalsWire {
  const basis = r.firstGrantedValue ?? r.requestedValue;
  const first = r.firstApprovedBy && r.firstApproverRole && r.firstApprovedAt && r.firstGrantedValue != null
    ? { by: bareEmail(r.firstApprovedBy), role: r.firstApproverRole, at: r.firstApprovedAt.toISOString(), figure: r.firstGrantedValue.toString(), figureWords: formatLimit(kind, r.firstGrantedValue) }
    : null;
  return {
    needed: needsTwoApprovals(kind, basis) ? 2 : 1,
    lines: { daily: LARGE_GRANT_LINES.daily.toString(), monthly: LARGE_GRANT_LINES.monthly.toString() },
    first,
    waitingFor: first && r.status === 'pending' ? otherRole(first.role) : null,
    youApprovedFirst: Boolean(r.firstApprovedBy && r.firstApprovedBy === staffId(staff.email)),
  };
}

/** The queue: every open request first (oldest first), then what was decided lately. Cross-tenant, for Splash staff. */
export async function listLimitRequestsForStaff(db: DrizzleDb, staff: StaffActor, now?: Clock): Promise<{ ok: true; open: StaffRequestWire[]; recent: StaffRequestWire[] } | LimitFailure> {
  if (!isDecider(staff.role)) return fail(403, 'role_not_allowed', 'Limit requests are for compliance and operations staff.');
  const at = clock(now);
  await applyDue(db, null, at);
  const rows = await db
    .select({ r: businessLimitRequests, orgName: organizations.name, kybTier: organizations.kybTier, kybLifecycle: organizations.kybLifecycle, askerName: users.name })
    .from(businessLimitRequests)
    .innerJoin(organizations, eq(organizations.id, businessLimitRequests.orgId))
    .leftJoin(users, eq(users.id, businessLimitRequests.requestedBy))
    .orderBy(businessLimitRequests.requestedAt);
  const out: StaffRequestWire[] = [];
  const valuesByOrg = new Map<string, LimitValues>();
  const contextByOrg = new Map<string, StaffContextWire>();
  for (const { r, orgName, kybTier, kybLifecycle, askerName } of rows) {
    if (!isLimitKind(r.kind)) continue;
    let values = valuesByOrg.get(r.orgId);
    if (!values) {
      values = (await valuesOf(db, r.orgId)).values;
      valuesByOrg.set(r.orgId, values);
    }
    let context = contextByOrg.get(r.orgId);
    if (!context) {
      const answers = await answersOf(db, r.orgId);
      const proposal = answers ? startWords(proposalOf(answers), { applied: answers.appliedAt != null }) : null;
      context = {
        kybState: kybLifecycle,
        kybStateWords: KYB_WORDS[kybLifecycle] ?? kybLifecycle,
        kybTier: kybTier ?? null,
        answers: answers && proposal
          ? { monthlyText: answers.monthlyText, perWeekText: answers.perWeekText, firstText: answers.firstText, proposedWords: proposal.proposal, wantedWords: proposal.wanted, startedFromAnswers: answers.appliedAt != null, answeredAt: answers.updatedAt.toISOString() }
          : null,
        use30: await usageOf(db, r.orgId, at),
      };
      contextByOrg.set(r.orgId, context);
    }
    const wire = requestWire(r, values[r.kind], at.getTime());
    if (!wire) continue;
    out.push({
      ...wire,
      org: { id: r.orgId, name: orgName },
      requestedBy: askerName ?? 'An owner',
      currentWords: formatLimit(r.kind, values[r.kind]),
      decidedBy: r.decidedBy,
      label: LIMIT_WORDS[r.kind].label,
      settledAt: (r.decidedAt ?? r.cancelledAt ?? r.requestedAt).toISOString(),
      earlierRequests: rows.filter((o) => o.r.orgId === r.orgId && o.r.id !== r.id && o.r.requestedAt.getTime() < r.requestedAt.getTime()).length,
      context,
      approvals: approvalsWire(r, r.kind, staff),
    });
  }
  const open = out.filter((r) => r.phase === 'asked');
  // What was answered most lately first, by when it was answered, not by when it was asked.
  const recent = out.filter((r) => r.phase !== 'asked').sort((a, b) => Date.parse(b.settledAt) - Date.parse(a.settledAt)).slice(0, 50);
  return { ok: true, open, recent };
}

export type DecideInput = { requestId: string; staff: StaffActor; action: unknown; granted?: unknown; reason?: unknown; now?: Clock };

/** `first_approval`: the first of two approvals was recorded and nothing started. `decided`: the request is decided (approved, or declined). */
export type DecideStage = 'first_approval' | 'decided';

/**
 * Approve, approve a smaller figure, or decline with a reason. Support staff are refused.
 *
 * A grant above a large-grant line (LARGE_GRANT_LINES) takes two different people, one from compliance and one from
 * operations. The first approval is recorded on the request (and the trail) and starts nothing: the request stays
 * pending, the owners are told nothing, and no notice runs. The second approval, from the other role and a different
 * person, for the same figure, decides it, and the 24 hour notice runs from then. One person never approves twice:
 * the same person again is a replay (a double click), not a second approval. Any decider can decline at any time.
 */
export async function decideLimitRequestForStaff(db: DrizzleDb, input: DecideInput): Promise<{ ok: true; request: RequestWire; replayed: boolean; stage: DecideStage } | LimitFailure> {
  if (!isDecider(input.staff.role)) return fail(403, 'role_not_allowed', 'Deciding a limit request is for compliance and operations staff.');
  const action = input.action;
  if (action !== 'approve' && action !== 'approve_smaller' && action !== 'decline') return fail(400, 'bad_action', 'Choose approve, approve a smaller figure, or decline.');
  const by = staffId(input.staff.email);
  const role = input.staff.role as (typeof ROLES)[number];
  const at = clock(input.now);

  return inTransaction(db, async (tx) => {
    const [row] = await tx.select().from(businessLimitRequests).where(eq(businessLimitRequests.id, input.requestId)).limit(1);
    if (!row || !isLimitKind(row.kind)) return fail(404, 'not_found', 'That request was not found.');
    const kind = row.kind;
    await applyDue(tx, row.orgId, at);
    const { values } = await valuesOf(tx, row.orgId);
    const wireOf = (r: RequestRow) => requestWire(r, values[kind], at.getTime());
    const done = (r: RequestRow, stage: DecideStage, replayed: boolean) => {
      const wire = wireOf(r);
      return wire ? { ok: true as const, request: wire, replayed, stage } : fail(500, 'unreadable', 'The request could not be read.');
    };

    // Decide once. The same decision again is a replay; a different one is refused, and nothing is rewritten.
    const reread = async () => (await tx.select().from(businessLimitRequests).where(eq(businessLimitRequests.id, row.id)).limit(1))[0] as RequestRow;
    const answerFor = async (r: RequestRow) => {
      if (r.status === 'pending') return null;
      const figure = action === 'approve' ? r.requestedValue : parseLimitValue(kind, input.granted);
      const sameWay =
        (action === 'decline' && r.status === 'declined' && r.decidedBy === by) ||
        (action !== 'decline' && (r.status === 'approved' || r.status === 'applied') && (r.decidedBy === by || r.firstApprovedBy === by) && r.grantedValue === figure);
      if (sameWay) return done(r, 'decided', true);
      return fail(409, 'already_decided', r.status === 'cancelled' ? 'The owner cancelled this request.' : 'This request has already been decided.');
    };
    const settled = await answerFor(row);
    if (settled) return settled;

    if (action === 'decline') {
      const reasonList = reasonProblems(input.reason, DECLINE_REASON_MIN);
      if (reasonList.length > 0) return fail(400, 'bad_reason', `Say why in plain words, so the owner can act on it. ${reasonList.join(' ')}`);
      const reason = cleanReason(input.reason);
      const [declined] = await tx
        .update(businessLimitRequests)
        .set({ status: 'declined', declineReason: reason, decidedBy: by, decidedRole: role, decidedAt: at, updatedAt: at })
        .where(and(eq(businessLimitRequests.id, row.id), eq(businessLimitRequests.status, 'pending')))
        .returning();
      if (!declined) return (await answerFor(await reread())) ?? fail(409, 'already_decided', 'This request has already been decided.');
      await recordAuthorityEvent(tx, { orgId: row.orgId, actorUserId: by, action: 'limit_request_declined', ref: row.id, detail: { kind, requested: row.requestedValue.toString(), reason, ...(row.firstApprovedBy ? { afterFirstApprovalBy: row.firstApprovedBy } : {}) }, now: () => at });
      return done(declined, 'decided', false);
    }

    let granted = row.requestedValue;
    if (action === 'approve_smaller') {
      const parsed = parseLimitValue(kind, input.granted);
      if (parsed == null) return fail(400, 'bad_figure', kind === 'days' ? 'Give a whole number of days.' : 'Give the smaller amount in USDC.');
      if (parsed >= row.requestedValue) return fail(400, 'not_smaller', `A smaller figure must be less than the ${formatLimit(kind, row.requestedValue)} asked for. To grant it as asked, choose approve.`);
      granted = parsed;
    }
    const problems = grantProblems(kind, granted, row.requestedValue, values[kind]);
    if (problems.length > 0) return fail(400, 'bad_figure', problems.join(' '), { max: LIMIT_SANITY_MAX[kind].toString() });

    const noticeFields = { status: 'approved' as const, grantedValue: granted, decidedBy: by, decidedRole: role, decidedAt: at, effectiveAt: new Date(effectiveAtMs(at.getTime())), updatedAt: at };
    const detailBase = { kind, current: values[kind].toString(), requested: row.requestedValue.toString(), granted: granted.toString(), smaller: granted < row.requestedValue, effectiveAt: noticeFields.effectiveAt.toISOString(), noticeMs: LIMIT_NOTICE_MS };

    // ── A first approval already stands: the figure is fixed, the same person is a replay, the other role decides it.
    if (row.firstApprovedBy) {
      if (row.firstGrantedValue !== granted) {
        return fail(409, 'figure_differs', `The first approver approved ${formatLimit(kind, row.firstGrantedValue ?? granted)}. Approve that figure to agree, or decline the request.`);
      }
      if (row.firstApprovedBy === by) return done(row, 'first_approval', true);
      if (role === row.firstApproverRole) {
        return fail(403, 'second_approver_role', `The first approval came from ${row.firstApproverRole} staff, so the second has to come from ${otherRole(row.firstApproverRole ?? role)} staff, and from a different person.`);
      }
      const [decided] = await tx
        .update(businessLimitRequests)
        .set(noticeFields)
        .where(and(eq(businessLimitRequests.id, row.id), eq(businessLimitRequests.status, 'pending'), eq(businessLimitRequests.firstApprovedBy, row.firstApprovedBy)))
        .returning();
      if (!decided) return (await answerFor(await reread())) ?? fail(409, 'already_decided', 'This request has already been decided.');
      await recordAuthorityEvent(tx, {
        orgId: row.orgId,
        actorUserId: by,
        action: 'limit_request_approved',
        ref: row.id,
        detail: {
          ...detailBase,
          twoApprovals: true,
          approvers: [
            { by: row.firstApprovedBy, role: row.firstApproverRole, at: row.firstApprovedAt?.toISOString() ?? null },
            { by, role, at: at.toISOString() },
          ],
        },
        now: () => at,
      });
      return done(decided, 'decided', false);
    }

    // ── A large grant with no approval yet: this is the first of two. Nothing starts.
    if (needsTwoApprovals(kind, granted)) {
      const [first] = await tx
        .update(businessLimitRequests)
        .set({ firstApprovedBy: by, firstApproverRole: role, firstApprovedAt: at, firstGrantedValue: granted, updatedAt: at })
        .where(and(eq(businessLimitRequests.id, row.id), eq(businessLimitRequests.status, 'pending'), isNull(businessLimitRequests.firstApprovedBy)))
        .returning();
      if (!first) {
        // Another person got there first: this one is the second, or a replay, or too late.
        const latest = await reread();
        if (latest.status === 'pending' && latest.firstApprovedBy && latest.firstApprovedBy !== by && latest.firstGrantedValue === granted && latest.firstApproverRole !== role) {
          const [decided] = await tx
            .update(businessLimitRequests)
            .set(noticeFields)
            .where(and(eq(businessLimitRequests.id, row.id), eq(businessLimitRequests.status, 'pending'), eq(businessLimitRequests.firstApprovedBy, latest.firstApprovedBy)))
            .returning();
          if (decided) {
            await recordAuthorityEvent(tx, {
              orgId: row.orgId,
              actorUserId: by,
              action: 'limit_request_approved',
              ref: row.id,
              detail: { ...detailBase, twoApprovals: true, approvers: [{ by: latest.firstApprovedBy, role: latest.firstApproverRole, at: latest.firstApprovedAt?.toISOString() ?? null }, { by, role, at: at.toISOString() }] },
              now: () => at,
            });
            return done(decided, 'decided', false);
          }
        }
        if (latest.status === 'pending' && latest.firstApprovedBy === by && latest.firstGrantedValue === granted) return done(latest, 'first_approval', true);
        return (await answerFor(latest)) ?? fail(409, 'already_decided', 'This request has already been decided or is waiting for a different approval. Reload the list.');
      }
      await recordAuthorityEvent(tx, {
        orgId: row.orgId,
        actorUserId: by,
        action: 'limit_request_first_approved',
        ref: row.id,
        detail: { kind, current: values[kind].toString(), requested: row.requestedValue.toString(), granted: granted.toString(), smaller: granted < row.requestedValue, role, needsSecondFrom: otherRole(role), because: 'the figure is above a large-grant line, so a second person must approve it before any notice starts' },
        now: () => at,
      });
      return done(first, 'first_approval', false);
    }

    // ── Inside the lines: one approval, and the notice starts now.
    const [approved] = await tx
      .update(businessLimitRequests)
      .set(noticeFields)
      .where(and(eq(businessLimitRequests.id, row.id), eq(businessLimitRequests.status, 'pending'), isNull(businessLimitRequests.firstApprovedBy)))
      .returning();
    if (!approved) return (await answerFor(await reread())) ?? fail(409, 'already_decided', 'This request has already been decided.');
    await recordAuthorityEvent(tx, {
      orgId: row.orgId,
      actorUserId: by,
      action: 'limit_request_approved',
      ref: row.id,
      detail: { ...detailBase, twoApprovals: false, approvers: [{ by, role, at: at.toISOString() }] },
      now: () => at,
    });
    return done(approved, 'decided', false);
  });
}

// ─── Telling the owners ─────────────────────────────────────────────────────

export type OwnerNotice = { subject: string; text: string; path: string };
/** Tell this business's owners. Answers how many it reached; never throws. */
export type NotifyOwners = (orgId: string, notice: OwnerNotice) => Promise<number>;

/**
 * Tell the owners what has happened to a request: approved (and when it starts),
 * declined (and why), and started. State-based and idempotent: each is claimed before
 * it is sent, once, and the claim is let go when no owner was reached so the next run
 * tries again. Safe to call after every decision and from the cron.
 */
export async function sendLimitNotices(db: DrizzleDb, input: { notify: NotifyOwners; now?: Clock; orgId?: string }): Promise<{ sent: number; failed: number }> {
  const at = clock(input.now);
  let sent = 0;
  let failed = 0;
  const scope = input.orgId ? eq(businessLimitRequests.orgId, input.orgId) : undefined;
  const rows: RequestRow[] = await db
    .select()
    .from(businessLimitRequests)
    .where(and(scope, or(
      and(inArray(businessLimitRequests.status, ['approved', 'applied']), isNull(businessLimitRequests.approvedNotifiedAt)),
      and(eq(businessLimitRequests.status, 'declined'), isNull(businessLimitRequests.declinedNotifiedAt)),
      and(eq(businessLimitRequests.status, 'applied'), isNull(businessLimitRequests.effectiveNotifiedAt)),
    )));

  for (const r of rows) {
    if (!isLimitKind(r.kind)) continue;
    const kind = r.kind;
    const wanted: Array<{ column: 'approvedNotifiedAt' | 'declinedNotifiedAt' | 'effectiveNotifiedAt'; notice: LimitNotice }> = [];
    const base = { limit: kind, requested: r.requestedValue, granted: r.grantedValue, before: r.currentValue, reason: r.declineReason };
    // A limit that has already started is told as started alone: "it will start" would be wrong by now, and "started" says all of it.
    if (r.status === 'applied' && !r.approvedNotifiedAt) await db.update(businessLimitRequests).set({ approvedNotifiedAt: at }).where(and(eq(businessLimitRequests.id, r.id), isNull(businessLimitRequests.approvedNotifiedAt)));
    else if (r.status === 'approved' && !r.approvedNotifiedAt) wanted.push({ column: 'approvedNotifiedAt', notice: { ...base, kind: 'approved', startsAtMs: r.effectiveAt?.getTime() ?? null } });
    if (r.status === 'declined' && !r.declinedNotifiedAt) wanted.push({ column: 'declinedNotifiedAt', notice: { ...base, kind: 'declined', startsAtMs: null } });
    if (r.status === 'applied' && !r.effectiveNotifiedAt) wanted.push({ column: 'effectiveNotifiedAt', notice: { ...base, kind: 'started', startsAtMs: r.appliedAt?.getTime() ?? r.effectiveAt?.getTime() ?? null } });
    for (const w of wanted) {
      const col = businessLimitRequests[w.column];
      const [claim] = await db.update(businessLimitRequests).set({ [w.column]: at }).where(and(eq(businessLimitRequests.id, r.id), isNull(col))).returning({ id: businessLimitRequests.id });
      if (!claim) continue;
      const words = limitNoticeText(w.notice);
      let reached = 0;
      try {
        reached = await input.notify(r.orgId, { subject: words.subject, text: words.text, path: LIMITS_PATH });
      } catch {
        reached = 0;
      }
      if (reached > 0) sent += 1;
      else {
        failed += 1;
        // Nobody was told: let the claim go so the next run tries again.
        await db.update(businessLimitRequests).set({ [w.column]: null }).where(eq(businessLimitRequests.id, r.id));
      }
    }
  }
  return { sent, failed };
}

/** What the cron does: start every approved increase whose notice has passed, then tell the owners what is due. Cross-tenant. */
export async function runLimitChangesForCron(db: DrizzleDb, input: { notify: NotifyOwners; now?: Clock }): Promise<{ applied: number; sent: number; failed: number }> {
  const at = clock(input.now);
  const applied = await applyDue(db, null, at);
  const told = await sendLimitNotices(db, { notify: input.notify, now: () => at });
  return { applied, ...told };
}

export { REASON_MAX };
