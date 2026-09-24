import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import { SUI_USDC_COIN_TYPE } from '../lib/payments/stablecoin-lane.ts';
import { plainUsdc, textCell, USDC_RECORD_COLUMNS, usdcRecordsCsv } from '../lib/payments/usdc-records.ts';
import { listUsdcRecords, loadActivityLabels } from '../lib/server/usdc-records.ts';
import { labelMovements, movementFor, readUsdcActivity } from '../lib/server/wallet-activity.ts';

/**
 * The Splash wallet as a wallet: money in and out read from chain, named
 * from Splash's records; and every USDC transfer exportable for the books.
 */

const USDC = SUI_USDC_COIN_TYPE.mainnet;
const SUI = '0x2::sui::SUI';
const ME = `0x${'aa'.repeat(32)}`;
const PAYER = `0x${'bb'.repeat(32)}`;
const PAYEE = `0x${'cc'.repeat(32)}`;
const FEE = `0x${'dd'.repeat(32)}`;

const change = (owner, amount, coinType = USDC) => ({ owner: { address: owner }, amount: String(amount), coinType: { repr: coinType } });
const node = (digest, changes, { status = 'SUCCESS', timestamp = '2026-09-24T10:00:00Z' } = {}) => ({
  digest,
  effects: { status, timestamp, balanceChanges: { nodes: changes } },
});

// ─── Reading one transaction ────────────────────────────────────────────────

test('money in: the amount, and the payer as the counterparty', () => {
  const m = movementFor(ME, node('in1', [change(PAYER, -250_000_000), change(ME, 250_000_000), change(PAYER, -2_000_000, SUI)]));
  assert.equal(m.direction, 'IN');
  assert.equal(m.amountMinor, 250_000_000n);
  assert.equal(m.counterparty, PAYER);
  assert.equal(m.success, true);
});

test('money out through Splash: the payee is the counterparty, not the fee leg', () => {
  const m = movementFor(ME, node('out1', [change(ME, -100_800_000), change(PAYEE, 100_000_000), change(FEE, 800_000)]));
  assert.equal(m.direction, 'OUT');
  assert.equal(m.amountMinor, 100_800_000n, 'what left the wallet, fee included');
  assert.equal(m.counterparty, PAYEE);
});

test('a transaction that moved no USDC for this address is not activity; case does not matter', () => {
  assert.equal(movementFor(ME, node('gas', [change(ME, -1_000_000, SUI)])), null);
  assert.equal(movementFor(ME, node('other', [change(PAYER, -5), change(PAYEE, 5)])), null);
  const upper = movementFor(ME.toUpperCase().replace('0X', '0x'), node('in2', [change(PAYER, -1), change(ME, 1)]));
  assert.equal(upper.direction, 'IN');
});

// ─── Paging through the chain ───────────────────────────────────────────────

function gqlPage(nodes, { hasPreviousPage = false, startCursor = null } = {}) {
  return new Response(JSON.stringify({ data: { address: { transactions: { pageInfo: { hasPreviousPage, startCursor }, nodes } } } }), { status: 200 });
}

test('activity is newest first, skips non-USDC pages, and hands back a cursor for older', async () => {
  const bodies = [];
  const pages = [
    // Newest page (oldest-first inside, as GraphQL `last` returns it): gas only.
    gqlPage([node('g1', [change(ME, -1, SUI)])], { hasPreviousPage: true, startCursor: 'c1' }),
    gqlPage([
      node('in-old', [change(PAYER, -10_000_000), change(ME, 10_000_000)], { timestamp: '2026-09-20T00:00:00Z' }),
      node('out-new', [change(ME, -5_040_000), change(PAYEE, 5_000_000), change(FEE, 40_000)], { timestamp: '2026-09-21T00:00:00Z' }),
    ], { hasPreviousPage: true, startCursor: 'c2' }),
  ];
  const fetcher = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return pages.shift() ?? gqlPage([]);
  };
  const result = await readUsdcActivity(ME, { fetcher, limit: 2 });
  assert.equal(result.available, true);
  assert.deepEqual(result.movements.map((m) => m.digest), ['out-new', 'in-old']);
  assert.equal(result.olderCursor, 'c2');
  assert.equal(bodies[0].variables.before, null);
  assert.equal(bodies[1].variables.before, 'c1', 'the second page continues from the first');
  assert.match(bodies[0].query, /relation: AFFECTED/);
});

test('the indexer refusing or failing is "unavailable", never an empty wallet', async () => {
  const refused = await readUsdcActivity(ME, { fetcher: async () => new Response(JSON.stringify({ errors: [{ message: 'rate limited' }] }), { status: 200 }) });
  assert.equal(refused.available, false);
  assert.match(refused.reason, /rate limited/);
  const down = await readUsdcActivity(ME, { fetcher: async () => new Response('bad gateway', { status: 502 }) });
  assert.equal(down.available, false);
});

test('a quiet wallet stops after a bounded number of pages', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return gqlPage([node(`g${calls}`, [change(ME, -1, SUI)])], { hasPreviousPage: true, startCursor: `c${calls}` });
  };
  const result = await readUsdcActivity(ME, { fetcher });
  assert.equal(calls, 4);
  assert.equal(result.movements.length, 0);
  assert.equal(result.olderCursor, 'c4', 'and says where to carry on');
});

// ─── Naming it from Splash's records ────────────────────────────────────────

test('labels: a Splash send, an x402 payment, a deposit from a saved recipient, and a send with no record', () => {
  const movements = [
    movementFor(ME, node('d-send', [change(ME, -100_800_000), change(PAYEE, 100_000_000), change(FEE, 800_000)])),
    movementFor(ME, node('d-x402', [change(ME, -10_000), change(PAYEE, 10_000)])),
    movementFor(ME, node('d-in', [change(PAYER, -3_000_000), change(ME, 3_000_000)])),
    movementFor(ME, node('d-odd', [change(ME, -7_000_000), change(PAYER, 7_000_000)])),
  ];
  const outflows = new Map([
    ['d-send', { kind: 'TRANSFER', recipientName: 'Manila Parts Supply', resource: null, feeMinor: 800_000n }],
    ['d-x402', { kind: 'X402', recipientName: null, resource: 'https://api.example.com/fx', feeMinor: 0n }],
  ]);
  const recipients = new Map([[PAYER, 'Cebu Traders']]);
  const [send, x402, deposit, odd] = labelMovements(movements, outflows, recipients);
  assert.equal(send.label, 'Sent with Splash to Manila Parts Supply');
  assert.equal(send.origin, 'SPLASH');
  assert.equal(send.feeMinor, 800_000n);
  assert.equal(x402.label, 'x402 payment to api.example.com');
  assert.equal(x402.feeMinor, null, 'x402 carries no Splash fee');
  assert.equal(deposit.label, 'Received from Cebu Traders');
  assert.equal(deposit.origin, 'RECEIVED');
  assert.equal(odd.origin, 'NO_RECORD', 'from a passkey wallet only Splash signs — this one deserves a look');
  assert.match(odd.label, /no Splash record to Cebu Traders/);

  // A connected Slush or MetaMask wallet sends outside Splash all the time.
  const [, , , external] = labelMovements(movements, outflows, recipients, { splashWallet: false });
  assert.equal(external.origin, 'SENT');
  assert.equal(external.label, 'Sent to Cebu Traders');
});

// ─── The CSV ────────────────────────────────────────────────────────────────

test('CSV: exact six-decimal amounts, total = amount + fee, CRLF, the explorer link only with a digest', () => {
  assert.equal(plainUsdc(1_234_500_000n), '1234.500000');
  assert.equal(plainUsdc(1n), '0.000001');
  const csv = usdcRecordsCsv([{
    id: 'sco_1', kind: 'TRANSFER', status: 'CONFIRMED', createdAt: new Date('2026-09-24T01:00:00Z'), confirmedAt: new Date('2026-09-24T01:01:00Z'),
    recipientName: 'Manila Parts Supply', recipientAddress: PAYEE, resource: null, principalMinor: 100_000_000n, feeMinor: 800_000n,
    senderAddress: ME, txDigest: 'Dig3st', auditHash: 'ab'.repeat(32), anchorStatus: 'PENDING_MAINNET_PUBLISH',
    requestedBy: 'Maker <maker@acme.test>', approvedBy: 'Owner <owner@acme.test>', approvalMethod: 'WHATSAPP_PASSKEY', approvedAt: new Date('2026-09-24T01:00:30Z'), failureReason: null,
  }, {
    id: 'sco_2', kind: 'X402', status: 'FAILED', createdAt: '2026-09-23T00:00:00Z', confirmedAt: null,
    recipientName: null, recipientAddress: PAYEE, resource: 'https://api.example.com/fx', principalMinor: 10_000n, feeMinor: 0n,
    senderAddress: ME, txDigest: null, auditHash: null, anchorStatus: 'NOT_REQUIRED',
    requestedBy: null, approvedBy: null, approvalMethod: null, approvedAt: null, failureReason: 'Seller refused, "try later"',
  }]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], USDC_RECORD_COLUMNS.join(','));
  assert.equal(lines.length, 4, 'header, two rows, and the trailing newline');
  assert.match(lines[1], /,100\.000000,0\.800000,100\.800000,/);
  assert.match(lines[1], /https:\/\/suiscan\.xyz\/mainnet\/tx\/Dig3st/);
  assert.match(lines[1], /WhatsApp code \+ passkey/);
  assert.match(lines[2], /^2026-09-23T00:00:00\.000Z,,x402,failed,/);
  assert.match(lines[2], /"Seller refused, ""try later"""/, 'quotes and commas are escaped');
});

test('CSV: a name that starts like a formula is neutralised', () => {
  assert.equal(textCell('=HYPERLINK("http://evil","x")'), '"\'=HYPERLINK(""http://evil"",""x"")"');
  assert.equal(textCell('+1 555'), "'+1 555");
  assert.equal(textCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(textCell('-2+3'), "'-2+3");
  assert.equal(textCell('Plain Name'), 'Plain Name');
  assert.equal(textCell(null), '');
});

// ─── The records, from the database ─────────────────────────────────────────

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

test('records join the recipient, who asked, and the approval actually spent — and stay inside the org', async () => {
  const { client, db } = await migratedDb();
  await client.exec(`
    INSERT INTO organizations (id, name, legal_name) VALUES ('org_a', 'Acme', 'Acme Sdn Bhd'), ('org_b', 'Other', 'Other Ltd');
    INSERT INTO users (id, email, name) VALUES ('u_maker', 'maker@acme.test', 'Mia Maker'), ('u_owner', 'owner@acme.test', 'Omar Owner');
    INSERT INTO suppliers (id, org_id, name, country, payout_method, wallet_address, wallet_provider)
      VALUES ('sup_1', 'org_a', 'Manila Parts Supply', 'PH', 'WALLET', '${PAYEE}', 'SLUSH');
    INSERT INTO stablecoin_outflows (id, org_id, kind, supplier_id, network, coin_type, principal_minor, fee_minor, sender_address,
      recipient_address, fee_address, status, reserved_until, tx_digest, anchor_status, audit_hash, requested_by, confirmed_at, created_at)
    VALUES
      ('sco_ok', 'org_a', 'TRANSFER', 'sup_1', 'mainnet', '${USDC}', 100000000, 800000, '${ME}', '${PAYEE}', '${FEE}', 'CONFIRMED',
        now(), 'DIGEST_OK', 'PENDING_MAINNET_PUBLISH', '${'ab'.repeat(32)}', 'u_maker', now(), now() - interval '1 hour'),
      ('sco_fail', 'org_a', 'TRANSFER', 'sup_1', 'mainnet', '${USDC}', 5000000, 40000, '${ME}', '${PAYEE}', '${FEE}', 'FAILED',
        now(), NULL, 'PENDING_MAINNET_PUBLISH', NULL, 'u_maker', NULL, now() - interval '2 hours'),
      ('sco_other_org', 'org_b', 'TRANSFER', NULL, 'mainnet', '${USDC}', 7000000, 56000, '${ME}', '${PAYEE}', '${FEE}', 'EXPIRED',
        now(), NULL, 'PENDING_MAINNET_PUBLISH', NULL, NULL, NULL, now());
    INSERT INTO step_up_codes (id, org_id, method, approver_user_id, requested_by, purpose, subject_id, subject_digest, summary,
      expires_at, verified_at, consumed_at)
    VALUES
      ('su_spent', 'org_a', 'CLICK', 'u_owner', 'u_maker', 'STABLECOIN_TRANSFER', 'sco_ok', '${'0'.repeat(64)}', 'Pay 100 USDC',
        now() + interval '10 minutes', now(), now()),
      ('su_unused', 'org_a', 'CLICK', 'u_maker', 'u_maker', 'STABLECOIN_TRANSFER', 'sco_fail', '${'1'.repeat(64)}', 'Pay 5 USDC',
        now() + interval '10 minutes', now(), NULL);
  `);

  const records = await listUsdcRecords(db, 'org_a');
  assert.deepEqual(records.map((r) => r.id), ['sco_ok', 'sco_fail'], 'newest first, and only this org');
  const [ok, failed] = records;
  assert.equal(ok.recipientName, 'Manila Parts Supply');
  assert.equal(ok.requestedBy, 'Mia Maker <maker@acme.test>');
  assert.equal(ok.approvedBy, 'Omar Owner <owner@acme.test>');
  assert.equal(ok.approvalMethod, 'CLICK');
  assert.equal(failed.approvedBy, null, 'an approval that was never spent is not "the approval"');

  const labels = await loadActivityLabels(db, 'org_a', ['DIGEST_OK', 'NOT_OURS']);
  assert.equal(labels.outflowsByDigest.get('DIGEST_OK').recipientName, 'Manila Parts Supply');
  assert.equal(labels.outflowsByDigest.has('NOT_OURS'), false);
  assert.equal(labels.recipientsByAddress.get(PAYEE), 'Manila Parts Supply');
  assert.equal((await listUsdcRecords(db, 'org_b')).length, 1);
  await client.close();
});

// ─── The routes ─────────────────────────────────────────────────────────────

function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

test('routes: signed in, rate limited, and scoped to the session’s workspace — never an org from the request', async () => {
  for (const rel of ['../app/api/stablecoin/activity/route.ts', '../app/api/stablecoin/export/route.ts']) {
    const src = code(await readFile(new URL(rel, import.meta.url), 'utf8'));
    assert.match(src, /requireCustomerRequest\(request\)/, rel);
    assert.match(src, /enforceRateLimit\(/, rel);
    assert.match(src, /accountCheck\.account\.orgId/, rel);
    assert.doesNotMatch(src, /searchParams\.get\('org/, rel);
  }
  const exportSrc = code(await readFile(new URL('../app/api/stablecoin/export/route.ts', import.meta.url), 'utf8'));
  assert.match(exportSrc, /'Content-Disposition': `attachment; filename="splash-usdc-transfers-\$\{day\}\.csv"`/);
});
