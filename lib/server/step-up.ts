import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import { and, asc, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';

import { approverChannels, memberships, stepUpCodes, users } from '@/lib/db/schema';

/**
 * Step-up approval, in the style each workspace chooses in Settings.
 *
 * ─── WHATSAPP_PASSKEY (Settings → WhatsApp approvals ON) ─────────────────────
 *   request   Splash WhatsApps a 6-digit code to a VERIFIED number, with a
 *             summary of exactly what is being approved.
 *   code      The person it was sent to types it into Splash, in THEIR OWN
 *             session: right code, right person, in time. (What it approves
 *             is checked where the approval is used — see below.)
 *   passkey   They then sign the approval with their passkey. The phone proves
 *             the channel; the passkey proves the person at the keyboard.
 *
 * ─── CLICK (WhatsApp approvals OFF) ─────────────────────────────────────────
 *   An approver clicks Approve in Splash. With "Require dual approval" on and
 *   the amount at or above the approval threshold — the same rule the fiat
 *   queue applies — it must be a different person from the one who asked:
 *   maker-checker. Otherwise a one-person business approves its own: the CEO
 *   who runs everything.
 *
 * Then, either way:
 *   consume   The payment or save it approved uses it, once.
 *
 * ─── Who approves a WhatsApp code ───────────────────────────────────────────
 * Payments go to the MAIN ADMIN: the workspace's first admin membership. A
 * settings or profile change goes to the editor's own verified number, or to
 * the main admin when the editor has none (makers and viewers cannot register
 * one). An unverified number is a number somebody typed, and receives nothing.
 *
 * ─── Why every approval is bound to a digest ────────────────────────────────
 * The approver is shown "1,000 USDC to Maria". If the approval were for "a
 * transfer", it would approve whatever transfer arrived next. So each one
 * carries the sha256 of the canonical subject, recomputed from the thing
 * actually being done when it is used: change the amount, the recipient or one
 * settings dial afterwards, and it no longer fits.
 *
 * ─── Why only a keyed hash of a code is stored ──────────────────────────────
 * A 6-digit code is a million guesses. A plain sha256 of it in a leaked table
 * is reversed in a second; an HMAC under the session secret is not.
 */

export type StepUpPurpose = 'STABLECOIN_TRANSFER' | 'FIAT_TRANSFER' | 'BATCH_PAYOUT' | 'SETTINGS_CHANGE' | 'PROFILE_CHANGE';
export type ApprovalStyle = 'WHATSAPP_PASSKEY' | 'CLICK';

/** How long a sent code can be entered, and how long a given approval stays usable. */
export const STEP_UP_TTL_MS = 10 * 60 * 1000;
export const STEP_UP_MAX_ATTEMPTS = 5;
/** WhatsApp is not a free channel, and a button can be pressed ten times. */
export const STEP_UP_RESEND_COOLDOWN_MS = 30 * 1000;

const PAYMENT_PURPOSES: ReadonlySet<StepUpPurpose> = new Set(['STABLECOIN_TRANSFER', 'FIAT_TRANSFER', 'BATCH_PAYOUT']);
const APPROVING_DB_ROLES: ReadonlySet<string> = new Set(['admin', 'checker']);

/** The style a workspace's settings select. */
export function approvalStyleOf(settings: { whatsappEnabled: boolean }): ApprovalStyle {
  return settings.whatsappEnabled ? 'WHATSAPP_PASSKEY' : 'CLICK';
}

// Structural, not nominal: node-postgres in the app, PGlite in the tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export type StepUpSender = (
  to: string,
  message: { label: string; code: string; fallbackBody: string },
) => Promise<{ sent: boolean; reason?: string }>;

export type PasskeyVerifier = (input: {
  userId: string;
  message: Uint8Array;
  signature: string;
}) => Promise<{ ok: true; credentialId: string } | { ok: false; reason: string }>;

export interface StepUpDeps {
  db: Db;
  send: StepUpSender;
  verifyPasskey: PasskeyVerifier;
  /** HMAC key for code hashes. */
  key: string;
  now?: () => number;
}

export type StepUpFailure = { ok: false; status: number; code: string; error: string };

function fail(status: number, code: string, error: string): StepUpFailure {
  return { ok: false, status, code, error };
}

// ─── Subjects ───────────────────────────────────────────────────────────────

function canonical(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** sha256 of the subject as canonical JSON: key order and bigints do not matter. */
export function subjectDigest(subject: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(subject))).digest('hex');
}

export function stepUpKey(env: NodeJS.ProcessEnv = process.env): string {
  const secret = (env.CUSTOMER_SESSION_SECRET ?? '').trim();
  if (secret) return secret;
  if (env.NODE_ENV === 'production') throw new Error('CUSTOMER_SESSION_SECRET is required to hash step-up codes');
  return 'splash-local-step-up-key';
}

function hashCode(key: string, id: string, code: string): string {
  return createHmac('sha256', key).update(`${id}:${code}`).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Enough of a number to recognise it, not enough to use it. */
export function maskNumber(e164: string): string {
  return e164.length > 7 ? `${e164.slice(0, 3)} •••• ${e164.slice(-4)}` : '••••';
}

/**
 * The exact text a passkey signs to approve. Rebuilt from the stored row on
 * the server — never taken from the client — so a signature over anything else
 * does not verify.
 */
export function passkeyApprovalMessage(row: { id: string; purpose: string; subjectId: string; subjectDigest: string }): string {
  return [
    'Splash approval',
    `Purpose: ${row.purpose}`,
    `Subject: ${row.subjectId}`,
    `Digest: ${row.subjectDigest}`,
    `Approval: ${row.id}`,
  ].join('\n');
}

// ─── Who approves ───────────────────────────────────────────────────────────

export interface ApproverTarget {
  userId: string;
  name: string;
  e164: string | null;
}

/** The workspace's first admin, and their number if they have proved it. */
export async function mainAdmin(d: Db, orgId: string): Promise<ApproverTarget | null> {
  const [row] = await d
    .select({
      userId: users.id,
      name: users.name,
      e164: approverChannels.whatsappE164,
      verifiedAt: approverChannels.verifiedAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(approverChannels, and(eq(approverChannels.userId, users.id), eq(approverChannels.orgId, memberships.orgId)))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'admin')))
    .orderBy(asc(memberships.createdAt), asc(memberships.id))
    .limit(1);
  if (!row) return null;
  return { userId: row.userId, name: row.name, e164: row.verifiedAt ? row.e164 : null };
}

async function ownVerifiedNumber(d: Db, orgId: string, userId: string): Promise<string | null> {
  const [row] = await d
    .select({ e164: approverChannels.whatsappE164, verifiedAt: approverChannels.verifiedAt })
    .from(approverChannels)
    .where(and(eq(approverChannels.orgId, orgId), eq(approverChannels.userId, userId)))
    .limit(1);
  return row?.verifiedAt ? row.e164 : null;
}

export async function resolveApprover(
  d: Db,
  input: { orgId: string; purpose: StepUpPurpose; requesterUserId: string },
): Promise<{ ok: true; approver: ApproverTarget & { e164: string } } | StepUpFailure> {
  if (!PAYMENT_PURPOSES.has(input.purpose)) {
    const own = await ownVerifiedNumber(d, input.orgId, input.requesterUserId);
    if (own) {
      const [me] = await d.select({ name: users.name }).from(users).where(eq(users.id, input.requesterUserId)).limit(1);
      return { ok: true, approver: { userId: input.requesterUserId, name: me?.name ?? 'You', e164: own } };
    }
  }
  const admin = await mainAdmin(d, input.orgId);
  if (!admin) return fail(409, 'no_admin', 'This workspace has no admin to approve it.');
  if (!admin.e164) {
    return fail(
      409,
      'admin_whatsapp_unverified',
      `${admin.name} is the main admin and has not verified a WhatsApp number yet. They can do it in Settings → Approvals; until then this cannot be approved by WhatsApp.`,
    );
  }
  return { ok: true, approver: { ...admin, e164: admin.e164 } };
}

// ─── Reading ────────────────────────────────────────────────────────────────

async function latestLive(d: Db, orgId: string, purpose: StepUpPurpose, subjectId: string) {
  const [row] = await d
    .select()
    .from(stepUpCodes)
    .where(and(
      eq(stepUpCodes.orgId, orgId),
      eq(stepUpCodes.purpose, purpose),
      eq(stepUpCodes.subjectId, subjectId),
      isNull(stepUpCodes.supersededAt),
      isNull(stepUpCodes.consumedAt),
    ))
    .orderBy(desc(stepUpCodes.createdAt))
    .limit(1);
  return row ?? null;
}

async function supersedeOpen(d: Db, input: { orgId: string; purpose: StepUpPurpose; subjectId: string }, now: number) {
  await d
    .update(stepUpCodes)
    .set({ supersededAt: new Date(now), updatedAt: new Date(now) })
    .where(and(
      eq(stepUpCodes.orgId, input.orgId),
      eq(stepUpCodes.purpose, input.purpose),
      eq(stepUpCodes.subjectId, input.subjectId),
      isNull(stepUpCodes.supersededAt),
      isNull(stepUpCodes.consumedAt),
    ));
}

const freshApproval = (row: { verifiedAt: Date | string | null }, now: number) =>
  Boolean(row.verifiedAt) && new Date(row.verifiedAt as Date).getTime() > now - STEP_UP_TTL_MS;

// ─── WHATSAPP_PASSKEY: request ──────────────────────────────────────────────

export async function requestStepUp(
  deps: StepUpDeps,
  input: {
    orgId: string;
    style: ApprovalStyle;
    requesterUserId: string;
    requesterName: string;
    purpose: StepUpPurpose;
    subjectId: string;
    subject: unknown;
    /** Short: it rides in the template's {{1}}. */
    label: string;
    /** What the approver is approving, in full, for the message and the screen. */
    summary: string;
  },
) {
  if (input.style !== 'WHATSAPP_PASSKEY') {
    return fail(400, 'click_style', 'This workspace approves by clicking Approve in Splash, so no WhatsApp code is sent. Turn on WhatsApp approvals in Settings to use codes.');
  }
  const now = deps.now?.() ?? Date.now();
  const digest = subjectDigest(input.subject);

  const resolved = await resolveApprover(deps.db, input);
  if (!resolved.ok) return resolved;
  const { approver } = resolved;

  const latest = await latestLive(deps.db, input.orgId, input.purpose, input.subjectId);
  if (latest && latest.subjectDigest === digest && freshApproval(latest, now)) {
    return { ok: true as const, alreadyApproved: true, approverName: approver.name, sentTo: maskNumber(approver.e164) };
  }
  if (latest && latest.method === 'WHATSAPP_PASSKEY' && !latest.verifiedAt && now - new Date(latest.createdAt).getTime() < STEP_UP_RESEND_COOLDOWN_MS) {
    return fail(429, 'cooldown', 'A code was just sent. Wait 30 seconds before asking for another.');
  }

  await supersedeOpen(deps.db, input, now);

  const id = `stp_${randomUUID()}`;
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(now + STEP_UP_TTL_MS);
  await deps.db.insert(stepUpCodes).values({
    id,
    orgId: input.orgId,
    method: 'WHATSAPP_PASSKEY',
    approverUserId: approver.userId,
    requestedBy: input.requesterUserId,
    purpose: input.purpose,
    subjectId: input.subjectId,
    subjectDigest: digest,
    summary: input.summary,
    codeHash: hashCode(deps.key, id, code),
    sentTo: approver.e164,
    delivered: false,
    expiresAt,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });

  const fallbackBody =
    `Splash approval code: ${code}\n\n${input.summary}\n\n` +
    `Requested by ${input.requesterName}. Enter the code in Splash, then confirm with your passkey. ` +
    'It expires in 10 minutes. Splash will never ask you for this code.';
  const delivery = await deps.send(approver.e164, { label: input.label, code, fallbackBody });
  if (delivery.sent) {
    await deps.db.update(stepUpCodes).set({ delivered: true, updatedAt: new Date(now) }).where(eq(stepUpCodes.id, id));
  }

  return {
    ok: true as const,
    alreadyApproved: false,
    id,
    approverName: approver.name,
    selfApproval: approver.userId === input.requesterUserId,
    sentTo: maskNumber(approver.e164),
    delivered: delivery.sent,
    deliveryError: delivery.sent ? null : delivery.reason ?? 'not delivered',
    expiresAt: expiresAt.toISOString(),
  };
}

// ─── WHATSAPP_PASSKEY: the code ─────────────────────────────────────────────
//
// The approver acts on the approval by its id, reading the summary that was
// stored — they may not hold the payload (a maker's profile edit reaches the
// main admin as a summary, not as the form). The digest is enforced where the
// approval is USED: the save recomputes it from what it is actually saving.

async function openApproval(d: Db, orgId: string, approvalId: string) {
  const [row] = await d
    .select()
    .from(stepUpCodes)
    .where(and(
      eq(stepUpCodes.id, approvalId),
      eq(stepUpCodes.orgId, orgId),
      isNull(stepUpCodes.supersededAt),
      isNull(stepUpCodes.consumedAt),
    ))
    .limit(1);
  return row ?? null;
}

async function checkRow(deps: StepUpDeps, row: Awaited<ReturnType<typeof openApproval>>, userId: string, now: number) {
  if (!row) return fail(404, 'no_code', 'This approval request no longer exists. Request a new code.');
  if (row.method !== 'WHATSAPP_PASSKEY') return fail(400, 'not_a_code', 'This approval does not use a code.');
  if (row.approverUserId !== userId) {
    const [who] = await deps.db.select({ name: users.name }).from(users).where(eq(users.id, row.approverUserId)).limit(1);
    return fail(403, 'not_the_approver', `This code was sent to ${who?.name ?? 'the main admin'}. Only they can enter it, in their own Splash session.`);
  }
  if (new Date(row.expiresAt).getTime() <= now) return fail(410, 'expired', 'This code has expired. Request a new one.');
  return null;
}

export async function verifyStepUpCode(
  deps: StepUpDeps,
  input: { orgId: string; userId: string; approvalId: string; code: string },
) {
  const now = deps.now?.() ?? Date.now();
  const row = await openApproval(deps.db, input.orgId, input.approvalId);
  if (row?.verifiedAt && row.approverUserId === input.userId) {
    return { ok: true as const, next: 'DONE' as const, approvedAt: new Date(row.verifiedAt).toISOString() };
  }
  const problem = await checkRow(deps, row, input.userId, now);
  if (problem) return problem;
  const live = row!;

  if (!live.codeVerifiedAt) {
    if (live.attempts >= STEP_UP_MAX_ATTEMPTS) return fail(429, 'locked', 'Too many wrong attempts. Request a new code.');
    const typed = String(input.code ?? '').trim();
    const right = /^\d{6}$/.test(typed) && live.codeHash !== null && sameHash(hashCode(deps.key, live.id, typed), live.codeHash);
    if (!right) {
      const [bumped] = await deps.db
        .update(stepUpCodes)
        .set({ attempts: sql`${stepUpCodes.attempts} + 1`, updatedAt: new Date(now) })
        .where(and(eq(stepUpCodes.id, live.id), lt(stepUpCodes.attempts, STEP_UP_MAX_ATTEMPTS)))
        .returning({ attempts: stepUpCodes.attempts });
      const left = Math.max(0, STEP_UP_MAX_ATTEMPTS - (bumped?.attempts ?? STEP_UP_MAX_ATTEMPTS));
      return fail(400, 'wrong_code', left > 0 ? `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Request a new code.');
    }
    await deps.db
      .update(stepUpCodes)
      .set({ codeVerifiedAt: new Date(now), updatedAt: new Date(now) })
      .where(and(eq(stepUpCodes.id, live.id), isNull(stepUpCodes.codeVerifiedAt)));
  }

  return {
    ok: true as const,
    next: 'PASSKEY' as const,
    summary: live.summary,
    // What the passkey must sign. The server rebuilds it when checking.
    message: passkeyApprovalMessage(live),
  };
}

// ─── WHATSAPP_PASSKEY: the passkey ──────────────────────────────────────────

export async function confirmStepUpPasskey(
  deps: StepUpDeps,
  input: { orgId: string; userId: string; approvalId: string; signature: string },
) {
  const now = deps.now?.() ?? Date.now();
  const row = await openApproval(deps.db, input.orgId, input.approvalId);
  if (row?.verifiedAt && row.approverUserId === input.userId) {
    return { ok: true as const, approvedAt: new Date(row.verifiedAt).toISOString() };
  }
  const problem = await checkRow(deps, row, input.userId, now);
  if (problem) return problem;
  const live = row!;
  if (!live.codeVerifiedAt) return fail(409, 'code_first', 'Enter the WhatsApp code first.');

  const message = new TextEncoder().encode(passkeyApprovalMessage(live));
  const checked = await deps.verifyPasskey({ userId: input.userId, message, signature: String(input.signature ?? '') });
  if (!checked.ok) return fail(400, 'passkey_rejected', `The passkey confirmation did not verify: ${checked.reason}`);

  await deps.db
    .update(stepUpCodes)
    .set({ passkeyCredentialId: checked.credentialId, verifiedAt: new Date(now), updatedAt: new Date(now) })
    .where(and(eq(stepUpCodes.id, live.id), isNull(stepUpCodes.verifiedAt)));
  return { ok: true as const, approvedAt: new Date(now).toISOString() };
}

/** Approvals waiting on this person: codes sent to them, not yet given. */
export async function listPendingApprovals(d: Db, input: { orgId: string; userId: string; nowMs?: number }) {
  const now = new Date(input.nowMs ?? Date.now());
  const rows = await d
    .select({
      id: stepUpCodes.id,
      purpose: stepUpCodes.purpose,
      summary: stepUpCodes.summary,
      requestedBy: stepUpCodes.requestedBy,
      codeVerifiedAt: stepUpCodes.codeVerifiedAt,
      expiresAt: stepUpCodes.expiresAt,
      createdAt: stepUpCodes.createdAt,
      subjectId: stepUpCodes.subjectId,
      subjectDigest: stepUpCodes.subjectDigest,
      attempts: stepUpCodes.attempts,
    })
    .from(stepUpCodes)
    .where(and(
      eq(stepUpCodes.orgId, input.orgId),
      eq(stepUpCodes.approverUserId, input.userId),
      eq(stepUpCodes.method, 'WHATSAPP_PASSKEY'),
      isNull(stepUpCodes.verifiedAt),
      isNull(stepUpCodes.supersededAt),
      isNull(stepUpCodes.consumedAt),
      gt(stepUpCodes.expiresAt, now),
    ))
    .orderBy(desc(stepUpCodes.createdAt))
    .limit(20);
  const names = new Map<string, string>();
  for (const r of rows) {
    if (!names.has(r.requestedBy)) {
      const [u] = await d.select({ name: users.name }).from(users).where(eq(users.id, r.requestedBy)).limit(1);
      names.set(r.requestedBy, u?.name ?? 'someone');
    }
  }
  return rows.map((r: typeof rows[number]) => ({
    id: r.id,
    purpose: r.purpose,
    summary: r.summary,
    requestedByName: names.get(r.requestedBy) ?? 'someone',
    stage: r.codeVerifiedAt ? ('PASSKEY' as const) : ('CODE' as const),
    locked: r.attempts >= STEP_UP_MAX_ATTEMPTS,
    expiresAt: new Date(r.expiresAt).toISOString(),
    message: r.codeVerifiedAt ? passkeyApprovalMessage(r) : null,
  }));
}

// ─── CLICK ──────────────────────────────────────────────────────────────────

export async function approveByClick(
  deps: Pick<StepUpDeps, 'db' | 'now'>,
  input: {
    orgId: string;
    style: ApprovalStyle;
    /** The person clicking. */
    userId: string;
    /** Their membership role: admin | checker | maker | viewer. */
    dbRole: string;
    requesterUserId: string;
    /** Settings → dual approval ON and the amount at or above the approval
     *  threshold: the same rule the fiat queue applies. */
    requireSecondPerson: boolean;
    purpose: StepUpPurpose;
    subjectId: string;
    subject: unknown;
    summary: string;
  },
) {
  if (input.style !== 'CLICK') {
    return fail(400, 'whatsapp_style', 'This workspace approves by WhatsApp code and passkey. Request a code instead.');
  }
  if (!APPROVING_DB_ROLES.has(input.dbRole)) {
    return fail(403, 'not_an_approver', 'Your role cannot approve payments. An admin or checker must approve.');
  }
  if (input.requireSecondPerson && input.userId === input.requesterUserId) {
    return fail(403, 'maker_checker', 'This workspace requires a second person to approve (maker-checker). Someone other than the person who prepared it must click Approve.');
  }
  const now = deps.now?.() ?? Date.now();
  const digest = subjectDigest(input.subject);
  const latest = await latestLive(deps.db, input.orgId, input.purpose, input.subjectId);
  if (latest && latest.subjectDigest === digest && freshApproval(latest, now)) {
    return { ok: true as const, approvedAt: new Date(latest.verifiedAt).toISOString() };
  }
  await supersedeOpen(deps.db, input, now);
  await deps.db.insert(stepUpCodes).values({
    id: `stp_${randomUUID()}`,
    orgId: input.orgId,
    method: 'CLICK',
    approverUserId: input.userId,
    requestedBy: input.requesterUserId,
    purpose: input.purpose,
    subjectId: input.subjectId,
    subjectDigest: digest,
    summary: input.summary,
    codeHash: null,
    expiresAt: new Date(now + STEP_UP_TTL_MS),
    verifiedAt: new Date(now),
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  return { ok: true as const, approvedAt: new Date(now).toISOString() };
}

// ─── Status and use ─────────────────────────────────────────────────────────

export async function stepUpStatus(
  d: Db,
  input: { orgId: string; purpose: StepUpPurpose; subjectId: string; subject: unknown; nowMs?: number },
) {
  const now = input.nowMs ?? Date.now();
  const row = await latestLive(d, input.orgId, input.purpose, input.subjectId);
  if (!row) return { state: 'NONE' as const };
  const [who] = await d.select({ name: users.name }).from(users).where(eq(users.id, row.approverUserId)).limit(1);
  const base = {
    approvalId: row.id as string,
    approverUserId: row.approverUserId as string,
    method: row.method as ApprovalStyle,
    approverName: who?.name ?? null,
    sentTo: row.sentTo ? maskNumber(row.sentTo) : null,
    summary: row.summary,
  };
  if (row.subjectDigest !== subjectDigest(input.subject)) return { state: 'CHANGED' as const, ...base };
  if (row.verifiedAt) return { state: freshApproval(row, now) ? ('APPROVED' as const) : ('EXPIRED' as const), ...base };
  if (new Date(row.expiresAt).getTime() <= now) return { state: 'EXPIRED' as const, ...base };
  if (row.attempts >= STEP_UP_MAX_ATTEMPTS) return { state: 'LOCKED' as const, ...base };
  if (row.codeVerifiedAt) return { state: 'AWAITING_PASSKEY' as const, ...base, message: passkeyApprovalMessage(row) };
  return { state: 'SENT' as const, ...base, expiresAt: new Date(row.expiresAt).toISOString() };
}

/**
 * Use an approval, once. True only for an approval given for this exact
 * subject within the TTL and not yet used; the UPDATE is conditional, so two
 * requests racing on one approval cannot both have it.
 */
export async function consumeStepUp(
  d: Db,
  input: { orgId: string; purpose: StepUpPurpose; subjectId: string; subject: unknown; nowMs?: number },
): Promise<boolean> {
  const now = input.nowMs ?? Date.now();
  const row = await latestLive(d, input.orgId, input.purpose, input.subjectId);
  if (!row || !freshApproval(row, now)) return false;
  if (row.subjectDigest !== subjectDigest(input.subject)) return false;
  const used = await d
    .update(stepUpCodes)
    .set({ consumedAt: new Date(now), updatedAt: new Date(now) })
    .where(and(eq(stepUpCodes.id, row.id), isNull(stepUpCodes.consumedAt)))
    .returning({ id: stepUpCodes.id });
  return used.length === 1;
}

/** Give an approval back when the action it was used for did not happen. */
export async function releaseStepUp(
  d: Db,
  input: { orgId: string; purpose: StepUpPurpose; subjectId: string },
): Promise<void> {
  const [row] = await d
    .select({ id: stepUpCodes.id })
    .from(stepUpCodes)
    .where(and(
      eq(stepUpCodes.orgId, input.orgId),
      eq(stepUpCodes.purpose, input.purpose),
      eq(stepUpCodes.subjectId, input.subjectId),
      isNull(stepUpCodes.supersededAt),
    ))
    .orderBy(desc(stepUpCodes.createdAt))
    .limit(1);
  if (row) {
    await d.update(stepUpCodes).set({ consumedAt: null, updatedAt: new Date() }).where(eq(stepUpCodes.id, row.id));
  }
}

// ─── The real passkey check ─────────────────────────────────────────────────

/** Verify a passkey signature over `message` against the approver's ENROLLED
 *  key for this deployment's relying party — never a key the request brings. */
export function enrolledPasskeyVerifier(d: Db): PasskeyVerifier {
  return async ({ userId, message, signature }) => {
    const { findCredential, relyingPartyId, assertCompressedP256, markCredentialUsed } = await import('@/lib/auth/passkey');
    const credential = await findCredential(d, { userId, rpId: relyingPartyId() });
    if (!credential) return { ok: false, reason: 'you have no passkey on this site. Create one in Settings → Security first.' };
    try {
      const { PasskeyPublicKey } = await import('@mysten/sui/keypairs/passkey');
      const publicKey = new PasskeyPublicKey(assertCompressedP256(credential.publicKey));
      const ok = await publicKey.verifyPersonalMessage(message, signature);
      if (!ok) return { ok: false, reason: 'the signature does not match your enrolled passkey' };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'signature could not be checked' };
    }
    await markCredentialUsed(d, credential.id);
    return { ok: true, credentialId: credential.id };
  };
}
