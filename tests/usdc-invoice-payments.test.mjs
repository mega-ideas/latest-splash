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
import { checkInvoiceUsdcPayment, invoiceUsdcBySlug, invoiceUsdcTerms, syncOrgInvoiceUsdcPayments } from '../lib/server/usdc-invoice-payments.ts';
import { loadActivityLabels } from '../lib/server/usdc-records.ts';
import { labelMovements } from '../lib/server/wallet-activity.ts';

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

// ─── The issuer's side: every open invoice, one read ───────────────────────

test('the issuer syncs every open invoice against one read of its wallet', async () => {
  const { client, db } = await world();
  await client.exec(`
    INSERT INTO invoices (id, org_id, issuer_org, payer_name, amount_minor, currency, target_currency, status, pay_link_slug, created_at) VALUES
      ('inv_bank', 'org_a', 'A Co', 'Bank Payer', 1250000000, 'USD', 'PHP', 'paid', 'slug-bank', '${T_INVOICE.toISOString()}');
    UPDATE invoices SET payer_name = 'Cebu Traders' WHERE id = 'inv_2';
  `);
  const one = invoiceUsdcAmountMinor('inv_1', 1_250_000_000n);
  const two = invoiceUsdcAmountMinor('inv_2', 1_250_000_000n);
  const bank = invoiceUsdcAmountMinor('inv_bank', 1_250_000_000n);
  let reads = 0;
  const read = async () => {
    reads += 1;
    return {
      available: true,
      olderCursor: null,
      movements: [
        move('PAYS_TWO', two, '2026-09-24T09:00:00Z'),
        move('PAYS_ONE', one, '2026-09-24T09:05:00Z'),
        move('PAYS_BANK', bank, '2026-09-24T09:06:00Z'),
      ],
    };
  };
  const result = await syncOrgInvoiceUsdcPayments(db, 'org_a', { rpId: 'localhost', read });
  assert.equal(result.status, 'SYNCED');
  assert.equal(reads, 1, 'one read of the wallet for all of them');
  assert.equal(result.checked, 2, 'an invoice already marked paid by bank is not re-matched');
  assert.deepEqual(result.paid.map((p) => `${p.invoiceId}:${p.digest}`).sort(), ['inv_1:PAYS_ONE', 'inv_2:PAYS_TWO']);
  assert.equal((await invoiceUsdcBySlug(db, 'slug-bank')).usdcTxDigest, null);

  // Nothing left open: a second sync checks nothing and reads nothing.
  const again = await syncOrgInvoiceUsdcPayments(db, 'org_a', { rpId: 'localhost', read });
  assert.deepEqual(again, { status: 'SYNCED', checked: 0, paid: [], alreadyUsed: [] });
  assert.equal(reads, 1);

  // Wallet activity now names the deposits.
  const labels = await loadActivityLabels(db, 'org_a', ['PAYS_TWO', 'PAYS_ONE', 'UNRELATED']);
  assert.deepEqual(labels.invoicesByDigest.get('PAYS_TWO'), { invoiceId: 'inv_2', payerName: 'Cebu Traders' });
  assert.equal(labels.invoicesByDigest.has('UNRELATED'), false);
  const [named] = labelMovements(
    [{ digest: 'PAYS_TWO', timestamp: '2026-09-24T09:00:00Z', success: true, direction: 'IN', amountMinor: two, counterparty: PAYER }],
    new Map(),
    new Map(),
    { splashWallet: true, invoicesByDigest: labels.invoicesByDigest },
  );
  assert.equal(named.label, 'Invoice inv_2 paid by Cebu Traders');
  await client.close();
});

test('the issuer sync reads nothing without a wallet, and records nothing when Sui does not answer', async () => {
  const bare = await world({ passkey: false });
  const none = await syncOrgInvoiceUsdcPayments(bare.db, 'org_a', { rpId: 'localhost', read: async () => { throw new Error('must not read'); } });
  assert.deepEqual(none, { status: 'NO_WALLET' });
  await bare.client.close();

  const { client, db } = await world();
  const down = await syncOrgInvoiceUsdcPayments(db, 'org_a', { rpId: 'localhost', read: async () => ({ available: false, reason: 'indexer down' }) });
  assert.deepEqual(down, { status: 'UNAVAILABLE', reason: 'indexer down' });
  assert.equal((await invoiceUsdcBySlug(db, 'slug-one')).usdcTxDigest, null);
  await client.close();
});

test('the sync route is signed in, rate limited, and scoped to the session’s workspace', async () => {
  const route = code(await readFile(new URL('../app/api/invoices/usdc-sync/route.ts', import.meta.url), 'utf8'));
  assert.match(route, /requireCustomerRequest\(request\)/);
  assert.match(route, /RATE_LIMITS\.invoiceUsdcSyncUser/);
  assert.match(route, /syncOrgInvoiceUsdcPayments\(getDb\(\), accountCheck\.account\.orgId/);
});

// ─── Review fixes ───────────────────────────────────────────────────────────

test('the wallet a payer was shown is pinned, so a later passkey change cannot strand the payment', async () => {
  const { client, db } = await world();
  const row = await invoiceUsdcBySlug(db, 'slug-one');
  assert.equal((await invoiceUsdcTerms(db, row, 'localhost')).address, WALLET);
  assert.equal((await invoiceUsdcBySlug(db, 'slug-one')).usdcReceiveAddress, WALLET);
  // The main admin re-enrols with a new passkey: a new address.
  const NEW = `0x${'ef'.repeat(32)}`;
  await client.exec(`UPDATE passkey_credentials SET sui_address = '${NEW}' WHERE id = 'pk_ceo'`);
  const again = await invoiceUsdcBySlug(db, 'slug-one');
  assert.equal((await invoiceUsdcTerms(db, again, 'localhost')).address, WALLET, 'still the wallet the payer saw');
  const checked = [];
  await checkInvoiceUsdcPayment(db, again, { rpId: 'localhost', read: async (address) => { checked.push(address); return { available: true, movements: [], olderCursor: null }; } });
  assert.deepEqual(checked, [WALLET], 'and that is the wallet checked');
  await client.close();
});

test('a payment older than the newest page is still found, and paging stops once past the invoice', async () => {
  const { client, db } = await world();
  const row = await invoiceUsdcBySlug(db, 'slug-one');
  const amount = invoiceUsdcAmountMinor('inv_1', 1_250_000_000n);
  const befores = [];
  const read = async (_address, before) => {
    befores.push(before ?? null);
    if (!before) return { available: true, movements: [move('RECENT', 1n, '2026-09-25T00:00:00Z')], olderCursor: 'older' };
    return { available: true, movements: [move('OLDER_PAYMENT', amount, '2026-09-24T09:00:00Z'), move('ANCIENT', 1n, '2026-09-01T00:00:00Z')], olderCursor: 'even-older' };
  };
  const result = await checkInvoiceUsdcPayment(db, row, { rpId: 'localhost', read });
  assert.equal(result.status, 'PAID');
  assert.equal(result.digest, 'OLDER_PAYMENT');
  assert.deepEqual(befores, [null, 'older'], 'stops once the page reaches before the invoice');
  await client.close();
});

test('an invoice already reported paid is not offered in USDC, and the copied amount is plain', async () => {
  const lib = code(await readFile(new URL('../lib/server/usdc-invoice-payments.ts', import.meta.url), 'utf8'));
  assert.match(lib, /if \(row\.status === 'paid' \|\| row\.status === 'settled'\) return null;/);
  assert.match(lib, /amountPlain: plainUsdc\(terms\.amountMinor\)/);
  const ui = code(await readFile(new URL('../components/pay/PayWithUsdc.tsx', import.meta.url), 'utf8'));
  assert.match(ui, /copy\(usdc\.terms!\.amountPlain, 'Amount'\)/);
  assert.doesNotMatch(ui, /copy\(usdc\.terms!\.amount, /);
});

test('your own sends from another workspace are not flagged as missing a record', async () => {
  const { client, db } = await world();
  const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
  await client.exec(`
    INSERT INTO organizations (id, name) VALUES ('org_b', 'B Co');
    INSERT INTO stablecoin_outflows (id, org_id, kind, network, coin_type, principal_minor, fee_minor, sender_address, recipient_address, status, reserved_until, tx_digest, anchor_status, audit_hash, confirmed_at)
    VALUES ('sco_b', 'org_b', 'TRANSFER', 'mainnet', '${USDC}', 5000000, 40000, '${WALLET}', '${PAYER}', 'CONFIRMED', now(), 'SENT_IN_B', 'PENDING_MAINNET_PUBLISH', '${'ab'.repeat(32)}', now()),
           ('sco_x', 'org_b', 'TRANSFER', 'mainnet', '${USDC}', 5000000, 40000, '${PAYER}', '${WALLET}', 'CONFIRMED', now(), 'SOMEONE_ELSE', 'PENDING_MAINNET_PUBLISH', '${'cd'.repeat(32)}', now());
  `);
  const own = await loadActivityLabels(db, 'org_a', ['SENT_IN_B', 'SOMEONE_ELSE'], WALLET);
  assert.deepEqual([...own.elsewhereDigests], ['SENT_IN_B'], 'only sends from this wallet');
  const viewingOther = await loadActivityLabels(db, 'org_a', ['SENT_IN_B'], null);
  assert.equal(viewingOther.elsewhereDigests.size, 0, 'nothing revealed about a wallet that is not yours');
  const [m] = labelMovements(
    [{ digest: 'SENT_IN_B', timestamp: '2026-09-24T09:00:00Z', success: true, direction: 'OUT', amountMinor: 5_040_000n, counterparty: PAYER }],
    new Map(), new Map(), { splashWallet: true, elsewhereDigests: own.elsewhereDigests },
  );
  assert.equal(m.origin, 'SPLASH');
  assert.equal(m.label, 'Sent with Splash from another workspace');
  await client.close();
});

test('treasury quotes are rate limited, since each one calls the Sui route finder', async () => {
  const route = code(await readFile(new URL('../app/api/stablecoin/treasury-quote/route.ts', import.meta.url), 'utf8'));
  assert.match(route, /enforceRateLimit\(\{ rule: RATE_LIMITS\.treasuryQuoteUser/);
});
