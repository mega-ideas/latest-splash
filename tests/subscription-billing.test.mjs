/**
 * Subscription billing (Amendment A1 §6), behind FEATURE_SUBSCRIPTION_BILLING,
 * which is OFF. Built and tested here; nothing is reachable while off.
 *
 *   off        every entry point is 404 and writes nothing; the routes check
 *              the flag before anything else; no payment path imports billing
 *   reader     a plain allowance::new is understood only for billing, only to
 *              the finance multisig, USDC, a calendar-month limit and an end
 *              of term; anything else is refused as before
 *   subscribe  the business wallet's quorum signs allowance::new with the
 *              plan price as its monthly limit; the AllowanceCap stays with
 *              the wallet; the bytes must carry exactly the plan's terms
 *   billing    at most one pull per business per calendar month (UTC),
 *              signed by the finance multisig; an invoice per pull and a
 *              receipt per paid one; a failed pull is grace plus a notice to
 *              that business's owners; retries bounded; grace lapses
 *   cancel     the wallet revokes; also possible with the flag off for a live
 *              plan; a revoke outside Splash cancels too
 *   change     revoke and new allowance in one transaction
 *   tenancy    another business's plan, invoices and notices are never read
 *
 * PGlite, software passkeys, the wallet model chain plus a model of the
 * framework allowance. Nothing reaches a network.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils';

import { expect as walletExpect, T0, USDC, world } from './fixtures/wallet-world.mjs';
import { describeWalletTransaction } from '../lib/wallet/wallet-tx-describe.ts';
import { buildBusinessMultisig } from '../lib/wallet/business-multisig.ts';
import { windowIndexAt } from '../lib/wallet/allowance-window.ts';
import { startBusinessWallet } from '../lib/server/business-wallet.ts';
import { openSigningRequest, signingInbox, submitPartialSignature } from '../lib/server/wallet-signing.ts';
import { allowanceCopy, billingAllowanceName, billingPeriod, subscriptionBillingEnabled, termEndUtc } from '../lib/billing/subscription.ts';
import { subscribeTx } from '../lib/server/subscription-builders.ts';
import {
  cancelSubscription,
  changePlan,
  continueBillingSteps,
  describeBillingPull,
  listPlans,
  MAX_PULL_ATTEMPTS,
  readSubscription,
  runBillingCycleForStaff,
  submitPullForStaff,
  subscribe,
  upsertPlanForStaff,
} from '../lib/server/subscription-billing.ts';

const FINANCE = normalizeSuiAddress('0x' + 'f1'.repeat(32));
const STRANGER = normalizeSuiAddress('0x' + '99'.repeat(32));
const USDC_1 = 1_000_000n;
const ON = { FEATURE_SUBSCRIPTION_BILLING: 'true' };
const OFF = {};
const B = `0x2::balance::Balance<${USDC}>`;

// ─── 1. Pure ────────────────────────────────────────────────────────────────

test('periods and terms are calendar months in UTC; only "true" turns billing on; the Settings line is the plan price', () => {
  assert.equal(billingPeriod(Date.UTC(2026, 9, 31, 23, 59)), '2026-10');
  assert.equal(billingPeriod(Date.UTC(2026, 10, 1, 0, 0)), '2026-11');
  assert.equal(termEndUtc(T0.getTime(), 12), Date.UTC(2027, 9, 1), 'October 2026 counts as the first of twelve months');
  assert.equal(termEndUtc(Date.UTC(2026, 11, 31), 1), Date.UTC(2027, 0, 1));
  assert.throws(() => termEndUtc(T0.getTime(), 0), RangeError);
  assert.equal(allowanceCopy(49n * USDC_1), 'Splash can draw up to 49 USDC per calendar month (UTC) for your plan. Revoke any time.');
  assert.equal(allowanceCopy(9_990_000n), 'Splash can draw up to 9.99 USDC per calendar month (UTC) for your plan. Revoke any time.');
  assert.equal(subscriptionBillingEnabled({}), false, 'off by default');
  assert.equal(subscriptionBillingEnabled({ FEATURE_SUBSCRIPTION_BILLING: '1' }), false);
  assert.equal(subscriptionBillingEnabled({ FEATURE_SUBSCRIPTION_BILLING: 'TRUE' }), false);
  assert.equal(subscriptionBillingEnabled(ON), true);
  assert.equal(billingAllowanceName('growth'), 'splash-billing:growth');
  assert.throws(() => billingAllowanceName('a b'), RangeError);
});

// ─── The world ─────────────────────────────────────────────────────────────

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

const hex = (n) => '0x' + n.toString(16).padStart(64, '0');

/** The framework allowance, modelled: new (plain, funded by the sender), revoke (the cap's owner), and a charge as consume does. */
function billingModel(w) {
  const state = { allowances: new Map(), caps: new Map(), next: 0x700 };
  const landed = new Map();
  const base = w.signing.chain;
  const expectB = () => ({ ...walletExpect, billing: { financeAddress: FINANCE, allowanceIds: [...state.allowances.keys()], capIds: [...state.caps.keys()] } });
  function run(bytes, commit) {
    let d;
    try {
      d = describeWalletTransaction(bytes, expectB());
    } catch {
      return null;
    }
    if (!d.actions.some((a) => a.type === 'new_billing_allowance' || a.type === 'revoke_billing_allowance')) return null;
    const s = { allowances: new Map(state.allowances), caps: new Map(state.caps), next: state.next };
    for (const a of d.actions) {
      if (a.type === 'revoke_billing_allowance') {
        const cap = s.caps.get(a.cap);
        if (!cap || cap.owner !== d.sender || cap.allowance !== a.allowance) return { success: false, error: 'MoveAbort(EWrongCap)' };
        s.caps.delete(a.cap);
        s.allowances.delete(a.allowance);
      }
      if (a.type === 'new_billing_allowance') {
        const id = hex(s.next++);
        const capId = hex(s.next++);
        s.allowances.set(id, {
          id, funder: d.sender, spender: a.spender, app: null,
          lifetimeCap: a.lifetimeCapMinor === null ? null : BigInt(a.lifetimeCapMinor),
          startMs: null, expiresAtMs: BigInt(a.expiresAtMs),
          rateLimit: { limit: BigInt(a.monthlyLimitMinor), spent: 0n, anchorMs: null, index: 0n, window: { kind: 'calendar', months: 1 } },
          name: a.name, currentSpend: 0n, initialSharedVersion: '21',
        });
        s.caps.set(capId, { objectId: capId, version: '22', digest: '11111111111111111111111111111111', owner: d.sender, allowance: id });
      }
    }
    if (commit) Object.assign(state, s);
    return { success: true };
  }
  w.signing.chain = {
    ...base,
    simulate: async (bytes) => run(bytes, false) ?? base.simulate(bytes),
    execute: async (bytes, sigs) => {
      const r = run(bytes, true);
      if (!r) return base.execute(bytes, sigs);
      const out = { digest: TransactionDataBuilder.getDigestFromBytes(bytes), ...r };
      landed.set(out.digest, out);
      return out;
    },
    read: async (digest) => landed.get(digest) ?? base.read(digest),
  };
  function charge(allowanceId, amount, nowMs) {
    const stored = state.allowances.get(allowanceId);
    if (!stored) throw new Error('EWrongAllowance');
    const a = { ...stored, rateLimit: { ...stored.rateLimit } };
    if (a.expiresAtMs !== null && nowMs >= a.expiresAtMs) throw new Error('EExpired');
    a.currentSpend += amount;
    if (a.lifetimeCap !== null && a.currentSpend > a.lifetimeCap) throw new Error('EExceedsLifetimeCap');
    const rl = a.rateLimit;
    if (rl.anchorMs !== null) {
      const current = windowIndexAt(rl.window, rl.anchorMs, nowMs);
      if (current > rl.index) {
        rl.index = current;
        rl.spent = 0n;
      }
    } else rl.anchorMs = nowMs;
    rl.spent += amount;
    if (rl.spent > rl.limit) throw new Error('EExceedsRateLimit');
    state.allowances.set(allowanceId, a);
  }
  const held = (owner) =>
    [...state.caps.values()].filter((c) => c.owner === normalizeSuiAddress(owner)).map((c) => ({ ...state.allowances.get(c.allowance), cap: { objectId: c.objectId, version: c.version, digest: c.digest } }));
  return { state, charge, held };
}

async function billingWorld({ env = ON } = {}) {
  const w = await world();
  const model = billingModel(w);
  let now = T0;
  const clock = () => now;
  const setNow = (d) => {
    now = d;
    w.setNow(d);
  };
  const deps = { db: w.db, env, now: clock };
  const bw = { ctx: w.ctx, financeAddress: async () => ({ ok: true, address: FINANCE }), readHeldAllowances: async (owner) => model.held(owner) };
  const prev = w.signing.onExecuted;
  w.signing.onExecuted = async (request) => {
    await prev(request);
    await continueBillingSteps(deps, bw, request);
  };
  const emails = [];
  let nonce = 77;
  const cycle = (over = {}) =>
    runBillingCycleForStaff({
      ...deps,
      usdcType: USDC,
      readAllowance: async (id) => model.state.allowances.get(id) ?? null,
      financeGas: async () => ({ price: 1000n, budget: 20_000_000n, epoch: 900n, chain: (await w.sponsor.gasFor()).chain, nonce: nonce++ }),
      readDigest: async () => null,
      readHeldAllowances: (owner) => bw.readHeldAllowances(owner),
      currentEpoch: async () => 900n,
      sendEmail: async (m) => { emails.push(m); return { providerRef: `em_${emails.length}` }; },
      appUrl: 'https://v1.splashz.xyz',
      ...over,
    });
  return { ...w, model, deps, bw, setNow, clock, cycle, emails };
}

async function registered(w) {
  const started = await startBusinessWallet(w.ctx, { orgId: 'acme', requestedBy: 'u-founder', founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey }, owners: w.owners });
  assert.equal(started.ok, true, JSON.stringify(started));
  await signBy(w, started.request, 'founder');
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  assert.equal((await signBy(w, register, 'two', 'three')).status, 'executed');
  const wallet = buildBusinessMultisig({ members: w.owners });
  return { address: wallet.address, members: { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) } };
}

const count = async (w, table) => (await w.client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

async function subscribed(w, planId = 'growth') {
  const r = await registered(w);
  await upsertPlanForStaff(w.db, { id: 'growth', name: 'Growth', priceMinor: 49n * USDC_1 });
  await upsertPlanForStaff(w.db, { id: 'scale', name: 'Scale', priceMinor: 199n * USDC_1, termMonths: 6 });
  const opened = await subscribe(w.deps, w.bw, { orgId: 'acme', requestedBy: 'u-founder', wallet: r.members, planId });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal((await signBy(w, opened.request, 'founder', 'two')).status, 'executed');
  return { ...r, opened };
}

// ─── 2. Off ─────────────────────────────────────────────────────────────────

test('with the flag off every entry point is not found and writes nothing', async () => {
  const w = await billingWorld({ env: OFF });
  const r = await registered(w);
  await upsertPlanForStaff(w.db, { id: 'growth', name: 'Growth', priceMinor: 49n * USDC_1 });
  const requestsBefore = await count(w, 'wallet_signing_requests');
  const input = { orgId: 'acme', requestedBy: 'u-founder', wallet: r.members };
  for (const result of [
    await listPlans(w.deps),
    await readSubscription(w.deps, 'acme'),
    await subscribe(w.deps, w.bw, { ...input, planId: 'growth' }),
    await changePlan(w.deps, w.bw, { ...input, planId: 'growth' }),
    await cancelSubscription(w.deps, w.bw, input),
    await submitPullForStaff({ ...w.deps, usdcType: USDC, execute: async () => { throw new Error('never'); } }, { pullId: 'pull_x', signatures: [] }),
  ]) {
    assert.deepEqual([result.ok, result.status, result.code], [false, 404, 'not_found']);
  }
  assert.deepEqual(await w.cycle(), { ok: false, status: 404, code: 'not_found' });
  assert.equal(await count(w, 'subscriptions'), 0);
  assert.equal(await count(w, 'subscription_pulls'), 0);
  assert.equal(await count(w, 'wallet_signing_requests'), requestsBefore, 'no request opened');
  await w.client.close();
});

async function code(relative) {
  const text = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

function handler(source, method) {
  const start = source.indexOf(`export async function ${method}(`);
  assert.ok(start >= 0, `exports ${method}`);
  const next = source.indexOf('export async function', start + 1);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

test('every billing route checks the flag before anything else; the customer route takes the org from the session, owners only', async () => {
  for (const [file, methods] of [['app/api/billing/plans/route.ts', ['GET']], ['app/api/wallet/subscription/route.ts', ['GET', 'POST']]]) {
    const src = await code(file);
    for (const m of methods) {
      const body = handler(src, m);
      const flag = body.indexOf('subscriptionBillingEnabled()');
      assert.ok(flag >= 0, `${file} ${m} checks the flag`);
      for (const later of ['walletRoute(', 'requireCustomerRequest(', 'getDb(']) {
        const at = body.indexOf(later);
        if (at >= 0) assert.ok(flag < at, `${file} ${m}: the flag is checked before ${later}`);
      }
    }
  }
  const cron = await code('app/api/cron/billing/route.ts');
  const cronBody = cron.slice(cron.indexOf('async function handle('));
  assert.ok(cronBody.indexOf('subscriptionBillingEnabled()') >= 0);
  assert.ok(cronBody.indexOf('subscriptionBillingEnabled()') < cronBody.indexOf('isAuthorized('), 'the cron checks the flag first');
  assert.ok(cronBody.indexOf('subscriptionBillingEnabled()') < cronBody.indexOf('runBillingCycleForStaff('));
  const customer = await code('app/api/wallet/subscription/route.ts');
  assert.match(customer, /walletRoute\(request\)/, 'walletRoute: requireSessionAccount, the session org');
  assert.match(customer, /requireOwner\(route/);
  assert.doesNotMatch(customer, /orgId:\s*body|body\.orgId|searchParams/, 'no org from the request');
  const walletRouteSrc = await code('lib/server/wallet-route.ts');
  assert.match(walletRouteSrc, /requireSessionAccount\(auth\.session\)/);
});

test('no payment path consults billing: only the billing routes, the cron and the executed-request hook import it', async () => {
  const roots = ['lib', 'app', 'components'];
  const allowed = new Set([
    'lib/server/subscription-billing.ts',
    'lib/server/subscription-billing-deps.ts',
    'lib/server/wallet-deps.ts',
    'app/api/wallet/subscription/route.ts',
    'app/api/billing/plans/route.ts',
    'app/api/cron/billing/route.ts',
  ]);
  const hits = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const rel = p.split(path.sep).join('/');
        const t = await readFile(p, 'utf8');
        if (/(?:from\s+|import\s*\()['"][^'"]*subscription-billing/.test(t) && !allowed.has(rel)) hits.push(rel);
      }
    }
  }
  for (const r of roots) await walk(r);
  assert.deepEqual(hits, []);
  const deps = await code('lib/server/wallet-deps.ts');
  assert.match(deps, /request\.purpose === 'subscription'[\s\S]*continueBillingSteps/, 'wallet-deps only continues an executed subscription request');
});

// ─── 3. The reader ──────────────────────────────────────────────────────────

test('a plain allowance is understood only for billing: to the finance multisig, USDC, monthly, with an end of term', async () => {
  const w = await billingWorld();
  const r = await registered(w);
  const gas = await w.sponsor.gasFor();
  const build = async (fill) => {
    const tx = new Transaction();
    fill(tx);
    tx.setSender(r.address);
    tx.setGasOwner(gas.owner);
    tx.setGasPrice(gas.price);
    tx.setGasBudget(gas.budget);
    tx.setGasPayment([]);
    tx.setExpiration({ ValidDuring: { minEpoch: '900', maxEpoch: '901', minTimestamp: null, maxTimestamp: null, chain: gas.chain, nonce: 5 } });
    return tx.build();
  };
  const allowanceNew = (tx, { spender = FINANCE, type = B, name = 'splash-billing:growth', expiry = 1_800_000_000_000n, monthly = true } = {}) => {
    const [rl] = monthly
      ? tx.moveCall({ target: '0x2::allowance::monthly_rate_limit', arguments: [tx.pure.u256(49n * USDC_1)] })
      : tx.moveCall({ target: '0x2::allowance::periodic_rate_limit', arguments: [tx.pure.u64(86_400_000n), tx.pure.u256(49n * USDC_1)] });
    const [some] = tx.moveCall({ target: '0x1::option::some', typeArguments: ['0x2::allowance::RateLimit'], arguments: [rl] });
    tx.moveCall({ target: '0x2::allowance::new', typeArguments: [type], arguments: [tx.pure.string(name), tx.pure.address(spender), tx.pure.option('u256', null), tx.pure.option('u64', null), tx.pure.option('u64', expiry), some] });
  };
  const billing = { ...walletExpect, billing: { financeAddress: FINANCE, allowanceIds: [], capIds: [] } };
  const good = describeWalletTransaction(await build((tx) => allowanceNew(tx)), billing);
  assert.deepEqual(good.actions.map((a) => a.type), ['rate_limit', 'wrap_rate_limit', 'new_billing_allowance']);
  assert.deepEqual(
    (({ spender, name, monthlyLimitMinor, expiresAtMs, lifetimeCapMinor, startsAtMs }) => ({ spender, name, monthlyLimitMinor, expiresAtMs, lifetimeCapMinor, startsAtMs }))(good.actions[2]),
    { spender: FINANCE, name: 'splash-billing:growth', monthlyLimitMinor: String(49n * USDC_1), expiresAtMs: '1800000000000', lifetimeCapMinor: null, startsAtMs: null },
  );
  const refused = async (fill, expectCode, e = billing) => assert.throws(() => describeWalletTransaction(fill, e), (err) => err.code === expectCode, expectCode);
  await refused(await build((tx) => allowanceNew(tx)), 'command_not_allowed', walletExpect);
  await refused(await build((tx) => allowanceNew(tx, { spender: STRANGER })), 'wrong_spender');
  await refused(await build((tx) => allowanceNew(tx, { spender: gas.owner })), 'wrong_spender');
  await refused(await build((tx) => allowanceNew(tx, { type: '0x2::balance::Balance<0x2::sui::SUI>' })), 'wrong_asset');
  await refused(await build((tx) => allowanceNew(tx, { name: 'rent' })), 'bad_argument');
  await refused(await build((tx) => allowanceNew(tx, { expiry: null })), 'bad_argument');
  await refused(await build((tx) => allowanceNew(tx, { monthly: false })), 'bad_argument');
  // A revoke of an allowance the server did not read as a billing allowance of this wallet.
  await refused(await build((tx) => tx.moveCall({ target: '0x2::allowance::revoke', typeArguments: [B], arguments: [tx.objectRef({ objectId: '0x' + '75'.repeat(32), version: 2, digest: '11111111111111111111111111111111' }), tx.sharedObjectRef({ objectId: '0x' + '76'.repeat(32), initialSharedVersion: 4, mutable: true })] })), 'wrong_object');
  await w.client.close();
});

// ─── 4. Subscribe ───────────────────────────────────────────────────────────

test('subscribing: the wallet quorum signs allowance::new to the finance multisig at the plan price; the cap stays with the wallet', async () => {
  const w = await billingWorld();
  const { opened, address } = await subscribed(w);
  assert.equal(opened.request.purpose, 'subscription');
  const n = opened.request.description.actions.find((a) => a.type === 'new_billing_allowance');
  assert.equal(n.spender, FINANCE);
  assert.equal(n.monthlyLimitMinor, String(49n * USDC_1));
  assert.equal(n.expiresAtMs, String(Date.UTC(2027, 9, 1)));
  const { walletRequestHeadline } = await import('../lib/server/approval-requests.ts');
  assert.equal(walletRequestHeadline('subscription', opened.request.description), 'let Splash draw up to 49.00 USDC per calendar month (UTC) for the plan, until 2027-10-01; revoke any time');

  const view = await readSubscription(w.deps, 'acme');
  assert.equal(view.subscription.status, 'active');
  assert.equal(view.subscription.copy, 'Splash can draw up to 49 USDC per calendar month (UTC) for your plan. Revoke any time.');
  assert.equal(view.subscription.financeAddress, FINANCE);
  const [cap] = [...w.model.state.caps.values()];
  assert.equal(cap.owner, normalizeSuiAddress(address), 'the AllowanceCap is the business wallet’s');
  assert.equal(view.subscription.allowanceId, cap.allowance);

  // Tenancy: another business sees nothing of it.
  const other = await readSubscription(w.deps, 'northwind');
  assert.deepEqual([other.subscription, other.pending, other.invoices, other.receipts], [null, null, [], []]);

  const again = await subscribe(w.deps, w.bw, { orgId: 'acme', requestedBy: 'u-founder', wallet: (await registeredMembers(w)), planId: 'growth' });
  assert.equal(again.code, 'already_subscribed');
  await w.client.close();
});

async function registeredMembers(w) {
  const wallet = buildBusinessMultisig({ members: w.owners });
  return { multisigPublicKey: wallet.multisigPublicKey, members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })) };
}

test('the bytes must carry exactly the plan: another price, term or spender is refused before anyone signs; no finance multisig, no plan', async () => {
  const w = await billingWorld();
  const r = await registered(w);
  await upsertPlanForStaff(w.db, { id: 'growth', name: 'Growth', priceMinor: 49n * USDC_1 });
  const gas = await w.sponsor.gasFor();
  const terms = { name: 'splash-billing:growth', monthlyLimitMinor: 49n * USDC_1, expiresAtMs: BigInt(Date.UTC(2027, 9, 1)), lifetimeCapMinor: null };
  const open = async (bytesOver, termsOver = {}) =>
    openSigningRequest(w.signing, {
      orgId: 'acme', requestedBy: 'u-founder', purpose: 'subscription', dedupeKey: 'billing:test', signer: { kind: 'multisig', ...r.members }, gasMode: 'sponsored',
      transactionBytes: await subscribeTx({ wallet: r.address, usdcType: USDC, name: terms.name, finance: FINANCE, monthlyLimitMinor: terms.monthlyLimitMinor, expiresAtMs: terms.expiresAtMs, lifetimeCapMinor: null, gas, ...bytesOver }),
      billing: { financeAddress: FINANCE, allowanceIds: [], capIds: [] },
      billingTerms: { revokeAllowances: [], grant: terms, ...termsOver },
    });
  assert.equal((await open({ monthlyLimitMinor: 4_900n * USDC_1 })).code, 'wrong_shape', 'a hundred times the price');
  assert.equal((await open({ expiresAtMs: terms.expiresAtMs + 1n })).code, 'wrong_shape', 'a longer term');
  assert.equal((await open({ finance: STRANGER })).code, 'wrong_spender', 'another spender');
  assert.equal((await open({}, { revokeAllowances: ['0x' + '76'.repeat(32)] })).code, 'wrong_shape', 'it must revoke every allowance the server named');
  assert.equal((await open({}, { grant: undefined })).code, 'wrong_shape', 'a grant the server did not ask for');

  const noFinance = await subscribe(w.deps, { ...w.bw, financeAddress: async () => ({ ok: false, error: 'SPLASH_FINANCE_ADDRESS is not set' }) }, { orgId: 'acme', requestedBy: 'u-founder', wallet: r.members, planId: 'growth' });
  assert.deepEqual([noFinance.status, noFinance.code], [503, 'finance_unconfigured']);
  const noPlan = await subscribe(w.deps, w.bw, { orgId: 'acme', requestedBy: 'u-founder', wallet: r.members, planId: 'nope' });
  assert.equal(noPlan.code, 'no_such_plan');
  assert.equal(await count(w, 'subscriptions'), 0);
  await w.client.close();
});

// ─── 5. Billing ─────────────────────────────────────────────────────────────

test('one pull per calendar month: an invoice with it, signed by the finance multisig, a receipt once it lands; never twice', async () => {
  const w = await billingWorld();
  const { address } = await subscribed(w);
  const wallet = normalizeSuiAddress(address);
  const first = await w.cycle();
  assert.equal(first.ok, true);
  assert.equal(first.prepared, 1);
  assert.deepEqual(first.errors, []);
  const [pull] = (await w.client.query(`SELECT * FROM subscription_pulls`)).rows;
  assert.deepEqual([pull.org_id, pull.period, BigInt(pull.amount_minor), pull.status], ['acme', '2026-10', 49n * USDC_1, 'awaiting_signature']);
  const d = describeBillingPull(fromBase64(pull.tx_bytes), USDC);
  assert.deepEqual([d.sender, d.funder, d.recipient, d.amountMinor], [FINANCE, wallet, FINANCE, String(49n * USDC_1)], 'the finance multisig draws from the business wallet, to itself');
  assert.equal(d.digest, pull.tx_digest);
  const [invoice] = (await w.client.query(`SELECT * FROM subscription_invoices`)).rows;
  assert.equal(invoice.number, 'SPL-202610-000001', 'a sequence per calendar month, not a hash of the org');
  assert.equal(invoice.plan_name, 'Growth');

  assert.equal((await w.cycle()).prepared, 0, 'the month has its pull');
  await assert.rejects(
    w.client.query(`INSERT INTO subscription_pulls (id, org_id, subscription_id, period, amount_minor, status, tx_bytes, tx_digest) VALUES ('pull_dup', 'acme', $1, '2026-10', 1, 'awaiting_signature', 'x', 'y')`, [pull.subscription_id]),
    /unique|duplicate/i,
    'the database refuses a second pull in a month',
  );

  const execute = async (bytes) => {
    const x = describeBillingPull(bytes, USDC);
    w.model.charge(x.allowance, BigInt(x.amountMinor), BigInt(w.clock().getTime()));
    return { digest: x.digest, success: true };
  };
  const sent = await submitPullForStaff({ ...w.deps, usdcType: USDC, execute }, { pullId: pull.id, signatures: ['finance-sig'] });
  assert.deepEqual(sent, { ok: true, status: 'succeeded' });
  assert.equal((await submitPullForStaff({ ...w.deps, usdcType: USDC, execute }, { pullId: pull.id, signatures: ['finance-sig'] })).code, 'not_awaiting', 'a paid pull is never sent again');
  const [receipt] = (await w.client.query(`SELECT * FROM subscription_receipts`)).rows;
  assert.deepEqual([receipt.org_id, receipt.sui_digest, receipt.invoice_id], ['acme', pull.tx_digest, invoice.id]);

  // Later in October: nothing. November: the next pull, once the chain's own window renews.
  w.setNow(new Date(Date.UTC(2026, 9, 31, 23, 0)));
  assert.equal((await w.cycle()).prepared, 0);
  w.setNow(new Date(Date.UTC(2026, 10, 1, 9, 0)));
  assert.equal((await w.cycle()).prepared, 0, 'the allowance window anchored on 25 October has no room until 25 November');
  w.setNow(new Date(Date.UTC(2026, 10, 25, 9, 0)));
  const nov = await w.cycle();
  assert.deepEqual(nov.errors, []);
  assert.equal(nov.prepared, 1);
  const periods = (await w.client.query(`SELECT period FROM subscription_pulls ORDER BY period`)).rows.map((x) => x.period);
  assert.deepEqual(periods, ['2026-10', '2026-11']);
  const view = await readSubscription(w.deps, 'acme');
  assert.equal(view.invoices.length, 2);
  assert.equal(view.receipts.length, 1);
  assert.deepEqual((await readSubscription(w.deps, 'northwind')).invoices, [], "another business's invoices are not read");
  await w.client.close();
});

test('a failed pull: grace and one notice to that business’s owners; tried again in the month a bounded number of times; grace lapses; payments are not touched', async () => {
  const w = await billingWorld();
  await subscribed(w);
  await w.cycle();
  const pullId = () => w.client.query(`SELECT id, status, attempts FROM subscription_pulls`).then((r) => r.rows[0]);
  const failing = async (bytes) => ({ digest: describeBillingPull(bytes, USDC).digest, success: false, error: 'MoveAbort(EInsufficientFunds)' });
  const r1 = await submitPullForStaff({ ...w.deps, usdcType: USDC, execute: failing, sendEmail: async (m) => { w.emails.push(m); return { providerRef: null }; } }, { pullId: (await pullId()).id, signatures: ['s'] });
  assert.deepEqual(r1, { ok: true, status: 'failed' });
  const sub = (await w.client.query(`SELECT status, grace_until FROM subscriptions WHERE status <> 'replaced'`)).rows[0];
  assert.equal(sub.status, 'grace');
  assert.equal(new Date(sub.grace_until).getTime(), T0.getTime() + 7 * 86_400_000);
  assert.deepEqual(w.emails.map((m) => m.to).sort(), ['founder@acme.test', 'three@acme.test', 'two@acme.test'], 'the owners of this business only');
  assert.equal(w.emails[0].subject, 'Your Splash plan payment did not go through');
  assert.match(w.emails[0].text, /Splash could not draw 49 USDC for your Growth plan for 2026-10\./);
  assert.match(w.emails[0].text, /Your payments are not affected: billing never holds a payment back\./);

  // The cycle tries again on the same row, at most MAX_PULL_ATTEMPTS in all.
  for (let i = 2; i <= MAX_PULL_ATTEMPTS + 1; i += 1) {
    const prepared = await w.cycle();
    const p = await pullId();
    if (i <= MAX_PULL_ATTEMPTS) {
      assert.deepEqual([prepared.prepared, p.status, p.attempts], [1, 'awaiting_signature', i]);
      await submitPullForStaff({ ...w.deps, usdcType: USDC, execute: failing, sendEmail: async (m) => { w.emails.push(m); return { providerRef: null }; } }, { pullId: p.id, signatures: ['s'] });
    } else {
      assert.equal(prepared.prepared, 0, 'no more tries this month');
    }
  }
  assert.equal(await count(w, 'subscription_pulls'), 1, 'still one pull row for the month');
  w.setNow(new Date(T0.getTime() + 7 * 86_400_000 + 1));
  const lapsed = await w.cycle();
  assert.equal(lapsed.lapsed, 1);
  assert.equal((await readSubscription(w.deps, 'acme')).subscription.status, 'lapsed');
  await w.client.close();
});

test('a pull whose answer was lost is settled from its digest on the next run, forward only', async () => {
  const w = await billingWorld();
  await subscribed(w);
  await w.cycle();
  const [p] = (await w.client.query(`SELECT id, tx_digest FROM subscription_pulls`)).rows;
  const timeout = async () => { throw new Error('timeout'); };
  assert.deepEqual(await submitPullForStaff({ ...w.deps, usdcType: USDC, execute: timeout }, { pullId: p.id, signatures: ['s'] }), { ok: true, status: 'submitted' });
  const settled = await w.cycle({ readDigest: async (digest) => (digest === p.tx_digest ? { success: true } : null) });
  assert.equal(settled.succeeded, 1);
  assert.equal(await count(w, 'subscription_receipts'), 1);
  const again = await w.cycle({ readDigest: async () => ({ success: false, error: 'late' }) });
  assert.equal(again.failed, 0, 'a paid pull never turns failed');
  await w.client.close();
});

// ─── 6. Cancel and change ───────────────────────────────────────────────────

test('cancelling is the wallet revoking the allowance; with the flag off a live plan can still be cancelled; a revoke outside Splash cancels too', async () => {
  const w = await billingWorld();
  const { members } = await subscribed(w);
  const offDeps = { ...w.deps, env: OFF };
  const opened = await cancelSubscription(offDeps, w.bw, { orgId: 'acme', requestedBy: 'u-two', wallet: members });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.deepEqual(opened.request.description.actions.map((a) => a.type), ['revoke_billing_allowance']);
  const { walletRequestHeadline } = await import('../lib/server/approval-requests.ts');
  assert.match(walletRequestHeadline('subscription', opened.request.description), /^cancel the Splash subscription/);
  assert.equal((await signBy(w, opened.request, 'two', 'three')).status, 'executed');
  assert.equal(w.model.state.allowances.size, 0, 'the allowance is gone');
  const rows = (await w.client.query(`SELECT status FROM subscriptions`)).rows.map((x) => x.status);
  assert.deepEqual(rows, ['cancelled']);
  assert.equal((await cancelSubscription(offDeps, w.bw, { orgId: 'acme', requestedBy: 'u-two', wallet: members })).code, 'not_found', 'nothing left to cancel');
  assert.equal((await w.cycle()).prepared, 0, 'nothing is billed');

  // A second business wallet... the same business subscribes again, then revokes on its own.
  const again = await subscribe(w.deps, w.bw, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, planId: 'growth' });
  assert.equal((await signBy(w, again.request, 'founder', 'two')).status, 'executed');
  w.model.state.allowances.clear();
  w.model.state.caps.clear();
  const c = await w.cycle();
  assert.equal(c.cancelled, 1);
  assert.equal(c.prepared, 0);
  await w.client.close();
});

test('a plan change revokes the old allowance and grants the new one in one transaction', async () => {
  const w = await billingWorld();
  const { members } = await subscribed(w);
  const oldAllowance = [...w.model.state.allowances.keys()][0];
  const changed = await changePlan(w.deps, w.bw, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, planId: 'scale' });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.deepEqual(changed.request.description.actions.map((a) => a.type), ['revoke_billing_allowance', 'rate_limit', 'wrap_rate_limit', 'new_billing_allowance']);
  assert.equal(changed.request.description.actions[0].allowance, oldAllowance);
  assert.equal(changed.request.description.actions[3].monthlyLimitMinor, String(199n * USDC_1));
  assert.equal(changed.request.description.actions[3].expiresAtMs, String(Date.UTC(2027, 3, 1)), 'six calendar months from October');
  assert.equal((await changePlan(w.deps, w.bw, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, planId: 'scale' })).code, 'request_open', 'one change at a time');
  assert.equal((await signBy(w, changed.request, 'founder', 'three')).status, 'executed');
  assert.equal(w.model.state.allowances.has(oldAllowance), false);
  const rows = (await w.client.query(`SELECT plan_id, status FROM subscriptions ORDER BY created_at`)).rows.map((x) => [x.plan_id, x.status]);
  assert.deepEqual(rows, [['growth', 'replaced'], ['scale', 'active']]);
  const view = await readSubscription(w.deps, 'acme');
  assert.equal(view.subscription.copy, 'Splash can draw up to 199 USDC per calendar month (UTC) for your plan. Revoke any time.');
  await w.client.close();
});

// ─── 6b. Staff tools: plans and the finance multisig's pulls ──────────────────

test('staff list and edit plans, and list the pulls waiting for the finance signers with what each does; nothing while the flag is off', async () => {
  const { listPlansForStaff, listPullsAwaitingSignatureForStaff } = await import('../lib/server/subscription-billing.ts');
  const w = await billingWorld();
  const { address } = await subscribed(w);
  await upsertPlanForStaff(w.db, { id: 'legacy', name: 'Legacy', priceMinor: 9n * USDC_1, active: false });
  const plans = await listPlansForStaff(w.deps);
  assert.deepEqual(plans.plans.map((p) => [p.id, p.active]), [['legacy', false], ['growth', true], ['scale', true]], 'inactive plans too, for staff');
  await w.cycle();
  const listed = await listPullsAwaitingSignatureForStaff({ ...w.deps, usdcType: USDC });
  assert.equal(listed.ok, true);
  assert.equal(listed.pulls.length, 1);
  const [p] = listed.pulls;
  assert.deepEqual([p.orgId, p.period, p.amountMinor, p.planName], ['acme', '2026-10', String(49n * USDC_1), 'Growth']);
  assert.deepEqual([p.description.sender, p.description.funder, p.description.recipient], [FINANCE, normalizeSuiAddress(address), FINANCE], 'the signers see what the bytes do, read from the bytes');
  assert.equal(p.description.digest, p.txDigest);
  assert.ok(p.txBytes.length > 0);
  for (const r of [await listPlansForStaff({ ...w.deps, env: OFF }), await listPullsAwaitingSignatureForStaff({ ...w.deps, env: OFF, usdcType: USDC })]) {
    assert.deepEqual([r.ok, r.status, r.code], [false, 404, 'not_found']);
  }
  await w.client.close();
});

test('the staff billing routes check the flag first, then an operations staff session; the pull route only relays signatures', async () => {
  for (const [file, methods] of [['app/api/admin/billing/plans/route.ts', ['GET', 'PUT']], ['app/api/admin/billing/pulls/route.ts', ['GET']], ['app/api/admin/billing/pulls/[id]/route.ts', ['POST']]]) {
    const src = await code(file);
    for (const m of methods) {
      const body = handler(src, m);
      const flag = body.indexOf('subscriptionBillingEnabled()');
      const session = body.indexOf('requireBillingStaff(');
      assert.ok(flag >= 0 && session > flag, `${file} ${m}: the flag, then the staff session`);
      for (const later of ['getDb(', 'upsertPlanForStaff(', 'submitPullForStaff(', 'listPullsAwaitingSignatureForStaff(', 'listPlansForStaff(']) {
        const at = body.indexOf(later);
        if (at >= 0) assert.ok(session < at, `${file} ${m}: staff are checked before ${later}`);
      }
    }
  }
  const staff = await code('lib/server/billing-staff.ts');
  assert.match(staff, /getAdminSession\(\)/);
  assert.match(staff, /role !== 'operations'/);
  const pull = await code('app/api/admin/billing/pulls/[id]/route.ts');
  assert.doesNotMatch(pull, /signTransaction|Keypair|fromSecretKey|kms/i, 'the server never signs a pull');
});

// ─── 7. Review fixes: reconcile, cancel without the finance proof, plan changes and stuck pulls ──

const pulls = (w) => w.client.query(`SELECT * FROM subscription_pulls ORDER BY created_at, (status = 'superseded') DESC, id`).then((r) => r.rows);
const subs = (w) => w.client.query(`SELECT * FROM subscriptions ORDER BY created_at, id`).then((r) => r.rows);
const succeed = (w) => async (bytes) => {
  const x = describeBillingPull(bytes, USDC);
  w.model.charge(x.allowance, BigInt(x.amountMinor), BigInt(w.clock().getTime()));
  return { digest: x.digest, success: true };
};
const failingPull = async (bytes) => ({ digest: describeBillingPull(bytes, USDC).digest, success: false, error: 'MoveAbort(EInsufficientFunds)' });

test('a subscribe whose follow-up missed the new allowance (indexer lag) opens no second request when an owner subscribes again, and a later run activates it', async () => {
  const w = await billingWorld();
  const r = await registered(w);
  await upsertPlanForStaff(w.db, { id: 'growth', name: 'Growth', priceMinor: 49n * USDC_1 });
  let lag = false;
  const real = w.bw.readHeldAllowances;
  w.bw.readHeldAllowances = async (owner) => (lag ? [] : real(owner));
  const opened = await subscribe(w.deps, w.bw, { orgId: 'acme', requestedBy: 'u-founder', wallet: r.members, planId: 'growth' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  lag = true;
  assert.equal((await signBy(w, opened.request, 'founder', 'two')).status, 'executed');
  assert.deepEqual((await subs(w)).map((s) => [s.status, s.allowance_id]), [['pending', null]], 'the follow-up could not see the allowance yet');

  const requestsBefore = await count(w, 'wallet_signing_requests');
  const again = await subscribe(w.deps, w.bw, { orgId: 'acme', requestedBy: 'u-founder', wallet: r.members, planId: 'growth' });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'reconcile_pending');
  assert.equal(await count(w, 'wallet_signing_requests'), requestsBefore, 'no request is left for the owners to sign');
  assert.equal(w.model.state.allowances.size, 1, 'one billing allowance on chain');

  lag = false;
  const c = await w.cycle();
  assert.deepEqual(c.errors, []);
  const [s] = await subs(w);
  assert.equal(s.status, 'active', 'the cron reconciles the executed subscribe');
  assert.equal(s.allowance_id, [...w.model.state.allowances.keys()][0]);
  await w.client.close();
});

test('the cron reports an executed subscribe it still cannot reconcile, so a person is told, and keeps trying', async () => {
  const w = await billingWorld();
  const r = await registered(w);
  await upsertPlanForStaff(w.db, { id: 'growth', name: 'Growth', priceMinor: 49n * USDC_1 });
  const real = w.bw.readHeldAllowances;
  let lag = false;
  w.bw.readHeldAllowances = async (owner) => (lag ? [] : real(owner));
  const opened = await subscribe(w.deps, w.bw, { orgId: 'acme', requestedBy: 'u-founder', wallet: r.members, planId: 'growth' });
  lag = true;
  await signBy(w, opened.request, 'founder', 'two');
  const c = await w.cycle();
  assert.equal(c.errors.length, 1);
  assert.match(c.errors[0].error, /left no allowance/);
  lag = false;
  assert.deepEqual((await w.cycle()).errors, []);
  assert.equal((await subs(w))[0].status, 'active');
  await w.client.close();
});

test('cancel needs no finance proof: it works after a finance rotation, with the finance address unset, and with the fee config unreadable', async () => {
  for (const finance of [
    async () => ({ ok: true, address: normalizeSuiAddress('0x' + 'f2'.repeat(32)) }),
    async () => ({ ok: false, error: 'SPLASH_FINANCE_ADDRESS is not set' }),
    async () => { throw new Error('the fee config could not be read'); },
  ]) {
    const w = await billingWorld();
    const { members } = await subscribed(w);
    const opened = await cancelSubscription(w.deps, { ...w.bw, financeAddress: finance }, { orgId: 'acme', requestedBy: 'u-two', wallet: members });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal((await signBy(w, opened.request, 'two', 'three')).status, 'executed');
    assert.equal(w.model.state.allowances.size, 0);
    assert.deepEqual((await subs(w)).map((s) => s.status), ['cancelled']);
    await w.client.close();
  }
});

test('cancel revokes every billing allowance the wallet holds to a Splash finance address, not only the tracked one', async () => {
  const w = await billingWorld();
  const { members, address } = await subscribed(w);
  // A stray billing allowance to the same finance multisig, which Splash has no row for.
  const stray = hex(0x900);
  const strayCap = hex(0x901);
  w.model.state.allowances.set(stray, { ...[...w.model.state.allowances.values()][0], id: stray });
  w.model.state.caps.set(strayCap, { objectId: strayCap, version: '22', digest: '11111111111111111111111111111111', owner: normalizeSuiAddress(address), allowance: stray });
  const opened = await cancelSubscription(w.deps, w.bw, { orgId: 'acme', requestedBy: 'u-two', wallet: members });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.deepEqual(opened.request.description.actions.map((a) => a.type), ['revoke_billing_allowance', 'revoke_billing_allowance']);
  assert.equal((await signBy(w, opened.request, 'two', 'three')).status, 'executed');
  assert.equal(w.model.state.allowances.size, 0, 'no billing allowance is left on chain');
  await w.client.close();
});

test('a failed pull retried after a plan change is drawn, invoiced and receipted under the new plan; the old pull is superseded', async () => {
  const w = await billingWorld();
  const { members } = await subscribed(w);
  await w.cycle();
  const [growthPull] = await pulls(w);
  assert.deepEqual(await submitPullForStaff({ ...w.deps, usdcType: USDC, execute: failingPull, sendEmail: async () => ({ providerRef: null }) }, { pullId: growthPull.id, signatures: ['s'] }), { ok: true, status: 'failed' });

  const changed = await changePlan(w.deps, w.bw, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, planId: 'scale' });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal((await signBy(w, changed.request, 'founder', 'three')).status, 'executed');
  const scale = (await subs(w)).find((s) => s.plan_id === 'scale');
  assert.equal(scale.status, 'active');

  const c = await w.cycle();
  assert.deepEqual(c.errors, []);
  assert.equal(c.prepared, 1);
  const rows = await pulls(w);
  assert.deepEqual(rows.map((p) => [p.subscription_id === scale.id, p.status, BigInt(p.amount_minor)]), [[false, 'superseded', 49n * USDC_1], [true, 'awaiting_signature', 199n * USDC_1]]);
  const fresh = rows[1];
  assert.equal(describeBillingPull(fromBase64(fresh.tx_bytes), USDC).amountMinor, String(199n * USDC_1), 'the bytes draw what the row says');
  const invoices = (await w.client.query(`SELECT * FROM subscription_invoices ORDER BY number`)).rows;
  assert.deepEqual(invoices.map((i) => [i.number, i.plan_name, BigInt(i.amount_minor)]), [['SPL-202610-000001', 'Growth', 49n * USDC_1], ['SPL-202610-000002', 'Scale', 199n * USDC_1]]);

  assert.deepEqual(await submitPullForStaff({ ...w.deps, usdcType: USDC, execute: succeed(w) }, { pullId: fresh.id, signatures: ['s'] }), { ok: true, status: 'succeeded' });
  const [receipt] = (await w.client.query(`SELECT * FROM subscription_receipts`)).rows;
  assert.equal(BigInt(receipt.amount_minor), 199n * USDC_1, 'the receipt is what the chain drew');
  assert.equal(receipt.invoice_id, invoices[1].id);
  assert.equal((await w.cycle()).prepared, 0, 'October is paid: no further pull');
  await w.client.close();
});

test('a plan change supersedes the old plan’s pull waiting for signatures, so no stale pull or false notice follows', async () => {
  const w = await billingWorld();
  const { members } = await subscribed(w);
  await w.cycle();
  const changed = await changePlan(w.deps, w.bw, { orgId: 'acme', requestedBy: 'u-founder', wallet: members, planId: 'scale' });
  await signBy(w, changed.request, 'founder', 'three');
  const [old] = await pulls(w);
  assert.equal(old.status, 'superseded');
  assert.equal((await submitPullForStaff({ ...w.deps, usdcType: USDC, execute: failingPull }, { pullId: old.id, signatures: ['s'] })).code, 'not_awaiting');
  assert.deepEqual(w.emails, []);
  await w.client.close();
});

test('a pull left unsigned past its gas window is rebuilt on the same row; a pull the network refused before running stays signable', async () => {
  const w = await billingWorld();
  await subscribed(w);
  await w.cycle({ currentEpoch: async () => 900n });
  const [before] = await pulls(w);
  assert.equal((await w.cycle({ currentEpoch: async () => 901n })).prepared, 0, 'still inside its window');
  const later = await w.cycle({ currentEpoch: async () => 902n, financeGas: async () => ({ price: 1000n, budget: 20_000_000n, epoch: 902n, chain: (await w.sponsor.gasFor()).chain, nonce: 9 }) });
  assert.deepEqual(later.errors, []);
  assert.equal(later.prepared, 1);
  const [after] = await pulls(w);
  assert.equal(after.id, before.id, 'the same row');
  assert.notEqual(after.tx_digest, before.tx_digest, 'new bytes');
  assert.deepEqual([after.status, after.attempts], ['awaiting_signature', 1], 'an expired window is not a failed attempt');

  const rejected = await submitPullForStaff({ ...w.deps, usdcType: USDC, execute: async () => { throw new Error('Invalid user signature'); }, readDigest: async () => null }, { pullId: after.id, signatures: ['bad'] });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'not_sent');
  assert.equal((await pulls(w))[0].status, 'awaiting_signature', 'the finance signers can sign again');
  assert.deepEqual(await submitPullForStaff({ ...w.deps, usdcType: USDC, execute: succeed(w) }, { pullId: after.id, signatures: ['good'] }), { ok: true, status: 'succeeded' });
  await w.client.close();
});

test('a submitted pull the chain never saw is made signable again once its gas window has passed', async () => {
  const w = await billingWorld();
  await subscribed(w);
  await w.cycle({ currentEpoch: async () => 900n });
  const [p] = await pulls(w);
  const lost = await submitPullForStaff({ ...w.deps, usdcType: USDC, execute: async () => { throw new Error('timeout'); }, readDigest: async () => { throw new Error('unreachable'); } }, { pullId: p.id, signatures: ['s'] });
  assert.deepEqual(lost, { ok: true, status: 'submitted' }, 'the answer is unknown: it waits for the digest');
  assert.equal((await w.cycle({ currentEpoch: async () => 901n })).prepared, 0);
  const c = await w.cycle({ currentEpoch: async () => 903n, financeGas: async () => ({ price: 1000n, budget: 20_000_000n, epoch: 903n, chain: (await w.sponsor.gasFor()).chain, nonce: 11 }) });
  assert.equal(c.prepared, 1);
  const [q] = await pulls(w);
  assert.deepEqual([q.id, q.status], [p.id, 'awaiting_signature']);
  assert.notEqual(q.tx_digest, p.tx_digest);
  await w.client.close();
});
