import { NextResponse } from 'next/server';
import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import { resolveAuthorityForSession, UnauthorizedError } from '@/lib/auth/authority';
import { assertCleanBody, ProvenanceViolationError, provenanceViolationResponse } from '@/lib/auth/provenance-guard';
import { canApprove, type MembershipRole } from '@/lib/membership-roles';
import { approverChannels } from '@/lib/db/schema';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { normaliseE164, sendWhatsApp, whatsappConfigured } from '@/lib/server/whatsapp';

/**
 * Registering the number an approver will be reached on.
 *
 * ─── Why a number must be proved before it can approve ──────────────────────
 *
 * An unverified number is a number somebody typed. A single transposed digit
 * routes every approval request for that person to a stranger's phone — who
 * then receives the amount, the beneficiary and, in `reply` mode, the ability
 * to answer. Typos are not rare and this one is silent: the approver simply
 * never gets asked, and notices only when a payment sits unapproved.
 *
 * So registering a number sends a code TO it, and the number is inert until
 * that code comes back. Proving possession is the whole point; a number that
 * has not been proved is stored but never used for an approval.
 *
 * ─── You may only register your own ─────────────────────────────────────────
 *
 * The user id comes from the session, never the body. Otherwise an approver
 * could register a colleague's number against their own account, or their own
 * number against a colleague's — either of which turns "two approvers agreed"
 * into one person with two ballots.
 */
export const dynamic = 'force-dynamic';

const postSchema = z.object({
  whatsapp: z.string().trim().min(6).max(24),
});

const putSchema = z.object({
  code: z.string().trim().min(4).max(8),
});

/** Short-lived proof-of-possession codes, keyed by user. Not an approval and
 *  not a session — losing them on restart costs a re-send and nothing else,
 *  which is why they do not need a table. */
type PendingVerification = { code: string; e164: string; expiresAt: number };
const pendingGlobal = globalThis as typeof globalThis & {
  splashChannelVerifications?: Map<string, PendingVerification>;
};
const pending = (pendingGlobal.splashChannelVerifications ??= new Map());

const VERIFY_TTL_MS = 10 * 60 * 1000;

async function approverContext(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return { response: auth.response } as const;

  try {
    const ctx = await resolveAuthorityForSession(auth.session);
    const dbRole = ({ OWNER: 'admin', APPROVER: 'checker', MAKER: 'maker' } as Record<string, MembershipRole>)[
      ctx.role
    ] ?? 'viewer';
    // Only someone who can approve has any use for an approval channel.
    if (!canApprove(dbRole)) {
      return {
        response: NextResponse.json(
          { error: 'Your role does not approve payments, so there is nothing to reach you about.' },
          { status: 403 },
        ),
      } as const;
    }
    return { ctx } as const;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return {
        response: NextResponse.json(
          { error: 'This account has no workspace membership yet.', code: 'no_membership' },
          { status: 403 },
        ),
      } as const;
    }
    throw error;
  }
}

/** Start: store the number unverified, and send it a code. */
export async function POST(request: Request) {
  const resolved = await approverContext(request);
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;

  const body = await readJsonBody(request);
  try {
    assertCleanBody(body, 'approvals/channel');
  } catch (error) {
    if (error instanceof ProvenanceViolationError) return provenanceViolationResponse(error);
    throw error;
  }

  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter a WhatsApp number in international format.' }, { status: 400 });
  }

  const e164 = normaliseE164(parsed.data.whatsapp);
  if (!e164) {
    return NextResponse.json(
      { error: 'That does not look like an international number. Include the country code, e.g. +60102651678.' },
      { status: 400 },
    );
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'No database is configured.' }, { status: 503 });
  }

  const { getDb } = await import('@/lib/db/client');
  const db = getDb();

  // One number, one person — enforced by a unique index, and answered here so
  // the message explains rather than surfacing a constraint violation. Two
  // approvers sharing a handset would make "two approvers agreed" mean one
  // person pressed a button twice.
  const taken = await db
    .select({ userId: approverChannels.userId })
    .from(approverChannels)
    .where(eq(approverChannels.whatsappE164, e164))
    .limit(1);
  if (taken[0] && taken[0].userId !== ctx.userId) {
    return NextResponse.json(
      { error: 'That number is already registered to another approver.' },
      { status: 409 },
    );
  }

  await db
    .insert(approverChannels)
    .values({
      id: `chn_${randomUUID()}`,
      orgId: ctx.orgId,
      userId: ctx.userId,
      whatsappE164: e164,
      // Explicitly unverified. Re-registering a number resets this, because a
      // number that has changed hands has not been proved by its new holder.
      verifiedAt: null,
    })
    .onConflictDoUpdate({
      target: [approverChannels.orgId, approverChannels.userId],
      set: { whatsappE164: e164, verifiedAt: null, updatedAt: new Date() },
    });

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  pending.set(ctx.userId, { code, e164, expiresAt: Date.now() + VERIFY_TTL_MS });

  const delivery = await sendWhatsApp(
    e164,
    `Splash — confirm this number\n\nYour code is ${code}.\n\n` +
      'Enter it in Splash to start receiving payment approval requests here. ' +
      'If you did not ask for this, ignore it.',
  );

  return NextResponse.json({
    ok: true,
    whatsapp: e164,
    verified: false,
    delivered: delivery.sent,
    // Said plainly rather than implying a message is on its way. With no
    // credentials nothing was sent, and an approver waiting for a code that
    // will never arrive is worse than being told.
    message: delivery.sent
      ? 'Check WhatsApp for your confirmation code.'
      : whatsappConfigured()
        ? `The message could not be delivered: ${delivery.reason}`
        : 'WhatsApp is not configured on this deployment, so no code was sent.',
  });
}

/** Finish: prove possession. */
export async function PUT(request: Request) {
  const resolved = await approverContext(request);
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;

  const body = await readJsonBody(request);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Enter the code you received.' }, { status: 400 });

  const entry = pending.get(ctx.userId);
  // One message for wrong, expired and absent: the difference would tell
  // someone guessing that they had found a real code.
  if (!entry || entry.expiresAt < Date.now() || entry.code !== parsed.data.code) {
    return NextResponse.json({ error: 'That code is not valid. Ask for a new one.' }, { status: 400 });
  }
  pending.delete(ctx.userId);

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'No database is configured.' }, { status: 503 });
  }

  const { getDb } = await import('@/lib/db/client');
  await getDb()
    .update(approverChannels)
    .set({ verifiedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(approverChannels.userId, ctx.userId),
        eq(approverChannels.orgId, ctx.orgId),
        // The number as it was when the code was sent. If it changed in the
        // meantime, this code proves possession of a number nobody is
        // registering.
        eq(approverChannels.whatsappE164, entry.e164),
      ),
    );

  return NextResponse.json({
    ok: true,
    whatsapp: entry.e164,
    verified: true,
    message: 'Confirmed. Payment approval requests will reach you on WhatsApp.',
  });
}

/** What is registered, so the settings screen can render it. */
export async function GET(request: Request) {
  const resolved = await approverContext(request);
  if ('response' in resolved) return resolved.response;
  const { ctx } = resolved;

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ whatsapp: null, verified: false });
  }
  const { getDb } = await import('@/lib/db/client');
  const rows = await getDb()
    .select()
    .from(approverChannels)
    .where(and(eq(approverChannels.userId, ctx.userId), eq(approverChannels.orgId, ctx.orgId)))
    .limit(1);

  const row = rows[0];
  return NextResponse.json({
    whatsapp: row?.whatsappE164 ?? null,
    verified: Boolean(row?.verifiedAt),
  });
}
