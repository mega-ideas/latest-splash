/**
 * Which governance events every business owner must be told about (v2, brief
 * 3.5; docs/v2/phase1-move-design.md §7).
 *
 * Pure: events in, alerts out. The cron route (app/api/cron/governance-alerts)
 * reads recent events from Sui GraphQL and hands them here; the tests hand it
 * synthetic ones. Nothing here touches the network or the database.
 *
 * ─── Anti-spoofing is the whole job ─────────────────────────────────────────
 *
 * `upgrade_delay::wrap` is public. Anyone can wrap an UpgradeCap of their own
 * and emit a perfectly formed `UpgradeProposed`, and anyone can publish a
 * package with a module called `upgrade_delay` and a struct called
 * `UpgradeProposed`. An alert built from either would put a fake "review your
 * allowances" message, with our link in it, in front of every owner. So an
 * event becomes an alert only when ALL of these hold:
 *
 *   1. its Move type is defined in the canonical package: splash_upgrade_delay
 *      for the upgrade and owner events, splash_core for the registry events
 *      (address compared in canonical 64-hex form, module and name exactly);
 *   2. upgrade and owner events: `wrapper_id` is the canonical wrapper, and
 *      `package` (where the event has one) is splash_core's original id;
 *   3. registry events: `config_id` is the canonical compliance config.
 *
 * Everything else is reported in `ignored`, with its reason, and never alerts.
 * The indexer query already filters by type; that filter is not trusted.
 *
 * ─── One core id, the original, for good ────────────────────────────────────
 *
 * `upgrade_delay::wrap` records `package::upgrade_package(&cap)` once, while
 * the cap is still at version 1, and every event after that carries that
 * recorded id, not the cap's current package. The watched registry types are
 * all defined in the first v2 publish, so their type address is the original
 * id too, after any number of upgrades. A canonical-wrapper event naming any
 * other package therefore means SPLASH_CORE_PACKAGE_ID is not the original id
 * (set to a later version, say). It is ignored as `package_not_canonical`, and
 * the monitor treats it as configuration drift: the route answers 502 so a
 * person fixes the id, instead of owners silently missing an announcement.
 */
import { normalizeSuiAddress } from './operator-outflows.ts';

/** Where every governance alert sends the owner. The page arrives in Phase 3. */
export const REVIEW_PATH = '/dashboard/settings/spending-rules';

const DAY_MS = 86_400_000;
/** An alert stays on the dashboard for eight days after it was announced… */
const SHOW_AFTER_ANNOUNCE_MS = 8 * DAY_MS;
/** …or seven days after it could take effect, when that is later. That is
 *  the window in which the change can still be put into force on chain. */
const SHOW_AFTER_ETA_MS = 7 * DAY_MS;

export type GovernanceEvent = {
  /** The transaction digest. */
  digest: string;
  /** The event's position among its transaction's events. */
  eventSeq: number;
  /** The event's Move type as the indexer reports it: `0xPKG::module::Name`. */
  type: string;
  /** The checkpoint timestamp; null when the indexer gave none. */
  timestampMs: number | null;
  /** The event's fields as Sui GraphQL renders them (`MoveValue.json`). */
  json: Record<string, unknown> | null;
};

export type GovernancePolicy = {
  upgradeDelayPackageId: string;
  wrapperId: string;
  /** splash_core's original id: the one its first publish created. */
  corePackageId: string;
  complianceConfigId: string;
};

export type GovernanceAlertKind =
  | 'upgrade_proposed'
  | 'upgrade_authorized'
  | 'owner_change_proposed'
  | 'registry_addition_proposed'
  | 'registry_addition_activated';

/** 1 accepted asset, 2 settlement app, 3 bridge adapter (compliance_config). */
export type RegistryKind = 1 | 2 | 3;

export type GovernanceAlert = {
  kind: GovernanceAlertKind;
  digest: string;
  eventSeq: number;
  /** The event's type, normalized. */
  eventType: string;
  /** When the transaction was finalized. */
  occurredAtMs: number | null;
  /** When it was announced on chain (proposals only). */
  proposedAtMs: number | null;
  /** When it can take effect (proposals only). */
  etaMs: number | null;
  /** The dashboard shows it until then. */
  activeUntilMs: number;
  /** The bytecode digest of the announced upgrade, 0x + 64 hex. */
  bytecodeDigest: string | null;
  /** The upgrade policy the cap enforces: 0 compatible, 128 additive, 192 dependency-only. */
  upgradePolicy: number | null;
  registry: RegistryKind | null;
  typeName: string | null;
  newOwner: string | null;
  /** Plain sentences, sentence case: what happened, when, what to do. */
  summary: string;
  /** What kind of change it is: the diff summary owners are given. */
  detail: string;
  reviewPath: string;
};

export type IgnoredReason =
  | 'not_watched'
  | 'type_not_canonical'
  | 'wrapper_not_canonical'
  | 'package_not_canonical'
  | 'config_not_canonical'
  | 'malformed';

export type IgnoredEvent = { digest: string; eventSeq: number; type: string; reason: IgnoredReason; note?: string };

export type GovernanceReport = { alerts: GovernanceAlert[]; ignored: IgnoredEvent[] };

/** What the dashboard banner shows. Crosses the server/client boundary. */
export type GovernanceBannerAlert = {
  id: string;
  kind: GovernanceAlertKind;
  summary: string;
  detail: string;
  reviewPath: string;
};

type Source = 'upgrade_delay' | 'core';

const WATCHED: Record<string, { module: string; source: Source; kind: GovernanceAlertKind }> = {
  UpgradeProposed: { module: 'upgrade_delay', source: 'upgrade_delay', kind: 'upgrade_proposed' },
  UpgradeAuthorized: { module: 'upgrade_delay', source: 'upgrade_delay', kind: 'upgrade_authorized' },
  OwnerChangeProposed: { module: 'upgrade_delay', source: 'upgrade_delay', kind: 'owner_change_proposed' },
  RegistryAdditionProposed: { module: 'compliance_config', source: 'core', kind: 'registry_addition_proposed' },
  RegistryAdditionActivated: { module: 'compliance_config', source: 'core', kind: 'registry_addition_activated' },
};

/** The fully qualified types the monitor asks the indexer for. */
export function watchedEventTypes(policy: GovernancePolicy): string[] {
  const types: string[] = [];
  for (const [name, spec] of Object.entries(WATCHED)) {
    const pkg = spec.source === 'upgrade_delay' ? policy.upgradeDelayPackageId : policy.corePackageId;
    types.push(`${normalizeSuiAddress(pkg)}::${spec.module}::${name}`);
  }
  return [...new Set(types)];
}

const HEX_ID = /^0x[0-9a-fA-F]{1,64}$/;

/** A canonical 0x + 64 hex id, or null for anything that is not an id. */
function canonicalId(value: unknown): string | null {
  return typeof value === 'string' && HEX_ID.test(value.trim()) ? normalizeSuiAddress(value) : null;
}

function parseType(repr: string): { address: string; module: string; name: string } | null {
  const parts = repr.trim().split('::');
  if (parts.length !== 3) return null;
  const address = canonicalId(parts[0]);
  if (!address || !parts[1] || !parts[2]) return null;
  return { address, module: parts[1], name: parts[2] };
}

/** u64 fields arrive as decimal strings; milliseconds fit a JS number. */
function millis(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,16}$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

function smallInt(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
}

/** `vector<u8>`: Base64 from GraphQL, a byte array from JSON-RPC, or 0x hex. */
function bytes32Hex(value: unknown): string | null {
  let hex: string | null = null;
  if (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    hex = (value as number[]).map((b) => b.toString(16).padStart(2, '0')).join('');
  } else if (typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value)) {
    hex = value.slice(2).toLowerCase();
  } else if (typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    hex = Buffer.from(value, 'base64').toString('hex');
  }
  return hex && hex.length === 64 ? `0x${hex}` : null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `26 October 2026, 14:05 UTC`. Fixed, so every channel says the same. */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

const ACT = 'Review your spending rules and revoke any allowance you are not comfortable with';

/**
 * What the update is allowed to change, in an owner's words. The additive
 * sentence is the design's own limit (phase1-move-design.md §5): an added core
 * function could still alter a payment waiting to be made, but SpendPolicy is
 * not in splash_core, so no core upgrade can add a recipient, raise a limit or
 * create an allowance.
 */
function policySentence(policy: number): string {
  if (policy === 128) {
    return 'This update can only add to the contract. Existing functions stay as they are. Added code could still change a payment that has not been made yet, but it cannot add a recipient, raise a spending limit or create an allowance.';
  }
  if (policy === 192) return 'This update can only change the code the contract depends on.';
  if (policy === 0) return 'This update may change how existing functions work.';
  return `This update uses upgrade policy ${policy}.`;
}

const REGISTRY_NOUN: Record<RegistryKind, string> = {
  1: 'a new payment asset',
  2: 'a new app that can pay under spending rules',
  3: 'a new cross-chain bridge adapter',
};

const REGISTRY_DETAIL: Record<RegistryKind, string> = {
  1: 'Once it takes effect, payments can be made in this asset.',
  2: 'Once it takes effect, this app can pay from an allowance within your spending rules.',
  3: 'Once it takes effect, this adapter can carry payments to another blockchain.',
};

/** `0x…::usdc::USDC` → `usdc::USDC`: the readable part of a type name. */
function shortType(typeName: string): string {
  const parts = typeName.split('::');
  return parts.length >= 3 ? parts.slice(1).join('::') : typeName;
}

function activeUntil(announcedMs: number | null, etaMs: number | null): number | null {
  const candidates = [
    announcedMs != null ? announcedMs + SHOW_AFTER_ANNOUNCE_MS : null,
    etaMs != null ? etaMs + SHOW_AFTER_ETA_MS : null,
  ].filter((v): v is number => v != null);
  return candidates.length ? Math.max(...candidates) : null;
}

export function classifyGovernanceEvents(events: GovernanceEvent[], policy: GovernancePolicy): GovernanceReport {
  const upgradeDelay = normalizeSuiAddress(policy.upgradeDelayPackageId);
  const wrapper = normalizeSuiAddress(policy.wrapperId);
  const core = normalizeSuiAddress(policy.corePackageId);
  const config = normalizeSuiAddress(policy.complianceConfigId);
  const report: GovernanceReport = { alerts: [], ignored: [] };
  const seen = new Set<string>();

  for (const event of events) {
    const key = `${event.digest}|${event.eventSeq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ignore = (reason: IgnoredReason, note?: string) =>
      report.ignored.push({ digest: event.digest, eventSeq: event.eventSeq, type: event.type, reason, ...(note ? { note } : {}) });

    const type = parseType(event.type ?? '');
    if (!type) { ignore('malformed', 'the event type is not 0xPKG::module::Name'); continue; }
    const spec = WATCHED[type.name];
    if (!spec || spec.module !== type.module) { ignore('not_watched'); continue; }

    // 1. The type's own package. A look-alike module in anyone else's package
    //    stops here, whatever its fields say.
    const fromCanonical = type.address === (spec.source === 'upgrade_delay' ? upgradeDelay : core);
    if (!fromCanonical) { ignore('type_not_canonical', `defined in ${type.address}`); continue; }

    const json = event.json ?? {};
    if (!event.digest || !Number.isInteger(event.eventSeq) || event.eventSeq < 0) { ignore('malformed', 'no transaction digest or event position'); continue; }
    const eventType = `${type.address}::${type.module}::${type.name}`;
    const base = {
      kind: spec.kind,
      digest: event.digest,
      eventSeq: event.eventSeq,
      eventType,
      occurredAtMs: event.timestampMs ?? null,
      reviewPath: REVIEW_PATH,
      bytecodeDigest: null,
      upgradePolicy: null,
      registry: null,
      typeName: null,
      newOwner: null,
    } satisfies Partial<GovernanceAlert>;

    if (spec.source === 'upgrade_delay') {
      // 2. The canonical wrapper, naming core's original id.
      if (canonicalId(json.wrapper_id) !== wrapper) { ignore('wrapper_not_canonical'); continue; }
      if (spec.kind !== 'owner_change_proposed') {
        const pkg = canonicalId(json.package);
        if (pkg !== core) { ignore('package_not_canonical', `package ${pkg ?? 'missing'}`); continue; }
      }

      if (spec.kind === 'owner_change_proposed') {
        const newOwner = canonicalId(json.new_owner);
        const etaMs = millis(json.eta_ms);
        const until = activeUntil(event.timestampMs, etaMs);
        if (!newOwner || etaMs == null || until == null) { ignore('malformed', 'new_owner or eta_ms missing'); continue; }
        report.alerts.push({
          ...base,
          newOwner,
          proposedAtMs: event.timestampMs,
          etaMs,
          activeUntilMs: until,
          summary: `Splash has announced a change to who can update its payment contract. It can take effect from ${formatUtc(etaMs)}. ${ACT} before then.`,
          detail: `The new owner of the update key would be ${newOwner}, a shared account no single person can sign for. Whoever holds the key can announce updates, each with 24 hours of notice.`,
        });
        continue;
      }

      const bytecodeDigest = bytes32Hex(json.digest);
      const upgradePolicy = smallInt(json.policy);
      if (!bytecodeDigest || upgradePolicy == null) { ignore('malformed', 'digest or policy missing'); continue; }
      const diff = `${policySentence(upgradePolicy)} Code fingerprint: ${bytecodeDigest}.`;

      if (spec.kind === 'upgrade_proposed') {
        const proposedAtMs = millis(json.proposed_at_ms);
        const etaMs = millis(json.eta_ms);
        const until = activeUntil(proposedAtMs, etaMs);
        if (proposedAtMs == null || etaMs == null || until == null) { ignore('malformed', 'proposed_at_ms or eta_ms missing'); continue; }
        report.alerts.push({
          ...base,
          bytecodeDigest,
          upgradePolicy,
          proposedAtMs,
          etaMs,
          activeUntilMs: until,
          summary: `Splash has announced an update to its payment contract. It can take effect from ${formatUtc(etaMs)}. ${ACT} before then.`,
          detail: diff,
        });
      } else {
        const until = activeUntil(event.timestampMs, null);
        if (until == null) { ignore('malformed', 'no timestamp'); continue; }
        report.alerts.push({
          ...base,
          bytecodeDigest,
          upgradePolicy,
          proposedAtMs: null,
          etaMs: null,
          activeUntilMs: until,
          summary: `The announced update to Splash's payment contract has now taken effect. ${ACT}.`,
          detail: diff,
        });
      }
      continue;
    }

    // 3. Registry events: the one canonical compliance config.
    if (canonicalId(json.config_id) !== config) { ignore('config_not_canonical'); continue; }
    const registry = smallInt(json.registry);
    const typeName = typeof json.type_name === 'string' && json.type_name.trim() ? json.type_name.trim() : null;
    if ((registry !== 1 && registry !== 2 && registry !== 3) || !typeName) { ignore('malformed', 'registry or type_name invalid'); continue; }
    const noun = REGISTRY_NOUN[registry];
    const detail = `${REGISTRY_DETAIL[registry]} Full type: ${typeName}.`;

    if (spec.kind === 'registry_addition_proposed') {
      const proposedAtMs = millis(json.proposed_at_ms);
      const etaMs = millis(json.eta_ms);
      const until = activeUntil(proposedAtMs, etaMs);
      if (proposedAtMs == null || etaMs == null || until == null) { ignore('malformed', 'proposed_at_ms or eta_ms missing'); continue; }
      report.alerts.push({
        ...base,
        registry,
        typeName,
        proposedAtMs,
        etaMs,
        activeUntilMs: until,
        summary: `Splash has announced ${noun} (${shortType(typeName)}). It can take effect from ${formatUtc(etaMs)}. ${ACT} before then.`,
        detail,
      });
    } else {
      const until = activeUntil(event.timestampMs, null);
      if (until == null) { ignore('malformed', 'no timestamp'); continue; }
      report.alerts.push({
        ...base,
        registry,
        typeName,
        proposedAtMs: null,
        etaMs: null,
        activeUntilMs: until,
        summary: `Splash has added ${noun} (${shortType(typeName)}). It has now taken effect. ${ACT}.`,
        detail,
      });
    }
  }
  return report;
}

/** Ignored events that came from the canonical wrapper itself: genuine, and
 *  unalerted only because configuration lags the chain. */
export function configurationDrift(report: GovernanceReport): IgnoredEvent[] {
  return report.ignored.filter((event) => event.reason === 'package_not_canonical');
}
