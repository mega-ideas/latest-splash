import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * WS6 — Phase-0 custody gates.
 *
 * Phase 0 pays out. Holding customer funds — a STORED_BALANCE or SWEEP_ACCOUNT
 * delivery, and the treasury — is Phase 2, and needs a money-broking licence
 * Splash does not hold. Until the custody package is configured, every one of
 * those must refuse with a plain, licence-named error, and nothing on the
 * treasury surfaces may show demo balances or transactions as if they were
 * confirmed.
 *
 * Red before green: on the tree before the fix the gate module does not
 * exist, the transfer route accepts `deliveryTier: 'STORED_BALANCE'` with no
 * custody configured, `/api/treasury` serves a seeded demo ledger, and the
 * treasury page renders $24,500 and six "confirmed" transactions from a
 * constant before its first fetch returns.
 */

const gate = () => import('../lib/server/custody-phase.ts');

const CUSTODY_PACKAGE = '0x' + 'cd'.repeat(32);

async function source(relative) {
  const raw = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/* ── The gate ──────────────────────────────────────────────────────────── */

test('the custody phase is decided by the custody package alone, and PAYOUT_ONLY is the only Phase-0 tier', async () => {
  const { custodyPhaseEnabled, deliveryTierAllowed, PHASE0_DELIVERY_TIERS } = await gate();

  assert.equal(custodyPhaseEnabled({ custodyPackageId: '' }), false);
  assert.equal(custodyPhaseEnabled({ custodyPackageId: '   ' }), false);
  assert.equal(custodyPhaseEnabled({}), false);
  assert.equal(custodyPhaseEnabled({ custodyPackageId: CUSTODY_PACKAGE }), true);

  assert.deepEqual([...PHASE0_DELIVERY_TIERS], ['PAYOUT_ONLY']);
  for (const tier of ['STORED_BALANCE', 'SWEEP_ACCOUNT']) {
    assert.equal(deliveryTierAllowed(tier, { custodyPackageId: '' }), false, `${tier} holds funds`);
    assert.equal(deliveryTierAllowed(tier, { custodyPackageId: CUSTODY_PACKAGE }), true);
  }
  assert.equal(deliveryTierAllowed('PAYOUT_ONLY', { custodyPackageId: '' }), true);
  assert.equal(deliveryTierAllowed('anything-else', { custodyPackageId: CUSTODY_PACKAGE }), false, 'an unknown tier is never allowed');
});

test('the refusal names the licence, the phase, and the tier that is allowed — and never claims a licence', async () => {
  const { custodyPhaseResponse, CUSTODY_PHASE_REASON, CUSTODY_PHASE_CODE } = await gate();

  const response = custodyPhaseResponse();
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.equal(body.code, CUSTODY_PHASE_CODE);
  assert.equal(body.error, CUSTODY_PHASE_REASON);
  assert.deepEqual(body.allowedDeliveryTiers, ['PAYOUT_ONLY']);

  assert.match(CUSTODY_PHASE_REASON, /money-broking licence/i, 'the licence is named');
  assert.match(CUSTODY_PHASE_REASON, /Phase 2/, 'the phase is named');
  assert.match(CUSTODY_PHASE_REASON, /does not hold/i, 'and it is stated plainly that Splash does not hold it');
  assert.doesNotMatch(CUSTODY_PHASE_REASON, /\blicensed\b/i, 'claims discipline: never "licensed" about Splash');
});

/* ── Delivery tiers ────────────────────────────────────────────────────── */

test('the transfer route refuses STORED_BALANCE and SWEEP_ACCOUNT before it writes anything', async () => {
  const route = await source('app/api/transfers/authorize/route.ts');
  const check = route.indexOf('deliveryTierAllowed(');
  assert.ok(check > 0, 'the route must consult the custody phase');
  assert.ok(check < route.indexOf('createRecipient('), 'the tier is checked before the recipient is created');
  assert.ok(check < route.indexOf('createTransferIntent('), 'and before the intent exists');
  assert.match(route, /custodyPhaseResponse\(\)/);
  // The schema still defaults to the one Phase-0 tier.
  assert.match(route, /deliveryTier: z\.enum\(\['PAYOUT_ONLY', 'SWEEP_ACCOUNT', 'STORED_BALANCE'\]\)\.default\('PAYOUT_ONLY'\)/);
});

test('a recipient cannot be created with a fund-holding tier in Phase 0 either', async () => {
  const route = await source('app/api/recipients/route.ts');
  assert.ok(route.indexOf('deliveryTierAllowed(') < route.indexOf('createRecipient('));
  assert.match(route, /custodyPhaseResponse\(\)/);
});

/* ── The treasury ──────────────────────────────────────────────────────── */

test('/api/treasury and both treasury crons answer the licence-named error before touching the ledger', async () => {
  const api = await source('app/api/treasury/route.ts');
  for (const handler of ['GET', 'POST']) {
    const start = api.indexOf(`export async function ${handler}(`);
    assert.ok(start >= 0, `${handler} exists`);
    const body = api.slice(start, api.indexOf('export async function', start + 1) > 0 ? api.indexOf('export async function', start + 1) : undefined);
    assert.match(body, /custodyPhaseEnabled\(\)/, `${handler} consults the phase`);
    assert.ok(body.indexOf('custodyPhaseEnabled(') < body.indexOf('snapshot(') || body.indexOf('snapshot(') < 0, `${handler} gates before reading the ledger`);
    assert.ok(body.indexOf('custodyPhaseEnabled(') < body.indexOf('getLedger(') || body.indexOf('getLedger(') < 0);
  }
  assert.match(api, /custodyPhaseResponse\(\)/);

  for (const cron of ['app/api/cron/accrue-yield/route.ts', 'app/api/cron/settle-withdrawals/route.ts']) {
    const text = await source(cron);
    const check = text.indexOf('custodyPhaseEnabled(');
    assert.ok(check > 0, `${cron} consults the phase`);
    const work = Math.min(...['accrueDailyYield(', 'settleDueWithdrawals('].map((f) => text.indexOf(f)).filter((i) => i >= 0));
    assert.ok(check < work, `${cron} gates before any accrual or settlement runs`);
    assert.match(text, /custodyPhaseResponse\(\)/);
  }
});

test('the treasury page shows no demo balance or transaction as confirmed, and says when treasury arrives', async () => {
  const page = await source('app/dashboard/treasury/page.tsx');

  assert.doesNotMatch(page, /SEED_HISTORY/, 'the six hardcoded transactions are gone');
  assert.doesNotMatch(page, /useState\(11140/, 'no hardcoded available balance');
  assert.doesNotMatch(page, /useState\(24500/, 'no hardcoded treasury balance');
  assert.doesNotMatch(page, /useState\(98\.72/, 'no hardcoded accrued yield');
  assert.doesNotMatch(page, /tx_t00[1-9]/, 'no seeded transaction ids');
  assert.doesNotMatch(page, /'Audited/, 'nothing is described as audited without a source');
  assert.doesNotMatch(page, /earns a floating T-bill rate/, 'no yield promise in the header');

  assert.match(page, /Treasury arrives with our licence/, 'the Phase-0 state is plain about why');
  assert.match(page, /custody_not_licensed/, 'the page recognises the gate response');
  assert.match(page, /<MoneyPathPanel \/>/, 'the money-path panel still mounts (pinned by tests/money-path.test.mjs)');
});

test('the overview card and the copilot stop presenting treasury numbers in Phase 0', async () => {
  const overview = await source('app/dashboard/overview/page.tsx');
  assert.doesNotMatch(overview, /useState\(24500\)/);
  assert.doesNotMatch(overview, /useState\(98\.72\)/);
  assert.doesNotMatch(overview, /\+\$3\.22/, 'no invented daily yield');
  assert.match(overview, /Treasury arrives with our licence/);
  assert.match(overview, /custody_not_licensed/);

  const copilot = await source('app/api/copilot/chat/route.ts');
  const treasuryBranch = copilot.indexOf('TREASURY_KEYWORDS.some(');
  assert.ok(treasuryBranch > 0);
  assert.ok(copilot.indexOf('custodyPhaseEnabled(') > 0, 'the copilot consults the phase');
  assert.match(copilot, /custodyPhaseEnabled\(\)\s*\?[\s\S]{0,400}getLedger\(|if \(!custodyPhaseEnabled\(\)\)[\s\S]{0,600}getLedger\(/, 'the ledger is read only when the treasury exists');
});
