/**
 * Postgres access for governance alerts (v2, brief 3.5).
 *
 * Two tables (migration 0032). `governance_alerts` is one row per canonical
 * on-chain event, unique on (digest, event seq). `governance_alert_deliveries`
 * is one row per owner, alert and channel, unique on all three, and it is the
 * idempotency: a delivery is claimed by inserting its row BEFORE anything is
 * sent, so two cron runs racing, a retry, or a re-read of the same events
 * cannot send twice. Read-then-write would let both runs read nothing and both
 * send.
 *
 * Scope. An alert has no org: one announcement concerns every tenant, like a
 * daily audit batch. The cross-tenant reads here are the cron's, and say so in
 * their names (`*ForStaff`, WS2). The one reader a customer reaches,
 * `readGovernanceBannerForSession`, reads only the signed-in person's own
 * deliveries, so the banner exists exactly where the fan-out recorded one.
 *
 * Without DATABASE_URL there is no fallback map. The owners are rows in
 * `memberships`, so with no database there is nobody to tell and nowhere to
 * record that they were told; the monitor refuses to run (502) and the banner
 * reader returns nothing.
 */
import { randomUUID } from 'node:crypto';

import { and, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { approverChannels, governanceAlertDeliveries, governanceAlerts, memberships, users } from '../db/schema.ts';
import type * as schemaModule from '../db/schema.ts';
import type { GovernanceAlert, GovernanceAlertKind, GovernanceBannerAlert } from './governance-events.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

export type DeliveryChannel = 'in_app' | 'email' | 'whatsapp';

/** A failed send is claimed again on later runs, up to this many attempts. */
export const MAX_DELIVERY_ATTEMPTS = 3;

/** The business owner role. `admin` maps to OWNER (lib/auth/authority.ts). */
const OWNER_ROLE = 'admin';

export type StoredGovernanceAlert = {
  id: string;
  kind: GovernanceAlertKind;
  digest: string;
  eventSeq: number;
  summary: string;
  detail: string;
  reviewPath: string;
  etaAt: string | null;
  occurredAt: string | null;
  activeUntil: string;
};

export type BusinessOwner = {
  userId: string;
  email: string;
  name: string;
  /** The org in which they are an owner; the first, if several. */
  orgId: string;
  /** Their verified WhatsApp number, or null. Never an unverified one. */
  whatsappE164: string | null;
};

type AlertRow = typeof governanceAlerts.$inferSelect;

function toStored(row: AlertRow): StoredGovernanceAlert {
  return {
    id: row.id,
    kind: row.kind as GovernanceAlertKind,
    digest: row.digest,
    eventSeq: row.eventSeq,
    summary: row.summary,
    detail: row.detail,
    reviewPath: row.reviewPath,
    etaAt: row.etaAt?.toISOString() ?? null,
    occurredAt: row.occurredAt?.toISOString() ?? null,
    activeUntil: row.activeUntil.toISOString(),
  };
}

export function governanceAlertId(digest: string, eventSeq: number): string {
  return `gov_${digest}_${eventSeq}`;
}

const at = (ms: number | null) => (ms == null ? null : new Date(ms));

/**
 * Record an alert, or learn that it was recorded already. `created` is true
 * only for the run whose insert won.
 */
export async function recordGovernanceAlert(
  db: DrizzleDb,
  alert: GovernanceAlert,
): Promise<{ alert: StoredGovernanceAlert; created: boolean }> {
  const inserted = await db
    .insert(governanceAlerts)
    .values({
      id: governanceAlertId(alert.digest, alert.eventSeq),
      digest: alert.digest,
      eventSeq: alert.eventSeq,
      kind: alert.kind,
      eventType: alert.eventType,
      bytecodeDigest: alert.bytecodeDigest,
      upgradePolicy: alert.upgradePolicy,
      registry: alert.registry,
      typeName: alert.typeName,
      newOwner: alert.newOwner,
      proposedAt: at(alert.proposedAtMs),
      etaAt: at(alert.etaMs),
      occurredAt: at(alert.occurredAtMs),
      activeUntil: new Date(alert.activeUntilMs),
      summary: alert.summary,
      detail: alert.detail,
      reviewPath: alert.reviewPath,
    })
    // The id is derived from (digest, seq), so the primary key and the unique
    // index guard the same thing; either conflict means "already recorded".
    .onConflictDoNothing()
    .returning({ id: governanceAlerts.id });
  const rows = await db
    .select()
    .from(governanceAlerts)
    .where(and(eq(governanceAlerts.digest, alert.digest), eq(governanceAlerts.eventSeq, alert.eventSeq)))
    .limit(1);
  if (!rows[0]) throw new Error(`Governance alert ${alert.digest}#${alert.eventSeq} was neither recorded nor found.`);
  return { alert: toStored(rows[0]), created: inserted.length > 0 };
}

/** Every alert still on the dashboard at `nowMs`, newest first. Cross-tenant. */
export async function listActiveGovernanceAlertsForStaff(db: DrizzleDb, nowMs: number): Promise<StoredGovernanceAlert[]> {
  const rows = await db
    .select()
    .from(governanceAlerts)
    .where(gt(governanceAlerts.activeUntil, new Date(nowMs)))
    .orderBy(desc(governanceAlerts.createdAt))
    .limit(50);
  return rows.map(toStored);
}

/**
 * Every business owner of every organisation, once each: the members whose
 * role is `admin`, which the authority resolver maps to OWNER. Cross-tenant,
 * because one announcement concerns them all.
 *
 * A WhatsApp number is returned only when its channel row is verified, and
 * only the channel registered in the org they own; anyone else gets none.
 */
export async function listBusinessOwnersForStaff(db: DrizzleDb): Promise<BusinessOwner[]> {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      orgId: memberships.orgId,
      whatsappE164: approverChannels.whatsappE164,
      verifiedAt: approverChannels.verifiedAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(
      approverChannels,
      and(eq(approverChannels.userId, memberships.userId), eq(approverChannels.orgId, memberships.orgId)),
    )
    .where(eq(memberships.role, OWNER_ROLE))
    .orderBy(users.id, memberships.orgId);

  const owners = new Map<string, BusinessOwner>();
  for (const row of rows) {
    const verifiedNumber = row.verifiedAt && row.whatsappE164 ? row.whatsappE164 : null;
    const existing = owners.get(row.userId);
    if (existing) {
      if (!existing.whatsappE164 && verifiedNumber) existing.whatsappE164 = verifiedNumber;
      continue;
    }
    owners.set(row.userId, {
      userId: row.userId,
      email: row.email,
      name: row.name,
      orgId: row.orgId,
      whatsappE164: verifiedNumber,
    });
  }
  return [...owners.values()];
}

export type DeliveryState = { status: string; attempts: number };

const deliveryKey = (alertId: string, userId: string, channel: string) => `${alertId}|${userId}|${channel}`;

/** What has been recorded for these alerts, keyed `alert|user|channel`. Lets a
 *  run skip, without a write, everyone it has already told. */
export async function readDeliveryStatesForStaff(db: DrizzleDb, alertIds: string[]): Promise<Map<string, DeliveryState>> {
  const states = new Map<string, DeliveryState>();
  if (alertIds.length === 0) return states;
  const rows = await db
    .select({
      alertId: governanceAlertDeliveries.alertId,
      userId: governanceAlertDeliveries.userId,
      channel: governanceAlertDeliveries.channel,
      status: governanceAlertDeliveries.status,
      attempts: governanceAlertDeliveries.attempts,
    })
    .from(governanceAlertDeliveries)
    .where(inArray(governanceAlertDeliveries.alertId, alertIds));
  for (const row of rows) states.set(deliveryKey(row.alertId, row.userId, row.channel), { status: row.status, attempts: row.attempts });
  return states;
}

export function deliveryStateFor(states: Map<string, DeliveryState>, alertId: string, userId: string, channel: DeliveryChannel) {
  return states.get(deliveryKey(alertId, userId, channel)) ?? null;
}

/**
 * Claim one delivery: insert it as `sending`, or take back a `failed` one that
 * has attempts left. Returns the row id to finish, or null when someone else
 * holds it or it is done. Both branches are single statements the database
 * decides, so two instances cannot both win.
 */
export async function claimGovernanceDelivery(
  db: DrizzleDb,
  input: { alertId: string; userId: string; orgId: string; channel: DeliveryChannel },
): Promise<{ id: string; attempts: number } | null> {
  const inserted = await db
    .insert(governanceAlertDeliveries)
    .values({
      id: `gad_${randomUUID()}`,
      alertId: input.alertId,
      userId: input.userId,
      orgId: input.orgId,
      channel: input.channel,
      status: 'sending',
      attempts: 1,
    })
    .onConflictDoNothing()
    .returning({ id: governanceAlertDeliveries.id, attempts: governanceAlertDeliveries.attempts });
  if (inserted[0]) return inserted[0];

  const retried = await db
    .update(governanceAlertDeliveries)
    .set({ status: 'sending', attempts: sql`${governanceAlertDeliveries.attempts} + 1`, error: null, updatedAt: new Date() })
    .where(
      and(
        eq(governanceAlertDeliveries.alertId, input.alertId),
        eq(governanceAlertDeliveries.userId, input.userId),
        eq(governanceAlertDeliveries.channel, input.channel),
        eq(governanceAlertDeliveries.status, 'failed'),
        lt(governanceAlertDeliveries.attempts, MAX_DELIVERY_ATTEMPTS),
      ),
    )
    .returning({ id: governanceAlertDeliveries.id, attempts: governanceAlertDeliveries.attempts });
  return retried[0] ?? null;
}

export async function finishGovernanceDelivery(
  db: DrizzleDb,
  id: string,
  result: { ok: true; providerRef?: string | null } | { ok: false; error: string },
): Promise<void> {
  const now = new Date();
  await db
    .update(governanceAlertDeliveries)
    .set(
      result.ok
        ? { status: 'sent', providerRef: result.providerRef ?? null, error: null, sentAt: now, updatedAt: now }
        // Bounded: a provider's error text is recorded, never a body or a key.
        : { status: 'failed', error: result.error.slice(0, 500), updatedAt: now },
    )
    .where(eq(governanceAlertDeliveries.id, id));
}

/** The banner for one person: alerts still active for which the fan-out
 *  recorded an in-app delivery to them. Newest first, at most five. */
export async function listBannerAlertsForUser(db: DrizzleDb, userId: string, nowMs: number): Promise<GovernanceBannerAlert[]> {
  const rows = await db
    .select({
      id: governanceAlerts.id,
      kind: governanceAlerts.kind,
      summary: governanceAlerts.summary,
      detail: governanceAlerts.detail,
      reviewPath: governanceAlerts.reviewPath,
    })
    .from(governanceAlertDeliveries)
    .innerJoin(governanceAlerts, eq(governanceAlerts.id, governanceAlertDeliveries.alertId))
    .where(
      and(
        eq(governanceAlertDeliveries.userId, userId),
        eq(governanceAlertDeliveries.channel, 'in_app'),
        eq(governanceAlertDeliveries.status, 'sent'),
        gt(governanceAlerts.activeUntil, new Date(nowMs)),
      ),
    )
    .orderBy(desc(governanceAlerts.createdAt))
    .limit(5);
  return rows.map((row) => ({ ...row, kind: row.kind as GovernanceAlertKind }));
}

/**
 * The dashboard layout's reader. The person is the session's own identity,
 * looked up by its email; nothing from the request picks whose alerts these
 * are. Presentation only, so any failure reads as "no banner" rather than
 * taking the dashboard down: the email and WhatsApp halves do not depend on it.
 */
export async function readGovernanceBannerForSession(session: { email: string }, nowMs = Date.now()): Promise<GovernanceBannerAlert[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const { getDb } = await import('../db/client.ts');
    const db = getDb() as unknown as DrizzleDb;
    const email = session.email.trim().toLowerCase();
    const found = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (!found[0]) return [];
    return await listBannerAlertsForUser(db, found[0].id, nowMs);
  } catch (error) {
    console.error('[governance-alerts] the banner could not be read:', error instanceof Error ? error.message : error);
    return [];
  }
}
