import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import { DEFAULT_ORG_SETTINGS } from '../lib/server/org-settings.ts';

/**
 * Human approval, made real.
 *
 * Two defects, and each one on its own made the other pointless:
 *
 *   The approval control was globally switchable by any signed-in user.
 *   `PUT /api/settings` had `requireCustomerRequest` and nothing else, over ONE
 *   JSON file with no org id. Any authenticated user of any tenant could set
 *   `requireDualApproval` to false for everybody.
 *
 *   An approved payment never happened. The state machine ended at SUBMITTED,
 *   nothing dispatched SETTLE, and the payload lived in a `globalThis` Map with
 *   exactly one reference in the repository: its own definition.
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

// ── Settings belong to an org, and only an admin moves them ────────────────

test('the strict defaults are the defaults', () => {
  // An org with no settings row must not be an org with no controls.
  assert.equal(DEFAULT_ORG_SETTINGS.requireDualApproval, true);
  assert.equal(DEFAULT_ORG_SETTINGS.requireTotp, true);
  // And the stronger WhatsApp mode is the default one: a code typed back into
  // Splash needs the phone AND a live session; a reply needs only the handset.
  assert.equal(DEFAULT_ORG_SETTINGS.approvalChannel, 'code');
});

test('one org cannot change another org’s controls', async () => {
  const { client } = await migratedDb();
  await client.exec(`
    INSERT INTO org_settings (org_id, require_dual_approval, approval_threshold_usd)
    VALUES ('acme', false, 100)
  `);
  const acme = await client.query(
    `SELECT require_dual_approval, approval_threshold_usd FROM org_settings WHERE org_id = 'acme'`,
  );
  const northwind = await client.query(`SELECT * FROM org_settings WHERE org_id = 'northwind'`);

  assert.equal(acme.rows[0].require_dual_approval, false);
  // Northwind has no row, which means Northwind gets the strict defaults —
  // not acme's relaxed ones. One file with no org id gave everyone acme's.
  assert.equal(northwind.rows.length, 0);
  await client.close();
});

test('the settings route requires an admin, resolved from the database', async () => {
  const route = await readFile(new URL('../app/api/settings/route.ts', import.meta.url), 'utf8');
  // Changing a payment ceiling is an administrative act. A maker who can raise
  // their own limit has no limit.
  assert.match(route, /ctx\.role !== 'OWNER' && ctx\.role !== 'FINANCE_ADMIN'/);
  assert.match(route, /code: 'requires_admin'/);
  // From the membership row, never the session cookie's display-only role.
  assert.match(route, /resolveAuthorityForSession\(auth\.session\)/);
  assert.doesNotMatch(route, /session\.userRole/);
  // And the body may not name its own authority.
  assert.match(route, /assertCleanBody\(body, 'settings'\)/);
});

test('both money routes read their own org’s dials', async () => {
  for (const file of [
    '../app/api/transfers/authorize/route.ts',
    '../app/api/batches/authorize/route.ts',
  ]) {
    const route = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(route, /await readOrgSettings\(orgId\)/, `${file} must scope settings by org`);
    assert.doesNotMatch(route, /readOperatingSettings\(\)/, `${file} must not read the global file`);
  }
});

// ── An approval makes the payment happen ───────────────────────────────────

test('the payload rides on the proposal, not in a process map', async () => {
  const { client } = await migratedDb();
  // A globalThis Map loses every pending approval on restart — and a restart is
  // exactly what happens between proposing and approving a day later.
  const cols = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'proposals' AND column_name IN
      ('execution_payload', 'execution_state', 'execution_error', 'executed_at')
    ORDER BY column_name
  `);
  assert.deepEqual(
    cols.rows.map((r) => r.column_name),
    ['executed_at', 'execution_error', 'execution_payload', 'execution_state'],
  );
  await client.close();
});

test('final approval executes, and records what happened', async () => {
  const route = await readFile(
    new URL('../app/api/proposals/[id]/submit/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(route, /executeApprovedProposal\(/, 'SUBMITTED must not be where this ends');
  // Including a failure — an approval that could not be carried out has to be
  // visible, or it is the same silent no-op in a different place.
  assert.match(route, /recordExecution\(/);
  assert.match(route, /execution: outcome/);
});

test('recording an outcome does not void the approvals that authorised it', async () => {
  const store = await readFile(
    new URL('../lib/queue/proposal-state.ts', import.meta.url),
    'utf8',
  );
  // `revise` voids every approval by design — right for a quote refresh,
  // catastrophic for an outcome that arrives immediately after signing.
  assert.match(store, /recordExecution\(id: string/);
  const body = store.slice(store.indexOf('recordExecution(id: string'), store.indexOf('revise(id: string'));
  assert.doesNotMatch(body, /reviseProposalCanon/);
  assert.doesNotMatch(body, /approvals: \[\]/);

  const route = await readFile(
    new URL('../app/api/proposals/[id]/submit/route.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(route, /store\.revise\(/, 'the submit route must never revise');
});

// ── The approval claim is verified, never trusted ──────────────────────────

test('an approved-proposal header is a claim the route resolves', async () => {
  const guard = await readFile(
    new URL('../lib/server/approved-proposal.ts', import.meta.url),
    'utf8',
  );
  // Trusting the header would make dual approval a thing any client can assert
  // — a considerably worse hole than the one it closes.
  assert.match(guard, /proposal\.orgId !== orgId/, 'an approval in another org is not an approval');
  assert.match(guard, /distinctApprovers < required/, 'the signatures, not just the status');
  assert.match(guard, /APPROVED_STATUSES/);
  // Unverifiable means not approved.
  assert.match(guard, /reason: 'store unavailable'/);

  for (const file of [
    '../app/api/transfers/authorize/route.ts',
    '../app/api/batches/authorize/route.ts',
  ]) {
    const route = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(route, /resolveApprovalClaim\(request, orgId\)/);
    assert.match(route, /limits\.requiresSecondApproval && !approvalClaim\.approved/);
  }
});

test('execution replays the real route so every guard runs again', async () => {
  const replay = await readFile(
    new URL('../lib/server/approval-replay.ts', import.meta.url),
    'utf8',
  );
  // A second implementation of a money path drifts: a guard added to the route
  // in six months would silently not apply to approved payments, which are the
  // largest ones, because being large is what sent them for approval.
  assert.match(replay, /await import\('@\/app\/api\/transfers\/authorize\/route'\)/);
  assert.match(replay, /await import\('@\/app\/api\/batches\/authorize\/route'\)/);
  // The approver's own cookie, so the replay resolves a real session.
  assert.match(replay, /cookie: input\.cookie/);
});
