/**
 * When nobody who can approve answers (v2 Phase 3, p3-no-approver; Sky's question).
 *
 * What "waiting" is: a signing request that is collecting signatures (a payment the rules send to the
 * owners, a second approval above the line, a batch, a withdrawal, an automatic run handed back to "ask
 * me first", whose batch is a signing request), or an ask a staff member made to the owners that is still
 * open. Both have their own end already (a signing request's `expires_at`, 24 hours at most and sooner when
 * its quote ends; an ask's `expires_at`, the payment's own). This module never moves, extends or shortens
 * that end, and it can approve nothing: Splash holds no key to a business wallet, a timer does not sign,
 * and a notice is words and one link that signs nothing.
 *
 *   The ladder   `sweepApprovalWaitsForStaff` (the existing /api/cron/wallet-signing calls it) finds every
 *                waiting request and sends the step it is due: asked (0), reminder_10m, reminder_1h,
 *                reminder_4h (lib/approve/wait.ts holds the timing). Each step is ONE row in
 *                approval_wait_steps (the primary key is kind + request id + step) written in the same
 *                transaction as the notices of that step, so the cron running twice, two instances and a
 *                retry send a step once. An injected clock drives it in tests; there is no timer.
 *   The lapse    a request past its end that nobody approved gets one `lapsed` step: the person who asked
 *                and the owners are told "Nobody approved in time. Nothing was paid. Ask again." and one
 *                trail line is written. A late approval is refused with the same words (wallet-signing.ts,
 *                payment-approval-asks.ts).
 *   By hand      `remindNow` (the person who asked, or an owner, once per REMIND_NOW_COOLDOWN_MS per
 *                request). Cancelling is the existing withdraw: DELETE /api/wallet/signing-requests/:id
 *                and POST /api/wallet/approval-asks/:id { action: 'withdraw' }.
 *   Who is told  only people who are still members of THAT business and can still approve it: signers who
 *                have not signed or declined (a person who left, or a member of another business, is never
 *                told), or the owners for an ask. Every read takes the business; the cron's cross-tenant
 *                reads say so in their name (`*ForStaff`).
 *   The words    never an amount, a payee, an address or a secret (lib/approve/wait.ts). Logs carry an id
 *                and the kind of failure, never a name or a figure.
 *   E-mail       claimed before it is sent (`sending`), at most MAX_EMAIL_ATTEMPTS tries, through the same
 *                transport as every other Splash e-mail. With no usable transport (production without one)
 *                the notice stays in the app and the e-mail waits: nothing is sent from a console in
 *                production and nothing is invented.
 */
import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or } from 'drizzle-orm';

import { resolveEmailTransport, type EmailTransport } from '../auth/email-transport.ts';
import { approvalNotices, approvalWaitSteps, memberships, passkeyCredentials, users, walletApprovalAsks, walletSigningRequests, walletSigningSigners } from '../db/schema.ts';
import { APPROVE_PATH, LAPSE_NOTICE_WINDOW_MS, TELLS_REQUESTER, askerIsReminded, MINUTE_MS, NOTICE_SHOWN_MS, REMIND_NOW_COOLDOWN_MS, askedNotice, lapseNotice, manualNotice, reminderNotice, requesterNotice, stepToSend, utcWhen, whatIsWaiting, type LadderStep, type WaitKind, type WaitStep } from '../approve/wait.ts';
import { approveLink, approveInboxLink, approvePath } from '../approve/link.ts';
import { memberLabel } from '../team/member-title.ts';
import { memberRole, recordAuthorityEvent } from './wallet-authority.ts';
import type { SigningNotifier } from './wallet-signing.ts';
import { liveCards, type DrizzleDb } from './wallet-signing-store.ts';

export type WaitFailure = { ok: false; status: number; code: string; error: string };
const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): WaitFailure & Record<string, unknown> => ({ ok: false, status, code, error, ...extra });
type Clock = () => Date;

/** E-mail tries per notice: the first, and two more if the provider refused or did not answer. */
export const MAX_EMAIL_ATTEMPTS = 3;
/** An e-mail claimed this long ago by a run that died may be claimed again. */
export const EMAIL_LEASE_MS = 10 * MINUTE_MS;
/** A notice older than this is not e-mailed any more: it is stale news. The app still shows it. */
export const EMAIL_MAX_AGE_MS = 48 * 60 * MINUTE_MS;
/** The most e-mails one pass sends. */
const EMAIL_BATCH = 200;

/** One waiting (or lately ended) request, as the ladder sees it. */
export type WaitSubject = {
  kind: WaitKind;
  id: string;
  orgId: string;
  purpose: string | null;
  requestedBy: string;
  createdAt: Date;
  expiresAt: Date;
  /** open: still collecting before its end. lapsed: its end passed and nobody approved. closed: anything else. */
  state: 'open' | 'lapsed' | 'closed';
  /** The people who can still approve it and are still members of this business, in a stable order. */
  approvers: string[];
  /**
   * Whether anyone but the person who made it is asked to sign. A staff payment under their own rule, or a move of
   * their own USDC, is signed by its maker alone: nobody else is waited on, so the ladder and the lapse stay out of it.
   */
  waitsOnOthers: boolean;
};

// ─── Reading what waits ─────────────────────────────────────────────────────

async function ownersOf(db: DrizzleDb, orgId: string): Promise<string[]> {
  const rows = await db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'admin')));
  return rows.map((r) => r.userId).sort();
}

async function signingSubject(db: DrizzleDb, row: typeof walletSigningRequests.$inferSelect, now: Date): Promise<WaitSubject> {
  const signers = await db.select().from(walletSigningSigners).where(eq(walletSigningSigners.requestId, row.id));
  const pending = signers.filter((s) => s.signedAt === null && s.declinedAt === null).map((s) => s.userId);
  const cards = await liveCards(db, row.orgId, pending);
  const approvers = pending.filter((u) => cards.has(u)).sort();
  const past = row.expiresAt.getTime() <= now.getTime();
  const state = row.status === 'expired' || (row.status === 'collecting' && past) ? 'lapsed' : row.status === 'collecting' ? 'open' : 'closed';
  return { kind: 'signing', id: row.id, orgId: row.orgId, purpose: row.purpose, requestedBy: row.requestedBy, createdAt: row.createdAt, expiresAt: row.expiresAt, state, approvers, waitsOnOthers: signers.some((s) => s.userId !== row.requestedBy) };
}

async function askSubject(db: DrizzleDb, row: typeof walletApprovalAsks.$inferSelect, now: Date): Promise<WaitSubject> {
  const owners = (await ownersOf(db, row.orgId)).filter((u) => u !== row.requestedBy);
  const past = row.expiresAt.getTime() <= now.getTime();
  const state = row.status === 'open' ? (past ? 'lapsed' : 'open') : row.status === 'expired' ? 'lapsed' : 'closed';
  return { kind: 'ask', id: row.id, orgId: row.orgId, purpose: null, requestedBy: row.requestedBy, createdAt: row.createdAt, expiresAt: row.expiresAt, state, approvers: owners, waitsOnOthers: true };
}

/** One request of this business, or null. Another business's id reads as absent. */
export async function loadSubject(db: DrizzleDb, orgId: string, kind: WaitKind, id: string, now: Date): Promise<WaitSubject | null> {
  if (kind === 'signing') {
    const [row] = await db.select().from(walletSigningRequests).where(and(eq(walletSigningRequests.orgId, orgId), eq(walletSigningRequests.id, id))).limit(1);
    return row ? signingSubject(db, row, now) : null;
  }
  const [row] = await db.select().from(walletApprovalAsks).where(and(eq(walletApprovalAsks.orgId, orgId), eq(walletApprovalAsks.id, id))).limit(1);
  return row ? askSubject(db, row, now) : null;
}

/** Every request in every business still waiting before its end. A cron's read, cross-tenant by design. */
export async function openSubjectsForStaff(db: DrizzleDb, now: Date): Promise<WaitSubject[]> {
  const signing = await db.select().from(walletSigningRequests).where(and(eq(walletSigningRequests.status, 'collecting'), gt(walletSigningRequests.expiresAt, now))).orderBy(asc(walletSigningRequests.createdAt));
  const asks = await db.select().from(walletApprovalAsks).where(and(eq(walletApprovalAsks.status, 'open'), gt(walletApprovalAsks.expiresAt, now))).orderBy(asc(walletApprovalAsks.createdAt));
  return [...(await Promise.all(signing.map((r) => signingSubject(db, r, now)))), ...(await Promise.all(asks.map((r) => askSubject(db, r, now))))];
}

/** Every request that ended lately with nobody approving it. A cron's read, cross-tenant by design. */
export async function lapsedSubjectsForStaff(db: DrizzleDb, now: Date): Promise<WaitSubject[]> {
  const since = new Date(now.getTime() - LAPSE_NOTICE_WINDOW_MS);
  const signing = await db
    .select()
    .from(walletSigningRequests)
    .where(and(inArray(walletSigningRequests.status, ['collecting', 'expired']), lte(walletSigningRequests.expiresAt, now), gte(walletSigningRequests.expiresAt, since)))
    .orderBy(asc(walletSigningRequests.expiresAt));
  const asks = await db
    .select()
    .from(walletApprovalAsks)
    .where(and(eq(walletApprovalAsks.status, 'open'), lte(walletApprovalAsks.expiresAt, now), gte(walletApprovalAsks.expiresAt, since)))
    .orderBy(asc(walletApprovalAsks.expiresAt));
  return [...(await Promise.all(signing.map((r) => signingSubject(db, r, now)))), ...(await Promise.all(asks.map((r) => askSubject(db, r, now))))];
}

async function stepsDone(db: DrizzleDb, s: Pick<WaitSubject, 'kind' | 'id' | 'orgId'>): Promise<Set<string>> {
  const rows = await db
    .select({ step: approvalWaitSteps.step })
    .from(approvalWaitSteps)
    .where(and(eq(approvalWaitSteps.orgId, s.orgId), eq(approvalWaitSteps.subjectKind, s.kind), eq(approvalWaitSteps.subjectId, s.id)));
  return new Set(rows.map((r) => r.step));
}

const pathOf = (s: Pick<WaitSubject, 'kind' | 'id'>) => (s.kind === 'signing' ? (approvePath(s.id) ?? APPROVE_PATH) : APPROVE_PATH);

// ─── Writing a step ─────────────────────────────────────────────────────────

type Recipient = { userId: string; audience: 'approver' | 'requester' | 'owner'; title: string; body: string };

/**
 * Record one step and its notices in ONE transaction. The step row is the idempotency key: when it already
 * exists nothing is written and `false` comes back. A lapse also writes its trail line here, so the line
 * and the step are one fact. Reminders by hand write theirs too.
 */
async function recordStep(
  db: DrizzleDb,
  s: Pick<WaitSubject, 'kind' | 'id' | 'orgId'>,
  step: WaitStep,
  recipients: Recipient[],
  now: Date,
  trail?: { actorUserId: string; action: 'approval_lapsed' | 'approval_reminded'; detail: Record<string, unknown> },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as DrizzleDb;
    const inserted = await t
      .insert(approvalWaitSteps)
      .values({ subjectKind: s.kind, subjectId: s.id, step, orgId: s.orgId, createdAt: now })
      .onConflictDoNothing()
      .returning({ step: approvalWaitSteps.step });
    if (inserted.length === 0) return false;
    if (recipients.length > 0) {
      await t
        .insert(approvalNotices)
        .values(
          recipients.map((r) => ({
            id: `apn_${randomUUID()}`,
            orgId: s.orgId,
            subjectKind: s.kind,
            subjectId: s.id,
            step,
            userId: r.userId,
            audience: r.audience,
            title: r.title,
            body: r.body,
            linkPath: pathOf(s),
            createdAt: now,
          })),
        )
        .onConflictDoNothing();
    }
    if (trail) {
      await recordAuthorityEvent(t, { orgId: s.orgId, actorUserId: trail.actorUserId, action: trail.action, ref: s.id, detail: { kind: s.kind, ...trail.detail }, now: () => now });
    }
    return true;
  });
}

async function factsOf(db: DrizzleDb, s: WaitSubject) {
  const cards = await liveCards(db, s.orgId, [s.requestedBy, ...s.approvers]);
  const asker = cards.get(s.requestedBy);
  return {
    cards,
    facts: { kind: s.kind, purpose: s.purpose, requester: asker ? memberLabel({ name: asker.name, title: asker.title }) : null, expiresAt: s.expiresAt },
  };
}

const labelOf = (cards: Map<string, { name: string; title: string }>, userId: string) => {
  const c = cards.get(userId);
  return c ? memberLabel({ name: c.name, title: c.title }) : 'a member of your team';
};

/** Send the step a waiting request is due, if any. Returns the step sent, or null. */
export async function sendDueStep(db: DrizzleDb, s: WaitSubject, now: Date): Promise<LadderStep | null> {
  if (s.state !== 'open' || !s.waitsOnOthers) return null;
  const step = stepToSend(now.getTime() - s.createdAt.getTime(), await stepsDone(db, s));
  if (step === null) return null;
  const { cards, facts } = await factsOf(db, s);
  // The person who asked is in the app already: they are not told "needs your approval" about their own request,
  // and at 10 minutes they get their own notice instead.
  const others = s.approvers.filter((u) => u !== s.requestedBy);
  const approverIds = askerIsReminded(step) ? s.approvers : others;
  const words = step === 'asked' ? askedNotice(facts) : reminderNotice(facts, step);
  const recipients: Recipient[] = approverIds.map((userId) => ({ userId, audience: 'approver', ...words }));
  if (step === TELLS_REQUESTER && cards.has(s.requestedBy)) {
    recipients.push({ userId: s.requestedBy, audience: 'requester', ...requesterNotice(facts, others.map((u) => labelOf(cards, u))) });
  }
  const written = await recordStep(db, s, step, recipients, now);
  return written ? step : null;
}

/** Send the lapse of an ended request, once: to the person who asked and to the owners. */
export async function sendLapse(db: DrizzleDb, s: WaitSubject, now: Date): Promise<boolean> {
  if (s.state !== 'lapsed' || !s.waitsOnOthers) return false;
  if (Date.parse(s.expiresAt.toISOString()) < now.getTime() - LAPSE_NOTICE_WINDOW_MS) return false;
  const owners = await ownersOf(db, s.orgId);
  const cards = await liveCards(db, s.orgId, [s.requestedBy, ...owners]);
  const facts = { kind: s.kind, purpose: s.purpose, requester: null, expiresAt: s.expiresAt };
  const words = lapseNotice(facts);
  const people = new Map<string, Recipient['audience']>();
  if (cards.has(s.requestedBy)) people.set(s.requestedBy, 'requester');
  for (const o of owners) if (!people.has(o)) people.set(o, 'owner');
  const recipients: Recipient[] = [...people].map(([userId, audience]) => ({ userId, audience, ...words }));
  return recordStep(db, s, 'lapsed', recipients, now, { actorUserId: 'system:approval_lapse', action: 'approval_lapsed', detail: { expiresAt: s.expiresAt.toISOString() } });
}

// ─── E-mail ─────────────────────────────────────────────────────────────────

export type WaitMail = Pick<EmailTransport, 'sendMessage'>;
export type WaitDeps = {
  now?: Clock;
  /** The sender (default: the one every other Splash e-mail uses). Null: none, and nothing is e-mailed. */
  mail?: WaitMail | null;
  appUrl?: string;
  env?: { NODE_ENV?: string } & NodeJS.ProcessEnv;
};

function mailOf(deps: WaitDeps): WaitMail | null {
  if (deps.mail !== undefined) return deps.mail;
  try {
    return resolveEmailTransport(deps.env ?? process.env);
  } catch {
    // No usable sender here (production without one): the notices stay in the app and the e-mail waits.
    return null;
  }
}

/**
 * E-mail the notices that have not gone out. A notice is claimed (`sending`) with one conditional UPDATE
 * before it is sent, so two runs cannot both send it; a failed one is tried again up to MAX_EMAIL_ATTEMPTS
 * times; a sent one never. Never throws.
 */
export async function deliverNoticeEmails(db: DrizzleDb, deps: WaitDeps, filter?: { orgId: string; subjectKind: WaitKind; subjectId: string }): Promise<{ sent: number; failed: number; skipped: number }> {
  const out = { sent: 0, failed: 0, skipped: 0 };
  const now = (deps.now ?? (() => new Date()))();
  const mail = mailOf(deps);
  let rows;
  try {
    rows = await db
      .select({ n: approvalNotices, email: users.email })
      .from(approvalNotices)
      .innerJoin(users, eq(users.id, approvalNotices.userId))
      .where(
        and(
          gte(approvalNotices.createdAt, new Date(now.getTime() - EMAIL_MAX_AGE_MS)),
          or(
            and(inArray(approvalNotices.emailState, ['pending', 'failed']), lt(approvalNotices.emailAttempts, MAX_EMAIL_ATTEMPTS)),
            and(eq(approvalNotices.emailState, 'sending'), lte(approvalNotices.emailClaimedAt, new Date(now.getTime() - EMAIL_LEASE_MS))),
          ),
          ...(filter ? [eq(approvalNotices.orgId, filter.orgId), eq(approvalNotices.subjectKind, filter.subjectKind), eq(approvalNotices.subjectId, filter.subjectId)] : []),
        ),
      )
      .orderBy(asc(approvalNotices.createdAt))
      .limit(EMAIL_BATCH);
  } catch {
    return out;
  }
  const env = deps.env ?? process.env;
  for (const { n, email } of rows) {
    if (!mail) {
      out.skipped += 1;
      continue;
    }
    if (!email || !email.trim()) {
      await db.update(approvalNotices).set({ emailState: 'failed', emailAttempts: MAX_EMAIL_ATTEMPTS }).where(eq(approvalNotices.id, n.id));
      out.failed += 1;
      continue;
    }
    const claimed = await db
      .update(approvalNotices)
      .set({ emailState: 'sending', emailAttempts: n.emailAttempts + 1, emailClaimedAt: now })
      .where(and(eq(approvalNotices.id, n.id), eq(approvalNotices.emailState, n.emailState), eq(approvalNotices.emailAttempts, n.emailAttempts)))
      .returning({ id: approvalNotices.id });
    if (claimed.length === 0) continue;
    const link = n.subjectKind === 'signing' ? approveLink(deps.appUrl ?? process.env.NEXT_PUBLIC_APP_URL, n.subjectId, env) : approveInboxLink(deps.appUrl ?? process.env.NEXT_PUBLIC_APP_URL, env);
    const text = link
      ? `${n.body}\n\nOpen it in Splash. You will be asked to sign in first, and nothing happens from the link alone:\n\n${link}`
      : `${n.body}\n\nOpen Splash, sign in and go to Approve. Nothing happens from this message alone.`;
    try {
      await mail.sendMessage({ to: email, subject: n.title, text, ...(link ? { link } : {}), idempotencyKey: `splash-approval-${n.id}-${n.emailAttempts + 1}` });
      await db.update(approvalNotices).set({ emailState: 'sent', emailSentAt: now }).where(eq(approvalNotices.id, n.id));
      out.sent += 1;
    } catch (error) {
      // An id and the kind of failure, never a name, an address or a figure.
      console.warn(`[approval-wait] e-mail for notice ${n.id} did not go: ${error instanceof Error ? error.name : 'error'}`);
      await db.update(approvalNotices).set({ emailState: 'failed' }).where(eq(approvalNotices.id, n.id));
      out.failed += 1;
    }
  }
  return out;
}

// ─── The sweep ──────────────────────────────────────────────────────────────

export type WaitSweep = { steps: Array<{ kind: WaitKind; step: LadderStep }>; lapsed: number; emails: { sent: number; failed: number; skipped: number }; errors: number };

/**
 * One pass over every business: the step each waiting request is due, the lapse of each one that ended, and
 * the e-mails. Run by the existing cron; running it twice at the same moment, or again, writes nothing twice.
 * One request that cannot be read never stops the others.
 */
export async function sweepApprovalWaitsForStaff(db: DrizzleDb, deps: WaitDeps = {}): Promise<WaitSweep> {
  const now = (deps.now ?? (() => new Date()))();
  const result: WaitSweep = { steps: [], lapsed: 0, emails: { sent: 0, failed: 0, skipped: 0 }, errors: 0 };
  let open: WaitSubject[] = [];
  let ended: WaitSubject[] = [];
  try {
    [open, ended] = await Promise.all([openSubjectsForStaff(db, now), lapsedSubjectsForStaff(db, now)]);
  } catch {
    result.errors += 1;
    return result;
  }
  for (const s of open) {
    try {
      const step = await sendDueStep(db, s, now);
      if (step) result.steps.push({ kind: s.kind, step });
    } catch {
      result.errors += 1;
    }
  }
  for (const s of ended) {
    try {
      if (await sendLapse(db, s, now)) result.lapsed += 1;
    } catch {
      result.errors += 1;
    }
  }
  result.emails = await deliverNoticeEmails(db, { ...deps, now: () => now });
  return result;
}

/**
 * Tell a request's approvers now (step 0), right after it is made, instead of at the next pass of the cron.
 * The same function the cron runs, for one request of this business: if the step was sent already it writes
 * nothing. Never throws.
 */
export async function tellApproversNow(db: DrizzleDb, input: { orgId: string; kind: WaitKind; id: string }, deps: WaitDeps = {}): Promise<LadderStep | null> {
  const now = (deps.now ?? (() => new Date()))();
  try {
    const subject = await loadSubject(db, input.orgId, input.kind, input.id, now);
    if (!subject) return null;
    const step = await sendDueStep(db, subject, now);
    await deliverNoticeEmails(db, { ...deps, now: () => now }, { orgId: input.orgId, subjectKind: input.kind, subjectId: input.id });
    return step;
  } catch {
    return null;
  }
}

/**
 * The signing layer's hook for the ladder: step 0 right after a request is made, so its approvers are told at once
 * and not at the next pass of the cron. It tells in the app and by e-mail; the WhatsApp message the signing layer
 * already sends is separate and unchanged. Never throws, and reports no delivery of its own.
 */
export function approvalWaitNotifier(db: DrizzleDb, deps: WaitDeps = {}): SigningNotifier {
  return {
    async notify({ orgId, request, now }) {
      await tellApproversNow(db, { orgId, kind: 'signing', id: request.id }, { ...deps, now: () => now });
      return { delivered: [], unreachable: [] };
    },
  };
}

// ─── Remind them now ────────────────────────────────────────────────────────

/**
 * "Remind them now": the person who asked, or an owner, tells everyone who can still approve it, once per
 * REMIND_NOW_COOLDOWN_MS per request. Of two presses at once one wins (the step is a primary key) and the
 * other is told to wait. A request that has run out cannot be reminded: it says so in the lapse words.
 */
export async function remindNow(
  db: DrizzleDb,
  deps: WaitDeps,
  input: { orgId: string; userId: string; kind: WaitKind; id: string },
): Promise<{ ok: true; reminded: number; nextAt: string } | (WaitFailure & Record<string, unknown>)> {
  const now = (deps.now ?? (() => new Date()))();
  const s = await loadSubject(db, input.orgId, input.kind, input.id, now);
  const role = await memberRole(db, input.orgId, input.userId);
  if (!s || role === null) return fail(404, 'not_found', 'There is no such request.');
  const isOwner = role === 'admin';
  const asker = s.requestedBy === input.userId;
  if (!isOwner && !asker) {
    // Someone who is neither the person who asked nor an owner: a signer knows it exists, anyone else does not.
    return s.approvers.includes(input.userId) ? fail(403, 'not_allowed', 'Only the person who asked, or an owner, can remind the approvers.') : fail(404, 'not_found', 'There is no such request.');
  }
  if (s.state === 'lapsed') return fail(409, 'lapsed', 'Nobody approved in time. Nothing was paid. Ask again.');
  if (s.state !== 'open' || !s.waitsOnOthers) return fail(409, 'not_open', 'This request is not waiting for anyone else to approve it.');

  const done = await stepsDone(db, s);
  const manual = [...done].filter((x) => x.startsWith('manual_')).map((x) => Number(x.slice(7)));
  const last = manual.length === 0 ? null : await lastManualAt(db, s);
  if (last && now.getTime() - last.getTime() < REMIND_NOW_COOLDOWN_MS) {
    const nextAt = new Date(last.getTime() + REMIND_NOW_COOLDOWN_MS);
    return fail(429, 'too_soon', `You reminded them a moment ago. You can remind them again at ${utcWhen(nextAt)}.`, { retryAfterSec: Math.max(1, Math.ceil((nextAt.getTime() - now.getTime()) / 1000)), nextAt: nextAt.toISOString() });
  }
  const { cards, facts } = await factsOf(db, s);
  const others = s.approvers.filter((u) => u !== input.userId);
  const words = manualNotice(facts, labelOf(cards, input.userId));
  const recipients: Recipient[] = others.map((userId) => ({ userId, audience: 'approver', ...words }));
  const n = Math.max(0, ...manual) + 1;
  const written = await recordStep(db, s, `manual_${n}`, recipients, now, { actorUserId: input.userId, action: 'approval_reminded', detail: { reminded: others.length } });
  if (!written) {
    const nextAt = new Date(now.getTime() + REMIND_NOW_COOLDOWN_MS);
    return fail(429, 'too_soon', `They were just reminded. You can remind them again at ${utcWhen(nextAt)}.`, { retryAfterSec: Math.ceil(REMIND_NOW_COOLDOWN_MS / 1000), nextAt: nextAt.toISOString() });
  }
  await deliverNoticeEmails(db, { ...deps, now: () => now }, { orgId: s.orgId, subjectKind: s.kind, subjectId: s.id });
  return { ok: true, reminded: recipients.length, nextAt: new Date(now.getTime() + REMIND_NOW_COOLDOWN_MS).toISOString() };
}

async function lastManualAt(db: DrizzleDb, s: Pick<WaitSubject, 'kind' | 'id' | 'orgId'>): Promise<Date | null> {
  const rows = await db
    .select({ at: approvalWaitSteps.createdAt, step: approvalWaitSteps.step })
    .from(approvalWaitSteps)
    .where(and(eq(approvalWaitSteps.orgId, s.orgId), eq(approvalWaitSteps.subjectKind, s.kind), eq(approvalWaitSteps.subjectId, s.id)))
    .orderBy(desc(approvalWaitSteps.createdAt));
  return rows.find((r) => r.step.startsWith('manual_'))?.at ?? null;
}

// ─── What the Approve page shows ────────────────────────────────────────────

export type WaitingView = {
  kind: WaitKind;
  id: string;
  /** "a payment from the business wallet": what is waiting, without an amount or a payee. */
  what: string;
  /** "You", or the person's name and title. */
  askedBy: string;
  /** Who can still approve it, by name and title. */
  waitingOn: string[];
  /** Nobody has signed or declined yet. */
  nobodyAnswered: boolean;
  expiresAt: string;
  canRemind: boolean;
  /** When "Remind them now" may be used again, or null when it may be used now. */
  remindAt: string | null;
  canCancel: boolean;
  linkPath: string;
};

export type NoticeView = { id: string; title: string; body: string; linkPath: string; createdAt: string; step: string; kind: WaitKind; subjectId: string };

/**
 * What this person is waiting on, and what they have been told, in THEIR business. The person who asked sees
 * their own requests; an owner sees every open one in the business. Another business's rows are never read.
 */
export async function waitingFor(db: DrizzleDb, deps: WaitDeps, input: { orgId: string; userId: string }): Promise<{ waiting: WaitingView[]; notices: NoticeView[] }> {
  const now = (deps.now ?? (() => new Date()))();
  const role = await memberRole(db, input.orgId, input.userId);
  if (role === null) return { waiting: [], notices: [] };
  const owner = role === 'admin';
  const signing = await db
    .select()
    .from(walletSigningRequests)
    .where(and(eq(walletSigningRequests.orgId, input.orgId), eq(walletSigningRequests.status, 'collecting'), gt(walletSigningRequests.expiresAt, now), ...(owner ? [] : [eq(walletSigningRequests.requestedBy, input.userId)])))
    .orderBy(asc(walletSigningRequests.expiresAt));
  const asks = await db
    .select()
    .from(walletApprovalAsks)
    .where(and(eq(walletApprovalAsks.orgId, input.orgId), eq(walletApprovalAsks.status, 'open'), gt(walletApprovalAsks.expiresAt, now), ...(owner ? [] : [eq(walletApprovalAsks.requestedBy, input.userId)])))
    .orderBy(asc(walletApprovalAsks.expiresAt));
  const subjects = [...(await Promise.all(signing.map((r) => signingSubject(db, r, now)))), ...(await Promise.all(asks.map((r) => askSubject(db, r, now))))];

  const waiting: WaitingView[] = [];
  for (const s of subjects) {
    if (!s.waitsOnOthers) continue;
    const asker = s.requestedBy === input.userId;
    // A request that waits for this person's own signature is in their Approve list, not here.
    if (!asker && s.approvers.includes(input.userId)) continue;
    const { cards, facts } = await factsOf(db, s);
    const last = await lastManualAt(db, s);
    const remindAt = last && now.getTime() - last.getTime() < REMIND_NOW_COOLDOWN_MS ? new Date(last.getTime() + REMIND_NOW_COOLDOWN_MS).toISOString() : null;
    const answered = s.kind === 'signing' ? await answeredCount(db, s.id) : 0;
    waiting.push({
      kind: s.kind,
      id: s.id,
      what: whatOf(facts),
      askedBy: asker ? 'You' : (facts.requester ?? 'A member of your team'),
      waitingOn: s.approvers.filter((u) => u !== s.requestedBy).map((u) => labelOf(cards, u)),
      nobodyAnswered: answered === 0,
      expiresAt: s.expiresAt.toISOString(),
      canRemind: true,
      remindAt,
      canCancel: asker,
      linkPath: pathOf(s),
    });
  }

  const since = new Date(now.getTime() - NOTICE_SHOWN_MS);
  const rows = await db
    .select()
    .from(approvalNotices)
    .where(and(eq(approvalNotices.orgId, input.orgId), eq(approvalNotices.userId, input.userId), gte(approvalNotices.createdAt, since)))
    .orderBy(desc(approvalNotices.createdAt))
    .limit(20);
  const notices: NoticeView[] = rows.map((n) => ({ id: n.id, title: n.title, body: n.body, linkPath: n.linkPath, createdAt: n.createdAt.toISOString(), step: n.step, kind: n.subjectKind as WaitKind, subjectId: n.subjectId }));
  return { waiting, notices };
}

const whatOf = (f: { kind: WaitKind; purpose?: string | null }) => whatIsWaiting(f.kind, f.purpose);

async function answeredCount(db: DrizzleDb, requestId: string): Promise<number> {
  const rows = await db.select({ signedAt: walletSigningSigners.signedAt, declinedAt: walletSigningSigners.declinedAt }).from(walletSigningSigners).where(eq(walletSigningSigners.requestId, requestId));
  return rows.filter((r) => r.signedAt !== null || r.declinedAt !== null).length;
}

// ─── Who can really approve ─────────────────────────────────────────────────

/**
 * How many people can approve payments for this business RIGHT NOW: the owners who hold a working passkey on
 * this site (`relyingPartyId`). The business wallet is signed by its owners' passkeys, so an owner with no
 * passkey, a passkey that was revoked, or a passkey for another site cannot sign, and a member of any other
 * role does not sign wallet payments at all. Counting members would say three where one can sign.
 */
export async function approverCountOf(db: DrizzleDb, orgId: string, relyingPartyId: string): Promise<number> {
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(passkeyCredentials, eq(passkeyCredentials.userId, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'admin'), eq(passkeyCredentials.rpId, relyingPartyId), isNull(passkeyCredentials.revokedAt)));
  return new Set(rows.map((r) => r.userId)).size;
}
