/**
 * Amendment A1 §4: lib/fees/schedule.ts mirrors splash_core's fee on the server.
 *
 * What is pinned here:
 *   * parity: every row of lib/fees/vectors.json — the same file the Move
 *     vector tests are generated from — comes out of `deriveKind` and
 *     `splashFee` exactly as it does on chain;
 *   * `splashFee` follows A1 §2.4's order with floor rounding in bigint: the
 *     tier by principal (upper bounds exclusive), less the discount (never
 *     below zero), the minimum, the maximum, and last the 100 bps ceiling,
 *     which beats the minimum;
 *   * the launch schedule constant is A1 §2.2 (copied here from the
 *     amendment, not from the code), and FEE_CEILING_BPS is 100;
 *   * the on-chain FeeConfig reader is read-only GraphQL, fails closed (a
 *     malformed, missing or foreign object is refused, never defaulted),
 *     caches, refreshes when it sees FeeScheduleApplied from the config's own
 *     package and not from a look-alike, and never serves a cache past its
 *     expiry when a read fails;
 *   * the module is server-only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  BPS_DENOM,
  FEE_CEILING_BPS,
  FEE_KIND,
  FeeConfigUnavailableError,
  FeeKindMismatchError,
  LAUNCH_SCHEDULE,
  createFeeConfigCache,
  deriveKind,
  graphqlDiscountReader,
  graphqlFeeConfigReader,
  parseFeeConfig,
  splashFee,
} from '../lib/fees/schedule.ts';

const U64_MAX = 18_446_744_073_709_551_615n;
const vectors = JSON.parse(readFileSync('lib/fees/vectors.json', 'utf8'));

const CONFIG_ID = `0x${'c'.repeat(64)}`;
const PKG = `0x${'a'.repeat(64)}`;
const OTHER_PKG = `0x${'b'.repeat(64)}`;
const TABLE_ID = `0x${'d'.repeat(64)}`;
const FINANCE = `0x${'f'.repeat(64)}`;

// ─── Parity with the chain ──────────────────────────────────────────────────

for (const row of vectors.vectors) {
  test(`vector: ${row.name}`, () => {
    const declared = row.declared ?? row.kind;
    const partner = row.partner ?? row.kind === FEE_KIND.BANK_PAYOUT;
    const kind = deriveKind({
      declared,
      viaCctp: row.kind === FEE_KIND.CROSS_CHAIN,
      recipientIsBusinessWallet: row.kind === FEE_KIND.SPLASH_BUSINESS,
      recipientIsPartnerAddress: partner,
    });
    assert.equal(kind, row.kind);
    const fee = splashFee({
      kind,
      principalMinor: BigInt(row.principal_minor),
      discountBps: row.discount_bps,
      schedule: LAUNCH_SCHEDULE,
    });
    assert.equal(fee, BigInt(row.expected_fee_minor));
  });
}

test('the kinds are A1’s numbers, the same the vectors use', () => {
  assert.deepEqual({ ...FEE_KIND }, vectors.kinds);
});

test('the ceiling is 100 bps of 10,000', () => {
  assert.equal(FEE_CEILING_BPS, 100n);
  assert.equal(BPS_DENOM, 10_000n);
});

test('the launch schedule is A1 §2.2', () => {
  const bands = [1_000_000_000n, 10_000_000_000n, 50_000_000_000n, 100_000_000_000n, U64_MAX];
  const tiers = (rates) => rates.map((bps, i) => ({ upperMinor: bands[i], bps }));
  assert.deepEqual(LAUNCH_SCHEDULE, [
    { tiers: [{ upperMinor: U64_MAX, bps: 0n }], minMinor: 0n, maxMinor: 0n },
    { tiers: [{ upperMinor: U64_MAX, bps: 2n }], minMinor: 250_000n, maxMinor: 5_000_000n },
    { tiers: tiers([15n, 12n, 10n, 7n, 5n]), minMinor: 0n, maxMinor: U64_MAX },
    { tiers: tiers([30n, 20n, 12n, 7n, 5n]), minMinor: 0n, maxMinor: U64_MAX },
    { tiers: tiers([30n, 20n, 12n, 7n, 5n]), minMinor: 0n, maxMinor: U64_MAX },
  ]);
  assert.ok(Object.isFrozen(LAUNCH_SCHEDULE) && Object.isFrozen(LAUNCH_SCHEDULE[3].tiers[0]));
});

// ─── The computation's order ───────────────────────────────────────────────

const fee = (kind, principal, discountBps = 0, schedule = LAUNCH_SCHEDULE) =>
  splashFee({ kind, principalMinor: principal, discountBps, schedule });

test('the tier upper bound is exclusive, and past the last tier the last applies', () => {
  assert.equal(fee(FEE_KIND.BANK_PAYOUT, 999_999_999n), 2_999_999n);
  assert.equal(fee(FEE_KIND.BANK_PAYOUT, 1_000_000_000n), 2_000_000n);
  assert.equal(fee(FEE_KIND.BANK_PAYOUT, U64_MAX), U64_MAX * 5n / 10_000n);
});

test('a discount only lowers the rate, never below zero, and the minimum and ceiling still apply after it', () => {
  // 20 bps less 30 is 0, not negative.
  assert.equal(fee(FEE_KIND.BANK_PAYOUT, 5_000_000_000n, 30), 0n);
  // a wallet's rate discounted to 0 still pays the minimum, under the ceiling
  assert.equal(fee(FEE_KIND.WALLET, 100_000_000n, 2), 250_000n);
  assert.equal(fee(FEE_KIND.WALLET, 10_000_000n, 2), 100_000n);
});

test('the ceiling beats the minimum, and nothing is charged on nothing', () => {
  assert.equal(fee(FEE_KIND.WALLET, 10_000_000n), 100_000n);
  assert.equal(fee(FEE_KIND.WALLET, 0n), 0n);
  assert.equal(fee(FEE_KIND.WALLET, 1n), 0n);
});

test('a stored rate above the ceiling still charges no more than 1%', () => {
  const unchecked = LAUNCH_SCHEDULE.map((s) => s);
  unchecked[FEE_KIND.EXCHANGE] = { tiers: [{ upperMinor: U64_MAX, bps: 500n }], minMinor: 0n, maxMinor: U64_MAX };
  assert.equal(fee(FEE_KIND.EXCHANGE, 1_000_000_000n, 0, unchecked), 10_000_000n);
});

test('it refuses what the chain could never be asked', () => {
  assert.throws(() => fee(5, 1n), RangeError);
  assert.throws(() => fee(-1, 1n), RangeError);
  assert.throws(() => fee(FEE_KIND.WALLET, -1n), RangeError);
  assert.throws(() => fee(FEE_KIND.WALLET, U64_MAX + 1n), RangeError);
  assert.throws(() => fee(FEE_KIND.WALLET, 1000), TypeError);
  assert.throws(() => fee(FEE_KIND.WALLET, 1n, 1.5), RangeError);
  assert.throws(() => fee(FEE_KIND.WALLET, 1n, 65_536), RangeError);
});

// ─── The kind ───────────────────────────────────────────────────────────────

test('the kind is derived as on chain, and a mismatch is refused', () => {
  const base = { recipientIsBusinessWallet: false, recipientIsPartnerAddress: false, viaCctp: false };
  assert.equal(deriveKind({ ...base, declared: FEE_KIND.WALLET }), FEE_KIND.WALLET);
  assert.equal(deriveKind({ ...base, declared: FEE_KIND.EXCHANGE }), FEE_KIND.EXCHANGE);
  // a business wallet is free whatever was declared; a partner address is a bank payout
  assert.equal(deriveKind({ ...base, recipientIsBusinessWallet: true, declared: FEE_KIND.EXCHANGE }), FEE_KIND.SPLASH_BUSINESS);
  assert.equal(deriveKind({ ...base, recipientIsPartnerAddress: true, declared: FEE_KIND.WALLET }), FEE_KIND.BANK_PAYOUT);
  assert.equal(deriveKind({ ...base, viaCctp: true, declared: FEE_KIND.CROSS_CHAIN }), FEE_KIND.CROSS_CHAIN);
  assert.throws(() => deriveKind({ ...base, declared: FEE_KIND.BANK_PAYOUT }), FeeKindMismatchError);
  assert.throws(() => deriveKind({ ...base, declared: FEE_KIND.SPLASH_BUSINESS }), FeeKindMismatchError);
  assert.throws(() => deriveKind({ ...base, declared: FEE_KIND.CROSS_CHAIN }), FeeKindMismatchError);
  assert.throws(() => deriveKind({ ...base, viaCctp: true, declared: FEE_KIND.WALLET }), FeeKindMismatchError);
});

// ─── Reading the on-chain FeeConfig ─────────────────────────────────────────

const s = (n) => String(n);
function scheduleJson(schedule) {
  return {
    tiers: schedule.tiers.map((t) => ({ upper_minor: s(t.upperMinor), bps: s(t.bps) })),
    min_minor: s(schedule.minMinor),
    max_minor: s(schedule.maxMinor),
  };
}
function configObject({ type = `${PKG}::fee_config::FeeConfig`, json = {} } = {}) {
  return {
    address: CONFIG_ID,
    version: 42,
    asMoveObject: {
      contents: {
        type: { repr: type },
        json: {
          id: CONFIG_ID,
          schedules: LAUNCH_SCHEDULE.map(scheduleJson),
          fee_recipient: FINANCE,
          discounts: { id: TABLE_ID, size: '0' },
          pending_schedules: [null, null, null, null, null],
          pending_recipient: null,
          ...json,
        },
      },
    },
  };
}

test('a well-formed FeeConfig parses to the schedule the chain holds', () => {
  const state = parseFeeConfig(configObject(), CONFIG_ID);
  assert.deepEqual(state.schedule, LAUNCH_SCHEDULE);
  assert.equal(state.packageId, PKG);
  assert.equal(state.feeRecipient, FINANCE);
  assert.equal(state.discountsTableId, TABLE_ID);
  assert.equal(state.discountCount, 0n);
  assert.equal(state.version, 42);
  assert.deepEqual(state.pendingSchedules, [null, null, null, null, null]);
  assert.equal(state.pendingRecipient, null);
});

test('a pending schedule and recipient are read with their eta', () => {
  const pending = { tiers: [{ upperMinor: U64_MAX, bps: 3n }], minMinor: 1n, maxMinor: 2n };
  const state = parseFeeConfig(
    configObject({
      json: {
        pending_schedules: [null, { schedule: scheduleJson(pending), eta_ms: '5000' }, null, null, null],
        pending_recipient: { recipient: FINANCE, eta_ms: '7000' },
      },
    }),
    CONFIG_ID,
  );
  assert.deepEqual(state.pendingSchedules[1], { ...pending, etaMs: 5000n });
  assert.deepEqual(state.pendingRecipient, { recipient: FINANCE, etaMs: 7000n });
});

test('anything but a complete, valid FeeConfig is refused, never defaulted', () => {
  const bad = (o, why) => assert.throws(() => parseFeeConfig(o, CONFIG_ID), FeeConfigUnavailableError, why);
  bad(null, 'no object');
  bad({ ...configObject(), address: `0x${'e'.repeat(64)}` }, 'another object');
  bad(configObject({ type: `${PKG}::compliance_config::ComplianceConfig` }), 'another type');
  bad(configObject({ type: `${PKG}::fee_config::FeeConfigX` }), 'a look-alike type');
  bad(configObject({ json: { schedules: LAUNCH_SCHEDULE.slice(0, 4).map(scheduleJson) } }), 'four kinds');
  const rate = (bps) => LAUNCH_SCHEDULE.map((x, k) => (k === 2 ? scheduleJson({ ...x, tiers: [{ upperMinor: U64_MAX, bps }] }) : scheduleJson(x)));
  bad(configObject({ json: { schedules: rate(101n) } }), 'a rate above the ceiling');
  const unordered = LAUNCH_SCHEDULE.map(scheduleJson);
  unordered[3] = { ...unordered[3], tiers: [unordered[3].tiers[1], unordered[3].tiers[0], ...unordered[3].tiers.slice(2)] };
  bad(configObject({ json: { schedules: unordered } }), 'uppers out of order');
  const short = LAUNCH_SCHEDULE.map(scheduleJson);
  short[4] = { ...short[4], tiers: short[4].tiers.slice(0, 4) };
  bad(configObject({ json: { schedules: short } }), 'a last upper below u64::MAX');
  const numeric = LAUNCH_SCHEDULE.map(scheduleJson);
  numeric[1] = { ...numeric[1], min_minor: 250000 };
  bad(configObject({ json: { schedules: numeric } }), 'a u64 that is not a decimal string');
  const inverted = LAUNCH_SCHEDULE.map(scheduleJson);
  inverted[1] = { ...inverted[1], min_minor: '6000000' };
  bad(configObject({ json: { schedules: inverted } }), 'a minimum above the maximum');
  bad(configObject({ json: { fee_recipient: '0x0' } }), 'a recipient that is not an address');
  bad(configObject({ json: { pending_schedules: [null, null, null, null] } }), 'four pending slots');
});

function fetcherFor(reply, calls = []) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply();
    return { ok: true, status: 200, json: async () => reply };
  };
}

test('the reader asks GraphQL for the configured object, read-only, and refuses an incomplete answer', async () => {
  const calls = [];
  const read = graphqlFeeConfigReader(fetcherFor({ data: { object: configObject() } }, calls), 'https://graphql.example/graphql');
  const state = await read(CONFIG_ID);
  assert.deepEqual(state.schedule, LAUNCH_SCHEDULE);
  assert.equal(calls[0].url, 'https://graphql.example/graphql');
  assert.equal(calls[0].body.variables.id, CONFIG_ID);
  assert.match(calls[0].body.query, /^\s*query\b/);
  assert.doesNotMatch(calls[0].body.query, /mutation|executeTransaction|simulateTransaction/);

  const refuse = async (reply) =>
    assert.rejects(graphqlFeeConfigReader(fetcherFor(reply), 'https://graphql.example/graphql')(CONFIG_ID), FeeConfigUnavailableError);
  await refuse({ data: { object: null } });
  await refuse({ data: null, errors: [{ message: 'boom' }] });
  await refuse({ data: {} });
  await refuse(() => ({ ok: false, status: 503, json: async () => ({}) }));
  await refuse(new Error('network down'));
});

test('the discount reader looks the business up in the discounts table, 0 when it has none', async () => {
  const business = `0x${'0'.repeat(62)}12`;
  const calls = [];
  const read = graphqlDiscountReader(
    fetcherFor({ data: { table: { dynamicField: { value: { __typename: 'MoveValue', json: 10 } } } } }, calls),
    'https://graphql.example/graphql',
  );
  assert.equal(await read(TABLE_ID, business), 10);
  assert.equal(calls[0].body.variables.table, TABLE_ID);
  // the name is the ID's 32 bytes, BCS, base64
  assert.deepEqual([...Buffer.from(calls[0].body.variables.name, 'base64')], [...new Array(31).fill(0), 0x12]);

  const none = graphqlDiscountReader(fetcherFor({ data: { table: { dynamicField: null } } }), 'https://graphql.example/graphql');
  assert.equal(await none(TABLE_ID, business), 0);

  const refuse = async (reply) =>
    assert.rejects(graphqlDiscountReader(fetcherFor(reply), 'https://graphql.example/graphql')(TABLE_ID, business), FeeConfigUnavailableError);
  await refuse({ data: { table: { dynamicField: { value: { __typename: 'MoveValue', json: 'ten' } } } } });
  await refuse({ data: { table: { dynamicField: { value: { __typename: 'MoveValue', json: 70_000 } } } } });
  await refuse({ data: null, errors: [{ message: 'boom' }] });
  await refuse(new Error('network down'));
});

// ─── The cache ──────────────────────────────────────────────────────────────

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}
function stateWith(overrides = {}) {
  return { ...parseFeeConfig(configObject(), CONFIG_ID), ...overrides };
}

test('the cache reads once, serves until it expires, then reads again', async () => {
  const c = clock();
  let reads = 0;
  const cache = createFeeConfigCache({ id: CONFIG_ID, read: async () => (reads++, stateWith()), ttlMs: 60_000, now: c.now });
  await cache.get();
  await cache.get();
  assert.equal(reads, 1);
  c.advance(60_000);
  await cache.get();
  assert.equal(reads, 2);
});

test('concurrent reads share one request', async () => {
  let reads = 0;
  const cache = createFeeConfigCache({ id: CONFIG_ID, read: async () => (reads++, stateWith()), ttlMs: 60_000 });
  await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.equal(reads, 1);
});

test('a failed read fails closed: no stale schedule past its expiry, and no cached failure', async () => {
  const c = clock();
  let fail = false;
  const cache = createFeeConfigCache({
    id: CONFIG_ID,
    read: async () => {
      if (fail) throw new FeeConfigUnavailableError('indexer down');
      return stateWith();
    },
    ttlMs: 60_000,
    now: c.now,
  });
  await cache.get();
  fail = true;
  c.advance(60_000);
  await assert.rejects(cache.get(), FeeConfigUnavailableError);
  fail = false;
  await cache.get();
});

test('FeeScheduleApplied from the config’s own package refreshes it; a look-alike does not', async () => {
  let reads = 0;
  const cache = createFeeConfigCache({ id: CONFIG_ID, read: async () => (reads++, stateWith()), ttlMs: 60_000 });
  await cache.get();
  assert.equal(cache.observeEvent(`${OTHER_PKG}::fee_config::FeeScheduleApplied`), false);
  assert.equal(cache.observeEvent(`${PKG}::fee_config::FeeScheduleProposed`), false);
  await cache.get();
  assert.equal(reads, 1);
  assert.equal(cache.observeEvent(`${PKG}::fee_config::FeeScheduleApplied`), true);
  await cache.get();
  assert.equal(reads, 2);
  // the same package in upper case, or without its 0x, is the same package
  assert.equal(cache.observeEvent(`0x${'A'.repeat(64)}::fee_config::FeeScheduleApplied`), true);
  assert.equal(cache.observeEvent(`${'a'.repeat(64)}::fee_config::FeeScheduleApplied`), true);
});

test('a pending schedule shortens the cache to its eta, and to seconds once it could apply', async () => {
  const c = clock(1_000_000);
  let reads = 0;
  const pending = (etaMs) => [null, null, { ...LAUNCH_SCHEDULE[2], etaMs }, null, null];
  const cache = createFeeConfigCache({
    id: CONFIG_ID,
    read: async () => (reads++, stateWith({ pendingSchedules: pending(1_010_000n) })),
    ttlMs: 60_000,
    applicableTtlMs: 5_000,
    now: c.now,
  });
  await cache.get();
  c.advance(10_000); // the eta
  await cache.get();
  assert.equal(reads, 2);
  // now applicable at any moment: re-read every 5 s, not every minute
  c.advance(4_999);
  await cache.get();
  assert.equal(reads, 2);
  c.advance(1);
  await cache.get();
  assert.equal(reads, 3);
});

test('the module is server-only', () => {
  assert.match(readFileSync('lib/fees/schedule.ts', 'utf8'), /^import 'server-only';$/m);
});
