/**
 * The governance alert monitor's I/O half (v2, brief 3.5). The decision is
 * lib/server/governance-events.ts, which is pure and tested; this file only
 * gathers its inputs, records what it decided, and tells the owners.
 *
 *   - the canonical ids: SPLASH_UPGRADE_DELAY_PACKAGE_ID,
 *     SPLASH_UPGRADE_WRAPPER_ID and SPLASH_COMPLIANCE_CONFIG_ID. From the
 *     environment only (lib/env.ts says why). Any one missing or malformed and
 *     the monitor does not run: it answers `ok: false`, the route answers 502,
 *     and the scheduler's failure alerting sees a watchman who is not
 *     watching. Core's original id is not configured here at all: it is read
 *     from the wrapper's own `original_package` on every run, so
 *     SPLASH_CORE_PACKAGE_ID stays free to name whichever core version the app
 *     calls;
 *   - the state: ONE Sui GraphQL query for the two objects, the same endpoint
 *     the operator outflow monitor reads. Not the event feed: anyone can fill
 *     that with look-alikes of the canonical types (governance-events.ts says
 *     why, and why a 15-minute poll of state cannot miss a change that can
 *     take effect). An object that is missing, of another type, or not
 *     readable in full is `ok: false`, and a person is paged, because owners
 *     are not being told anything until it is fixed;
 *   - the previous state: governance_watch_state, so what took effect since
 *     the last run can be told too;
 *   - the owners: every `admin` membership (lib/server/governance-alerts-store.ts);
 *   - delivery: in-app (the row the dashboard banner reads), email through the
 *     existing transport (lib/auth/email-transport.ts), and WhatsApp through
 *     lib/server/whatsapp.ts, only to a verified number.
 *
 * Idempotent across runs and instances: alerts are unique on their content
 * key, deliveries on (alert, owner, channel), and an email or WhatsApp
 * delivery is claimed before it is sent. Every alert still shown is fanned out
 * on every run, so an owner added during the notice is told on the next run.
 * Channels go in order, in-app for everyone first, so a run cut short by its
 * time limit still leaves every owner the banner.
 *
 * A failed send is recorded and the next one is tried; it is claimed again on
 * a later run, up to MAX_DELIVERY_ATTEMPTS. So is a claim whose run died
 * before finishing it, once DELIVERY_LEASE_MS has passed.
 */
import 'server-only';

import { resolveEmailTransport, type EmailMessage } from '../auth/email-transport.ts';
import { sendOperatorAlert, type OperatorAlertSink } from './operator-alerts.ts';
import {
  deriveGovernanceAlerts,
  parseGovernanceState,
  type GovernanceAlert,
  type GovernanceChainRead,
  type GovernancePolicy,
} from './governance-events.ts';
import {
  claimGovernanceDelivery,
  deliveryClaimable,
  deliveryStateFor,
  finishGovernanceDelivery,
  listActiveGovernanceAlertsForStaff,
  listBusinessOwnersForStaff,
  readDeliveryStatesForStaff,
  readWatchStateForStaff,
  recordGovernanceAlert,
  recordInAppDelivery,
  saveWatchStateForStaff,
  type BusinessOwner,
  type DeliveryChannel,
  type StoredGovernanceAlert,
} from './governance-alerts-store.ts';
import { normalizeSuiAddress } from './operator-outflows.ts';
import { sendWhatsApp } from './whatsapp.ts';

const TIMEOUT_MS = 8_000;
const OBJECT_ID = /^0x[0-9a-fA-F]{64}$/;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export type GovernanceStateReader = (policy: GovernancePolicy) => Promise<GovernanceChainRead>;
export type EmailSender = (message: EmailMessage) => Promise<{ providerRef: string | null }>;
export type WhatsAppSender = (to: string, body: string) => Promise<{ sent: true; providerRef: string } | { sent: false; reason: string }>;

export type DeliveryTally = { sent: number; failed: number; skipped: number };

export type GovernanceMonitorResult =
  | {
      ok: true;
      /** What the chain showed, in brief. */
      observed: {
        wrapper: { id: string; objectVersion: number; corePackage: string; latestPackage: string; capVersion: number; policy: number; pendingUpgrade: boolean; pendingOwnerChange: boolean };
        config: { id: string; objectVersion: number; pendingAdditions: number };
      };
      /** Every alert this state calls for. */
      alerts: GovernanceAlert[];
      /** Alerts this run recorded for the first time. */
      recorded: string[];
      /** Alerts still shown, which this run fanned out. */
      active: string[];
      owners: number;
      deliveries: Record<DeliveryChannel, DeliveryTally>;
    }
  | { ok: false; reason: string };

/** The canonical ids, or every reason they are not usable. */
export function readGovernanceConfig(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; policy: GovernancePolicy } | { ok: false; reason: string } {
  const required = {
    SPLASH_UPGRADE_DELAY_PACKAGE_ID: (env.SPLASH_UPGRADE_DELAY_PACKAGE_ID ?? '').trim(),
    SPLASH_UPGRADE_WRAPPER_ID: (env.SPLASH_UPGRADE_WRAPPER_ID ?? '').trim(),
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
      reason: `governance alerts are not configured: ${parts.join('; ')}. Without the canonical ids there is no governance state to read, so nothing is alerted.`,
    };
  }
  return {
    ok: true,
    policy: {
      upgradeDelayPackageId: normalizeSuiAddress(required.SPLASH_UPGRADE_DELAY_PACKAGE_ID),
      wrapperId: normalizeSuiAddress(required.SPLASH_UPGRADE_WRAPPER_ID),
      complianceConfigId: normalizeSuiAddress(required.SPLASH_COMPLIANCE_CONFIG_ID),
    },
  };
}

/** Both objects in one query, so they are read at the same checkpoint. */
const STATE_QUERY = `query GovernanceState($wrapper: SuiAddress!, $config: SuiAddress!) {
  wrapper: object(address: $wrapper) {
    address
    version
    owner { __typename ... on AddressOwner { address { address } } }
    asMoveObject { contents { type { repr } json } }
  }
  config: object(address: $config) {
    address
    version
    owner { __typename ... on AddressOwner { address { address } } }
    asMoveObject { contents { type { repr } json } }
  }
}`;

function defaultEndpoint(): string {
  const configured = process.env.SUI_GRAPHQL_URL?.trim();
  if (configured) return configured;
  return process.env.SUI_NETWORK === 'mainnet' ? 'https://graphql.mainnet.sui.io/graphql' : 'https://graphql.testnet.sui.io/graphql';
}

/**
 * Read the wrapper and the config. Throws on anything but a complete answer:
 * an HTTP error, a GraphQL error, or a reply without both fields. A field
 * that is present and null means the chain has no such object, which the
 * parser refuses with the setting to check.
 */
export function graphqlGovernanceStateReader(fetcher: Fetcher = fetch, endpoint = defaultEndpoint()): GovernanceStateReader {
  return async (policy) => {
    const res = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: STATE_QUERY, variables: { wrapper: policy.wrapperId, config: policy.complianceConfigId } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`the Sui indexer answered HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Record<string, unknown> | null; errors?: Array<{ message?: string }> };
    if (body.errors?.length) throw new Error(`the Sui indexer refused the query: ${body.errors[0]?.message ?? 'unknown error'}`);
    const data = body.data;
    if (!data || typeof data !== 'object' || !('wrapper' in data) || !('config' in data)) {
      throw new Error('the Sui indexer answered without the wrapper and the config');
    }
    return { wrapper: (data.wrapper ?? null) as GovernanceChainRead['wrapper'], config: (data.config ?? null) as GovernanceChainRead['config'] };
  };
}

const SUBJECTS: Record<StoredGovernanceAlert['kind'], string> = {
  upgrade_proposed: 'An update to the Splash payment contract has been announced',
  owner_change_proposed: 'A change to who can update the Splash payment contract has been announced',
  registry_addition_proposed: 'An addition to the Splash payment contract has been announced',
  upgrade_committed: 'An update to the Splash payment contract has taken effect',
  registry_addition_activated: 'An addition to the Splash payment contract has taken effect',
};

/** Where an owner can see the same thing on any Sui explorer, without
 *  trusting this message, or us. */
const ON_CHAIN: Record<StoredGovernanceAlert['kind'], string> = {
  upgrade_proposed: 'holds the pending update, its bytecode digest and when it can take effect',
  owner_change_proposed: 'holds the pending change of owner and when it can take effect',
  registry_addition_proposed: 'lists it under its pending additions, with when it can take effect',
  upgrade_committed: "shows the contract's current version and package",
  registry_addition_activated: 'lists it in its registries',
};

function reviewUrl(appUrl: string, alert: StoredGovernanceAlert): string {
  return `${appUrl.replace(/\/+$/, '')}${alert.reviewPath}`;
}

export function governanceEmail(alert: StoredGovernanceAlert, to: string, appUrl: string): EmailMessage {
  const link = reviewUrl(appUrl, alert);
  const text = [
    alert.summary,
    alert.detail,
    'Review your spending rules and allowances here:',
    link,
    `You can check this yourself on any Sui explorer: object ${alert.subjectId} ${ON_CHAIN[alert.kind]}.`,
  ].join('\n\n');
  return { to, subject: SUBJECTS[alert.kind], text, link };
}

/** The same words as the email, the digest and full type included. */
export function governanceWhatsApp(alert: StoredGovernanceAlert, appUrl: string): string {
  return `${alert.summary} ${alert.detail} Review your spending rules and allowances: ${reviewUrl(appUrl, alert)}`;
}

/** Each distinct refusal pages once per process; the 502 repeats every run. */
const paged = new Set<string>();

export async function runGovernanceAlertMonitor(deps: {
  now?: number;
  env?: NodeJS.ProcessEnv;
  db?: Db;
  readState?: GovernanceStateReader;
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
  /** The time of each claim, not of the run: a run that sends to many owners
   *  lasts long enough that measuring the lease from its start would hand a
   *  live claim to the next run. */
  const clock = () => deps.now ?? Date.now();
  const readState = deps.readState ?? graphqlGovernanceStateReader();
  const appUrl = deps.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const alertSink = deps.alert ?? sendOperatorAlert;

  let read: GovernanceChainRead;
  try {
    read = await readState(config.policy);
  } catch (error) {
    return { ok: false, reason: `the monitor could not read the governance objects: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = parseGovernanceState(read, config.policy);
  if (!parsed.ok) {
    if (!paged.has(parsed.reason)) {
      paged.add(parsed.reason);
      await alertSink({ kind: 'governance_config_mismatch', severity: 'critical', objectId: parsed.objectId, reason: parsed.reason });
    }
    return { ok: false, reason: parsed.reason };
  }
  const { wrapper, config: complianceConfig } = parsed.state;

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
    const previous = await readWatchStateForStaff(db, { wrapperId: wrapper.id, configId: complianceConfig.id });
    const derived = deriveGovernanceAlerts(parsed.state, previous, now);

    // Record first, then the state: a run that dies in between leaves the
    // stored state older, so the next run derives the same keys again.
    const recorded: string[] = [];
    for (const alert of derived.alerts) {
      const { alert: stored, created } = await recordGovernanceAlert(db, alert);
      if (created) recorded.push(stored.id);
    }
    await saveWatchStateForStaff(db, { subjectId: wrapper.id, subjectKind: 'wrapper', snapshot: derived.snapshots.wrapper, nowMs: now });
    await saveWatchStateForStaff(db, { subjectId: complianceConfig.id, subjectKind: 'config', snapshot: derived.snapshots.config, nowMs: now });

    const active = await listActiveGovernanceAlertsForStaff(db, now);
    const owners = await listBusinessOwnersForStaff(db);
    const states = await readDeliveryStatesForStaff(db, active.map((a) => a.id));
    const deliveries: Record<DeliveryChannel, DeliveryTally> = {
      in_app: { sent: 0, failed: 0, skipped: 0 },
      email: { sent: 0, failed: 0, skipped: 0 },
      whatsapp: { sent: 0, failed: 0, skipped: 0 },
    };

    const send: Record<'email' | 'whatsapp', (alert: StoredGovernanceAlert, owner: BusinessOwner) => Promise<{ ok: true; providerRef?: string | null } | { ok: false; error: string }>> = {
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
          if (channel === 'in_app') {
            // The row is the delivery: the banner reads it.
            const recordedNow = state?.status === 'sent'
              ? false
              : await recordInAppDelivery(db, { alertId: alert.id, userId: owner.userId, orgId: owner.orgId, nowMs: now });
            deliveries.in_app[recordedNow ? 'sent' : 'skipped'] += 1;
            continue;
          }
          if (state && !deliveryClaimable(state, clock())) {
            deliveries[channel].skipped += 1;
            continue;
          }
          const claim = await claimGovernanceDelivery(db, { alertId: alert.id, userId: owner.userId, orgId: owner.orgId, channel, nowMs: clock() });
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
          await finishGovernanceDelivery(db, claim, outcome, clock());
          deliveries[channel][outcome.ok ? 'sent' : 'failed'] += 1;
        }
      }
    }

    return {
      ok: true,
      observed: {
        wrapper: {
          id: wrapper.id,
          objectVersion: wrapper.objectVersion,
          corePackage: wrapper.originalPackage,
          latestPackage: wrapper.latestPackage,
          capVersion: wrapper.capVersion,
          policy: wrapper.policy,
          pendingUpgrade: wrapper.pending != null,
          pendingOwnerChange: wrapper.pendingOwner != null,
        },
        config: { id: complianceConfig.id, objectVersion: complianceConfig.objectVersion, pendingAdditions: complianceConfig.pending.length },
      },
      alerts: derived.alerts,
      recorded,
      active: active.map((a) => a.id),
      owners: owners.length,
      deliveries,
    };
  } catch (error) {
    return { ok: false, reason: `the monitor could not record or deliver its alerts: ${error instanceof Error ? error.message : String(error)}` };
  }
}
