import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * v2 Phase 3, brief 5.2: Home (/dashboard), the first screen after sign-in.
 *
 * The board (docs/design/v2-previews/boards/Main.dc.html) shows three figures,
 * Splash Wallet, Needs approval and Sent this month, over a Recent payments
 * table, with quick actions. The brief deletes the settlement-engine
 * container, the roadmap cards ("01 Live-model Pay…"), the Corridor readiness
 * table with its model volumes and test success, and "Settlement SLA 400ms".
 *
 * Real numbers only. Every figure is computed by lib/dashboard/home.ts from
 * this org's own records (transfers, wallet payments, proposals waiting for a
 * decision), so it is tested here as behaviour; a figure with no source shows
 * an empty or unavailable state, never a number.
 */

const ROOT = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, ROOT), 'utf8');
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const ORG = 'org_acme';
const OTHER = 'org_bravo';
// 25 Oct 2026, 09:00 UTC.
const NOW = new Date('2026-10-25T09:00:00.000Z');

function transfer(overrides = {}) {
  return {
    id: 'ti_1',
    orgId: ORG,
    state: 'SETTLED',
    recipientName: 'Luzon Components Inc.',
    targetCurrency: 'PHP',
    targetAmount: '287000.00',
    sourceAmountUsd: '5000.00',
    sourceStablecoin: 'USDC',
    stablecoinAmountMicro: 5_000_000_000,
    createdAt: '2026-10-20T03:00:00.000Z',
    updatedAt: '2026-10-20T03:05:00.000Z',
    ...overrides,
  };
}

function walletPayment(overrides = {}) {
  return {
    id: 'out_1',
    kind: 'TRANSFER',
    status: 'CONFIRMED',
    recipientName: null,
    recipientAddress: '0x7a2b000000000000000000000000000000000000000000000000000000c41e',
    principalMinor: 1_200_000_000n,
    createdAt: '2026-10-22T08:00:00.000Z',
    confirmedAt: '2026-10-22T08:00:30.000Z',
    ...overrides,
  };
}

function proposal(overrides = {}) {
  return {
    id: 'prop_1',
    orgId: ORG,
    kind: 'PAYMENT',
    status: 'PENDING_APPROVAL',
    expiresAt: '2026-10-25T09:03:00.000Z',
    explain: { financialImpact: { amountIn: 5_000_000_000n, fxRate: { value: '57.40', quoteRef: 'corridor:USD/PHP', observedAt: '2026-10-25T08:58:00.000Z' } } },
    ...overrides,
  };
}

const home = () => import('../lib/dashboard/home.ts');

/* ── Sent this month ───────────────────────────────────────────────── */

test('sent this month counts settled USDC payments made this calendar month (UTC), and nothing else', async () => {
  const { buildHomeSummary } = await home();
  const summary = buildHomeSummary({
    orgId: ORG,
    now: NOW,
    transfers: [
      transfer({ id: 'ti_settled', stablecoinAmountMicro: 5_000_000_000 }),
      transfer({ id: 'ti_disbursed', state: 'DISBURSED', stablecoinAmountMicro: 0, sourceAmountUsd: '250.50' }),
      transfer({ id: 'ti_pending', state: 'SETTLING' }),
      transfer({ id: 'ti_failed', state: 'FAILED' }),
      transfer({ id: 'ti_last_month', createdAt: '2026-09-30T23:59:59.000Z' }),
      transfer({ id: 'ti_sample', demo: true }),
      transfer({ id: 'ti_usdt', sourceStablecoin: 'USDT' }),
    ],
    walletPayments: [
      walletPayment({ id: 'out_ok' }),
      walletPayment({ id: 'out_pending', status: 'PENDING', confirmedAt: null }),
      walletPayment({ id: 'out_failed', status: 'FAILED', confirmedAt: null }),
      walletPayment({ id: 'out_sept', confirmedAt: '2026-09-29T00:00:00.000Z', createdAt: '2026-09-29T00:00:00.000Z' }),
    ],
    proposals: [],
  });

  // 5,000 + 250.50 + 1,200 USDC, in 6-decimal minor units.
  assert.equal(summary.sentThisMonth.usdcMinor, '6450500000');
  assert.equal(summary.sentThisMonth.payments, 3);
  // A USDT-funded transfer is not a USDC amount; it is counted as left out,
  // not converted at a rate nobody quoted.
  assert.equal(summary.sentThisMonth.notCounted, 1);
  assert.equal(summary.sentThisMonth.since, '2026-10-01T00:00:00.000Z');
});

test('an org with no payments sends zero, not a placeholder', async () => {
  const { buildHomeSummary } = await home();
  const summary = buildHomeSummary({ orgId: ORG, now: NOW, transfers: [], walletPayments: [], proposals: [] });
  assert.equal(summary.sentThisMonth.usdcMinor, '0');
  assert.equal(summary.sentThisMonth.payments, 0);
  assert.deepEqual(summary.recent, []);
  assert.equal(summary.needsApproval.count, 0);
  assert.equal(summary.needsApproval.soonestExpiresAt, null);
});

/* ── Needs approval ────────────────────────────────────────────────── */

test('needs approval counts only this org’s payments waiting for a decision that have not expired', async () => {
  const { buildHomeSummary } = await home();
  const summary = buildHomeSummary({
    orgId: ORG,
    now: NOW,
    transfers: [],
    walletPayments: [],
    proposals: [
      proposal({ id: 'p_soon' }),
      proposal({ id: 'p_later', status: 'POLICY_EVALUATED', expiresAt: '2026-10-25T20:00:00.000Z' }),
      proposal({ id: 'p_other_org', orgId: OTHER, expiresAt: '2026-10-25T09:01:00.000Z' }),
      proposal({ id: 'p_expired', expiresAt: '2026-10-25T08:59:00.000Z' }),
      proposal({ id: 'p_approved', status: 'APPROVED' }),
      proposal({ id: 'p_rejected', status: 'REJECTED' }),
    ],
  });
  assert.equal(summary.needsApproval.count, 2);
  assert.equal(summary.needsApproval.soonestExpiresAt, '2026-10-25T09:03:00.000Z');
  assert.equal(summary.needsApproval.soonestHasRate, true);
  assert.equal(summary.needsApproval.expiringSoon, true);
});

test('the rate-expiry warning names the soonest expiry, and says rate only when the payment was priced at one', async () => {
  const { approvalNote } = await home();
  const nowMs = NOW.getTime();
  assert.deepEqual(
    approvalNote({ count: 2, soonestExpiresAt: '2026-10-25T09:03:00.000Z', soonestHasRate: true, expiringSoon: true }, nowMs),
    { text: 'One rate expires in 3 min', warn: true },
  );
  assert.deepEqual(
    approvalNote({ count: 1, soonestExpiresAt: '2026-10-25T09:00:20.000Z', soonestHasRate: false, expiringSoon: true }, nowMs),
    { text: 'One approval expires in under a minute', warn: true },
  );
  assert.deepEqual(
    approvalNote({ count: 1, soonestExpiresAt: '2026-10-25T14:30:00.000Z', soonestHasRate: true, expiringSoon: false }, nowMs),
    { text: 'The next expires in 5h 30m', warn: false },
  );
  assert.deepEqual(
    approvalNote({ count: 0, soonestExpiresAt: null, soonestHasRate: false, expiringSoon: false }, nowMs),
    { text: 'Nothing is waiting for you', warn: false },
  );
});

/* ── Recent payments ───────────────────────────────────────────────── */

test('recent payments merge bank payouts and wallet payments, newest first, with type and status', async () => {
  const { buildHomeSummary } = await home();
  const summary = buildHomeSummary({
    orgId: ORG,
    now: NOW,
    transfers: [
      transfer({ id: 'ti_ph', createdAt: '2026-10-24T01:00:00.000Z' }),
      transfer({ id: 'ti_id', targetCurrency: 'IDR', targetAmount: '81450000', recipientName: 'PT Sinar Jaya Abadi', state: 'SETTLING', createdAt: '2026-10-23T01:00:00.000Z' }),
      transfer({ id: 'ti_bad', state: 'REFUNDED', createdAt: '2026-10-21T01:00:00.000Z' }),
      transfer({ id: 'ti_sample', demo: true, createdAt: '2026-10-19T01:00:00.000Z' }),
    ],
    walletPayments: [
      walletPayment({ id: 'out_new', createdAt: '2026-10-25T08:00:00.000Z' }),
      walletPayment({ id: 'out_named', recipientName: 'Kedai Teknik', status: 'EXPIRED', confirmedAt: null, createdAt: '2026-10-22T00:00:00.000Z' }),
    ],
    proposals: [],
  });

  assert.deepEqual(
    summary.recent.map((r) => [r.id, r.recipient, r.type, r.amount, r.status, r.sample]),
    [
      ['out_new', '0x7a2b…c41e', 'Wallet', '1,200.00 USDC', 'settled', false],
      ['ti_ph', 'Luzon Components Inc.', 'Bank · PH', 'PHP 287,000.00', 'settled', false],
      ['ti_id', 'PT Sinar Jaya Abadi', 'Bank · ID', 'IDR 81,450,000', 'on_the_way', false],
      ['out_named', 'Kedai Teknik', 'Wallet', '1,200.00 USDC', 'expired', false],
      ['ti_bad', 'Luzon Components Inc.', 'Bank · PH', 'PHP 287,000.00', 'failed', false],
      ['ti_sample', 'Luzon Components Inc.', 'Bank · PH', 'PHP 287,000.00', 'settled', true],
    ],
  );
});

test('recent payments stop at six', async () => {
  const { buildHomeSummary } = await home();
  const transfers = Array.from({ length: 9 }, (_, i) => transfer({ id: `ti_${i}`, createdAt: `2026-10-0${i + 1}T00:00:00.000Z` }));
  const summary = buildHomeSummary({ orgId: ORG, now: NOW, transfers, walletPayments: [], proposals: [] });
  assert.equal(summary.recent.length, 6);
  assert.equal(summary.recent[0].id, 'ti_8');
});

/* ── Money formatting ──────────────────────────────────────────────── */

test('USDC amounts are grouped, two places, and never rounded up', async () => {
  const { formatUsdcMinor } = await home();
  assert.equal(formatUsdcMinor(0n), '0.00');
  assert.equal(formatUsdcMinor(1_234_567_891n), '1,234.56');
  assert.equal(formatUsdcMinor('186400000000'), '186,400.00');
  assert.equal(formatUsdcMinor(9_999n), '0.00');
});

/* ── The wallet card ───────────────────────────────────────────────── */

test('the business wallet comes from the Phase 2 API when it is there, and is honestly absent when it is not', async () => {
  const { businessWalletFrom } = await home();
  const addr = '0x' + 'ab'.repeat(32);
  assert.deepEqual(businessWalletFrom(200, { wallet: addr }), { kind: 'address', address: addr });
  assert.deepEqual(businessWalletFrom(200, { wallet: null }), { kind: 'none' });
  // No route yet (Phase 2 not deployed) reads as "no business wallet", not an error.
  assert.deepEqual(businessWalletFrom(404, null), { kind: 'none' });
  assert.deepEqual(businessWalletFrom(502, { error: 'The business account could not be read from the chain.' }), { kind: 'error' });
  assert.deepEqual(businessWalletFrom(200, { wallet: 'not-an-address' }), { kind: 'error' });
});

/* ── The route ─────────────────────────────────────────────────────── */

test('GET /api/home reads only the caller’s org, from the session', async () => {
  const route = codeOnly(await source('app/api/home/route.ts'));
  assert.match(route, /requireCustomerRequest\(request\)/);
  assert.match(route, /requireSessionAccount\(auth\.session\)/);
  assert.match(route, /listTransfersFor\(orgId,/);
  assert.match(route, /listUsdcRecords\([^)]*,\s*orgId\)/);
  assert.match(route, /buildHomeSummary\(\{[^}]*orgId/);
  assert.doesNotMatch(route, /searchParams\.get\('org/, 'the org never comes from the request');
  assert.match(route, /no-store/);
});

/* ── The page ──────────────────────────────────────────────────────── */

test('Home is titled Home and the modeled panels are gone', async () => {
  const raw = await source('app/dashboard/page.tsx');
  const page = codeOnly(raw);
  assert.match(page, /title="Home"/);
  assert.doesNotMatch(page, /title="Overview"/);
  for (const gone of [
    'SettlementEngineFlow',
    'NETWORK_STATUS',
    'Live-model',
    'Corridor Readiness',
    'Model volume',
    'Test success',
    '400ms',
    'Settlement SLA',
    'LiveExchangeTicker',
    'Batch TOTP authorization',
    '$6,670',
    'Treasury Projection',
  ]) {
    assert.ok(!page.includes(gone), `Home still renders ${gone}`);
  }
});

test('Home shows the board’s figures from real sources, with loading and empty states', async () => {
  const page = codeOnly(await source('app/dashboard/page.tsx'));
  for (const label of ['Splash Wallet', 'Needs approval', 'Sent this month', 'Recent payments']) {
    assert.ok(page.includes(label), `Home is missing ${label}`);
  }
  assert.match(page, /fetch\('\/api\/home'/);
  assert.match(page, /fetch\('\/api\/wallet\/business'/);
  assert.match(page, /\/api\/stablecoin\/wallet/);
  assert.match(page, /No payments yet\./);
  assert.match(page, /Loading payments…/);
  assert.match(page, /Balance unavailable/);
  assert.match(page, /No business wallet yet/);
});

test('Home has quick actions to pay, batch, open Wallet and ask Zeke', async () => {
  const page = codeOnly(await source('app/dashboard/page.tsx'));
  for (const href of ['/dashboard/transfer', '/dashboard/batch', '/dashboard/wallet', '/dashboard/zeke', '/queue']) {
    assert.ok(page.includes(`href="${href}"`) || page.includes(`href: '${href}'`), `no quick action to ${href}`);
  }
});

test('the modeled FX ticker is deleted with Home’s use of it', async () => {
  await assert.rejects(source('components/LiveExchangeTicker.tsx'), /ENOENT/);
});
