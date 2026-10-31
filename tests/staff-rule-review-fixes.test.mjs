/**
 * v2 Phase 3, staff payments inside a rule: what the independent review found,
 * reproduced first and then fixed. Each test names the failure it keeps out.
 *
 *   gas allowance   a staff member's unsigned requests could use up the whole
 *                   24-hour network-fee allowance of the business and lock the
 *                   owners out of their own payments
 *   reasons         the sentence a person reads quoted the cap before the
 *                   payments already on their way, so it contradicted itself
 *   threshold       several staff paying one recipient each stayed under the
 *                   second-approval amount and together went past it
 *   replay          another member of the business was handed a payment they
 *                   did not make
 *   one moment      the chain read and the in-flight read were not taken at the
 *                   same point in time
 *
 * On PGlite with every migration, software passkeys and the model chain.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import * as schema from '../lib/db/schema.ts';
import { formatUsdc } from '../lib/fees/copy.ts';
import { readStaffRule } from '../lib/server/spend-rules.ts';
import * as T from '../lib/server/wallet-transfers.ts';
import { T0 } from './fixtures/wallet-world.mjs';
import { NORTH_WALLET, OWNER, STAFF, STAFF2, SUPPLIER, amountInput, feeFor, input, setup, signOwn, staff2Key, staffKey, U } from './fixtures/staff-rule-world.mjs';

const staffRequests = (w) => w.db.select().from(schema.walletSigningRequests).where(eq(schema.walletSigningRequests.purpose, 'staff_rule_payment'));
const key = (n) => `tx_key_${String(n).padStart(6, '0')}`;

// ─── The network-fee allowance ──────────────────────────────────────────────

test('a staff member cannot have more than three payments open at once: the next goes to the owners, who keep their network-fee allowance', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address, { cap: { period: 'month', limitMinor: U(15_000) } }));
  const opened = [];
  for (let n = 1; n <= 3; n += 1) {
    const r = await T.createTransfer(t.deps(), STAFF, amountInput(t.recipientId, 1, { clientKey: key(n) }));
    assert.equal(r.transfer.route, 'staff_rule', `payment ${n}`);
    opened.push(r);
  }
  const fourth = await T.createTransfer(t.deps(), STAFF, amountInput(t.recipientId, 1, { clientKey: key(4) }));
  assert.equal(fourth.ok, true, JSON.stringify(fourth));
  assert.equal(fourth.transfer.route, 'asked_owners', 'a fourth open payment is asked of the owners, not opened');
  assert.deepEqual(fourth.plan.reasons, ['too_many_open']);
  assert.match(fourth.plan.lines.join(' '), /already have 3 payments waiting/i);
  assert.equal((await staffRequests(t.w)).length, 3, 'no fourth request, so no fourth share of the allowance');
  // Insisting on paying alone is refused in words, and nothing is stored.
  const insisted = await T.createTransfer(t.deps(), STAFF, amountInput(t.recipientId, 1, { clientKey: key(5), via: 'rule' }));
  assert.deepEqual([insisted.ok, insisted.status, insisted.code], [false, 409, 'outside_rule']);
  // The owners can still pay from the wallet: the allowance was not drained.
  const owner = await T.createTransfer(t.deps(), OWNER, amountInput(t.recipientId, 5, { clientKey: key(6) }));
  assert.equal(owner.ok, true, JSON.stringify(owner));
  assert.equal(owner.transfer.route, 'owners_sign');
  // Once one is signed it is no longer waiting, and the next goes through.
  assert.equal((await signOwn(t.w, 'u-staff', staffKey, opened[0].signingRequest)).request.status, 'executed');
  const again = await T.createTransfer(t.deps(), STAFF, amountInput(t.recipientId, 1, { clientKey: key(7) }));
  assert.equal(again.transfer.route, 'staff_rule');
  await t.w.client.close();
});

test('staff payments together may use only a fifth of the day’s network-fee allowance, whoever signs them; past that the owners are asked and keep the rest', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address, { cap: { period: 'month', limitMinor: U(15_000) } }));
  await t.give(t.rule(staff2Key.address, { cap: { period: 'month', limitMinor: U(15_000) } }));
  const first = await T.createTransfer(t.deps(), STAFF, amountInput(t.recipientId, 1, { clientKey: key(1) }));
  assert.equal(first.transfer.route, 'staff_rule');
  const gas = BigInt(first.signingRequest.description.gas.budget);
  assert.ok(gas > 0n);
  // A day's allowance of ten requests: staff may use two of them (20%).
  t.w.signing.sponsorDailyBudgetMist = gas * 10n;
  assert.equal((await signOwn(t.w, 'u-staff', staffKey, first.signingRequest)).request.status, 'executed');
  const second = await T.createTransfer(t.deps(), STAFF2, amountInput(t.recipientId, 1, { clientKey: key(2) }));
  assert.equal(second.transfer.route, 'staff_rule');
  assert.equal((await signOwn(t.w, 'u-staff2', staff2Key, second.signingRequest)).request.status, 'executed');
  // The business’s staff have used their share. Not an error: the owners are asked, with the reason.
  const third = await T.createTransfer(t.deps(), STAFF, amountInput(t.recipientId, 1, { clientKey: key(3) }));
  assert.equal(third.ok, true, JSON.stringify(third));
  assert.equal(third.transfer.route, 'asked_owners');
  assert.deepEqual(third.plan.reasons, ['staff_gas_share_used']);
  assert.equal((await staffRequests(t.w)).length, 2, 'the claim for the third left no request behind');
  const insisted = await T.createTransfer(t.deps(), STAFF2, amountInput(t.recipientId, 1, { clientKey: key(4), via: 'rule' }));
  assert.deepEqual([insisted.ok, insisted.status, insisted.code], [false, 429, 'staff_gas_share_used']);
  assert.match(insisted.error, /Nothing was sent/);
  // Eight tenths of the allowance are still the owners’.
  for (let n = 5; n <= 7; n += 1) {
    const owner = await T.createTransfer(t.deps(), OWNER, amountInput(t.recipientId, 5, { clientKey: key(n) }));
    assert.equal(owner.ok, true, `owner payment ${n}: ${JSON.stringify(owner)}`);
  }
  await t.w.client.close();
});

// ─── The sentence says what is true ─────────────────────────────────────────

test('the reason for a payment that is more than is left names what is left after the payment already on its way, not the whole cap', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address, { cap: { period: 'month', limitMinor: U(1_300) } }));
  const fee = feeFor(U(1_000));
  const first = await T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: key(1) }));
  assert.equal(first.transfer.route, 'staff_rule');
  const second = await T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: key(2) }));
  assert.equal(second.transfer.route, 'asked_owners');
  assert.deepEqual(second.plan.reasons, ['over_cap']);
  const left = `${formatUsdc(U(1_300) - U(1_000) - fee)} USDC left`;
  const line = second.plan.lines.join(' ');
  assert.ok(line.includes(left), `${left} in: ${line}`);
  assert.ok(!line.includes('1,300.00 USDC left'), 'the whole cap is not "left"');
  assert.match(line, /already on its way for you/);
  assert.ok(second.ask.note.includes(left), 'the owners read the same figure');
  await t.w.client.close();
});

test('a cap used up only by payments on their way does not promise the window’s renewal; it says the payments on their way hold it', async () => {
  const t = await setup();
  const fee = feeFor(U(1_000));
  await t.give(t.rule(staffKey.address, { cap: { period: 'month', limitMinor: U(1_000) + fee } }));
  const first = await T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: key(1) }));
  assert.equal(first.transfer.route, 'staff_rule');
  const second = await T.createTransfer(t.deps(), STAFF, amountInput(t.recipientId, 10, { clientKey: key(2) }));
  assert.deepEqual(second.plan.reasons, ['cap_used_up']);
  const line = second.plan.lines.join(' ');
  assert.doesNotMatch(line, /renews/i, line);
  assert.match(line, /already on its way for you/);
  assert.match(line, /not signed/i, 'and says what frees it');
  await t.w.client.close();
});

// ─── The second-approval amount, across people ──────────────────────────────

test('staff paying one recipient count together towards the second-approval amount: the payment that crosses it goes to the owners', async () => {
  const t = await setup();
  const wide = { perPaymentMaxMinor: U(6_000), cap: { period: 'month', limitMinor: U(50_000) } };
  await t.give(t.rule(staffKey.address, wide));
  await t.give(t.rule(staff2Key.address, wide));
  const a = await T.createTransfer(t.deps(), STAFF, amountInput(t.recipientId, 6_000, { clientKey: key(1) }));
  assert.equal(a.transfer.route, 'staff_rule');
  assert.equal((await signOwn(t.w, 'u-staff', staffKey, a.signingRequest)).request.status, 'executed');
  // Another person, their own rule, the same recipient: 6,000 + 4,001 is past 10,000.
  const over = await T.createTransfer(t.deps(), STAFF2, amountInput(t.recipientId, 4_001, { clientKey: key(2) }));
  assert.equal(over.ok, true, JSON.stringify(over));
  assert.equal(over.transfer.route, 'asked_owners');
  assert.deepEqual(over.plan.reasons, ['above_threshold']);
  const exact = await T.createTransfer(t.deps(), STAFF2, amountInput(t.recipientId, 4_000, { clientKey: key(3) }));
  assert.equal(exact.transfer.route, 'staff_rule', 'exactly the amount needs no approval');
  await t.w.client.close();
});

test('another person’s payment still on its way counts towards the same recipient’s second-approval amount', async () => {
  const t = await setup();
  const wide = { perPaymentMaxMinor: U(6_000), cap: { period: 'month', limitMinor: U(50_000) } };
  await t.give(t.rule(staffKey.address, wide));
  await t.give(t.rule(staff2Key.address, wide));
  const a = await T.createTransfer(t.deps(), STAFF, amountInput(t.recipientId, 6_000, { clientKey: key(1) }));
  assert.equal(a.transfer.route, 'staff_rule');
  const over = await T.createTransfer(t.deps(), STAFF2, amountInput(t.recipientId, 4_001, { clientKey: key(2) }));
  assert.equal(over.transfer.route, 'asked_owners');
  assert.deepEqual(over.plan.reasons, ['above_threshold']);
  // The other person’s cap is their own: only the recipient’s total is shared.
  const own = await T.createTransfer(t.deps(), STAFF2, amountInput(t.recipientId, 4_000, { clientKey: key(3) }));
  assert.equal(own.transfer.route, 'staff_rule');
  await t.w.client.close();
});

// ─── Who may ask for the answer again ───────────────────────────────────────

test('an intent id answers only the person who made the payment: another member, owner or not, is told the id was used for another payment', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  await t.give(t.rule(staff2Key.address));
  const mine = await T.createTransfer(t.deps(), STAFF, input(t.recipientId));
  assert.equal(mine.transfer.route, 'staff_rule');
  for (const [who, actor] of [['another staff member', STAFF2], ['an owner', OWNER]]) {
    const r = await T.createTransfer(t.deps(), actor, input(t.recipientId));
    assert.deepEqual([r.ok, r.status, r.code], [false, 409, 'idempotency_key_reused'], who);
    assert.ok(!('transfer' in r), `${who} is shown nothing of the payment`);
  }
  assert.equal((await staffRequests(t.w)).length, 1);
  const same = await T.createTransfer(t.deps(), STAFF, input(t.recipientId));
  assert.equal(same.created, false, 'the person who made it still gets their payment back');
  assert.equal(same.transfer.id, mine.transfer.id);
  await t.w.client.close();
});

// ─── One moment ─────────────────────────────────────────────────────────────

test('the moment a rule is read is taken before the first read of the chain, so a payment that lands in between is counted twice, not never', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  const real = t.w.sc.wallet.readAccount.bind(t.w.sc.wallet);
  const late = {
    ...t.w.sc,
    wallet: {
      ...t.w.sc.wallet,
      readAccount: async () => {
        // Time passes while the chain is read.
        t.w.setNow(new Date(T0.getTime() + 90_000));
        return real();
      },
    },
  };
  const read = await readStaffRule(late, { addresses: [staffKey.address] });
  assert.equal(read.ok, true, read.error);
  assert.equal(read.read.readAtMs, BigInt(T0.getTime()), 'the clock was read before the chain was');
  await t.w.client.close();
});

test('a claim whose request is still being made holds the cap for as long as it can still become a request, and is let go of after that', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address, { cap: { period: 'month', limitMinor: U(1_300) } }));
  const fee = feeFor(U(1_000));
  let n = 0;
  const claim = (minutesAgo) => {
    n += 1;
    const at = new Date(T0.getTime() - minutesAgo * 60_000);
    return t.w.db.insert(schema.walletTransfers).values({
      id: `wtr_old_${n}`, orgId: 'acme', clientKey: `old_claim_${n}0000`, requestHash: `h${n}`, paymentRef: `ref${n}`, route: 'staff_rule', payeeKind: 'self_custody',
      recipientId: t.recipientId, payeeName: 'Dela Cruz Trading Corp', payeeMasked: 'x', address: SUPPLIER, amountMinor: U(1_000), maxFeeMinor: fee, feeKind: 1, requestedBy: 'u-staff', createdAt: at, updatedAt: at,
    });
  };
  // Five minutes old: a slow upload of the audit bundle can take that long. Still held.
  await claim(5);
  const held = await T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: key(1) }));
  assert.equal(held.transfer.route, 'asked_owners');
  assert.deepEqual(held.plan.reasons, ['over_cap']);
  // An hour old: the request that made it is long dead.
  await t.w.db.delete(schema.walletTransfers).where(eq(schema.walletTransfers.id, 'wtr_old_1'));
  await t.w.db.delete(schema.walletTransfers).where(eq(schema.walletTransfers.clientKey, key(1)));
  await claim(60);
  const freed = await T.createTransfer(t.deps(), STAFF, input(t.recipientId, { clientKey: key(2) }));
  assert.equal(freed.transfer.route, 'staff_rule');
  await t.w.client.close();
});

// ─── A Splash business is not paid under a rule ─────────────────────────────

test('a Splash business is paid by the owners: under a rule it is a request to them with the reason, not a hard error', async () => {
  const t = await setup();
  await t.give(t.rule(staffKey.address));
  const deps = t.deps('acme', { businessWallet: async (id) => (id === 'northwind' ? { ok: true, name: 'Northwind Traders', wallet: NORTH_WALLET, country: 'PH' } : null) });
  const body = (over = {}) => ({ clientKey: key(1), payee: { kind: 'splash_business', businessId: 'northwind' }, amountMinor: U(500).toString(), maxFeeMinor: feeFor(U(500), 0).toString(), reference: 'INV-9', ...over });
  const asked = await T.createTransfer(deps, STAFF, body());
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.equal(asked.transfer.route, 'asked_owners');
  assert.deepEqual(asked.plan.reasons, ['recipient_not_on_rule']);
  assert.equal((await staffRequests(t.w)).length, 0);
  const insisted = await T.createTransfer(deps, STAFF, body({ clientKey: key(2), via: 'rule' }));
  assert.deepEqual([insisted.ok, insisted.status, insisted.code], [false, 409, 'outside_rule']);
  await t.w.client.close();
});
