/**
 * The near-threshold alert monitor's I/O half (v2 Phase 2). The decision is
 * lib/server/near-threshold.ts, which is pure; this file reads each
 * business's spending rules from the chain, records what it decided, and
 * emails that business's owners.
 *
 * Per business, never across: the view, the alerts and the owners are each
 * read for one org, and an alert is recorded under that org only. A business
 * whose rules cannot be read is reported as an error and the others still
 * run; the route answers 502 when there is any, so the scheduler's failure
 * alerting sees a monitor that is not watching. A business with no wallet or
 * no spending policy yet is skipped.
 *
 * Idempotent: an alert is unique on (org, content key), an email on (alert,
 * owner, channel), claimed before it is sent. Detective only: nothing here
 * changes a rule, blocks a payment or signs anything.
 */
import 'server-only';

import { resolveEmailTransport, type EmailMessage } from '../auth/email-transport.ts';
import { deriveNearThresholdAlerts, type NameOf } from './near-threshold.ts';
import {
  claimAlertEmail,
  finishAlertEmail,
  listBusinessesWithAccountsForStaff,
  listOrgOwners,
  recordSpendRuleAlert,
  type DrizzleDb,
} from './near-threshold-store.ts';
import type { SpendView } from './spend-rules-index.ts';

/** Where the owner reviews the rules. The page arrives in Phase 3. */
export const SPEND_RULES_PATH = '/dashboard/settings/spending-rules';

export type ViewRead = { ok: true; view: SpendView; nameOf?: NameOf } | { ok: false; skip?: boolean; error: string };

export type NearThresholdResult =
  | {
      ok: true;
      businesses: number;
      alerts: number;
      recorded: number;
      deliveries: { sent: number; failed: number; skipped: number };
      errors: Array<{ orgId: string; error: string }>;
    }
  | { ok: false; reason: string };

export function nearThresholdEmail(alert: { summary: string; detail: string }, to: string, appUrl: string): EmailMessage {
  const link = `${appUrl.replace(/\/+$/, '')}${SPEND_RULES_PATH}`;
  return {
    to,
    subject: 'A spending pattern to check in your Splash spending rules',
    text: [alert.summary, alert.detail, 'Your spending rules:', link].join('\n\n'),
    link,
  };
}

export async function runNearThresholdMonitor(deps: {
  db?: DrizzleDb;
  now?: number;
  env?: NodeJS.ProcessEnv;
  appUrl?: string;
  /** The businesses to look at; by default every one with an on-chain account. */
  orgs?: string[];
  readView: (orgId: string) => Promise<ViewRead>;
  sendEmail?: (message: EmailMessage) => Promise<{ providerRef: string | null }>;
}): Promise<NearThresholdResult> {
  if (!deps.db && !process.env.DATABASE_URL) {
    return { ok: false, reason: 'DATABASE_URL is not configured, so there are no owners to tell and nowhere to record that they were told.' };
  }
  const env = deps.env ?? process.env;
  const clock = () => deps.now ?? Date.now();
  const appUrl = deps.appUrl ?? env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  let sender = deps.sendEmail ?? null;
  const sendEmail = async (m: EmailMessage) => {
    sender ??= (x) => resolveEmailTransport(env).sendMessage(x);
    return sender(m);
  };
  try {
    const db = deps.db ?? ((await import('../db/client.ts')).getDb() as unknown as DrizzleDb);
    const orgs = deps.orgs ?? (await listBusinessesWithAccountsForStaff(db));
    const errors: Array<{ orgId: string; error: string }> = [];
    const deliveries = { sent: 0, failed: 0, skipped: 0 };
    let alertCount = 0;
    let recorded = 0;
    for (const orgId of orgs) {
      let read: ViewRead;
      try {
        read = await deps.readView(orgId);
      } catch (error) {
        read = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (!read.ok) {
        if (!read.skip) errors.push({ orgId, error: read.error });
        continue;
      }
      const alerts = deriveNearThresholdAlerts(read.view, { nameOf: read.nameOf });
      if (alerts.length === 0) continue;
      alertCount += alerts.length;
      const owners = await listOrgOwners(db, orgId);
      for (const alert of alerts) {
        const { alert: stored, created } = await recordSpendRuleAlert(db, orgId, alert, clock());
        if (created) recorded += 1;
        for (const owner of owners) {
          const claim = await claimAlertEmail(db, { alertId: stored.id, orgId, userId: owner.userId, nowMs: clock() });
          if (!claim) {
            deliveries.skipped += 1;
            continue;
          }
          let outcome: { ok: true; providerRef?: string | null } | { ok: false; error: string };
          try {
            outcome = { ok: true, ...(await sendEmail(nearThresholdEmail(stored, owner.email, appUrl))) };
          } catch (error) {
            outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          await finishAlertEmail(db, claim, outcome, clock());
          deliveries[outcome.ok ? 'sent' : 'failed'] += 1;
        }
      }
    }
    return { ok: true, businesses: orgs.length, alerts: alertCount, recorded, deliveries, errors };
  } catch (error) {
    return { ok: false, reason: `the monitor could not record or deliver its alerts: ${error instanceof Error ? error.message : String(error)}` };
  }
}
