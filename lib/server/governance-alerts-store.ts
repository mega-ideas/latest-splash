/**
 * Postgres access for governance alerts (v2, brief 3.5).
 *
 * Three tables (migration 0032).
 *
 * `governance_alerts` is one row per thing owners are told, unique on its
 * content key (lib/server/governance-events.ts derives it from what the chain
 * shows: wrapper + bytecode digest + eta, and so on), so a re-run or a second
 * instance reading the same state records it once.
 *
 * `governance_watch_state` is the last state the monitor read of each watched
 * object, at the highest object version seen. A newer read replaces it; an
 * older one (a lagging indexer, a slower instance) never does. It is what the
 * next run compares with to see what took effect, and the list of proposals
 * it still holds is what decides which proposal alerts are shown: one that was
 * cancelled, or lapsed, stops being shown as a change that can take effect.
 *
 * `governance_alert_deliveries` is one row per owner, alert and channel,
 * unique on all three, and it is the idempotency. An email or WhatsApp
 * delivery is claimed by writing its row as `sending` BEFORE anything is sent,
 * so two runs racing, a retry, or a re-read cannot both send. A claim older
 * than DELIVERY_LEASE_MS belongs to a run that died, and may be claimed again;
 * a `sent` row is never claimed again. The in-app delivery has no outside side
 * effect, so it is written `sent` in one statement.
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
import { createHash, randomUUID } from 'node:crypto';

import { and, desc, eq, gt, inArray, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { approverChannels, governanceAlertDeliveries, governanceAlerts, governanceWatchState, memberships, users } from '../db/schema.ts';
import type * as schemaModule from '../db/schema.ts';
import {
  PROPOSAL_KINDS,
  type ConfigSnapshot,
  type GovernanceAlert,
  type GovernanceAlertKind,
  type GovernanceBannerAlert,
  type GovernanceSnapshots,
  type WrapperSnapshot,
} from './governance-events.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

export type DeliveryChannel = 'in_app' | 'email' | 'whatsapp';

/** A failed send is claimed again on later runs, up to this many attempts. */
export const MAX_DELIVERY_ATTEMPTS = 3;

/**
 * How long a `sending` claim is honoured. Far longer than any run lasts (the
 * route's maxDuration is 60 seconds, the email transport gives up after 10),
 * so a claim this old belongs to a run that was killed, redeployed or lost
 * its database mid-send, and is claimed again. Whether that send arrived is
 * unknown; the cost of not knowing is one possible repeat, against an owner
 * never being told.
 */
export const DELIVERY_LEASE_MS = 10 * 60 * 1000;

/** The business owner role. `admin` maps to OWNER (lib/auth/authority.ts). */
const OWNER_ROLE = 'admin';

export type StoredGovernanceAlert = {
  id: string;
  kind: GovernanceAlertKind;
  /** The wrapper or config the alert was read from. */
  subjectId: string;
  summary: string;
  detail: string;
  reviewPath: string;
  etaAt: string | null;
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
    subjectId: row.subjectId,
    summary: row.summary,
    detail: row.detail,
    reviewPath: row.reviewPath,
    etaAt: row.etaAt?.toISOString() ?? null,
    activeUntil: row.activeUntil.toISOString(),
  };
}

/** `gov_` + a hash of the content key: short, stable, the same everywhere. */
export function governanceAlertId(contentKey: string): string {
  return `gov_${createHash('sha256').update(contentKey).digest('hex').slice(0, 40)}`;
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
      id: governanceAlertId(alert.key),
      contentKey: alert.key,
      subjectId: alert.subjectId,
      kind: alert.kind,
      bytecodeDigest: alert.bytecodeDigest,
      upgradePolicy: alert.upgradePolicy,
      packageId: alert.packageId,
      packageVersion: alert.packageVersion,
      registry: alert.registry,
      typeName: alert.typeName,
      newOwner: alert.newOwner,
      proposedAt: at(alert.proposedAtMs),
      etaAt: at(alert.etaMs),
      activeUntil: new Date(alert.activeUntilMs),
      summary: alert.summary,
      detail: alert.detail,
      reviewPath: alert.reviewPath,
    })
    // The id is derived from the content key, so the primary key and the
    // unique index guard the same thing; either conflict means "recorded".
    .onConflictDoNothing()
    .returning({ id: governanceAlerts.id });
  const rows = await db.select().from(governanceAlerts).where(eq(governanceAlerts.contentKey, alert.key)).limit(1);
  if (!rows[0]) throw new Error(`Governance alert ${alert.key} was neither recorded nor found.`);
  return { alert: toStored(rows[0]), created: inserted.length > 0 };
}

/** The stored state of these objects, by id. */
export async function readWatchStateForStaff(db: DrizzleDb, ids: { wrapperId: string; configId: string }): Promise<GovernanceSnapshots> {
  const rows = await db
    .select({ subjectId: governanceWatchState.subjectId, snapshot: governanceWatchState.snapshot })
    .from(governanceWatchState)
    .where(inArray(governanceWatchState.subjectId, [ids.wrapperId, ids.configId]));
  const by = new Map(rows.map((r: { subjectId: string; snapshot: unknown }) => [r.subjectId, r.snapshot]));
  return {
    wrapper: (by.get(ids.wrapperId) as WrapperSnapshot | undefined) ?? null,
    config: (by.get(ids.configId) as ConfigSnapshot | undefined) ?? null,
  };
}

/**
 * Store what this run read, unless a run has already stored a newer read of
 * the same object. One statement, so of two racing runs the higher object
 * version is what stays.
 */
export async function saveWatchStateForStaff(
  db: DrizzleDb,
  input: { subjectId: string; subjectKind: 'wrapper' | 'config'; snapshot: WrapperSnapshot | ConfigSnapshot; nowMs: number },
): Promise<boolean> {
  const now = new Date(input.nowMs);
  const saved = await db
    .insert(governanceWatchState)
    .values({
      subjectId: input.subjectId,
      subjectKind: input.subjectKind,
      objectVersion: input.snapshot.objectVersion,
      snapshot: input.snapshot,
      observedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: governanceWatchState.subjectId,
      set: {
        objectVersion: sql`excluded.object_version`,
        snapshot: sql`excluded.snapshot`,
        observedAt: sql`excluded.observed_at`,
        updatedAt: sql`excluded.updated_at`,
      },
      setWhere: lt(governanceWatchState.objectVersion, sql`excluded.object_version`),
    })
    .returning({ subjectId: governanceWatchState.subjectId });
  return saved.length > 0;
}

/**
 * Whether an alert is still something owners should see: anything that took
 * effect, until its time is up; a proposal only while the latest stored read
 * of its object still holds it (and it has not lapsed, which `active_until`
 * already says).
 */
const stillShown = () =>
  or(
    notInArray(governanceAlerts.kind, PROPOSAL_KINDS),
    sql`EXISTS (SELECT 1 FROM ${governanceWatchState}, jsonb_array_elements_text(${governanceWatchState.snapshot} -> 'pendingKeys') AS pending(key)
      WHERE ${governanceWatchState.subjectId} = ${governanceAlerts.subjectId} AND pending.key = ${governanceAlerts.contentKey})`,
  );

/** Every alert owners should see at `nowMs`, newest first. Cross-tenant. */
export async function listActiveGovernanceAlertsForStaff(db: DrizzleDb, nowMs: number): Promise<StoredGovernanceAlert[]> {
  const rows = await db
    .select()
    .from(governanceAlerts)
    .where(and(gt(governanceAlerts.activeUntil, new Date(nowMs)), stillShown()))
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

export type DeliveryState = { status: string; attempts: number; updatedAtMs: number };

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
      updatedAt: governanceAlertDeliveries.updatedAt,
    })
    .from(governanceAlertDeliveries)
    .where(inArray(governanceAlertDeliveries.alertId, alertIds));
  for (const row of rows) {
    states.set(deliveryKey(row.alertId, row.userId, row.channel), { status: row.status, attempts: row.attempts, updatedAtMs: row.updatedAt.getTime() });
  }
  return states;
}

export function deliveryStateFor(states: Map<string, DeliveryState>, alertId: string, userId: string, channel: DeliveryChannel) {
  return states.get(deliveryKey(alertId, userId, channel)) ?? null;
}

/** The claim rule `claimGovernanceDelivery` applies, for a run to skip what
 *  it cannot claim without a write. The database decides, not this. */
export function deliveryClaimable(state: DeliveryState, nowMs: number): boolean {
  if (state.attempts >= MAX_DELIVERY_ATTEMPTS) return false;
  if (state.status === 'failed') return true;
  return state.status === 'sending' && state.updatedAtMs < nowMs - DELIVERY_LEASE_MS;
}

/**
 * Claim one email or WhatsApp delivery: insert it as `sending`, or take back
 * one that failed or whose claim has outlived DELIVERY_LEASE_MS, while it has
 * attempts left. Returns what `finishGovernanceDelivery` needs, or null when
 * someone else holds it or it is done. Both branches are single statements the
 * database decides, so two instances cannot both win, and a `sent` row is
 * never claimed again.
 */
export async function claimGovernanceDelivery(
  db: DrizzleDb,
  input: { alertId: string; userId: string; orgId: string; channel: Exclude<DeliveryChannel, 'in_app'>; nowMs: number },
): Promise<{ id: string; attempts: number } | null> {
  const now = new Date(input.nowMs);
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
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: governanceAlertDeliveries.id, attempts: governanceAlertDeliveries.attempts });
  if (inserted[0]) return inserted[0];

  const retried = await db
    .update(governanceAlertDeliveries)
    .set({ status: 'sending', attempts: sql`${governanceAlertDeliveries.attempts} + 1`, error: null, updatedAt: now })
    .where(
      and(
        eq(governanceAlertDeliveries.alertId, input.alertId),
        eq(governanceAlertDeliveries.userId, input.userId),
        eq(governanceAlertDeliveries.channel, input.channel),
        lt(governanceAlertDeliveries.attempts, MAX_DELIVERY_ATTEMPTS),
        or(
          eq(governanceAlertDeliveries.status, 'failed'),
          and(eq(governanceAlertDeliveries.status, 'sending'), lt(governanceAlertDeliveries.updatedAt, new Date(input.nowMs - DELIVERY_LEASE_MS))),
        ),
      ),
    )
    .returning({ id: governanceAlertDeliveries.id, attempts: governanceAlertDeliveries.attempts });
  return retried[0] ?? null;
}

/**
 * Record how a claimed send ended. Only the claim that is still current: if
 * this run outlived its lease and another run claimed the row again, that
 * run's outcome is the one recorded.
 */
export async function finishGovernanceDelivery(
  db: DrizzleDb,
  claim: { id: string; attempts: number },
  result: { ok: true; providerRef?: string | null } | { ok: false; error: string },
  nowMs: number,
): Promise<void> {
  const now = new Date(nowMs);
  await db
    .update(governanceAlertDeliveries)
    .set(
      result.ok
        ? { status: 'sent', providerRef: result.providerRef ?? null, error: null, sentAt: now, updatedAt: now }
        // Bounded: a provider's error text is recorded, never a body or a key.
        : { status: 'failed', error: result.error.slice(0, 500), updatedAt: now },
    )
    .where(
      and(
        eq(governanceAlertDeliveries.id, claim.id),
        eq(governanceAlertDeliveries.attempts, claim.attempts),
        eq(governanceAlertDeliveries.status, 'sending'),
      ),
    );
}

/**
 * The in-app delivery: the row is the delivery, because the banner reads it.
 * Nothing leaves the process, so there is nothing to claim first; it is
 * written `sent` in one statement, or a row left in any other state is set to
 * `sent`. True when this call recorded it.
 */
export async function recordInAppDelivery(
  db: DrizzleDb,
  input: { alertId: string; userId: string; orgId: string; nowMs: number },
): Promise<boolean> {
  const now = new Date(input.nowMs);
  const inserted = await db
    .insert(governanceAlertDeliveries)
    .values({
      id: `gad_${randomUUID()}`,
      alertId: input.alertId,
      userId: input.userId,
      orgId: input.orgId,
      channel: 'in_app',
      status: 'sent',
      attempts: 1,
      sentAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: governanceAlertDeliveries.id });
  if (inserted[0]) return true;
  const repaired = await db
    .update(governanceAlertDeliveries)
    .set({ status: 'sent', attempts: sql`${governanceAlertDeliveries.attempts} + 1`, error: null, sentAt: now, updatedAt: now })
    .where(
      and(
        eq(governanceAlertDeliveries.alertId, input.alertId),
        eq(governanceAlertDeliveries.userId, input.userId),
        eq(governanceAlertDeliveries.channel, 'in_app'),
        ne(governanceAlertDeliveries.status, 'sent'),
      ),
    )
    .returning({ id: governanceAlertDeliveries.id });
  return repaired.length > 0;
}

/** The banner for one person: alerts still shown for which the fan-out
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
        stillShown(),
      ),
    )
    .orderBy(desc(governanceAlerts.createdAt))
    .limit(5);
  return rows.map((row: { id: string; kind: string; summary: string; detail: string; reviewPath: string }) => ({ ...row, kind: row.kind as GovernanceAlertKind }));
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
