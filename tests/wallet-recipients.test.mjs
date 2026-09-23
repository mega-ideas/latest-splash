import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';

import { attestation, screenWalletAddress, walletSendable } from '../lib/server/wallet-screening.ts';

/**
 * Wallet recipients: screened before they are saved, refused outright when
 * listed, and impossible to store malformed — at the route and in the table.
 */

const ADDRESS = `0x${'ab'.repeat(32)}`;
const NOW = new Date('2026-09-24T12:00:00Z');

function fakeFetch(respond) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetcher, calls };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// ─── Screening ──────────────────────────────────────────────────────────────

test('a listed address is BLOCK, an unlisted one CLEAR — and the key travels as a header, not in the URL', async () => {
  const listed = fakeFetch(() => json(200, { identifications: [{ category: 'sanctions', name: 'SANCTIONS: OFAC SDN' }] }));
  const hit = await screenWalletAddress(ADDRESS, { apiKey: 'test-key-123', fetcher: listed.fetcher, now: NOW });
  assert.equal(hit.verdict, 'BLOCK');
  assert.match(hit.detail, /OFAC SDN/);
  assert.equal(listed.calls[0].url, `https://public.chainalysis.com/api/v1/address/${ADDRESS}`);
  assert.equal(listed.calls[0].init.headers['X-API-Key'], 'test-key-123');
  assert.equal(listed.calls[0].url.includes('test-key-123'), false);

  const clean = fakeFetch(() => json(200, { identifications: [] }));
  const ok = await screenWalletAddress(ADDRESS, { apiKey: 'test-key-123', fetcher: clean.fetcher, now: NOW });
  assert.equal(ok.verdict, 'CLEAR');
  assert.equal(ok.screenedAt.toISOString(), NOW.toISOString());
});

test('a provider failure is ERROR, never CLEAR', async () => {
  const down = fakeFetch(() => json(503, {}));
  assert.equal((await screenWalletAddress(ADDRESS, { apiKey: 'k-12345678', fetcher: down.fetcher })).verdict, 'ERROR');
  const broken = fakeFetch(() => { throw new Error('ECONNRESET'); });
  const r = await screenWalletAddress(ADDRESS, { apiKey: 'k-12345678', fetcher: broken.fetcher });
  assert.equal(r.verdict, 'ERROR');
  assert.match(r.detail, /unreachable/);
});

test('without a key the address is unscreened (null) — and nothing is fetched', async () => {
  const spy = fakeFetch(() => json(200, { identifications: [] }));
  const r = await screenWalletAddress(ADDRESS, { apiKey: null, fetcher: spy.fetcher });
  assert.equal(r.verdict, null);
  assert.equal(spy.calls.length, 0);
});

test('an attestation names who vouched and when', () => {
  const a = attestation('user_42', NOW);
  assert.equal(a.verdict, 'ATTESTED');
  assert.equal(a.reference, `operator-attested:user_42:${NOW.toISOString()}`);
});

test('what may be paid (mainnet, always): CLEAR or ATTESTED; never BLOCK, ERROR or unscreened', () => {
  assert.equal(walletSendable('BLOCK').ok, false);
  assert.equal(walletSendable('CLEAR').ok, true);
  assert.equal(walletSendable('ATTESTED').ok, true);
  assert.equal(walletSendable('ERROR').ok, false);
  assert.match(walletSendable('ERROR').reason, /Re-save the recipient/);
  assert.equal(walletSendable(null).ok, false);
  assert.match(walletSendable(null).reason, /not been screened/);
  assert.equal(walletSendable(undefined).ok, false);
});

// ─── The route ──────────────────────────────────────────────────────────────

test('the recipients route validates, screens and refuses BEFORE it saves a wallet', async () => {
  const route = await readFile(new URL('../app/api/recipients/route.ts', import.meta.url), 'utf8');
  const start = route.indexOf("if (body.payoutMethod === 'WALLET')");
  assert.ok(start > 0, 'a wallet branch exists');
  const branch = route.slice(start, route.indexOf("const account = String(body.account"));
  const persistAt = branch.indexOf('persistRecipient(');
  for (const step of ['normaliseSuiAddress(', 'WALLET_PROVIDERS', 'screenWalletAddress(', "verdict === 'BLOCK'"]) {
    const at = branch.indexOf(step);
    assert.ok(at > 0 && at < persistAt, `${step} runs before the wallet is saved`);
  }
  assert.match(branch, /status: 403/, 'a listed wallet is refused, not saved');
  assert.match(branch, /ctx\.role !== 'OWNER' && ctx\.role !== 'FINANCE_ADMIN'/, 'only an admin may attest');
  assert.match(branch, /recordRecipientScreening\(/);
  // The custody gate sits above the split, so neither path saves first.
  assert.ok(route.indexOf('deliveryTierAllowed(') < start);
});

test('the invoice loop and the money routes refuse with the lane, not a generic block', async () => {
  const extract = await readFile(new URL('../app/api/copilot/extract-invoice/route.ts', import.meta.url), 'utf8');
  assert.ok(extract.indexOf("laneAccess(state, 'FIAT_OUT_LOCAL')") < extract.indexOf('const deliveryTier'),
    'Zeke checks the lane before recommending a delivery route');
  assert.match(extract, /blocked: \{ lane: 'FIAT_OUT_LOCAL'/);
  // parseInvoice returns amountMinor as a bigint; JSON cannot carry one, and
  // the route answered 500 on every extraction until it was stringified.
  assert.match(extract, /amountMinor: parsedInvoice\.amountMinor\.toString\(\)/);

  for (const [file, lane] of [
    ['app/api/transfers/authorize/route.ts', 'FIAT_OUT_LOCAL'],
    ['app/api/batches/authorize/route.ts', 'FIAT_OUT_LOCAL'],
    ['app/api/treasury/route.ts', 'TREASURY'],
  ]) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(text, new RegExp(`requireActiveOrg\\(auth\\.session, \\{ lane: '${lane}' \\}\\)`), file);
  }
});

// ─── The table ──────────────────────────────────────────────────────────────

async function migrated() {
  const client = new PGlite();
  const files = (await readdir(new URL('../drizzle', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sqlText = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
  await client.exec(`INSERT INTO organizations (id, name) VALUES ('org_w', 'W Co')`);
  return client;
}

test('the table refuses a wallet recipient with no address, a bad one, or an unaccepted wallet', async () => {
  const client = await migrated();
  const insert = (id, method, address, provider) => client.query(
    `INSERT INTO suppliers (id, org_id, name, country, payout_method, wallet_address, wallet_provider)
     VALUES ($1, 'org_w', 'Payee', 'PH', $2, $3, $4)`,
    [id, method, address, provider],
  );

  await insert('ok_wallet', 'WALLET', ADDRESS, 'SLUSH');
  await insert('ok_snap', 'WALLET', `0x${'cd'.repeat(32)}`, 'METAMASK_SUI_SNAP');
  await insert('ok_bank', 'BANK', null, null);

  await assert.rejects(() => insert('no_addr', 'WALLET', null, 'SLUSH'), /check/i);
  await assert.rejects(() => insert('evm', 'WALLET', '0x209693bc6afc0c5328ba36faf03c514ef312287c', 'SLUSH'), /check/i);
  await assert.rejects(() => insert('upper', 'WALLET', `0x${'AB'.repeat(32)}`, 'SLUSH'), /check/i, 'stored lower-case only');
  await assert.rejects(() => insert('phantom', 'WALLET', ADDRESS, 'PHANTOM'), /check/i, 'Phantom ended Sui support');
  await assert.rejects(() => insert('odd', 'CARD', null, null), /check/i);
  await client.close();
});
