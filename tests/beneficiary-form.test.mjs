import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import { getRecipient, insertRecipient } from '../lib/server/repository/recipients.ts';
import { missingTravelRuleFields } from '../lib/compliance/travel-rule.ts';

/**
 * The beneficiary a partner can actually file a travel-rule record for.
 *
 * Splash collected a name, an account number and an optional SWIFT code.
 * Migration 0006 gave `suppliers` everything FATF R.16 asks — legal identity,
 * address, per-corridor routing — and nothing wrote a single one of those
 * columns. Migration 0012 does the same for the ORIGINATOR half, which had no
 * home at all: the registration number lived in an in-memory KYB case and the
 * address nowhere.
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
  await client.exec(`INSERT INTO organizations (id, name) VALUES ('acme', 'Acme Trading')`);
  return { client, db };
}

const base = {
  id: 'rcpt_1',
  orgId: 'acme',
  name: 'Mabuhay Logistics Inc',
  country: 'PH',
  bank: '',
  swift: '',
  account: '',
  tier: 'PAYOUT_ONLY',
  kybStatus: 'none',
  createdVia: 'manual',
};

const fullTravelRule = {
  beneficiaryType: 'BUSINESS',
  legalName: 'Mabuhay Logistics Incorporated',
  registrationNumber: 'CS201812345',
  addressLine1: '12 Ayala Avenue',
  addressCity: 'Makati',
  addressCountry: 'PH',
  bankName: 'BDO Unibank',
  bankIdScheme: 'LOCAL_BANK_CODE',
  bankIdValue: 'BDOPH',
  bankAccountNumber: '001234567890',
  bankAccountName: 'Mabuhay Logistics Inc',
};

// ── The columns are actually written ────────────────────────────────────────

test('the travel-rule half survives a round trip', async () => {
  const { client, db } = await migratedDb();
  await insertRecipient(db, { ...base, travelRule: fullTravelRule });

  const read = await getRecipient(db, 'acme', 'rcpt_1');
  assert.equal(read.travelRule.legalName, 'Mabuhay Logistics Incorporated');
  assert.equal(read.travelRule.registrationNumber, 'CS201812345');
  assert.equal(read.travelRule.addressCity, 'Makati');
  assert.equal(read.travelRule.bankIdScheme, 'LOCAL_BANK_CODE');
  assert.equal(read.travelRule.bankIdValue, 'BDOPH');
  assert.equal(read.travelRule.bankAccountName, 'Mabuhay Logistics Inc');
  await client.close();
});

test('a beneficiary with no travel-rule record reads as having none, not as blank', async () => {
  const { client, db } = await migratedDb();
  await insertRecipient(db, base);
  const read = await getRecipient(db, 'acme', 'rcpt_1');
  // `undefined`, not an object of empty strings — a record of blanks would
  // satisfy a presence check while telling a partner nothing.
  assert.equal(read.travelRule, undefined);
  await client.close();
});

test('the display fields are derived from the routing record, not a second copy', async () => {
  const { client, db } = await migratedDb();
  await insertRecipient(db, {
    ...base,
    swift: 'STALEBIC',
    account: 'stale-account',
    travelRule: { ...fullTravelRule, bankIdScheme: 'SWIFT_BIC', bankIdValue: 'BNORPHMM' },
  });

  const read = await getRecipient(db, 'acme', 'rcpt_1');
  // Two writable copies of a SWIFT code is how the screen and the record a
  // partner receives come to disagree.
  assert.equal(read.swift, 'BNORPHMM');
  assert.equal(read.account, '001234567890');
  await client.close();
});

test('the originator has columns of its own now', async () => {
  const { client } = await migratedDb();
  await client.exec(`
    UPDATE organizations SET registration_number = '202401012345',
      address_line1 = '1 Jalan Sultan', address_city = 'Kuala Lumpur', address_country = 'MY'
    WHERE id = 'acme'
  `);
  const rows = await client.query(
    `SELECT registration_number, address_city, address_country FROM organizations WHERE id = 'acme'`,
  );
  // R.16 has two halves. 0006 gave `suppliers` the beneficiary side and the
  // originator nothing, so a complete record could not be produced however
  // carefully the beneficiary was filled in.
  assert.equal(rows.rows[0].registration_number, '202401012345');
  assert.equal(rows.rows[0].address_city, 'Kuala Lumpur');
  assert.equal(rows.rows[0].address_country, 'MY');
  await client.close();
});

// ── The form asks the server, and the server decides ───────────────────────

test('the corridor decides the fields — the component does not list them', async () => {
  const component = await readFile(
    new URL('../components/transfer/TravelRuleFields.tsx', import.meta.url),
    'utf8',
  );
  // Every requirement comes from the engine via the endpoint. A hardcoded
  // field list is how a form starts demanding something nobody checks, or
  // omitting one everybody does.
  assert.match(component, /\/api\/compliance\/travel-rule/);
  assert.match(component, /corridor\?\.requiresBranchCode/);
  assert.match(component, /corridor\?\.requiresPurposeCode/);
  assert.match(component, /corridor\?\.requiresAccountNumber/);
  // And each one explains itself.
  assert.match(component, /item\.because/);
  assert.doesNotMatch(component, /CORRIDOR_RULES/, 'the rules live in one module, not two');
});

test('unchecked is not the same as complete', async () => {
  const component = await readFile(
    new URL('../components/transfer/TravelRuleFields.tsx', import.meta.url),
    'utf8',
  );
  // Before the first response lands there is no `check`, and the step must
  // stay gated rather than opening in the gap.
  assert.match(component, /onReadyChange\(Boolean\(check\?\.ready\)\)/);

  const step = await readFile(
    new URL('../components/transfer/StepBeneficiary.tsx', import.meta.url),
    'utf8',
  );
  assert.match(step, /usingSaved \|\| travelRuleReady/);
});

// ── And the route enforces the same rule ───────────────────────────────────

test('authorize refuses an incomplete record, naming what is missing', async () => {
  const route = await readFile(
    new URL('../app/api/transfers/authorize/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(route, /missingTravelRuleFields\(/, 'the same engine the form asks');
  assert.match(route, /code: 'travel_rule_incomplete'/);
  assert.match(route, /missing: travelRuleMissing/, 'the caller is told which fields');

  // The originator half is read from the org, never from the body — a request
  // that could supply it is one that could misstate who sent the money.
  assert.match(route, /const \{ originator \} = await readOriginator\(orgId\)/);
  assert.doesNotMatch(route, /originator: body\./);
});

test('what travelled is frozen on the payment, not joined to the beneficiary', async () => {
  const route = await readFile(
    new URL('../app/api/transfers/authorize/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(route, /travelRuleSnapshot\(\{/);
  // A beneficiary edited next week must not rewrite the record of a payment
  // already sent.
  assert.match(route, /must not\s*\n?\s*\/\/ silently rewrite|snapshot rather than a join/i);
});

test('a Philippine payment needs the corridor’s own routing identifier', () => {
  const originator = {
    legalName: 'Acme Trading Sdn Bhd',
    registrationNumber: '202401012345',
    accountReference: 'acme',
  };

  const incomplete = missingTravelRuleFields({
    destinationCountry: 'PH',
    beneficiary: { name: 'Mabuhay Logistics Inc' },
    originator,
    payment: {},
  });
  assert.ok(incomplete.length > 0);
  // Each one carries the reason, in the payer's words rather than a rule number.
  assert.ok(incomplete.every((item) => item.because.length > 20));
  assert.ok(incomplete.every((item) => item.label && !item.label.includes('.')));

  const complete = missingTravelRuleFields({
    destinationCountry: 'PH',
    beneficiary: { name: 'Mabuhay Logistics Inc', ...fullTravelRule },
    originator,
    // PH requires all four: BSP asks for a purpose on inbound remittance,
    // and partner banks ask the other two as ongoing due diligence.
    payment: {
      purposeCode: 'GDS',
      purposeDescription: 'Invoice 4471',
      sourceOfFunds: 'Trading revenue',
      beneficiaryRelationship: 'Supplier since 2024',
    },
  });
  assert.deepEqual(complete, [], 'a complete record passes');
});
