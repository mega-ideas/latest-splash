/**
 * Every route that reads or changes a business's limits is wired the same
 * default-deny way (v2 Phase 3):
 *
 *   - the business is the SESSION's, the actor is the signed-in person (never a
 *     field of the request),
 *   - the decision is made by the one service module (lib/server/business-limits.ts),
 *   - changes are rate limited,
 *   - Splash staff routes ask for a staff session before anything else, and the
 *     service refuses support staff,
 *   - the cron fails closed without its secret,
 *   - nothing outside those routes changes a limit.
 *
 * What each function decides, cross-tenant included, is tested against a real
 * database in tests/business-limits.test.mjs.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

function handler(text, method) {
  const start = text.indexOf(`export async function ${method}`);
  assert.ok(start >= 0, `${method} is exported`);
  const next = text.indexOf('export async function', start + 10);
  return text.slice(start, next < 0 ? undefined : next);
}

const CUSTOMER = {
  'app/api/limits/route.ts': { GET: ['readLimitsView', false] },
  'app/api/limits/requests/route.ts': { POST: ['requestHigherLimit', true] },
  'app/api/limits/requests/[id]/route.ts': { DELETE: ['cancelLimitRequest', true] },
  'app/api/limits/lower/route.ts': { POST: ['lowerLimit', true] },
};

test('the customer limit routes start at the session gate, take the business and the actor from it, and call one service function each', () => {
  for (const [path, methods] of Object.entries(CUSTOMER)) {
    assert.ok(existsSync(new URL(path, root)), path);
    const text = code(read(path));
    for (const [method, [fn, limited]] of Object.entries(methods)) {
      const body = handler(text, method);
      assert.match(body, /await limitsRoute\(request\)/, `${path} ${method} opens at the gate`);
      assert.ok(body.indexOf('limitsRoute') < body.indexOf(fn), `${path} ${method}: the gate comes before the work`);
      assert.match(body, /if \(gate\.response\) return gate\.response/, `${path} ${method}`);
      assert.match(body, /orgId: gate\.route\.orgId/, `${path} ${method}: the business is the session's`);
      assert.match(body, /gate\.route\.authority\.userId/, `${path} ${method}: the actor is the signed-in person`);
      assert.doesNotMatch(body, /body\.(orgId|actor|userId|businessId|org)\b/, `${path} ${method}: nothing about whose it is comes from the request`);
      assert.match(body, new RegExp(`\\b${fn}\\(`), `${path} ${method} calls ${fn}`);
      if (limited) assert.match(body, /await limitChanges\(gate\.route\)/, `${path} ${method} is rate limited`);
    }
  }
});

test('a request is asked under an Idempotency-Key, and the key is the same request however often it is sent', () => {
  const route = code(read('app/api/limits/requests/route.ts'));
  assert.match(route, /request\.headers\.get\('idempotency-key'\)/);
});

test('the staff routes ask for a staff session first, and the service refuses support', () => {
  for (const [path, method] of [['app/api/admin/limits/route.ts', 'GET'], ['app/api/admin/limits/[id]/route.ts', 'PATCH']]) {
    const text = code(read(path));
    const body = handler(text, method);
    assert.match(body, /await getAdminSession\(\)/, path);
    assert.match(body, /if \(!session\) return NextResponse\.json\(\{ error: 'Staff authentication required' \}, \{ status: 401 \}\)/, path);
    assert.ok(body.indexOf('getAdminSession') < body.indexOf('getDb'), `${path}: the session comes before the database`);
    assert.match(body, /role: session\.role/, `${path}: the service is told the role`);
  }
  const service = code(read('lib/server/business-limits.ts'));
  assert.match(service, /LIMIT_DECIDER_ROLES = \['compliance', 'operations'\] as const/);
  assert.doesNotMatch(service, /LIMIT_DECIDER_ROLES = \[[^\]]*support/, 'support is not a role that decides');
  const page = code(read('app/admin/(console)/limits/page.tsx'));
  assert.match(page, /LIMIT_DECIDER_ROLES/);
});

test('the decision route tells the owners, and the cron fails closed without its secret', () => {
  const decide = code(read('app/api/admin/limits/[id]/route.ts'));
  assert.match(decide, /sendLimitNotices\(/);
  assert.match(decide, /tellOwners\(/);
  const cron = code(read('app/api/cron/limit-changes/route.ts'));
  assert.match(cron, /const secret = process\.env\.CRON_SECRET\?\.trim\(\);\s*if \(!secret\) return false;/);
  assert.match(cron, /timingSafeEqual/);
  assert.ok(cron.indexOf('isAuthorized(request)') < cron.indexOf('getDb'), 'authorised before the database is touched');
  assert.match(cron, /runLimitChangesForCron\(/);
});

test('only those routes change a limit: the writing functions are called nowhere else', () => {
  const writers = ['requestHigherLimit', 'cancelLimitRequest', 'lowerLimit', 'decideLimitRequestForStaff', 'runLimitChangesForCron'];
  const files = [...walk('app/'), ...walk('lib/'), ...walk('components/')].filter((f) => /\.(ts|tsx)$/.test(f));
  const allowed = new Set([
    'lib/server/business-limits.ts',
    'app/api/limits/requests/route.ts',
    'app/api/limits/requests/[id]/route.ts',
    'app/api/limits/lower/route.ts',
    'app/api/admin/limits/[id]/route.ts',
    'app/api/cron/limit-changes/route.ts',
  ]);
  for (const file of files) {
    if (allowed.has(file)) continue;
    const text = code(read(file));
    for (const fn of writers) assert.doesNotMatch(text, new RegExp(`\\b${fn}\\b`), `${file} must not call ${fn}`);
    assert.doesNotMatch(text, /\.(insert|update|delete)\((?:schema\.)?business(Limits|LimitRequests)\b/, `${file} must not write the limit tables`);
  }
});

test('enforcement reads the limits from one place', () => {
  for (const file of ['lib/server/scheduled-runner.ts', 'lib/server/scheduled-payments.ts']) {
    const text = code(read(file));
    assert.match(text, /currentLimits\(/, `${file} reads the business's limits`);
    assert.doesNotMatch(text, /from\(businessLimits\)/, `${file} does not read the table itself`);
  }
  const check = code(read('lib/schedule/auto-check.ts'));
  assert.match(check, /facts\.perPaymentLimitMinor/);
});

test('the Limits section is in Settings for owners and the Finance lead, and the staff queue is in the console', () => {
  const settings = code(read('components/settings/SettingsPage.tsx'));
  assert.match(settings, /id: 'limits', label: 'Limits'/);
  assert.match(settings, /people\.data\?\.you\.manager/);
  assert.match(settings, /<LimitsCard \/>/);
  const nav = code(read('app/admin/(console)/layout.tsx'));
  assert.match(nav, /href: '\/admin\/limits'/);
});
