/**
 * Section 4.6 review fixes.
 *
 *   - A payout's free text (its invoice reference, a party's name) is the
 *     business's own, so the evidence export masks any account-shaped run in
 *     it instead of refusing the whole document; the export still refuses a
 *     real leak elsewhere.
 *   - The evidence route answers a leak with a clear 422, never an unhandled 500,
 *     and does not decode its route parameter twice.
 *   - When Sumsub says the applicant exists (409), the applicant is looked up
 *     by its external user id so the reference is always learned and attached.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { assertEvidenceClean, EvidenceLeak, maskFreeText, sanitizeIsoEvidence } from '../lib/compliance/controls-evidence.ts';
import { kybProviderFromEnv } from '../lib/compliance/sumsub.ts';

const PROD = { NODE_ENV: 'production' };
const SUMSUB = { SUMSUB_APP_TOKEN: 'sbx:app-token', SUMSUB_SECRET_KEY: 'sumsub-secret-key' };

const iso = (over = {}) => ({
  messageDefinition: 'pacs.008.001.08',
  endToEndId: 'SPL-A1A1A1A1',
  uetr: '6f1c7e0a-1b2c-4d3e-8f90-a1a1a1a1a1a1',
  instructedAmount: { Ccy: 'USDC', value: '1000.000000' },
  settlementAmount: { Ccy: 'PHP', value: '56000.00' },
  exchangeRate: '56.000000',
  chargeBearer: 'SHAR',
  charges: [],
  debtor: { name: 'Acme Trading Sdn Bhd', registration: 'CINC ****2345', country: 'MY', wallet: `0x${'b2'.repeat(32)}` },
  creditor: { name: 'Dela Cruz Trading Corp', registration: 'CINC ****2345', town: 'Makati', country: 'PH' },
  creditorAgent: 'BNORPHMM',
  creditorAccountLast4: '7890',
  purposeCode: 'SUPP',
  relationship: 'SUPPLIER',
  sourceOfFunds: null,
  remittanceInfo: null,
  depositAddress: `0x${'c3'.repeat(32)}`,
  beneficiaryRef: 'ben_1',
  ...over,
});

test('an invoice reference with many digits does not stop the export', () => {
  for (const text of ['INV-2026-0345', 'Invoice 20260345', 'acct 1234 5678 9012']) {
    const clean = sanitizeIsoEvidence(iso({ remittanceInfo: text }));
    assert.doesNotThrow(() => assertEvidenceClean({ iso20022: clean }), text);
    assert.ok(clean.remittanceInfo && clean.remittanceInfo.length > 0);
  }
  const named = sanitizeIsoEvidence(iso({ creditor: { name: 'Acme 12345678 Ltd', registration: null, town: 'Makati', country: 'PH' } }));
  assert.doesNotThrow(() => assertEvidenceClean({ iso20022: named }));
});

test('free text keeps the last four digits only of an account-shaped run', () => {
  assert.equal(maskFreeText('INV-2026-0345'), 'INV-****0345');
  assert.equal(maskFreeText('Invoice 77'), 'Invoice 77');
  assert.equal(maskFreeText('x'.repeat(300)).length, 140);
  assert.ok(!maskFreeText('acct 1234 5678 9012').includes('5678'));
  assert.ok(!maskFreeText('DE89370400440532013000 paid').includes('0440532013'));
});

test('a real leak in the evidence is still refused', () => {
  assert.throws(() => assertEvidenceClean({ partner: { note: '0012-3456-7890' } }), EvidenceLeak);
});

test('the evidence route answers a leak with 422 and decodes its parameter once', () => {
  const text = readFileSync(new URL('../app/api/wallet/payments/[ref]/evidence/route.ts', import.meta.url), 'utf8');
  assert.match(text, /EvidenceLeak/);
  assert.match(text, /status: 422/);
  assert.ok(!/decodeURIComponent/.test(text));
  for (const f of ['sender-declaration', 'travel-rule']) {
    const t = readFileSync(new URL(`../app/api/wallet/payments/[ref]/${f}/route.ts`, import.meta.url), 'utf8');
    assert.ok(!/decodeURIComponent/.test(t), f);
  }
});

test('a 409 from Sumsub is followed by a lookup of the applicant, so its reference is learned', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, method: init?.method });
    if (url.includes('/resources/applicants?')) return new Response('{}', { status: 409 });
    if (url.includes('/resources/applicants/-;externalUserId=')) return new Response(JSON.stringify({ id: 'applicant-77' }), { status: 200 });
    if (url.includes('/resources/accessTokens')) return new Response(JSON.stringify({ token: 'act-1' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const s = await kybProviderFromEnv({ ...PROD, ...SUMSUB }, { fetcher }).createSession({ orgId: 'acme', kybCaseId: 'k', businessName: 'A', registrationNumber: '1' });
  assert.equal(s.applicantId, 'applicant-77');
  const lookup = calls.find((c) => c.url.includes('externalUserId='));
  assert.equal(lookup.method, 'GET');
  assert.match(lookup.url, /externalUserId=org%3Aacme\/one$/);
});

test('a 409 whose lookup finds nothing still opens the session, with no applicant reference', async () => {
  const fetcher = async (url) => {
    if (url.includes('/resources/applicants?')) return new Response('{}', { status: 409 });
    if (url.includes('/resources/accessTokens')) return new Response(JSON.stringify({ token: 'act-2' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const s = await kybProviderFromEnv({ ...PROD, ...SUMSUB }, { fetcher }).createSession({ orgId: 'acme', kybCaseId: 'k', businessName: 'A', registrationNumber: '1' });
  assert.deepEqual([s.applicantId, s.accessToken], [null, 'act-2']);
});
