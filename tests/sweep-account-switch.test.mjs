import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The sweep switch (SWEEP_ACCOUNT_ENABLED) is honoured before money moves.
 *
 * Phase 2 only: with no custody package every sweep is refused by the custody
 * gate first (tests/phase0-custody-gate.test.mjs). With custody on and the
 * switch off, nothing checked the switch until the delivery executor, which
 * runs after the payer is debited and the payment settles, and even there
 * only after crediting the recipient's stored balance. So a sweep transfer
 * failed with the money already moved and a credit left behind, and the
 * invoice loop kept recommending SWEEP_ACCOUNT for PHP.
 *
 * Red before green: on the tree before the fix `sweepAccountEnabled` does not
 * exist, the authorize and recipients routes never read the switch, and the
 * executor credits a SWEEP_ACCOUNT intent before it throws.
 */

// Phase 2 for this whole file. The contract config is cached on first read,
// so the package has to be in place before anything imports the gate.
process.env.SPLASH_CUSTODY_PACKAGE_ID = '0x' + 'cd'.repeat(32);
// The PDAX adapter is chosen when lib/server/pdax.ts loads: force the mock, so
// a PDAX_API_KEY in the shell can never send this file's sweeps to the partner.
process.env.USE_MOCK_APIS = 'true';

const phase = () => import('../lib/server/custody-phase.ts');
const operationsModule = () => import('../lib/server/operations.ts');
const transfersStore = () => import('../lib/server/transfers-store.ts');
const sweep = () => import('../lib/server/sweep.ts');

const CUSTODY_ON = { custodyPackageId: process.env.SPLASH_CUSTODY_PACKAGE_ID };
const CUSTODY_OFF = { custodyPackageId: '' };

async function source(relative) {
  return (await readFile(new URL(`../${relative}`, import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** Run `fn` with the switch set to `value` (undefined = unset), then restore it. */
async function withSweepSwitch(value, fn) {
  const previous = process.env.SWEEP_ACCOUNT_ENABLED;
  if (value === undefined) delete process.env.SWEEP_ACCOUNT_ENABLED;
  else process.env.SWEEP_ACCOUNT_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.SWEEP_ACCOUNT_ENABLED;
    else process.env.SWEEP_ACCOUNT_ENABLED = previous;
  }
}

test('this file runs in Phase 2', async () => {
  const { custodyPhaseEnabled } = await phase();
  assert.equal(custodyPhaseEnabled(), true);
});

test('the switch reads the way the executor always read it: on unless set to "false"', async () => {
  const { sweepAccountEnabled } = await phase();
  assert.equal(await withSweepSwitch(undefined, () => sweepAccountEnabled()), true, 'unset is on (lib/env.ts default)');
  assert.equal(await withSweepSwitch('true', () => sweepAccountEnabled()), true);
  assert.equal(await withSweepSwitch('false', () => sweepAccountEnabled()), false);
});

test('a PHP invoice is recommended SWEEP_ACCOUNT only with custody on AND the switch on', async () => {
  const { invoiceDeliveryTier, deliveryTierAllowed } = await phase();

  assert.equal(invoiceDeliveryTier('PHP', CUSTODY_ON, true), 'SWEEP_ACCOUNT');
  assert.equal(invoiceDeliveryTier('PHP', CUSTODY_ON, false), 'PAYOUT_ONLY', 'the switch is off: no sweep recommended');
  assert.equal(invoiceDeliveryTier('PHP', CUSTODY_OFF, true), 'PAYOUT_ONLY', 'custody still decides first');
  assert.equal(invoiceDeliveryTier('USD', CUSTODY_ON, true), 'PAYOUT_ONLY');

  // The default reads the switch, so the invoice loop and the transfer prefill
  // follow it without passing anything.
  assert.equal(await withSweepSwitch('false', () => invoiceDeliveryTier('PHP', CUSTODY_ON)), 'PAYOUT_ONLY');
  assert.equal(await withSweepSwitch(undefined, () => invoiceDeliveryTier('PHP', CUSTODY_ON)), 'SWEEP_ACCOUNT');

  // Every recommendation is a tier the gate accepts under the same switch.
  for (const sweepOn of [true, false]) {
    for (const config of [CUSTODY_ON, CUSTODY_OFF]) {
      const tier = invoiceDeliveryTier('PHP', config, sweepOn);
      assert.equal(deliveryTierAllowed(tier, config) && (tier !== 'SWEEP_ACCOUNT' || sweepOn), true, `${tier} sweepOn=${sweepOn}`);
    }
  }
});

test('the refusal names the switch, not the licence, and is true with custody on', async () => {
  const { sweepAccountDisabledResponse, SWEEP_ACCOUNT_DISABLED_REASON, SWEEP_ACCOUNT_DISABLED_CODE, CUSTODY_PHASE_REASON } = await phase();

  const response = sweepAccountDisabledResponse();
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body, { error: SWEEP_ACCOUNT_DISABLED_REASON, code: SWEEP_ACCOUNT_DISABLED_CODE });
  assert.equal(SWEEP_ACCOUNT_DISABLED_CODE, 'sweep_account_disabled');

  assert.notEqual(SWEEP_ACCOUNT_DISABLED_REASON, CUSTODY_PHASE_REASON);
  assert.match(SWEEP_ACCOUNT_DISABLED_REASON, /switched off/);
  assert.match(SWEEP_ACCOUNT_DISABLED_REASON, /PAYOUT_ONLY/, 'it says what to choose instead');
  assert.doesNotMatch(SWEEP_ACCOUNT_DISABLED_REASON, /this payout/, 'also shown when saving a recipient, where there is no payout');
  // With custody on these would be false, so the switch's refusal claims none of them.
  assert.doesNotMatch(SWEEP_ACCOUNT_DISABLED_REASON, /licen[cs]e|Phase 0|Phase 2|does not hold/i);
  assert.doesNotMatch(SWEEP_ACCOUNT_DISABLED_REASON, /\blicensed\b/i);
});

test('the executor backstop says what did not happen, and does not invite a second payment', async () => {
  const { SWEEP_ACCOUNT_DISABLED_AT_DELIVERY, SWEEP_ACCOUNT_DISABLED_REASON } = await phase();
  assert.notEqual(SWEEP_ACCOUNT_DISABLED_AT_DELIVERY, SWEEP_ACCOUNT_DISABLED_REASON);
  assert.match(SWEEP_ACCOUNT_DISABLED_AT_DELIVERY, /was not delivered/);
  assert.match(SWEEP_ACCOUNT_DISABLED_AT_DELIVERY, /nothing was credited or paid out/);
  // By the executor the customer may already have paid: never "pick again".
  assert.doesNotMatch(SWEEP_ACCOUNT_DISABLED_AT_DELIVERY, /\bchoose\b|PAYOUT_ONLY/i);
  // It does not know what its caller did, so it claims nothing about it.
  assert.doesNotMatch(SWEEP_ACCOUNT_DISABLED_AT_DELIVERY, /settled|debited/i);
  assert.doesNotMatch(SWEEP_ACCOUNT_DISABLED_AT_DELIVERY, /licen[cs]e|Phase 0|Phase 2/i);
});

test('the authorize route refuses a sweep with the switch off before a recipient, intent, debit or settlement', async () => {
  const route = await source('app/api/transfers/authorize/route.ts');
  const custody = route.indexOf('if (!deliveryTierAllowed(body.deliveryTier)) return custodyPhaseResponse();');
  const check = route.indexOf("if (body.deliveryTier === 'SWEEP_ACCOUNT' && !sweepAccountEnabled()) return sweepAccountDisabledResponse();");
  assert.ok(custody > 0, 'the custody gate is still there');
  assert.ok(check > custody, 'the switch is checked after the custody gate, so Phase 0 still answers with the licence');
  for (const write of ['persistRecipient(', 'createTransferIntent(', 'recordMovement(', 'executeComposedPayment(', 'completeDeliveryForTransfer(']) {
    const at = route.indexOf(write);
    assert.ok(at > 0, `${write} exists`);
    assert.ok(check < at, `the switch is checked before ${write}`);
  }
});

test('a sweep recipient cannot be saved with the switch off either', async () => {
  const route = await source('app/api/recipients/route.ts');
  const custody = route.indexOf('if (!deliveryTierAllowed(tier)) return custodyPhaseResponse();');
  const check = route.indexOf("if (tier === 'SWEEP_ACCOUNT' && !sweepAccountEnabled()) return sweepAccountDisabledResponse();");
  assert.ok(custody > 0);
  assert.ok(check > custody);
  assert.ok(check < route.indexOf("if (body.payoutMethod === 'WALLET')"), 'before the bank/wallet split');
  assert.ok(check < route.indexOf('persistRecipient('), 'before anything is saved');
});

test('the executor reads the switch through the shared helper, before any ledger line', async () => {
  const executor = await source('lib/server/sweep.ts');
  assert.doesNotMatch(executor, /process\.env\.SWEEP_ACCOUNT_ENABLED/, 'one reading of the switch: sweepAccountEnabled()');
  const custody = executor.indexOf('if (!deliveryTierAllowed(intent.deliveryTier)) throw');
  const check = executor.indexOf("if (intent.deliveryTier === 'SWEEP_ACCOUNT' && !sweepAccountEnabled()) throw new Error(SWEEP_ACCOUNT_DISABLED_AT_DELIVERY);");
  assert.ok(custody > 0 && check > custody, 'after the custody check, so Phase 0 still fails with the licence reason');
  assert.ok(check < executor.indexOf('recordMovement('), 'before the stored-balance credit');
  assert.ok(check < executor.indexOf('createSweepJob('), 'before a sweep job exists');
});

test('with the switch off the executor refuses a sweep without crediting anything; other tiers are untouched', async () => {
  const { createTransferIntent, operations } = await operationsModule();
  const { persistTransfer, readTransferForStaff } = await transfersStore();
  const { completeDeliveryForTransfer } = await sweep();
  const { SWEEP_ACCOUNT_DISABLED_AT_DELIVERY } = await phase();
  const prevDb = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL; // the in-process stores, which this reads back
  try {
    const intentWith = async (deliveryTier) => persistTransfer(createTransferIntent({
      orgId: 'org-sweep-switch',
      recipientName: 'Acme PH',
      targetCurrency: 'PHP',
      targetAmount: '5642.00',
      stablecoinAmountMicro: 100_000_000,
      deliveryTier,
    }));
    const linesFor = (id) => [...operations.ledgerEntries.values()].filter((entry) => entry.refId === id);

    await withSweepSwitch('false', async () => {
      const refused = await intentWith('SWEEP_ACCOUNT');
      const sweepsBefore = operations.sweepJobs.size;
      // Any refusal first: the old executor also threw, but only after it
      // had written the credit, and the ledger check is what tells them apart.
      let thrown = null;
      await assert.rejects(async () => {
        try {
          await completeDeliveryForTransfer(refused.id);
        } catch (error) {
          thrown = error;
          throw error;
        }
      });
      assert.equal(linesFor(refused.id).length, 0, 'no stored-balance credit is left behind');
      assert.equal(operations.sweepJobs.size, sweepsBefore, 'no sweep job');
      assert.ok(!['CREDITED', 'SWEEPING', 'DISBURSED'].includes((await readTransferForStaff(refused.id)).state));
      assert.equal(thrown.message, SWEEP_ACCOUNT_DISABLED_AT_DELIVERY, 'the failure reason says what happened');

      // The switch is about sweeps only.
      const stored = await intentWith('STORED_BALANCE');
      assert.deepEqual(await completeDeliveryForTransfer(stored.id), { state: 'CREDITED' });
      const payout = await intentWith('PAYOUT_ONLY');
      assert.deepEqual(await completeDeliveryForTransfer(payout.id), { state: 'DISBURSED' });
    });

    // Switched back on, the same kind of intent sweeps (mock PDAX without a key).
    await withSweepSwitch(undefined, async () => {
      const swept = await intentWith('SWEEP_ACCOUNT');
      const result = await completeDeliveryForTransfer(swept.id);
      assert.equal(result.state, 'DISBURSED');
      assert.equal(linesFor(swept.id).length, 1, 'the credit is written once the sweep may run');
    });
  } finally {
    if (prevDb !== undefined) process.env.DATABASE_URL = prevDb;
  }
});
