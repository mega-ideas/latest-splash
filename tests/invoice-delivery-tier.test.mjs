import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The invoice loop recommends only a delivery the authorize step accepts, and
 * shows the confidence the parser actually returned.
 *
 * Red before green: on the tree before the fix, extract-invoice mapped a PHP
 * invoice to SWEEP_ACCOUNT unconditionally — a fund-holding tier the Phase-0
 * custody gate refuses (tests/phase0-custody-gate.test.mjs) — and the transfer
 * page prefilled the same tier from ?invoiceId=. So "Open payment intent" led
 * to a 403. The route also reported `Math.max(0.96, extraction.confidence)`,
 * so a heuristic read parseInvoice scored 0.2 was shown as 96% confident.
 */

// invoiceDeliveryTier() also reads the sweep switch by default. Unset is on,
// so this file tests the custody phase alone whatever the shell exports;
// tests/sweep-account-switch.test.mjs covers the switch.
delete process.env.SWEEP_ACCOUNT_ENABLED;

const gate = () => import('../lib/server/custody-phase.ts');

const CUSTODY_OFF = { custodyPackageId: '' };
const CUSTODY_ON = { custodyPackageId: '0x' + 'cd'.repeat(32) };

async function source(relative) {
  const raw = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('a PHP invoice is recommended PAYOUT_ONLY in Phase 0, and SWEEP_ACCOUNT only once custody is on', async () => {
  const { invoiceDeliveryTier } = await gate();

  assert.equal(invoiceDeliveryTier('PHP', CUSTODY_OFF), 'PAYOUT_ONLY', 'SWEEP_ACCOUNT holds funds: not in Phase 0');
  assert.equal(invoiceDeliveryTier('PHP', CUSTODY_ON), 'SWEEP_ACCOUNT', 'the sweep mapping survives behind the custody phase');
  for (const currency of ['USD', 'USDC', 'IDR', undefined]) {
    assert.equal(invoiceDeliveryTier(currency, CUSTODY_OFF), 'PAYOUT_ONLY', String(currency));
    assert.equal(invoiceDeliveryTier(currency, CUSTODY_ON), 'PAYOUT_ONLY', String(currency));
  }
});

test('every recommendation is a tier the authorize step accepts, in either phase', async () => {
  const { invoiceDeliveryTier, deliveryTierAllowed } = await gate();

  for (const config of [CUSTODY_OFF, CUSTODY_ON]) {
    for (const currency of ['PHP', 'USD', 'USDC', 'IDR', undefined]) {
      const tier = invoiceDeliveryTier(currency, config);
      assert.equal(deliveryTierAllowed(tier, config), true, `${currency} → ${tier} with custody ${config.custodyPackageId ? 'on' : 'off'}`);
    }
  }
});

test('extract-invoice takes its tier from the gate and reports the parser confidence unmodified', async () => {
  const route = await source('app/api/copilot/extract-invoice/route.ts');

  assert.match(route, /const deliveryTier = invoiceDeliveryTier\(invoice\.targetCurrency\);/);
  assert.doesNotMatch(route, /=== 'PHP' \? 'SWEEP_ACCOUNT'/, 'no hardcoded PHP → SWEEP_ACCOUNT mapping');
  assert.doesNotMatch(route, /Math\.max\(/, 'confidence is not floored');
  assert.doesNotMatch(route, /0\.96/);

  const success = route.slice(route.indexOf('const deliveryTier'));
  assert.match(success, /confidence: extraction\.confidence,/, 'the recommendation carries the parser confidence');

  // The Phase-0 wording names the licence without claiming one.
  assert.match(success, /money-broking licence Splash does not hold yet/);
  assert.doesNotMatch(success, /\blicensed\b/i);
  assert.doesNotMatch(success, /Bank payout - direct local delivery/, 'the old text described the route for every currency as a bank payout');
});

test('the unverified-business refusal still stops the loop before any tier is recommended', async () => {
  const route = await source('app/api/copilot/extract-invoice/route.ts');

  const refusal = route.indexOf("laneAccess(state, 'FIAT_OUT_LOCAL')");
  assert.ok(refusal > 0 && refusal < route.indexOf('const deliveryTier'));
  assert.match(route, /blocked: \{ lane: 'FIAT_OUT_LOCAL', reason: access\.reason \}/);
  assert.match(route, /suggestedAction: 'lane:FIAT_OUT_LOCAL:locked'/);
  assert.match(route, /return NextResponse\.json\(\{ extraction, suggestion: refused \}\);/);
});

test('the transfer page prefills the server-gated tier from ?invoiceId=, not its own PHP mapping', async () => {
  const page = await source('app/dashboard/transfer/page.tsx');
  assert.doesNotMatch(page, /'SWEEP_ACCOUNT'/, 'the page names no fund-holding tier of its own');
  assert.match(page, /deliveryTier: invoice\.recommendedDeliveryTier \?\? 'PAYOUT_ONLY'/);

  // The page is a client component and cannot read the custody phase, so the
  // invoice read answers it — through the same function extract-invoice uses.
  const api = await source('app/api/invoices/[id]/route.ts');
  const get = api.slice(api.indexOf('export async function GET('), api.indexOf('export async function PATCH('));
  assert.match(get, /recommendedDeliveryTier: invoiceDeliveryTier\(invoice\.targetCurrency\)/);
});
