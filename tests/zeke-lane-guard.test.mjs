import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertZekeLane,
  classifyLaneIntent,
  formatUsdcAllowance,
  laneRefusalText,
  ZekeLaneRefusal,
  zekeLaneState,
} from '../lib/agent/zeke-lane-guard.ts';
import {
  executeOxwalTool,
  resetOxwalFixtures,
  resetOxwalProposalStore,
  runOxwalAgent,
} from '../lib/agent/oxwal.ts';
import { buildRecipient } from '../lib/server/operations.ts';
import { persistRecipient, recordRecipientScreening } from '../lib/server/recipients-store.ts';
import { findSavedRecipient, listSavedRecipients } from '../lib/agent/recipient-tools.ts';

/**
 * Zeke and an unverified business: it may send USDC on Sui to saved wallet
 * recipients; it may not pay out in a local currency, convert USD into one,
 * bring USD in, or use Treasury — and Zeke says so, from the message AND from
 * the invoice it reads.
 */

async function withGate(on, fn) {
  const prevGate = process.env.FEATURE_KYB_GATE;
  const prevDb = process.env.DATABASE_URL;
  process.env.FEATURE_KYB_GATE = on ? 'true' : 'false';
  // No database: with the gate on, an org that cannot be read is REGISTERED.
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
  const events = [];
  for await (const event of runOxwalAgent({ forceLocal: true, ...request })) events.push(event);
  return events;
}

const text = (events) => events.filter((e) => e.type === 'delta').map((e) => e.text).join('');

// ─── Reading the message ────────────────────────────────────────────────────

test('a request to pay out in a local currency is recognised, by code, name or symbol', () => {
  assert.deepEqual(classifyLaneIntent('Pay Maria 50,000 PHP'), { lane: 'FIAT_OUT_LOCAL', currency: 'PHP' });
  assert.deepEqual(classifyLaneIntent('send 20k pesos to Mabuhay'), { lane: 'FIAT_OUT_LOCAL', currency: 'pesos' });
  assert.deepEqual(classifyLaneIntent('Make a payment of ₱25,000 to Acme'), { lane: 'FIAT_OUT_LOCAL', currency: 'PHP' });
  assert.deepEqual(classifyLaneIntent('convert 1000 USD to MYR'), { lane: 'FIAT_OUT_LOCAL', currency: 'MYR' });
  assert.deepEqual(classifyLaneIntent('pay them in local currency'), { lane: 'FIAT_OUT_LOCAL', currency: null });
  assert.deepEqual(classifyLaneIntent('send $500 to their bank account'), { lane: 'FIAT_OUT_LOCAL', currency: null });
});

test('questions, USDC wallet sends and x402 challenges are not refused', () => {
  assert.equal(classifyLaneIntent("what's the USD/PHP rate today?"), null);
  assert.equal(classifyLaneIntent('how much would 1000 USD convert to in PHP?'), null);
  assert.equal(classifyLaneIntent('send 500 USDC to Maria’s Slush wallet'), null);
  assert.equal(classifyLaneIntent('send 500 to Maria'), null, 'no currency and no bank: the tools decide');
  assert.equal(classifyLaneIntent("what's the treasury yield?"), null);
  assert.equal(
    classifyLaneIntent('{"x402Version":2,"accepts":[{"description":"EUR FX feed","amount":"1000"}]} pay this'),
    null,
    'an x402 challenge is the x402 lane, open to onboarding businesses',
  );
});

test('USD in and Treasury requests are recognised', () => {
  assert.deepEqual(classifyLaneIntent('deposit 10,000 USD by bank wire'), { lane: 'FIAT_IN_USD', currency: 'USD' });
  assert.equal(classifyLaneIntent('fund the account with USDC from Arbitrum'), null, 'USDC funding is not USD in');
  assert.deepEqual(classifyLaneIntent('move idle cash into the treasury vault'), { lane: 'TREASURY', currency: null });
});

// ─── The words ──────────────────────────────────────────────────────────────

test('the refusal says what is locked, what is open, and how to unlock it', () => {
  const t = laneRefusalText('FIAT_OUT_LOCAL', 'REGISTERED', 'PHP');
  assert.match(t, /isn't verified/);
  assert.match(t, /PHP/);
  assert.match(t, /USDC on Sui/);
  assert.match(t, /5,000 USDC in any 30 days/);
  assert.match(t, /x402 payments counting toward the same limit/);
  assert.match(t, /Finish verification/);

  assert.equal(laneRefusalText('FIAT_OUT_LOCAL', 'ACTIVE', 'PHP'), '', 'a verified business is not refused');
  assert.match(laneRefusalText('STABLECOIN_WALLET', 'SUSPENDED'), /suspended/);
  assert.match(laneRefusalText('TREASURY', 'KYB_SUBMITTED'), /verified businesses/);
  assert.match(laneRefusalText('FIAT_IN_USD', 'REGISTERED'), /CCTP/);
});

test('the remaining allowance is shown rounded down, never overstated', () => {
  assert.equal(formatUsdcAllowance(4_999_995_000n), '4,999.99');
  assert.equal(formatUsdcAllowance(5_000_000_000n), '5,000.00');
  assert.equal(formatUsdcAllowance(9_999n), '0.00');
  assert.equal(formatUsdcAllowance(0n), '0.00');
});

// ─── The state Zeke acts on ─────────────────────────────────────────────────

test('Zeke follows the money gate: off locks nothing, on reads the org (and fails closed)', async () => {
  await withGate(false, async () => {
    assert.equal(await zekeLaneState('any-org'), 'ACTIVE');
    await assertZekeLane('any-org', 'FIAT_OUT_LOCAL', 'PHP');
  });
  await withGate(true, async () => {
    assert.equal(await zekeLaneState('any-org'), 'REGISTERED');
    await assert.rejects(() => assertZekeLane('any-org', 'FIAT_OUT_LOCAL', 'PHP'), ZekeLaneRefusal);
    await assertZekeLane('any-org', 'STABLECOIN_WALLET');
    await assertZekeLane('any-org', 'X402');
  });
});

// ─── The conversation ───────────────────────────────────────────────────────

test('an unverified business asking to pay in PHP is refused before any tool runs', async () => {
  resetOxwalFixtures();
  resetOxwalProposalStore();
  const events = await run({ message: 'Pay cp_acme_ph 5000 PHP', orgId: 'org-unverified', kybState: 'REGISTERED' });
  assert.ok(events.some((e) => e.type === 'warning' && e.warning.code === 'LANE_LOCKED'));
  assert.equal(events.filter((e) => e.type === 'proposal').length, 0);
  assert.equal(events.filter((e) => e.type === 'tool').length, 0, 'refused from the message itself');
  assert.match(text(events), /isn't verified/);
  assert.deepEqual(events.at(-1), { type: 'done', source: 'scripted' });
});

test('the same request from a verified business still drafts a proposal', async () => {
  resetOxwalFixtures();
  resetOxwalProposalStore();
  const events = await run({ message: 'Pay cp_acme_ph 5000 PHP', orgId: 'org-verified', kybState: 'ACTIVE' });
  assert.equal(events.filter((e) => e.type === 'proposal').length, 1);
  assert.equal(events.some((e) => e.type === 'warning' && e.warning.code === 'LANE_LOCKED'), false);
});

test('the invoice loop: Zeke reads a PHP invoice the operator never described, and refuses it', async () => {
  resetOxwalFixtures();
  resetOxwalProposalStore();
  await withGate(true, async () => {
    // No currency in the message. The invoice says PHP; the tool reads it.
    const events = await run({ message: 'pay invoice inv_demo_acme_5000 to cp_acme_ph', orgId: 'org-unverified' });
    assert.ok(events.some((e) => e.type === 'tool' && e.name === 'getInvoice'), 'the invoice was read');
    assert.ok(events.some((e) => e.type === 'warning' && e.warning.code === 'LANE_LOCKED'));
    assert.equal(events.filter((e) => e.type === 'proposal').length, 0);
    assert.match(text(events), /paying out in PHP/);
  });
});

test('every fiat and treasury propose tool refuses an unverified business directly', async () => {
  resetOxwalFixtures();
  resetOxwalProposalStore();
  await withGate(true, async () => {
    const orgId = 'org-unverified';
    await assert.rejects(
      () => executeOxwalTool('proposePayment', { orgId, counterpartyId: 'cp_acme_ph', amountUsd: 100, currency: 'PHP' }),
      /isn't verified/,
    );
    await assert.rejects(() => executeOxwalTool('proposeFxConvert', { orgId, amountUsd: 100, currencyOut: 'MYR' }), /isn't verified/);
    await assert.rejects(
      () => executeOxwalTool('proposeTreasuryAllocation', { orgId, amountUsd: 100, corridor: 'MY_PH' }),
      /verified businesses/,
    );
    await assert.rejects(() => executeOxwalTool('proposeTreasuryRedeem', { orgId, amountUsd: 100 }), /verified businesses/);
    await assert.rejects(
      () => executeOxwalTool('proposeBatchPayout', {
        orgId,
        corridor: 'MY_PH',
        payouts: [{ counterpartyId: 'cp_acme_ph', amountUsd: 500, currency: 'PHP' }],
      }),
      /isn't verified/,
    );
  });
});

// ─── What Zeke can read about recipients ────────────────────────────────────

test('Zeke sees saved wallet recipients as payable by wallet, and bank recipients as locked', async () => {
  await withGate(true, async () => {
    const orgId = `org-recip-${Date.now()}`;
    const wallet = await persistRecipient(buildRecipient({
      orgId,
      name: 'Maria Santos Trading',
      country: 'PH',
      payoutMethod: 'WALLET',
      walletAddress: `0x${'ab'.repeat(32)}`,
      walletProvider: 'SLUSH',
    }));
    await recordRecipientScreening(orgId, wallet.id, { verdict: 'CLEAR', reference: 'test', screenedAt: new Date() });
    await persistRecipient(buildRecipient({ orgId, name: 'Mabuhay Bank Payee', country: 'PH', account: '1234567890' }));

    const { recipients } = await listSavedRecipients({ orgId });
    const w = recipients.find((r) => r.name === 'Maria Santos Trading');
    const bank = recipients.find((r) => r.name === 'Mabuhay Bank Payee');

    assert.equal(w.payoutMethod, 'WALLET');
    assert.equal(w.payable, true);
    assert.match(w.wallet, /^0xababab…ababab$/, 'shortened: enough to confirm, not to copy');
    assert.match(w.howToPay, /signs it in its own wallet/);

    assert.equal(bank.payoutMethod, 'BANK');
    assert.equal(bank.payable, false);
    assert.match(bank.blockedBecause, /unlock when your business is verified/);

    const found = await findSavedRecipient({ orgId, name: 'Maria' });
    assert.equal(found.status, 'FOUND');
    assert.equal(found.match.payoutMethod, 'WALLET');
  });
});
