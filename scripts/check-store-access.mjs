/**
 * Nothing reaches into an operations map except the store that owns it.
 *
 * Every record that has moved to Postgres — transfers, invoices, beneficiaries,
 * the ledger — is reached through a store module that takes an `orgId` on every
 * read and spells cross-tenant reach `*ForStaff`. The in-process `Map` behind
 * each one still exists, because `npm run dev` has to work without a database.
 *
 * A route that touches that Map directly gets neither guarantee, and it fails
 * in two directions at once:
 *
 *   It is unscoped. `[...operations.transfers.values()]` is every tenant's
 *   transfers. That is exactly what `app/api/transfers/route.ts` did, and its
 *   `?export=true` returned all of them in one response.
 *
 *   It is EMPTY. Once the record moved to Postgres, nothing writes that Map in
 *   a deployed environment — so the same line that leaked every tenant's data
 *   in development returned nothing at all in production. A store bypassed is a
 *   store that silently stops working, and the two failures hide each other:
 *   whoever tests it against a real database sees an empty page and goes
 *   looking for a rendering bug.
 *
 * So: the maps are private to their stores. This check says so mechanically,
 * because a convention that only lives in a comment is one import away from
 * being over.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** The maps that belong to a store. */
const OWNED = ['transfers', 'invoices', 'recipients', 'ledgerEntries', 'auditReceipts'];

/** The store modules, plus operations.ts itself, which defines them. */
const ALLOWED = new Set(
  [
    'lib/server/operations.ts',
    'lib/server/transfers-store.ts',
    'lib/server/invoices-store.ts',
    'lib/server/recipients-store.ts',
    'lib/server/ledger-store.ts',
  ].map((p) => path.normalize(p)),
);

const ROOTS = ['app', 'lib', 'components'];
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build']);

async function filesUnder(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const pattern = new RegExp(`\\boperations\\s*\\.\\s*(${OWNED.join('|')})\\b`);
const violations = [];

for (const root of ROOTS) {
  for (const file of await filesUnder(root)) {
    if (ALLOWED.has(path.normalize(file))) continue;
    const text = await readFile(file, 'utf8');
    let line = 0;
    let inBlockComment = false;
    for (const raw of text.split('\n')) {
      line += 1;
      const trimmed = raw.trim();
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        continue;
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlockComment = true;
        continue;
      }
      // A comment explaining the store that replaced a map is documentation.
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      const match = pattern.exec(raw);
      if (match) {
        violations.push(
          `${file.replace(/\\/g, '/')}:${line} reaches operations.${match[1]} directly — ` +
            `use the store, which scopes the read and works against Postgres.`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error('An operations map is reached from outside its store:\n');
  for (const violation of violations) console.error(`  ✖ ${violation}`);
  console.error(
    '\nThese maps are the no-database fallback inside a store module. Read through\n' +
      'the store instead — lib/server/{transfers,invoices,recipients,ledger}-store.ts —\n' +
      'so the read is scoped to an org AND actually sees a deployed database.',
  );
  process.exit(1);
}

console.log(
  `Store access is private: ${OWNED.length} operations map(s), reached only from ` +
    `${ALLOWED.size} owning module(s).`,
);
