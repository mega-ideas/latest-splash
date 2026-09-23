import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import {
  closeOutflow,
  confirmOutflow,
  readAllowance,
  reserveOutflow,
  RESERVATION_MS,
} from '../lib/server/stablecoin-outflows.ts';
import { parseUsdcMinor, SUI_USDC_COIN_TYPE } from '../lib/payments/stablecoin-lane.ts';

/**
 * The outflow ledger against real migrations: reservations, the shared cap,
 * expiry, and confirm-exactly-once.
 */

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

const SENDER = '0x' + '11'.repeat(32);
const RECIPIENT = '0x' + '22'.repeat(32);
const FEE = '0x' + '33'.repeat(32);
const usdc = (s) => parseUsdcMinor(s);
const HASH = 'a'.repeat(64);

async function org(client, { id = 'org_sc', kyb = 'REGISTERED' } = {}) {
  await client.exec(`INSERT INTO organizations (id, name, kyb_lifecycle) VALUES ('${id}', 'SC Co', '${kyb}')`);
  return id;
}

function reserve(db, orgId, principal, extra = {}) {
  return reserveOutflow(db, {
    orgId,
    kind: 'TRANSFER',
    supplierId: null,
    coinType: SUI_USDC_COIN_TYPE.mainnet,
    principalMinor: principal,
    feeMinor: principal / 125n,
    senderAddress: SENDER,
    recipientAddress: RECIPIENT,
    feeAddress: FEE,
    ...extra,
  });
}

test('a reservation holds allowance, and a mainnet row is marked anchor-pending', async () => {
  const { client, db } = await migratedDb();
  const orgId = await org(client);
  const r = await reserve(db, orgId, usdc('4000'));
  assert.equal(r.ok, true);
  assert.equal(r.network, 'mainnet');
  const row = (await client.query(`SELECT status, anchor_status FROM stablecoin_outflows WHERE id = '${r.id}'`)).rows[0];
  assert.equal(row.status, 'PENDING');
  assert.equal(row.anchor_status, 'PENDING_MAINNET_PUBLISH');

  const next = await reserve(db, orgId, usdc('1000') + 1n);
  assert.equal(next.ok, false, 'the pending reservation already counts');
  assert.match(next.reason, /5000\.000000 USDC in any 30 days/);
  await client.close();
});

test('two quotes fired at once cannot jointly breach the cap', async () => {
  const { client, db } = await migratedDb();
  const orgId = await org(client);
  const [a, b] = await Promise.all([reserve(db, orgId, usdc('3000')), reserve(db, orgId, usdc('3000'))]);
  assert.equal([a, b].filter((r) => r.ok).length, 1, 'exactly one of two 3,000 quotes fits in 5,000');
  await client.close();
});

test('an abandoned reservation lapses and stops counting', async () => {
  const { client, db } = await migratedDb();
  const orgId = await org(client);
  const t0 = Date.UTC(2026, 8, 24, 12, 0, 0);
  const r = await reserve(db, orgId, usdc('5000'), { nowMs: t0 });
  assert.equal(r.ok, true);
  assert.equal((await reserve(db, orgId, usdc('1'), { nowMs: t0 + 60_000 })).ok, false, 'held while live');
  assert.equal((await reserve(db, orgId, usdc('1'), { nowMs: t0 + RESERVATION_MS + 1 })).ok, true, 'released once lapsed');
  await client.close();
});

test('a reservation confirms exactly once, and a digest can never be claimed twice', async () => {
  const { client, db } = await migratedDb();
  const orgId = await org(client);
  const r1 = await reserve(db, orgId, usdc('10'));
  const r2 = await reserve(db, orgId, usdc('10'));
  assert.equal(await confirmOutflow(db, { orgId, id: r1.id, txDigest: 'DIGEST_A', auditHash: HASH }), true);
  assert.equal(await confirmOutflow(db, { orgId, id: r1.id, txDigest: 'DIGEST_A', auditHash: HASH }), false, 'already confirmed');
  await assert.rejects(
    () => confirmOutflow(db, { orgId, id: r2.id, txDigest: 'DIGEST_A', auditHash: HASH }),
    // drizzle wraps the driver error; the constraint name lives on the cause.
    (err) => /duplicate key|unique/i.test(String(err?.cause?.message ?? err?.message)),
    'one on-chain transaction cannot be recorded as two payments',
  );
  await client.close();
});

test('a failed or mismatched outflow releases its allowance', async () => {
  const { client, db } = await migratedDb();
  const orgId = await org(client);
  const r = await reserve(db, orgId, usdc('5000'));
  await closeOutflow(db, { orgId, id: r.id, status: 'MISMATCH', reason: 'signed a different amount', txDigest: 'DIGEST_M' });
  const again = await reserve(db, orgId, usdc('5000'));
  assert.equal(again.ok, true, 'a mismatch is not counted as a Splash payment');
  await client.close();
});

test('confirmed x402 payments count against the same allowance', async () => {
  const { client, db } = await migratedDb();
  const orgId = await org(client);
  const x = await reserve(db, orgId, usdc('4999.99'), { kind: 'X402', feeMinor: 0n, resource: 'https://api.example.com/r' });
  assert.equal(x.ok, true);
  await confirmOutflow(db, { orgId, id: x.id, txDigest: 'DIGEST_X', auditHash: HASH });
  const { allowance } = await readAllowance(db, orgId);
  assert.equal(allowance.remainingMinor, usdc('0.01'));
  assert.equal((await reserve(db, orgId, usdc('1'))).ok, false);
  await client.close();
});

test('a suspended business cannot reserve anything; a verified one is on mainnet too, with Tier 3 limits', async () => {
  const { client, db } = await migratedDb();
  const suspended = await org(client, { id: 'org_susp', kyb: 'SUSPENDED' });
  const r = await reserve(db, suspended, usdc('1'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /suspended/);

  const verified = await org(client, { id: 'org_v', kyb: 'ACTIVE' });
  const v = await reserve(db, verified, usdc('20000'));
  assert.equal(v.ok, true, 'above the unverified cap, within Tier 3');
  assert.equal(v.network, 'mainnet', 'there is no stablecoin sandbox');
  const row = (await client.query(`SELECT network, anchor_status FROM stablecoin_outflows WHERE id = '${v.id}'`)).rows[0];
  assert.equal(row.network, 'mainnet');
  assert.equal(row.anchor_status, 'PENDING_MAINNET_PUBLISH');
  await client.close();
});

test('the database itself refuses a nonsense row', async () => {
  const { client } = await migratedDb();
  await org(client);
  await assert.rejects(
    () => client.exec(`INSERT INTO stablecoin_outflows (id, org_id, kind, network, coin_type, principal_minor, fee_minor, sender_address, recipient_address, reserved_until, anchor_status)
      VALUES ('bad', 'org_sc', 'TRANSFER', 'mainnet', 'x', 0, 0, 'a', 'b', now(), 'NOT_REQUIRED')`),
    /check/i,
    'a zero principal violates the CHECK constraint',
  );
  await assert.rejects(
    () => client.exec(`INSERT INTO stablecoin_outflows (id, org_id, kind, network, coin_type, principal_minor, fee_minor, sender_address, recipient_address, reserved_until, anchor_status)
      VALUES ('tn', 'org_sc', 'TRANSFER', 'testnet', 'x', 1, 0, 'a', 'b', now(), 'NOT_REQUIRED')`),
    /check/i,
    'the ledger holds mainnet rows only',
  );
  await client.close();
});

test('a CONFIRMED row must carry its digest and audit hash — the table refuses one without', async () => {
  const { client, db } = await migratedDb();
  const orgId = await org(client);
  const r = await reserve(db, orgId, usdc('10'));
  await assert.rejects(
    () => client.exec(`UPDATE stablecoin_outflows SET status = 'CONFIRMED', tx_digest = 'D', confirmed_at = now() WHERE id = '${r.id}'`),
    /check/i,
    'no audit hash, no confirmation',
  );
  assert.equal(await confirmOutflow(db, { orgId, id: r.id, txDigest: 'DIGEST_H', auditHash: HASH }), true);
  const row = (await client.query(`SELECT audit_hash FROM stablecoin_outflows WHERE id = '${r.id}'`)).rows[0];
  assert.equal(row.audit_hash, HASH);
  await client.close();
});
