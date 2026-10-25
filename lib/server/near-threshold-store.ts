/**
 * Postgres access for near-threshold alerts (v2 Phase 2; migration 0051).
 *
 * Every read a customer reaches takes the org (`listSpendRuleAlertsForOrg`):
 * an alert of another business is never returned. The cron's cross-tenant
 * read is the list of businesses to look at, and says so in its name
 * (`*ForStaff`, WS2).
 *
 * An email is claimed by writing its delivery row as `sending` before it is
 * sent, so two runs cannot both send it; a failed send may be claimed again
 * up to MAX_ALERT_EMAIL_ATTEMPTS times, a `sent` one never.
 */
import { createHash, randomUUID } from 'node:crypto';

import { and, asc, desc, eq, gt, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { memberships, organizations, spendRuleAlertDeliveries, spendRuleAlerts, users } from '../db/schema.ts';
import type * as schemaModule from '../db/schema.ts';
import type { NearThresholdAlert } from './near-threshold.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

export const MAX_ALERT_EMAIL_ATTEMPTS = 3;
/** A claim older than this belongs to a run that died, and may be claimed again. */
export const ALERT_EMAIL_LEASE_MS = 10 * 60 * 1000;

export type StoredSpendRuleAlert = {
  id: string;
  kind: NearThresholdAlert['kind'];
  severity: NearThresholdAlert['severity'];
  policyId: string;
  recipient: string | null;
  beneficiary: string | null;
  spenders: string[];
  countedMinor: string;
  thresholdMinor: string;
  payments: number;
  summary: string;
  detail: string;
  activeUntil: string;
  createdAt: string;
};

type Row = typeof spendRuleAlerts.$inferSelect;

function toStored(row: Row): StoredSpendRuleAlert {
  return {
    id: row.id,
    kind: row.kind as StoredSpendRuleAlert['kind'],
    severity: row.severity as StoredSpendRuleAlert['severity'],
    policyId: row.policyId,
    recipient: row.recipient,
    beneficiary: row.beneficiary,
    spenders: row.spenders as string[],
    countedMinor: row.countedMinor,
    thresholdMinor: row.thresholdMinor,
    payments: row.payments,
    summary: row.summary,
    detail: row.detail,
    activeUntil: row.activeUntil.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** `sra_` + a hash of the org and the content key: the same everywhere. */
export function spendRuleAlertId(orgId: string, contentKey: string): string {
  return `sra_${createHash('sha256').update(`${orgId}\u0000${contentKey}`).digest('hex').slice(0, 40)}`;
}

/** Record an alert for one business, or learn it was recorded already. */
export async function recordSpendRuleAlert(db: DrizzleDb, orgId: string, alert: NearThresholdAlert, nowMs: number): Promise<{ alert: StoredSpendRuleAlert; created: boolean }> {
  const now = new Date(nowMs);
  const id = spendRuleAlertId(orgId, alert.key);
  const inserted = await db
    .insert(spendRuleAlerts)
    .values({
      id,
      orgId,
      contentKey: alert.key,
      kind: alert.kind,
      severity: alert.severity,
      policyId: alert.policyId,
      recipient: alert.recipient,
      beneficiary: alert.beneficiary,
      spenders: alert.spenders,
      countedMinor: alert.countedMinor,
      thresholdMinor: alert.thresholdMinor,
      payments: alert.payments,
      summary: alert.summary,
      detail: alert.detail,
      activeUntil: new Date(Number(alert.activeUntilMs)),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: spendRuleAlerts.id });
  const rows = await db.select().from(spendRuleAlerts).where(and(eq(spendRuleAlerts.orgId, orgId), eq(spendRuleAlerts.contentKey, alert.key))).limit(1);
  if (!rows[0]) throw new Error('a spending-rule alert was neither recorded nor found');
  return { alert: toStored(rows[0]), created: inserted.length > 0 };
}

/** This business's alerts still shown at `nowMs`, newest first. */
export async function listSpendRuleAlertsForOrg(db: DrizzleDb, orgId: string, nowMs: number): Promise<StoredSpendRuleAlert[]> {
  const rows = await db
    .select()
    .from(spendRuleAlerts)
    .where(and(eq(spendRuleAlerts.orgId, orgId), gt(spendRuleAlerts.activeUntil, new Date(nowMs))))
    .orderBy(desc(spendRuleAlerts.createdAt))
    .limit(50);
  return rows.map(toStored);
}

/** Every business with an on-chain account: the ones that can have rules. Cross-tenant, for the cron. */
export async function listBusinessesWithAccountsForStaff(db: DrizzleDb): Promise<string[]> {
  const rows = await db.select({ id: organizations.id }).from(organizations).where(isNotNull(organizations.suiBusinessAccountId)).orderBy(asc(organizations.id));
  return rows.map((r: { id: string }) => r.id);
}

/** This business's owners (role admin), with their email. */
export async function listOrgOwners(db: DrizzleDb, orgId: string): Promise<Array<{ userId: string; email: string; name: string }>> {
  return db
    .select({ userId: users.id, email: users.email, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'admin')))
    .orderBy(asc(users.id));
}

/** Claim one owner's email about one alert, or null when it is taken or done. */
export async function claimAlertEmail(db: DrizzleDb, input: { alertId: string; orgId: string; userId: string; nowMs: number }): Promise<{ id: string; attempts: number } | null> {
  const now = new Date(input.nowMs);
  const inserted = await db
    .insert(spendRuleAlertDeliveries)
    .values({ id: `srd_${randomUUID()}`, alertId: input.alertId, orgId: input.orgId, userId: input.userId, channel: 'email', status: 'sending', attempts: 1, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning({ id: spendRuleAlertDeliveries.id, attempts: spendRuleAlertDeliveries.attempts });
  if (inserted[0]) return inserted[0];
  const retried = await db
    .update(spendRuleAlertDeliveries)
    .set({ status: 'sending', attempts: sql`${spendRuleAlertDeliveries.attempts} + 1`, error: null, updatedAt: now })
    .where(
      and(
        eq(spendRuleAlertDeliveries.alertId, input.alertId),
        eq(spendRuleAlertDeliveries.userId, input.userId),
        eq(spendRuleAlertDeliveries.channel, 'email'),
        lt(spendRuleAlertDeliveries.attempts, MAX_ALERT_EMAIL_ATTEMPTS),
        or(
          eq(spendRuleAlertDeliveries.status, 'failed'),
          and(eq(spendRuleAlertDeliveries.status, 'sending'), lt(spendRuleAlertDeliveries.updatedAt, new Date(input.nowMs - ALERT_EMAIL_LEASE_MS))),
        ),
      ),
    )
    .returning({ id: spendRuleAlertDeliveries.id, attempts: spendRuleAlertDeliveries.attempts });
  return retried[0] ?? null;
}

/** Record how a claimed send ended; only the claim that is still current counts. */
export async function finishAlertEmail(
  db: DrizzleDb,
  claim: { id: string; attempts: number },
  result: { ok: true; providerRef?: string | null } | { ok: false; error: string },
  nowMs: number,
): Promise<void> {
  const now = new Date(nowMs);
  await db
    .update(spendRuleAlertDeliveries)
    .set(result.ok ? { status: 'sent', providerRef: result.providerRef ?? null, sentAt: now, updatedAt: now } : { status: 'failed', error: result.error.slice(0, 500), updatedAt: now })
    .where(and(eq(spendRuleAlertDeliveries.id, claim.id), eq(spendRuleAlertDeliveries.attempts, claim.attempts), eq(spendRuleAlertDeliveries.status, 'sending')));
}
