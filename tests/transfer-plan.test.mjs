import assert from 'node:assert/strict';
import test from 'node:test';

import { FEE_KIND } from '../lib/fees/schedule.ts';
import {
  BANK_COUNTRIES,
  corridorAccess,
  feeKindOf,
  payeeFieldFor,
  requirementsFor,
} from '../lib/transfer/payee.ts';
import {
  approvalPlan,
  DEFAULT_SECOND_APPROVAL_MINOR,
  fundsCheck,
  maxFeeToSend,
  parseAmountMinor,
} from '../lib/transfer/plan.ts';
import { newIntentKey, parseDraft, serializeDraft, draftStorageKey, DRAFT_MAX_AGE_MS } from '../lib/transfer/draft.ts';

/**
 * v2 Phase 3, brief 5.4: who is paid (step 1), what each kind needs (step 2),
 * the amount and where it is paid from (step 3), who has to approve it
 * (step 4), and the draft kept while funds arrive.
 */

const USDC = (n) => BigInt(Math.round(n * 1_000_000));

// ─── Step 1: who you are paying ─────────────────────────────────────────────

test('a business bank account is live in PH and ID, and the others are under Pilot access', () => {
  assert.equal(corridorAccess('PH'), 'live');
  assert.equal(corridorAccess('ID'), 'live');
  for (const c of ['MY', 'VN', 'TH', 'SG']) assert.equal(corridorAccess(c), 'pilot', c);
  assert.equal(corridorAccess('FR'), 'unsupported');
  assert.equal(corridorAccess('ph'), 'live', 'case is not a reason to refuse');
  const live = BANK_COUNTRIES.filter((c) => c.access === 'live').map((c) => c.country);
  assert.deepEqual(live.sort(), ['ID', 'PH']);
  const pilot = BANK_COUNTRIES.filter((c) => c.access === 'pilot').map((c) => c.country);
  assert.deepEqual(pilot.sort(), ['MY', 'SG', 'TH', 'VN']);
});

test('each kind of payee is priced as the kind the chain derives, never typed in', () => {
  assert.equal(feeKindOf({ kind: 'bank' }), FEE_KIND.BANK_PAYOUT);
  assert.equal(feeKindOf({ kind: 'splash_business' }), FEE_KIND.SPLASH_BUSINESS);
  assert.equal(feeKindOf({ kind: 'wallet', wallet: 'self_custody' }), FEE_KIND.WALLET);
  assert.equal(feeKindOf({ kind: 'wallet', wallet: 'exchange' }), FEE_KIND.EXCHANGE);
  assert.equal(feeKindOf({ kind: 'wallet', wallet: 'cross_chain' }), FEE_KIND.CROSS_CHAIN);
  assert.throws(() => feeKindOf({ kind: 'wallet' }));
  assert.throws(() => feeKindOf({ kind: 'nonsense' }));
});

test('the field a payee needs follows its kind: a bank is never given a Sui address field', () => {
  assert.equal(payeeFieldFor({ kind: 'bank' }), 'account_number');
  assert.equal(payeeFieldFor({ kind: 'splash_business' }), 'registered_name');
  assert.equal(payeeFieldFor({ kind: 'wallet', wallet: 'self_custody' }), 'sui_address');
  assert.equal(payeeFieldFor({ kind: 'wallet', wallet: 'exchange' }), 'sui_address');
  assert.equal(payeeFieldFor({ kind: 'wallet', wallet: 'cross_chain' }), 'chain_address');
});

// ─── Step 2: What's needed for PH / ID ──────────────────────────────────────

test('"What’s needed for PH" is a sheet built from the corridor rule, one list, no duplicated fields', () => {
  for (const country of ['PH', 'ID']) {
    const sheet = requirementsFor(country);
    assert.ok(sheet, country);
    assert.match(sheet.title, new RegExp(`What’s needed for ${country}`));
    const labels = sheet.groups.flatMap((g) => g.items.map((i) => i.label));
    assert.equal(new Set(labels.map((l) => l.toLowerCase())).size, labels.length, 'no item is listed twice');
    // The duplicates the old form asked for.
    assert.ok(!labels.some((l) => /registered legal name/i.test(l)) || !labels.some((l) => /^business name$/i.test(l)), 'business name and registered legal name are one field');
    assert.ok(!(labels.some((l) => /^bank account$/i.test(l)) && labels.some((l) => /^account number$/i.test(l))), 'bank account and account number are one field');
    for (const group of sheet.groups) for (const item of group.items) assert.ok(item.because.length > 10, `${item.label} says why it is asked`);
  }
  const ph = requirementsFor('PH');
  assert.ok(ph.groups.flatMap((g) => g.items).some((i) => /bank/i.test(i.label)));
  assert.ok(ph.groups.flatMap((g) => g.items).some((i) => /purpose/i.test(i.label)), 'PH asks for a purpose of payment');
  const id = requirementsFor('ID');
  assert.match(id.intro, /Indonesia|ID/);
  assert.equal(requirementsFor('FR'), null);
  assert.equal(requirementsFor('MY'), null, 'a Pilot corridor has no sheet: it is not paid');
});

// ─── Step 3: amount and shortfall ───────────────────────────────────────────

test('an amount is read exactly, to six decimals, and anything else is not read', () => {
  assert.equal(parseAmountMinor('5,000'), 5_000_000_000n);
  assert.equal(parseAmountMinor('5000.5'), 5_000_500_000n);
  assert.equal(parseAmountMinor(' 0.000001 '), 1n);
  assert.equal(parseAmountMinor('1e3'), null);
  assert.equal(parseAmountMinor('-5'), null);
  assert.equal(parseAmountMinor('0'), null);
  assert.equal(parseAmountMinor(''), null);
  assert.equal(parseAmountMinor('1.0000001'), null, 'more than six decimals is refused, not rounded');
  assert.equal(parseAmountMinor('99999999999999999999'), null, 'past the largest amount a payment can carry');
  assert.equal(parseAmountMinor('12abc'), null);
});

test('the shortfall is what the wallet lacks for the amount and the fee shown, and nothing when it covers both', () => {
  const short = fundsCheck({ balanceMinor: USDC(48_250), amountMinor: USDC(52_179.25), feeMinor: USDC(365.25) });
  assert.equal(short.enough, false);
  assert.equal(short.needMinor, USDC(52_544.5));
  assert.equal(short.shortByMinor, USDC(4_294.5));
  const exact = fundsCheck({ balanceMinor: USDC(100), amountMinor: USDC(99.75), feeMinor: USDC(0.25) });
  assert.equal(exact.enough, true);
  assert.equal(exact.shortByMinor, 0n);
  const noBalance = fundsCheck({ balanceMinor: null, amountMinor: USDC(10), feeMinor: 0n });
  assert.equal(noBalance.enough, false);
  assert.equal(noBalance.unknown, true, 'a balance that could not be read is not a zero balance');
  assert.equal(noBalance.shortByMinor, null);
});

test('the fee the person was shown goes back as max_fee, exactly, and a missing fee is no payment', () => {
  assert.equal(maxFeeToSend({ feeMinor: 35_000_000n }), '35000000');
  assert.equal(maxFeeToSend({ feeMinor: 0n }), '0');
  assert.equal(maxFeeToSend(null), null);
  assert.equal(maxFeeToSend({ feeMinor: null }), null);
});

// ─── Step 4: who approves ───────────────────────────────────────────────────

const RULE = { status: 'active', perPaymentMaxMinor: USDC(5_000).toString(), spendableNowMinor: USDC(20_000).toString() };
const POLICY = { secondApprovalThresholdMinor: USDC(10_000).toString(), recipients: [] };
const WALLET_PAYEE = { kind: 'wallet', wallet: 'self_custody', address: `0x${'77'.repeat(32)}` };

test('owners sign together: the multisig collects the signatures', () => {
  const plan = approvalPlan({ role: 'OWNER', amountMinor: USDC(50_000), feeMinor: USDC(10), payee: WALLET_PAYEE, rule: null, policy: null });
  assert.equal(plan.route, 'owners_sign');
  assert.equal(plan.needsOwnerApproval, false);
});

test('a viewer cannot pay', () => {
  const plan = approvalPlan({ role: 'VIEWER', amountMinor: USDC(10), feeMinor: 0n, payee: WALLET_PAYEE, rule: null, policy: null });
  assert.equal(plan.route, 'blocked');
  assert.equal(plan.reasons[0], 'viewer');
});

test('staff within their rule, below the threshold, pay under the rule (splash_spend)', () => {
  const plan = approvalPlan({
    role: 'MAKER',
    amountMinor: USDC(1_000),
    feeMinor: USDC(0.25),
    payee: WALLET_PAYEE,
    rule: RULE,
    policy: { ...POLICY, recipients: [{ address: WALLET_PAYEE.address, tag: 'wallet' }] },
    runningTotalMinor: 0n,
  });
  assert.equal(plan.route, 'staff_rule');
  assert.equal(plan.needsOwnerApproval, false);
});

test('staff outside their rule ask the owners, with every reason named', () => {
  const base = { role: 'MAKER', feeMinor: USDC(1), payee: WALLET_PAYEE, rule: RULE, policy: { ...POLICY, recipients: [{ address: WALLET_PAYEE.address, tag: 'wallet' }] }, runningTotalMinor: 0n };
  const reasonsOf = (over) => approvalPlan({ ...base, amountMinor: USDC(1_000), ...over });
  assert.deepEqual(reasonsOf({ rule: null }).reasons, ['no_rule']);
  assert.equal(reasonsOf({ rule: null }).route, 'ask_owners');
  assert.deepEqual(reasonsOf({ rule: { ...RULE, status: 'expired' } }).reasons, ['rule_expired']);
  assert.deepEqual(reasonsOf({ rule: { ...RULE, status: 'no_allowance' } }).reasons, ['rule_revoked']);
  assert.deepEqual(reasonsOf({ amountMinor: USDC(5_000.01) }).reasons, ['over_payment_max']);
  assert.deepEqual(reasonsOf({ rule: { ...RULE, spendableNowMinor: USDC(500).toString() } }).reasons, ['over_cap']);
  assert.deepEqual(reasonsOf({ rule: { ...RULE, spendableNowMinor: '0' } }).reasons, ['cap_used_up']);
  assert.deepEqual(reasonsOf({ policy: { ...POLICY, recipients: [] } }).reasons, ['recipient_not_on_rule']);
  const two = reasonsOf({ amountMinor: USDC(6_000), policy: { ...POLICY, recipients: [] } });
  assert.deepEqual(two.reasons.sort(), ['over_payment_max', 'recipient_not_on_rule']);
  assert.equal(two.route, 'ask_owners');
});

test('above the threshold, counting what was already paid to the same recipient, an owner approves', () => {
  const policy = { secondApprovalThresholdMinor: USDC(10_000).toString(), recipients: [{ address: WALLET_PAYEE.address, tag: 'wallet' }] };
  const rule = { ...RULE, perPaymentMaxMinor: USDC(9_000).toString(), spendableNowMinor: USDC(100_000).toString() };
  const alone = approvalPlan({ role: 'MAKER', amountMinor: USDC(9_000), feeMinor: USDC(1), payee: WALLET_PAYEE, rule, policy, runningTotalMinor: 0n });
  assert.equal(alone.route, 'staff_rule');
  const split = approvalPlan({ role: 'MAKER', amountMinor: USDC(9_000), feeMinor: USDC(1), payee: WALLET_PAYEE, rule, policy, runningTotalMinor: USDC(2_000) });
  assert.equal(split.route, 'ask_owners', 'split payments to one recipient count together');
  assert.deepEqual(split.reasons, ['above_threshold']);
  assert.equal(split.needsOwnerApproval, true);
  assert.equal(split.thresholdMinor, USDC(10_000));
  const exactly = approvalPlan({ role: 'MAKER', amountMinor: USDC(8_000), feeMinor: 0n, payee: WALLET_PAYEE, rule, policy, runningTotalMinor: USDC(2_000) });
  assert.equal(exactly.route, 'staff_rule', 'a running total of exactly the threshold needs no second approval; one unit above does');
  const above = approvalPlan({ role: 'MAKER', amountMinor: USDC(8_000) + 1n, feeMinor: 0n, payee: WALLET_PAYEE, rule, policy, runningTotalMinor: USDC(2_000) });
  assert.equal(above.route, 'ask_owners');
  assert.equal(DEFAULT_SECOND_APPROVAL_MINOR, USDC(10_000), 'the default is 10,000 USDC');
  const noPolicy = approvalPlan({ role: 'MAKER', amountMinor: USDC(10_001), feeMinor: 0n, payee: WALLET_PAYEE, rule: { ...RULE, perPaymentMaxMinor: USDC(20_000).toString(), spendableNowMinor: USDC(50_000).toString() }, policy: null });
  assert.equal(noPolicy.route, 'ask_owners', 'without the policy, nothing is assumed to be within a rule');
});

test('a bank payout and USDC to another chain are the owners’ to pay: staff ask them', () => {
  const bank = approvalPlan({ role: 'MAKER', amountMinor: USDC(100), feeMinor: USDC(1), payee: { kind: 'bank' }, rule: RULE, policy: POLICY });
  assert.equal(bank.route, 'ask_owners');
  assert.deepEqual(bank.reasons, ['owners_pay_this_kind']);
  const chain = approvalPlan({ role: 'APPROVER', amountMinor: USDC(100), feeMinor: USDC(1), payee: { kind: 'wallet', wallet: 'cross_chain' }, rule: RULE, policy: POLICY });
  assert.equal(chain.route, 'ask_owners');
  assert.deepEqual(chain.reasons, ['owners_pay_this_kind']);
  const owner = approvalPlan({ role: 'OWNER', amountMinor: USDC(100), feeMinor: USDC(1), payee: { kind: 'bank' }, rule: null, policy: null });
  assert.equal(owner.route, 'owners_sign');
});

// ─── The draft kept while funds arrive ──────────────────────────────────────

const NOW = new Date('2026-10-31T08:00:00Z');
const DRAFT = {
  v: 1,
  intentKey: newIntentKey(() => new Uint8Array(12).fill(7)),
  payee: { kind: 'bank', beneficiaryId: 'dst_1', name: 'PT Sinar Jaya Abadi', country: 'ID' },
  amountText: '52,179.25',
  purposeCode: 'SUPP',
  sourceOfFunds: 'business_revenue',
  reference: 'INV-0042',
  topUp: { fundingIntentId: 'fi_1', startedAt: NOW.toISOString() },
  savedAt: NOW.toISOString(),
};

test('the intent id is one key made once per draft, in the shape the routes accept', () => {
  assert.match(DRAFT.intentKey, /^[A-Za-z0-9_-]{8,80}$/);
  const a = newIntentKey();
  const b = newIntentKey();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{8,80}$/);
});

test('a draft round-trips, is kept for a week, and holds no account number or address', () => {
  const text = serializeDraft(DRAFT);
  const back = parseDraft(text, NOW);
  assert.deepEqual(back, DRAFT);
  assert.equal(parseDraft(text, new Date(NOW.getTime() + DRAFT_MAX_AGE_MS - 1)) !== null, true);
  assert.equal(parseDraft(text, new Date(NOW.getTime() + DRAFT_MAX_AGE_MS + 1)), null, 'an old draft is dropped');
  // What a draft must never carry: the account is sealed on the server, the draft names it by id.
  const dirty = serializeDraft({ ...DRAFT, payee: { ...DRAFT.payee, accountNumber: '0012345678901234', address: `0x${'ab'.repeat(32)}` }, account: '12345678901' });
  assert.ok(!/0012345678901234|12345678901|abababab/.test(dirty), dirty);
  assert.equal(draftStorageKey('org_1'), 'splash.transfer.draft.org_1');
});

test('a draft that is not one is not read', () => {
  for (const bad of ['', 'null', '[]', '{"v":2}', '{"v":1}', 'not json', JSON.stringify({ ...DRAFT, intentKey: 'x' }), JSON.stringify({ ...DRAFT, amountText: 'a'.repeat(100) }), JSON.stringify({ ...DRAFT, payee: { kind: 'nonsense' } }), JSON.stringify({ ...DRAFT, savedAt: 'yesterday' })]) {
    assert.equal(parseDraft(bad, NOW), null, bad.slice(0, 60));
  }
  assert.equal(parseDraft(null, NOW), null);
  assert.equal(parseDraft(undefined, NOW), null);
});
