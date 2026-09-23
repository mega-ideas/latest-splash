import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import * as repo from '../lib/server/repository/treasury.ts';

/**
 * Treasury balances that survive a deploy.
 *
 * Balances, withdrawal notices and the yield accrual baseline all lived in
 * module state. Three consequences, in ascending order of seriousness:
 *
 *   A restart set every customer's Available and Smart Treasury to zero.
 *
 *   It dropped every PENDING withdrawal notice. A notice is a promise that
 *   funds land on a stated date, and the settlement cron reads that list — so
 *   a restart between request and settlement left the money reserved out of
 *   treasury with nothing scheduled to release it, and no record of the debt.
 *
 *   It reset the accrual baseline to null. Yield is a price DELTA, so a null
 *   baseline correctly records nothing — meaning every deploy silently skipped
 *   a day of yield for every customer, and nothing said so.
 */

async function migratedDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const files = (await readdir(new URL('../drizzle', import.meta.url)))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sqlText = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
  await client.exec(`
    INSERT INTO organizations (id, name) VALUES ('acme', 'Acme Trading'), ('northwind', 'Northwind')
  `);
  return { client, db };
}

const ledger = (over = {}) => ({
  orgId: 'acme',
  availableMicro: 11_140_000_000n,
  treasuryPrincipalMicro: 24_500_000_000n,
  treasuryYieldMicro: 98_720_000n,
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});

test('a balance survives, exactly, in micro-USD', async () => {
  const { client, db } = await migratedDb();
  await repo.upsertLedger(db, ledger());

  const row = await repo.findLedger(db, 'acme');
  // Integers all the way down: a float here is a rounding error in somebody's
  // money that compounds every accrual.
  assert.equal(row.availableMicro, 11_140_000_000n);
  assert.equal(row.treasuryYieldMicro, 98_720_000n);
  await client.close();
});

test('one org\'s balance is not another\'s', async () => {
  const { client, db } = await migratedDb();
  await repo.upsertLedger(db, ledger());
  await repo.upsertLedger(db, ledger({ orgId: 'northwind', treasuryPrincipalMicro: 0n }));

  assert.equal((await repo.findLedger(db, 'northwind')).treasuryPrincipalMicro, 0n);
  assert.equal((await repo.findLedger(db, 'acme')).treasuryPrincipalMicro, 24_500_000_000n);
  await client.close();
});

test('a negative balance is refused by the database, not just by the mover', async () => {
  const { client, db } = await migratedDb();
  // The mover checks before it writes, but the mover is not the only writer —
  // accrual writes too, and a falling redemption price produces a negative
  // delta. The constraint is the backstop.
  await assert.rejects(() => repo.upsertLedger(db, ledger({ availableMicro: -1n })));
  await client.close();
});

test('a pending notice is still owed after a restart', async () => {
  const { client, db } = await migratedDb();
  await repo.insertNotice(db, {
    id: 'wn_1',
    orgId: 'acme',
    amountMicro: 5_000_000_000n,
    requestedAt: new Date('2026-09-01T00:00:00Z'),
    availableAt: new Date('2026-09-03T00:00:00Z'),
    state: 'PENDING',
  });

  const mine = await repo.listNoticesForOrg(db, 'acme');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].amountMicro, 5_000_000_000n);
  // And it is not visible to anybody else.
  assert.equal((await repo.listNoticesForOrg(db, 'northwind')).length, 0);
  await client.close();
});

test('the settlement sweep finds what is due and leaves what is not', async () => {
  const { client, db } = await migratedDb();
  const base = {
    orgId: 'acme',
    amountMicro: 1_000_000n,
    requestedAt: new Date('2026-09-01T00:00:00Z'),
    state: 'PENDING',
  };
  await repo.insertNotice(db, { ...base, id: 'due', availableAt: new Date('2026-09-03T00:00:00Z') });
  await repo.insertNotice(db, { ...base, id: 'later', availableAt: new Date('2026-09-30T00:00:00Z') });
  await repo.insertNotice(db, {
    ...base,
    id: 'settled',
    availableAt: new Date('2026-09-02T00:00:00Z'),
    state: 'SETTLED',
  });

  const due = await repo.listDueNotices(db, new Date('2026-09-05T00:00:00Z'));
  // Only PENDING and only elapsed. Re-settling a SETTLED notice would credit
  // Available twice for one withdrawal.
  assert.deepEqual(due.map((n) => n.id), ['due']);
  await client.close();
});

test('the accrual baseline outlives the process', async () => {
  const { client, db } = await migratedDb();

  // No baseline yet is a real answer, and it is the answer only on the very
  // first run — not on the first run after every deploy.
  assert.equal(await repo.readAccrualBaseline(db), null);

  await repo.writeAccrualBaseline(db, 1_004_312n);
  assert.equal(await repo.readAccrualBaseline(db), 1_004_312n);

  // One row, whatever happens: a second baseline would mean two answers to
  // "what price did we last accrue against".
  await repo.writeAccrualBaseline(db, 1_004_555n);
  assert.equal(await repo.readAccrualBaseline(db), 1_004_555n);
  await client.close();
});
