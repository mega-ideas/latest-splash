/**
 * Amendment A1 §4 and §2.7: the quote API, and the copy it renders.
 *
 * What is pinned here:
 *   * the quote is A1 §4's shape: { splashFee: { kind, tierLabel, bps,
 *     minor }, partnerFee | circleFee: { minor, source }, totalDebitMinor,
 *     maxFeeMinor }, computed with lib/fees/schedule.ts's splashFee on the
 *     kind the settle path charges, and every lib/fees/vectors.json row a
 *     settle path pays comes out of it with the chain's fee;
 *   * Splash's fee is charged on top: the total debited is the principal
 *     plus Splash's fee, and max_fee is exactly the fee shown (Sky, 24 Oct:
 *     the UI passes the exact shown fee as max_fee). A partner's or Circle's
 *     fee is its own line with its source, never added to Splash's;
 *   * while the FeeConfig has no fee recipient the fee is 0, and the quote
 *     says the fees are off rather than showing a rate it will not charge;
 *   * the pricing line is A1 §2.7's, rendered from the schedule: change the
 *     schedule and the line changes, so no rate is typed into copy;
 *   * the server's quote engine (lib/server/quote.ts) returns that shape for
 *     a local-currency payout (a BANK_PAYOUT), with the payout partner's fee
 *     from the partner's own quote, and fails closed on mainnet when no
 *     FeeConfig is configured;
 *   * the PTB side: the payment the server builds carries maxFeeMinor as a
 *     typed field (lib/server/composed-payment.ts), and the authorize route
 *     refuses a payment whose current fee is above the one the payer was
 *     shown.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { FEE_KIND, LAUNCH_SCHEDULE, U64_MAX, settlementKind } from '../lib/fees/schedule.ts';
import {
  feeBreakdownRows,
  formatRate,
  formatUsdc,
  kindLabel,
  pricingLine,
  rateRange,
  scheduleFromWire,
  scheduleToWire,
  tierLabel,
} from '../lib/fees/copy.ts';
import { buildFeeQuote, feeQuoteFromWire, feeQuoteToWire } from '../lib/fees/quote.ts';

const ON = { feesOn: true, schedule: LAUNCH_SCHEDULE };
const OFF = { feesOn: false, schedule: LAUNCH_SCHEDULE };
const vectors = JSON.parse(readFileSync('lib/fees/vectors.json', 'utf8'));

const A1_PRICING_LINE =
  'Free between Splash businesses · 0.02% to any Sui wallet (min 0.25 USDC) · 0.05–0.15% to supported exchanges · ' +
  '0.05–0.30% to a bank or another chain, lower for larger payments. Payout-partner or Circle fees are shown separately before you approve.';

// ─── Copy, rendered from the schedule ──────────────────────────────────────

test("the pricing line is A1 §2.7's, word for word, from the launch schedule", () => {
  assert.equal(pricingLine(LAUNCH_SCHEDULE), A1_PRICING_LINE);
});

test('the pricing line follows the schedule it is given: no rate is typed into it', () => {
  const changed = LAUNCH_SCHEDULE.map((k, kind) => {
    if (kind === FEE_KIND.WALLET) return { ...k, tiers: [{ upperMinor: U64_MAX, bps: 3n }], minMinor: 500_000n };
    if (kind === FEE_KIND.CROSS_CHAIN) return { ...k, tiers: [{ upperMinor: U64_MAX, bps: 25n }] };
    return k;
  });
  const line = pricingLine(changed);
  assert.match(line, /0\.03% to any Sui wallet \(min 0\.50 USDC\)/);
  // Bank and another chain differ now, so each has its own part.
  assert.match(line, /0\.05–0\.30% to a bank, lower for larger payments/);
  assert.match(line, /0\.25% to another chain/);
  assert.doesNotMatch(line, /0\.02%/);
});

test('rates, amounts, kinds and tiers are labelled from the schedule', () => {
  assert.equal(formatRate(2n), '0.02%');
  assert.equal(formatRate(30n), '0.30%');
  assert.equal(formatRate(100n), '1.00%');
  assert.equal(formatUsdc(2_999_999n), '2.999999');
  assert.equal(formatUsdc(250_000n), '0.25');
  assert.equal(formatUsdc(1_000_000_000n), '1,000.00');
  assert.equal(kindLabel(FEE_KIND.BANK_PAYOUT), 'Bank payout');
  assert.equal(kindLabel(FEE_KIND.WALLET), 'Sui wallet');
  const bank = LAUNCH_SCHEDULE[FEE_KIND.BANK_PAYOUT];
  assert.deepEqual(
    bank.tiers.map((_, i) => tierLabel(bank, i)),
    ['Under 1,000 USDC', '1,000 to under 10,000 USDC', '10,000 to under 50,000 USDC', '50,000 to under 100,000 USDC', '100,000 USDC and above'],
  );
  assert.equal(tierLabel(LAUNCH_SCHEDULE[FEE_KIND.WALLET], 0), 'Any amount');
  assert.equal(rateRange(bank), '0.05–0.30%');
  assert.equal(rateRange(LAUNCH_SCHEDULE[FEE_KIND.WALLET]), '0.02%');
});

test('a schedule crosses to the browser as data and comes back the same', () => {
  const wire = JSON.parse(JSON.stringify(scheduleToWire(LAUNCH_SCHEDULE)));
  assert.deepEqual(scheduleFromWire(wire), LAUNCH_SCHEDULE);
  assert.throws(() => scheduleFromWire([{ tiers: [{ upperMinor: '1', bps: '101' }], minMinor: '0', maxMinor: '0' }]), /ceiling|kind/);
});

// ─── The quote (A1 §4) ─────────────────────────────────────────────────────

test("A1 §4's shape: Splash's fee with its kind and tier, the partner's fee with its source, the total and max_fee", () => {
  const q = buildFeeQuote({
    kind: FEE_KIND.BANK_PAYOUT,
    principalMinor: 999_999_999n,
    state: ON,
    partnerFee: { minor: 2_000_000n, source: 'Our Philippines payout partner, live quote' },
  });
  assert.deepEqual(q.splashFee, {
    kind: FEE_KIND.BANK_PAYOUT,
    kindLabel: 'Bank payout',
    tierLabel: 'Under 1,000 USDC',
    bps: 30n,
    minor: 2_999_999n,
    basis: 'rate',
  });
  assert.deepEqual(q.partnerFee, { minor: 2_000_000n, source: 'Our Philippines payout partner, live quote' });
  assert.equal(q.circleFee, undefined);
  // Charged on top; the partner's fee is not Splash's and is not added to it.
  assert.equal(q.totalDebitMinor, 999_999_999n + 2_999_999n);
  assert.equal(q.maxFeeMinor, 2_999_999n, 'max_fee is the fee shown');
  assert.equal(q.feesOn, true);
});

test('every vector a settle path pays is quoted at the chain fee', () => {
  let quoted = 0;
  for (const v of vectors.vectors) {
    const declared = v.declared ?? v.kind;
    const partner = v.partner ?? v.kind === FEE_KIND.BANK_PAYOUT;
    let kind;
    try {
      kind = settlementKind({
        declared,
        viaCctp: v.kind === FEE_KIND.CROSS_CHAIN,
        recipientIsBusinessWallet: v.kind === FEE_KIND.SPLASH_BUSINESS,
        recipientIsPartnerAddress: partner,
      });
    } catch {
      continue; // the settle paths refuse it (the partner address declared WALLET)
    }
    const q = buildFeeQuote({ kind, principalMinor: BigInt(v.principal_minor), discountBps: v.discount_bps, state: ON });
    assert.equal(q.splashFee.minor, BigInt(v.expected_fee_minor), v.name);
    assert.equal(q.totalDebitMinor, BigInt(v.principal_minor) + BigInt(v.expected_fee_minor), v.name);
    assert.equal(q.maxFeeMinor, BigInt(v.expected_fee_minor), v.name);
    quoted += 1;
  }
  assert.ok(quoted >= 29, `${quoted} vectors quoted`);
});

test('the quote says which bound set the fee: the rate, the minimum, the maximum or the 1% ceiling', () => {
  const wallet = (p) => buildFeeQuote({ kind: FEE_KIND.WALLET, principalMinor: p, state: ON }).splashFee;
  assert.equal(wallet(10_000_000n).basis, 'ceiling');
  assert.equal(wallet(10_000_000n).minor, 100_000n);
  assert.equal(wallet(25_000_000n).basis, 'minimum');
  assert.equal(wallet(10_000_000_000n).basis, 'rate');
  assert.equal(wallet(1_000_000_000_000n).basis, 'maximum');
  const free = buildFeeQuote({ kind: FEE_KIND.SPLASH_BUSINESS, principalMinor: 50_000_000_000n, state: ON }).splashFee;
  assert.equal(free.minor, 0n);
  assert.equal(free.bps, 0n);
});

test('the breakdown labels the bound that set the fee, not the tier rate it overrode (the A1 review)', () => {
  // The review rendered a 10 USDC wallet payment as "0.02% · capped at the 1%
  // ceiling" beside a 0.10 USDC fee: a 0.02% rate cannot be capped at 1%. The
  // 0.25 USDC minimum set the fee, and the 1% ceiling then lowered it.
  const line = (kind, principalMinor) =>
    feeBreakdownRows(feeQuoteToWire(buildFeeQuote({ kind, principalMinor, state: ON })))[0];

  const ceiling = line(FEE_KIND.WALLET, 10_000_000n);
  assert.equal(ceiling.amount, '0.10 USDC');
  assert.equal(ceiling.detail, 'Sui wallet · Any amount · 1% ceiling, lower than the minimum');
  assert.doesNotMatch(ceiling.detail, /0\.02%/, 'the tier rate did not set this fee');

  const minimum = line(FEE_KIND.WALLET, 25_000_000n);
  assert.equal(minimum.amount, '0.25 USDC');
  assert.equal(minimum.detail, 'Sui wallet · Any amount · minimum 0.25 USDC');

  const rate = line(FEE_KIND.WALLET, 10_000_000_000n);
  assert.equal(rate.amount, '2.00 USDC');
  assert.equal(rate.detail, 'Sui wallet · Any amount · 0.02%');

  const maximum = line(FEE_KIND.WALLET, 1_000_000_000_000n);
  assert.equal(maximum.amount, '5.00 USDC');
  assert.equal(maximum.detail, 'Sui wallet · Any amount · maximum 5 USDC');
  assert.doesNotMatch(maximum.detail, /0\.02%/, 'the tier rate did not set this fee');
});

test('a discount lowers the rate the quote shows, as it lowers the fee', () => {
  const q = buildFeeQuote({ kind: FEE_KIND.BANK_PAYOUT, principalMinor: 5_000_000_000n, discountBps: 10, state: ON });
  assert.equal(q.splashFee.bps, 10n);
  assert.equal(q.splashFee.minor, 5_000_000n);
});

test('while no fee recipient has been applied the fee is 0, max_fee is 0 and the quote says the fees are off', () => {
  const q = buildFeeQuote({ kind: FEE_KIND.BANK_PAYOUT, principalMinor: 999_999_999n, state: OFF });
  assert.equal(q.feesOn, false);
  assert.equal(q.splashFee.minor, 0n);
  assert.equal(q.splashFee.bps, 0n);
  assert.equal(q.splashFee.basis, 'off');
  assert.equal(q.maxFeeMinor, 0n);
  assert.equal(q.totalDebitMinor, 999_999_999n);
});

test('a Circle fee is its own line with its source, like a partner fee', () => {
  const q = buildFeeQuote({
    kind: FEE_KIND.CROSS_CHAIN,
    principalMinor: 1_000_000_000n,
    state: ON,
    circleFee: { minor: 100_000n, source: "Circle's CCTP fast-transfer fee" },
  });
  assert.equal(q.partnerFee, undefined);
  assert.deepEqual(q.circleFee, { minor: 100_000n, source: "Circle's CCTP fast-transfer fee" });
  assert.equal(q.totalDebitMinor, 1_000_000_000n + 2_000_000n);
  assert.throws(
    () => buildFeeQuote({ kind: 3, principalMinor: 1n, state: ON, partnerFee: { minor: 1n, source: 'x' }, circleFee: { minor: 1n, source: 'y' } }),
    /partner fee or a Circle fee/,
  );
});

test('the quote crosses the wire as strings and comes back exact', () => {
  const q = buildFeeQuote({ kind: FEE_KIND.BANK_PAYOUT, principalMinor: 49_999_999_999n, state: ON, partnerFee: { minor: null, source: 'Quoted by the payout partner' } });
  const wire = JSON.parse(JSON.stringify(feeQuoteToWire(q)));
  assert.equal(wire.splashFee.minor, '59999999');
  assert.equal(wire.maxFeeMinor, '59999999');
  assert.equal(wire.partnerFee.minor, null);
  assert.deepEqual(feeQuoteFromWire(wire), q);
  assert.throws(() => feeQuoteFromWire({ ...wire, maxFeeMinor: '1.5' }), /maxFeeMinor/);
  assert.throws(() => feeQuoteFromWire({ ...wire, totalDebitMinor: '1' }), /total/);
});

test('the fee breakdown is three lines: Splash fee with kind and tier, the partner fee with its source, the total debited', () => {
  const q = feeQuoteToWire(
    buildFeeQuote({ kind: FEE_KIND.BANK_PAYOUT, principalMinor: 1_000_000_000n, state: ON, partnerFee: { minor: 2_000_000n, source: 'Our Philippines payout partner, live quote' } }),
  );
  const rows = feeBreakdownRows(q);
  assert.deepEqual(rows.map((r) => r.key), ['splash', 'partner', 'total']);
  assert.equal(rows[0].label, 'Splash fee');
  assert.equal(rows[0].detail, 'Bank payout · 1,000 to under 10,000 USDC · 0.20%');
  assert.equal(rows[0].amount, '2.00 USDC');
  assert.equal(rows[1].label, 'Payout-partner fee');
  assert.equal(rows[1].detail, 'Our Philippines payout partner, live quote. Taken from the payout, not debited.');
  assert.equal(rows[1].amount, '2.00 USDC');
  assert.equal(rows[2].label, 'Total debited');
  assert.equal(rows[2].amount, '1,002.00 USDC');

  const off = feeBreakdownRows(feeQuoteToWire(buildFeeQuote({ kind: FEE_KIND.BANK_PAYOUT, principalMinor: 1_000_000_000n, state: OFF })));
  assert.match(off[0].detail, /not charged yet/i);
  assert.equal(off[0].amount, '0.00 USDC');
  assert.deepEqual(off.map((r) => r.key), ['splash', 'total']);

  const unquoted = feeBreakdownRows(feeQuoteToWire(buildFeeQuote({ kind: FEE_KIND.BANK_PAYOUT, principalMinor: 1_000_000_000n, state: ON, partnerFee: { minor: null, source: 'Quoted by the payout partner at payout' } })));
  assert.equal(unquoted[1].amount, 'Not quoted yet');
});

// ─── The server's quote engine ─────────────────────────────────────────────

async function withEnv(patch, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('the quote engine prices a local-currency payout as a BANK_PAYOUT, with the partner fee from the partner quote', async () => {
  const { calculateQuote } = await import('../lib/server/quote.ts');
  const quote = await withEnv({ SPLASH_FEE_CONFIG_ID: undefined, SUI_NETWORK: 'testnet', PDAX_API_KEY: undefined }, () =>
    calculateQuote(100_000, undefined, 'PHP', 'STANDARD', { destination: { type: 'bank' } }),
  );
  // US$1,000.00 is 1,000 USDC of principal: the 1,000 to 10,000 tier, 0.20%.
  assert.equal(quote.principalMinor, '1000000000');
  assert.equal(quote.splashFee.kind, FEE_KIND.BANK_PAYOUT);
  assert.equal(quote.splashFee.tierLabel, '1,000 to under 10,000 USDC');
  assert.equal(quote.splashFee.bps, '20');
  assert.equal(quote.splashFee.minor, '2000000');
  assert.equal(quote.totalDebitMinor, '1002000000');
  assert.equal(quote.maxFeeMinor, '2000000');
  assert.equal(quote.scheduleSource, 'launch-schedule');
  assert.ok(quote.partnerFee, 'a partner fee line');
  assert.match(quote.partnerFee.source, /payout partner/i);
  assert.equal(typeof quote.partnerFee.minor, 'string');
  for (const legacy of ['platformFee', 'fixedFee', 'networkFee']) assert.equal(legacy in quote, false, `${legacy} is gone`);
  assert.equal(Object.keys(quote).some((k) => /bps$/i.test(k)), false, 'no flat rate on the quote');
});

test('on mainnet a quote with no FeeConfig configured fails closed', async () => {
  const { calculateQuote } = await import('../lib/server/quote.ts');
  const { FeeConfigUnavailableError } = await import('../lib/fees/fee-config.ts');
  await withEnv({ SPLASH_FEE_CONFIG_ID: undefined, SUI_NETWORK: 'mainnet' }, () =>
    assert.rejects(calculateQuote(100_000, undefined, 'PHP', 'STANDARD', { destination: { type: 'bank' } }), FeeConfigUnavailableError),
  );
});

test('the quote route returns the quote and answers 503 when the fee cannot be read', () => {
  const route = readFileSync('app/api/quotes/route.ts', 'utf8');
  assert.match(route, /FeeConfigUnavailableError/);
  assert.match(route, /status: 503/);
});

test("the quote route quotes the session's own business, with its discount, as authorize does", () => {
  // The funding session is opened for the quote's total and authorize
  // refuses one that differs from its own re-quote by more than a micro-USDC,
  // so the two must quote the same business. A quote without the discount
  // made every bank- or coin-funded transfer by a discounted business 409.
  const route = readFileSync('app/api/quotes/route.ts', 'utf8');
  assert.match(route, /requireSessionAccount\(auth\.session\)/, 'the account comes from the session');
  assert.match(route, /calculateQuote\([^)]*\{ businessId: [^}]+\}\)/, 'and is passed to the quote');
  assert.doesNotMatch(route, /can only over-quote/, 'over-quoting is not harmless here');
  const authorize = readFileSync('app/api/transfers/authorize/route.ts', 'utf8');
  assert.match(authorize, /calculateQuote\([^)]*\{ businessId: businessAccountId[ ,][^)]*\}\)/);
});

// ─── max_fee into the PTB ──────────────────────────────────────────────────

test('the payment the server builds carries maxFeeMinor, and the shown fee bounds it', () => {
  const composed = readFileSync('lib/server/composed-payment.ts', 'utf8');
  assert.match(composed, /maxFeeMinor: bigint;/, 'a typed field the v2 builder reads');
  const authorize = readFileSync('app/api/transfers/authorize/route.ts', 'utf8');
  assert.match(authorize, /maxFeeMinor/);
  assert.match(authorize, /fee_above_shown/, 'a fee above the one shown is refused before anything moves');
  const step = readFileSync('components/transfer/StepQuote.tsx', 'utf8');
  assert.match(step, /maxFeeMinor/, 'the review sends the fee it showed');
});
