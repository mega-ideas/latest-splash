/**
 * The A1 review's fee-surface Lows (L7): what a customer reads about
 * Splash's fee, on the screens around the quote.
 *
 * What is pinned here:
 *   * no screen shows a funding-source fee tier: A1 removed the
 *     STANDARD/DISCOUNT funding discount, and the quote ignores it, so a
 *     selector or a record that still says "Applied fee: DISCOUNT" tells
 *     the payer about a price that does not exist (L7c);
 *   * while FeeConfig's fees are off (no fee recipient applied yet), every
 *     surface that shows a Splash fee says none is charged: the price list,
 *     the FAQ, the calculator, the batch, treasury and queue previews, the
 *     landing's callouts and the delivery step. The schedule API and
 *     publishedFeeSchedule carry whether the fees are on, and no surface
 *     computes a fee as if they were (L7a);
 *   * a quote is priced by where the payment goes, through the settle
 *     paths' own kind rules (settlementKind): a bank, a Sui wallet, an
 *     exchange, a Splash business or another chain. The transfer flow
 *     says where (its recipient is a bank account), the quote route
 *     refuses a quote that does not say, and a destination no flow can
 *     pay yet is refused by name, with the delivery step saying which
 *     routes are priced when they open in Phase 2 (L7d).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';

// A route imports 'next/server', which plain Node resolves only with its extension.
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'next/server' ? 'next/server.js' : specifier, context);
  },
});

import { FEE_KIND, LAUNCH_SCHEDULE } from '../lib/fees/schedule.ts';
import { pricingLine, pricingSummary, rateRange, scheduleToWire } from '../lib/fees/copy.ts';

const read = (path) => readFileSync(path, 'utf8');

/** Every .ts/.tsx file under `dir`, repo-relative with forward slashes. */
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', '.next'].includes(e.name) ? [] : sources(full);
    return /\.tsx?$/.test(e.name) ? [full.replace(/\\/g, '/')] : [];
  });
}

// ─── L7a: fees off, on every surface that shows a fee ──────────────────────

const OFF_LEAD = "No Splash fee is charged yet. Once fees start, after 24 hours' public notice: ";

test('the price list says no Splash fee is charged while the fees are off', () => {
  const on = pricingSummary(LAUNCH_SCHEDULE);
  assert.equal(on.feesOn, true);
  assert.equal(on.line, pricingLine(LAUNCH_SCHEDULE));
  assert.equal(on.bankFee, rateRange(LAUNCH_SCHEDULE[FEE_KIND.BANK_PAYOUT]));
  assert.equal(on.bankFeePhrase, `${on.bankFee} Splash fee to a bank`);
  assert.equal(on.notice, null);

  const off = pricingSummary(LAUNCH_SCHEDULE, { feesOn: false });
  assert.equal(off.feesOn, false);
  assert.equal(off.line, pricingLine(LAUNCH_SCHEDULE, { feesOn: false }));
  assert.ok(off.line.startsWith(OFF_LEAD), off.line);
  assert.ok(off.line.includes(on.parts.join(' · ')), 'and the schedule that will apply once they start');
  assert.equal(off.bankFee, 'None yet');
  assert.equal(off.bankFeePhrase, 'No Splash fee charged yet');
  assert.match(off.notice, /^No Splash fee is charged yet\./);
});

test("the FAQ's cost answer says no fee is charged while the fees are off", async () => {
  const { landingFaq } = await import('../content/landing-faq.ts');
  const cost = landingFaq(LAUNCH_SCHEDULE, { feesOn: false }).find((item) => /cost/i.test(item.q));
  assert.ok(cost.a.includes(OFF_LEAD), cost.a);
  assert.ok(cost.a.includes(pricingLine(LAUNCH_SCHEDULE, { feesOn: false })), cost.a);
  const onCost = landingFaq(LAUNCH_SCHEDULE).find((item) => /cost/i.test(item.q));
  assert.ok(onCost.a.includes(pricingLine(LAUNCH_SCHEDULE)), 'and the price list while they are on');
});

test('the calculator charges no Splash fee while the fees are off', async () => {
  const { estimatePayment, splashQuote } = await import('../lib/fx/calculator.ts');
  const on = splashQuote(100_000n, LAUNCH_SCHEDULE);
  assert.equal(on.splashFee.minor, 2_000_000n, 'US$1,000 at 0.20%');
  const off = splashQuote(100_000n, LAUNCH_SCHEDULE, { feesOn: false });
  assert.equal(off.feesOn, false);
  assert.equal(off.splashFee.minor, 0n);
  assert.equal(off.totalDebitMinor, 1_000_000_000n);
  const estimate = estimatePayment({ amountUsdMinor: 100_000n, baseline: null, fxRate: null, schedule: LAUNCH_SCHEDULE, feesOn: false });
  assert.equal(estimate.splash.quote.splashFee.minor, 0n);
});

test('publishedFeeSchedule and GET /api/fees/schedule carry whether the fees are on', async () => {
  const CONFIG_ID = `0x${'c'.repeat(64)}`;
  const PKG = `0x${'a'.repeat(64)}`;
  const TABLE_ID = `0x${'d'.repeat(64)}`;
  const s = (n) => String(n);
  const object = {
    address: CONFIG_ID,
    version: 7,
    asMoveObject: {
      contents: {
        type: { repr: `${PKG}::fee_config::FeeConfig` },
        json: {
          id: CONFIG_ID,
          schedules: LAUNCH_SCHEDULE.map((k) => ({
            tiers: k.tiers.map((t) => ({ upper_minor: s(t.upperMinor), bps: s(t.bps) })),
            min_minor: s(k.minMinor),
            max_minor: s(k.maxMinor),
          })),
          // Published with no fee recipient: Splash's fees are off.
          fee_recipient: null,
          discounts: { id: TABLE_ID, size: '0' },
          pending_schedules: [null, null, null, null, null],
          pending_recipient: null,
        },
      },
    },
  };
  const saved = { fetch: globalThis.fetch, id: process.env.SPLASH_FEE_CONFIG_ID, url: process.env.SUI_GRAPHQL_URL };
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { object } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  process.env.SPLASH_FEE_CONFIG_ID = CONFIG_ID;
  process.env.SUI_GRAPHQL_URL = 'https://graphql.example.invalid/graphql';
  try {
    const { publishedFeeSchedule } = await import('../lib/fees/fee-config.ts');
    const published = await publishedFeeSchedule();
    assert.equal(published.source, 'fee-config');
    assert.equal(published.feesOn, false);

    const { GET } = await import('../app/api/fees/schedule/route.ts');
    const body = await (await GET()).json();
    assert.equal(body.feesOn, false);
    assert.equal(body.pricing.feesOn, false);
    assert.ok(body.pricing.line.startsWith(OFF_LEAD), body.pricing.line);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.id === undefined) delete process.env.SPLASH_FEE_CONFIG_ID;
    else process.env.SPLASH_FEE_CONFIG_ID = saved.id;
    if (saved.url === undefined) delete process.env.SUI_GRAPHQL_URL;
    else process.env.SUI_GRAPHQL_URL = saved.url;
  }
  const { publishedFeeSchedule } = await import('../lib/fees/fee-config.ts');
  const launch = await publishedFeeSchedule({ SUI_NETWORK: 'testnet' });
  assert.equal(launch.source, 'launch-schedule');
  assert.equal(launch.feesOn, true, 'off mainnet with no FeeConfig, as a testnet quote charges the launch schedule');
});

test('the published-fees hook keeps whether the fees are on, and takes no answer without it', async () => {
  const { publishedFeesFromBody } = await import('../lib/fees/use-published-pricing.ts');
  const schedule = scheduleToWire(LAUNCH_SCHEDULE);
  const off = publishedFeesFromBody({ feesOn: false, schedule, pricing: pricingSummary(LAUNCH_SCHEDULE, { feesOn: false }) });
  assert.equal(off.feesOn, false);
  assert.equal(off.pricing.feesOn, false);
  assert.deepEqual(off.schedule, LAUNCH_SCHEDULE);
  assert.equal(publishedFeesFromBody({ feesOn: true, schedule, pricing: pricingSummary(LAUNCH_SCHEDULE) }).feesOn, true);
  assert.equal(publishedFeesFromBody({ schedule, pricing: pricingSummary(LAUNCH_SCHEDULE) }), null, 'an answer that does not say is no answer');
  assert.equal(publishedFeesFromBody(null), null);
});

test('no surface computes a Splash fee as if the fees were on', () => {
  const offenders = [];
  for (const root of ['app', 'components', 'lib']) {
    for (const file of sources(root)) {
      if (file.startsWith('lib/fees/')) continue;
      read(file).split(/\r?\n/).forEach((line, i) => {
        if (/feesOn:\s*true\b/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
  }
  assert.deepEqual(offenders, [], 'each takes the fees-on flag the schedule it uses came with');
});

test("the landing, the delivery step and the overview show Splash's bank fee through the fees-aware phrases", () => {
  const offenders = [];
  for (const root of ['app', 'components']) {
    for (const file of sources(root)) {
      read(file).split(/\r?\n/).forEach((line, i) => {
        if (/pricing\??\.bankRange\b/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
  }
  assert.deepEqual(offenders, [], 'a bare rate range reads as charged; bankFee and bankFeePhrase say "none yet" while the fees are off');
  const landing = read('components/IsometricLanding.tsx');
  assert.doesNotMatch(landing, /splash: pricing\.bank,/, "the comparison's Splash cell says so too");
  const page = read('app/page.tsx');
  assert.match(page, /pricingSummary\(schedule, \{ feesOn \}\)/, 'the page prices the landing with the fees-on flag');
  assert.match(page, /landingFaq\(schedule, \{ feesOn \}\)/, 'and the FAQ JSON-LD');
});

// ─── L7c: no retired funding fee tier ──────────────────────────────────────

test('the funding selector shows no retired fee tier', () => {
  const selector = read('components/funding/FundingSelector.tsx');
  assert.doesNotMatch(selector, /Applied fee/, 'no "Applied fee" badge');
  assert.doesNotMatch(selector, /\{selection\.feeTier\}/, 'the selection tier is not rendered');
  assert.doesNotMatch(selector, /'(?:STANDARD|DISCOUNT) fee'/, 'no tier named as a fee on a button');
});

test("the audit record's funding line names the method and asset, not a retired fee tier", () => {
  const audit = read('app/dashboard/audit/[intentId]/page.tsx');
  assert.doesNotMatch(audit, /funding\.feeTier/, 'the record does not print the tier');
  assert.doesNotMatch(audit, /Legacy USD \/ STANDARD/, 'nor a tier for a legacy record');
});

// ─── L7d: the quote is priced by where the payment goes ────────────────────

const ADDRESS = `0x${'b'.repeat(64)}`;
const plain = { isBusinessWallet: false, isPartnerAddress: false };

test("a destination's kind is the settle paths' own: settlementKind on what the registry holds", async () => {
  const { BANK_DESTINATION, destinationKind } = await import('../lib/fees/destination.ts');
  const { FeeKindMismatchError } = await import('../lib/fees/schedule.ts');
  // A bank payout goes to the payout partner's registered deposit address.
  assert.equal(destinationKind(BANK_DESTINATION), FEE_KIND.BANK_PAYOUT);
  assert.equal(destinationKind({ type: 'cross_chain' }), FEE_KIND.CROSS_CHAIN);
  assert.equal(destinationKind({ type: 'sui_wallet', address: ADDRESS }, plain), FEE_KIND.WALLET);
  assert.equal(destinationKind({ type: 'exchange', address: ADDRESS }, plain), FEE_KIND.EXCHANGE);
  // A wallet or an exchange address that is a Splash business's wallet is a free Splash-business payment.
  const business = { isBusinessWallet: true, isPartnerAddress: false };
  assert.equal(destinationKind({ type: 'sui_wallet', address: ADDRESS }, business), FEE_KIND.SPLASH_BUSINESS);
  assert.equal(destinationKind({ type: 'exchange', address: ADDRESS }, business), FEE_KIND.SPLASH_BUSINESS);
  assert.equal(destinationKind({ type: 'splash_business', address: ADDRESS }, business), FEE_KIND.SPLASH_BUSINESS);
  // What the settle paths refuse, the quote refuses.
  assert.throws(() => destinationKind({ type: 'splash_business', address: ADDRESS }, plain), FeeKindMismatchError, 'an unregistered "Splash business"');
  const partner = { isBusinessWallet: false, isPartnerAddress: true };
  assert.throws(() => destinationKind({ type: 'sui_wallet', address: ADDRESS }, partner), FeeKindMismatchError, 'a partner deposit address paid as a wallet');
  assert.throws(() => destinationKind({ type: 'sui_wallet', address: ADDRESS }), /registry/, 'an address is classified, never assumed');
});

test('a destination is read from a request body, or refused', async () => {
  const { parseDestination } = await import('../lib/fees/destination.ts');
  assert.deepEqual(parseDestination({ type: 'bank' }), { type: 'bank' });
  assert.deepEqual(parseDestination({ type: 'cross_chain' }), { type: 'cross_chain' });
  assert.deepEqual(parseDestination({ type: 'sui_wallet', address: ADDRESS.toUpperCase().replace('0X', '0x') }), { type: 'sui_wallet', address: ADDRESS });
  for (const bad of [undefined, null, 'bank', {}, { type: 'iban' }, { type: 'sui_wallet' }, { type: 'exchange', address: '0x12' }]) {
    assert.equal(parseDestination(bad), null, JSON.stringify(bad));
  }
});

test('the quote engine prices the destination it is given, and refuses one no flow can pay yet', async () => {
  const { calculateQuote, QuoteDestinationError } = await import('../lib/server/quote.ts');
  const saved = { id: process.env.SPLASH_FEE_CONFIG_ID, net: process.env.SUI_NETWORK };
  delete process.env.SPLASH_FEE_CONFIG_ID;
  process.env.SUI_NETWORK = 'testnet';
  try {
    const bank = await calculateQuote(100_000, undefined, 'PHP', 'STANDARD', { destination: { type: 'bank' } });
    assert.equal(bank.splashFee.kind, FEE_KIND.BANK_PAYOUT);
    assert.deepEqual(bank.destination, { type: 'bank' });
    for (const destination of [{ type: 'sui_wallet', address: ADDRESS }, { type: 'exchange', address: ADDRESS }, { type: 'splash_business', address: ADDRESS }, { type: 'cross_chain' }]) {
      await assert.rejects(
        calculateQuote(100_000, undefined, 'PHP', 'STANDARD', { destination }),
        (error) => error instanceof QuoteDestinationError && /Phase 2/.test(error.message),
        destination.type,
      );
    }
  } finally {
    if (saved.id === undefined) delete process.env.SPLASH_FEE_CONFIG_ID;
    else process.env.SPLASH_FEE_CONFIG_ID = saved.id;
    if (saved.net === undefined) delete process.env.SUI_NETWORK;
    else process.env.SUI_NETWORK = saved.net;
  }
});

test('the quote engine prices nothing without a destination: no caller is quoted as a bank by default', async () => {
  // The A1 review: the route refused a missing destination, but the engine
  // still priced one as BANK_PAYOUT.
  const { calculateQuote, QuoteDestinationError } = await import('../lib/server/quote.ts');
  for (const options of [undefined, {}, { businessId: null }, { destination: undefined }, { destination: null }]) {
    await assert.rejects(
      calculateQuote(100_000, undefined, 'PHP', 'STANDARD', options),
      (error) => error instanceof QuoteDestinationError && /needs a destination/.test(error.message),
      JSON.stringify(options),
    );
  }
  const source = readFileSync('lib/server/quote.ts', 'utf8');
  assert.doesNotMatch(source, /destination\s*\?\?\s*BANK_DESTINATION/, 'no fallback to a bank payout');
});

test('the quote route takes the destination from the request, and the transfer flow sends it', () => {
  const route = read('app/api/quotes/route.ts');
  assert.match(route, /parseDestination\(body\.destination\)/, 'the route reads where the payment goes');
  assert.match(route, /destination_required/, 'and refuses a quote that does not say');
  assert.match(route, /QuoteDestinationError/, 'and names a destination it cannot price yet');
  assert.match(route, /calculateQuote\([^)]*\{ businessId: businessAccountId, destination \}\)/);
  const step = read('components/transfer/StepQuote.tsx');
  assert.match(step, /destination: destinationForRecipient\(\{ rail: recipientRail \}\)/, 'the review says where its payment goes');
  assert.match(step, /const recipientRail = state\.recipient\.rail;/);
  const authorize = read('app/api/transfers/authorize/route.ts');
  assert.match(authorize, /calculateQuote\([^)]*\{ businessId: businessAccountId, destination: BANK_DESTINATION \}\)/, 'authorize re-quotes the bank payout it sends');
});

test('no surface quotes Splash fee on a kind it typed in: every quote goes through destinationKind', () => {
  const offenders = [];
  for (const root of ['app', 'components', 'lib']) {
    for (const file of sources(root)) {
      if (file.startsWith('lib/fees/')) continue;
      read(file).split(/\r?\n/).forEach((line, i) => {
        if (/buildFeeQuote\(\{\s*kind:\s*FEE_KIND\./.test(line) || /^\s*kind:\s*FEE_KIND\./.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
  }
  assert.deepEqual(offenders, []);
});

test('the delivery step prices the route it knows, and says which are priced when they open in Phase 2', () => {
  const step = read('components/transfer/StepDelivery.tsx');
  assert.doesNotMatch(step, /crypto wallet/i, 'this flow pays a bank account; a Sui wallet is paid from Send USDC');
  assert.match(step, /Send USDC/);
  assert.match(step, /PHASE_2_FEE_NOTE/, 'the Phase 2 routes say their fee is set when they open');
  assert.match(step, /option\.tier === 'PAYOUT_ONLY' \? pricing\.bankFeePhrase : PHASE_2_FEE_NOTE/);
});
