/**
 * Unanimous consent, and any single refusal is final.
 *
 * ─── The shape of the rule ──────────────────────────────────────────────────
 *
 * An approval request goes to every eligible approver. ALL of them must
 * approve; ONE rejection ends it immediately and the payment does not go.
 *
 * That asymmetry is deliberate and it is what makes reply-by-WhatsApp
 * defensible at all. WhatsApp authenticates a handset, not a person — so ask
 * what a stolen phone can do under this rule. It can refuse payments, which is
 * noisy, reversible and immediately obvious to the operator. It cannot release
 * one, because releasing needs every OTHER approver's phone as well.
 *
 * A majority rule would not have that property: with three approvers, two
 * compromised handsets would move money.
 *
 * ─── One ballot each ────────────────────────────────────────────────────────
 *
 * Each approver gets a token bound to them and to one proposal, single-use and
 * expiring. Not one shared code per proposal: a shared code makes "three
 * approvers agreed" satisfiable by one person entering it three times, which is
 * exactly the control being claimed and exactly what it would not be
 * delivering.
 */
import 'server-only';

import { randomInt, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';

import { approvalTokens } from '@/lib/db/schema';
import type { Approver } from '@/lib/server/approver-channels';

/** Long enough not to be guessed inside its life, short enough to read aloud. */
const CODE_DIGITS = 6;

/**
 * How long an approval request stays answerable.
 *
 * An approval request is a claim about the world at a moment — this balance,
 * this corridor, this beneficiary, these ceilings. Thirty minutes is long
 * enough for someone to reach their phone and short enough that the claim is
 * still true when they do.
 */
export const TOKEN_TTL_MS = 30 * 60 * 1000;

export type IssuedToken = {
  id: string;
  userId: string;
  code: string;
  expiresAt: Date;
  sentTo: string | null;
};

function code(): string {
  // randomInt, not Math.random: this is the secret in `code` mode.
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

/**
 * Issue one ballot per approver.
 *
 * Idempotent per (proposal, approver): a retried notification reuses the
 * existing token rather than minting a second, because two live tokens for one
 * approver is one person able to answer twice.
 */
export async function issueTokens(input: {
  proposalId: string;
  orgId: string;
  approvers: Approver[];
  channel: 'code' | 'reply';
  now: Date;
}): Promise<IssuedToken[]> {
  if (!process.env.DATABASE_URL) return [];
  const { getDb } = await import('@/lib/db/client');
  const db = getDb();

  const expiresAt = new Date(input.now.getTime() + TOKEN_TTL_MS);
  const issued: IssuedToken[] = [];

  for (const approver of input.approvers) {
    const row = {
      id: `atk_${randomUUID()}`,
      proposalId: input.proposalId,
      orgId: input.orgId,
      userId: approver.userId,
      code: code(),
      channel: input.channel,
      sentTo: approver.whatsappE164,
      expiresAt,
    };
    const [inserted] = await db
      .insert(approvalTokens)
      .values(row)
      .onConflictDoNothing({ target: [approvalTokens.proposalId, approvalTokens.userId] })
      .returning();

    if (inserted) {
      issued.push({
        id: inserted.id,
        userId: inserted.userId,
        code: inserted.code,
        expiresAt: inserted.expiresAt,
        sentTo: inserted.sentTo,
      });
      continue;
    }

    // Already had one. Reuse it rather than mint a second.
    const existing = await db
      .select()
      .from(approvalTokens)
      .where(
        and(
          eq(approvalTokens.proposalId, input.proposalId),
          eq(approvalTokens.userId, approver.userId),
        ),
      )
      .limit(1);
    if (existing[0]) {
      issued.push({
        id: existing[0].id,
        userId: existing[0].userId,
        code: existing[0].code,
        expiresAt: existing[0].expiresAt,
        sentTo: existing[0].sentTo,
      });
    }
  }

  return issued;
}

export type TokenLookup =
  | { ok: true; token: { id: string; proposalId: string; orgId: string; userId: string } }
  | { ok: false; reason: string };

/**
 * Find this approver's live, undecided ballot.
 *
 * Both lookups below refuse a token that has already been decided. A ballot is
 * single-use: an approver who answers twice has not agreed twice, and allowing
 * it would let one person satisfy a two-approver requirement by replying again.
 */
export async function findLiveTokenForUser(
  userId: string,
  now: Date,
  proposalId?: string,
): Promise<TokenLookup> {
  if (!process.env.DATABASE_URL) return { ok: false, reason: 'no database configured' };
  const { getDb } = await import('@/lib/db/client');
  const db = getDb();

  const conditions = [eq(approvalTokens.userId, userId), isNull(approvalTokens.decidedAt)];
  if (proposalId) conditions.push(eq(approvalTokens.proposalId, proposalId));

  const rows = await db
    .select()
    .from(approvalTokens)
    .where(and(...conditions))
    .limit(2);

  if (rows.length === 0) return { ok: false, reason: 'no pending approval for this approver' };
  // A reply carries no proposal id, so an approver with two payments waiting
  // cannot be disambiguated. Asking is the only safe answer — guessing would
  // approve the wrong payment.
  if (rows.length > 1 && !proposalId) {
    return { ok: false, reason: 'more than one payment is waiting on this approver' };
  }

  const row = rows[0];
  if (row.expiresAt.getTime() < now.getTime()) {
    return { ok: false, reason: 'this approval request has expired' };
  }
  return {
    ok: true,
    token: { id: row.id, proposalId: row.proposalId, orgId: row.orgId, userId: row.userId },
  };
}

/** Find a ballot by the digits an approver typed, scoped to them. */
export async function findTokenByCode(
  userId: string,
  typed: string,
  now: Date,
): Promise<TokenLookup> {
  if (!process.env.DATABASE_URL) return { ok: false, reason: 'no database configured' };
  const { getDb } = await import('@/lib/db/client');
  const db = getDb();

  const rows = await db
    .select()
    .from(approvalTokens)
    .where(
      and(
        eq(approvalTokens.userId, userId),
        eq(approvalTokens.code, typed.trim()),
        isNull(approvalTokens.decidedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  // One message for a wrong code and an expired one: the difference would tell
  // someone guessing that they had found a real code.
  if (!row) return { ok: false, reason: 'that code is not valid' };
  if (row.expiresAt.getTime() < now.getTime()) return { ok: false, reason: 'that code is not valid' };

  return {
    ok: true,
    token: { id: row.id, proposalId: row.proposalId, orgId: row.orgId, userId: row.userId },
  };
}

/**
 * Record a ballot, once.
 *
 * The `isNull(decidedAt)` in the WHERE clause is the single-use guarantee, and
 * it is in the UPDATE rather than checked beforehand: two replies arriving
 * together would both pass a prior read and both count.
 */
export async function recordDecision(
  tokenId: string,
  decision: 'APPROVE' | 'REJECT',
  now: Date,
): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  const { getDb } = await import('@/lib/db/client');
  const rows = await getDb()
    .update(approvalTokens)
    .set({ decision, decidedAt: now, updatedAt: now })
    .where(and(eq(approvalTokens.id, tokenId), isNull(approvalTokens.decidedAt)))
    .returning({ id: approvalTokens.id });
  return rows.length > 0;
}

export type Tally = {
  total: number;
  approved: number;
  rejected: number;
  /** Every approver said yes. */
  unanimous: boolean;
  /** Someone said no. Terminal. */
  refused: boolean;
};

/**
 * Where the vote stands.
 *
 * `refused` is checked before `unanimous` by every caller, and the two can
 * never both be true, because a rejection ends the request.
 */
export async function tally(proposalId: string): Promise<Tally> {
  if (!process.env.DATABASE_URL) {
    return { total: 0, approved: 0, rejected: 0, unanimous: false, refused: false };
  }
  const { getDb } = await import('@/lib/db/client');
  const rows = await getDb()
    .select({ decision: approvalTokens.decision })
    .from(approvalTokens)
    .where(eq(approvalTokens.proposalId, proposalId));

  const approved = rows.filter((r) => r.decision === 'APPROVE').length;
  const rejected = rows.filter((r) => r.decision === 'REJECT').length;
  return {
    total: rows.length,
    approved,
    rejected,
    // Every issued ballot returned an approval. Not "enough of them".
    unanimous: rows.length > 0 && approved === rows.length,
    refused: rejected > 0,
  };
}
