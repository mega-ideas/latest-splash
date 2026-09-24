import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import { resolveAuthorityFromDb, UnauthorizedError } from '../lib/auth/authority.ts';
import { OPEN_QUEUE_STATUSES, approvalWindowLabel, openProposalsForOrg } from '../lib/queue/queue-scope.ts';
import { viewerOrgId } from '../lib/server/viewer-org.ts';

/**
 * The approval queue is one workspace's, not everyone's.
 *
 * `/queue` checked only that a session existed, then listed the process-global
 * proposal store — which, after a cold start, is hydrated with every tenant's
 * open proposals — filtered by status alone. Any signed-in user, including a
 * brand-new account with no membership, saw every tenant's pending payments:
 * "Pay 25000 USD to <payee> in PHP", the amount, and the maker's id.
 */

delete process.env.DATABASE_URL;

function proposal(id, orgId, status, overrides = {}) {
  return {
    id,
    idempotencyKey: `idem_${id}`,
    kind: 'PAYMENT',
    status,
    tier: 'TIER_0_PROPOSE',
    orgId,
    corridor: 'PHP',
    unsignedTxBytes: 'abc',
    explain: {
      recommendation: `Pay 25000 USD to the payee of ${id} in PHP.`,
      financialImpact: { amountIn: 25_000_000_000n, currencyIn: 'USD' },
      evidence: [],
      confidence: 1,
      risk: 'MEDIUM',
      requiredApprovers: 2,
      reasoningTraceRef: 'test',
    },
    createdBy: `usr_maker_${orgId}`,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    approvals: [],
    ...overrides,
  };
}

const MIXED = [
  proposal('a_pending', 'org_a', 'PENDING_APPROVAL'),
  proposal('a_simulated', 'org_a', 'SIMULATED'),
  proposal('a_evaluated', 'org_a', 'POLICY_EVALUATED'),
  proposal('a_submitted', 'org_a', 'SUBMITTED'),
  proposal('a_rejected', 'org_a', 'REJECTED'),
  proposal('b_pending', 'org_b', 'PENDING_APPROVAL'),
  proposal('b_simulated', 'org_b', 'SIMULATED'),
];

const ids = (list) => list.map((p) => p.id);

function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

// ── The filter ──────────────────────────────────────────────────────────────

test('a workspace sees its own open proposals and none of another’s', () => {
  assert.deepEqual(ids(openProposalsForOrg(MIXED, 'org_a')), ['a_pending', 'a_simulated', 'a_evaluated']);
  assert.deepEqual(ids(openProposalsForOrg(MIXED, 'org_b')), ['b_pending', 'b_simulated']);
  assert.deepEqual(openProposalsForOrg(MIXED, 'org_c'), []);
});

test('no membership means no workspace, and nothing is shown', () => {
  // "Every org" is not a fallback for "no org".
  assert.deepEqual(openProposalsForOrg(MIXED, null), []);
  assert.deepEqual(openProposalsForOrg(MIXED, ''), []);
});

test('open means still maker-checker work: submitted, rejected and settled rows are not', () => {
  assert.deepEqual([...OPEN_QUEUE_STATUSES].sort(), ['PENDING_APPROVAL', 'POLICY_EVALUATED', 'SIMULATED']);
});

test('an approver sees how long is left, against the request’s clock', () => {
  const now = Date.parse('2026-09-24T10:00:00.000Z');
  assert.equal(approvalWindowLabel('2026-09-24T10:45:00.000Z', now), 'Expires in 45m');
  assert.equal(approvalWindowLabel('2026-09-25T09:30:00.000Z', now), 'Expires in 23h 30m');
  assert.equal(approvalWindowLabel('2026-09-24T09:59:00.000Z', now), 'Approval window closed');
  assert.equal(approvalWindowLabel('not a date', now), 'No expiry');
});

test('the real store, holding two tenants: each sees only its own', async () => {
  const { getOxwalProposalStore } = await import('../lib/agent/oxwal.ts');
  const store = getOxwalProposalStore();
  store.hydrate([
    proposal('store_a', 'org_store_a', 'PENDING_APPROVAL'),
    proposal('store_b', 'org_store_b', 'PENDING_APPROVAL'),
  ]);
  assert.deepEqual(ids(openProposalsForOrg(store.list(), 'org_store_a')), ['store_a']);
  assert.deepEqual(ids(openProposalsForOrg(store.list(), 'org_store_b')), ['store_b']);
});

// ── Whose workspace: the membership row, never the cookie ──────────────────

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
  await client.exec(`
    INSERT INTO organizations (id, name) VALUES ('org_a', 'A Co'), ('org_b', 'B Co');
    INSERT INTO users (id, email, name) VALUES
      ('u_a', 'ops@a.test', 'Ops A'),
      ('u_b', 'ops@b.test', 'Ops B'),
      ('u_new', 'new@signup.test', 'Just Signed Up');
    INSERT INTO memberships (id, user_id, org_id, role) VALUES
      ('m_a', 'u_a', 'org_a', 'checker'),
      ('m_b', 'u_b', 'org_b', 'maker');
  `);
  return { client, db };
}

test('the viewer’s workspace comes from their membership, and a new account has none', async () => {
  const { client, db } = await migratedDb();
  const fromDb = (session) => resolveAuthorityFromDb(db, session.email);

  assert.equal(await viewerOrgId({ email: 'ops@a.test' }, fromDb), 'org_a');
  assert.equal(await viewerOrgId({ email: 'ops@b.test' }, fromDb), 'org_b');
  // Signed up, never granted anything: a valid session and no workspace.
  assert.equal(await viewerOrgId({ email: 'new@signup.test' }, fromDb), null);
  // A session claiming an org does not get one: only the membership counts.
  assert.equal(await viewerOrgId({ email: 'new@signup.test', orgId: 'org_a' }, fromDb), null);

  // And through the filter: the new account sees nothing of A's or B's.
  assert.deepEqual(openProposalsForOrg(MIXED, await viewerOrgId({ email: 'new@signup.test' }, fromDb)), []);
  assert.deepEqual(
    ids(openProposalsForOrg(MIXED, await viewerOrgId({ email: 'ops@b.test' }, fromDb))),
    ['b_pending', 'b_simulated'],
  );
  await client.close();
});

test('with no database there is no membership to read, so nobody has a workspace', async () => {
  // The real resolver fails closed without DATABASE_URL: authority is never assumed.
  assert.equal(await viewerOrgId({ email: 'ops@a.test' }), null);
});

test('a failure to read the membership is an error, not an empty queue', async () => {
  const down = async () => {
    throw new Error('connection refused');
  };
  await assert.rejects(viewerOrgId({ email: 'ops@a.test' }, down), /connection refused/);
  const none = async () => {
    throw new UnauthorizedError();
  };
  assert.equal(await viewerOrgId({ email: 'ops@a.test' }, none), null);
});

// ── The page, and every other surface that reads the store ──────────────────

test('/queue lists only the viewer’s workspace', async () => {
  const page = code(await readFile(new URL('../app/queue/page.tsx', import.meta.url), 'utf8'));
  assert.match(page, /if \(!session\) \{\s*redirect\('\/login'\);/);
  assert.match(page, /const orgId = await viewerOrgId\(session\);/);
  assert.match(page, /openProposalsForOrg\(proposalStore\.list\(\), orgId\)/);
  // The only listing of the store on the page goes through the scope.
  assert.equal(page.match(/\.list\(\)/g)?.length, 1);
  assert.doesNotMatch(page, /item\.status === 'SIMULATED'/, 'the status filter moved into the scope, with the org');
});

function sourcesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourcesUnder(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

test('no page or API route lists the proposal store except through the org scope', () => {
  const readers = sourcesUnder('app').filter((path) => readFileSync(path, 'utf8').includes('getOxwalProposalStore'));
  assert.ok(readers.length > 0, 'the scan found the pages that read the store');
  for (const path of readers) {
    const text = code(readFileSync(path, 'utf8'));
    const listings = text.match(/\.list\(\)/g)?.length ?? 0;
    const scoped = text.match(/openProposalsForOrg\([A-Za-z_.]+\.list\(\), /g)?.length ?? 0;
    assert.equal(listings, scoped, `${path} lists the proposal store without scoping it to the viewer's org`);
  }

  // The one listing in lib/server looks up a proposal within a single org.
  const dual = code(readFileSync('lib/server/dual-approval.ts', 'utf8'));
  const dualListings = dual.match(/\.list\(\)/g)?.length ?? 0;
  const dualScoped = dual.match(/\.list\(\)\s*\.(?:find|filter)\(\((\w+)\) => \1\.orgId === input\.orgId/g)?.length ?? 0;
  assert.ok(dualListings > 0);
  assert.equal(dualListings, dualScoped, 'every listing in dual-approval.ts is filtered to one org');
});
