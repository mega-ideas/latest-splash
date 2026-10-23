/**
 * The governance alert monitor's I/O half (v2, brief 3.5). The decision is
 * lib/server/governance-events.ts, which is pure and tested; this file only
 * gathers its inputs, records what it decided, and tells the owners.
 *
 *   - the canonical ids: SPLASH_UPGRADE_DELAY_PACKAGE_ID,
 *     SPLASH_UPGRADE_WRAPPER_ID, SPLASH_CORE_PACKAGE_ID (the core's ORIGINAL
 *     id; every governance event names it, after any number of upgrades) and
 *     SPLASH_COMPLIANCE_CONFIG_ID. From the environment only (lib/env.ts says
 *     why). Any one missing and the monitor does not run: it answers
 *     `ok: false`, the route answers 502, and the scheduler's failure alerting
 *     sees a watchman who is not watching;
 *   - the events: Sui GraphQL, by type, the same endpoint the operator outflow
 *     monitor reads. The type filter narrows the query; the classifier checks
 *     every event again and does not trust it;
 *   - the owners: every `admin` membership (lib/server/governance-alerts-store.ts);
 *   - delivery: in-app (the row the dashboard banner reads), email through the
 *     existing transport (lib/auth/email-transport.ts), and WhatsApp through
 *     lib/server/whatsapp.ts, only to a verified number.
 *
 * Idempotent across runs and instances: alerts are unique on (digest, event
 * seq) and deliveries on (alert, owner, channel), and a delivery is claimed
 * before it is sent. Every active alert is fanned out on every run, so an
 * owner added during the notice window is told on the next run. Channels go
 * in order, in-app for everyone first, so a run cut short by its time limit
 * still leaves every owner the banner.
 *
 * A failed send is recorded and the next one is tried; it is claimed again on
 * a later run, up to MAX_DELIVERY_ATTEMPTS.
 */
import 'server-only';

import { resolveEmailTransport, type EmailMessage } from '../auth/email-transport.ts';
import { sendOperatorAlert, type OperatorAlertSink } from './operator-alerts.ts';
import {
  classifyGovernanceEvents,
  configurationDrift,
  watchedEventTypes,
  type GovernanceEvent,
  type GovernancePolicy,
  type GovernanceReport,
  type IgnoredEvent,
} from './governance-events.ts';
import {
  MAX_DELIVERY_ATTEMPTS,
  claimGovernanceDelivery,
  deliveryStateFor,
  finishGovernanceDelivery,
  listActiveGovernanceAlertsForStaff,
  listBusinessOwnersForStaff,
  readDeliveryStatesForStaff,
  recordGovernanceAlert,
  type BusinessOwner,
  type DeliveryChannel,
  type StoredGovernanceAlert,
} from './governance-alerts-store.ts';
import { normalizeSuiAddress } from './operator-outflows.ts';
import { sendWhatsApp } from './whatsapp.ts';

const PAGE = 50;
const MAX_PAGES = 4;
const TIMEOUT_MS = 8_000;
/** Look back as far as an alert can stay on the dashboard, so a monitor that
 *  was down for days still records what it missed while it still matters. */
const DEFAULT_WINDOW_MS = 9 * 24 * 60 * 60 * 1000;
const OBJECT_ID = /^0x[0-9a-fA-F]{64}$/;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export type GovernanceEventReader = (types: string[], sinceMs: number) => Promise<GovernanceEvent[]>;
export type EmailSender = (message: EmailMessage) => Promise<{ providerRef: string | null }>;
export type WhatsAppSender = (to: string, body: string) => Promise<{ sent: true; providerRef: string } | { sent: false; reason: string }>;

export type DeliveryTally = { sent: number; failed: number; skipped: number };

export type GovernanceMonitorResult =
  | {
      ok: true;
      scanned: number;
      report: GovernanceReport;
      /** Alerts this run recorded for the first time. */
      recorded: string[];
      /** Alerts still active, which this run fanned out. */
      active: string[];
      owners: number;
      deliveries: Record<DeliveryChannel, DeliveryTally>;
      /** Genuine wrapper events the configuration does not cover. */
      drift: IgnoredEvent[];
    }
  | { ok: false; reason: string };

/** The canonical ids, or every reason they are not usable. */
export function readGovernanceConfig(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; policy: GovernancePolicy } | { ok: false; reason: string } {
  const required = {
    SPLASH_UPGRADE_DELAY_PACKAGE_ID: (env.SPLASH_UPGRADE_DELAY_PACKAGE_ID ?? '').trim(),
    SPLASH_UPGRADE_WRAPPER_ID: (env.SPLASH_UPGRADE_WRAPPER_ID ?? '').trim(),
    SPLASH_CORE_PACKAGE_ID: (env.SPLASH_CORE_PACKAGE_ID ?? '').trim(),
    SPLASH_COMPLIANCE_CONFIG_ID: (env.SPLASH_COMPLIANCE_CONFIG_ID ?? '').trim(),
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  const malformed = Object.entries(required).filter(([, v]) => v && !OBJECT_ID.test(v)).map(([k]) => k);
  if (missing.length || malformed.length) {
    const parts = [
      missing.length ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not configured` : '',
      malformed.length ? `${malformed.join(', ')} ${malformed.length === 1 ? 'is' : 'are'} not a 0x + 64 hex id` : '',
    ].filter(Boolean);
    return {
      ok: false,
      reason: `governance alerts are not configured: ${parts.join('; ')}. Without the canonical ids no event can be told apart from a spoof, so none is alerted.`,
    };
  }
  return {
    ok: true,
    policy: {
      upgradeDelayPackageId: normalizeSuiAddress(required.SPLASH_UPGRADE_DELAY_PACKAGE_ID),
      wrapperId: normalizeSuiAddress(required.SPLASH_UPGRADE_WRAPPER_ID),
      corePackageId: normalizeSuiAddress(required.SPLASH_CORE_PACKAGE_ID),
      complianceConfigId: normalizeSuiAddress(required.SPLASH_COMPLIANCE_CONFIG_ID),
    },
  };
}

const QUERY = `query GovernanceEvents($type: String!, $last: Int!, $before: String) {
  events(last: $last, before: $before, filter: { type: $type }) {
    pageInfo { hasPreviousPage startCursor }
    nodes {
      sequenceNumber
      timestamp
      transaction { digest }
      contents { type { repr } json }
    }
  }
}`;

type GqlEventNode = {
  sequenceNumber?: number | null;
  timestamp?: string | null;
  transaction?: { digest?: string | null } | null;
  contents?: { type?: { repr?: string | null } | null; json?: unknown } | null;
};

/** One GraphQL node as the classifier's input, or null when the indexer has
 *  not tied it to a transaction yet. */
export function toGovernanceEvent(node: GqlEventNode): GovernanceEvent | null {
  const digest = node.transaction?.digest ?? '';
  const type = node.contents?.type?.repr ?? '';
  if (!digest || !type || typeof node.sequenceNumber !== 'number') return null;
  const timestamp = node.timestamp ? Date.parse(node.timestamp) : NaN;
  const json = node.contents?.json;
  return {
    digest,
    eventSeq: node.sequenceNumber,
    type,
    timestampMs: Number.isFinite(timestamp) ? timestamp : null,
    json: json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null,
  };
}

function defaultEndpoint(): string {
  const configured = process.env.SUI_GRAPHQL_URL?.trim();
  if (configured) return configured;
  return process.env.SUI_NETWORK === 'mainnet' ? 'https://graphql.mainnet.sui.io/graphql' : 'https://graphql.testnet.sui.io/graphql';
}

export function graphqlGovernanceReader(fetcher: Fetcher = fetch, endpoint = defaultEndpoint()): GovernanceEventReader {
  async function readType(type: string, sinceMs: number): Promise<GovernanceEvent[]> {
    const out: GovernanceEvent[] = [];
    let before: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { type, last: PAGE, before } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`the Sui indexer answered HTTP ${res.status}`);
      const body = (await res.json()) as {
        data?: { events?: { pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null }; nodes?: GqlEventNode[] } | null };
        errors?: Array<{ message?: string }>;
      };
      if (body.errors?.length) throw new Error(`the Sui indexer refused the query: ${body.errors[0]?.message ?? 'unknown error'}`);
      const events = body.data?.events;
      if (!events) break;
      let reachedWindowStart = false;
      // `last` returns the page oldest-first; walk it newest-first.
      for (const node of [...(events.nodes ?? [])].reverse()) {
        const parsed = toGovernanceEvent(node);
        if (!parsed) continue;
        if (parsed.timestampMs != null && parsed.timestampMs < sinceMs) {
          reachedWindowStart = true;
          break;
        }
        out.push(parsed);
      }
      if (reachedWindowStart || !events.pageInfo?.hasPreviousPage) break;
      before = events.pageInfo?.startCursor ?? null;
      if (!before) break;
    }
    return out;
  }
  return async (types, sinceMs) => (await Promise.all(types.map((type) => readType(type, sinceMs)))).flat();
}

const SUBJECTS: Record<StoredGovernanceAlert['kind'], string> = {
  upgrade_proposed: 'An update to the Splash payment contract has been announced',
  upgrade_authorized: 'An update to the Splash payment contract has taken effect',
  owner_change_proposed: 'A change to who can update the Splash payment contract has been announced',
  registry_addition_proposed: 'An addition to the Splash payment contract has been announced',
  registry_addition_activated: 'An addition to the Splash payment contract has taken effect',
};

function reviewUrl(appUrl: string, alert: StoredGovernanceAlert): string {
  return `${appUrl.replace(/\/+$/, '')}${alert.reviewPath}`;
}

/** The email. The digest is there so an owner can check the announcement on
 *  any Sui explorer without trusting this message, or us. */
export function governanceEmail(alert: StoredGovernanceAlert, to: string, appUrl: string): EmailMessage {
  const link = reviewUrl(appUrl, alert);
  const text = [
    alert.summary,
    alert.detail,
    'Review your spending rules and allowances here:',
    link,
    `You can check this announcement yourself on any Sui explorer: transaction ${alert.digest}.`,
  ].join('\n\n');
  return { to, subject: SUBJECTS[alert.kind], text, link };
}

export function governanceWhatsApp(alert: StoredGovernanceAlert, appUrl: string): string {
  return `${alert.summary} Review your spending rules and allowances: ${reviewUrl(appUrl, alert)}`;
}

const driftAlerted = new Set<string>();

export async function runGovernanceAlertMonitor(deps: {
  now?: number;
  windowMs?: number;
  env?: NodeJS.ProcessEnv;
  db?: Db;
  readEvents?: GovernanceEventReader;
  sendEmail?: EmailSender;
  sendWhatsApp?: WhatsAppSender;
  alert?: OperatorAlertSink;
  appUrl?: string;
} = {}): Promise<GovernanceMonitorResult> {
  const env = deps.env ?? process.env;
  const config = readGovernanceConfig(env);
  if (!config.ok) return { ok: false, reason: config.reason };
  if (!deps.db && !process.env.DATABASE_URL) {
    return { ok: false, reason: 'DATABASE_URL is not configured, so there are no business owners to alert and nowhere to record that they were.' };
  }

  const now = deps.now ?? Date.now();
  const sinceMs = now - (deps.windowMs ?? DEFAULT_WINDOW_MS);
  const readEvents = deps.readEvents ?? graphqlGovernanceReader();
  const appUrl = deps.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  let events: GovernanceEvent[];
  try {
    events = await readEvents(watchedEventTypes(config.policy), sinceMs);
  } catch (error) {
    return { ok: false, reason: `the monitor could not read its inputs: ${error instanceof Error ? error.message : String(error)}` };
  }
  const report = classifyGovernanceEvents(events, config.policy);

  // The transport is resolved once, lazily: a misconfigured one fails each
  // email delivery (recorded, retried later) rather than the whole run.
  let emailSender: EmailSender | null = deps.sendEmail ?? null;
  const sendEmail: EmailSender = async (message) => {
    emailSender ??= (m) => resolveEmailTransport(env).sendMessage(m);
    return emailSender(message);
  };
  const whatsapp: WhatsAppSender = deps.sendWhatsApp ?? ((to, body) => sendWhatsApp(to, body, env));

  try {
    const db = deps.db ?? (await import('../db/client.ts')).getDb();
    const recorded: string[] = [];
    for (const alert of report.alerts) {
      const { alert: stored, created } = await recordGovernanceAlert(db, alert);
      if (created) recorded.push(stored.id);
    }

    const active = await listActiveGovernanceAlertsForStaff(db, now);
    const owners = await listBusinessOwnersForStaff(db);
    const states = await readDeliveryStatesForStaff(db, active.map((a) => a.id));
    const deliveries: Record<DeliveryChannel, DeliveryTally> = {
      in_app: { sent: 0, failed: 0, skipped: 0 },
      email: { sent: 0, failed: 0, skipped: 0 },
      whatsapp: { sent: 0, failed: 0, skipped: 0 },
    };

    const send: Record<DeliveryChannel, (alert: StoredGovernanceAlert, owner: BusinessOwner) => Promise<{ ok: true; providerRef?: string | null } | { ok: false; error: string }>> = {
      // The row is the delivery: the dashboard banner reads it.
      in_app: async () => ({ ok: true }),
      email: async (alert, owner) => ({ ok: true, ...(await sendEmail(governanceEmail(alert, owner.email, appUrl))) }),
      whatsapp: async (alert, owner) => {
        const result = await whatsapp(owner.whatsappE164!, governanceWhatsApp(alert, appUrl));
        return result.sent ? { ok: true, providerRef: result.providerRef } : { ok: false, error: result.reason };
      },
    };

    for (const channel of ['in_app', 'email', 'whatsapp'] as const) {
      for (const alert of active) {
        for (const owner of owners) {
          // Never to anyone without a verified number. Not a skip: there is
          // no channel to deliver on.
          if (channel === 'whatsapp' && !owner.whatsappE164) continue;
          const state = deliveryStateFor(states, alert.id, owner.userId, channel);
          if (state && (state.status !== 'failed' || state.attempts >= MAX_DELIVERY_ATTEMPTS)) {
            deliveries[channel].skipped += 1;
            continue;
          }
          const claim = await claimGovernanceDelivery(db, { alertId: alert.id, userId: owner.userId, orgId: owner.orgId, channel });
          if (!claim) {
            deliveries[channel].skipped += 1;
            continue;
          }
          let outcome: { ok: true; providerRef?: string | null } | { ok: false; error: string };
          try {
            outcome = await send[channel](alert, owner);
          } catch (error) {
            outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          await finishGovernanceDelivery(db, claim.id, outcome);
          deliveries[channel][outcome.ok ? 'sent' : 'failed'] += 1;
        }
      }
    }

    const drift = configurationDrift(report);
    const alertSink = deps.alert ?? sendOperatorAlert;
    for (const event of drift) {
      const key = `${event.digest}|${event.eventSeq}`;
      if (driftAlerted.has(key)) continue;
      driftAlerted.add(key);
      await alertSink({
        kind: 'governance_config_drift',
        severity: 'critical',
        digest: event.digest,
        reason: event.note ?? event.reason,
        detail: { eventSeq: event.eventSeq, type: event.type },
      });
    }

    return {
      ok: true,
      scanned: events.length,
      report,
      recorded,
      active: active.map((a) => a.id),
      owners: owners.length,
      deliveries,
      drift,
    };
  } catch (error) {
    return { ok: false, reason: `the monitor could not record or deliver its alerts: ${error instanceof Error ? error.message : String(error)}` };
  }
}
