/**
 * How a business's limits start (v2 Phase 3, Sky's decision): the three answers a business gives, the proposal worked
 * out from them (lib/limits/start.ts), and what is done with it.
 *
 *   A NEW business (no limits yet) is STARTED at its proposal, once: three rows in business_limits, source 'starting',
 *   written by `system:onboarding`, each with a line on the trail. A business that already has limits (every business
 *   that existed before the starting figures, by migration 0086) is never changed by answering: the answers are saved
 *   so Splash staff can see them and the owner can see what a new business like theirs would start at, and the owner
 *   can ask for it with "Ask for higher limits", which is the ordinary request to Splash.
 *
 *   The answers are the owner's own words about their business. They are checked (lib/limits/start.ts), kept at most 40
 *   characters, shown only as text, and NEVER written to the trail or any log; a refused answer is not echoed back.
 *
 * Every function takes the business and the person from the caller (the session, in the routes) and reads and writes
 * only that business. Saving twice with the same answers saves once; two saves at the same moment start the limits once.
 * Nothing here moves money.
 */
import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { businessLimitAnswers, businessLimits } from '../db/schema.ts';
import { DEFAULT_LIMITS, limitInputValue, type LimitKind } from '../limits/rules.ts';
import { START_KINDS, proposeStart, type AnswerProblems, type StartKind } from '../limits/start.ts';
import { answersOf, currentLimits, proposalOf, readStartWire, requestHigherLimit, valuesOf, type LimitFailure, type RequestWire, type StartWire } from './business-limits.ts';
import { inTransaction, teamManager } from './team-admin.ts';
import { recordAuthorityEvent } from './wallet-authority.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

type Clock = () => Date;
const clock = (now?: Clock) => (now ?? (() => new Date()))();
const fail = (status: number, code: string, error: string, details?: Record<string, unknown>): LimitFailure => ({ ok: false, status, code, error, ...(details ? { details } : {}) });

/** The reason on a request made from the answers: a sentence with no figure in it, so none of the answers are copied into a request or the trail. */
export const ASK_FROM_ANSWERS_REASON = 'These are the limits worked out from the answers we gave when we set up our business.';

/**
 * Should the setup page ask this business the three questions? Only a business that has answered nothing and has no
 * limits yet: a new business. A business that already runs is not asked there; it can answer from the Limits screen.
 */
export async function limitAnswersNeeded(db: DrizzleDb, orgId: string): Promise<boolean> {
  if (await answersOf(db, orgId)) return false;
  const rows = await db.select({ kind: businessLimits.kind }).from(businessLimits).where(eq(businessLimits.orgId, orgId)).limit(1);
  return rows.length === 0;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type SaveAnswersInput = { orgId: string; actorUserId: string; answers: unknown; now?: Clock };

/**
 * Save the answers with the proposal, and start a new business at it. Owners only. A refused answer saves nothing and
 * is said in words, per answer, without repeating what was typed.
 */
export async function saveLimitAnswers(db: DrizzleDb, input: SaveAnswersInput): Promise<{ ok: true; applied: boolean; replayed: boolean; start: StartWire } | (LimitFailure & { details?: { problems?: AnswerProblems } })> {
  const manager = await teamManager(db, input.orgId, input.actorUserId);
  if (manager !== 'owner') {
    return manager === 'finance_lead'
      ? fail(403, 'owner_only', 'Only an owner can tell Splash how the business will use it.')
      : fail(403, 'not_allowed', 'Only an owner can tell Splash how the business will use it.');
  }
  const proposal = proposeStart(isRecord(input.answers) ? input.answers : {});
  if (!proposal.ok) return fail(400, 'bad_answers', 'One or more answers could not be used. Nothing was saved.', { problems: proposal.problems });
  const at = clock(input.now);

  return inTransaction(db, async (tx) => {
    const values = {
      monthlyText: proposal.texts.monthlyUsdc,
      perWeekText: proposal.texts.paymentsPerWeek,
      firstText: proposal.texts.firstTransferUsdc,
      monthlyMinor: proposal.parsed.monthlyMinor,
      perWeek: proposal.parsed.paymentsPerWeek,
      firstMinor: proposal.parsed.firstTransferMinor,
      proposedPerPayment: proposal.limits.per_payment,
      proposedDaily: proposal.limits.daily,
      proposedMonthly: proposal.limits.monthly,
      wantedPerPayment: proposal.wanted.per_payment,
      wantedDaily: proposal.wanted.daily,
      wantedMonthly: proposal.wanted.monthly,
      formulaVersion: proposal.formulaVersion,
    };
    let row = await answersOf(tx, input.orgId);
    let replayed = false;
    const same = (r: typeof businessLimitAnswers.$inferSelect) =>
      r.monthlyText === values.monthlyText && r.perWeekText === values.perWeekText && r.firstText === values.firstText && r.formulaVersion === values.formulaVersion;
    if (row && same(row)) {
      replayed = true;
    } else if (row) {
      const [updated] = await tx.update(businessLimitAnswers).set({ ...values, version: row.version + 1, answeredBy: input.actorUserId, updatedAt: at }).where(eq(businessLimitAnswers.id, row.id)).returning();
      row = updated;
      await recordAuthorityEvent(tx, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'limit_answers_saved', ref: row.id, detail: { version: row.version, first: false }, now: () => at });
    } else {
      const id = `bla_${randomUUID()}`;
      const [created] = await tx
        .insert(businessLimitAnswers)
        .values({ id, orgId: input.orgId, ...values, version: 1, answeredBy: input.actorUserId, createdAt: at, updatedAt: at })
        .onConflictDoNothing()
        .returning();
      if (created) {
        row = created;
        await recordAuthorityEvent(tx, { orgId: input.orgId, actorUserId: input.actorUserId, action: 'limit_answers_saved', ref: row.id, detail: { version: 1, first: true }, now: () => at });
      } else {
        // Another save got there first: it is the same save when the answers are the same.
        row = await answersOf(tx, input.orgId);
        if (!row) return fail(500, 'unreadable', 'The answers could not be saved. Nothing was changed.');
        replayed = same(row);
      }
    }
    if (!row) return fail(500, 'unreadable', 'The answers could not be saved. Nothing was changed.');

    // Start a new business at the proposal, once. A business that already has limits keeps them.
    if (row.appliedAt == null) {
      const have = await tx.select({ kind: businessLimits.kind }).from(businessLimits).where(eq(businessLimits.orgId, input.orgId)).limit(1);
      if (have.length === 0) {
        const [claim] = await tx
          .update(businessLimitAnswers)
          .set({ appliedAt: at, updatedAt: at })
          .where(and(eq(businessLimitAnswers.id, row.id), eq(businessLimitAnswers.version, row.version)))
          .returning();
        if (claim) {
          row = claim;
          const proposed = proposalOf(claim);
          for (const kind of START_KINDS) {
            const value = proposed.limits[kind];
            const [written] = await tx
              .insert(businessLimits)
              .values({ orgId: input.orgId, kind, value, source: 'starting', changedBy: 'system:onboarding', requestId: null, heldMax: value, updatedAt: at })
              .onConflictDoNothing()
              .returning({ kind: businessLimits.kind });
            if (written) {
              await recordAuthorityEvent(tx, {
                orgId: input.orgId,
                actorUserId: 'system:onboarding',
                action: 'limit_change_applied',
                ref: claim.id,
                detail: { kind, before: DEFAULT_LIMITS[kind].toString(), after: value.toString(), because: 'a new business starts at the figures worked out from its answers' },
                now: () => at,
              });
            }
          }
        }
      }
    }
    const start = await readStartWire(tx, input.orgId, 'owner');
    return { ok: true as const, applied: start.applied, replayed, start };
  });
}

export type AskedFromAnswers = { kind: StartKind; request: RequestWire; replayed: boolean };
export type SkippedFromAnswers = { kind: StartKind; why: 'fits' | 'restore' | 'open' | 'refused'; error?: string };

/**
 * "Ask for higher limits": one request to Splash for each limit the answers asked for more than the business has, on the
 * ordinary request path (an owner asks, Splash staff decide, a 24 hour notice). The figures come from the answers stored
 * for the business, never from the request; the reason is a sentence with none of the answers in it; each request is keyed
 * by the answers and their version, so a double click or a second tab asks once, and new answers are a new ask.
 */
export async function askForHigherFromAnswers(db: DrizzleDb, input: { orgId: string; actorUserId: string; now?: Clock }): Promise<{ ok: true; asked: AskedFromAnswers[]; skipped: SkippedFromAnswers[] } | LimitFailure> {
  const manager = await teamManager(db, input.orgId, input.actorUserId);
  if (manager !== 'owner') {
    return manager === 'finance_lead' ? fail(403, 'owner_only', 'Only an owner can ask Splash for higher limits.') : fail(403, 'not_allowed', 'Only an owner can ask Splash for higher limits.');
  }
  const answers = await answersOf(db, input.orgId);
  if (!answers) return fail(409, 'no_answers', 'Tell us how you will use Splash first, and we can ask for limits to match.');
  const at = clock(input.now);
  await currentLimits(db, input.orgId, () => at);
  const { values, held } = await valuesOf(db, input.orgId);
  const proposal = proposalOf(answers);
  const asked: AskedFromAnswers[] = [];
  const skipped: SkippedFromAnswers[] = [];
  for (const kind of START_KINDS) {
    const wanted = proposal.wanted[kind];
    if (wanted <= values[kind]) {
      skipped.push({ kind, why: 'fits' });
      continue;
    }
    if (wanted <= held[kind]) {
      skipped.push({ kind, why: 'restore' });
      continue;
    }
    const result = await requestHigherLimit(db, {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      kind,
      requested: limitInputValue(kind as LimitKind, wanted),
      reason: ASK_FROM_ANSWERS_REASON,
      requestKey: `start-${answers.id}-v${answers.version}-${kind}`,
      now: () => at,
    });
    if (result.ok) asked.push({ kind, request: result.request, replayed: result.replayed });
    else if (result.code === 'already_open') skipped.push({ kind, why: 'open' });
    else skipped.push({ kind, why: 'refused', error: result.error });
  }
  return { ok: true, asked, skipped };
}
