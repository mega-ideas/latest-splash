/**
 * Sumsub's webhooks (v2 §4.6): a business's KYB verdict, and the status of a
 * Travel Rule transfer to an exchange.
 *
 * The order is fixed: the signature over the raw body (in the algorithm
 * Sumsub names),
 * then the body, then its date inside the window (lib/compliance/sumsub.ts),
 * then the delivery once: its digest is claimed in `webhook_events`
 * (provider, event id) before anything is applied, so a replay inside the
 * window changes nothing. Then:
 *
 *   KYB      the org named by `externalUserId = org:<orgId>`, and nothing
 *            else in the payload, moves by the lifecycle state machine as
 *            the PROVIDER actor, which can reach KYB_PROVIDER_APPROVED or
 *            REJECTED and never ACTIVE (lib/compliance/kyb-state.ts). A
 *            transition the machine refuses (a verdict for an org already
 *            further on) is acknowledged and changes nothing: no status
 *            goes backwards.
 *   Travel   the transfer named by Sumsub's own reference, for that txnId
 *   Rule     and that org, forward only (lib/server/travel-rule-transfers.ts).
 *
 * Without a database production refuses (503): a delivery that cannot be
 * kept once cannot be applied once.
 */
import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { webhookEvents } from '../db/schema.ts';
import { KybTransitionError } from '../compliance/kyb-state.ts';
import { kybDecision, orgFromSumsubPayload, travelRuleEventOf, verifySumsubWebhook } from '../compliance/sumsub.ts';
import { applyTravelRuleEvent } from './travel-rule-transfers.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

export type SumsubWebhookDeps = {
  db: DrizzleDb | null;
  secret: string | undefined;
  production: boolean;
  now: () => Date;
  applyKyb: (orgId: string, next: 'KYB_PROVIDER_APPROVED' | 'REJECTED') => Promise<{ from: string; to: string }>;
  /** Sumsub's old SHA-1 default: refused unless allowed (outside production, or SUMSUB_WEBHOOK_ALLOW_SHA1 for the switch-over). Default allowed. */
  allowSha1?: boolean;
};

export type SumsubWebhookResult = { status: number; body: Record<string, unknown> };

async function claim(db: DrizzleDb, replayKey: string, type: string, now: Date): Promise<boolean> {
  const [row] = await db
    .insert(webhookEvents)
    .values({ id: `whe_${randomUUID()}`, provider: 'sumsub', eventId: replayKey, payload: { type: type.slice(0, 64) }, status: 'RECEIVED', receivedAt: now })
    .onConflictDoNothing()
    .returning();
  return Boolean(row);
}

async function settle(db: DrizzleDb, replayKey: string, status: 'PROCESSED' | 'SKIPPED', now: Date) {
  await db.update(webhookEvents).set({ status, processedAt: now, updatedAt: now }).where(and(eq(webhookEvents.provider, 'sumsub'), eq(webhookEvents.eventId, replayKey)));
}

async function release(db: DrizzleDb, replayKey: string) {
  await db.delete(webhookEvents).where(and(eq(webhookEvents.provider, 'sumsub'), eq(webhookEvents.eventId, replayKey)));
}

export async function handleSumsubWebhook(deps: SumsubWebhookDeps, input: { raw: string; digest: string | null; alg: string | null }): Promise<SumsubWebhookResult> {
  const now = deps.now();
  const verified = verifySumsubWebhook({ ...input, secret: deps.secret, now, allowSha1: deps.allowSha1 ?? true });
  if (!verified.ok) {
    return verified.status === 403 ? { status: 403, body: { error: 'forbidden' } } : { status: 400, body: { error: verified.reason } };
  }
  const payload = verified.payload;
  const type = typeof payload.type === 'string' ? payload.type : '';
  if (!deps.db && deps.production) return { status: 503, body: { error: 'not stored' } };

  if (deps.db && !(await claim(deps.db, verified.replayKey, type, now))) {
    return { status: 200, body: { ok: true, applied: false, reason: 'replay' } };
  }
  const done = async (applied: boolean, reason: string, extra: Record<string, unknown> = {}): Promise<SumsubWebhookResult> => {
    if (deps.db) await settle(deps.db, verified.replayKey, applied ? 'PROCESSED' : 'SKIPPED', now);
    return { status: 200, body: { ok: true, applied, reason, ...extra } };
  };

  const orgId = orgFromSumsubPayload(payload);
  try {
    const tr = travelRuleEventOf(payload);
    if (tr) {
      if (!deps.db) return done(false, 'no database');
      const r = await applyTravelRuleEvent(deps.db, { provider: 'sumsub', ...tr, orgId }, now);
      return done(r.applied, r.reason);
    }
    if (!orgId) return done(false, 'not about a business of ours');
    const decision = kybDecision(payload);
    if (!decision.next) return done(false, decision.reason);
    try {
      const moved = await deps.applyKyb(orgId, decision.next);
      return done(true, decision.reason, { from: moved.from, to: moved.to });
    } catch (error) {
      // Only the state machine's own refusal (a duplicate, or an org already
      // further on) is acknowledged, so Sumsub stops; nothing goes backwards.
      // Anything else (the database down, a timeout) is ours: it goes to the
      // outer catch, the claim is released and Sumsub delivers it again.
      if (error instanceof KybTransitionError) return done(false, 'transition not permitted');
      throw error;
    }
  } catch (error) {
    // Something of ours failed: let Sumsub deliver it again.
    if (deps.db) await release(deps.db, verified.replayKey);
    throw error;
  }
}
