import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import {
  acceptTermsFor,
  orgHasCurrentTerms,
  readOnboardingStateForOrg,
} from '../lib/server/onboarding.ts';
import { TERMS_VERSION } from '../content/legal.ts';

/**
 * Onboarding: the derived stepper state, against real migrations.
 *
 * The design under test is that setup progress is COMPUTED from records the
 * product already keeps, never stored — so these tests write ordinary rows
 * (an org, a terms acceptance, a KYB state, a settings row, a supplier) and
 * assert the steps flip, with no onboarding-specific write beyond terms.
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

async function seedOrg(client, { id = 'org_onb', kyb = 'REGISTERED' } = {}) {
  await client.exec(
    `INSERT INTO organizations (id, name, kyb_lifecycle) VALUES ('${id}', 'Onboarding Test Co', '${kyb}')`,
  );
  await client.exec(
    `INSERT INTO users (id, email, name, password_hash, email_verified_at)
     VALUES ('usr_onb', 'onb@test.example', 'Onb', 'scrypt$1$1$1$x$x', now())`,
  );
  return id;
}

test('a fresh org has nothing done, and the state says so honestly', async () => {
  const { client, db } = await migratedDb();
  const orgId = await seedOrg(client);
  const state = await readOnboardingStateForOrg(db, orgId);

  assert.equal(state.intent, null);
  assert.deepEqual(
    state.steps.map((s) => [s.id, s.done]),
    [['terms', false], ['profile', false], ['verify', false], ['approvals', false], ['recipient', false]],
  );
  assert.equal(state.complete, false);
  assert.equal(state.kyb.blocked, true, 'REGISTERED cannot move money');
  assert.match(state.kyb.reason, /Verification has not started/);
  await client.close();
});

test('accepting the terms is idempotent, versioned, and flips exactly one step', async () => {
  const { client, db } = await migratedDb();
  const orgId = await seedOrg(client);

  await acceptTermsFor(db, { userId: 'usr_onb', orgId });
  await acceptTermsFor(db, { userId: 'usr_onb', orgId });
  const rows = await client.query('SELECT version FROM terms_acceptances');
  assert.equal(rows.rows.length, 1, 'accepting twice writes once');
  assert.equal(rows.rows[0].version, TERMS_VERSION);

  const state = await readOnboardingStateForOrg(db, orgId);
  assert.equal(state.steps[0].done, true);
  assert.equal(state.steps[1].done, false, 'no other step moved');
  await client.close();
});

test('an OLD terms version does not satisfy the current gate', async () => {
  const { client, db } = await migratedDb();
  const orgId = await seedOrg(client);
  await client.exec(
    `INSERT INTO terms_acceptances (id, user_id, org_id, version) VALUES ('t1', 'usr_onb', '${orgId}', '2020-01-01')`,
  );
  assert.equal(await orgHasCurrentTerms(db, orgId), false, 'a version bump re-asks everyone');
  await client.close();
});

test('the KYB step reads the lifecycle the admin console writes — no onboarding write involved', async () => {
  const { client, db } = await migratedDb();
  const orgId = await seedOrg(client, { kyb: 'KYB_SUBMITTED' });

  let state = await readOnboardingStateForOrg(db, orgId);
  assert.equal(state.steps[2].done, false);
  assert.equal(state.steps[2].pending, true, 'submitted reads as in review');

  await client.exec(`UPDATE organizations SET kyb_lifecycle = 'ACTIVE' WHERE id = '${orgId}'`);
  state = await readOnboardingStateForOrg(db, orgId);
  assert.equal(state.steps[2].done, true);
  assert.equal(state.kyb.blocked, false);
  await client.close();
});

test('profile, approvals and recipient steps derive from ordinary rows; 1-4 complete the setup', async () => {
  const { client, db } = await migratedDb();
  const orgId = await seedOrg(client, { kyb: 'ACTIVE' });
  await acceptTermsFor(db, { userId: 'usr_onb', orgId });
  await client.exec(
    `UPDATE organizations SET legal_name = 'Onboarding Test Co Sdn Bhd', registration_number = 'SSM-123', address_country = 'MY' WHERE id = '${orgId}'`,
  );
  await client.exec(`INSERT INTO org_settings (org_id, updated_by) VALUES ('${orgId}', 'usr_onb')`);

  let state = await readOnboardingStateForOrg(db, orgId);
  assert.equal(state.complete, true, 'the recipient step is optional by design');
  assert.equal(state.steps[4].done, false);

  await client.exec(
    `INSERT INTO suppliers (id, org_id, name, country, bank_name, swift, account_ref)
     VALUES ('sup1', '${orgId}', 'Mabuhay Logistics', 'PH', 'BDO', 'BNORPHMM', 'ref-1')`,
  );
  state = await readOnboardingStateForOrg(db, orgId);
  assert.equal(state.steps[4].done, true);
  await client.close();
});

test('migration 0019 backfills intent=pay only for orgs with payment history', async () => {
  const sqlText = await readFile(new URL('../drizzle/0019_onboarding_terms_intent.sql', import.meta.url), 'utf8');
  assert.match(sqlText, /UPDATE "organizations" SET "intent" = 'pay'/);
  assert.match(sqlText, /EXISTS \(SELECT 1 FROM "payment_intents"/);
  assert.match(sqlText, /"intent" IS NULL/, 'a chosen intent is never overwritten');
});

/* ── The lock contract: presentation reads the same gates the routes enforce ── */

test('the shell locks from a server-resolved prop and reroutes to setup — it invents no gate', async () => {
  const shell = await readFile(new URL('../components/dashboard/DashboardShell.tsx', import.meta.url), 'utf8');
  assert.match(shell, /locks\?: \{ termsDone: boolean; moneyBlocked: boolean; custodyOn: boolean; reason: string \}/);
  assert.match(shell, /function lockReasonFor\(/);
  assert.match(shell, /lockReason \? '\/dashboard\/setup' : href/);
  assert.doesNotMatch(shell, /kybGateEnabled|readOrgKybState|getDb/, 'the client shell must not reach the DB or the gate itself');

  const layout = await readFile(new URL('../app/dashboard/layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /readOnboardingState/);
  assert.match(layout, /custodyPhaseEnabled\(\)/);
  assert.match(layout, /moneyBlocked: kyb\.blocked/, 'the lock is the KYB gate, not a copy of it');
  assert.match(layout, /if \(needsIntent\) redirect\('\/onboarding\/intent'\)/);
});

test('every money-adjacent route asks for the terms beside its other gates', async () => {
  for (const file of [
    'app/api/transfers/authorize/route.ts',
    'app/api/batches/authorize/route.ts',
    'app/api/recipients/route.ts',
    'app/api/invoices/route.ts',
  ]) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(text, /requireTermsAccepted\(/, `${file} must gate on the terms`);
  }
  const gate = await readFile(new URL('../lib/server/onboarding.ts', import.meta.url), 'utf8');
  assert.match(gate, /status: 412/);
  assert.match(gate, /terms_not_accepted/);
});
