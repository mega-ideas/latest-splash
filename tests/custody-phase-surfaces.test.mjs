import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Imported lazily, so each test stands or falls on its own on a tree that
// lacks one of these exports.
const rules = () => import('../lib/custody-phase-rules.ts');
const phase = () => import('../lib/server/custody-phase.ts');
const payLink = () => import('../lib/server/pay-link.ts');
const guard = () => import('../lib/agent/zeke-lane-guard.ts');
const agent = () => import('../lib/agent/oxwal.ts');
const execution = () => import('../lib/server/approval-execution.ts');
const operationsModule = () => import('../lib/server/operations.ts');
const transfersStore = () => import('../lib/server/transfers-store.ts');
const sweep = () => import('../lib/server/sweep.ts');

/**
 * Two fund-holding surfaces the Phase 0 custody gate never reached.
 *
 * The public pay link told an invoice's payer to wire the money into a
 * "Splash Labuan Ltd client account" (account number CLIENT-USD-SETTLEMENT, a
 * placeholder): Splash collecting and holding a third party's funds. And Zeke
 * opened Treasury to any verified business: it drafted allocations and
 * redemptions /api/treasury then refused, and its balance and treasury reads
 * answered with the $11,140 / $24,500 / $98.72 fixtures the treasury page had
 * already stopped showing as a balance. The landing's recipient ladder sold
 * the sweep account as a "Phase 1 launch" into "a Splash account". And the
 * delivery executor (lib/server/sweep.ts) credited a stored balance or opened
 * a sweep for any tier it was handed, trusting its one caller to have gated it.
 *
 * This file pins Phase 0: no custody package. tests/oxwal-authority.test.mjs
 * runs with one, and covers the same tools once Treasury is open.
 *
 * Red before green: on the tree before the fix lib/server/pay-link.ts does not
 * exist, the pay route and page hand every payer the collection account, and
 * a verified business gets a TREASURY_ALLOCATE proposal and fixture balances.
 */

delete process.env.SPLASH_CUSTODY_PACKAGE_ID;

const CUSTODY_PACKAGE = '0x' + 'cd'.repeat(32);
const FIXTURE_AMOUNTS = ['11140000000', '24500000000', '98720000', '24598720000'];

async function source(relative) {
  return (await readFile(new URL(`../${relative}`, import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** FEATURE_KYB_GATE off: every org reads as verified (ACTIVE) to Zeke. */
async function asVerified(fn) {
  const prevGate = process.env.FEATURE_KYB_GATE;
  const prevDb = process.env.DATABASE_URL;
  process.env.FEATURE_KYB_GATE = 'false';
  delete process.env.DATABASE_URL;
  try {
    return await fn();
  } finally {
    if (prevGate === undefined) delete process.env.FEATURE_KYB_GATE;
    else process.env.FEATURE_KYB_GATE = prevGate;
    if (prevDb !== undefined) process.env.DATABASE_URL = prevDb;
  }
}

async function run(request) {
  const { runOxwalAgent } = await agent();
  const events = [];
  for await (const event of runOxwalAgent({ forceLocal: true, ...request })) events.push(event);
  return events;
}

const text = (events) => events.filter((e) => e.type === 'delta').map((e) => e.text).join('');

test('this file runs in Phase 0', async () => {
  const { custodyPhaseEnabled } = await phase();
  assert.equal(custodyPhaseEnabled(), false);
});

/* ── The pay link ──────────────────────────────────────────────────────── */

test('the pay link names a Splash collection account only once custody is on', async () => {
  const { payLinkBankInstructions } = await payLink();
  assert.equal(payLinkBankInstructions({ custodyPackageId: '' }), null);
  assert.equal(payLinkBankInstructions(), null, 'and the live config is Phase 0');
  const phase2 = payLinkBankInstructions({ custodyPackageId: CUSTODY_PACKAGE });
  assert.ok(phase2 && phase2.swift && phase2.account, 'Phase 2 still has the account to show');
});

test('the pay route and page take the gated instructions, and neither holds the account itself', async () => {
  for (const file of ['app/api/pay/[slug]/route.ts', 'app/pay/[slug]/page.tsx']) {
    const text = await source(file);
    assert.match(text, /bankInstructions: payLinkBankInstructions\(\)/, `${file} asks the gate`);
    assert.doesNotMatch(text, /BANK_TRANSFER_INSTRUCTIONS|Splash Labuan|CLIENT-USD-SETTLEMENT|client account/, `${file} carries no account`);
  }
});

test('with no collection account the payer is told to pay the issuer, and why, in the licence words', async () => {
  const { CUSTODY_LICENCE, CUSTODY_PHASE_WHY } = await rules();
  assert.equal(typeof CUSTODY_LICENCE, 'string', 'the licence clause is shared');
  const client = await source('components/pay/PayInvoiceClient.tsx');
  assert.match(client, /bankInstructions: \{[^}]*\} \| null;/, 'the page accepts no account');
  assert.match(client, /invoice\.bankInstructions \?/, 'and renders both cases');
  assert.match(client, /Pay \{invoice\.issuerOrg\} directly/);
  assert.match(client, /\{CUSTODY_LICENCE\}/, 'the licence clause is the shared one');
  assert.match(client, /paymentReference/, 'the matching reference stays');
  assert.doesNotMatch(client, /\blicensed\b/i);
  assert.match(CUSTODY_PHASE_WHY, new RegExp(CUSTODY_LICENCE), 'one licence clause, everywhere');
});

/* ── The landing ───────────────────────────────────────────────────────── */

test('the landing ladder puts both fund-holding rungs in Phase 2, in the licence words', async () => {
  const landing = await source('components/IsometricLanding.tsx');
  const start = landing.indexOf('const recipientLadder');
  assert.ok(start > 0, 'the ladder exists');
  const ladder = landing.slice(start, landing.indexOf('];', start));
  // It sold the sweep account as a "Phase 1 launch" into "a Splash account",
  // and stored balance as merely "Corridor gated".
  assert.doesNotMatch(ladder, /Phase 1 launch|Corridor gated|sweep value into a Splash account/);
  for (const title of ['Sweep account', 'Stored balance']) {
    assert.match(ladder, new RegExp(`title: '${title}',\\s*status: 'Phase 2'`), `${title} is Phase 2`);
  }
  assert.match(ladder, /\$\{CUSTODY_LICENCE\}/, 'the sweep rung names the licence it waits for');
});

/* ── Settings ──────────────────────────────────────────────────────────── */

test('the settings page stops presenting Treasury and the fund-holding rungs as running in Phase 0', async () => {
  const page = await source('app/dashboard/settings/page.tsx');
  assert.match(page, /const custodyOn = useCustodyPhaseOn\(\);/, 'the phase the shell resolved');
  // Nothing reads autoAllocateTreasuryPct, so "applied to treasury allocation" was never true.
  assert.doesNotMatch(page, /treasury allocation, and account security/);
  assert.match(page, /Phase 2 · Smart Treasury holds customer funds, which needs \$\{CUSTODY_LICENCE\}/);
  assert.match(page, /custodyOn \? 'payout\/sweep\/stored' : 'payout today · sweep and stored balance in Phase 2/);
  assert.match(page, /text\(custodyOn\)/, 'the phase-dependent cards are rendered with the phase');
  assert.match(
    page,
    /label="Auto-allocate to treasury"[^\n]*disabled=\{!custodyOn\} note=\{custodyOn \? undefined : TREASURY_PHASE0\}/,
    'the treasury control is not offered in Phase 0',
  );
});

/* ── Zeke and Treasury ─────────────────────────────────────────────────── */

test('a verified business still cannot get a treasury proposal in Phase 0', async () => {
  const { assertZekeLane, TREASURY_CUSTODY_REFUSAL, ZekeLaneRefusal } = await guard();
  const { executeOxwalTool, resetOxwalFixtures, resetOxwalProposalStore } = await agent();
  assert.equal(typeof TREASURY_CUSTODY_REFUSAL, 'string', 'the guard has a custody refusal');
  resetOxwalFixtures();
  resetOxwalProposalStore();
  await asVerified(async () => {
    const orgId = 'org-verified';
    const refused = (error) => error instanceof ZekeLaneRefusal && error.message === TREASURY_CUSTODY_REFUSAL;
    await assert.rejects(() => executeOxwalTool('proposeTreasuryAllocation', { orgId, amountUsd: 100, corridor: 'MY_PH' }), refused);
    await assert.rejects(() => executeOxwalTool('proposeTreasuryRedeem', { orgId, amountUsd: 100 }), refused);
    // Only Treasury: a payout lane stays open for the same business.
    await assert.doesNotReject(() => assertZekeLane(orgId, 'FIAT_OUT_LOCAL', 'PHP'));
  });

  assert.match(TREASURY_CUSTODY_REFUSAL, /money-broking licence/);
  assert.match(TREASURY_CUSTODY_REFUSAL, /does not hold/);
  assert.doesNotMatch(TREASURY_CUSTODY_REFUSAL, /\blicensed\b/i);
});

test('Zeke reads no Splash-held balance or treasury position in Phase 0', async () => {
  const { executeOxwalTool, resetOxwalFixtures } = await agent();
  resetOxwalFixtures();
  await asVerified(async () => {
    const balances = await executeOxwalTool('getBalances', { orgId: 'org-verified' });
    assert.deepEqual(balances.data.balances, []);
    const treasury = await executeOxwalTool('getTreasuryState', { orgId: 'org-verified' });
    assert.equal(treasury.data.open, false);
    assert.equal('treasuryPrincipalMicro' in treasury.data, false);
    for (const result of [balances, treasury]) {
      const json = JSON.stringify(result);
      for (const amount of FIXTURE_AMOUNTS) assert.ok(!json.includes(amount), `no fixture ${amount}`);
      assert.match(json, /money-broking licence/, 'the read says why it is empty');
    }
  });
});

test('asking Zeke to move cash into Treasury is refused with the licence reason, before any proposal', async () => {
  const { resetOxwalFixtures, resetOxwalProposalStore } = await agent();
  resetOxwalFixtures();
  resetOxwalProposalStore();
  await asVerified(async () => {
    // The message check, before any model. Once past it, the scripted planner
    // answered anything mentioning treasury with a $2,500 allocation.
    for (const message of ['move idle cash into the treasury vault', 'allocate idle cash']) {
      const events = await run({ message, orgId: 'org-verified' });
      assert.ok(events.some((e) => e.type === 'warning' && e.warning.code === 'LANE_LOCKED'), message);
      assert.equal(events.filter((e) => e.type === 'proposal').length, 0, message);
      assert.match(text(events), /money-broking licence Splash does not hold yet/, message);
    }
  });
});

test('asking about treasury yield or balances gets the Phase 0 answer, not a Smart Treasury that exists', async () => {
  const { resetOxwalFixtures, resetOxwalProposalStore } = await agent();
  resetOxwalFixtures();
  resetOxwalProposalStore();
  await asVerified(async () => {
    for (const message of ["what's the treasury yield?", 'what is my balance?']) {
      const events = await run({ message, orgId: 'org-verified' });
      const reply = text(events);
      assert.equal(events.filter((e) => e.type === 'proposal').length, 0, message);
      assert.match(reply, /money-broking licence Splash does not hold yet/, message);
      assert.doesNotMatch(reply, /Smart Treasury earns|allocate idle treasury|balances live on/, message);
    }
  });
});

test('an unverified business still hears the verification reason first', async () => {
  const { executeOxwalTool } = await agent();
  const prevGate = process.env.FEATURE_KYB_GATE;
  const prevDb = process.env.DATABASE_URL;
  process.env.FEATURE_KYB_GATE = 'true';
  delete process.env.DATABASE_URL;
  try {
    await assert.rejects(
      () => executeOxwalTool('proposeTreasuryAllocation', { orgId: 'org-unverified', amountUsd: 100, corridor: 'MY_PH' }),
      /verified businesses/,
    );
  } finally {
    if (prevGate === undefined) delete process.env.FEATURE_KYB_GATE;
    else process.env.FEATURE_KYB_GATE = prevGate;
    if (prevDb !== undefined) process.env.DATABASE_URL = prevDb;
  }
});

/* ── The delivery executor ─────────────────────────────────────────────── */

test('the delivery executor refuses a fund-holding tier itself, before any ledger line', async () => {
  const { createTransferIntent, operations } = await operationsModule();
  const { persistTransfer, readTransferForStaff } = await transfersStore();
  const { completeDeliveryForTransfer } = await sweep();
  const { CUSTODY_PHASE_REASON } = await rules();
  const prevDb = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL; // the in-process stores, which this reads back
  try {
    const intentWith = async (deliveryTier) => persistTransfer(createTransferIntent({
      orgId: 'org-executor',
      recipientName: 'Acme PH',
      targetCurrency: 'PHP',
      targetAmount: '5642.00',
      stablecoinAmountMicro: 100_000_000,
      deliveryTier,
    }));
    const linesFor = (id) => [...operations.ledgerEntries.values()].filter((entry) => entry.refId === id);

    // An intent that reached it anyway — an old row, a future caller — with a
    // tier the authorize route would have refused, or one nobody knows.
    for (const tier of ['STORED_BALANCE', 'SWEEP_ACCOUNT', 'NOT_A_TIER']) {
      const intent = await intentWith(tier);
      const sweepsBefore = operations.sweepJobs.size;
      await assert.rejects(() => completeDeliveryForTransfer(intent.id), (error) => error.message === CUSTODY_PHASE_REASON, tier);
      assert.equal(linesFor(intent.id).length, 0, `${tier}: no stored-balance credit`);
      assert.equal(operations.sweepJobs.size, sweepsBefore, `${tier}: no sweep job`);
      assert.notEqual((await readTransferForStaff(intent.id)).state, 'CREDITED', tier);
    }

    // A payout still completes.
    const payout = await intentWith('PAYOUT_ONLY');
    assert.deepEqual(await completeDeliveryForTransfer(payout.id), { state: 'DISBURSED' });
  } finally {
    if (prevDb !== undefined) process.env.DATABASE_URL = prevDb;
  }
});

test('an approved treasury proposal records that nothing settles it in Phase 0', async () => {
  const { executeApprovedProposal } = await execution();
  const { CUSTODY_PHASE_WHY } = await rules();
  for (const kind of ['TREASURY_ALLOCATE', 'TREASURY_REDEEM']) {
    const outcome = await executeApprovedProposal({ kind }, {}, { cookie: '', origin: 'http://localhost' });
    assert.equal(outcome.state, 'SKIPPED');
    assert.match(outcome.detail, /not executed/);
    assert.ok(outcome.detail.includes(CUSTODY_PHASE_WHY), 'with the licence-named reason');
    assert.doesNotMatch(outcome.detail, /own path/, 'not the Phase 2 wording');
  }
});
