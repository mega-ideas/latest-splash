import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

/**
 * WS2 — the four stores that answered any session with every tenant's data.
 *
 * Same rule as the transfer, invoice, beneficiary and ledger stores: `orgId`
 * is the first, required parameter of every read, the org comes from the
 * SESSION (`requireCustomerRequest` + `requireSessionAccount`, which resolves
 * it through `resolveAuthorityForSession`), and reach across tenants is
 * spelled `*ForStaff` and only ever behind the staff session.
 *
 *   1. MemWal (Copilot memory). Already namespaced per org on main; pinned
 *      here so a recall for org B can never return org A's fact, even from a
 *      relayer that ignores namespaces, and so no unscoped entry point returns.
 *   2. Support tickets. `listSupportTickets()` / `readSupportTicket(id)` gave
 *      any signed-in customer every tenant's tickets, by list or by id.
 *   3. Walrus blobs. `GET /api/walrus/:blobId` returned any blob's metadata to
 *      any session. It must answer only when the caller's org owns an invoice
 *      or a transfer receipt that references the blob, and 404 otherwise.
 *   4. Daily audit batches. Every tenant's settlement ids, roots and proofs to
 *      any customer session. Sky's decision: staff-only, roots and contents.
 *
 * One cross-org test per store, then a source scan that the routes use the
 * member guard (or the staff guard) and the scoped readers.
 */

delete process.env.DATABASE_URL;
delete process.env.MEMWAL_PRIVATE_KEY;
delete process.env.MEMWAL_ACCOUNT_ID;

const ORG_A = 'org_acme';
const ORG_B = 'org_bravo';

const root = new URL('..', import.meta.url);
const source = (rel) => readFile(new URL(rel, root), 'utf8');

// ── 1 · MemWal ──────────────────────────────────────────────────────────────

/** A relayer that ignores the namespace: the old shared one, or a bug. */
function sharedRelayer() {
  const stored = [];
  return {
    async remember(text) {
      stored.push(text);
    },
    async recall({ limit }) {
      return { results: stored.slice(0, limit).map((text, i) => ({ text, distance: i / 10 })) };
    },
  };
}

test('memwal: a recall for org B never returns org A\'s fact, even from a relayer that ignores namespaces', async () => {
  const { orgScopedMemory } = await import('../lib/server/memwal-scope.ts');
  const memory = orgScopedMemory(sharedRelayer());
  const fact = 'Invoice vendor Manila Parts Trading settles in PHP';

  assert.equal(await memory.remember(ORG_A, fact), true);

  const forB = await memory.recall(ORG_B, 'vendor settles in', 10);
  assert.deepEqual(forB, [], 'org B sees nothing of org A');
  const forA = await memory.recall(ORG_A, 'vendor settles in', 10);
  assert.deepEqual(forA.map((m) => m.text), [fact], 'org A still recalls its own fact');

  assert.equal(await memory.remember('', fact), false, 'no org, no write');
  assert.deepEqual(await memory.recall('', 'vendor', 10), [], 'no org, no recall');
});

test('memwal: the adapter has no unscoped entry point, and every memory call takes the org first', async () => {
  const text = await source('lib/server/memwal.ts');
  const exported = [...text.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g)].map(
    ([, name, params]) => ({ name, params: params.trim() }),
  );
  const names = exported.map((e) => e.name).sort();
  assert.deepEqual(names, ['memwalConfigured', 'memwalHealth', 'recallForOrg', 'rememberForOrg']);
  for (const { name, params } of exported.filter((e) => /^(recall|remember)/.test(e.name))) {
    assert.match(params, /^orgId:\s*string\s*,/, `${name} takes orgId: string first`);
  }
  assert.doesNotMatch(text, /export\s+(const|let)\s+\w*client/i, 'the client is not exported');

  // Nothing else talks to the SDK, so nothing else can pick a namespace.
  const offenders = [];
  for (const file of await sourceFiles()) {
    if (file === 'lib/server/memwal.ts') continue;
    if ((await source(file)).includes("from '@mysten-incubation/memwal'")) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'only lib/server/memwal.ts imports the MemWal SDK');
});

// ── 2 · Support tickets ─────────────────────────────────────────────────────

test('support: org B can neither list, read nor reply to org A\'s ticket; staff can see both', async () => {
  // The in-process fallback (no DATABASE_URL). The same scoping in Postgres is
  // pinned by tests/support-persistence.test.mjs.
  const support = await import('../lib/server/support.ts');
  const ticket = await support.createSupportTicket(ORG_A, {
    type: 'complaint',
    subject: 'Batch stuck',
    message: 'Our PH supplier batch has not moved.',
    email: 'ops@acme.example',
  });
  assert.equal(ticket.orgId, ORG_A, 'the ticket carries its org');
  await support.createSupportTicket(ORG_B, { type: 'other', subject: 'Receipt', message: 'Where is it?' });

  const listedForB = await support.listSupportTickets(ORG_B);
  assert.ok(listedForB.length >= 1);
  assert.ok(listedForB.every((t) => t.orgId === ORG_B), 'org B lists only its own tickets');
  assert.ok(!listedForB.some((t) => t.id === ticket.id));

  assert.equal(await support.readSupportTicket(ORG_B, ticket.id), null, 'a foreign id reads as missing');
  assert.equal(
    await support.updateSupportTicket(ORG_B, ticket.id, { actor: 'b@bravo.example', actorType: 'customer', replyMessage: 'mine now' }),
    null,
    'a foreign id cannot be replied to',
  );
  assert.equal((await support.readSupportTicket(ORG_A, ticket.id)).replies.length, 0, 'and nothing was written');

  assert.equal((await support.readSupportTicket(ORG_A, ticket.id))?.id, ticket.id, 'the owner still reads it');
  assert.ok((await support.listSupportTicketsForStaff()).some((t) => t.id === ticket.id), 'staff lists every tenant');
  assert.equal((await support.readSupportTicketForStaff(ticket.id))?.id, ticket.id);
  assert.equal((await support.listSupportTickets('')).length, 0, 'an empty org lists nothing');
});

// ── 3 · Walrus blobs ────────────────────────────────────────────────────────

test('walrus: a blob is served only to the org whose invoice or receipt references it (in-process stores)', async () => {
  const { persistInvoice } = await import('../lib/server/invoices-store.ts');
  const { persistTransfer, patchTransfer } = await import('../lib/server/transfers-store.ts');
  const { orgReferencesBlob } = await import('../lib/server/walrus-access.ts');

  const now = new Date().toISOString();
  await persistInvoice({
    id: 'inv_ws2_a', orgId: ORG_A, issuerOrg: 'Acme', amountUsd: '10', targetCurrency: 'PHP', dueDate: '2026-11-01',
    status: 'draft', payLinkSlug: 'ws2-a', walrusBlobId: 'blob_invoice_a', createdAt: now, updatedAt: now,
  });
  await persistTransfer({
    id: 'ti_ws2_a', orgId: ORG_A, state: 'SETTLED', recipientName: 'Mabuhay', targetCurrency: 'PHP',
    targetAmount: '560', sourceAmountUsd: '10', walrusBlobId: 'blob_receipt_a', createdAt: now, updatedAt: now,
  });
  await patchTransfer('ti_ws2_a', { evidence: { walrusBlobId: 'blob_evidence_a' } });

  for (const blob of ['blob_invoice_a', 'blob_receipt_a', 'blob_evidence_a']) {
    assert.equal(await orgReferencesBlob(ORG_A, blob), true, `org A owns ${blob}`);
    assert.equal(await orgReferencesBlob(ORG_B, blob), false, `org B does not own ${blob}`);
  }
  assert.equal(await orgReferencesBlob(ORG_A, 'blob_nobody'), false, 'an unreferenced blob belongs to nobody');
  assert.equal(await orgReferencesBlob('', 'blob_invoice_a'), false, 'no org owns nothing');
  assert.equal(await orgReferencesBlob(ORG_A, ''), false, 'an empty id is nothing');
});

async function migratedDb() {
  const client = new PGlite();
  const schema = await import('../lib/db/schema.ts');
  const db = drizzle(client, { schema });
  const files = (await readdir(new URL('../drizzle', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sqlText = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
  await client.exec(`INSERT INTO organizations (id, name) VALUES ('${ORG_A}', 'Acme'), ('${ORG_B}', 'Bravo')`);
  return { client, db };
}

test('walrus: the Postgres lookups are scoped by org (invoice blob, transfer blob, receipt evidence blob)', async () => {
  const invoicesRepo = await import('../lib/server/repository/invoices.ts');
  const transfersRepo = await import('../lib/server/repository/transfers.ts');
  const { client, db } = await migratedDb();

  await invoicesRepo.insertInvoice(db, {
    id: 'inv_a', orgId: ORG_A, issuerOrg: 'Acme', amountUsd: '10', targetCurrency: 'PHP', dueDate: '2026-11-01',
    status: 'draft', payLinkSlug: 'pg-a', walrusBlobId: 'pg_blob_invoice',
  });
  await transfersRepo.insertTransfer(db, {
    id: 'ti_a', orgId: ORG_A, state: 'AUTHORIZED', recipientName: 'Mabuhay', targetCurrency: 'PHP',
    targetAmount: '560', sourceAmountUsd: '10', quoteId: 'q', exchangeRate: '56', deliveryTier: 'PAYOUT_ONLY',
    suiTxDigest: null, receiptObjectId: null, failureReason: null, failedAtState: null,
    walrusBlobId: 'pg_blob_receipt',
    metadata: { evidence: { walrusBlobId: 'pg_blob_evidence' } },
  });

  assert.equal(await invoicesRepo.findInvoiceIdByBlob(db, ORG_A, 'pg_blob_invoice'), 'inv_a');
  assert.equal(await invoicesRepo.findInvoiceIdByBlob(db, ORG_B, 'pg_blob_invoice'), null);
  assert.equal(await transfersRepo.findTransferIdByBlob(db, ORG_A, 'pg_blob_receipt'), 'ti_a');
  assert.equal(await transfersRepo.findTransferIdByBlob(db, ORG_A, 'pg_blob_evidence'), 'ti_a');
  assert.equal(await transfersRepo.findTransferIdByBlob(db, ORG_B, 'pg_blob_receipt'), null);
  assert.equal(await transfersRepo.findTransferIdByBlob(db, ORG_B, 'pg_blob_evidence'), null);
  assert.equal(await transfersRepo.findTransferIdByBlob(db, ORG_A, 'pg_blob_invoice'), null);
  await client.close();
});

// ── 4 · Daily audit batches ─────────────────────────────────────────────────

test('audit batches: every reader is named for staff, and nothing unscoped is exported', async () => {
  const text = await source('lib/server/audit-batches.ts');
  const exported = [...text.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(([, name]) => name);
  for (const name of exported) {
    if (name === 'verifyMerkleProof' || name === 'buildDailyAuditBatch') continue; // pure / the cron job
    assert.match(name, /ForStaff$/, `${name} reads every tenant's settlements, so it says so`);
  }
  assert.ok(exported.includes('listDailyAuditBatchesForStaff'));
  assert.ok(exported.includes('verifyDailyAuditBatchForStaff'));
});

// ── Source scan: the routes use the guards ──────────────────────────────────

const MEMBER_ROUTES = [
  'app/api/support/tickets/route.ts',
  'app/api/support/tickets/[id]/route.ts',
  'app/api/walrus/[blobId]/route.ts',
  'app/api/memwal/behaviors/route.ts',
];

const STAFF_ROUTES = [
  'app/api/admin/support/route.ts',
  'app/api/admin/support/[id]/route.ts',
  'app/api/audit-batches/route.ts',
  'app/api/audit-batches/verify/route.ts',
];

test('member routes take the org from the session: requireCustomerRequest, then requireSessionAccount', async () => {
  for (const file of MEMBER_ROUTES) {
    const text = await source(file);
    assert.match(text, /requireCustomerRequest\(request\)/, `${file} authenticates the caller`);
    assert.match(text, /requireSessionAccount\(auth\.session\)/, `${file} resolves the caller's org`);
    assert.doesNotMatch(text, /ForStaff\b/, `${file} never reaches across tenants`);
    assert.doesNotMatch(text, /body\.orgId|searchParams\.get\(['"]org/, `${file} never takes the org from the request`);
  }
});

test('support member routes pass the session org first to every store call', async () => {
  for (const file of ['app/api/support/tickets/route.ts', 'app/api/support/tickets/[id]/route.ts']) {
    const text = await source(file);
    for (const [, call] of text.matchAll(/\b((?:create|read|update|list)SupportTickets?)\(/g)) {
      assert.match(text, new RegExp(`${call}\\(accountCheck\\.account\\.orgId,`), `${file}: ${call} is scoped`);
    }
  }
});

test('the walrus route checks ownership before it touches the blob, answers 404 otherwise, and is never cached', async () => {
  const text = await source('app/api/walrus/[blobId]/route.ts');
  const owns = text.indexOf('orgReferencesBlob(accountCheck.account.orgId');
  const fetches = text.indexOf('retrieveBlob(');
  assert.ok(owns > 0, 'ownership is checked against the session org');
  assert.ok(fetches > owns, 'and before the blob is retrieved');
  assert.match(text, /status:\s*404/);
  assert.match(text, /no-store/, 'the blob is sensitive: no caching anywhere');
});

test('staff routes use the staff session and the *ForStaff readers, never the customer guard', async () => {
  for (const file of STAFF_ROUTES) {
    const text = await source(file);
    assert.match(text, /getAdminSession\(\)/, `${file} requires a staff session`);
    assert.doesNotMatch(text, /requireCustomerRequest/, `${file} is not reachable with a customer session`);
    assert.match(text, /ForStaff\(/, `${file} uses a *ForStaff reader`);
  }
  for (const file of ['app/admin/(console)/page.tsx', 'app/admin/(console)/support/page.tsx']) {
    const text = await source(file);
    assert.match(text, /listSupportTicketsForStaff\(\)/, `${file} reads tickets as staff`);
  }
});

test('the customer dashboard no longer calls the staff-only audit batch routes', async () => {
  const offenders = [];
  for (const file of await sourceFiles()) {
    // The staff console's own components may call the staff-only routes.
    if (!file.startsWith('app/dashboard') && !file.startsWith('components/')) continue;
    if (file.startsWith('components/admin/')) continue;
    if ((await source(file)).includes('/api/audit-batches')) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('staff can still read the audit batches: the console has a page that lists and verifies them', async () => {
  const page = await source('app/admin/(console)/audit-batches/page.tsx');
  assert.match(page, /listDailyAuditBatchesForStaff\(\)/, 'the page reads through the staff-only reader');
  const nav = await source('app/admin/(console)/layout.tsx');
  assert.match(nav, /href: '\/admin\/audit-batches'/, 'the console navigation links to it');
  const component = await source('components/admin/AdminAuditBatches.tsx');
  assert.match(component, /\/api\/audit-batches\/verify/, 'a leaf can be verified from the page');
});

test('profile-request functions that only staff may call are named for staff', async () => {
  const profile = await source('lib/server/customer-profile.ts');
  assert.match(profile, /export function listProfileRequestsForStaff\(/);
  assert.match(profile, /export function decideProfileRequestForStaff\(/);
  assert.doesNotMatch(profile, /export function (listAllRequests|decideProfileRequest)\(/);
  for (const file of await sourceFiles()) {
    if (file.startsWith('app/admin') || file.startsWith('app/api/admin') || file === 'lib/server/customer-profile.ts') continue;
    assert.doesNotMatch(await source(file), /ProfileRequests?ForStaff/, `${file} calls a staff-only profile function`);
  }
});

test('a reasoning trace reference is shown as text, not linked to a blob route that cannot serve it', async () => {
  const card = await source('components/oxwal/ActionCard.tsx');
  assert.doesNotMatch(card, /\/api\/walrus\/\$\{encodeURIComponent\(proposal\.explain\.reasoningTraceRef\)\}/);
});

// ── helpers ─────────────────────────────────────────────────────────────────

async function sourceFiles() {
  const out = [];
  async function walk(rel) {
    let entries;
    try {
      entries = await readdir(new URL(rel, root), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (['node_modules', '.next', '.git'].includes(entry.name)) continue;
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) await walk(`${child}/`);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(child.replace(/\/$/, ''));
    }
  }
  for (const dir of ['app/', 'lib/', 'components/']) await walk(dir);
  return out;
}
