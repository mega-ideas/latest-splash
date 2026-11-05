/**
 * The cross-chain sweep (v2 §4.7, review B7): a burned CCTP payment is asked
 * of Circle again on every run, within its own business, so a lost refresh
 * does not leave it burned forever; one still not minted six hours after its
 * burn is reported as stuck. Nothing is signed or sent.
 *
 * PGlite with every migration; Circle's service is a stand-in.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as schema from '../lib/db/schema.ts';
import { sweepCrossChainTransfers } from '../lib/server/cross-chain-transfers.ts';

import { migratedDb } from './helpers/store-db.mjs';

const T0 = new Date('2026-10-25T08:00:00Z');
const HOUR = 3_600_000;
const MINT_RECIPIENT = `0x${'0'.repeat(24)}52908400098527886e0f7030069857d2e4169ee7`;
const NONCE = `0x${'4e'.repeat(32)}`;
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const u32 = (n) => n.toString(16).padStart(8, '0');
const message = () => {
  const body = u32(1) + '11'.repeat(32) + MINT_RECIPIENT.slice(2) + word(1_000_000_000n) + '22'.repeat(32) + word(0) + word(0) + word(0);
  return `0x${u32(1)}${u32(8)}${u32(6)}${NONCE.slice(2)}${'33'.repeat(32)}${'44'.repeat(32)}${'0'.repeat(64)}${u32(2000)}${u32(2000)}${body}`;
};

async function burned(db, { id, orgId, paymentRef, burnDigest, burnedAt }) {
  await db.insert(schema.crossChainTransfers).values({ id, orgId, paymentRef, destinationChain: 'BASE', destinationDomain: 6, mintRecipient: MINT_RECIPIENT, amountMinor: 1_000_000_000n, status: 'awaiting_burn', createdAt: burnedAt });
  const { eq } = await import('drizzle-orm');
  await db.update(schema.crossChainTransfers).set({ status: 'burned', burnDigest, burnedAt }).where(eq(schema.crossChainTransfers.id, id));
}

test('every burned payment is asked of Circle again, each in its own business, and a late one is reported', async () => {
  const { db, client } = await migratedDb();
  await burned(db, { id: 'cct_1', orgId: 'acme', paymentRef: `0x${'a1'.repeat(32)}`, burnDigest: 'Fq3nXdigest1111111111111111111111111111111', burnedAt: new Date(T0.getTime() - HOUR) });
  await burned(db, { id: 'cct_2', orgId: 'northwind', paymentRef: `0x${'a2'.repeat(32)}`, burnDigest: 'Fq3nXdigest2222222222222222222222222222222', burnedAt: new Date(T0.getTime() - 7 * HOUR) });
  const asked = [];
  const iris = {
    sandbox: false,
    async messagesForSuiBurn(digest) {
      asked.push(digest);
      return digest.endsWith('1') ? [{ message: message(), attestation: '0xa77e', status: 'complete' }] : [{ message: '0x', attestation: 'PENDING', status: 'pending_confirmations' }];
    },
  };
  const swept = await sweepCrossChainTransfers({ db, now: () => T0, iris });
  assert.deepEqual([swept.asked, swept.attested, swept.pending, swept.errors], [2, 1, 1, 0]);
  assert.deepEqual(asked.sort(), ['Fq3nXdigest1111111111111111111111111111111', 'Fq3nXdigest2222222222222222222222222222222']);
  assert.deepEqual(swept.stuck, [{ orgId: 'northwind', paymentRef: `0x${'a2'.repeat(32)}`, status: 'burned' }], 'burned seven hours ago and not attested');
  const rows = await db.select().from(schema.crossChainTransfers);
  assert.deepEqual(rows.map((r) => [r.id, r.status]).sort(), [['cct_1', 'attested'], ['cct_2', 'burned']]);
  // An attested payment is not asked again; once late, it is reported until minted.
  const later = await sweepCrossChainTransfers({ db, now: () => new Date(T0.getTime() + 6 * HOUR), iris });
  assert.equal(later.asked, 1);
  assert.deepEqual(later.stuck.map((s) => s.paymentRef).sort(), [`0x${'a1'.repeat(32)}`, `0x${'a2'.repeat(32)}`].sort());
  await client.close();
});

test('the sweep route is the cron secret’s, and production asks only the configured service', async () => {
  const src = await readFile(new URL('../app/api/cron/cross-chain/route.ts', import.meta.url), 'utf8');
  assert.match(src, /CRON_SECRET/);
  assert.match(src, /timingSafeEqual/);
  assert.match(src, /irisClientFromEnv\(\)/);
  assert.doesNotMatch(src, /signAndExecute|executeTransaction/, 'it reads; it never signs or sends');
});
