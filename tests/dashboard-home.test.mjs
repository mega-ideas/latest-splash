import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { migratedDb } from './helpers/store-db.mjs';

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
const OWNER = { userId: 'u_owner', role: 'OWNER' };
const STAFF = { userId: 'u_staff', role: 'MAKER' };

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
    settledAt: '2026-10-20T03:05:00.000Z',
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
    txDigest: 'DIGEST_1',
    reservedUntil: '2026-10-22T08:05:00.000Z',
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
    createdBy: 'u_staff',
    approvals: [],
    expiresAt: '2026-10-25T09:03:00.000Z',
    explain: { financialImpact: { amountIn: 5_000_000_000n, fxRate: { value: '57.40', quoteRef: 'corridor:USD/PHP', observedAt: '2026-10-25T08:58:00.000Z' } } },
    ...overrides,
  };
}

const home = () => import('../lib/dashboard/home.ts');
const summaryOf = async (input) => (await home()).buildHomeSummary({ orgId: ORG, now: NOW, transfers: [], walletPayments: [], proposals: [], viewer: OWNER, ...input });

/* ── Sent this month ───────────────────────────────────────────────── */

test('sent this month counts settled USDC payments settled this calendar month (UTC), and nothing else', async () => {
  const summary = await summaryOf({
    transfers: [
      transfer({ id: 'ti_settled', stablecoinAmountMicro: 5_000_000_000 }),
      transfer({ id: 'ti_disbursed', state: 'DISBURSED', stablecoinAmountMicro: 0, sourceAmountUsd: '250.50' }),
      transfer({ id: 'ti_pending', state: 'SETTLING', settledAt: null }),
      transfer({ id: 'ti_failed', state: 'FAILED', settledAt: null }),
      transfer({ id: 'ti_last_month', createdAt: '2026-09-29T23:00:00.000Z', settledAt: '2026-09-30T23:59:59.000Z' }),
      transfer({ id: 'ti_sample', demo: true }),
      transfer({ id: 'ti_usdt', sourceStablecoin: 'USDT' }),
    ],
    walletPayments: [
      walletPayment({ id: 'out_ok' }),
      walletPayment({ id: 'out_pending', status: 'PENDING', confirmedAt: null }),
      walletPayment({ id: 'out_failed', status: 'FAILED', confirmedAt: null }),
      walletPayment({ id: 'out_sept', confirmedAt: '2026-09-29T00:00:00.000Z', createdAt: '2026-09-29T00:00:00.000Z' }),
    ],
  });

  // 5,000 + 250.50 + 1,200 USDC, in 6-decimal minor units.
  assert.equal(summary.sentThisMonth.usdcMinor, '6450500000');
  assert.equal(summary.sentThisMonth.payments, 3);
  // A USDT-funded transfer is not a USDC amount; it is counted as left out,
  // not converted at a rate nobody quoted.
  assert.equal(summary.sentThisMonth.notCounted, 1);
  assert.equal(summary.sentThisMonth.unreadable, 0);
  assert.equal(summary.sentThisMonth.since, '2026-10-01T00:00:00.000Z');
});

test('a transfer counts in the month it settled, not the month it was created', async () => {
  // Created in the last second of September, settled in October: October's.
  const october = await summaryOf({
    transfers: [transfer({ id: 'ti_cross', createdAt: '2026-09-30T23:59:00.000Z', settledAt: '2026-10-01T00:04:00.000Z' })],
  });
  assert.equal(october.sentThisMonth.payments, 1);
  assert.equal(october.sentThisMonth.usdcMinor, '5000000000');

  // And September would not have counted it either: it settled after.
  const september = await summaryOf({
    now: new Date('2026-09-30T23:59:59.000Z'),
    transfers: [transfer({ id: 'ti_cross', createdAt: '2026-09-30T23:59:00.000Z', settledAt: '2026-10-01T00:04:00.000Z' })],
  });
  assert.equal(september.sentThisMonth.payments, 0);

  // No recorded transition (the in-process store before a restart): the
  // record's last write, which is at or after the settlement, stands in.
  const fallback = await summaryOf({
    transfers: [transfer({ id: 'ti_old', createdAt: '2026-09-30T23:59:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', settledAt: undefined })],
  });
  assert.equal(fallback.sentThisMonth.payments, 1);
});

test('a USDC amount that cannot be read is counted as unreadable, not as another stablecoin', async () => {
  const summary = await summaryOf({
    transfers: [
      transfer({ id: 'ti_bad_amount', stablecoinAmountMicro: 0, sourceAmountUsd: '1e3' }),
      transfer({ id: 'ti_usdt', sourceStablecoin: 'USDT' }),
    ],
  });
  assert.equal(summary.sentThisMonth.payments, 0);
  assert.equal(summary.sentThisMonth.notCounted, 1);
  assert.equal(summary.sentThisMonth.unreadable, 1);
});

test('an org with no payments sends zero, not a placeholder', async () => {
  const summary = await summaryOf({});
  assert.equal(summary.sentThisMonth.usdcMinor, '0');
  assert.equal(summary.sentThisMonth.payments, 0);
  assert.deepEqual(summary.recent, []);
  assert.equal(summary.needsApproval.count, 0);
  assert.equal(summary.needsApproval.soonestExpiresAt, null);
});

/* ── Needs approval ────────────────────────────────────────────────── */

test('needs approval counts only this org’s payments waiting for a decision that have not expired', async () => {
  const summary = await summaryOf({
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
});

test('needs approval counts what the viewer can still approve; a staff member sees their own requests apart', async () => {
  const proposals = [
    // Raised by staff over their rule (Sky, 25 Oct: staff may ask owners to approve).
    proposal({ id: 'p_staff', createdBy: 'u_staff', expiresAt: '2026-10-25T09:20:00.000Z' }),
    // Already approved by this owner, waiting for a second approver.
    proposal({ id: 'p_owner_signed', createdBy: 'u_other', approvals: [{ userId: 'u_owner', role: 'OWNER', signedAt: '2026-10-25T08:00:00.000Z' }], expiresAt: '2026-10-25T09:01:00.000Z' }),
    // The owner's own request: maker never approves it.
    proposal({ id: 'p_owner_own', createdBy: 'u_owner', expiresAt: '2026-10-25T09:02:00.000Z' }),
  ];

  const owner = await summaryOf({ proposals, viewer: OWNER });
  assert.equal(owner.needsApproval.count, 1, 'only the staff request is the owner’s to approve');
  assert.equal(owner.needsApproval.soonestExpiresAt, '2026-10-25T09:20:00.000Z');
  assert.equal(owner.needsApproval.yourRequests, 1);

  const staff = await summaryOf({ proposals, viewer: STAFF });
  assert.equal(staff.needsApproval.count, 0, 'a maker approves nothing, least of all their own request');
  assert.equal(staff.needsApproval.yourRequests, 1);

  const nobody = await summaryOf({ proposals, viewer: null });
  assert.equal(nobody.needsApproval.count, 0, 'authority is never assumed');
  assert.equal(nobody.needsApproval.yourRequests, 0);
});

test('the roles Home counts as approvers are the ones the approval state machine accepts', async () => {
  const { APPROVER_ROLES } = await home();
  const { canRoleApprove } = await import('../lib/queue/proposal-state.ts');
  for (const role of ['OWNER', 'FINANCE_ADMIN', 'MAKER', 'APPROVER', 'VIEWER', 'AUDITOR', 'DEVELOPER']) {
    assert.equal(APPROVER_ROLES.has(role), canRoleApprove(role), role);
  }
});

test('the rate-expiry warning is worked out from the clock, and an expired approval asks for a refresh', async () => {
  const { approvalNote } = await home();
  const nowMs = NOW.getTime();
  const waiting = (soonestExpiresAt, soonestHasRate = true) => ({ count: 2, soonestExpiresAt, soonestHasRate, yourRequests: 0 });

  assert.deepEqual(approvalNote(waiting('2026-10-25T09:03:00.000Z'), nowMs), { text: 'One rate expires in 3 min', warn: true, stale: false });
  assert.deepEqual(approvalNote(waiting('2026-10-25T09:00:20.000Z', false), nowMs), { text: 'One approval expires in under a minute', warn: true, stale: false });
  assert.deepEqual(approvalNote(waiting('2026-10-25T14:30:00.000Z'), nowMs), { text: 'The next expires in 5h 30m', warn: false, stale: false });

  // Loaded with 40 minutes left: no warning then, a warning 15 minutes later.
  const later = waiting('2026-10-25T09:40:00.000Z');
  assert.equal(approvalNote(later, nowMs).warn, false);
  assert.equal(approvalNote(later, nowMs + 15 * 60_000).warn, true);

  // An hour after it lapsed the page must not say it is about to.
  assert.deepEqual(approvalNote(waiting('2026-10-25T09:03:00.000Z'), nowMs + 60 * 60_000), { text: 'An approval has expired. Updating…', warn: true, stale: true });

  assert.deepEqual(approvalNote({ count: 0, soonestExpiresAt: null, soonestHasRate: false, yourRequests: 0 }, nowMs), { text: 'Nothing is waiting for you', warn: false, stale: false });
});

test('a staff member’s own requests are named as waiting for approval', async () => {
  const { ownRequestsNote } = await home();
  assert.equal(ownRequestsNote({ count: 0, soonestExpiresAt: null, soonestHasRate: false, yourRequests: 0 }), null);
  assert.equal(ownRequestsNote({ count: 0, soonestExpiresAt: null, soonestHasRate: false, yourRequests: 1 }), 'Your 1 request is waiting for approval');
  assert.equal(ownRequestsNote({ count: 0, soonestExpiresAt: null, soonestHasRate: false, yourRequests: 3 }), 'Your 3 requests are waiting for approval');
});

/* ── Recent payments ───────────────────────────────────────────────── */

test('recent payments merge bank payouts and wallet payments, newest first, with type and status', async () => {
  const summary = await summaryOf({
    transfers: [
      transfer({ id: 'ti_ph', createdAt: '2026-10-24T01:00:00.000Z' }),
      transfer({ id: 'ti_id', targetCurrency: 'IDR', targetAmount: '81450000', recipientName: 'PT Sinar Jaya Abadi', state: 'SETTLING', createdAt: '2026-10-23T01:00:00.000Z' }),
      transfer({ id: 'ti_bad', state: 'REFUNDED', createdAt: '2026-10-21T01:00:00.000Z' }),
    ],
    walletPayments: [
      walletPayment({ id: 'out_new', createdAt: '2026-10-25T08:00:00.000Z' }),
      walletPayment({ id: 'out_sent', recipientName: 'Kedai Teknik', status: 'PENDING', confirmedAt: null, txDigest: 'DIGEST_2', createdAt: '2026-10-22T12:00:00.000Z' }),
      walletPayment({ id: 'out_failed', recipientName: 'Kedai Teknik', status: 'FAILED', confirmedAt: null, txDigest: null, createdAt: '2026-10-22T00:00:00.000Z' }),
    ],
  });

  assert.deepEqual(
    summary.recent.map((r) => [r.id, r.recipient, r.type, r.amount, r.status]),
    [
      ['out_new', '0x7a2b…c41e', 'Wallet', '1,200.00 USDC', 'settled'],
      ['ti_ph', 'Luzon Components Inc.', 'Bank · PH', 'PHP 287,000.00', 'settled'],
      ['ti_id', 'PT Sinar Jaya Abadi', 'Bank · ID', 'IDR 81,450,000', 'on_the_way'],
      ['out_sent', 'Kedai Teknik', 'Wallet', '1,200.00 USDC', 'on_the_way'],
      ['out_failed', 'Kedai Teknik', 'Wallet', '1,200.00 USDC', 'failed'],
      ['ti_bad', 'Luzon Components Inc.', 'Bank · PH', 'PHP 287,000.00', 'failed'],
    ],
  );
});

test('a wallet quote that was never sent is not a payment, however old it is', async () => {
  // A quote starts PENDING with a reservation and only becomes EXPIRED when
  // a later send closes it; nothing sweeps it. Probe from the review: one
  // quoted on 1 Jun and never broadcast came out as "On the way" in October.
  const summary = await summaryOf({
    walletPayments: [
      walletPayment({ id: 'q_june', status: 'PENDING', txDigest: null, confirmedAt: null, createdAt: '2026-06-01T00:00:00.000Z', reservedUntil: '2026-06-01T00:05:00.000Z' }),
      walletPayment({ id: 'q_now', status: 'PENDING', txDigest: null, confirmedAt: null, createdAt: '2026-10-25T08:59:00.000Z', reservedUntil: '2026-10-25T09:04:00.000Z' }),
      walletPayment({ id: 'q_closed', status: 'EXPIRED', txDigest: null, confirmedAt: null, createdAt: '2026-10-24T00:00:00.000Z' }),
    ],
  });
  assert.deepEqual(summary.recent, [], 'no row says money is moving that nobody sent');
  assert.equal(summary.sentThisMonth.payments, 0);
});

test('sample transfers are not listed among real payments', async () => {
  const summary = await summaryOf({
    transfers: [transfer({ id: 'ti_real', createdAt: '2026-10-24T00:00:00.000Z' }), transfer({ id: 'ti_sample', demo: true, createdAt: '2026-10-25T00:00:00.000Z' })],
  });
  assert.deepEqual(summary.recent.map((r) => r.id), ['ti_real']);
  assert.ok(!('sample' in summary.recent[0]), 'no row carries a sample flag for the page to label');
});

test('a payout amount shows its currency’s decimals however it was stored', async () => {
  // Postgres hands targetAmount back without trailing zeros ("57400"); the
  // in-process store keeps what was typed, grouping commas included.
  const summary = await summaryOf({
    transfers: [
      transfer({ id: 'a', targetAmount: '57400', createdAt: '2026-10-24T03:00:00.000Z' }),
      transfer({ id: 'b', targetAmount: '57400.5', createdAt: '2026-10-23T03:00:00.000Z' }),
      transfer({ id: 'c', targetCurrency: 'IDR', targetAmount: '81450000.00', createdAt: '2026-10-22T03:00:00.000Z' }),
      transfer({ id: 'd', targetAmount: '1,234.5', createdAt: '2026-10-21T03:00:00.000Z' }),
    ],
  });
  assert.deepEqual(summary.recent.map((r) => r.amount), ['PHP 57,400.00', 'PHP 57,400.50', 'IDR 81,450,000', 'PHP 1,234.50']);
});

test('recent payments stop at six', async () => {
  const transfers = Array.from({ length: 9 }, (_, i) => transfer({ id: `ti_${i}`, createdAt: `2026-10-0${i + 1}T00:00:00.000Z` }));
  const summary = await summaryOf({ transfers });
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

test('the wallet card reads every answer the Phase 2 business wallet route gives', async () => {
  // GET /api/wallet/business on v2/phase2-backend (app/api/wallet/business/
  // route.ts, lib/server/wallet-route.ts, lib/server/wallet-deps.ts):
  //   200 { wallet, pendingWallet }   the BusinessAccount as read from chain
  //   409  this business has no on-chain account yet
  //   503  DATABASE_URL, the v2 network gate or the v2 object ids are missing
  //   403  no membership, or the session and authority orgs differ
  //   502  the chain could not be read
  const { businessWalletFrom } = await home();
  const addr = '0x' + 'ab'.repeat(32);
  const pending = '0x' + 'cd'.repeat(32);
  assert.deepEqual(businessWalletFrom(200, { wallet: addr, pendingWallet: null }), { kind: 'address', address: addr });
  assert.deepEqual(businessWalletFrom(200, { wallet: null, pendingWallet: null }), { kind: 'none' });
  assert.deepEqual(businessWalletFrom(200, { wallet: null, pendingWallet: pending }), { kind: 'pending' });
  assert.deepEqual(businessWalletFrom(409, { error: 'this business has no on-chain account yet, so it cannot have a business wallet' }), { kind: 'none' });
  assert.deepEqual(businessWalletFrom(503, { error: 'the business wallet needs the database, and DATABASE_URL is not set' }), { kind: 'off' });
  // No route at all (a build without Phase 2) is the same: nothing to retry.
  assert.deepEqual(businessWalletFrom(404, null), { kind: 'off' });
  assert.deepEqual(businessWalletFrom(403, { error: 'no membership' }), { kind: 'no_access' });
  assert.deepEqual(businessWalletFrom(502, { error: 'The business account could not be read from the chain.' }), { kind: 'error' });
  assert.deepEqual(businessWalletFrom(500, null), { kind: 'error' });
  assert.deepEqual(businessWalletFrom(200, { wallet: 'not-an-address' }), { kind: 'error' });
});

test('only a failed read offers Try again; the other wallet states say what is true', async () => {
  const page = codeOnly(await source('app/dashboard/page.tsx'));
  for (const copy of ['No business wallet yet', 'Wallet being set up', 'Business wallet not available', 'Balance unavailable']) {
    assert.ok(page.includes(copy), `the wallet card is missing “${copy}”`);
  }
  const unavailable = page.slice(page.indexOf('Balance unavailable'));
  assert.match(unavailable.slice(0, 1200), /Try again/);
  const off = page.slice(page.indexOf('Business wallet not available'), page.indexOf('Balance unavailable'));
  assert.doesNotMatch(off, /Try again/, 'retrying cannot switch a server setting on');
});

/* ── The stores ────────────────────────────────────────────────────── */

test('when a transfer settled comes from its recorded transitions, inside its org', async () => {
  const { client, db } = await migratedDb();
  await client.exec(`
    INSERT INTO payment_intents (id, org_id, state, source_amount_minor, source_currency, target_amount_minor, target_currency, created_at)
    VALUES ('pi_a', 'acme', 'SETTLED', 5000000000, 'USD', 287000000000, 'PHP', '2026-09-30T23:59:00Z'),
           ('pi_b', 'northwind', 'SETTLED', 1000000, 'USD', 57000000, 'PHP', '2026-10-02T00:00:00Z');
    INSERT INTO intent_transitions (id, intent_id, from_state, to_state, created_at) VALUES
      ('t1', 'pi_a', 'AUTHORIZED', 'SETTLING', '2026-09-30T23:59:30Z'),
      ('t2', 'pi_a', 'SETTLING', 'SETTLED', '2026-10-01T00:04:00Z'),
      ('t3', 'pi_a', 'SETTLED', 'DISBURSED', '2026-10-01T02:00:00Z'),
      ('t4', 'pi_b', 'SETTLING', 'SETTLED', '2026-10-02T00:01:00Z');
  `);
  const { listSettledAt } = await import('../lib/server/repository/transfers.ts');
  const settled = await listSettledAt(db, 'acme', ['pi_a', 'pi_b'], ['SETTLED', 'DISBURSED', 'CREDITED']);
  assert.equal(settled.get('pi_a')?.toISOString(), '2026-10-01T00:04:00.000Z', 'the first time it reached a settled state');
  assert.equal(settled.has('pi_b'), false, 'another org’s transfer is not read');
  await client.close();
});

test('Home reads this month’s confirmed wallet payments and the newest sent ones, not every quote', async () => {
  const { client, db } = await migratedDb();
  const USDC = '0xdba3::usdc::USDC';
  const ME = '0x' + '11'.repeat(32);
  const PAYEE = '0x' + '22'.repeat(32);
  const HASH = 'ab'.repeat(32);
  await client.exec(`
    INSERT INTO suppliers (id, org_id, name, country, payout_method, wallet_address, wallet_provider)
      VALUES ('sup_1', 'acme', 'Manila Parts Supply', 'PH', 'WALLET', '${PAYEE}', 'SLUSH');
    INSERT INTO stablecoin_outflows (id, org_id, kind, supplier_id, network, coin_type, principal_minor, fee_minor, sender_address,
      recipient_address, status, reserved_until, tx_digest, anchor_status, audit_hash, confirmed_at, created_at)
    VALUES
      ('ok_oct', 'acme', 'TRANSFER', 'sup_1', 'mainnet', '${USDC}', 100000000, 0, '${ME}', '${PAYEE}', 'CONFIRMED',
        '2026-10-10T00:05:00Z', 'D_OCT', 'PENDING_MAINNET_PUBLISH', '${HASH}', '2026-10-10T00:01:00Z', '2026-10-10T00:00:00Z'),
      ('ok_sep', 'acme', 'TRANSFER', NULL, 'mainnet', '${USDC}', 7000000, 0, '${ME}', '${PAYEE}', 'CONFIRMED',
        '2026-09-10T00:05:00Z', 'D_SEP', 'PENDING_MAINNET_PUBLISH', '${HASH}', '2026-09-10T00:01:00Z', '2026-09-10T00:00:00Z'),
      ('quote_old', 'acme', 'TRANSFER', NULL, 'mainnet', '${USDC}', 5000000, 0, '${ME}', '${PAYEE}', 'PENDING',
        '2026-06-01T00:05:00Z', NULL, 'PENDING_MAINNET_PUBLISH', NULL, NULL, '2026-06-01T00:00:00Z'),
      ('quote_live', 'acme', 'TRANSFER', NULL, 'mainnet', '${USDC}', 5000000, 0, '${ME}', '${PAYEE}', 'PENDING',
        '2026-10-25T09:04:00Z', NULL, 'PENDING_MAINNET_PUBLISH', NULL, NULL, '2026-10-25T08:59:00Z'),
      ('other_org', 'northwind', 'TRANSFER', NULL, 'mainnet', '${USDC}', 9000000, 0, '${ME}', '${PAYEE}', 'CONFIRMED',
        '2026-10-11T00:05:00Z', 'D_OTHER', 'PENDING_MAINNET_PUBLISH', '${HASH}', '2026-10-11T00:01:00Z', '2026-10-11T00:00:00Z');
  `);
  const { listHomeOutflows } = await import('../lib/server/usdc-records.ts');
  const rows = await listHomeOutflows(db, 'acme', { since: new Date('2026-10-01T00:00:00Z'), recent: 6 });
  const ids = rows.map((r) => r.id).sort();
  assert.deepEqual(ids, ['ok_oct', 'ok_sep'], 'this org only; quotes never sent are not read');
  const oct = rows.find((r) => r.id === 'ok_oct');
  assert.equal(oct.recipientName, 'Manila Parts Supply');
  assert.equal(oct.txDigest, 'D_OCT');
  assert.equal(typeof oct.principalMinor, 'bigint');
  await client.close();
});

/* ── The route ─────────────────────────────────────────────────────── */

test('GET /api/home reads only the caller’s org, from the session, as the person viewing it', async () => {
  const route = codeOnly(await source('app/api/home/route.ts'));
  assert.match(route, /requireCustomerRequest\(request\)/);
  assert.match(route, /requireSessionAccount\(auth\.session\)/);
  assert.match(route, /resolveAuthorityForSession\(auth\.session\)/);
  assert.match(route, /authority\.orgId !== orgId/, 'Home and /queue must count the same org, as walletRoute checks');
  assert.match(route, /listTransfersFor\(orgId,/);
  assert.match(route, /settledTimesFor\(orgId,/);
  assert.match(route, /listHomeOutflows\([^)]*,\s*orgId,/);
  assert.match(route, /buildHomeSummary\(\{[^}]*orgId[^}]*viewer/);
  assert.doesNotMatch(route, /listUsdcRecords/, 'the export’s joins are not Home’s to pay for');
  assert.doesNotMatch(route, /searchParams\.get\('org/, 'the org never comes from the request');
  assert.match(route, /no-store/);
});

test('GET /api/home is rate limited per person', async () => {
  const route = codeOnly(await source('app/api/home/route.ts'));
  assert.match(route, /enforceRateLimit\(\{\s*rule:\s*RATE_LIMITS\.homeSummaryUser,\s*key:\s*authority\.userId/);
  const { RATE_LIMITS } = await import('../lib/server/rate-limit.ts');
  assert.equal(RATE_LIMITS.homeSummaryUser.bucket, 'home-summary:user');
  assert.ok(RATE_LIMITS.homeSummaryUser.limit >= 30, 'a person refreshing Home is not throttled');
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
    'SampleChip',
    'Sample',
  ]) {
    assert.ok(!page.includes(gone), `Home still renders ${gone}`);
  }
});

test('Home shows the board’s figures from real sources, with loading, empty and retryable error states', async () => {
  const page = codeOnly(await source('app/dashboard/page.tsx'));
  for (const label of ['Splash Wallet', 'Needs approval', 'Sent this month', 'Recent payments']) {
    assert.ok(page.includes(label), `Home is missing ${label}`);
  }
  assert.match(page, /fetch\('\/api\/home'/);
  assert.match(page, /fetch\('\/api\/wallet\/business'/);
  assert.match(page, /\/api\/stablecoin\/wallet/);
  assert.match(page, /No payments yet\./);
  assert.match(page, /Loading payments…/);
  // Each figure card that fails says so to a screen reader and can be retried.
  assert.ok((page.match(/<FigureError /g) ?? []).length >= 2, 'both figure cards use the retryable error');
  const figureError = page.slice(page.indexOf('function FigureError'), page.indexOf('function FigureError') + 800);
  assert.match(figureError, /role="status"/);
  assert.match(figureError, /Try again/);
});

test('Home refetches when the soonest approval lapses, rather than counting it', async () => {
  const page = codeOnly(await source('app/dashboard/page.tsx'));
  assert.match(page, /note\?\.stale/);
  assert.match(page, /loadSummary\(\)/);
  assert.match(page, /ownRequestsNote\(/);
});

test('Home has quick actions to pay, batch, open Wallet and ask Zeke', async () => {
  const page = codeOnly(await source('app/dashboard/page.tsx'));
  for (const href of ['/dashboard/transfer', '/dashboard/batch', '/dashboard/wallet', '/dashboard/zeke', '/queue']) {
    assert.ok(page.includes(`href="${href}"`) || page.includes(`href: '${href}'`), `no quick action to ${href}`);
  }
});

test('the seeded accounts carry no “Demo” in a person’s name or a business address', async () => {
  // D14: no "Demo" text in the UI. Screens that print users.name or the
  // originator address read these seeds. (The header's name is built from
  // the email's local part, lib/auth/customer-session.ts, not from these.)
  for (const script of ['scripts/dev-db.mjs', 'scripts/seed-demo-user.mjs']) {
    const text = await source(script);
    // assert.ok, not doesNotMatch: a failure must not print the seed file.
    assert.ok(!/'Demo Operator'/.test(text), `${script} seeds a person called Demo`);
    assert.ok(!/Menara Demo/.test(text), `${script} seeds an address with Demo in it`);
  }
});

test('the modeled FX ticker is deleted with Home’s use of it', async () => {
  await assert.rejects(source('components/LiveExchangeTicker.tsx'), /ENOENT/);
});
