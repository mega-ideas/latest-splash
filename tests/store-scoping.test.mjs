import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The reads that were left, after the four stores moved to Postgres.
 *
 * Each of these took an id, or nothing at all, and returned another tenant's
 * data to anyone holding a session. They are grouped here because they share
 * one shape: authentication was checked, entitlement was not.
 */

const withoutComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

async function route(file) {
  return readFile(new URL(`../${file}`, import.meta.url), 'utf8');
}

test('the transfer history is the caller’s own, and reads the durable store', async () => {
  const text = await route('app/api/transfers/route.ts');
  assert.match(text, /requireSessionAccount/);
  assert.match(text, /listTransfersFor\(accountCheck\.account\.orgId/);
  // It read `operations.transfers` directly: every tenant's transfers, and
  // `?export=true` returned all of them at once. Worse, once transfers moved to
  // Postgres that map stopped being written, so the same line rendered an empty
  // page against a real database.
  assert.doesNotMatch(withoutComments(text), /operations\.transfers/);
});

test('a batch is readable by the org that authorized it', async () => {
  const text = await route('app/api/batches/[id]/route.ts');
  assert.match(text, /requireSessionAccount/);
  // Through the store, scoped by org — not by the on-chain account id, which
  // falls back to a value shared across tenants.
  assert.match(text, /readBatch\(accountCheck\.account\.orgId, id\)/);
  assert.match(text, /from '@\/lib\/server\/batches-store'/);
});

test('rate holds are one customer’s corridor positions, not everyone’s', async () => {
  const text = await route('app/api/rate-holds/route.ts');
  assert.match(text, /requireSessionAccount/);
  assert.match(text, /listRateHoldsFor\(|readRateHoldFor\(/);
  assert.doesNotMatch(withoutComments(text), /listRateHolds\(\)|readRateHold\(/);
});

test('a hold with no owner belongs to nobody, not to everybody', async () => {
  delete process.env.DATABASE_URL;
  const { createRateHold, listRateHoldsFor } = await import('../lib/server/operations.ts');

  const mine = createRateHold({
    orgId: 'acme', corridorCurrency: 'PHP', rate: '56.5', feeBps: 80,
  });
  const theirs = createRateHold({
    orgId: 'northwind', corridorCurrency: 'PHP', rate: '56.5', feeBps: 80,
  });
  // The demo seed creates holds with no orgId. An `orgId === undefined`
  // comparison must not match a real org.
  const ownerless = createRateHold({ corridorCurrency: 'MYR', rate: '4.7', feeBps: 80, demo: true });

  const forMe = listRateHoldsFor('acme');
  assert.ok(forMe.some((h) => h.id === mine.id));
  assert.ok(!forMe.some((h) => h.id === theirs.id));
  assert.ok(!forMe.some((h) => h.id === ownerless.id));
});

test('the store-access guard is in the lint chain', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  // A convention that lives only in a comment is one import away from over.
  assert.match(pkg.scripts.lint, /check:stores/);
  assert.equal(pkg.scripts['check:stores'], 'node scripts/check-store-access.mjs');
});
