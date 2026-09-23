import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../lib/db/schema.ts';
import {
  CORRIDOR_RULES,
  corridorRule,
  missingTravelRuleFields,
  supportedCorridors,
  travelRuleSnapshot,
} from '../lib/compliance/travel-rule.ts';

/**
 * What a beneficiary record has to carry before a regulated payout can be made.
 *
 * The transfer form collected a business name, an account number and an
 * optional SWIFT. That is enough to render a row and not enough to pay anyone
 * in any supported corridor — PH clears on a bank code, the EU on IBAN, GB
 * domestic on a sort code. These tests pin the requirements per corridor so a
 * rule cannot be quietly dropped.
 */

/** A beneficiary with everything a strict corridor asks for. */
const completeBeneficiary = {
  name: 'Mabuhay Logistics Inc',
  legalName: 'Mabuhay Logistics Incorporated',
  beneficiaryType: 'BUSINESS',
  registrationNumber: 'CS201812345',
  addressLine1: '12 Ayala Avenue',
  addressCity: 'Makati',
  addressState: 'Metro Manila',
  addressPostalCode: '1226',
  addressCountry: 'PH',
  bankName: 'BPI',
  bankIdScheme: 'LOCAL_BANK_CODE',
  bankIdValue: '010040018',
  bankCountry: 'PH',
  bankAccountNumber: '1234567890',
  bankAccountName: 'Mabuhay Logistics Inc',
};

const completeOriginator = {
  legalName: 'Acme Trading Sdn Bhd',
  registrationNumber: '202401012345',
  addressLine1: 'Level 12, Menara Splash',
  addressCity: 'Kuala Lumpur',
  addressCountry: 'MY',
  accountReference: 'acct_acme_001',
};

const completePayment = {
  purposeCode: 'GSC',
  purposeDescription: 'Freight services, invoice INV-2291',
  sourceOfFunds: 'Trading revenue',
  beneficiaryRelationship: 'Supplier',
};

const complete = {
  destinationCountry: 'PH',
  beneficiary: completeBeneficiary,
  originator: completeOriginator,
  payment: completePayment,
};

const fieldsOf = (result) => result.map((r) => r.field);

test('a complete record for a supported corridor is accepted', () => {
  assert.deepEqual(missingTravelRuleFields(complete), []);
});

// ── What the old form collected ─────────────────────────────────────────────

test('name plus account number plus SWIFT — what the form used to collect — is not enough', () => {
  const missing = missingTravelRuleFields({
    destinationCountry: 'PH',
    originator: completeOriginator,
    // The old form had no purpose, source of funds or relationship field at all.
    payment: {},
    beneficiary: {
      name: 'Mabuhay Logistics Inc',
      bankIdScheme: 'SWIFT_BIC',
      bankIdValue: 'BOPIPHMM',
      bankAccountNumber: '1234567890',
    },
  });
  // Every one of these was simply absent from the product.
  const f = fieldsOf(missing);
  assert.ok(f.includes('beneficiary.beneficiaryType'));
  assert.ok(f.includes('beneficiary.addressLine1'));
  assert.ok(f.includes('beneficiary.bankName'));
  assert.ok(f.includes('beneficiary.bankAccountName'));
  assert.ok(f.includes('payment.purposeCode'));
  assert.ok(f.includes('payment.sourceOfFunds'));
  assert.ok(f.includes('payment.beneficiaryRelationship'));
});

// ── R.16, the originator half ───────────────────────────────────────────────

test('the originator needs a name, an account reference and one more identifier', () => {
  const missing = missingTravelRuleFields({ ...complete, originator: {} });
  const f = fieldsOf(missing);
  assert.ok(f.includes('originator.legalName'));
  assert.ok(f.includes('originator.accountReference'));
  assert.ok(f.includes('originator.addressLine1'));
});

test('a registration number satisfies the originator identifier instead of an address', () => {
  const missing = missingTravelRuleFields({
    ...complete,
    originator: { legalName: 'Acme', accountReference: 'acct_1', registrationNumber: '202401012345' },
  });
  assert.equal(fieldsOf(missing).includes('originator.addressLine1'), false);
});

// ── Identity differs by beneficiary type ────────────────────────────────────

test('a business needs a registration number; an individual needs a birth date or national ID', () => {
  const business = missingTravelRuleFields({
    ...complete,
    beneficiary: { ...completeBeneficiary, registrationNumber: null },
  });
  assert.ok(fieldsOf(business).includes('beneficiary.registrationNumber'));

  const individual = missingTravelRuleFields({
    ...complete,
    beneficiary: {
      ...completeBeneficiary,
      beneficiaryType: 'INDIVIDUAL',
      registrationNumber: null,
      dateOfBirth: null,
      nationalIdNumber: null,
    },
  });
  assert.ok(fieldsOf(individual).includes('beneficiary.dateOfBirth'));

  // Either identifier resolves it — screening a name alone produces false hits.
  const withDob = missingTravelRuleFields({
    ...complete,
    beneficiary: { ...completeBeneficiary, beneficiaryType: 'INDIVIDUAL', registrationNumber: null, dateOfBirth: '1984-02-11' },
  });
  assert.equal(fieldsOf(withDob).includes('beneficiary.dateOfBirth'), false);
});

// ── Corridor routing ────────────────────────────────────────────────────────

test('the EU routes on IBAN and does not ask for a separate account number', () => {
  const rule = corridorRule('EU');
  assert.deepEqual(rule.bankIdSchemes, ['IBAN']);
  assert.equal(rule.requiresAccountNumber, false, 'an IBAN already encodes the account');

  const missing = missingTravelRuleFields({
    destinationCountry: 'EU',
    beneficiary: {
      ...completeBeneficiary,
      addressCountry: 'DE',
      bankName: 'Commerzbank',
      bankIdScheme: 'IBAN',
      bankIdValue: 'DE89370400440532013000',
      bankAccountNumber: null,
      bankCountry: 'DE',
    },
    originator: completeOriginator,
    payment: { ...completePayment, purposeCode: null },
  });
  assert.deepEqual(missing, [], 'SEPA needs neither an account number nor a purpose code');
});

test('a SWIFT code is refused where the corridor routes on something else', () => {
  const missing = missingTravelRuleFields({
    destinationCountry: 'GB',
    beneficiary: { ...completeBeneficiary, addressCountry: 'GB', bankIdScheme: 'SWIFT_BIC', bankIdValue: 'BARCGB22' },
    originator: completeOriginator,
    payment: completePayment,
  });
  // GB accepts SWIFT for international, so this one passes — the assertion is
  // that the ACCEPTED set is consulted rather than a single hardcoded scheme.
  assert.equal(fieldsOf(missing).includes('beneficiary.bankIdScheme'), false);

  const wrong = missingTravelRuleFields({
    destinationCountry: 'EU',
    beneficiary: { ...completeBeneficiary, addressCountry: 'DE', bankIdScheme: 'GB_SORT_CODE', bankIdValue: '20-00-00' },
    originator: completeOriginator,
    payment: completePayment,
  });
  assert.ok(fieldsOf(wrong).includes('beneficiary.bankIdScheme'), 'SEPA does not route on a sort code');
});

test('Singapore and Thailand ask for a branch code; the Philippines does not', () => {
  assert.equal(CORRIDOR_RULES.SG.requiresBranchCode, true);
  assert.equal(CORRIDOR_RULES.TH.requiresBranchCode, true);
  assert.equal(CORRIDOR_RULES.PH.requiresBranchCode, false);

  const missing = missingTravelRuleFields({
    destinationCountry: 'SG',
    beneficiary: {
      ...completeBeneficiary,
      addressCountry: 'SG',
      bankIdScheme: 'SWIFT_BIC',
      bankIdValue: 'DBSSSGSG',
      bankBranchCode: null,
    },
    originator: completeOriginator,
    payment: completePayment,
  });
  assert.ok(fieldsOf(missing).includes('beneficiary.bankBranchCode'));
});

test('purpose of payment is required exactly where the regulator asks for it', () => {
  const withoutPurpose = { ...completePayment, purposeCode: null };
  for (const country of ['PH', 'MY', 'ID', 'TH', 'VN']) {
    const missing = missingTravelRuleFields({
      ...complete,
      destinationCountry: country,
      beneficiary: { ...completeBeneficiary, bankIdScheme: 'SWIFT_BIC', bankIdValue: 'BOPIPHMM', bankBranchCode: '001' },
      payment: withoutPurpose,
    });
    assert.ok(fieldsOf(missing).includes('payment.purposeCode'), `${country} requires a purpose code`);
  }
  for (const country of ['SG', 'GB', 'EU']) {
    assert.equal(CORRIDOR_RULES[country].requiresPurposeCode, false, `${country} does not`);
  }
});

test('an unsupported destination is refused rather than guessed at', () => {
  const missing = missingTravelRuleFields({ ...complete, destinationCountry: 'ZZ' });
  assert.ok(fieldsOf(missing).includes('beneficiary.bankCountry'));
  assert.match(missing.at(-1).because, /Splash holds routing rules for/);
});

test('every requirement explains itself in words a payer would understand', () => {
  const missing = missingTravelRuleFields({
    destinationCountry: 'PH',
    beneficiary: {},
    originator: {},
    payment: {},
  });
  assert.ok(missing.length > 8);
  for (const req of missing) {
    assert.ok(req.label.length > 0 && !req.label.includes('_'), `${req.field} shows a field name`);
    assert.ok(req.because.length > 20, `${req.field} has no reason a payer could act on`);
  }
});

// ── The snapshot ────────────────────────────────────────────────────────────

test('the snapshot freezes what travelled, so editing the beneficiary later cannot rewrite it', () => {
  const snap = travelRuleSnapshot(complete);
  assert.equal(snap.standard, 'FATF-R16');
  assert.equal(snap.beneficiary.legalName, 'Mabuhay Logistics Incorporated');
  assert.equal(snap.beneficiary.accountNumber, '1234567890');
  assert.equal(snap.originator.legalName, 'Acme Trading Sdn Bhd');
  assert.match(snap.beneficiary.address, /Makati/);

  // A later edit produces a different snapshot and leaves the old one alone.
  const renamed = travelRuleSnapshot({
    ...complete,
    beneficiary: { ...completeBeneficiary, legalName: 'Renamed Holdings Bhd' },
  });
  assert.equal(snap.beneficiary.legalName, 'Mabuhay Logistics Incorporated');
  assert.equal(renamed.beneficiary.legalName, 'Renamed Holdings Bhd');
});

test('the snapshot is JSON-serialisable, since it is stored as jsonb', () => {
  const snap = travelRuleSnapshot(complete);
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
});

// ── The columns exist, and a migration creates them ──────────────────────────

test('every corridor named in the UI has a rule', () => {
  // These are the corridors the product lists on the dashboard.
  for (const country of ['PH', 'MY', 'ID', 'SG', 'TH', 'VN', 'GB', 'EU']) {
    assert.ok(corridorRule(country), `${country} is offered but has no routing rule`);
  }
  assert.equal(supportedCorridors().length, 8);
});

test('migration 0006 applies and the beneficiary columns exist', async () => {
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
  await client.exec(`
    INSERT INTO suppliers (
      id, org_id, name, country, beneficiary_type, legal_name, registration_number,
      address_line1, address_city, address_country,
      bank_name, bank_id_scheme, bank_id_value, bank_country, bank_account_number, bank_account_name
    ) VALUES (
      's1', 'acme', 'Mabuhay Logistics Inc', 'PH', 'BUSINESS', 'Mabuhay Logistics Incorporated', 'CS201812345',
      '12 Ayala Avenue', 'Makati', 'PH',
      'BPI', 'LOCAL_BANK_CODE', '010040018', 'PH', '1234567890', 'Mabuhay Logistics Inc'
    )
  `);

  const rows = await db.select().from(schema.suppliers);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bankIdScheme, 'LOCAL_BANK_CODE');
  assert.equal(rows[0].beneficiaryType, 'BUSINESS');
  assert.equal(rows[0].bankAccountName, 'Mabuhay Logistics Inc');

  // And the payment-side columns.
  await client.exec(`
    INSERT INTO payment_intents (
      id, org_id, supplier_id, state, source_amount_minor, source_currency,
      target_amount_minor, target_currency, purpose_code, source_of_funds,
      beneficiary_relationship, travel_rule_snapshot
    ) VALUES (
      'pi_1', 'acme', 's1', 'AUTHORIZED', 100000, 'USD', 5642000, 'PHP',
      'GSC', 'Trading revenue', 'Supplier', '{"version":1}'::jsonb
    )
  `);
  const intents = await db.select().from(schema.paymentIntents);
  assert.equal(intents[0].purposeCode, 'GSC');
  assert.deepEqual(intents[0].travelRuleSnapshot, { version: 1 });

  await client.close();
});
