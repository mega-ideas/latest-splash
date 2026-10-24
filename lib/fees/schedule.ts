/**
 * Splash's fee on the server: a mirror of splash_core::fee_config
 * (Amendment A1 §2.4, §4), and a reader of the on-chain FeeConfig.
 *
 * ─── The computation ────────────────────────────────────────────────────────
 *
 * `splashFee` is the chain's `fee_config::splash_fee`, step for step, in
 * bigint: the tier's rate (the first tier whose upper bound is above the
 * principal, else the last), less the business's discount, never below zero;
 * principal × rate / 10,000, rounded down; raised to the kind's minimum and
 * lowered to its maximum; and last lowered to the ceiling, 1% of the
 * principal, which beats the minimum. `deriveKind` is
 * `address_registry::derive_kind`. Both are held to the chain by the same
 * vectors (lib/fees/vectors.json, tests/fee-schedule.test.mjs, and the Move
 * tests scripts/gen-fee-tests.mjs generates from that file).
 * `settlementKind` adds what every settle path then refuses: a derived kind
 * that does not fit the declared one (`address_registry::assert_kind_fits`);
 * a quote should use it, since a vector's kind can be one the settle paths
 * refuse to pay (a partner address declared WALLET).
 *
 * The number shown to a payer is a quote, not the charge: the chain computes
 * the fee itself at settlement and checks it against the `max_fee` the payer
 * signed (EFeeAboveMax). A stale schedule here can make a payment abort; it
 * can never make one pay more than it was shown.
 *
 * ─── The schedule ───────────────────────────────────────────────────────────
 *
 * `LAUNCH_SCHEDULE` is A1 §2.2, the FeeConfig default at publish. It is the
 * reference the tests pin, not the live schedule: that is read from the
 * shared FeeConfig (SPLASH_FEE_CONFIG_ID) over Sui GraphQL, read-only, and
 * cached. The cache refreshes when it expires, when the server sees a
 * FeeScheduleApplied event from the config's own package (`observeFeeEvent`;
 * a look-alike event from another package is ignored), and early when a
 * proposed schedule reaches its eta, after which it could be applied at any
 * moment.
 *
 * Splash's fees are off until the first fee recipient change has been
 * applied (Sky, 24 Oct): a FeeConfig is published with no fee recipient, and
 * while it has none the chain's `splash_fee` returns 0 on every kind. A
 * config read with no recipient is therefore valid and reads as fees off
 * (`feesOn: false`), and `feeUnderConfig`, which every quote goes through,
 * returns 0 under it. The cache also refreshes on FeeRecipientApplied and
 * at a pending recipient's eta, when the fees could turn on.
 *
 * It fails closed. An object that is missing, of another type, or not a
 * valid FeeConfig in every field is refused, never defaulted to the launch
 * schedule; a failed read clears the cache rather than serving the old one.
 * The caller then shows no fee and builds no payment.
 *
 * Server-only: it reads the chain and the environment. Clients get fee
 * numbers from the quote API.
 */
import 'server-only';

// ─── Constants: splash_core::fee_config ─────────────────────────────────────

/** The most any fee may be, in basis points of the principal: 1%. The same
 *  constant as splash_core::fee_config and splash_spend (check:fees). */
export const FEE_CEILING_BPS = 100n;
export const BPS_DENOM = 10_000n;
export const FEE_MAX_TIERS = 8;
export const U64_MAX = 18_446_744_073_709_551_615n;
const U16_MAX = 65_535;

/** A1's kind numbers, the same on chain, in the vectors and here. */
export const FEE_KIND = Object.freeze({
  SPLASH_BUSINESS: 0,
  WALLET: 1,
  EXCHANGE: 2,
  CROSS_CHAIN: 3,
  BANK_PAYOUT: 4,
} as const);
export type FeeKind = (typeof FEE_KIND)[keyof typeof FEE_KIND];
export const FEE_KIND_COUNT = 5;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Principals below `upperMinor` (and at or above the previous tier's) pay `bps`. */
export type FeeTier = { readonly upperMinor: bigint; readonly bps: bigint };
export type KindSchedule = { readonly tiers: readonly FeeTier[]; readonly minMinor: bigint; readonly maxMinor: bigint };
/** One schedule per kind, indexed by kind. */
export type FeeSchedule = readonly KindSchedule[];

export class FeeKindMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeeKindMismatchError';
  }
}

/** The on-chain FeeConfig could not be read, or was not what it must be. */
export class FeeConfigUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FeeConfigUnavailableError';
  }
}

// ─── The launch schedule (A1 §2.2; USDC, 6 decimals) ────────────────────────

function freezeSchedule(kinds: KindSchedule[]): FeeSchedule {
  return Object.freeze(
    kinds.map((k) => Object.freeze({ ...k, tiers: Object.freeze(k.tiers.map((t) => Object.freeze({ ...t }))) })),
  );
}

const BANDS = [1_000_000_000n, 10_000_000_000n, 50_000_000_000n, 100_000_000_000n, U64_MAX];
const banded = (rates: bigint[]): FeeTier[] => rates.map((bps, i) => ({ upperMinor: BANDS[i], bps }));

export const LAUNCH_SCHEDULE: FeeSchedule = freezeSchedule([
  // SPLASH_BUSINESS: free inside the network.
  { tiers: [{ upperMinor: U64_MAX, bps: 0n }], minMinor: 0n, maxMinor: 0n },
  // WALLET: 2 bps, at least 0.25 USDC, at most 5 USDC.
  { tiers: [{ upperMinor: U64_MAX, bps: 2n }], minMinor: 250_000n, maxMinor: 5_000_000n },
  // EXCHANGE.
  { tiers: banded([15n, 12n, 10n, 7n, 5n]), minMinor: 0n, maxMinor: U64_MAX },
  // CROSS_CHAIN, and BANK_PAYOUT on the same tiers.
  { tiers: banded([30n, 20n, 12n, 7n, 5n]), minMinor: 0n, maxMinor: U64_MAX },
  { tiers: banded([30n, 20n, 12n, 7n, 5n]), minMinor: 0n, maxMinor: U64_MAX },
]);

// ─── The computation (A1 §2.4) ──────────────────────────────────────────────

function assertKind(kind: unknown, what = 'kind'): asserts kind is FeeKind {
  if (typeof kind !== 'number' || !Number.isInteger(kind) || kind < 0 || kind >= FEE_KIND_COUNT) {
    throw new RangeError(`${what} must be one of 0-${FEE_KIND_COUNT - 1}, got ${String(kind)}`);
  }
}

/** The schedule's rate for `principal`, before any discount, and which tier gave it. */
export function tierOf(s: KindSchedule, principalMinor: bigint): { index: number; bps: bigint } {
  if (s.tiers.length === 0) throw new RangeError('a schedule has at least one tier');
  for (let i = 0; i < s.tiers.length; i += 1) {
    if (principalMinor < s.tiers[i].upperMinor) return { index: i, bps: s.tiers[i].bps };
  }
  const last = s.tiers.length - 1;
  return { index: last, bps: s.tiers[last].bps };
}

/** `a * b / d`, rounded down; throws where Move's u64 cast would abort. */
function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  const r = (a * b) / d;
  if (r > U64_MAX) throw new RangeError('the fee does not fit a u64');
  return r;
}

/**
 * Splash's fee, in minor units, on `principalMinor` of `kind` for a business
 * with `discountBps` off the rate, under `schedule`. The chain's
 * `fee_config::splash_fee`, in its exact order. Throws only on inputs the
 * chain could never be given.
 */
export function splashFee({
  kind,
  principalMinor,
  discountBps,
  schedule,
}: {
  kind: FeeKind | number;
  principalMinor: bigint;
  discountBps: number | bigint;
  schedule: FeeSchedule;
}): bigint {
  assertKind(kind);
  if (typeof principalMinor !== 'bigint') throw new TypeError('principalMinor must be a bigint of minor units');
  if (principalMinor < 0n || principalMinor > U64_MAX) throw new RangeError('principalMinor must fit a u64');
  const discount = typeof discountBps === 'bigint' ? discountBps : Number.isInteger(discountBps) ? BigInt(discountBps) : -1n;
  if (discount < 0n || discount > BigInt(U16_MAX)) throw new RangeError('discountBps must be a whole number of basis points (a u16)');
  const s = schedule[kind];
  if (!s) throw new RangeError(`the schedule has no kind ${kind}`);

  let bps = tierOf(s, principalMinor).bps;
  bps = bps - (discount < bps ? discount : bps);
  let fee = mulDivFloor(principalMinor, bps, BPS_DENOM);
  if (fee < s.minMinor) fee = s.minMinor;
  if (fee > s.maxMinor) fee = s.maxMinor;
  const ceiling = mulDivFloor(principalMinor, FEE_CEILING_BPS, BPS_DENOM);
  if (fee > ceiling) fee = ceiling;
  return fee;
}

/**
 * Splash's fee under a whole FeeConfig: the chain's `fee_config::splash_fee`
 * with its config argument. 0 while the config's fees are off (no fee
 * recipient applied yet); otherwise `splashFee` on the config's schedule. An
 * unknown kind throws either way, as the chain checks it first.
 */
export function feeUnderConfig({
  config,
  kind,
  principalMinor,
  discountBps,
}: {
  config: Pick<FeeConfigState, 'feesOn' | 'schedule'>;
  kind: FeeKind | number;
  principalMinor: bigint;
  discountBps: number | bigint;
}): bigint {
  const fee = splashFee({ kind, principalMinor, discountBps, schedule: config.schedule });
  return config.feesOn ? fee : 0n;
}

// ─── The kind (A1 §2.3) ─────────────────────────────────────────────────────

/**
 * The kind the chain charges: `address_registry::derive_kind`. `declared` is
 * the intent's kind on the owners' path, or the recipient's tag in the
 * SpendPolicy under a spending rule. A mismatch the chain would abort on
 * (EKindMismatch) throws.
 */
export function deriveKind({
  declared,
  viaCctp,
  recipientIsBusinessWallet,
  recipientIsPartnerAddress,
}: {
  declared: FeeKind | number;
  viaCctp: boolean;
  recipientIsBusinessWallet: boolean;
  recipientIsPartnerAddress: boolean;
}): FeeKind {
  assertKind(declared, 'declared');
  if (viaCctp) {
    if (declared !== FEE_KIND.CROSS_CHAIN) throw new FeeKindMismatchError('a CCTP payment must be declared CROSS_CHAIN');
    return FEE_KIND.CROSS_CHAIN;
  }
  if (recipientIsBusinessWallet) return FEE_KIND.SPLASH_BUSINESS;
  if (recipientIsPartnerAddress) return FEE_KIND.BANK_PAYOUT;
  if (declared !== FEE_KIND.WALLET && declared !== FEE_KIND.EXCHANGE) {
    throw new FeeKindMismatchError(`kind ${declared} needs a recipient the registries classify as it; this one is a plain address (WALLET or EXCHANGE)`);
  }
  return declared;
}

/**
 * The kind a settle path charges, and so the kind to quote: `deriveKind`,
 * then `address_registry::assert_kind_fits` (Sky, 24 Oct). The derived kind
 * must be the declared one, except a declared WALLET or EXCHANGE to a
 * business wallet, which is a free SPLASH_BUSINESS payment. Anything else
 * throws as the chain aborts (EKindMismatch): in particular a partner
 * deposit address is only ever paid as a declared BANK_PAYOUT, never as a
 * WALLET or EXCHANGE that would skip the bank floor and the beneficiary.
 */
export function settlementKind(args: {
  declared: FeeKind | number;
  viaCctp: boolean;
  recipientIsBusinessWallet: boolean;
  recipientIsPartnerAddress: boolean;
}): FeeKind {
  const derived = deriveKind(args);
  const { declared } = args;
  if (derived === declared) return derived;
  const toBusiness = derived === FEE_KIND.SPLASH_BUSINESS;
  if (toBusiness && (declared === FEE_KIND.WALLET || declared === FEE_KIND.EXCHANGE)) return derived;
  throw new FeeKindMismatchError(`a payment declared kind ${declared} goes to a recipient the registries classify as kind ${derived}; open it as kind ${derived}`);
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
  return configuredCache().get();
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
