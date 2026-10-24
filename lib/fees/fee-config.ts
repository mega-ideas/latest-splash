/**
 * The on-chain FeeConfig, read on the server (Amendment A1 §4).
 *
 * The live schedule is read from the shared FeeConfig (SPLASH_FEE_CONFIG_ID)
 * over Sui GraphQL, read-only, and cached. The cache refreshes when it
 * expires, when the server sees a FeeScheduleApplied event from the config's
 * own package (`observeFeeEvent`; a look-alike event from another package is
 * ignored), and early when a proposed schedule reaches its eta, after which
 * it could be applied at any moment, until its seven-day apply window closes
 * and it lapses (FEE_APPLY_WINDOW_MS).
 *
 * Splash's fees are off until the first fee recipient change has been
 * applied (Sky, 24 Oct): a FeeConfig is published with no fee recipient. A
 * config read with no recipient is therefore valid and reads as fees off
 * (`feesOn: false`). The cache also refreshes on FeeRecipientApplied and at
 * a pending recipient's eta, when the fees could turn on.
 *
 * It fails closed. An object that is missing, of another type, or not a
 * valid FeeConfig in every field is refused, never defaulted to the launch
 * schedule; a failed read clears the cache rather than serving the old one.
 * The caller then shows no fee and builds no payment (`quoteFeeState`).
 *
 * Copy is the one exception, and it is not a payment: the pricing line and
 * the calculator render from the live schedule when it can be read, and from
 * the launch schedule, the FeeConfig default at publish, when it cannot
 * (`publishedFeeSchedule`).
 *
 * Server-only: it reads the chain and the environment. Clients get fee
 * numbers from the quote API, and the schedule as data from a server parent.
 */
import 'server-only';

import {
  FEE_APPLY_WINDOW_MS,
  FEE_CEILING_BPS,
  FEE_KIND_COUNT,
  FEE_MAX_TIERS,
  LAUNCH_SCHEDULE,
  U64_MAX,
  feeUnderConfig,
  freezeSchedule,
  tierOf,
  type FeeKind,
  type FeeSchedule,
  type FeeState,
  type FeeTier,
  type KindSchedule,
} from './schedule.ts';

const U16_MAX = 65_535;

/** The on-chain FeeConfig could not be read, or was not what it must be. */
export class FeeConfigUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FeeConfigUnavailableError';
  }
}

// ─── Reading the on-chain FeeConfig ─────────────────────────────────────────

export type PendingSchedule = KindSchedule & { readonly etaMs: bigint };

export type FeeConfigState = {
  /** The FeeConfig object read, normalized. */
  readonly id: string;
  /** The object's version when read. */
  readonly version: number;
  /** The package that defines `fee_config::FeeConfig` (core's original id). */
  readonly packageId: string;
  readonly schedule: FeeSchedule;
  /** The fee recipient in force; null until the first change is applied. */
  readonly feeRecipient: string | null;
  /** False while no fee recipient has been applied: every fee is then 0. */
  readonly feesOn: boolean;
  /** The Table<ID, u16> of per-business discounts, and how many it holds. */
  readonly discountsTableId: string;
  readonly discountCount: bigint;
  /** One slot per kind. */
  readonly pendingSchedules: readonly (PendingSchedule | null)[];
  readonly pendingRecipient: { readonly recipient: string; readonly etaMs: bigint } | null;
};

const HEX_ADDRESS = /^(?:0x)?([0-9a-fA-F]{1,64})$/;
const FEE_CONFIG_TYPE = /^(?:0x)?([0-9a-fA-F]{1,64})::fee_config::FeeConfig$/;
/** The events after which the fee the chain charges can differ: a schedule
 *  applied, or a recipient applied (the first one turns the fees on). */
const REFRESHING_EVENT_TYPE = /^(?:0x)?([0-9a-fA-F]{1,64})::fee_config::(?:FeeScheduleApplied|FeeRecipientApplied)$/;
const WHOLE = /^(0|[1-9]\d*)$/;

/** `0x` + 64 lower-case hex, or null if `value` is not a Sui address. */
export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = HEX_ADDRESS.exec(value.trim());
  return m ? `0x${m[1].toLowerCase().padStart(64, '0')}` : null;
}

function refuse(message: string): never {
  throw new FeeConfigUnavailableError(`FeeConfig refused: ${message}`);
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function u64(v: unknown, what: string): bigint {
  if (typeof v !== 'string' || !WHOLE.test(v)) refuse(`${what} is not a u64 written as a decimal string`);
  const n = BigInt(v);
  if (n > U64_MAX) refuse(`${what} does not fit a u64`);
  return n;
}

function address(v: unknown, what: string): string {
  const a = typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) ? normalizeAddress(v) : null;
  if (!a || /^0x0+$/.test(a)) refuse(`${what} is not a full, non-zero Sui address`);
  return a;
}

/** A schedule as `fee_config::build` would accept it, or refused. */
function parseKindSchedule(v: unknown, what: string): KindSchedule {
  if (!isObject(v) || !Array.isArray(v.tiers)) refuse(`${what} has no tiers`);
  const n = v.tiers.length;
  if (n < 1 || n > FEE_MAX_TIERS) refuse(`${what} has ${n} tiers, not 1-${FEE_MAX_TIERS}`);
  const tiers: FeeTier[] = v.tiers.map((t: unknown, i: number) => {
    if (!isObject(t)) refuse(`${what} tier ${i} is not a tier`);
    const tier = { upperMinor: u64(t.upper_minor, `${what} tier ${i} upper_minor`), bps: u64(t.bps, `${what} tier ${i} bps`) };
    if (tier.bps > FEE_CEILING_BPS) refuse(`${what} tier ${i} is ${tier.bps} bps, above the ${FEE_CEILING_BPS} bps ceiling`);
    return tier;
  });
  for (let i = 1; i < n; i += 1) {
    if (!(tiers[i - 1].upperMinor < tiers[i].upperMinor)) refuse(`${what} upper bounds are not strictly ascending`);
  }
  if (tiers[n - 1].upperMinor !== U64_MAX) refuse(`${what} last upper bound is not u64::MAX`);
  const minMinor = u64(v.min_minor, `${what} min_minor`);
  const maxMinor = u64(v.max_minor, `${what} max_minor`);
  if (minMinor > maxMinor) refuse(`${what} minimum is above its maximum`);
  return { tiers, minMinor, maxMinor };
}

/** What a GraphQL `object(address:)` with `address version asMoveObject { contents { type { repr } json } }` returns. */
export type FeeConfigObjectRead = {
  address?: unknown;
  version?: unknown;
  asMoveObject?: { contents?: { type?: { repr?: unknown } | null; json?: unknown } | null } | null;
} | null;

/**
 * The FeeConfig `expectedId` names, from an indexer's read of it, checked in
 * every field. Throws FeeConfigUnavailableError on anything else.
 */
export function parseFeeConfig(read: FeeConfigObjectRead | undefined, expectedId: string): FeeConfigState {
  const id = normalizeAddress(expectedId);
  if (!id) refuse(`${String(expectedId)} is not an object id`);
  if (!read) refuse(`there is no object ${id}`);
  if (normalizeAddress(read.address) !== id) refuse(`the indexer answered for another object than ${id}`);
  const version = read.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) refuse('the object has no version');
  const contents = read.asMoveObject?.contents;
  const repr = contents?.type?.repr;
  const m = typeof repr === 'string' ? FEE_CONFIG_TYPE.exec(repr) : null;
  if (!m) refuse(`${id} is a ${typeof repr === 'string' ? repr : 'non-Move object'}, not a fee_config::FeeConfig`);
  const packageId = normalizeAddress(m[1]) as string;
  const json = contents?.json;
  if (!isObject(json)) refuse('the object has no contents');

  if (!Array.isArray(json.schedules) || json.schedules.length !== FEE_KIND_COUNT) refuse(`it does not hold one schedule for each of the ${FEE_KIND_COUNT} kinds`);
  const schedule = freezeSchedule(json.schedules.map((s: unknown, k: number) => parseKindSchedule(s, `kind ${k}'s schedule`)));

  // Option<address>: null until the first recipient change is applied.
  const feeRecipient = json.fee_recipient === null ? null : address(json.fee_recipient, 'fee_recipient');
  if (!isObject(json.discounts)) refuse('it has no discounts table');
  const discountsTableId = address(json.discounts.id, 'the discounts table id');
  const discountCount = u64(json.discounts.size, 'the discounts table size');

  if (!Array.isArray(json.pending_schedules) || json.pending_schedules.length !== FEE_KIND_COUNT) refuse('it does not hold one pending-schedule slot per kind');
  const pendingSchedules = json.pending_schedules.map((p: unknown, k: number): PendingSchedule | null => {
    if (p === null) return null;
    if (!isObject(p)) refuse(`kind ${k}'s pending schedule is not a proposal`);
    return Object.freeze({ ...parseKindSchedule(p.schedule, `kind ${k}'s pending schedule`), etaMs: u64(p.eta_ms, `kind ${k}'s pending eta_ms`) });
  });

  let pendingRecipient: FeeConfigState['pendingRecipient'] = null;
  if (json.pending_recipient !== null) {
    const p = json.pending_recipient;
    if (!isObject(p)) refuse('the pending recipient is not a proposal');
    pendingRecipient = Object.freeze({ recipient: address(p.recipient, 'the pending recipient'), etaMs: u64(p.eta_ms, 'the pending recipient eta_ms') });
  }

  return Object.freeze({
    id,
    version,
    packageId,
    schedule,
    feeRecipient,
    feesOn: feeRecipient !== null,
    discountsTableId,
    discountCount,
    pendingSchedules: Object.freeze(pendingSchedules),
    pendingRecipient,
  });
}

type Fetcher = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
const TIMEOUT_MS = 8_000;

/** SUI_GRAPHQL_URL, else Mysten's public endpoint for SUI_NETWORK. */
export function defaultGraphqlEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SUI_GRAPHQL_URL?.trim();
  if (configured) return configured;
  return env.SUI_NETWORK === 'mainnet' ? 'https://graphql.mainnet.sui.io/graphql' : 'https://graphql.testnet.sui.io/graphql';
}

/** One read-only query. Throws FeeConfigUnavailableError on anything but a complete answer. */
async function query(fetcher: Fetcher, endpoint: string, text: string, variables: Record<string, string>): Promise<Json> {
  let body: { data?: unknown; errors?: Array<{ message?: string }> };
  try {
    const res = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: text, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) throw new FeeConfigUnavailableError(`the Sui indexer answered HTTP ${res.status}`);
    body = (await res.json()) as typeof body;
  } catch (error) {
    if (error instanceof FeeConfigUnavailableError) throw error;
    throw new FeeConfigUnavailableError('the Sui indexer could not be reached', { cause: error });
  }
  if (body?.errors?.length) throw new FeeConfigUnavailableError(`the Sui indexer refused the query: ${body.errors[0]?.message ?? 'unknown error'}`);
  if (!isObject(body?.data)) throw new FeeConfigUnavailableError('the Sui indexer answered without data');
  return body.data;
}

const FEE_CONFIG_QUERY = `query FeeConfig($id: SuiAddress!) {
  object(address: $id) {
    address
    version
    asMoveObject { contents { type { repr } json } }
  }
}`;

/** A reader of the FeeConfig at an id, over GraphQL. */
export function graphqlFeeConfigReader(fetcher: Fetcher = fetch, endpoint = defaultGraphqlEndpoint()): (id: string) => Promise<FeeConfigState> {
  return async (id) => {
    const data = await query(fetcher, endpoint, FEE_CONFIG_QUERY, { id });
    if (!('object' in data)) throw new FeeConfigUnavailableError('the Sui indexer answered without the object');
    return parseFeeConfig(data.object as FeeConfigObjectRead, id);
  };
}

const DISCOUNT_QUERY = `query FeeDiscount($table: SuiAddress!, $name: Base64!) {
  table: address(address: $table) {
    dynamicField(name: { type: "0x2::object::ID", bcs: $name }) {
      value { __typename ... on MoveValue { json } }
    }
  }
}`;

/**
 * A reader of one business's discount, in bps, from FeeConfig's discounts
 * table (a dynamic field keyed by the business account's ID); 0 when it has
 * none. Fails closed like the config reader.
 */
export function graphqlDiscountReader(
  fetcher: Fetcher = fetch,
  endpoint = defaultGraphqlEndpoint(),
): (discountsTableId: string, businessId: string) => Promise<number> {
  return async (discountsTableId, businessId) => {
    const table = normalizeAddress(discountsTableId);
    const business = normalizeAddress(businessId);
    if (!table || !business) throw new FeeConfigUnavailableError('the discounts table and the business must be object ids');
    const name = Buffer.from(business.slice(2), 'hex').toString('base64');
    const data = await query(fetcher, endpoint, DISCOUNT_QUERY, { table, name });
    if (!isObject(data.table)) throw new FeeConfigUnavailableError('the Sui indexer answered without the discounts table');
    const field = data.table.dynamicField;
    if (field === null) return 0;
    const json = isObject(field) && isObject(field.value) ? field.value.json : undefined;
    if (typeof json !== 'number' || !Number.isInteger(json) || json < 0 || json > U16_MAX) {
      throw new FeeConfigUnavailableError("the business's discount is not a u16");
    }
    return json;
  };
}

// ─── The cache ──────────────────────────────────────────────────────────────

export type FeeConfigCache = {
  /** The FeeConfig, from the cache while it is fresh. Throws FeeConfigUnavailableError. */
  get(): Promise<FeeConfigState>;
  /** Drop the cache; the next get reads the chain. */
  invalidate(): void;
  /** Tell the cache an event was seen. A FeeScheduleApplied or
   *  FeeRecipientApplied from the config's own package refreshes it (returns
   *  true); anything else is ignored. */
  observeEvent(eventType: string): boolean;
};

export function createFeeConfigCache({
  id,
  read,
  ttlMs = 60_000,
  applicableTtlMs = 5_000,
  now = Date.now,
}: {
  id: string;
  read: (id: string) => Promise<FeeConfigState>;
  /** How long a read is trusted when nothing is pending. */
  ttlMs?: number;
  /** How long once a pending schedule has reached its eta and could apply at any moment. */
  applicableTtlMs?: number;
  now?: () => number;
}): FeeConfigCache {
  let state: FeeConfigState | null = null;
  let expiresAt = 0;
  let packageId: string | null = null;
  let inflight: Promise<FeeConfigState> | null = null;
  let generation = 0;

  const expiryFor = (s: FeeConfigState, t: number): number => {
    let at = t + ttlMs;
    const etas = s.pendingSchedules.filter((p) => p !== null).map((p) => p.etaMs);
    if (s.pendingRecipient) etas.push(s.pendingRecipient.etaMs);
    for (const etaMs of etas) {
      const eta = Number(etaMs);
      // From eta + the apply window on, the proposal has lapsed and can never
      // apply (E_FEE_PROPOSAL_LAPSED), so it no longer shortens the cache.
      if (t >= eta + Number(FEE_APPLY_WINDOW_MS)) continue;
      at = Math.min(at, eta <= t ? t + applicableTtlMs : eta);
    }
    return at;
  };

  const invalidate = () => {
    generation += 1;
    state = null;
    expiresAt = 0;
  };

  return {
    async get() {
      if (state && now() < expiresAt) return state;
      if (inflight) return inflight;
      const started = generation;
      state = null;
      inflight = read(id)
        .then((s) => {
          packageId = s.packageId;
          if (generation === started) {
            state = s;
            expiresAt = expiryFor(s, now());
          }
          return s;
        })
        .catch((error: unknown) => {
          state = null;
          expiresAt = 0;
          if (error instanceof FeeConfigUnavailableError) throw error;
          throw new FeeConfigUnavailableError('the FeeConfig could not be read', { cause: error });
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    invalidate,
    observeEvent(eventType) {
      const m = REFRESHING_EVENT_TYPE.exec(eventType.trim());
      if (!m || !packageId || normalizeAddress(m[1]) !== packageId) return false;
      invalidate();
      return true;
    },
  };
}

// ─── The configured FeeConfig ───────────────────────────────────────────────

/** SPLASH_FEE_CONFIG_ID, or why it is not usable. */
export function feeConfigIdFromEnv(env: NodeJS.ProcessEnv = process.env): { ok: true; id: string } | { ok: false; reason: string } {
  const raw = (env.SPLASH_FEE_CONFIG_ID ?? '').trim();
  if (!raw) return { ok: false, reason: 'SPLASH_FEE_CONFIG_ID is not configured, so there is no fee schedule to quote from' };
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) return { ok: false, reason: 'SPLASH_FEE_CONFIG_ID is not a 0x + 64 hex id' };
  return { ok: true, id: normalizeAddress(raw) as string };
}

let configured: FeeConfigCache | null = null;

function configuredCache(): FeeConfigCache {
  if (configured) return configured;
  const id = feeConfigIdFromEnv();
  if (!id.ok) throw new FeeConfigUnavailableError(id.reason);
  configured = createFeeConfigCache({ id: id.id, read: graphqlFeeConfigReader() });
  return configured;
}

/** The live FeeConfig named by SPLASH_FEE_CONFIG_ID. Throws FeeConfigUnavailableError. */
export function getFeeConfig(): Promise<FeeConfigState> {
  return configuredCache().get().then((cfg) => {
    lastReadSchedule = cfg.schedule;
    return cfg;
  });
}

/** The schedule of the last FeeConfig this process read, for copy that cannot wait for a read. */
let lastReadSchedule: FeeSchedule | null = null;

/**
 * The schedule copy renders from when it cannot await a read (Zeke's canned
 * answers): the last live FeeConfig this process read, else the launch
 * schedule. A quote never uses it.
 */
export function lastPublishedFeeSchedule(): FeeSchedule {
  return lastReadSchedule ?? LAUNCH_SCHEDULE;
}

/** For the event listener: pass every event type seen; a FeeScheduleApplied
 *  or FeeRecipientApplied from the configured FeeConfig's package refreshes
 *  the cached config. */
export function observeFeeEvent(eventType: string): boolean {
  return configured ? configured.observeEvent(eventType) : false;
}

/**
 * The fee the chain would charge now on a payment, from the live schedule and
 * the business's live discount: what a quote shows and bounds `max_fee` by.
 * 0 while the config's fees are off (`feesOn` false). Throws
 * FeeConfigUnavailableError rather than guess.
 */
export async function currentSplashFee({
  businessId,
  kind,
  principalMinor,
}: {
  businessId: string;
  kind: FeeKind;
  principalMinor: bigint;
}): Promise<{
  kind: FeeKind;
  feesOn: boolean;
  tierIndex: number;
  rateBps: bigint;
  discountBps: number;
  feeMinor: bigint;
  configVersion: number;
}> {
  const cfg = await getFeeConfig();
  const discountBps = cfg.discountCount === 0n ? 0 : await graphqlDiscountReader()(cfg.discountsTableId, businessId);
  const feeMinor = feeUnderConfig({ config: cfg, kind, principalMinor, discountBps });
  const tier = tierOf(cfg.schedule[kind], principalMinor);
  return { kind, feesOn: cfg.feesOn, tierIndex: tier.index, rateBps: tier.bps, discountBps, feeMinor, configVersion: cfg.version };
}

// ─── What a quote and the copy compute under ────────────────────────────────

/** Where a fee state came from: the live FeeConfig, or A1's launch schedule. */
export type FeeScheduleSource = 'fee-config' | 'launch-schedule';

function onMainnet(env: NodeJS.ProcessEnv): boolean {
  return (env.SUI_NETWORK ?? '').trim().toLowerCase() === 'mainnet';
}

/**
 * The schedule, and whether the fees are on, that a quote is computed under.
 *
 * With SPLASH_FEE_CONFIG_ID configured it is the live FeeConfig, and a read
 * that fails throws FeeConfigUnavailableError: the quote shows no fee and no
 * payment is built. Without it, on mainnet, it throws the same way, since a
 * mainnet payment is only ever quoted from the chain. Off mainnet, where the
 * v2 FeeConfig may not be published yet (the testnet still runs the v1
 * builders), it is the launch schedule with the fees on, and says so
 * (`source`), so a testnet quote shows what mainnet will charge.
 */
export async function quoteFeeState(env: NodeJS.ProcessEnv = process.env): Promise<FeeState & { source: FeeScheduleSource; configVersion: number | null; discountsTableId: string | null; discountCount: bigint }> {
  const id = feeConfigIdFromEnv(env);
  if (id.ok) {
    const cfg = await getFeeConfig();
    return { feesOn: cfg.feesOn, schedule: cfg.schedule, source: 'fee-config', configVersion: cfg.version, discountsTableId: cfg.discountsTableId, discountCount: cfg.discountCount };
  }
  if (onMainnet(env)) throw new FeeConfigUnavailableError(`${id.reason}; a mainnet quote is only ever read from the chain`);
  return { feesOn: true, schedule: LAUNCH_SCHEDULE, source: 'launch-schedule', configVersion: null, discountsTableId: null, discountCount: 0n };
}

/**
 * A business's discount in bps for a quote under `state`: read from the live
 * FeeConfig's discounts table when it holds any and the business is an
 * on-chain account id; 0 otherwise. 0 can only over-quote, never under: a
 * discount lowers the fee, and the chain refunds the unused max_fee to the
 * business wallet.
 */
export async function quoteDiscountBps(
  state: { source: FeeScheduleSource; discountsTableId: string | null; discountCount: bigint },
  businessId: string | null | undefined,
): Promise<number> {
  if (state.source !== 'fee-config' || !state.discountsTableId || state.discountCount === 0n) return 0;
  if (!businessId || !normalizeAddress(businessId) || !/^0x[0-9a-fA-F]{64}$/.test(businessId.trim())) return 0;
  return graphqlDiscountReader()(state.discountsTableId, businessId);
}

/**
 * The schedule Splash's pricing copy renders from: the live FeeConfig's when
 * it is configured and can be read, else the launch schedule (the FeeConfig
 * default at publish). Never throws: a pricing line is not a payment, and the
 * quote, which is, fails closed on its own.
 */
export async function publishedFeeSchedule(env: NodeJS.ProcessEnv = process.env): Promise<{ schedule: FeeSchedule; source: FeeScheduleSource }> {
  if (!feeConfigIdFromEnv(env).ok) return { schedule: LAUNCH_SCHEDULE, source: 'launch-schedule' };
  try {
    const cfg = await getFeeConfig();
    return { schedule: cfg.schedule, source: 'fee-config' };
  } catch {
    return { schedule: LAUNCH_SCHEDULE, source: 'launch-schedule' };
  }
}
