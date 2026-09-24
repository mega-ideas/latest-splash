import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import {
  exactUsdc,
  findInvoicePayment,
  invoiceUsdcAmountMinor,
  invoiceUsdcSuffix,
  PAYMENT_CLOCK_TOLERANCE_MS,
  SUFFIX_RANGE,
} from '../lib/payments/usdc-invoice.ts';
import { checkInvoiceUsdcPayment, invoiceUsdcBySlug, invoiceUsdcTerms } from '../lib/server/usdc-invoice-payments.ts';

/**
 * Invoices paid in USDC on Sui, straight to the issuer's own wallet: an exact
 * amount per invoice, matched from chain, recorded once.
 */

const WALLET = `0x${'ab'.repeat(32)}`;
const PAYER = `0x${'cd'.repeat(32)}`;
const T_INVOICE = new Date('2026-09-24T08:00:00Z');

// ─── The amount ─────────────────────────────────────────────────────────────

test('each invoice asks for its own exact amount: the invoice plus 1–997 millionths', () => {
  const a = invoiceUsdcSuffix('inv_a');
  assert.equal(a, invoiceUsdcSuffix('inv_a'), 'the same invoice always asks the same');
  const seen = new Set();
  for (let i = 0; i < 400; i += 1) {
    const s = invoiceUsdcSuffix(`inv_${i}`);
    assert.ok(s >= 1n && s <= SUFFIX_RANGE, `suffix ${s} in range`);
    seen.add(s);
  }
  assert.ok(seen.size > 300, 'different invoices spread across the range');
  assert.equal(invoiceUsdcAmountMinor('inv_a', 1_250_000_000n), 1_250_000_000n + a);
  assert.throws(() => invoiceUsdcAmountMinor('inv_a', 0n), /positive/);
  assert.equal(exactUsdc(1_250_000_417n), '1,250.000417');
  assert.equal(exactUsdc(5_000_001n), '5.000001');
});

// ─── The match ──────────────────────────────────────────────────────────────

const move = (digest, amountMinor, at, overrides = {}) => ({
  digest, amountMinor, timestamp: at, success: true, direction: 'IN', counterparty: PAYER, ...overrides,
});

test('only money in, of exactly the amount, that succeeded, after the invoice existed', () => {
  const expected = 1_250_000_417n;
  const after = '2026-09-24T09:00:00Z';
  assert.equal(findInvoicePayment([move('ok', expected, after)], expected, T_INVOICE).digest, 'ok');
  for (const miss of [
    move('out', expected, after, { direction: 'OUT' }),
    move('failed', expected, after, { success: false }),
    move('short', expected - 1n, after),
    move('over', expected + 1n, after),
    move('before', expected, new Date(T_INVOICE.getTime() - PAYMENT_CLOCK_TOLERANCE_MS - 1000).toISOString()),
    move('undated', expected, null),
  ]) {
    assert.equal(findInvoicePayment([miss], expected, T_INVOICE), null, miss.digest);
  }
  // Paid twice by mistake: the first one paid it.
  const twice = findInvoicePayment([move('second', expected, '2026-09-24T10:00:00Z'), move('first', expected, after)], expected, T_INVOICE);
  assert.equal(twice.digest, 'first');
});

// ─── Recorded once, against a real database ─────────────────────────────────

async function world({ passkey = true } = {}) {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const files = (await readdir(new URL('../drizzle', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const text = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) {
      if (statement.trim()) await client.exec(statement.trim());
    }
  }
  await client.exec(`
    INSERT INTO organizations (id, name) VALUES ('org_a', 'A Co');
    INSERT INTO users (id, email, name) VALUES ('u_ceo', 'ceo@a.test', 'Aisha CEO'), ('u_admin2', 'admin2@a.test', 'Second Admin');
    INSERT INTO memberships (id, user_id, org_id, role, created_at) VALUES
      ('m1', 'u_ceo', 'org_a', 'admin', '2026-01-01T00:00:00Z'),
      ('m2', 'u_admin2', 'org_a', 'admin', '2026-02-01T00:00:00Z');
    INSERT INTO invoices (id, org_id, issuer_org, amount_minor, currency, target_currency, status, pay_link_slug, created_at) VALUES
      ('inv_1', 'org_a', 'A Co', 1250000000, 'USD', 'PHP', 'sent', 'slug-one', '${T_INVOICE.toISOString()}'),
      ('inv_2', 'org_a', 'A Co', 1250000000, 'USD', 'PHP', 'sent', 'slug-two', '${T_INVOICE.toISOString()}');
  `);
  if (passkey) {
    await client.exec(`INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, sui_address, rp_id)
      VALUES ('pk_ceo', 'u_ceo', 'cred-ceo', 'AAAA', '${WALLET}', 'localhost');`);
  }
  return { client, db };
}

const page = (movements) => async () => ({ available: true, movements, olderCursor: null });

test('the main admin’s Splash wallet receives, and the payment is recorded once', async () => {
  const { client, db } = await world();
  const row = await invoiceUsdcBySlug(db, 'slug-one');
  const terms = await invoiceUsdcTerms(db, row, 'localhost');
  assert.equal(terms.address, WALLET);
  assert.equal(terms.amountMinor, invoiceUsdcAmountMinor('inv_1', 1_250_000_000n));

  let reads = 0;
  const read = async () => {
    reads += 1;
    return { available: true, olderCursor: null, movements: [move('DIGEST_1', terms.amountMinor, '2026-09-24T09:00:00Z')] };
  };
  const first = await checkInvoiceUsdcPayment(db, row, { rpId: 'localhost', read, now: () => new Date('2026-09-24T09:01:00Z') });
  assert.equal(first.status, 'PAID');
  assert.equal(first.digest, 'DIGEST_1');
  assert.equal(first.payer, PAYER);

  const after = await invoiceUsdcBySlug(db, 'slug-one');
  assert.equal(after.status, 'paid');
  assert.equal(after.usdcTxDigest, 'DIGEST_1');
  assert.equal(after.usdcPayerAddress, PAYER);

  // Checking again reports the recorded payment without reading the chain.
  const again = await checkInvoiceUsdcPayment(db, after, { rpId: 'localhost', read });
  assert.equal(again.status, 'PAID');
  assert.equal(reads, 1);
  await client.close();
});

test('one transaction cannot pay two invoices', async () => {
  const { client, db } = await world();
  const one = await invoiceUsdcBySlug(db, 'slug-one');
  const two = await invoiceUsdcBySlug(db, 'slug-two');
  const amountOne = invoiceUsdcAmountMinor('inv_1', 1_250_000_000n);
  const amountTwo = invoiceUsdcAmountMinor('inv_2', 1_250_000_000n);
  await checkInvoiceUsdcPayment(db, one, { rpId: 'localhost', read: page([move('SHARED', amountOne, '2026-09-24T09:00:00Z')]) });
  // A (contrived) chain answer that offers the same transaction for invoice two.
  const reuse = await checkInvoiceUsdcPayment(db, two, { rpId: 'localhost', read: page([move('SHARED', amountTwo, '2026-09-24T09:00:00Z')]) });
  assert.equal(reuse.status, 'ALREADY_USED');
  assert.equal((await invoiceUsdcBySlug(db, 'slug-two')).usdcTxDigest, null);
  await client.close();
});

test('not seen, no wallet, and an indexer that does not answer are all said plainly', async () => {
  const { client, db } = await world();
  const row = await invoiceUsdcBySlug(db, 'slug-one');
  const notSeen = await checkInvoiceUsdcPayment(db, row, { rpId: 'localhost', read: page([move('close', invoiceUsdcAmountMinor('inv_1', 1_250_000_000n) - 1n, '2026-09-24T09:00:00Z')]) });
  assert.equal(notSeen.status, 'NOT_SEEN');
  assert.equal(notSeen.address, WALLET);
  const down = await checkInvoiceUsdcPayment(db, row, { rpId: 'localhost', read: async () => ({ available: false, reason: 'indexer down' }) });
  assert.deepEqual(down, { status: 'UNAVAILABLE', reason: 'indexer down' });
  assert.equal((await invoiceUsdcBySlug(db, 'slug-one')).status, 'sent', 'nothing recorded');
  await client.close();

  const noWallet = await world({ passkey: false });
  const bare = await invoiceUsdcBySlug(noWallet.db, 'slug-one');
  assert.equal(await invoiceUsdcTerms(noWallet.db, bare, 'localhost'), null);
  const result = await checkInvoiceUsdcPayment(noWallet.db, bare, { rpId: 'localhost', read: async () => { throw new Error('must not read'); } });
  assert.equal(result.status, 'NO_WALLET');
  await noWallet.client.close();
});

test('a recorded payment must say when', async () => {
  const { client } = await world();
  await assert.rejects(
    () => client.exec(`UPDATE invoices SET usdc_tx_digest = 'X' WHERE id = 'inv_1'`),
    /invoices_usdc_paid_check/,
  );
  await client.close();
});

// ─── The pay link ───────────────────────────────────────────────────────────

function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

test('the payer’s check is limited by network before anything is looked up, and moves nothing', async () => {
  const route = code(await readFile(new URL('../app/api/pay/[slug]/usdc/route.ts', import.meta.url), 'utf8'));
  const limit = route.indexOf('enforceRateLimit(');
  const lookup = route.indexOf('invoiceUsdcBySlug(');
  assert.ok(limit > 0 && lookup > limit);
  assert.match(route, /RATE_LIMITS\.payLinkUsdcIp/);
  const lib = code(await readFile(new URL('../lib/server/usdc-invoice-payments.ts', import.meta.url), 'utf8'));
  for (const forbidden of ['signWith', 'executeTransfer', 'reserveOutflow', 'buildTransferBytes']) {
    assert.doesNotMatch(lib, new RegExp(forbidden), forbidden);
  }
});

test('the pay page and its API show the same USDC terms', async () => {
  const page = code(await readFile(new URL('../app/pay/[slug]/page.tsx', import.meta.url), 'utf8'));
  const api = code(await readFile(new URL('../app/api/pay/[slug]/route.ts', import.meta.url), 'utf8'));
  assert.match(page, /publicUsdcForSlug\(slug\)/);
  assert.match(api, /publicUsdcForSlug\(slug\)/);
  const ui = await readFile(new URL('../components/pay/PayWithUsdc.tsx', import.meta.url), 'utf8');
  assert.match(ui, /Send exactly/);
  assert.match(ui, /Splash never holds it/);
});
