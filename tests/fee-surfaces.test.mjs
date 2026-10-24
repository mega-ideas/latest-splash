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
 *     computes a fee as if they were (L7a).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

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
