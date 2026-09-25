import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { fromBase64, toBase64 } from '@mysten/sui/utils';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import { parseUsdcMinor, SUI_USDC_COIN_TYPE } from '../lib/payments/stablecoin-lane.ts';
import { readAllowance, RESERVATION_MS } from '../lib/server/stablecoin-outflows.ts';
import { quoteWalletTransfer, submitWalletTransfer } from '../lib/server/stablecoin-send.ts';

/**
 * A wallet transfer end to end — quote, sign, submit — against real
 * migrations and a scripted chain. The chain double computes balance changes
 * from the bytes it is given, so a wallet that alters the transaction is
 * caught by the same arithmetic that would catch it on Sui.
 */

const usdc = (s) => parseUsdcMinor(s);
const SENDER = `0x${'11'.repeat(32)}`;
const OTHER = `0x${'99'.repeat(32)}`;
const RECIPIENT = `0x${'22'.repeat(32)}`;
const FEE = `0x${'33'.repeat(32)}`;
const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);

async function migratedDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const files = (await readdir(new URL('../drizzle', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sqlText = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
  return { client, db };
}

/** A chain double. Bytes are JSON {sender, coinType, legs}; "signing" is the
 *  identity; balance changes are derived from the legs. */
function scriptedChain({ buildError, executeThrows = false, executeFails = false } = {}) {
  const landed = new Map();
  const calls = { execute: 0, simulate: 0 };
  const decode = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
  const observe = (bytes, success = true) => {
    const tx = decode(bytes);
    const total = tx.legs.reduce((s, l) => s + BigInt(l.amountMinor), 0n);
    return {
      digest: createHash('sha256').update(bytes).digest('hex'),
      success,
      error: success ? null : 'MoveAbort in command 0',
      sender: tx.sender,
      balanceChanges: success
        ? [{ coinType: tx.coinType, address: tx.sender, amount: (-total).toString() },
          ...tx.legs.map((l) => ({ coinType: tx.coinType, address: l.address, amount: String(l.amountMinor) }))]
        : [],
    };
  };
  return {
    calls,
    landed,
    encode: (tx) => new TextEncoder().encode(JSON.stringify(tx, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
    deps: {
      async build(input) {
        if (buildError) throw new Error(buildError);
        return new TextEncoder().encode(JSON.stringify({ ...input, legs: input.legs.map((l) => ({ ...l, amountMinor: l.amountMinor.toString() })) }));
      },
      async simulate(bytes) { calls.simulate += 1; return observe(bytes); },
      async execute(bytes) {
        calls.execute += 1;
        const o = observe(bytes, !executeFails);
        landed.set(o.digest, o);
        if (executeThrows) throw new Error('socket hang up');
        return o;
      },
      async read(digest) { return landed.get(digest) ?? null; },
      digestOf: (bytes) => createHash('sha256').update(bytes).digest('hex'),
      senderOf: (bytes) => decode(bytes).sender,
      describeBuildError: (e) => `described: ${e.message}`,
    },
  };
}

async function setup({ kyb = 'REGISTERED', verdict = 'CLEAR', payoutMethod = 'WALLET', fee = FEE, approved = true, chainOpts, anchorFee = false, splashWallet = false } = {}) {
  const { client, db } = await migratedDb();
  await client.exec(`INSERT INTO organizations (id, name, kyb_lifecycle) VALUES ('org_s', 'S Co', '${kyb}')`);
  await client.exec(`INSERT INTO users (id, email, name) VALUES ('u_owner', 'owner@s.test', 'Owner')`);
  await client.exec(`INSERT INTO suppliers (id, org_id, name, country, payout_method, wallet_address, wallet_provider)
    VALUES ('rcpt_w', 'org_s', 'Maria', 'PH', 'WALLET', '${RECIPIENT}', 'SLUSH')`);
  const recipient = {
    id: 'rcpt_w', orgId: 'org_s', name: 'Maria', country: 'PH', bank: '', swift: '', account: '', tier: 'PAYOUT_ONLY',
    kybStatus: 'none', createdVia: 'manual', createdAt: new Date(T0).toISOString(),
    payoutMethod, walletAddress: payoutMethod === 'WALLET' ? RECIPIENT : undefined, walletProvider: 'SLUSH', screeningVerdict: verdict,
  };
  const chain = scriptedChain(chainOpts);
  let now = T0;
  // The approval double: step-up itself is tested in step-up.test.mjs.
  const approvals = { allow: approved, consumed: 0, released: 0 };
  const deps = {
    db,
    chain: chain.deps,
    approval: {
      consume: async () => { if (approvals.allow) approvals.consumed += 1; return approvals.allow; },
      release: async () => { approvals.released += 1; },
    },
    readRecipient: async (orgId, id) => (orgId === 'org_s' && id === 'rcpt_w' ? recipient : null),
    feeAddress: () => fee ?? undefined,
    isSplashWallet: async () => splashWallet,
    anchorFeeOn: () => anchorFee,
    now: () => now,
  };
  return { client, db, deps, chain, approvals, advance: (ms) => { now += ms; } };
}

const quote = (deps, amount = '1000', extra = {}) =>
  quoteWalletTransfer(deps, { orgId: 'org_s', userId: 'u_owner', role: 'OWNER', recipientId: 'rcpt_w', amount, senderAddress: SENDER, ...extra });
const submit = (deps, q, bytes = q.transactionBytes) =>
  submitWalletTransfer(deps, { orgId: 'org_s', role: 'OWNER', outflowId: q.outflowId, transactionBytes: bytes, signature: 'sig' });

test('the happy path: 1,000 USDC to the recipient, no Splash fee, one leg, recorded with its audit hash', async () => {
  const { client, db, deps, chain } = await setup();
  const q = await quote(deps, '1000');
  assert.equal(q.ok, true);
  assert.equal(q.network, 'mainnet');
  assert.equal(q.chain, 'sui:mainnet');
  assert.equal(q.coinType, SUI_USDC_COIN_TYPE.mainnet);
  assert.equal(q.principalMinor, usdc('1000').toString());
  assert.equal(q.feeMinor, '0', 'stablecoin transfers are free');
  assert.equal(q.totalDebitMinor, usdc('1000').toString());
  assert.equal(q.feeKind, 'FREE');
  assert.equal(q.feeAddress, null, 'no fee, no fee leg, no fee address');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromBase64(q.transactionBytes))).legs.map((l) => l.address), [RECIPIENT]);

  const done = await submit(deps, q);
  assert.equal(done.ok, true);
  assert.equal(done.status, 'CONFIRMED');
  assert.match(done.auditHash, /^[0-9a-f]{64}$/);
  assert.equal(done.anchorStatus, 'PENDING_MAINNET_PUBLISH', 'recorded now, anchored once the contracts are on mainnet');
  assert.match(done.explorerUrl, /^https:\/\/suiscan\.xyz\/mainnet\/tx\//);
  assert.equal(chain.calls.simulate, 1, 'dry-run before submitting');
  assert.equal(chain.calls.execute, 1);

  const { allowance } = await readAllowance(db, 'org_s', T0);
  assert.equal(allowance.usedMinor, usdc('1000'), 'the principal counts; the fee does not');
  await client.close();
});

test('a retry after success is answered from the record, never submitted twice', async () => {
  const { client, deps, chain } = await setup();
  const q = await quote(deps);
  await submit(deps, q);
  const again = await submit(deps, q);
  assert.equal(again.status, 'CONFIRMED');
  assert.equal(chain.calls.execute, 1);
  await client.close();
});

test('a lost response: the chain has the transaction, so it is recorded, not re-sent', async () => {
  const { client, deps, chain } = await setup({ chainOpts: { executeThrows: true } });
  const q = await quote(deps);
  const done = await submit(deps, q);
  assert.equal(done.status, 'CONFIRMED');
  assert.equal(chain.calls.execute, 1);
  await client.close();
});

test('a wallet that changed the transaction is caught on the dry run, and nothing moves', async () => {
  const { client, deps, chain } = await setup();
  const q = await quote(deps, '1000');
  const tampered = chain.encode({
    sender: SENDER,
    coinType: SUI_USDC_COIN_TYPE.mainnet,
    legs: [{ address: OTHER, amountMinor: usdc('1000') }],
  });
  const r = await submit(deps, q, toBase64(tampered));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'preflight_mismatch');
  assert.equal(chain.calls.execute, 0, 'never submitted');
  // The honest bytes still go through afterwards: the quote stayed open.
  assert.equal((await submit(deps, q)).status, 'CONFIRMED');
  await client.close();
});

test('bytes signed by a different wallet are refused before anything else', async () => {
  const { client, deps, chain } = await setup();
  const q = await quote(deps);
  const other = chain.encode({ sender: OTHER, coinType: SUI_USDC_COIN_TYPE.mainnet, legs: [] });
  const r = await submit(deps, q, toBase64(other));
  assert.equal(r.code, 'wrong_sender');
  await client.close();
});

test('a quote that lapsed before submission is closed, and nothing is sent', async () => {
  const { client, db, deps, chain, advance } = await setup();
  const q = await quote(deps, '5000');
  advance(RESERVATION_MS + 1);
  const r = await submit(deps, q);
  assert.equal(r.status, 410);
  assert.equal(chain.calls.execute, 0);
  const { allowance } = await readAllowance(db, 'org_s', T0 + RESERVATION_MS + 1);
  assert.equal(allowance.usedMinor, 0n, 'the lapsed reservation no longer counts');
  await client.close();
});

test('a transaction that fails on chain is recorded FAILED and releases the allowance', async () => {
  const { client, db, deps } = await setup({ chainOpts: { executeFails: true } });
  const q = await quote(deps, '5000');
  const r = await submit(deps, q);
  assert.equal(r.code, 'failed_on_chain');
  assert.match(r.error, /gas\) was still charged/);
  const row = (await client.query(`SELECT status, tx_digest FROM stablecoin_outflows WHERE id = '${q.outflowId}'`)).rows[0];
  assert.equal(row.status, 'FAILED');
  assert.ok(row.tx_digest, 'the digest is kept so it can be looked up');
  assert.equal((await readAllowance(db, 'org_s', T0)).allowance.usedMinor, 0n);
  await client.close();
});

test('the unverified cap holds across quotes', async () => {
  const { client, deps } = await setup();
  assert.equal((await quote(deps, '5000')).ok, true);
  const over = await quote(deps, '1');
  assert.equal(over.status, 409);
  assert.match(over.error, /5000\.000000 USDC in any 30 days/);
  assert.equal(over.allowance.remainingMinor, '0');
  await client.close();
});

test('a build failure (no USDC, no gas) releases the reservation it made', async () => {
  const { client, db, deps } = await setup({ chainOpts: { buildError: 'Insufficient balance of USDC' } });
  const r = await quote(deps, '4000');
  assert.equal(r.status, 422);
  assert.match(r.error, /described: Insufficient balance/);
  assert.equal((await readAllowance(db, 'org_s', T0)).allowance.usedMinor, 0n);
  await client.close();
});

test('refusals before any reservation: role, bank recipient, unscreened on mainnet, listed, no fee address, minimum', async () => {
  let s = await setup();
  assert.equal((await quote(s.deps, '10', { role: 'VIEWER' })).code, 'role_cannot_send');
  assert.equal((await quote(s.deps, '10', { role: 'APPROVER' })).code, 'role_cannot_send');
  assert.equal((await quote(s.deps, '0.99')).code, 'below_minimum');
  assert.equal((await quote(s.deps, '10', { senderAddress: RECIPIENT })).code, 'self_transfer');
  assert.equal((await quote(s.deps, '10', { senderAddress: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' })).code, 'invalid_input');
  await s.client.close();

  s = await setup({ payoutMethod: 'BANK' });
  assert.equal((await quote(s.deps)).code, 'not_a_wallet_recipient');
  await s.client.close();

  s = await setup({ verdict: null });
  assert.equal((await quote(s.deps)).code, 'recipient_not_sendable', 'mainnet wants CLEAR or ATTESTED');
  await s.client.close();

  s = await setup({ verdict: 'ATTESTED' });
  assert.equal((await quote(s.deps)).ok, true);
  await s.client.close();

  s = await setup({ verdict: 'BLOCK' });
  assert.equal((await quote(s.deps)).code, 'recipient_not_sendable', 'a listed wallet is refused everywhere');
  await s.client.close();

  // Free transfers need no fee address at all.
  s = await setup({ fee: null });
  assert.equal((await quote(s.deps)).ok, true);
  await s.client.close();

  // With the audit-anchor fee on, a transfer out of Splash needs one.
  s = await setup({ fee: null, anchorFee: true });
  const noFee = await quote(s.deps);
  assert.equal(noFee.code, 'fee_address_missing');
  assert.equal((await readAllowance(s.db, 'org_s', T0)).allowance.usedMinor, 0n, 'nothing reserved');
  await s.client.close();

  s = await setup({ fee: RECIPIENT, anchorFee: true });
  assert.equal((await quote(s.deps)).code, 'fee_address_conflict');
  await s.client.close();
});

test('no approval, no chain: an unapproved transfer is refused before the dry run', async () => {
  const { client, deps, chain } = await setup({ approved: false });
  const q = await quote(deps);
  const r = await submit(deps, q);
  assert.equal(r.status, 428);
  assert.equal(r.code, 'approval_required');
  assert.equal(chain.calls.simulate, 0);
  assert.equal(chain.calls.execute, 0);
  await client.close();
});

test('an approval is handed back when nothing moved, and the quote records who asked', async () => {
  const { client, deps, chain, approvals } = await setup();
  const q = await quote(deps, '1000');
  const row = (await client.query(`SELECT requested_by FROM stablecoin_outflows WHERE id = '${q.outflowId}'`)).rows[0];
  assert.equal(row.requested_by, 'u_owner');
  const tampered = chain.encode({
    sender: SENDER,
    coinType: SUI_USDC_COIN_TYPE.mainnet,
    legs: [{ address: OTHER, amountMinor: usdc('1000') }],
  });
  await submit(deps, q, toBase64(tampered));
  assert.equal(approvals.consumed, 1);
  assert.equal(approvals.released, 1, 'the preflight refused, so the approval is still good');
  await client.close();
});

test('with the audit-anchor fee on, a transfer out of Splash pays it on top, in the same transaction', async () => {
  const { client, deps } = await setup({ anchorFee: true });
  const q = await quote(deps, '1000');
  assert.equal(q.feeMinor, usdc('0.2').toString(), '0.02% of 1,000');
  assert.equal(q.totalDebitMinor, usdc('1000.2').toString());
  assert.equal(q.feeKind, 'AUDIT_ANCHOR');
  assert.equal(q.feeAddress, FEE);
  const legs = JSON.parse(new TextDecoder().decode(fromBase64(q.transactionBytes))).legs;
  assert.deepEqual(legs.map((l) => [l.address, l.amountMinor]), [[RECIPIENT, usdc('1000').toString()], [FEE, usdc('0.2').toString()]]);
  assert.equal((await submit(deps, q)).status, 'CONFIRMED', 'the dry run and the chain check the fee leg too');

  const small = await quote(deps, '10');
  assert.equal(small.feeMinor, usdc('0.05').toString(), 'the 0.05 floor');
  await client.close();
});

test('to a Splash user wallet it stays free, even with the audit-anchor fee on', async () => {
  const { client, deps } = await setup({ anchorFee: true, splashWallet: true });
  const q = await quote(deps, '1000');
  assert.equal(q.feeMinor, '0');
  assert.equal(q.destination, 'SPLASH');
  assert.equal(q.feeAddress, null);
  assert.equal((await submit(deps, q)).status, 'CONFIRMED');
  await client.close();
});

test('a suspended business cannot quote at all', async () => {
  const s = await setup({ kyb: 'SUSPENDED' });
  const r = await quote(s.deps);
  assert.equal(r.status, 409);
  assert.match(r.error, /suspended/);
  await s.client.close();
});

test('the chain reader takes the digest from effects when a dry run has none at the top level', async () => {
  const { observe } = await import('../lib/server/stablecoin-chain.ts');
  const status = { success: true, error: null };
  // Shapes seen on Sui mainnet on 2026-09-25 (scripts/rehearse-usdc-send.mjs).
  const simulated = observe({ $kind: 'Transaction', Transaction: { effects: { transactionDigest: 'DryRunDigest' }, status, balanceChanges: [], transaction: { sender: '0xabc' } } });
  assert.equal(simulated.digest, 'DryRunDigest');
  const executed = observe({ $kind: 'Transaction', Transaction: { digest: 'RealDigest', effects: { transactionDigest: 'RealDigest' }, status, balanceChanges: [] } });
  assert.equal(executed.digest, 'RealDigest');
  const failed = observe({ $kind: 'FailedTransaction', FailedTransaction: { digest: 'F', status: { success: false, error: { message: 'InsufficientCoinBalance' } } } });
  assert.deepEqual([failed.success, failed.error], [false, 'InsufficientCoinBalance']);
});
