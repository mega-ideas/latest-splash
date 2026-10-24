/**
 * What every business owner must be told about upgrade governance (v2, brief
 * 3.5; docs/v2/phase1-move-design.md §7), decided from the chain's STATE.
 *
 * Pure: two objects in, alerts out. lib/server/governance-alert-monitor.ts
 * reads them from Sui GraphQL and records what this decides; the tests hand
 * it synthetic ones. Nothing here touches the network or the database.
 *
 * ─── State, not a feed ──────────────────────────────────────────────────────
 *
 * `upgrade_delay::wrap` is public, so anyone can wrap an UpgradeCap of their
 * own and emit UpgradeProposed, OwnerChangeProposed and the rest of exactly
 * the canonical Move types, a thousand to a transaction. Any bounded walk back
 * through the global event feed for those types can be flooded until the
 * genuine announcement is out of view. So no feed is read. Every run reads the
 * two objects that ARE the governance state, and alerts from their fields:
 *
 *   - the canonical DelayedUpgradeCap (SPLASH_UPGRADE_WRAPPER_ID): `pending`
 *     (the announced upgrade's bytecode digest, when it was announced, when it
 *     can take effect), `pending_owner` (an announced move to a new governance
 *     multisig), and its cap's version, latest package and policy;
 *   - the canonical ComplianceConfig (SPLASH_COMPLIANCE_CONFIG_ID):
 *     `pending_additions` and its three registries.
 *
 * Only the wrapper's owner can change the wrapper, and only Splash's own keys
 * can change the config (an addition needs governance), so nobody else can
 * add to, or crowd out, what is read.
 *
 * A 15-minute poll of this state cannot miss a change that can take effect.
 * An upgrade, an owner change and a registry addition each sit in it, readable,
 * for at least 24 hours before the chain will put them into force
 * (`upgrade_delay::DELAY_MS`, in a package published immutable, and
 * `compliance_config::ADDITION_NOTICE_MS`, which only a core upgrade could
 * route around, and a core upgrade itself waits 24 hours on the wrapper), and for up to seven days after, so each is read
 * on many polls first. All a poll can miss is a proposal made and withdrawn
 * between two polls, which could never have taken effect.
 *
 * ─── Canonical means type-checked against the chain ─────────────────────────
 *
 * The wrapper's Move type must be exactly
 * `<SPLASH_UPGRADE_DELAY_PACKAGE_ID>::upgrade_delay::DelayedUpgradeCap`; only
 * that immutable package can make one. Its `original_package` was recorded at
 * `wrap` from the cap itself, while the cap was at version 1, so it is core's
 * ORIGINAL id, after any number of upgrades. That is where core's original id
 * comes from here, never from SPLASH_CORE_PACKAGE_ID, which the app sets to
 * whichever core version it calls. The config's type must then be exactly
 * `<original_package>::compliance_config::ComplianceConfig` (a struct's type
 * always carries the id of the package that first defined it).
 *
 * A configured id that names no object, an object of any other type, or a
 * field that does not parse: the read is refused whole (`ok: false`), so the
 * route answers 502 and a person is paged. Nothing is alerted from a read
 * that could not be trusted, and nothing is silently skipped.
 *
 * ─── Proposals, and what took effect ────────────────────────────────────────
 *
 * Each alert is keyed by its content: wrapper + bytecode digest + eta for an
 * upgrade, wrapper + new owner + eta for an owner change, config + registry +
 * type + eta for an addition. A re-run or a second instance derives the same
 * key, and the store records each key once.
 *
 * A proposal is shown while the latest state read still holds it and it has
 * not lapsed; cancelled or lapsed, it is no longer shown as something that can
 * take effect. What took effect is seen by comparing with the state the
 * monitor stored on its previous run: the cap's version rising (an upgrade was
 * committed) or a registry gaining an entry (an addition was activated). The
 * first state a monitor ever stores is a baseline and raises neither, because
 * nothing in it says when those things happened.
 */
import { normalizeSuiAddress } from './operator-outflows.ts';

/** Where every governance alert sends the owner. The page arrives in Phase 3. */
export const REVIEW_PATH = '/dashboard/settings/spending-rules';

const DAY_MS = 86_400_000;
/** `upgrade_delay::WINDOW_MS`: an upgrade or owner change not put into force
 *  within seven days of its eta lapses (E_PROPOSAL_LAPSED). */
const PROPOSAL_WINDOW_MS = 7 * DAY_MS;
/** `compliance_config::ADDITION_WINDOW_MS`, the same for a registry addition. */
const ADDITION_WINDOW_MS = 7 * DAY_MS;
/** How long something that took effect stays on the dashboard. */
const SHOW_EFFECT_MS = 8 * DAY_MS;

export type GovernancePolicy = {
  upgradeDelayPackageId: string;
  wrapperId: string;
  complianceConfigId: string;
};

/** One object as Sui GraphQL renders `object(address) { address version owner
 *  { __typename … on AddressOwner { address { address } } } asMoveObject {
 *  contents { type { repr } json } } }`. Untrusted until parsed. */
export type ChainObject = {
  address?: unknown;
  version?: unknown;
  owner?: { __typename?: unknown; address?: { address?: unknown } | null } | null;
  asMoveObject?: { contents?: { type?: { repr?: unknown } | null; json?: unknown } | null } | null;
};

/** What one read of the chain returned: null where no object exists. */
export type GovernanceChainRead = { wrapper: ChainObject | null; config: ChainObject | null };

/** 1 accepted asset, 2 settlement app, 3 bridge adapter (compliance_config). */
export type RegistryKind = 1 | 2 | 3;
const REGISTRIES: RegistryKind[] = [1, 2, 3];

export type WrapperState = {
  id: string;
  objectVersion: number;
  owner: string;
  /** Core's original id, recorded at `wrap`. */
  originalPackage: string;
  /** The id of core's current version. */
  latestPackage: string;
  capVersion: number;
  /** 0 compatible, 128 additive, 192 dependency-only. */
  policy: number;
  pending: { digest: string; proposedAtMs: number; etaMs: number } | null;
  pendingOwner: { newOwner: string; etaMs: number } | null;
};

export type ConfigState = {
  id: string;
  objectVersion: number;
  registries: Record<RegistryKind, string[]>;
  pending: Array<{ registry: RegistryKind; typeName: string; proposedAtMs: number; etaMs: number }>;
};

export type GovernanceState = { wrapper: WrapperState; config: ConfigState };

export type GovernanceAlertKind =
  | 'upgrade_proposed'
  | 'owner_change_proposed'
  | 'registry_addition_proposed'
  | 'upgrade_committed'
  | 'registry_addition_activated';

/** Shown only while the latest state read still holds them (see the store). */
export const PROPOSAL_KINDS: GovernanceAlertKind[] = ['upgrade_proposed', 'owner_change_proposed', 'registry_addition_proposed'];

export type GovernanceAlert = {
  /** What the alert says, as a key: the same change always derives the same one. */
  key: string;
  kind: GovernanceAlertKind;
  /** The object it was read from: the wrapper or the config. */
  subjectId: string;
  /** The announced upgrade's bytecode digest, 0x + 64 hex. */
  bytecodeDigest: string | null;
  upgradePolicy: number | null;
  /** The package of core's current version (upgrade_committed). */
  packageId: string | null;
  packageVersion: number | null;
  registry: RegistryKind | null;
  typeName: string | null;
  newOwner: string | null;
  /** When it was announced on chain (proposals). */
  proposedAtMs: number | null;
  /** When it can take effect (proposals). */
  etaMs: number | null;
  /** Shown until then, at the latest: a proposal until it lapses on chain. */
  activeUntilMs: number;
  /** Plain sentences, sentence case: what happened, when, what to do. */
  summary: string;
  /** What the chain shows about the change, and what that allows. */
  detail: string;
  reviewPath: string;
};

/** What the dashboard banner shows. Crosses the server/client boundary. */
export type GovernanceBannerAlert = {
  id: string;
  kind: GovernanceAlertKind;
  summary: string;
  detail: string;
  reviewPath: string;
};

/** What the monitor stores per object between runs. JSON (a jsonb column). */
export type WrapperSnapshot = { objectVersion: number; capVersion: number; pendingKeys: string[] };
export type ConfigSnapshot = { objectVersion: number; registries: Record<'1' | '2' | '3', string[]>; pendingKeys: string[] };
export type GovernanceSnapshots = { wrapper: WrapperSnapshot | null; config: ConfigSnapshot | null };

// ─── Parsing: every field, or nothing ─────────────────────────────────────────

const HEX_ID = /^0x[0-9a-fA-F]{1,64}$/;

/** A canonical 0x + 64 hex id, or null for anything that is not an id. */
function canonicalId(value: unknown): string | null {
  return typeof value === 'string' && HEX_ID.test(value.trim()) ? normalizeSuiAddress(value) : null;
}

/** `0xPKG::module::Name`, address canonical. Generic types do not parse. */
function canonicalType(repr: unknown): string | null {
  if (typeof repr !== 'string') return null;
  const parts = repr.trim().split('::');
  if (parts.length !== 3 || !/^[A-Za-z_]\w*$/.test(parts[1]) || !/^[A-Za-z_]\w*$/.test(parts[2])) return null;
  const address = canonicalId(parts[0]);
  return address ? `${address}::${parts[1]}::${parts[2]}` : null;
}

/** u64 milliseconds arrive as decimal strings; they fit a JS number. */
function millis(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,16}$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

/** An object or cap version: a safe non-negative integer, number or string. */
function version(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  return millis(value);
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const has = (o: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(o, key);

class Unreadable extends Error {}

function need<T>(value: T | null, what: string): T {
  if (value == null) throw new Unreadable(what);
  return value;
}

/** A `VecSet<String>`: `{ contents: [ "…", … ] }`. */
function stringSet(value: unknown, what: string): string[] {
  const contents = record(value)?.contents;
  if (!Array.isArray(contents)) throw new Unreadable(`${what} is not a set`);
  return contents.map((entry, i) => {
    if (typeof entry !== 'string' || !entry.trim()) throw new Unreadable(`${what}[${i}] is not a type name`);
    return entry.trim();
  });
}

export type ParsedState = { ok: true; state: GovernanceState } | { ok: false; reason: string; objectId: string };

/**
 * Check the two objects are the canonical ones and read every field the
 * alerts depend on. Any doubt is a refusal naming the setting to check.
 */
export function parseGovernanceState(read: GovernanceChainRead, policy: GovernancePolicy): ParsedState {
  const upgradeDelay = normalizeSuiAddress(policy.upgradeDelayPackageId);
  const wrapperId = normalizeSuiAddress(policy.wrapperId);
  const configId = normalizeSuiAddress(policy.complianceConfigId);
  const wrapperType = `${upgradeDelay}::upgrade_delay::DelayedUpgradeCap`;

  // ── The wrapper ──
  const w = read.wrapper;
  if (!w) {
    return { ok: false, objectId: wrapperId, reason: `SPLASH_UPGRADE_WRAPPER_ID (${wrapperId}) names no object on chain, so there is no upgrade wrapper to watch. Set it to the DelayedUpgradeCap that wraps splash_core's UpgradeCap.` };
  }
  const wType = canonicalType(w.asMoveObject?.contents?.type?.repr);
  if (wType !== wrapperType) {
    return { ok: false, objectId: wrapperId, reason: `SPLASH_UPGRADE_WRAPPER_ID (${wrapperId}) is ${wType ? `a ${wType}` : 'not a Move object of a type this monitor can read'}, not a ${wrapperType}. Only the canonical wrapper's state can alert owners.` };
  }
  let wrapper: WrapperState;
  try {
    if (canonicalId(w.address) !== wrapperId) throw new Unreadable('the object returned is not the one asked for');
    const json = need(record(w.asMoveObject?.contents?.json), 'it has no fields');
    if (canonicalId(json.id) !== wrapperId) throw new Unreadable('its id is not the configured id');
    if (w.owner?.__typename !== 'AddressOwner') throw new Unreadable('it is not owned by an address');
    const cap = need(record(json.cap), 'cap is missing');
    if (!has(json, 'pending') || !has(json, 'pending_owner')) throw new Unreadable('pending or pending_owner is missing');
    const pendingJson = json.pending === null ? null : need(record(json.pending), 'pending is not a proposal');
    const ownerJson = json.pending_owner === null ? null : need(record(json.pending_owner), 'pending_owner is not an owner change');
    wrapper = {
      id: wrapperId,
      objectVersion: need(version(w.version), 'its object version is not a number'),
      owner: need(canonicalId(w.owner?.address?.address), 'its owner is not an address'),
      originalPackage: need(canonicalId(json.original_package), 'original_package is not an id'),
      latestPackage: need(canonicalId(cap.package), 'cap.package is not an id'),
      capVersion: need(version(cap.version), 'cap.version is not a number'),
      policy: need(smallInt(cap.policy), 'cap.policy is not a policy'),
      pending: pendingJson && {
        digest: need(bytes32Hex(pendingJson.digest), 'pending.digest is not 32 bytes'),
        proposedAtMs: need(millis(pendingJson.proposed_at_ms), 'pending.proposed_at_ms is not a time'),
        etaMs: need(millis(pendingJson.eta_ms), 'pending.eta_ms is not a time'),
      },
      pendingOwner: ownerJson && {
        newOwner: need(canonicalId(ownerJson.new_owner), 'pending_owner.new_owner is not an address'),
        etaMs: need(millis(ownerJson.eta_ms), 'pending_owner.eta_ms is not a time'),
      },
    };
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    return { ok: false, objectId: wrapperId, reason: `the upgrade wrapper ${wrapperId} could not be read in full (${error.message}), so nothing from it is trusted.` };
  }

  // ── The config, checked against the wrapper's own record of core ──
  const configType = `${wrapper.originalPackage}::compliance_config::ComplianceConfig`;
  const c = read.config;
  if (!c) {
    return { ok: false, objectId: configId, reason: `SPLASH_COMPLIANCE_CONFIG_ID (${configId}) names no object on chain, so there are no registry additions to watch.` };
  }
  const cType = canonicalType(c.asMoveObject?.contents?.type?.repr);
  if (cType !== configType) {
    return { ok: false, objectId: configId, reason: `SPLASH_COMPLIANCE_CONFIG_ID (${configId}) is ${cType ? `a ${cType}` : 'not a Move object of a type this monitor can read'}, not a ${configType}, the config of the core package the upgrade wrapper guards (its original_package).` };
  }
  let config: ConfigState;
  try {
    if (canonicalId(c.address) !== configId) throw new Unreadable('the object returned is not the one asked for');
    const json = need(record(c.asMoveObject?.contents?.json), 'it has no fields');
    if (canonicalId(json.id) !== configId) throw new Unreadable('its id is not the configured id');
    if (c.owner?.__typename !== 'Shared') throw new Unreadable('it is not shared');
    if (!Array.isArray(json.pending_additions)) throw new Unreadable('pending_additions is not a list');
    config = {
      id: configId,
      objectVersion: need(version(c.version), 'its object version is not a number'),
      registries: {
        1: stringSet(json.accepted_assets, 'accepted_assets'),
        2: stringSet(json.settlement_apps, 'settlement_apps'),
        3: stringSet(json.bridge_adapters, 'bridge_adapters'),
      },
      pending: json.pending_additions.map((entry, i) => {
        const p = need(record(entry), `pending_additions[${i}] is not an addition`);
        const registry = smallInt(p.registry);
        if (registry !== 1 && registry !== 2 && registry !== 3) throw new Unreadable(`pending_additions[${i}].registry is not 1, 2 or 3`);
        const typeName = typeof p.type_name === 'string' && p.type_name.trim() ? p.type_name.trim() : null;
        return {
          registry,
          typeName: need(typeName, `pending_additions[${i}].type_name is missing`),
          proposedAtMs: need(millis(p.proposed_at_ms), `pending_additions[${i}].proposed_at_ms is not a time`),
          etaMs: need(millis(p.eta_ms), `pending_additions[${i}].eta_ms is not a time`),
        };
      }),
    };
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    return { ok: false, objectId: configId, reason: `the compliance config ${configId} could not be read in full (${error.message}), so nothing from it is trusted.` };
  }
  return { ok: true, state: { wrapper, config } };
}

// ─── Words ────────────────────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `26 October 2026, 14:05 UTC`. Fixed, so every channel says the same. */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

const ACT = 'Review your spending rules and revoke any allowance you are not comfortable with';

const POLICY_NAME: Record<number, string> = { 0: 'compatible', 128: 'additive', 192: 'dependency-only' };

function policyLine(policy: number): string {
  return `Upgrade policy: ${POLICY_NAME[policy] ?? 'unrecognised'} (${policy}).`;
}

/**
 * What the policy the cap enforces lets an update change. The network checks
 * the policy when it runs an upgrade. The additive sentence is the design's
 * own limit (phase1-move-design.md §5): an added core function could still
 * alter a payment waiting to be made, but spending rules live in the
 * immutable splash_spend, and only the business's wallet can grant an
 * allowance.
 */
function policyMeaning(policy: number): string {
  if (policy === 128) {
    return 'The network accepts an update under this policy only if it adds to the contract: existing functions stay as they are. Added code could still change a payment that has not been made yet, or the account limits and freezes the payment contract keeps, but it cannot change a spending rule (who may spend, to whom, or how much) or create an allowance. Spending rules live in a separate contract that cannot be updated, and only your wallet can grant an allowance.';
  }
  if (policy === 192) return 'The network accepts an update under this policy only if it changes nothing but the code the contract depends on.';
  if (policy === 0) return 'Under this policy an update may change how existing functions work.';
  return '';
}

const REGISTRY_NOUN: Record<RegistryKind, string> = {
  1: 'a new payment asset',
  2: 'a new settlement app',
  3: 'a new cross-chain bridge adapter',
};

/** What a registered entry can do, from compliance_config and payment_intent:
 *  an app opens and settles intents in an account's name (`create_for_app`,
 *  `settle_from_app`); it can draw on a wallet only under an allowance bound
 *  to its own type, which only the wallet can grant. */
const REGISTRY_POWER: Record<RegistryKind, { proposed: string; activated: string }> = {
  1: {
    proposed: 'Once it takes effect, payments can be made in this asset.',
    activated: 'Payments can now be made in this asset.',
  },
  2: {
    proposed: "Once it takes effect, this app can open payment requests in your account's name and settle them. It can spend from your wallet only under an allowance you grant to this app.",
    activated: "This app can now open payment requests in your account's name and settle them. It can spend from your wallet only under an allowance you grant to this app.",
  },
  3: {
    proposed: 'Once it takes effect, this adapter can carry payments to another blockchain.',
    activated: 'This adapter can now carry payments to another blockchain.',
  },
};

/** `0x…::usdc::USDC` or `…::usdc::USDC` → `usdc::USDC`: the readable part. */
function shortType(typeName: string): string {
  const parts = typeName.split('::');
  return parts.length >= 3 ? parts.slice(1).join('::') : typeName;
}

// ─── Deriving alerts ──────────────────────────────────────────────────────────

const empty = {
  bytecodeDigest: null,
  upgradePolicy: null,
  packageId: null,
  packageVersion: null,
  registry: null,
  typeName: null,
  newOwner: null,
  proposedAtMs: null,
  etaMs: null,
  reviewPath: REVIEW_PATH,
} satisfies Partial<GovernanceAlert>;

export type DerivedGovernance = {
  alerts: GovernanceAlert[];
  /** What to store for the next run's comparison. */
  snapshots: { wrapper: WrapperSnapshot; config: ConfigSnapshot };
};

/**
 * The alerts this state calls for. `previous` is what the monitor stored on
 * an earlier run; it is compared only when this read is newer than it (a
 * higher object version), so a lagging read can never make an old entry look
 * new.
 */
export function deriveGovernanceAlerts(state: GovernanceState, previous: GovernanceSnapshots, nowMs: number): DerivedGovernance {
  const { wrapper, config } = state;
  const alerts: GovernanceAlert[] = [];
  const wrapperPending: string[] = [];
  const configPending: string[] = [];

  // The announced upgrade, while it can still be put into force.
  if (wrapper.pending && nowMs < wrapper.pending.etaMs + PROPOSAL_WINDOW_MS) {
    const { digest, proposedAtMs, etaMs } = wrapper.pending;
    const key = `upgrade_proposed|${wrapper.id}|${digest}|${etaMs}`;
    wrapperPending.push(key);
    alerts.push({
      ...empty,
      key,
      kind: 'upgrade_proposed',
      subjectId: wrapper.id,
      bytecodeDigest: digest,
      upgradePolicy: wrapper.policy,
      proposedAtMs,
      etaMs,
      activeUntilMs: etaMs + PROPOSAL_WINDOW_MS,
      summary: `Splash has announced an update to its payment contract. It can take effect from ${formatUtc(etaMs)}. ${ACT} before then.`,
      detail: [`The update's bytecode digest is ${digest}.`, policyLine(wrapper.policy), policyMeaning(wrapper.policy)].filter(Boolean).join(' '),
    });
  }

  // The announced move to a new governance multisig, likewise.
  if (wrapper.pendingOwner && nowMs < wrapper.pendingOwner.etaMs + PROPOSAL_WINDOW_MS) {
    const { newOwner, etaMs } = wrapper.pendingOwner;
    const key = `owner_change_proposed|${wrapper.id}|${newOwner}|${etaMs}`;
    wrapperPending.push(key);
    alerts.push({
      ...empty,
      key,
      kind: 'owner_change_proposed',
      subjectId: wrapper.id,
      newOwner,
      etaMs,
      activeUntilMs: etaMs + PROPOSAL_WINDOW_MS,
      summary: `Splash has announced a change to who can update its payment contract. It can take effect from ${formatUtc(etaMs)}. ${ACT} before then.`,
      detail: `The key that can announce updates would move from ${wrapper.owner} to ${newOwner}, a multisig account: no single key can sign for it alone. Whoever holds that key can announce updates, each with 24 hours of notice.`,
    });
  }

  // Each announced registry addition, likewise.
  for (const p of config.pending) {
    if (nowMs >= p.etaMs + ADDITION_WINDOW_MS) continue;
    const key = `registry_addition_proposed|${config.id}|${p.registry}|${p.typeName}|${p.etaMs}`;
    configPending.push(key);
    alerts.push({
      ...empty,
      key,
      kind: 'registry_addition_proposed',
      subjectId: config.id,
      registry: p.registry,
      typeName: p.typeName,
      proposedAtMs: p.proposedAtMs,
      etaMs: p.etaMs,
      activeUntilMs: p.etaMs + ADDITION_WINDOW_MS,
      summary: `Splash has announced ${REGISTRY_NOUN[p.registry]} (${shortType(p.typeName)}). It can take effect from ${formatUtc(p.etaMs)}. ${ACT} before then.`,
      detail: `${REGISTRY_POWER[p.registry].proposed} Full type: ${p.typeName}.`,
    });
  }

  // What took effect since the stored state: only against an older one.
  const prevWrapper = previous.wrapper;
  if (prevWrapper && wrapper.objectVersion > prevWrapper.objectVersion && wrapper.capVersion > prevWrapper.capVersion) {
    alerts.push({
      ...empty,
      key: `upgrade_committed|${wrapper.id}|${wrapper.capVersion}|${wrapper.latestPackage}`,
      kind: 'upgrade_committed',
      subjectId: wrapper.id,
      upgradePolicy: wrapper.policy,
      packageId: wrapper.latestPackage,
      packageVersion: wrapper.capVersion,
      activeUntilMs: nowMs + SHOW_EFFECT_MS,
      summary: `An update to Splash's payment contract has taken effect. ${ACT}.`,
      detail: [
        `The contract is now at version ${wrapper.capVersion}, package ${wrapper.latestPackage}.`,
        policyLine(wrapper.policy),
        'Every update to it is announced on chain 24 hours before it can take effect.',
      ].join(' '),
    });
  }
  const prevConfig = previous.config;
  if (prevConfig && config.objectVersion > prevConfig.objectVersion) {
    for (const registry of REGISTRIES) {
      const before = new Set(prevConfig.registries[String(registry) as '1' | '2' | '3'] ?? []);
      for (const typeName of config.registries[registry]) {
        if (before.has(typeName)) continue;
        alerts.push({
          ...empty,
          // The stored version both racing runs compared against, so they
          // derive one key; a later re-addition compares against a later one.
          key: `registry_addition_activated|${config.id}|${registry}|${typeName}|${prevConfig.objectVersion}`,
          kind: 'registry_addition_activated',
          subjectId: config.id,
          registry,
          typeName,
          activeUntilMs: nowMs + SHOW_EFFECT_MS,
          summary: `Splash has added ${REGISTRY_NOUN[registry]} (${shortType(typeName)}). It has now taken effect. ${ACT}.`,
          detail: `${REGISTRY_POWER[registry].activated} Full type: ${typeName}.`,
        });
      }
    }
  }

  return {
    alerts,
    snapshots: {
      wrapper: { objectVersion: wrapper.objectVersion, capVersion: wrapper.capVersion, pendingKeys: wrapperPending },
      config: {
        objectVersion: config.objectVersion,
        registries: { 1: config.registries[1], 2: config.registries[2], 3: config.registries[3] },
        pendingKeys: configPending,
      },
    },
  };
}
