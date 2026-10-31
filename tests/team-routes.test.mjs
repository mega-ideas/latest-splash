/**
 * Every route that changes the team, the Finance lead, or who may Add funds
 * and Withdraw is wired the same default-deny way (v2 Phase 3):
 *
 *   - the business is the SESSION's (never a field of the request),
 *   - the actor is the signed-in person (never a field of the request),
 *   - the decision is made by the one service module (lib/server/team-admin.ts),
 *   - changes are rate limited,
 *   - nothing outside app/api/team calls a team-changing function.
 *
 * What each function decides, cross-tenant included, is tested against a real
 * database in tests/team-roles.test.mjs. This file checks the routes use them.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function walk(dir, out = []) {
  for (const name of readdirSync(new URL(dir, root))) {
    const rel = `${dir}${name}`;
    if (statSync(new URL(rel, root)).isDirectory()) walk(`${rel}/`, out);
    else out.push(rel);
  }
  return out;
}

const TEAM_ROUTES = {
  'app/api/team/route.ts': { GET: null, POST: 'addTeamMember' },
  'app/api/team/me/route.ts': { GET: null },
  'app/api/team/members/[userId]/route.ts': { PATCH: 'changeTeamMemberRole', DELETE: 'removeTeamMember' },
  'app/api/team/members/[userId]/access/route.ts': { PUT: 'setMemberAccess' },
  'app/api/team/finance-lead/route.ts': { POST: 'appointFinanceLead', DELETE: 'revokeFinanceLead' },
};

function handler(text, method) {
  const start = text.indexOf(`export async function ${method}`);
  assert.ok(start >= 0, `${method} is exported`);
  const next = text.indexOf('export async function', start + 10);
  return text.slice(start, next < 0 ? undefined : next);
}

test('the team routes exist, and each starts at the team gate before it does anything', () => {
  for (const [path, methods] of Object.entries(TEAM_ROUTES)) {
    assert.ok(existsSync(new URL(path, root)), path);
    const text = read(path);
    for (const method of Object.keys(methods)) {
      const h = code(handler(text, method));
      assert.match(h, /await teamRoute\(request\)/, `${path} ${method} opens with the gate`);
      assert.match(h, /if \(gate\.response\) return gate\.response;/, `${path} ${method} stops when the gate says no`);
      assert.ok(h.indexOf('teamRoute(request)') < h.indexOf('readJsonBody') || !h.includes('readJsonBody'), `${path} ${method} reads no body before the gate`);
    }
  }
});

test('the business and the actor come from the session in every team route, never from the request', () => {
  for (const [path, methods] of Object.entries(TEAM_ROUTES)) {
    const text = code(read(path));
    assert.doesNotMatch(text, /body\.(orgId|org|actorUserId|actor|businessId)\b/, `${path} takes no business or actor from the body`);
    assert.doesNotMatch(text, /searchParams\.get\(['"](orgId|org|actor|business)/, `${path} takes no business from the query`);
    for (const [method, service] of Object.entries(methods)) {
      if (!service) continue;
      const h = handler(text, method);
      assert.match(h, new RegExp(`${service}\\(gate\\.route\\.db, \\{[^}]*orgId: gate\\.route\\.orgId`), `${path} ${method} acts in the session's business`);
      assert.match(h, /actorUserId: gate\.route\.authority\.userId/, `${path} ${method} acts as the signed-in person`);
    }
  }
});

test('every team change is rate limited, per person and per business, before it runs', () => {
  for (const [path, methods] of Object.entries(TEAM_ROUTES)) {
    const text = read(path);
    for (const [method, service] of Object.entries(methods)) {
      if (!service) continue;
      const h = code(handler(text, method));
      assert.match(h, /await limitTeamChanges\(gate\.route\)/, `${path} ${method}`);
      assert.ok(h.indexOf('limitTeamChanges') < h.indexOf(service), `${path} ${method} limits first`);
    }
  }
  const gate = read('lib/server/team-route.ts');
  assert.match(gate, /teamChangeUser/);
  assert.match(gate, /teamChangeOrg/);
  assert.match(read('lib/server/rate-limit.ts'), /teamChangeUser:/);
  assert.match(read('lib/server/rate-limit.ts'), /teamChangeOrg:/);
});

test('the team gate reads the business from the session and fails closed without a membership', () => {
  const gate = code(read('lib/server/team-route.ts'));
  assert.match(gate, /requireCustomerRequest\(request\)/);
  assert.match(gate, /requireSessionAccount\(auth\.session\)/);
  assert.match(gate, /resolveAuthorityForSession\(auth\.session\)/);
  assert.match(gate, /authority\.orgId !== account\.account\.orgId/);
  assert.match(gate, /status: 403/);
  assert.doesNotMatch(gate, /liveWalletContext/, 'a team is managed without a business wallet');
});

test('nothing outside the team routes (and the service itself) calls a team-changing function: a new route cannot skip the rules', () => {
  const names = ['addTeamMember', 'changeTeamMemberRole', 'removeTeamMember', 'appointFinanceLead', 'revokeFinanceLead', 'setMemberAccess'];
  const allowed = new Set(Object.keys(TEAM_ROUTES).concat(['lib/server/team-admin.ts']));
  const offenders = [];
  for (const file of [...walk('app/'), ...walk('lib/'), ...walk('components/')]) {
    if (!/\.(ts|tsx)$/.test(file) || allowed.has(file)) continue;
    const text = code(read(file));
    for (const n of names) if (new RegExp(`\\b${n}\\s*\\(`).test(text)) offenders.push(`${file}: ${n}`);
  }
  assert.deepEqual(offenders, []);
});

test('the team list a manager reads is the session business\'s; a person who is not a manager gets the shape without emails', () => {
  const route = code(read('app/api/team/route.ts'));
  const get = handler(route, 'GET');
  assert.match(get, /listTeam\(gate\.route\.db, gate\.route\.orgId\)/);
  assert.match(get, /teamManager\(/);
  assert.match(get, /manager \?/, 'the people and the trail go to a manager only');
});

/* ── Add funds and Withdraw ───────────────────────────────────────────── */

const FUNDING_WRITES = [
  'app/api/wallet/funding/intents/route.ts',
  'app/api/wallet/funding/intents/[id]/route.ts',
  'app/api/wallet/funding/quotes/route.ts',
  'app/api/wallet/funding/deposits/route.ts',
  'app/api/wallet/funding/deposits/[id]/route.ts',
];

test('every Add funds route asks for the Add funds access an owner granted, and no route still lets any non-viewer in', () => {
  for (const path of FUNDING_WRITES) {
    const text = code(read(path));
    assert.doesNotMatch(text, /refuseViewer\(/, `${path} no longer lets any non-viewer through`);
    for (const method of ['POST', 'DELETE']) {
      if (!text.includes(`export async function ${method}`)) continue;
      assert.match(handler(text, method), /await requireFundsAccess\([^)]*'add_funds'/, `${path} ${method}`);
    }
  }
  const helper = code(read('lib/server/wallet-funding-route.ts'));
  assert.doesNotMatch(helper, /export function refuseViewer/, 'the old any-non-viewer gate is gone');
});

test('the funding sources stay owners-only', () => {
  for (const path of ['app/api/wallet/funding/sources/route.ts', 'app/api/wallet/funding/sources/[id]/route.ts', 'app/api/wallet/funding/sources/[id]/challenge/route.ts', 'app/api/wallet/funding/sources/[id]/verify/route.ts']) {
    const text = code(read(path));
    for (const method of ['POST', 'DELETE']) {
      if (text.includes(`export async function ${method}`)) assert.match(handler(text, method), /requireFundingOwner\(/, `${path} ${method}`);
    }
  }
});

test('every Withdraw route asks for the Withdraw access an owner granted; bank accounts and the deposit address are read by them only', () => {
  const quotes = code(read('app/api/wallet/withdrawals/quotes/route.ts'));
  assert.match(handler(quotes, 'POST'), /await requireFundsAccess\([^)]*'withdraw'/);
  const withdrawals = code(read('app/api/wallet/withdrawals/route.ts'));
  assert.match(handler(withdrawals, 'POST'), /await requireFundsAccess\([^)]*'withdraw'/);
  assert.match(handler(withdrawals, 'GET'), /fundsAccessOf\(|hasFundsAccess\(|await fundsAccess\(/, 'the list asks what this person may see');
  assert.doesNotMatch(handler(withdrawals, 'GET'), /canAskForWithdrawal/);
  const destinations = code(read('app/api/wallet/withdrawals/destinations/route.ts'));
  assert.match(handler(destinations, 'GET'), /await requireFundsAccess\([^)]*'withdraw'/);
  assert.match(handler(destinations, 'POST'), /requireOwner\(/, 'adding a bank account stays an owner\'s');
  const deposit = code(read('app/api/wallet/withdrawals/deposit-address/route.ts'));
  assert.match(handler(deposit, 'GET'), /await requireFundsAccess\([^)]*'withdraw'/);
  assert.match(handler(deposit, 'POST'), /requireOwner\(/);
  const one = code(read('app/api/wallet/withdrawals/[id]/route.ts'));
  assert.match(handler(one, 'GET'), /await requireFundsAccess\([^)]*'withdraw'/);
  const walletRoute = code(read('lib/server/wallet-route.ts'));
  assert.doesNotMatch(walletRoute, /export function requireWithdrawalRequester/, 'the any-staff gate is gone');
  assert.match(walletRoute, /export async function requireFundsAccess/);
});

test('the wallet overview carries what this person may do, from the server', () => {
  const route = code(read('app/api/wallet/overview/route.ts'));
  assert.match(route, /access:/);
  assert.match(route, /fundsAccessOf\(/);
});

/* ── The Finance lead on the wallet's own routes ──────────────────────── */

test('the Finance lead may start a request to add a signer and nothing else on the wallet: every other signer route stays an owner\'s', () => {
  const members = code(read('app/api/wallet/business/members/route.ts'));
  assert.match(members, /requireOwnerOrFinanceLead\(/);
  assert.match(members, /change === 'add_owner'/);
  const post = handler(members, 'POST');
  assert.match(post, /requireOwner\(route, 'change the business owners'\)|requireOwner\(/, 'removing an owner and the recovery party stay an owner\'s');
  for (const path of [
    'app/api/wallet/business/rotation/route.ts',
    'app/api/wallet/business/route.ts',
    'app/api/wallet/business/consent/route.ts',
    'app/api/wallet/persons-in-charge/route.ts',
  ]) {
    const text = code(read(path));
    assert.doesNotMatch(text, /FinanceLead/, `${path} knows nothing of the Finance lead`);
  }
  assert.match(code(read('app/api/wallet/business/rotation/route.ts')), /requireOwner\(route, 'change the wallet signers'\)/);
  assert.match(code(read('app/api/wallet/business/route.ts')), /requireOwner\(route, 'set up the business wallet'\)/);
});

test('the staff console\'s grant and revoke are on the trail too, under the operator\'s name', () => {
  const memberships = code(read('lib/server/memberships.ts'));
  assert.match(memberships, /member_added/);
  assert.match(memberships, /operator:/);
});
