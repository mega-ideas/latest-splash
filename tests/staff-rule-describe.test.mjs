/**
 * v2 Phase 3, staff payments inside a rule: the transaction a staff member
 * signs alone, and the reader that refuses everything else.
 *
 * A payment under a rule is one transaction from the staff member's own
 * passkey address: open the intent (splash_spend::create_intent), pay it
 * under their allowance with no second approval (splash_spend::pay_intent),
 * anchor the receipt, delete the finished intent. The signer is shown every
 * command, decoded from the bytes on their own device, so the reader must
 * understand exactly these and nothing near them: no withdrawal from an
 * allowance outside pay_intent, no allowance but the one the server read as
 * this person's, no second approval, no other recipient, amount or fee than
 * the ones the server stored.
 *
 * Offline: the bytes are built and decoded; nothing reaches a network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { ACCOUNT, CHAIN_ID, CONFIG, FEES, REGISTRY, USDC } from './fixtures/wallet-world.mjs';
import { POLICY_REGISTRY, SPEND, spendChainCfg, spendExpect } from './fixtures/spend-world.mjs';
import { staffRulePaymentTx } from '../lib/server/spend-rules-builders.ts';
import { assertPurposeShape } from '../lib/server/wallet-signing.ts';
import { describeWalletTransaction, walletTxDigest, WalletTxRefused } from '../lib/wallet/wallet-tx-describe.ts';
import { reviewOnDevice } from '../lib/wallet/review-on-device.ts';
import { plainActions, signingItems, RENDERED_ACTION_TYPES } from '../lib/wallet-page/actions.ts';
import { approveFacts } from '../lib/approve/facts.ts';

const U = (n) => BigInt(Math.round(n * 1_000_000));
const WALLET = normalizeSuiAddress(`0x${'aa'.repeat(32)}`);
const STAFF = normalizeSuiAddress(`0x${'a1'.repeat(32)}`);
const OTHER_STAFF = normalizeSuiAddress(`0x${'a2'.repeat(32)}`);
const SUPPLIER = normalizeSuiAddress(`0x${'77'.repeat(32)}`);
const SPONSOR = normalizeSuiAddress(`0x${'5a'.repeat(32)}`);
const POLICY = normalizeSuiAddress(`0x${'70'.repeat(32)}`);
const ALLOWANCE = normalizeSuiAddress(`0x${'81'.repeat(32)}`);
const OTHER_ALLOWANCE = normalizeSuiAddress(`0x${'82'.repeat(32)}`);
const NOW = 1_792_000_000_000n;

const gas = { owner: SPONSOR, price: 1000n, budget: 20_000_000n, epoch: 900n, chain: CHAIN_ID, nonce: 7 };
const expectStaff = { ...spendExpect, spend: { policyIds: [POLICY] }, staffPay: { policyId: POLICY, allowanceId: ALLOWANCE, funder: WALLET } };

const payment = (over = {}) => ({
  spender: STAFF,
  account: { objectId: ACCOUNT, initialSharedVersion: 9 },
  policy: { objectId: POLICY, initialSharedVersion: 11 },
  allowance: { objectId: ALLOWANCE, initialSharedVersion: 12 },
  funder: WALLET,
  paymentRef: new Uint8Array(32).fill(1),
  recipient: SUPPLIER,
  amountMinor: U(1_000),
  targetCurrency: 'USDC',
  fxRateUsdLocal: 1_000_000n,
  commitment: new Uint8Array(32).fill(2),
  railCommitment: new Uint8Array(32).fill(3),
  expiresAtMs: NOW + 7n * 86_400_000n,
  maxFeeMinor: U(0.25),
  settleByMs: NOW + 3_600_000n,
  contentHash: new Uint8Array(32).fill(4),
  walrusBlobId: new TextEncoder().encode('blob-1'),
  gas,
  ...over,
});

const build = (over) => staffRulePaymentTx(spendChainCfg, payment(over));
const refusal = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof WalletTxRefused, String(error));
    return error;
  }
  assert.fail('expected the reader to refuse');
};

test('a payment under a rule is five commands from the staff member’s own address, sponsored, and the reader says exactly what each does', async () => {
  const bytes = await build();
  const d = describeWalletTransaction(bytes, expectStaff);
  assert.equal(d.sender, STAFF);
  assert.deepEqual(d.actions.map((a) => a.type), ['open_intent', 'no_second_approval', 'pay_intent', 'anchor_receipt', 'delete_intent']);
  const [open, , pay] = d.actions;
  assert.equal(open.recipient, SUPPLIER);
  assert.equal(open.amountMinor, U(1_000).toString());
  assert.equal(open.kind, 1, 'a rule pays a recipient tagged a wallet: kind WALLET');
  assert.equal(open.beneficiaryRef, '');
  assert.deepEqual(open.underRule, { policy: POLICY });
  assert.equal(pay.maxFeeMinor, U(0.25).toString());
  assert.equal(pay.intentFromCommand, 0);
  assert.equal(pay.intent, null, 'it pays the intent it opened, not one from elsewhere');
  assert.deepEqual(pay.underRule, { allowance: ALLOWANCE, funder: WALLET, policy: POLICY, withdrawalMinor: (U(1_000) + U(0.25)).toString() });
  assert.equal(d.gas.sponsored, true);
  assert.equal(d.gas.fromAddressBalance, true);
  assert.ok(d.validity, 'it carries a ValidDuring window');
});

test('the reader understands none of it without the server’s word for which allowance, policy and funder are this person’s', async () => {
  const bytes = await build();
  for (const [name, expect] of [
    ['no staffPay', { ...spendExpect, spend: { policyIds: [POLICY] } }],
    ['no spend package', { ...expectStaff, spendPackageId: undefined, policyRegistryId: undefined }],
  ]) {
    const e = refusal(() => describeWalletTransaction(bytes, expect));
    assert.ok(['foreign_withdrawal', 'command_not_allowed'].includes(e.code), `${name}: ${e.code}`);
  }
  for (const [name, staffPay] of [
    ['another allowance', { ...expectStaff.staffPay, allowanceId: OTHER_ALLOWANCE }],
    ['another funder', { ...expectStaff.staffPay, funder: normalizeSuiAddress(`0x${'bb'.repeat(32)}`) }],
    ['another policy', { ...expectStaff.staffPay, policyId: normalizeSuiAddress(`0x${'71'.repeat(32)}`) }],
  ]) {
    const e = refusal(() => describeWalletTransaction(bytes, { ...expectStaff, staffPay }));
    assert.ok(['foreign_withdrawal', 'wrong_object'].includes(e.code), `${name}: ${e.code}`);
  }
});

/** A transaction the staff builder would never make: each is a way to turn the rule into something else. */
function manual(fn) {
  const tx = new Transaction();
  fn(tx);
  tx.setSender(STAFF);
  tx.setGasOwner(SPONSOR);
  tx.setGasPrice(1000n);
  tx.setGasBudget(20_000_000n);
  tx.setGasPayment([]);
  tx.setExpiration({ ValidDuring: { minEpoch: '900', maxEpoch: '901', minTimestamp: null, maxTimestamp: null, chain: CHAIN_ID, nonce: 3 } });
  return tx.build();
}
const shared = (tx, id, mutable = true) => tx.sharedObjectRef({ objectId: id, initialSharedVersion: 5, mutable });
const allowanceWithdrawal = (tx, amount) => tx.withdrawal({ amount, type: USDC, from: 'allowance', allowance: ALLOWANCE, funder: WALLET });

test('an allowance withdrawal is only ever the argument of splash_spend::pay_intent: redeeming it, or sending it, is refused', async () => {
  const redeemed = await manual((tx) => {
    const [funds] = tx.moveCall({ target: '0x2::balance::redeem_funds', typeArguments: [USDC], arguments: [allowanceWithdrawal(tx, 1000)] });
    tx.moveCall({ target: '0x2::balance::send_funds', typeArguments: [USDC], arguments: [funds, tx.pure.address(STAFF)] });
  });
  assert.equal(refusal(() => describeWalletTransaction(redeemed, expectStaff)).code, 'foreign_withdrawal');
  const lone = await manual((tx) => {
    tx.moveCall({ target: '0x2::balance::redeem_funds', typeArguments: [USDC], arguments: [allowanceWithdrawal(tx, 1000)] });
  });
  assert.equal(refusal(() => describeWalletTransaction(lone, expectStaff)).code, 'foreign_withdrawal');
});

test('the second approval slot is empty or the transaction is refused: a rule payment never smuggles an approval in', async () => {
  const approval = `${SPEND}::splash_spend::PayoutApproval`;
  const wrongOption = await manual((tx) => {
    tx.moveCall({ target: '0x1::option::none', typeArguments: ['0x2::coin::Coin<0x2::sui::SUI>'], arguments: [] });
  });
  assert.equal(refusal(() => describeWalletTransaction(wrongOption, expectStaff)).code, 'bad_type');
  const unused = await manual((tx) => {
    tx.moveCall({ target: '0x1::option::none', typeArguments: [approval], arguments: [] });
  });
  assert.equal(refusal(() => describeWalletTransaction(unused, expectStaff)).code, 'dangling_proposal', 'an empty approval nobody uses is a half-built payment');
  const noRule = await manual((tx) => {
    tx.moveCall({ target: '0x1::option::none', typeArguments: [approval], arguments: [] });
  });
  assert.equal(refusal(() => describeWalletTransaction(noRule, { ...expectStaff, staffPay: undefined })).code, 'command_not_allowed');
});

test('delegate_execution, approve_payout by the staff member, discard_approval and the other splash_spend calls are not understood here', async () => {
  for (const target of ['splash_spend::delegate_execution', 'splash_spend::discard_approval', 'splash_spend::approve_payout', 'splash_spend::rotate_spender']) {
    const bytes = await manual((tx) => {
      tx.moveCall({ target: `${SPEND}::${target}`, arguments: [shared(tx, POLICY)] });
    });
    const e = refusal(() => describeWalletTransaction(bytes, expectStaff));
    assert.ok(['command_not_allowed', 'bad_argument'].includes(e.code), `${target}: ${e.code}`);
  }
});

test('the purpose is a rule payment only when the bytes are exactly the payment the server stored', async () => {
  const bytes = await build();
  const d = describeWalletTransaction(bytes, expectStaff);
  const context = { staffPayment: { spender: STAFF, recipient: SUPPLIER, amountMinor: U(1_000), maxFeeMinor: U(0.25), policyId: POLICY, allowanceId: ALLOWANCE } };
  assertPurposeShape('staff_rule_payment', d, context);
  const bad = (over, why) => {
    const e = refusal(() => assertPurposeShape('staff_rule_payment', d, { staffPayment: { ...context.staffPayment, ...over } }));
    assert.equal(e.code, 'wrong_shape', why);
  };
  bad({ recipient: OTHER_STAFF }, 'another recipient');
  bad({ amountMinor: U(1_001) }, 'another amount');
  bad({ maxFeeMinor: U(0.26) }, 'another fee bound');
  bad({ spender: OTHER_STAFF }, 'sent by someone other than the person the rule is for');
  bad({ allowanceId: OTHER_ALLOWANCE }, 'another allowance');
  bad({ policyId: normalizeSuiAddress(`0x${'71'.repeat(32)}`) }, 'another policy');
  assert.equal(refusal(() => assertPurposeShape('staff_rule_payment', d, {})).code, 'wrong_shape', 'with no stored payment to compare, nothing is a rule payment');
  // The owners' purposes do not accept this shape, so it cannot be opened as a wallet payment by mistake.
  for (const purpose of ['wallet_payment', 'wallet_batch', 'withdrawal', 'partner_payout', 'spend_rule', 'spend_approval']) {
    assert.equal(refusal(() => assertPurposeShape(purpose, d, { batch: [], ...context })).code, 'wrong_shape', purpose);
  }
});

test('a quote that outlives the intent, or a withdrawal that is not the amount plus the fee, is refused as a rule payment', async () => {
  const late = describeWalletTransaction(await build({ settleByMs: NOW + 9n * 86_400_000n }), expectStaff);
  const context = { staffPayment: { spender: STAFF, recipient: SUPPLIER, amountMinor: U(1_000), maxFeeMinor: U(0.25), policyId: POLICY, allowanceId: ALLOWANCE } };
  assert.equal(refusal(() => assertPurposeShape('staff_rule_payment', late, context)).code, 'wrong_shape');
  const d = describeWalletTransaction(await build(), expectStaff);
  const tampered = structuredClone(d);
  tampered.actions[2].underRule.withdrawalMinor = (U(1_000) + U(5)).toString();
  assert.equal(refusal(() => assertPurposeShape('staff_rule_payment', tampered, context)).code, 'wrong_shape', 'drawing more than amount plus fee');
});

test('the builder refuses what could never be a rule payment', async () => {
  for (const [over, code] of [
    [{ amountMinor: 0n }, 'bad_amount'],
    [{ maxFeeMinor: -1n }, 'bad_fee'],
    [{ maxFeeMinor: U(11) }, 'bad_fee'],
    [{ settleByMs: NOW + 8n * 86_400_000n, expiresAtMs: NOW + 7n * 86_400_000n }, 'bad_deadline'],
    [{ paymentRef: new Uint8Array(31) }, 'bad_commitment'],
    [{ contentHash: new Uint8Array(0) }, 'no_audit_bundle'],
    [{ recipient: STAFF }, 'bad_recipient'],
  ]) {
    await assert.rejects(build(over), (error) => error.code === code, code);
  }
});

test('on the signing screen the staff member is told, in order, what the transaction does, and none of it is "not shown here"', async () => {
  const bytes = await build();
  const d = describeWalletTransaction(bytes, expectStaff);
  const items = signingItems(d.actions);
  assert.equal(items.some((i) => i.unknown), false);
  assert.ok(RENDERED_ACTION_TYPES.includes('no_second_approval'), 'every command the reader can return has wording');
  const words = plainActions(d.actions).join(' ');
  assert.match(words, /within your rule/i);
  assert.match(words, /1,000\.00 USDC/);
  assert.match(words, /0\.25 USDC/);
});

test('the approve screen reads a rule payment as one payment, what leaves the wallet is amount plus the fee bound, and it is not "unexpected"', async () => {
  const bytes = await build();
  const { digest, bytesHash } = walletTxDigest(bytes);
  const review = reviewOnDevice({ transactionBytes: Buffer.from(bytes).toString('base64'), digest, bytesHash, expect: expectStaff });
  const facts = approveFacts(review, { names: ['Dela Cruz Trading Corp'] });
  assert.equal(facts.kind, 'payment');
  assert.equal(facts.blocked, false, facts.blockedReason ?? '');
  assert.equal(facts.mismatch, null);
  assert.equal(facts.payments[0].amount, '1,000.00');
  assert.equal(facts.payments[0].maxFee, '0.25');
  assert.equal(facts.leavesAtMost, '1,000.25', 'drawn from the wallet under the allowance: the amount and at most the fee');
  assert.equal(facts.unexpected.length, 0);
});

test('config ids the reader checks are the ones the world built, so nothing above passed by accident', () => {
  assert.equal(spendChainCfg.spendPackageId, SPEND);
  assert.equal(spendChainCfg.policyRegistry.objectId, POLICY_REGISTRY);
  assert.equal(CONFIG.length, 66);
  assert.equal(FEES.length, 66);
  assert.equal(REGISTRY.length, 66);
});
