import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * v2 Phase 2 §4.6: what every compliance route asks before it answers.
 * These are source checks in the repo's usual way (tests/store-scoping): the
 * routes import server-only modules, so what is pinned here is the order and
 * the presence of the gates, which a later edit must not drop.
 */

const strip = (text) => text.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = async (file) => strip(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));

const WALLET_ROUTES = [
  'app/api/wallet/payments/[ref]/evidence/route.ts',
  'app/api/wallet/payments/[ref]/travel-rule/route.ts',
  'app/api/wallet/payments/[ref]/sender-declaration/route.ts',
];

test('every wallet compliance route takes its business from the session, before anything else', async () => {
  for (const file of WALLET_ROUTES) {
    const text = await read(file);
    assert.match(text, /walletRoute\(request\)/, file);
    // The session gate is the first await in the handler.
    const handler = text.slice(text.indexOf('export async function'));
    assert.match(handler, /^[^\n]*\n\s*const gate = await walletRoute\(request\);\n\s*if \(gate\.response\) return gate\.response;/, file);
    // No business, account or user id is read from the request.
    assert.doesNotMatch(text, /body\.(orgId|org|businessId|userId|accountId)|searchParams\.get\('(orgId|org|businessId|userId)'\)/, file);
  }
});

test('payment evidence and the sender declaration are for owners and staff; the Travel Rule message for those who may ask', async () => {
  assert.match(await read(WALLET_ROUTES[0]), /requirePayoutReader\(gate\.route\)/);
  assert.match(await read(WALLET_ROUTES[2]), /requirePayoutReader\(gate\.route\)/);
  assert.match(await read(WALLET_ROUTES[1]), /requireWithdrawalRequester\(gate\.route\)/);
});

test('the Travel Rule route refuses in production without Sumsub before it reads the body', async () => {
  const text = await read(WALLET_ROUTES[1]);
  const provider = text.indexOf('travelRuleProviderOrRefusal()');
  assert.ok(provider > 0);
  assert.ok(provider < text.indexOf('readJsonBody('), 'the provider is checked before the body is read');
  assert.ok(text.indexOf('limitWalletRequests(') > 0 && text.indexOf('limitWalletRequests(') < provider, 'the rate limit comes first');
});

test('the evidence and the sender declaration read the chain and write a PDF, so each is rate limited for its person, in its own bucket', async () => {
  for (const [file, rule] of [[WALLET_ROUTES[0], 'controlsEvidenceUser'], [WALLET_ROUTES[2], 'complianceReadUser']]) {
    const text = await read(file);
    assert.ok(text.includes(`enforceRateLimit({ rule: RATE_LIMITS.${rule}, key: gate.route.authority.userId })`), file);
    const handler = text.slice(text.indexOf('export async function'));
    assert.ok(handler.indexOf('requirePayoutReader(') < handler.indexOf(`RATE_LIMITS.${rule}`), `${file}: role first, then the limit`);
  }
});

test('opening a Sumsub verification is an owner act, limited per business', async () => {
  const text = await read('app/api/kyb/sumsub/route.ts');
  assert.match(text, /requireSessionAccount\(auth\.session\)/);
  assert.match(text, /authority\.role !== 'OWNER'/);
  assert.match(text, /enforceRateLimit\(\{ rule: RATE_LIMITS\.kybSessionOrg, key: orgId \}\)/);
  assert.ok(text.indexOf("authority.role !== 'OWNER'") < text.indexOf('RATE_LIMITS.kybSessionOrg'), 'the owner check comes first');
  assert.ok(text.indexOf('RATE_LIMITS.kybSessionOrg') < text.indexOf('createSession('), 'the limit comes before the provider is asked');
});

test('the screening route takes the business from the session, and limits the person', async () => {
  const text = await read('app/api/compliance/screenings/route.ts');
  assert.match(text, /requireSessionAccount\(auth\.session\)/);
  assert.match(text, /authority\.orgId !== accountCheck\.account\.orgId/);
  assert.match(text, /canAskForWithdrawal\(authority\.role\)/);
  assert.match(text, /enforceRateLimit\(/);
  assert.match(text, /orgId: accountCheck\.account\.orgId/);
  assert.doesNotMatch(text, /body\.(orgId|org|businessId|userId)/);
});

test('the Sumsub webhook is the one compliance route with no session: signature, window and one claim instead', async () => {
  const text = await read('app/api/webhooks/sumsub/route.ts');
  assert.doesNotMatch(text, /requireSessionAccount|requireCustomerRequest/);
  assert.match(text, /handleSumsubWebhook\(/);
  assert.match(text, /MAX_BODY_BYTES/);
  assert.match(text, /applyKyb: \(orgId, next\) => setOrgKybState\(orgId, next, 'PROVIDER'\)/);
});
