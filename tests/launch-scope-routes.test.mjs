import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { before } from 'node:test';

/**
 * LAUNCH_SCOPE=stablecoin on the real route handlers: every fiat, settlement
 * and treasury door answers 403 not_in_launch_scope before it reads a body,
 * touches a store or calls a partner, and the approval executor records an
 * out-of-scope approval without carrying it out. tests/launch-scope.test.mjs
 * pins the rules and that every such route calls the guard; this proves the
 * guard sits in front of the work.
 *
 * `cookies()` and `after()` exist only inside a Next request, so they are
 * stubbed as in tests/approved-payout-once.test.mjs. No database: nothing
 * here should get far enough to need one.
 */

process.env.LAUNCH_SCOPE = 'stablecoin';
process.env.CUSTOMER_SESSION_SECRET = 'launch-scope-routes-session-secret-0123456789abcdef0123456789';
process.env.CRON_SECRET = 'launch-scope-cron-secret';
process.env.FUNDING_WEBHOOK_SECRET = 'launch-scope-webhook-secret';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
delete process.env.DATABASE_URL;

const scope = { cookies: new Map(), deferred: [] };
globalThis.__launchScopeRoutes = scope;
const stubModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const NEXT_HEADERS = stubModule(`
  const jar = () => globalThis.__launchScopeRoutes.cookies;
  export async function cookies() {
    return {
      get: (name) => (jar().has(name) ? { name, value: jar().get(name) } : undefined),
      getAll: () => [...jar()].map(([name, value]) => ({ name, value })),
      has: (name) => jar().has(name),
      set: () => {},
      delete: () => {},
    };
  }
  export async function headers() { return new Headers(); }
`);
const NEXT_SERVER = stubModule(`
  export * from 'next/server.js';
  export function after(task) { globalThis.__launchScopeRoutes.deferred.push(task); }
`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/headers') return { url: NEXT_HEADERS, shortCircuit: true };
    if (specifier === 'next/server') return { url: NEXT_SERVER, shortCircuit: true };
    if (context.parentURL?.startsWith('data:')) return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    return nextResolve(specifier, context);
  },
});

const ORIGIN = 'http://localhost:3000';
let session;

before(async () => {
  session = await import('@/lib/auth/customer-session');
  const s = session.createCustomerSessionFromIdentity({ email: 'maker@acme.test', credentialVersion: 1 });
  scope.cookies = new Map([[session.CUSTOMER_SESSION_COOKIE, session.createCustomerSessionToken(s, process.env.CUSTOMER_SESSION_SECRET)]]);
});

/** A POST that would do real work if it got past the guard. */
const post = (url, body = {}, headers = {}) =>
  new Request(`${ORIGIN}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: JSON.stringify(body) });

async function refused(res, label) {
  assert.equal(res.status, 403, `${label}: ${res.status}`);
  const body = await res.json();
  assert.equal(body.code, 'not_in_launch_scope', label);
}

test('customer routes: transfers, batches, treasury, funding and rate holds refuse, and nothing is deferred', async () => {
  const cases = [
    ['@/app/api/transfers/authorize/route', '/api/transfers/authorize', { recipientName: 'Maria', amountUsd: 500, targetCurrency: 'PHP' }],
    ['@/app/api/batches/authorize/route', '/api/batches/authorize', { batchId: 'b1' }],
    ['@/app/api/treasury/route', '/api/treasury', { action: 'allocate', amountUsd: 100 }],
    ['@/app/api/funding/sessions/route', '/api/funding/sessions', { amountUsd: 100 }],
    ['@/app/api/rate-holds/route', '/api/rate-holds', { targetCurrency: 'PHP', amountUsd: 100 }],
  ];
  for (const [mod, url, body] of cases) {
    const route = await import(mod);
    await refused(await route.POST(post(url, body)), url);
  }
  assert.equal(scope.deferred.length, 0, 'no settlement was handed to after()');
});

test('webhooks and cron jobs refuse once their secret checks out, and still answer 401 without it', async () => {
  const deposits = await import('@/app/api/funding/deposits/route');
  await refused(await deposits.POST(post('/api/funding/deposits', { sessionId: 's' }, { 'x-funding-webhook-secret': process.env.FUNDING_WEBHOOK_SECRET })), 'funding/deposits');
  const usd = await import('@/app/api/funding/usd-deposits/route');
  await refused(await usd.POST(post('/api/funding/usd-deposits', { sessionId: 's' }, { 'x-funding-webhook-secret': process.env.FUNDING_WEBHOOK_SECRET })), 'funding/usd-deposits');

  const auth = { authorization: `Bearer ${process.env.CRON_SECRET}` };
  for (const job of ['audit-batch', 'update-peg', 'accrue-yield', 'settle-withdrawals']) {
    const route = await import(`@/app/api/cron/${job}/route`);
    await refused(await route.POST(post(`/api/cron/${job}`, {}, auth)), job);
    const anonymous = await route.POST(post(`/api/cron/${job}`));
    assert.equal(anonymous.status, 401, `${job} without the secret is still 401`);
  }
});

test('an approval of an out-of-scope payment is recorded, not carried out', async () => {
  const { executeApprovedProposal } = await import('@/lib/server/approval-execution');
  const proposal = { id: 'prop_scope_1', orgId: 'acme', kind: 'PAYMENT', createdBy: 'usr_maker' };
  const outcome = await executeApprovedProposal(proposal, { amountUsd: 500 }, { cookie: '', origin: ORIGIN });
  assert.equal(outcome.state, 'SKIPPED');
  assert.match(outcome.detail, /not executed/);
  assert.match(outcome.detail, /USDC on Sui only/);
});
