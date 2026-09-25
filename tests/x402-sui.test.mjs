import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { toBase64 } from '@mysten/sui/utils';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import { parseUsdcMinor, SUI_USDC_COIN_TYPE } from '../lib/payments/stablecoin-lane.ts';
import {
  encodeHeader,
  parsePaymentRequired,
  parseSettlement,
  paymentHeader,
  selectSuiRequirement,
} from '../lib/payments/x402-sui.ts';
import { assertPublicUrl, isPrivateAddress, UnsafeUrlError } from '../lib/server/safe-fetch.ts';
import { readAllowance, reserveOutflow } from '../lib/server/stablecoin-outflows.ts';
import { payX402, quoteX402 } from '../lib/server/x402-pay.ts';

/**
 * x402 on Sui mainnet: the protocol, the fetch guard, and a full quote → pay
 * against real migrations, a scripted seller and a scripted chain.
 */

const USDC = SUI_USDC_COIN_TYPE.mainnet;
const PAYTO = `0x${'5e'.repeat(32)}`;
const BUYER = `0x${'b0'.repeat(32)}`;
const URL_ = 'https://seller.example/api/data';
const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);

const requiredV2 = (overrides = {}) => ({
  x402Version: 2,
  resource: { url: URL_, description: 'Data', mimeType: 'application/json' },
  accepts: [{ scheme: 'exact', network: 'sui:mainnet', amount: '10000', asset: USDC, payTo: PAYTO, maxTimeoutSeconds: 60, extra: {}, ...overrides }],
});

// ─── Protocol ───────────────────────────────────────────────────────────────

test('a v2 challenge in the PAYMENT-REQUIRED header and a v1 challenge in the body both parse', () => {
  const v2 = parsePaymentRequired({ header: encodeHeader(requiredV2()) }, URL_);
  assert.equal(v2.x402Version, 2);
  assert.equal(v2.accepts[0].amountMinor, 10000n);
  assert.equal(v2.resource.url, URL_);

  const v1 = parsePaymentRequired({ body: { x402Version: 1, accepts: [{ scheme: 'exact', network: 'sui:mainnet', maxAmountRequired: '250', asset: USDC, payTo: PAYTO, resource: URL_ }] } }, URL_);
  assert.equal(v1.accepts[0].amountMinor, 250n);
  assert.throws(() => parsePaymentRequired({ body: { x402Version: 2, accepts: [{ amount: '0.01' }] } }, URL_), /integer base units/);
  assert.throws(() => parsePaymentRequired({ body: { hello: 'world' } }, URL_), /not an x402/);
});

test('only exact, sui:mainnet, native USDC is payable; anything else is described and refused', () => {
  const ok = selectSuiRequirement(parsePaymentRequired({ header: encodeHeader(requiredV2()) }, URL_));
  assert.equal(ok.ok, true);
  assert.equal(ok.payTo, PAYTO);

  const evm = selectSuiRequirement(parsePaymentRequired({ body: requiredV2({ network: 'base', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }) }, URL_));
  assert.equal(evm.ok, false);
  assert.match(evm.reason, /offers: base \(exact\)/);
  assert.match(evm.reason, /not payable from a Sui wallet/);

  const sui = selectSuiRequirement(parsePaymentRequired({ body: requiredV2({ asset: '0x2::sui::SUI' }) }, URL_));
  assert.equal(sui.ok, false, 'SUI is not USDC');
  const testnet = selectSuiRequirement(parsePaymentRequired({ body: requiredV2({ network: 'sui:testnet' }) }, URL_));
  assert.equal(testnet.ok, false, 'mainnet only');
});

test('the payment header echoes the accepted requirement verbatim; settlements decode', () => {
  const pr = parsePaymentRequired({ header: encodeHeader(requiredV2()) }, URL_);
  const h = paymentHeader(pr, pr.accepts[0], { transaction: 'dHg=', signature: 'c2ln' });
  assert.equal(h.name, 'PAYMENT-SIGNATURE');
  const decoded = JSON.parse(Buffer.from(h.value, 'base64').toString());
  assert.equal(decoded.x402Version, 2);
  assert.deepEqual(decoded.accepted, pr.accepts[0].raw);
  assert.deepEqual(decoded.payload, { signature: 'c2ln', transaction: 'dHg=' });

  const s = parseSettlement(encodeHeader({ success: true, transaction: 'DIG', network: 'sui:mainnet', payer: BUYER }));
  assert.equal(s.success, true);
  assert.equal(s.transaction, 'DIG');
  assert.equal(parseSettlement('%%%'), null);
});

// ─── The fetch guard ────────────────────────────────────────────────────────

test('private, loopback, link-local and metadata addresses are refused', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  assert.equal(isPrivateAddress('93.184.216.34'), false);

  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const privateLookup = async () => [{ address: '10.0.0.5', family: 4 }];
  await assert.doesNotReject(() => assertPublicUrl('https://seller.example/x', { lookup: publicLookup, allowLocalHttp: false }));
  await assert.rejects(() => assertPublicUrl('https://internal.example/x', { lookup: privateLookup, allowLocalHttp: false }), UnsafeUrlError);
  await assert.rejects(() => assertPublicUrl('http://seller.example/x', { lookup: publicLookup, allowLocalHttp: false }), /Only https/);
  await assert.rejects(() => assertPublicUrl('https://169.254.169.254/latest/meta-data', { allowLocalHttp: false }), UnsafeUrlError);
  await assert.rejects(() => assertPublicUrl('https://user:pw@seller.example/x', { lookup: publicLookup, allowLocalHttp: false }), /credentials/);
  await assert.rejects(() => assertPublicUrl('http://localhost:3000/x', { allowLocalHttp: false }), /Only https/, 'localhost only outside production');
  await assert.doesNotReject(() => assertPublicUrl('http://localhost:3000/x', { allowLocalHttp: true }));
});

// ─── Quote → pay ────────────────────────────────────────────────────────────

async function world({ verdict = 'CLEAR', sellerOffer = requiredV2(), sellerOk = true } = {}) {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  for (const file of (await readdir(new URL('../drizzle', import.meta.url))).filter((f) => f.endsWith('.sql')).sort()) {
    const text = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const s of text.split('--> statement-breakpoint')) if (s.trim()) await client.exec(s.trim());
  }
  await client.exec(`INSERT INTO organizations (id, name) VALUES ('org_x', 'X Co'); INSERT INTO users (id, email, name) VALUES ('u_x', 'x@x.test', 'X');`);

  const landed = new Map();
  const calls = { sellerPaid: 0, consumed: 0, released: 0 };
  const decode = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
  const observe = (bytes) => {
    const tx = decode(bytes);
    const total = tx.legs.reduce((s, l) => s + BigInt(l.amountMinor), 0n);
    return {
      digest: createHash('sha256').update(bytes).digest('hex'),
      success: true,
      sender: tx.sender,
      balanceChanges: [{ coinType: tx.coinType, address: tx.sender, amount: (-total).toString() }, ...tx.legs.map((l) => ({ coinType: tx.coinType, address: l.address, amount: String(l.amountMinor) }))],
    };
  };
  const state = { offer: sellerOffer, sellerOk, approved: true };
  const headers = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
  const deps = {
    db,
    now: () => T0,
    sleep: async () => {},
    approval: {
      consume: async () => { if (state.approved) calls.consumed += 1; return state.approved; },
      release: async () => { calls.released += 1; },
    },
    screen: async () => ({ verdict, reference: null, screenedAt: null, detail: '' }),
    get: async (_url, init) => {
      const sig = init?.headers?.['PAYMENT-SIGNATURE'];
      if (!sig) return { status: 402, headers: headers({ 'payment-required': encodeHeader(state.offer) }), body: '', truncated: false };
      calls.sellerPaid += 1;
      if (!state.sellerOk) return { status: 402, headers: headers({ 'payment-response': encodeHeader({ success: false, errorReason: 'insufficient_funds', transaction: '', network: 'sui:mainnet' }) }), body: '', truncated: false };
      const payload = JSON.parse(Buffer.from(sig, 'base64').toString());
      const bytes = Buffer.from(payload.payload.transaction, 'base64');
      const o = observe(bytes);
      landed.set(o.digest, o); // the facilitator broadcast it
      return { status: 200, headers: headers({ 'content-type': 'application/json', 'payment-response': encodeHeader({ success: true, transaction: o.digest, network: 'sui:mainnet', payer: BUYER }) }), body: '{"data":42}', truncated: false };
    },
    chain: {
      build: async (input) => new TextEncoder().encode(JSON.stringify({ ...input, legs: input.legs.map((l) => ({ ...l, amountMinor: l.amountMinor.toString() })) })),
      simulate: async (bytes) => observe(bytes),
      execute: async () => { throw new Error('x402 never executes through Splash'); },
      read: async (digest) => landed.get(digest) ?? null,
      digestOf: (bytes) => createHash('sha256').update(bytes).digest('hex'),
      senderOf: (bytes) => decode(bytes).sender,
      describeBuildError: (e) => e.message,
    },
  };
  return { client, db, deps, calls, state, landed };
}

const quote = (deps, extra = {}) => quoteX402(deps, { orgId: 'org_x', userId: 'u_x', role: 'OWNER', url: URL_, senderAddress: BUYER, ...extra });
const pay = (deps, q, bytes = q.transactionBytes) => payX402(deps, { orgId: 'org_x', role: 'OWNER', outflowId: q.outflowId, transactionBytes: bytes, signature: 'sig' });

test('an x402 payment: reserved with no fee, sent to the seller, confirmed from the chain, content returned', async () => {
  const w = await world();
  const q = await quote(w.deps);
  assert.equal(q.ok, true);
  assert.equal(q.amountMinor, '10000');
  // Never gasless: the seller's facilitator broadcasts a coin transfer the buyer pays gas for.
  assert.equal(q.gas, 'SENDER_PAYS');
  assert.equal(JSON.parse(Buffer.from(q.transactionBytes, 'base64').toString()).gas, 'SENDER_PAYS');
  const row = (await w.client.query(`SELECT kind, fee_minor, resource, requested_by FROM stablecoin_outflows WHERE id = '${q.outflowId}'`)).rows[0];
  assert.equal(row.kind, 'X402');
  assert.equal(Number(row.fee_minor), 0, 'no Splash fee on x402');
  assert.equal(row.resource, URL_);

  const r = await pay(w.deps, q);
  assert.equal(r.status, 'CONFIRMED');
  assert.equal(r.content.body, '{"data":42}');
  assert.equal(r.sellerDigestMatches, true);
  assert.match(r.auditHash, /^[0-9a-f]{64}$/);
  assert.equal(w.calls.sellerPaid, 1);
  const { allowance } = await readAllowance(w.db, 'org_x', T0);
  assert.equal(allowance.usedMinor, 10000n);
  await w.client.close();
});

test('x402 and wallet transfers share one allowance', async () => {
  const w = await world({ sellerOffer: requiredV2({ amount: parseUsdcMinor('2').toString() }) });
  await reserveOutflow(w.db, {
    orgId: 'org_x', kind: 'TRANSFER', supplierId: null, coinType: USDC,
    principalMinor: parseUsdcMinor('4999'), feeMinor: 0n, senderAddress: BUYER, recipientAddress: PAYTO, feeAddress: null, nowMs: T0,
  });
  const q = await quote(w.deps);
  assert.equal(q.status, 409);
  assert.match(q.error, /5000\.000000 USDC in any 30 days/);
  await w.client.close();
});

test('a seller that changed its price after approval is not paid, and the approval is handed back', async () => {
  const w = await world();
  const q = await quote(w.deps);
  w.state.offer = requiredV2({ amount: '20000' });
  const r = await pay(w.deps, q);
  assert.equal(r.code, 'seller_changed');
  assert.equal(w.calls.sellerPaid, 0, 'nothing was sent to the seller');
  assert.equal(w.calls.released, 1);
  await w.client.close();
});

test('a refusing seller: nothing lands, the quote is FAILED with the digest kept', async () => {
  const w = await world({ sellerOk: false });
  const q = await quote(w.deps);
  const r = await pay(w.deps, q);
  assert.equal(r.code, 'seller_refused');
  assert.match(r.error, /insufficient_funds/);
  const row = (await w.client.query(`SELECT status, tx_digest FROM stablecoin_outflows WHERE id = '${q.outflowId}'`)).rows[0];
  assert.equal(row.status, 'FAILED');
  assert.ok(row.tx_digest);
  await w.client.close();
});

test('once a signed payment has gone to the seller, a differently-signed one is refused', async () => {
  const w = await world();
  const q = await quote(w.deps);
  // The seller takes the first payment but the facilitator is slow: nothing lands yet.
  const realGet = w.deps.get;
  w.deps.get = async (url, init) => {
    const res = await realGet(url, init);
    w.landed.clear();
    return res;
  };
  const first = await pay(w.deps, q);
  assert.equal(first.status, 'SETTLING');

  const other = new TextEncoder().encode(JSON.stringify({ sender: BUYER, coinType: USDC, legs: [{ address: PAYTO, amountMinor: '10000' }], nonce: 2 }));
  const second = await pay(w.deps, q, toBase64(other));
  assert.equal(second.code, 'already_sent', 'a second signature for the same payment could pay twice');
  await w.client.close();
});

test('resending the SAME signed payment needs no second approval', async () => {
  const w = await world();
  const q = await quote(w.deps);
  const realGet = w.deps.get;
  let slow = true;
  w.deps.get = async (url, init) => {
    const res = await realGet(url, init);
    if (slow) w.landed.clear();
    return res;
  };
  assert.equal((await pay(w.deps, q)).status, 'SETTLING');
  slow = false;
  w.state.approved = false; // no approval left to spend
  const again = await pay(w.deps, q);
  assert.equal(again.status, 'CONFIRMED');
  await w.client.close();
});

test('quote refusals: EVM-only seller, unscreened payee without an admin attestation, listed payee', async () => {
  let w = await world({ sellerOffer: requiredV2({ network: 'base', asset: '0xabc' }) });
  assert.equal((await quote(w.deps)).code, 'not_payable');
  await w.client.close();

  w = await world({ verdict: null });
  assert.equal((await quote(w.deps)).code, 'payee_unscreened');
  assert.equal((await quote(w.deps, { attestPayee: true, role: 'MAKER' })).code, 'not_admin');
  assert.equal((await quote(w.deps, { attestPayee: true })).ok, true);
  await w.client.close();

  w = await world({ verdict: 'BLOCK' });
  assert.equal((await quote(w.deps)).code, 'payee_blocked');
  await w.client.close();
});

test('a dry run the node refuses or does not answer: nothing is paid and the approval goes back', async () => {
  const w = await world();
  const q = await quote(w.deps);
  w.deps.chain.simulate = async () => { throw new Error('Too Many Requests'); };
  w.deps.chain.isTransient = (e) => /too many requests/i.test(e.message);
  let r = await pay(w.deps, q);
  assert.equal(r.code, 'chain_busy');
  assert.equal(w.calls.sellerPaid, 0);
  assert.equal(w.calls.released, 1);

  w.deps.chain.simulate = async () => { throw new Error('Error checking transaction input objects: denied'); };
  r = await pay(w.deps, q);
  assert.equal(r.code, 'preflight_refused');
  assert.equal(w.calls.sellerPaid, 0);
  assert.equal(w.calls.released, 2);
  await w.client.close();
});
