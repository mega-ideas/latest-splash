/**
 * Spending rules (sub-accounts), v2 §4.2: the backend Settings → Team &
 * rules calls.
 *
 *   window maths   the allowance's day and month windows roll over as the
 *                  chain rolls them (a stale `spent` is not shown), and the
 *                  running totals count what the policy counts
 *   layouts        the BCS the index reads follows the Move structs
 *   builders       every splash_spend call matches its Move signature
 *   reader         a rule transaction is shown for what it does; anything
 *                  else (another app, rotate_spender, another business's
 *                  policy or allowance, a dangling proposal) is refused
 *   flows          policy, give, change (= revoke + reissue), take back,
 *                  recipients (the WALLET tag only after the ownership
 *                  proof), limits, a second approval, all signed by the
 *                  quorum through the §4.1 signing flow
 *   rotation       the earlier generation's rules go stale and are reissued
 *                  under the new wallet; the old wallet revokes its own
 *   index          live spend, the current window, what is left, expiry,
 *                  running totals, RuleSpend events, a revoked rule
 *   routes         org from the session, owners only for changes
 *
 * PGlite, software passkeys, and the model chain in
 * tests/fixtures/spend-world.mjs. Nothing reaches a network.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import test from 'node:test';

import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';

import { softPasskey } from './fixtures/soft-passkey.mjs';
import { ACCOUNT, OTHER_ACCOUNT, T0, USDC } from './fixtures/wallet-world.mjs';
import { POLICY_REGISTRY, SPEND, spendChainCfg, spendExpect, spendWorld } from './fixtures/spend-world.mjs';
import { civilFromMs, liveRateLimit, thresholdCounted, windowBounds, windowIndexAt } from '../lib/wallet/allowance-window.ts';
import { allowanceNameFor, LAYOUTS, parseAllowance, AllowanceBcs, policyIdFor } from '../lib/wallet/spend-rules-bcs.ts';
import { describeWalletTransaction } from '../lib/wallet/wallet-tx-describe.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { startBusinessWallet, startWalletRotation } from '../lib/server/business-wallet.ts';
import { recordOwnershipProof } from '../lib/server/ownership-proofs.ts';
import { approvePayoutTx, createSpendPolicyTx, spendRuleTx } from '../lib/server/spend-rules-builders.ts';
import { spendIdsFromEnv } from '../lib/server/spend-rules-env.ts';
import {
  changePolicyLimits,
  changeRecipients,
  changeSpendingRule,
  issueSpendingRule,
  openSecondApproval,
  readSpendingRules,
  reissueAfterRotation,
  revokeSpendingRule,
  revokeStaleAllowances,
  startSpendPolicy,
} from '../lib/server/spend-rules.ts';
import { acceptApprovalAsk, askOwnersToApprove, listApprovalAsks, settleApprovalAsks } from '../lib/server/payment-approval-asks.ts';
import * as schema from '../lib/db/schema.ts';
import { eq } from 'drizzle-orm';
import { openSigningRequest, signingInbox, submitPartialSignature } from '../lib/server/wallet-signing.ts';

const DAY = 86_400_000n;
const USDC_1 = 1_000_000n;
const t0 = BigInt(T0.getTime());

async function sign(passkey, view) {
  return (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
}

async function signBy(w, view, ...who) {
  let last;
  for (const name of who) {
    last = await submitPartialSignature(w.signing, { orgId: 'acme', userId: name === 'founder' ? 'u-founder' : `u-${name}`, id: view.id, signature: await sign(w.keys[name], view), digest: view.digest });
    assert.equal(last.ok, true, JSON.stringify(last));
  }
  return last.request;
}

const membersOf = (wallet) => ({ multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) });

async function registered(w) {
  const started = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey }, owners: w.owners });
  assert.equal(started.ok, true, JSON.stringify(started));
  await signBy(w, started.request, 'founder');
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  assert.equal((await signBy(w, register, 'two', 'three')).status, 'executed');
  const wallet = buildBusinessMultisig({ members: w.owners });
  return { wallet, members: membersOf(wallet) };
}

/** A registered wallet with its policy, and a staff member's passkey. */
async function withPolicy(w, perPaymentMaxMinor = 20_000n * USDC_1) {
  const r = await registered(w);
  const opened = await startSpendPolicy(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: r.members, perPaymentMaxMinor });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.request.purpose, 'spend_policy');
  assert.equal((await signBy(w, opened.request, 'founder', 'two')).status, 'executed');
  return r;
}

const staffKey = softPasskey();
const STAFF = staffKey.address;
const STAFF2 = softPasskey().address;
const SUPPLIER = normalizeSuiAddress('0x' + '51'.repeat(32));
const EXCHANGE = normalizeSuiAddress('0x' + '52'.repeat(32));

function rule(overrides = {}) {
  return { spender: STAFF, perPaymentMaxMinor: 2_000n * USDC_1, cap: { period: 'month', limitMinor: 15_000n * USDC_1 }, expiresAtMs: t0 + 90n * DAY, ...overrides };
}

async function giveRule(w, members, r = rule()) {
  const opened = await issueSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, rule: r });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal((await signBy(w, opened.request, 'two', 'three')).status, 'executed');
  return opened.request;
}

/* ── Window maths ─────────────────────────────────────────────────────── */

test('a day window rolls over 24 hours after its first charge: the stale spent is not shown', () => {
  const anchor = t0 + 3_600_000n;
  const rl = { limit: 500n * USDC_1, spent: 500n * USDC_1, anchorMs: anchor, index: 0n, window: { kind: 'periodic', periodMs: DAY } };
  const during = liveRateLimit(rl, anchor + DAY - 1n);
  assert.deepEqual([during.spentMinor, during.remainingMinor, during.rolledOver], [500n * USDC_1, 0n, false]);
  assert.equal(during.endsAtMs, anchor + DAY);
  const after = liveRateLimit(rl, anchor + DAY);
  assert.deepEqual([after.spentMinor, after.remainingMinor, after.rolledOver], [0n, 500n * USDC_1, true]);
  assert.deepEqual([after.startsAtMs, after.endsAtMs], [anchor + DAY, anchor + 2n * DAY]);
  // Several windows later, the window counted is the one now.
  const later = liveRateLimit({ ...rl, index: 1n }, anchor + 5n * DAY + 7n);
  assert.equal(later.startsAtMs, anchor + 5n * DAY);
  // Nothing charged yet: the whole cap, no window yet (the first charge anchors it).
  const fresh = liveRateLimit({ ...rl, spent: 0n, anchorMs: null }, anchor);
  assert.deepEqual([fresh.remainingMinor, fresh.startsAtMs, fresh.endsAtMs], [500n * USDC_1, null, null]);
});

test("a month window renews on the anchor's day at 00:00 UTC, clamped to short months", () => {
  const ms = (iso) => BigInt(Date.parse(iso));
  const month = { kind: 'calendar', months: 1 };
  const anchor = ms('2027-01-31T10:00:00Z');
  assert.equal(windowIndexAt(month, anchor, ms('2027-02-27T23:59:59.999Z')), 0n);
  assert.equal(windowIndexAt(month, anchor, ms('2027-02-28T00:00:00Z')), 1n, 'a 31 January anchor renews on 28 February');
  assert.equal(windowIndexAt(month, anchor, ms('2027-03-30T23:59:59Z')), 1n);
  assert.equal(windowIndexAt(month, anchor, ms('2027-03-31T00:00:00Z')), 2n, 'then on 31 March');
  const leap = ms('2028-01-31T10:00:00Z');
  assert.equal(windowIndexAt(month, leap, ms('2028-02-29T00:00:00Z')), 1n, 'on 29 February in a leap year');
  assert.deepEqual(windowBounds(month, anchor, 1n), { startMs: ms('2027-02-28T00:00:00Z'), endMs: ms('2027-03-31T00:00:00Z') });
  const rl = { limit: 15_000n * USDC_1, spent: 14_000n * USDC_1, anchorMs: anchor, index: 0n, window: month };
  assert.equal(liveRateLimit(rl, ms('2027-02-28T00:00:00Z')).remainingMinor, 15_000n * USDC_1, 'month-end rollover');
  // Every window's bounds agree with the chain's index, for many anchors.
  for (const iso of ['2026-10-25T08:00:00Z', '2027-01-29T23:59:59Z', '2027-03-31T00:00:00Z', '2027-12-15T12:00:00Z', '2028-02-29T06:00:00Z']) {
    const a = ms(iso);
    for (let i = 0n; i < 26n; i++) {
      const { startMs, endMs } = windowBounds(month, a, i);
      assert.equal(windowIndexAt(month, a, i === 0n ? a : startMs), i, `${iso} window ${i} starts`);
      assert.equal(windowIndexAt(month, a, endMs - 1n), i, `${iso} window ${i} ends`);
      assert.equal(windowIndexAt(month, a, endMs), i + 1n, `${iso} window ${i + 1n} begins`);
    }
  }
  assert.deepEqual(civilFromMs(ms('2028-02-29T06:00:00Z')), { year: 2028n, month: 2n, day: 29n });
});

test('the running total counts what the policy counts: a window length after its last payment, plus what it carries', () => {
  const e = { windowStartMs: t0, windowEndMs: t0 + DAY, lastPaymentMs: t0 + DAY - 1n, total: 9_000n * USDC_1, carried: 2_000n * USDC_1, carriedUntilMs: t0 + 2n * 3_600_000n };
  assert.equal(thresholdCounted(e, t0 + 3_600_000n).countedMinor, 11_000n * USDC_1);
  assert.equal(thresholdCounted(e, t0 + DAY + 3_600_000n).countedMinor, 9_000n * USDC_1, 'past its window, still counting until a window after the last payment');
  assert.equal(thresholdCounted(e, t0 + DAY + 3_600_000n).countsUntilMs, t0 + 2n * DAY - 1n);
  assert.equal(thresholdCounted(e, t0 + 2n * DAY - 1n).countedMinor, 0n, 'and from then on nothing');
});

/* ── Layouts and names ────────────────────────────────────────────────── */

function moveFields(source, struct) {
  const m = source.match(new RegExp(`public struct ${struct}(?:<[^>]*>)? has [^{]*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `struct ${struct}`);
  return [...m[1].matchAll(/^\s*([a-z_][a-z0-9_]*):/gm)].map((x) => x[1]);
}

test('the BCS the index reads follows the Move structs field for field', async () => {
  const policy = await readFile(new URL('../move/splash_spend/sources/spend_policy.move', import.meta.url), 'utf8');
  const spend = await readFile(new URL('../move/splash_spend/sources/splash_spend.move', import.meta.url), 'utf8');
  for (const s of ['SpendPolicy', 'Spender', 'Destination', 'RunningKey', 'RunningTotal', 'PolicyKey']) assert.deepEqual(LAYOUTS[s], moveFields(policy, s), s);
  assert.deepEqual(LAYOUTS.RuleSpend, moveFields(spend, 'RuleSpend'));
  // The framework's allowance module, from the Move package cache the build uses.
  const framework = `${homedir()}/.move/git/https___github_com_MystenLabs_sui_git_719fb2960ccfbf9f4d33041f8ea5146d30671696/crates/sui-framework/packages/sui-framework/sources/allowance.move`;
  if (existsSync(framework)) {
    const allowance = await readFile(framework, 'utf8');
    assert.deepEqual(LAYOUTS.Allowance, moveFields(allowance, 'Allowance'));
    assert.deepEqual(LAYOUTS.Settings, moveFields(allowance, 'Settings'));
    assert.deepEqual(LAYOUTS.AllowanceCap, moveFields(allowance, 'AllowanceCap'));
    assert.match(allowance, /Windowed \{\s*\/\/\/[^\n]*\n\s*limit: u256,[\s\S]*spent: u256,[\s\S]*anchor_ms: Option<u64>,[\s\S]*index: u64,[\s\S]*window: Window,/);
    assert.match(allowance, /PeriodicMs\(u64\),[\s\S]*CalendarMonths\(u8\),/);
  }
  // A round trip through the layout.
  const bytes = AllowanceBcs.serialize({
    id: '0x' + '01'.repeat(32),
    settings: {
      funder: ACCOUNT, spender: STAFF, app: { name: 'x::splash_spend::SPLASH_SPEND' }, lifetime_cap: null, start_timestamp_ms: null, expiration_timestamp_ms: String(t0 + DAY),
      rate_limit: { Windowed: { limit: '5', spent: '2', anchor_ms: String(t0), index: '3', window: { CalendarMonths: 1 } } }, name: 'n',
    },
    current_spend: '9',
  }).toBytes();
  const a = parseAllowance(bytes);
  assert.deepEqual([a.spender, a.expiresAtMs, a.rateLimit.window, a.rateLimit.index, a.currentSpend], [STAFF, t0 + DAY, { kind: 'calendar', months: 1 }, 3n, 9n]);
});

test("a rule's allowance name and the policy id are what splash_spend computes", () => {
  const id = policyIdFor({ policyRegistryId: POLICY_REGISTRY, spendPackageId: SPEND, accountId: ACCOUNT, walletEpoch: 1n });
  assert.match(id, /^0x[0-9a-f]{64}$/);
  assert.notEqual(id, policyIdFor({ policyRegistryId: POLICY_REGISTRY, spendPackageId: SPEND, accountId: ACCOUNT, walletEpoch: 2n }), 'a rotation is a new policy');
  assert.notEqual(id, policyIdFor({ policyRegistryId: POLICY_REGISTRY, spendPackageId: SPEND, accountId: OTHER_ACCOUNT, walletEpoch: 1n }));
  const name = allowanceNameFor(id);
  assert.equal(name, `splash-policy:${id.slice(2)}`, 'address::to_string: 64 lowercase hex digits, no 0x');
  assert.equal(name.length, 78);
});

/* ── Builders against the Move sources ────────────────────────────────── */

function moveParams(source, fn) {
  const m = source.match(new RegExp(`public fun ${fn}(?:<[^>]*>)?\\(([\\s\\S]*?)\\)(?:: [^{]+)? \\{`));
  assert.ok(m, `public fun ${fn}`);
  return m[1].split(',').map((p) => p.trim()).filter((p) => p && !/TxContext/.test(p));
}

test('every splash_spend call the builders make has the Move signature, and none is rotate_spender', async () => {
  const policy = await readFile(new URL('../move/splash_spend/sources/spend_policy.move', import.meta.url), 'utf8');
  const spend = await readFile(new URL('../move/splash_spend/sources/splash_spend.move', import.meta.url), 'utf8');
  const gas = { owner: '0x' + 'aa'.repeat(32), price: 1000n, budget: 1_000_000n, epoch: 900n, chain: '11111111111111111111111111111111', nonce: 1 };
  const account = { objectId: ACCOUNT, initialSharedVersion: 9 };
  const pol = { objectId: '0x' + '70'.repeat(32), initialSharedVersion: 11 };
  const w = buildBusinessMultisig({ members: [{ userId: 'a', publicKey: softPasskey().publicKey }, { userId: 'b', publicKey: softPasskey().publicKey }] });
  const txs = [
    await createSpendPolicyTx(spendChainCfg, { wallet: w.address, account, keys: w.members.map((m) => fromBase64(m.suiPublicKey)), weights: [1, 1], threshold: 2, perPaymentMaxMinor: 1n, gas }),
    await spendRuleTx(spendChainCfg, {
      wallet: w.address, account, policy: pol, gas,
      ops: [
        { op: 'add_spender', spender: STAFF, role: 1, perPaymentMaxMinor: 5n },
        { op: 'remove_spender', spender: STAFF2 },
        { op: 'verify_recipient', address: SUPPLIER, kind: 2 },
        { op: 'remove_recipient', address: EXCHANGE },
        { op: 'verify_beneficiary', commitment: new Uint8Array(32).fill(3), partnerDeposit: EXCHANGE },
        { op: 'remove_beneficiary', commitment: new Uint8Array(32).fill(4) },
        { op: 'set_limits', perPaymentMaxMinor: 9n, secondApprovalThresholdMinor: 10n },
        { op: 'set_running_window', windowMs: 3_600_000n },
        { op: 'revoke_allowance', cap: { objectId: '0x' + '71'.repeat(32), version: 3, digest: '11111111111111111111111111111111' }, allowance: { objectId: '0x' + '72'.repeat(32), initialSharedVersion: 12 } },
        { op: 'issue_allowance', spender: STAFF, name: allowanceNameFor(pol.objectId), cap: { period: 'day', limitMinor: 7n }, expiresAtMs: t0 + DAY },
      ],
    }),
    await approvePayoutTx(spendChainCfg, { owner: STAFF2, account, policy: pol, intent: { objectId: '0x' + '99'.repeat(32), initialSharedVersion: 7 }, payer: STAFF, maxTotalMinor: 10n, settleByMs: t0 + 1n, gas }),
  ];
  const seen = new Set();
  for (const bytes of txs) {
    for (const c of Transaction.from(bytes).getData().commands) {
      if (c.$kind !== 'MoveCall') continue;
      const { package: pkg, module, function: fn, arguments: args } = c.MoveCall;
      if (normalizeSuiAddress(pkg) !== normalizeSuiAddress(SPEND)) continue;
      seen.add(`${module}::${fn}`);
      const params = moveParams(module === 'spend_policy' ? policy : spend, fn);
      assert.equal(args.length, params.length, `${module}::${fn}: ${params.join(', ')}`);
    }
  }
  assert.deepEqual([...seen].sort(), [
    'spend_policy::add_spender', 'spend_policy::create_policy', 'spend_policy::remove_beneficiary', 'spend_policy::remove_recipient', 'spend_policy::remove_spender',
    'spend_policy::set_limits', 'spend_policy::set_running_window', 'spend_policy::verify_beneficiary', 'spend_policy::verify_recipient',
    'splash_spend::accept', 'splash_spend::approve_payout',
  ]);
  const builders = await readFile(new URL('../lib/server/spend-rules-builders.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(builders, /rotate_spender'|allowance::new'|balance_spend/, 'no rotate_spender, no non-app allowance, no spend');
});

/* ── The reader ───────────────────────────────────────────────────────── */

test('a new rule is shown for what it does: who, how much a day or month, until when, under which policy', async () => {
  const w = await spendWorld();
  const { members } = await withPolicy(w);
  const opened = await issueSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, rule: rule() });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const actions = opened.request.description.actions;
  assert.deepEqual(actions.map((a) => a.type), ['add_spender', 'rate_limit', 'wrap_rate_limit', 'propose_allowance', 'accept_allowance']);
  const [add, , , propose, accept] = actions;
  assert.deepEqual([add.spender, add.role, add.perPaymentMaxMinor], [STAFF, 'staff', String(2_000n * USDC_1)]);
  assert.deepEqual(propose.rateLimit, { window: { kind: 'calendar', months: 1 }, limitMinor: String(15_000n * USDC_1) });
  assert.equal(propose.expiresAtMs, String(t0 + 90n * DAY));
  assert.equal(propose.name, allowanceNameFor(accept.policy));
  const { walletRequestHeadline } = await import('../lib/server/approval-requests.ts');
  assert.match(walletRequestHeadline('spend_rule', opened.request.description), /give 0x[0-9a-f]{4}…[0-9a-f]{4} a spending rule of 15,000\.00 USDC a month until 2027-01-23/);
  await w.client.close();
});

test("the reader refuses another app, rotate_spender, a plain allowance, another business's policy or allowance, and a dangling proposal", async () => {
  const w = await spendWorld();
  const { wallet } = await withPolicy(w);
  const policyId = [...w.spend.policies.keys()][0];
  const expect = { ...spendExpect, spend: { policyIds: [policyId], allowanceIds: [], capIds: [] } };
  const gas = await w.sponsor.gasFor();
  const B = `0x2::balance::Balance<${USDC}>`;
  const build = async (fill) => {
    const tx = new Transaction();
    fill(tx);
    tx.setSender(wallet.address);
    tx.setGasOwner(gas.owner);
    tx.setGasPrice(gas.price);
    tx.setGasBudget(gas.budget);
    tx.setGasPayment([]);
    tx.setExpiration({ ValidDuring: { minEpoch: '900', maxEpoch: '901', minTimestamp: null, maxTimestamp: null, chain: gas.chain, nonce: 5 } });
    return tx.build();
  };
  const refused = async (bytes, code, e = expect) => assert.throws(() => describeWalletTransaction(bytes, e), (err) => err.code === code, code);
  const pol = (tx) => tx.sharedObjectRef({ objectId: policyId, initialSharedVersion: 11, mutable: true });
  const propose = (tx, app, name = allowanceNameFor(policyId)) => {
    const [rl] = tx.moveCall({ target: '0x2::allowance::monthly_rate_limit', arguments: [tx.pure.u256(5n)] });
    const [some] = tx.moveCall({ target: '0x1::option::some', typeArguments: ['0x2::allowance::RateLimit'], arguments: [rl] });
    return tx.moveCall({
      target: '0x2::allowance::propose_for_app',
      typeArguments: [B, app],
      arguments: [tx.pure.string(name), tx.pure.address(STAFF), tx.pure.option('u256', null), tx.pure.option('u64', null), tx.pure.option('u64', t0 + DAY), some],
    })[0];
  };
  // An allowance bound to any other app: whoever wrote that app could spend under it.
  await refused(await build((tx) => propose(tx, `${'0x' + 'ba'.repeat(32)}::evil::APP`)), 'wrong_app');
  // A proposal nobody accepts.
  await refused(await build((tx) => propose(tx, `${SPEND}::splash_spend::SPLASH_SPEND`)), 'dangling_proposal');
  // A name for another policy.
  await refused(
    await build((tx) => {
      const p = propose(tx, `${SPEND}::splash_spend::SPLASH_SPEND`, allowanceNameFor('0x' + '73'.repeat(32)));
      tx.moveCall({ target: `${SPEND}::splash_spend::accept`, typeArguments: [USDC], arguments: [p, pol(tx), tx.sharedObjectRef({ objectId: ACCOUNT, initialSharedVersion: 9, mutable: false })] });
    }),
    'bad_argument',
  );
  // rotate_spender, and a plain allowance no app polices.
  await refused(await build((tx) => tx.moveCall({ target: '0x2::allowance::rotate_spender', typeArguments: [B, `${SPEND}::splash_spend::SPLASH_SPEND`], arguments: [tx.sharedObjectRef({ objectId: '0x' + '72'.repeat(32), initialSharedVersion: 12, mutable: true }), tx.pure.address(STAFF)] })), 'command_not_allowed');
  await refused(await build((tx) => tx.moveCall({ target: '0x2::allowance::new', typeArguments: [B], arguments: [tx.pure.string('x'), tx.pure.address(STAFF), tx.pure.option('u256', 5n), tx.pure.option('u64', null), tx.pure.option('u64', t0 + DAY), tx.pure.u8(0)] })), 'command_not_allowed');
  // A rule without its recurring cap.
  await refused(await build((tx) => tx.moveCall({ target: '0x1::option::none', typeArguments: ['0x2::allowance::RateLimit'] })), 'bad_argument');
  // Another business's policy, and an allowance this business does not hold.
  const foreignPolicy = await build((tx) => tx.moveCall({ target: `${SPEND}::spend_policy::remove_spender`, arguments: [tx.sharedObjectRef({ objectId: '0x' + '74'.repeat(32), initialSharedVersion: 3, mutable: true }), tx.pure.address(STAFF)] }));
  await refused(foreignPolicy, 'wrong_object');
  const foreignRevoke = await build((tx) => tx.moveCall({ target: '0x2::allowance::revoke', typeArguments: [B], arguments: [tx.objectRef({ objectId: '0x' + '75'.repeat(32), version: 2, digest: '11111111111111111111111111111111' }), tx.sharedObjectRef({ objectId: '0x' + '76'.repeat(32), initialSharedVersion: 4, mutable: true })] }));
  await refused(foreignRevoke, 'wrong_object');
  // A recipient off Sui.
  await refused(await build((tx) => tx.moveCall({ target: `${SPEND}::spend_policy::remove_recipient`, arguments: [pol(tx), tx.pure.u32(5), tx.pure.address(SUPPLIER)] })), 'bad_argument');
  // Without splash_spend configured, none of it is understood.
  const bare = { ...expect };
  delete bare.spendPackageId;
  delete bare.policyRegistryId;
  await refused(foreignPolicy, 'package_not_allowed', bare);
  await w.client.close();
});

/* ── Flows ────────────────────────────────────────────────────────────── */

test('the quorum creates the policy, then gives a staff member a rule; the index shows it live', async () => {
  const w = await spendWorld();
  const { members } = await withPolicy(w);
  // One policy per wallet generation.
  const again = await startSpendPolicy(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, perPaymentMaxMinor: 1n });
  assert.equal(again.code, 'policy_exists');

  // A rule above the business's per-payment maximum, without a cap, or expired, is refused.
  for (const [bad, code] of [
    [rule({ perPaymentMaxMinor: 30_000n * USDC_1 }), 'above_policy_max'],
    [rule({ cap: { period: 'month', limitMinor: 0n } }), 'bad_limit'],
    [rule({ expiresAtMs: t0 }), 'bad_expiry'],
    [rule({ expiresAtMs: t0 + 400n * DAY }), 'bad_expiry'],
  ]) {
    const r = await issueSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, rule: bad });
    assert.equal(r.code, code);
  }

  await giveRule(w, members);
  const { view } = await readSpendingRules(w.sc);
  assert.equal(view.policy.perPaymentMaxMinor, String(20_000n * USDC_1));
  assert.equal(view.policy.secondApprovalThresholdMinor, String(10_000n * USDC_1), 'D2: a second approval above 10,000 USDC by default');
  const [r] = view.rules;
  assert.deepEqual([r.spender, r.role, r.status, r.perPaymentMaxMinor], [STAFF, 'staff', 'active', String(2_000n * USDC_1)]);
  const [a] = r.allowances;
  assert.deepEqual([a.current, a.state, a.currentSpendMinor, a.expiresAtMs], [true, 'active', '0', String(t0 + 90n * DAY)]);
  assert.deepEqual([a.window.period, a.window.limitMinor, a.window.remainingMinor], ['month', String(15_000n * USDC_1), String(15_000n * USDC_1)]);
  assert.equal(a.spendableNowMinor, String(15_000n * USDC_1));
  // A second rule for the same person is a change, not a new rule.
  const dup = await issueSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, rule: rule() });
  assert.equal(dup.code, 'rule_exists');
  await w.client.close();
});

test('the WALLET tag needs a verified ownership proof; an exchange address does not', async () => {
  const w = await spendWorld();
  const { members } = await withPolicy(w);
  const refused = await changeRecipients(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, change: { add: [{ address: SUPPLIER, tag: 'wallet' }] } });
  assert.equal(refused.code, 'ownership_not_proven');
  assert.deepEqual(refused.details.addresses, [SUPPLIER]);
  // Another business's proof does not count here.
  await recordOwnershipProof(w.db, { orgId: 'northwind', address: SUPPLIER, method: 'signed_message', evidence: 'sig', now: T0 });
  assert.equal((await changeRecipients(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, change: { add: [{ address: SUPPLIER, tag: 'wallet' }] } })).code, 'ownership_not_proven');

  const exchange = await changeRecipients(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, change: { add: [{ address: EXCHANGE, tag: 'exchange' }] } });
  assert.equal(exchange.ok, true, JSON.stringify(exchange));
  await signBy(w, exchange.request, 'founder', 'three');

  await recordOwnershipProof(w.db, { orgId: 'acme', address: SUPPLIER, method: 'signed_message', evidence: 'sig', now: T0 });
  const proven = await changeRecipients(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, change: { add: [{ address: SUPPLIER, tag: 'wallet' }] } });
  assert.equal(proven.ok, true, JSON.stringify(proven));
  await signBy(w, proven.request, 'founder', 'three');
  const { view } = await readSpendingRules(w.sc);
  assert.deepEqual(view.policy.recipients, [{ address: EXCHANGE, tag: 'exchange' }, { address: SUPPLIER, tag: 'wallet' }]);

  // The gate holds in the signing flow too: bytes tagging an unproven address are refused before anyone signs.
  const policyId = [...w.spend.policies.keys()][0];
  const bytes = await spendRuleTx(spendChainCfg, { wallet: proven.request.sender, account: w.ctx.account, policy: { objectId: policyId, initialSharedVersion: 11 }, ops: [{ op: 'verify_recipient', address: '0x' + '53'.repeat(32), kind: 1 }], gas: await w.sponsor.gasFor() });
  const direct = await openSigningRequest(w.signing, { orgId: 'acme', requestedBy: 'u-founder', purpose: 'spend_rule', dedupeKey: 'x', transactionBytes: bytes, signer: { kind: 'multisig', ...members }, gasMode: 'sponsored', spend: { policyIds: [policyId] }, walletTagAllowed: [] });
  assert.equal(direct.code, 'wrong_shape');
  await w.client.close();
});

test('changing a rule revokes its allowance and issues the new one in one transaction', async () => {
  const w = await spendWorld();
  const { members } = await withPolicy(w);
  await giveRule(w, members);
  const [before] = (await readSpendingRules(w.sc)).view.rules[0].allowances;

  // Same per-payment maximum: the spender stays, so no approval is retired.
  const capOnly = await changeSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, rule: rule({ cap: { period: 'day', limitMinor: 800n * USDC_1 } }) });
  assert.equal(capOnly.ok, true, JSON.stringify(capOnly));
  assert.deepEqual(capOnly.request.description.actions.map((a) => a.type), ['revoke_allowance', 'rate_limit', 'wrap_rate_limit', 'propose_allowance', 'accept_allowance']);
  assert.equal(capOnly.request.description.actions[0].allowance, before.allowanceId);
  assert.equal((await signBy(w, capOnly.request, 'founder', 'two')).status, 'executed');
  const after = (await readSpendingRules(w.sc)).view.rules[0];
  assert.equal(after.allowances.length, 1);
  assert.notEqual(after.allowances[0].allowanceId, before.allowanceId);
  assert.deepEqual([after.allowances[0].window.period, after.allowances[0].window.limitMinor], ['day', String(800n * USDC_1)]);
  const generation = w.spend.policies.values().next().value.generation;

  // A new per-payment maximum: remove and re-add the spender (Move's only way), which retires approvals.
  const max = await changeSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, rule: rule({ perPaymentMaxMinor: 500n * USDC_1 }) });
  assert.deepEqual(max.request.description.actions.map((a) => a.type), ['revoke_allowance', 'remove_spender', 'add_spender', 'rate_limit', 'wrap_rate_limit', 'propose_allowance', 'accept_allowance']);
  await signBy(w, max.request, 'two', 'three');
  assert.equal(w.spend.policies.values().next().value.generation, generation + 1n);
  assert.equal((await readSpendingRules(w.sc)).view.rules[0].perPaymentMaxMinor, String(500n * USDC_1));

  // Someone with no rule has nothing to change.
  assert.equal((await changeSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, rule: rule({ spender: STAFF2 }) })).code, 'no_rule');
  await w.client.close();
});

test('a revoked rule: its allowance is gone, the spender is off the policy, and the index says so', async () => {
  const w = await spendWorld();
  const { members } = await withPolicy(w);
  await giveRule(w, members);
  await giveRule(w, members, rule({ spender: STAFF2, cap: { period: 'day', limitMinor: 100n * USDC_1 } }));
  const revoked = await revokeSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, spender: STAFF });
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  assert.deepEqual(revoked.request.description.actions.map((a) => a.type), ['revoke_allowance', 'remove_spender']);
  assert.match((await import('../lib/server/approval-requests.ts')).walletRequestHeadline('spend_rule', revoked.request.description), /take back/);
  await signBy(w, revoked.request, 'founder', 'two');
  const { view } = await readSpendingRules(w.sc);
  assert.deepEqual(view.rules.map((r) => r.spender), [STAFF2]);
  assert.equal(view.stale.length + view.unattached.length, 0);
  assert.equal([...w.spend.caps.values()].length, 1, "the wallet holds only the other rule's cap");
  assert.equal((await revokeSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, spender: STAFF })).code, 'no_rule');

  // A spender whose allowance was revoked elsewhere (the cap destroyed) shows as having no allowance.
  const [cap] = [...w.spend.caps.values()];
  w.spend.caps.delete(cap.objectId);
  w.spend.allowances.delete(cap.allowance);
  const [left] = (await readSpendingRules(w.sc)).view.rules;
  assert.deepEqual([left.spender, left.status, left.allowances.length], [STAFF2, 'no_allowance', 0]);
  await w.client.close();
});

test('the business-wide limits: per-payment maximum, threshold and window, within their bounds', async () => {
  const w = await spendWorld();
  const { members } = await withPolicy(w);
  assert.equal((await changePolicyLimits(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, runningWindowMs: 60_000n })).code, 'bad_window');
  assert.equal((await changePolicyLimits(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members })).code, 'empty');
  const r = await changePolicyLimits(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, secondApprovalThresholdMinor: 5_000n * USDC_1, runningWindowMs: 7n * DAY });
  assert.deepEqual(r.request.description.actions.map((a) => [a.type, a.secondApprovalThresholdMinor ?? a.windowMs]), [['set_limits', String(5_000n * USDC_1)], ['set_running_window', String(7n * DAY)]]);
  await signBy(w, r.request, 'founder', 'two');
  const { view } = await readSpendingRules(w.sc);
  assert.deepEqual([view.policy.secondApprovalThresholdMinor, view.policy.runningWindowMs, view.policy.perPaymentMaxMinor], [String(5_000n * USDC_1), String(7n * DAY), String(20_000n * USDC_1)]);
  await w.client.close();
});

/* ── The index: rollover, running totals, spends ──────────────────────── */

test('window rollover: a rule spent out today shows its full cap after the window, and its lifetime spend', async () => {
  const w = await spendWorld();
  const { members } = await withPolicy(w);
  await giveRule(w, members, rule({ cap: { period: 'day', limitMinor: 1_000n * USDC_1 }, lifetimeCapMinor: 2_500n * USDC_1 }));
  const allowanceId = [...w.spend.allowances.keys()][0];
  w.charge(allowanceId, 600n * USDC_1, t0 + 1_000n);
  w.charge(allowanceId, 400n * USDC_1, t0 + 5_000n);
  assert.throws(() => w.charge(allowanceId, 1n, t0 + 6_000n), /EExceedsRateLimit/, 'the model charges like the chain');

  let a = (await readSpendingRules(w.sc)).view.rules[0].allowances[0];
  assert.deepEqual([a.window.spentMinor, a.window.remainingMinor, a.spendableNowMinor, a.currentSpendMinor], ['1000000000', '0', '0', '1000000000']);
  assert.equal(a.window.endsAtMs, String(t0 + 1_000n + DAY));

  w.setNow(new Date(Number(t0 + 1_000n + DAY)));
  a = (await readSpendingRules(w.sc)).view.rules[0].allowances[0];
  assert.equal(a.window.rolledOver, true);
  assert.deepEqual([a.window.spentMinor, a.window.remainingMinor], ['0', '1000000000']);
  assert.equal(a.lifetimeRemainingMinor, String(1_500n * USDC_1));
  assert.equal(a.spendableNowMinor, String(1_000n * USDC_1), 'the smaller of the window and the lifetime');
  w.charge(allowanceId, 1_000n * USDC_1, t0 + 2_000n + DAY);
  a = (await readSpendingRules(w.sc)).view.rules[0].allowances[0];
  assert.deepEqual([a.window.rolledOver, a.window.spentMinor, a.lifetimeRemainingMinor, a.spendableNowMinor], [false, '1000000000', String(500n * USDC_1), '0']);

  // Past its expiry the rule is shown expired, with nothing to spend.
  w.setNow(new Date(Number(t0 + 91n * DAY)));
  const r = (await readSpendingRules(w.sc)).view.rules[0];
  assert.deepEqual([r.status, r.allowances[0].state, r.allowances[0].spendableNowMinor], ['expired', 'expired', '0']);
  await w.client.close();
});

test('running totals toward the second approval are shown per recipient, with what is left and RuleSpend events', async () => {
  const w = await spendWorld();
  const { members } = await withPolicy(w);
  await giveRule(w, members);
  const policy = w.spend.policies.values().next().value;
  policy.runningTotals.push(
    { payer: STAFF, beneficiary: '', recipient: SUPPLIER, windowStartMs: t0 - 3_600_000n, windowEndMs: t0 - 3_600_000n + DAY, lastPaymentMs: t0 - 60_000n, total: 8_500n * USDC_1, carried: 0n, carriedUntilMs: 0n },
    { payer: STAFF, beneficiary: 'ab'.repeat(32), recipient: '0x' + '00'.repeat(32), windowStartMs: t0 - 3n * DAY, windowEndMs: t0 - 2n * DAY, lastPaymentMs: t0 - 2n * DAY - 1n, total: 4_000n * USDC_1, carried: 0n, carriedUntilMs: 0n },
    { payer: STAFF2, beneficiary: '', recipient: SUPPLIER, windowStartMs: t0, windowEndMs: t0 + DAY, lastPaymentMs: t0, total: 1n, carried: 0n, carriedUntilMs: 0n },
  );
  w.spends.push({ policyId: policy.id, intentId: '0x' + '99'.repeat(32), allowanceId: [...w.spend.allowances.keys()][0], approvalId: null, spender: STAFF, recipient: SUPPLIER, derivedKind: 1, fee: 1_700_000n });
  const [r] = (await readSpendingRules(w.sc)).view.rules;
  assert.equal(r.runningTotals.length, 1, "a total that no longer counts is not shown, nor another payer's");
  const [t] = r.runningTotals;
  assert.deepEqual([t.recipient, t.countedMinor, t.beforeApprovalMinor, t.nearThreshold], [SUPPLIER, String(8_500n * USDC_1), String(1_500n * USDC_1), true]);
  assert.deepEqual(r.recentSpends, [{ intentId: '0x' + '99'.repeat(32), allowanceId: [...w.spend.allowances.keys()][0], approvalId: null, recipient: SUPPLIER, derivedKind: 1, feeMinor: '1700000' }]);
  await w.client.close();
});

/* ── Rotation ─────────────────────────────────────────────────────────── */

test('after a rotation the old policy is stale; the rules are reissued under the new wallet, and the old wallet revokes its own', async () => {
  const w = await spendWorld();
  const { members, wallet: old } = await withPolicy(w);
  await recordOwnershipProof(w.db, { orgId: 'acme', address: SUPPLIER, method: 'signed_message', evidence: 'sig', now: T0 });
  const recipients = await changeRecipients(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, change: { add: [{ address: SUPPLIER, tag: 'wallet' }, { address: EXCHANGE, tag: 'exchange' }] } });
  await signBy(w, recipients.request, 'founder', 'two');
  await giveRule(w, members);

  // Rotate to a 3-of-3 of the same owners.
  const rotate = await startWalletRotation(w.ctx, { orgId: 'acme', requestedBy: 'u-two', current: members, owners: w.owners, threshold: 3 });
  assert.equal(rotate.ok, true, JSON.stringify(rotate));
  await signBy(w, rotate.request, 'two', 'founder');
  const [confirm] = (await signingInbox(w.signing, { orgId: 'acme', userId: 'u-three' })).filter((r) => r.purpose === 'confirm_wallet_rotation');
  await signBy(w, confirm, 'founder', 'two', 'three');
  const next = buildBusinessMultisig({ members: w.owners, threshold: 3 });
  const nextMembers = membersOf(next);

  // Stale: the old policy and its rule can no longer pay.
  let { view } = await readSpendingRules(w.sc);
  assert.equal(view.walletEpoch, '2');
  assert.equal(view.policy, null);
  assert.equal(view.reissueNeeded, true);
  assert.equal(view.stale.length, 1);
  assert.deepEqual([view.stale[0].spender, view.stale[0].current, view.stale[0].funder], [STAFF, false, old.address]);
  assert.equal((await issueSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: nextMembers, rule: rule() })).code, 'no_policy');
  assert.equal((await issueSpendingRule(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, rule: rule() })).code, 'wallet_changed', 'the old wallet cannot be named');

  // The proof behind the WALLET tag is withdrawn meanwhile: that recipient is not carried.
  const { revokeOwnershipProof } = await import('../lib/server/ownership-proofs.ts');
  await revokeOwnershipProof(w.db, { orgId: 'acme', address: SUPPLIER });

  // Reissue: the new policy first, and the copy follows when it lands.
  const first = await reissueAfterRotation(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: nextMembers });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.request.purpose, 'spend_policy');
  assert.equal(first.request.sender, next.address);
  const created = await signBy(w, first.request, 'founder', 'two', 'three');
  assert.equal(created.status, 'executed', JSON.stringify(created));
  const [copy] = (await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' })).filter((r) => r.purpose === 'spend_rule');
  assert.ok(copy, 'the reissue opened itself once the policy landed');
  const types = copy.description.actions.map((a) => a.type);
  assert.deepEqual(types, ['verify_recipient', 'add_spender', 'rate_limit', 'wrap_rate_limit', 'propose_allowance', 'accept_allowance']);
  assert.equal(copy.description.actions[0].address, EXCHANGE, 'the exchange is carried; the wallet whose proof was withdrawn is not');
  assert.equal(copy.description.actions[4].expiresAtMs, String(t0 + 90n * DAY), 'the same expiry');
  await signBy(w, copy, 'founder', 'two', 'three');

  ({ view } = await readSpendingRules(w.sc));
  assert.equal(view.reissueNeeded, false);
  assert.deepEqual([view.rules.length, view.rules[0].spender, view.rules[0].status, view.rules[0].allowances[0].funder], [1, STAFF, 'active', next.address]);
  assert.equal(view.stale.length, 1, 'the old allowance is still there, unable to pay');

  // The old wallet's own quorum revokes it.
  const cleanup = await revokeStaleAllowances(w.sc, { orgId: 'acme', requestedBy: 'u-founder', oldWallet: old.address });
  assert.equal(cleanup.ok, true, JSON.stringify(cleanup));
  assert.equal(cleanup.request.sender, old.address);
  assert.deepEqual(cleanup.request.description.actions.map((a) => a.type), ['revoke_allowance']);
  await signBy(w, cleanup.request, 'founder', 'two');
  ({ view } = await readSpendingRules(w.sc));
  assert.equal(view.stale.length, 0);
  assert.equal((await revokeStaleAllowances(w.sc, { orgId: 'acme', requestedBy: 'u-founder', oldWallet: next.address })).code, 'not_stale');
  await w.client.close();
});

/* ── A second approval, asked for by staff ────────────────────────────── */

test("a staff member's payment above the threshold gets one owner's second approval through the ask", async () => {
  const w = await spendWorld();
  const { members } = await withPolicy(w);
  await giveRule(w, members);
  const INTENT = normalizeSuiAddress('0x' + '99'.repeat(32));
  w.model.addIntent({ id: INTENT, initialSharedVersion: 7, account: ACCOUNT, maker: STAFF, recipient: SUPPLIER, beneficiaryRef: '', amountMinor: 1_500n * USDC_1, kind: 1, targetCurrency: 'USDC', fxRateUsdLocal: 1_000_000n, expiresAtMs: t0 + 3n * DAY, status: 0, asset: USDC });
  const asked = await askOwnersToApprove({ db: w.db, ctx: w.ctx }, { orgId: 'acme', userId: 'u-staff', intentId: INTENT, contentHash: '04'.repeat(32), walrusBlobId: 'aa', requesterAddresses: [STAFF] });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  const opener = (ownerKey) => (input) => openSecondApproval(w.sc, { ...input, ownerPasskeyPublicKey: ownerKey.publicKey });

  // The fee shown above splash_spend's 1% ceiling is refused.
  const tooMuch = await acceptApprovalAsk({ db: w.db, ctx: w.ctx, secondApproval: opener(w.keys.two) }, { orgId: 'acme', userId: 'u-two', askId: asked.ask.id, mode: 'second_approval', maxFeeMinor: 16n * USDC_1, settleByMs: t0 + 300_000n });
  assert.equal(tooMuch.code, 'bad_fee');

  const accepted = await acceptApprovalAsk({ db: w.db, ctx: w.ctx, secondApproval: opener(w.keys.two) }, { orgId: 'acme', userId: 'u-two', askId: asked.ask.id, mode: 'second_approval', maxFeeMinor: 300_000n, settleByMs: t0 + 300_000n });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const request = accepted.request;
  assert.equal(request.purpose, 'spend_approval');
  assert.equal(request.sender, w.keys.two.address, 'one owner signs with their own passkey');
  const [approve] = request.description.actions;
  assert.deepEqual([approve.type, approve.payer, approve.maxTotalMinor, approve.intent.recipient], ['approve_payout', STAFF, String(1_500n * USDC_1 + 300_000n), SUPPLIER]);
  assert.equal(new Date(request.expiresAt).getTime(), Number(t0 + 300_000n), 'the request lasts no longer than the quote');
  assert.match((await import('../lib/server/approval-requests.ts')).walletRequestHeadline('spend_approval', request.description), /approve 1,500\.00 USDC to 0x5151…5151, paid by/);
  assert.equal((await signBy(w, request, 'two')).status, 'executed');
  assert.deepEqual(w.spend.approvals.map((a) => [a.approver, a.payer]), [[w.keys.two.address, STAFF]]);

  // An owner who is not a member of the wallet, a payer without a rule, another business's payment.
  const outsider = softPasskey();
  assert.equal((await openSecondApproval(w.sc, { orgId: 'acme', ownerUserId: 'u-x', ownerPasskeyPublicKey: outsider.publicKey, intentId: INTENT, payer: STAFF, maxFeeMinor: 0n, settleByMs: t0 + 1_000n })).code, 'not_a_wallet_member');
  assert.equal((await openSecondApproval(w.sc, { orgId: 'acme', ownerUserId: 'u-three', ownerPasskeyPublicKey: w.keys.three.publicKey, intentId: INTENT, payer: STAFF2, maxFeeMinor: 0n, settleByMs: t0 + 1_000n })).code, 'payer_not_a_spender');
  w.model.addIntent({ id: '0x' + '98'.repeat(32), initialSharedVersion: 7, account: OTHER_ACCOUNT, maker: STAFF, recipient: SUPPLIER, amountMinor: 1n, kind: 1, targetCurrency: 'USDC', fxRateUsdLocal: 1n, expiresAtMs: t0 + DAY, status: 0, asset: USDC });
  assert.equal((await openSecondApproval(w.sc, { orgId: 'acme', ownerUserId: 'u-three', ownerPasskeyPublicKey: w.keys.three.publicKey, intentId: '0x' + '98'.repeat(32), payer: STAFF, maxFeeMinor: 0n, settleByMs: t0 + 1_000n })).code, 'not_found');
  // The maker cannot approve their own payment, even as an owner.
  w.model.addIntent({ id: '0x' + '97'.repeat(32), initialSharedVersion: 7, account: ACCOUNT, maker: w.keys.three.address, recipient: SUPPLIER, amountMinor: 1n, kind: 1, targetCurrency: 'USDC', fxRateUsdLocal: 1n, expiresAtMs: t0 + DAY, status: 0, asset: USDC });
  assert.equal((await openSecondApproval(w.sc, { orgId: 'acme', ownerUserId: 'u-three', ownerPasskeyPublicKey: w.keys.three.publicKey, intentId: '0x' + '97'.repeat(32), payer: STAFF, maxFeeMinor: 0n, settleByMs: t0 + 1_000n })).code, 'self_approval');
  await w.client.close();
});

/* ── Sky's example: a payment over the rule, asked for with a draft ───── */

const bytes32hex = (b) => b.toString(16).padStart(2, '0').repeat(32);

function draft(overrides = {}) {
  return {
    paymentRef: bytes32hex(0x31),
    recipient: SUPPLIER,
    beneficiaryRef: '',
    amountMinor: 5_000n * USDC_1,
    kind: 1,
    targetCurrency: 'USDC',
    fxRateUsdLocal: 1_000_000n,
    commitment: bytes32hex(0x32),
    railCommitment: bytes32hex(0x33),
    expiresAtMs: t0 + 3n * DAY,
    ...overrides,
  };
}

test('(3) a staff payment over the rule cannot be opened on chain, so staff ask with a draft and the quorum pays it', async () => {
  const w = await spendWorld();
  const { members } = await withPolicy(w);
  const ex = await changeRecipients(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, change: { add: [{ address: EXCHANGE, tag: 'exchange' }] } });
  await signBy(w, ex.request, 'founder', 'two');
  await giveRule(w, members);

  // create_intent refuses both of Sky's cases, so no intent exists to ask about.
  assert.throws(() => w.createStaffIntent(STAFF, { id: '0x' + '41'.repeat(32), recipient: EXCHANGE, amountMinor: 5_000n * USDC_1, kind: 2, expiresAtMs: t0 + DAY }), /E_OVER_PER_PAYMENT_MAX/);
  assert.throws(() => w.createStaffIntent(STAFF, { id: '0x' + '42'.repeat(32), recipient: SUPPLIER, amountMinor: 100n * USDC_1, kind: 1, expiresAtMs: t0 + DAY }), /E_UNVERIFIED_DESTINATION/);
  const byIntent = await askOwnersToApprove({ db: w.db, ctx: w.ctx }, { orgId: 'acme', userId: 'u-staff', intentId: '0x' + '41'.repeat(32), contentHash: '04'.repeat(32), walrusBlobId: 'aa', requesterAddresses: [STAFF] });
  assert.equal(byIntent.status, 404, 'the intent path has nothing to ask about');

  const { readCurrentPolicy } = await import('../lib/server/spend-rules.ts');
  assert.equal(typeof readCurrentPolicy, 'function', 'the current policy can be read for an ask');
  const deps = { db: w.db, ctx: w.ctx, policy: () => readCurrentPolicy(w.sc) };
  const asked = await askOwnersToApprove(deps, { orgId: 'acme', userId: 'u-staff', draft: draft(), contentHash: '04'.repeat(32), walrusBlobId: 'aa', requesterAddresses: [STAFF], note: 'Supplier invoice, 5,000 USDC' });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.equal(asked.ask.intent.source, 'draft');
  assert.deepEqual([asked.ask.intent.recipient, asked.ask.intent.amountMinor, asked.ask.intent.kind], [SUPPLIER, String(5_000n * USDC_1), 1]);
  assert.deepEqual(asked.ask.intent.checks, { recipientVerified: false, overPerPaymentMax: true, makerPerPaymentMaxMinor: String(2_000n * USDC_1) }, 'owners see why it came to them');

  // One open ask per payment reference; malformed or impossible drafts are refused before anything is stored.
  assert.equal((await askOwnersToApprove(deps, { orgId: 'acme', userId: 'u-staff', draft: draft(), contentHash: '04'.repeat(32), walrusBlobId: 'aa', requesterAddresses: [STAFF] })).code, 'ask_open');
  for (const [bad, code] of [
    [draft({ paymentRef: 'zz' }), 'bad_draft'],
    [draft({ paymentRef: bytes32hex(0x34), kind: 3 }), 'cross_chain_not_built'],
    [draft({ paymentRef: bytes32hex(0x35), amountMinor: 0n }), 'bad_draft'],
    [draft({ paymentRef: bytes32hex(0x36), expiresAtMs: t0 }), 'bad_draft'],
    [draft({ paymentRef: bytes32hex(0x37), kind: 4, beneficiaryRef: '' }), 'bad_draft'],
  ]) {
    const r = await askOwnersToApprove(deps, { orgId: 'acme', userId: 'u-staff', draft: bad, contentHash: '04'.repeat(32), walrusBlobId: 'aa', requesterAddresses: [STAFF] });
    assert.equal(r.code, code, JSON.stringify(bad, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  }
  assert.equal((await w.db.select().from(schema.walletApprovalAsks)).length, 1);

  // A second approval needs an intent on chain; the quorum pays a draft from the wallet.
  const opener = (input) => openSecondApproval(w.sc, { ...input, ownerPasskeyPublicKey: w.keys.two.publicKey });
  const second = await acceptApprovalAsk({ ...deps, secondApproval: opener }, { orgId: 'acme', userId: 'u-two', askId: asked.ask.id, mode: 'second_approval', maxFeeMinor: 0n, settleByMs: t0 + 300_000n });
  assert.equal(second.code, 'no_intent');
  const accepted = await acceptApprovalAsk(deps, { orgId: 'acme', userId: 'u-two', askId: asked.ask.id, mode: 'wallet_pays', wallet: members, maxFeeMinor: 250_000n, settleByMs: t0 + 300_000n });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const d = accepted.request.description;
  assert.deepEqual(d.actions.map((a) => a.type), ['withdraw', 'open_intent', 'pay_intent', 'anchor_receipt', 'delete_intent'], 'create_for_wallet + confirm_from_business_wallet');
  assert.deepEqual([d.actions[1].recipient, d.actions[1].amountMinor], [SUPPLIER, String(5_000n * USDC_1)]);
  const done = await signBy(w, accepted.request, 'two', 'three');
  assert.equal(done.status, 'executed');
  const [row] = await w.db.select().from(schema.walletSigningRequests).where(eq(schema.walletSigningRequests.id, accepted.request.id));
  await settleApprovalAsks(w.db, row);
  const [after] = await listApprovalAsks(w.db, { orgId: 'acme', userId: 'u-staff' });
  assert.equal(after.status, 'approved');
  await w.client.close();
});

test('two owners accepting one ask at once: one signing request opens, and the ask follows it', async () => {
  const w = await spendWorld();
  const { members } = await withPolicy(w);
  const ex = await changeRecipients(w.sc, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, change: { add: [{ address: EXCHANGE, tag: 'exchange' }] } });
  await signBy(w, ex.request, 'founder', 'two');
  await giveRule(w, members);
  const id = w.createStaffIntent(STAFF, { id: '0x' + '43'.repeat(32), recipient: EXCHANGE, amountMinor: 1_500n * USDC_1, kind: 2, expiresAtMs: t0 + 3n * DAY });
  const deps = { db: w.db, ctx: w.ctx, secondApproval: (input) => openSecondApproval(w.sc, { ...input, ownerPasskeyPublicKey: w.keys.three.publicKey }) };
  const asked = await askOwnersToApprove(deps, { orgId: 'acme', userId: 'u-staff', intentId: id, contentHash: '04'.repeat(32), walrusBlobId: 'aa', requesterAddresses: [STAFF] });
  assert.equal(asked.ok, true, JSON.stringify(asked));
  const [a, b] = await Promise.all([
    acceptApprovalAsk(deps, { orgId: 'acme', userId: 'u-two', askId: asked.ask.id, mode: 'wallet_pays', wallet: members, maxFeeMinor: 250_000n, settleByMs: t0 + 300_000n }),
    acceptApprovalAsk(deps, { orgId: 'acme', userId: 'u-three', askId: asked.ask.id, mode: 'second_approval', maxFeeMinor: 250_000n, settleByMs: t0 + 300_000n }),
  ]);
  const won = [a, b].filter((r) => r.ok);
  assert.equal(won.length, 1, JSON.stringify([a.code ?? 'ok', b.code ?? 'ok']));
  assert.equal([a, b].find((r) => !r.ok).code, 'not_open');
  const opened = (await w.db.select().from(schema.walletSigningRequests)).filter((r) => r.purpose === 'wallet_payment' || r.purpose === 'spend_approval');
  assert.equal(opened.length, 1, 'only the winner built a request');
  const [ask] = await listApprovalAsks(w.db, { orgId: 'acme', userId: 'u-staff' });
  assert.equal(ask.signingRequestId, won[0].request.id);
  await w.client.close();
});

/* ── Routes and configuration ─────────────────────────────────────────── */

test('every spending-rule route takes the org from the session, and only owners change rules', async () => {
  const routes = ['route.ts', '[staffUserId]/route.ts', 'policy/route.ts', 'recipients/route.ts', 'reissue/route.ts'];
  for (const r of routes) {
    const source = await readFile(new URL(`../app/api/wallet/spending-rules/${r}`, import.meta.url), 'utf8');
    assert.match(source, /spendRoute\(request\)/, `${r}: the wallet route, the org from the session`);
    assert.doesNotMatch(source, /body\.orgId|searchParams\.get\('orgId'\)|body\.spender\b|body\.policy/, `${r}: no org, policy or address from the request`);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const at = source.indexOf(`export async function ${method}(`);
      if (at < 0) continue;
      const body = source.slice(at, source.indexOf('\n}\n', at));
      assert.match(body, /requireOwner\(route,/, `${r} ${method}: owners only`);
      assert.match(body, /limitWalletRequests\(route\)/, `${r} ${method}: rate-limited`);
    }
  }
  const front = await readFile(new URL('../lib/server/spend-rules-route.ts', import.meta.url), 'utf8');
  assert.match(front, /walletRoute\(request\)/);
  assert.match(front, /memberRole\(route\.db, route\.orgId, userId\)/, "a staff member is looked up in the caller's org only");
  assert.match(front, /a\.userId === userId && a\.canSign/, 'the address is their own active passkey here');
});

test("splash_spend's ids come from the environment or nothing is built", async () => {
  assert.equal(spendIdsFromEnv({}).ok, false);
  assert.match(spendIdsFromEnv({ SPLASH_SPEND_PACKAGE_ID: SPEND }).reason, /SPLASH_SPEND_POLICY_REGISTRY_ID/);
  assert.equal(spendIdsFromEnv({ SPLASH_SPEND_PACKAGE_ID: SPEND, SPLASH_SPEND_POLICY_REGISTRY_ID: POLICY_REGISTRY }).ok, true);
  const env = await readFile(new URL('../lib/env.ts', import.meta.url), 'utf8');
  assert.match(env, /SPLASH_SPEND_POLICY_REGISTRY_ID: objectId/);
});
