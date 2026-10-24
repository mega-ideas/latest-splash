/**
 * Amendment A1 §2.7: customer copy is rendered from the schedule, never typed
 * in.
 *
 * What is pinned here:
 *   * the landing's pricing line is A1 §2.7's, and the landing gets it from
 *     the schedule in force (app/page.tsx reads publishedFeeSchedule and hands
 *     it down); the hero callout, the steps, the comparison table, the ticker
 *     and the footer quote that schedule, not a flat rate;
 *   * the FAQ's answer to "What does a payment cost?" and the JSON-LD built
 *     from it carry the same pricing line;
 *   * the claims register and the numbers page render Splash's fee from the
 *     launch schedule, with a source and a date (check:numbers);
 *   * the fee breakdown (Splash fee with its kind and tier label, the
 *     partner's or Circle's fee with its source, the total debited) renders
 *     the same in the calculator, on the transfer review and on the receipt,
 *     rendered here on the server the way Next renders it;
 *   * a receipt of a payment authorized before A1, which carries no fee
 *     breakdown, still says what it said (its fee was inside the amount).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

import { FEE_KIND, LAUNCH_SCHEDULE } from '../lib/fees/schedule.ts';
import { pricingLine, rateRange, scheduleToWire } from '../lib/fees/copy.ts';
import { buildFeeQuote, feeQuoteToWire } from '../lib/fees/quote.ts';

// Node strips types but not JSX: compile the components the way Next would.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.tsx')) return nextLoad(url, context);
    const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    return { format: 'module', source: outputText, shortCircuit: true };
  },
});

const read = (path) => readFileSync(path, 'utf8');
/** Visible text of rendered markup: tags out, entities back, whitespace squashed. */
const text = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const LINE = pricingLine(LAUNCH_SCHEDULE);
const quote = feeQuoteToWire(
  buildFeeQuote({
    kind: FEE_KIND.BANK_PAYOUT,
    principalMinor: 1_000_000_000n,
    state: { feesOn: true, schedule: LAUNCH_SCHEDULE },
    partnerFee: { minor: 2_000_000n, source: 'Our Philippines payout partner, live quote' },
  }),
);

// ─── The landing ───────────────────────────────────────────────────────────

test('the landing renders its pricing from the schedule app/page.tsx reads', () => {
  const page = read('app/page.tsx');
  assert.match(page, /publishedFeeSchedule\(/, 'the page reads the schedule in force');
  assert.match(page, /<IsometricLanding[^>]*pricing=/, 'and hands the landing its pricing');
  assert.match(page, /landingFaq\(/, 'the FAQ JSON-LD is built from the same schedule');

  const landing = read('components/IsometricLanding.tsx');
  assert.match(landing, /pricing\.line/, 'the pricing line is on the page');
  assert.doesNotMatch(landing, /lockedCopy\.fee/, 'no flat rate from the claims register');
  assert.doesNotMatch(landing, /USDC transfers carry no Splash fee|'Free', 'USDC transfers'/, 'a wallet payment is not free under A1');
  const cinematic = read('components/landing/SettlementCinematic.tsx');
  assert.doesNotMatch(cinematic, /lockedCopy\.fee/);
  assert.match(cinematic, /pricing/);
});

test("the FAQ's cost answer is the pricing line", async () => {
  const { landingFaq } = await import('../content/landing-faq.ts');
  const faq = landingFaq(LAUNCH_SCHEDULE);
  const cost = faq.find((item) => /cost/i.test(item.q));
  assert.ok(cost, 'there is a cost question');
  assert.ok(cost.a.includes(LINE), cost.a);
});

test('the claims register and the numbers page carry the schedule, with a source and a date', async () => {
  const { lockedCopy, claims } = await import('../content/claims.ts');
  assert.equal('fee' in lockedCopy, false, 'no flat-rate headline');
  assert.equal('feeFootnote' in lockedCopy, false);
  assert.equal(claims.fee.claim, LINE);
  const { SEA_NUMBERS, validateSeaNumbers } = await import('../content/sea-numbers.ts');
  const fee = SEA_NUMBERS.find((n) => n.id === 'splash-fee-bank-payout');
  assert.ok(fee, "Splash's bank-payout fee is a number with provenance");
  assert.equal(fee.value, rateRange(LAUNCH_SCHEDULE[FEE_KIND.BANK_PAYOUT]));
  assert.match(fee.sourceUrl, /fee_config\.move$/);
  assert.equal(SEA_NUMBERS.some((n) => n.id === 'splash-fee-usd-php'), false, 'the flat-rate entry is gone');
  assert.deepEqual(validateSeaNumbers(SEA_NUMBERS), []);
});

// ─── The fee breakdown, rendered ───────────────────────────────────────────

test('the fee breakdown renders the three lines from the quote', async () => {
  const { default: FeeBreakdown } = await import('../components/fees/FeeBreakdown.tsx');
  const out = text(renderToStaticMarkup(createElement(FeeBreakdown, { quote })));
  assert.match(out, /Splash fee Bank payout · 1,000 to under 10,000 USDC · 0\.20% 2\.00 USDC/);
  assert.match(out, /Payout-partner fee Our Philippines payout partner, live quote 2\.00 USDC/);
  assert.match(out, /Total debited 1,002\.00 USDC/);
});

test('the receipt shows the breakdown it was charged', async () => {
  const { default: Receipt } = await import('../components/Receipt.tsx');
  const html = renderToStaticMarkup(
    createElement(Receipt, {
      txDigest: 'Pending',
      sender: 'Splash operator',
      recipient: 'Acme Supplies',
      amount: '1000.00',
      currency: 'USD',
      fees: quote,
      timestamp: '2026-10-24T08:00:00Z',
      status: 'Pending',
    }),
  );
  const out = text(html);
  assert.match(out, /Splash fee Bank payout · 1,000 to under 10,000 USDC · 0\.20% 2\.00 USDC/);
  assert.match(out, /Payout-partner fee Our Philippines payout partner, live quote 2\.00 USDC/);
  assert.match(out, /Total debited 1,002\.00 USDC/);
  assert.doesNotMatch(out, /incl\./, 'the fee is no longer inside the amount');
});

test('a receipt from before A1 still says what it said', async () => {
  const { default: Receipt } = await import('../components/Receipt.tsx');
  const out = text(
    renderToStaticMarkup(
      createElement(Receipt, {
        txDigest: 'Pending',
        sender: 'Splash operator',
        recipient: 'Acme Supplies',
        amount: '1000.00',
        currency: 'USD',
        fee: '7.00',
        timestamp: '2026-09-30T08:00:00Z',
        status: 'Pending',
      }),
    ),
  );
  assert.match(out, /Total cost 1,000\.00 USD incl\. 7\.00 fee/);
});

test('the calculator renders the breakdown from the schedule it is given', async () => {
  const { default: FeeCalculator } = await import('../components/landing/FeeCalculator.tsx');
  const out = text(renderToStaticMarkup(createElement(FeeCalculator, { schedule: scheduleToWire(LAUNCH_SCHEDULE) })));
  // The default amount, US$1,000, is a bank payout in the 1,000 to 10,000 band.
  assert.match(out, /Splash fee Bank payout · 1,000 to under 10,000 USDC · 0\.20% 2\.00 USDC/);
  assert.match(out, /Payout-partner fee/);
  assert.match(out, /Total debited 1,002\.00 USDC/);

  const cheaper = LAUNCH_SCHEDULE.map((k, kind) => (kind === FEE_KIND.BANK_PAYOUT ? { ...k, tiers: k.tiers.map((t) => ({ ...t, bps: t.bps / 2n })) } : k));
  const changed = text(renderToStaticMarkup(createElement(FeeCalculator, { schedule: scheduleToWire(cheaper) })));
  assert.match(changed, /0\.10% 1\.00 USDC/, 'a different schedule, a different fee: nothing is typed in');
});

test('the transfer review shows the breakdown and sends the fee it showed', () => {
  const step = read('components/transfer/StepQuote.tsx');
  assert.match(step, /<FeeBreakdown/);
  assert.doesNotMatch(step, /All-in fee/);
  const receiptStep = read('components/transfer/StepReceipt.tsx');
  assert.match(receiptStep, /fees=\{/);
  const shared = read('app/receipt/[token]/page.tsx');
  assert.match(shared, /fees=\{intent\.fees\}/, 'the shared receipt shows the breakdown recorded at authorization');
});
