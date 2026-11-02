/**
 * The routes and the pages for how a business's limits start (v2 Phase 3, Sky's decision), read as source the way
 * tests/limits-routes.test.mjs and tests/limits-ui-review.test.mjs read the rest, because the claims are about which
 * gate a route opens at, whose business it uses, which route a button calls and what the words say.
 *
 *   routes     answers and "Ask for higher limits" start at the session gate and use the session's business and person
 *   setup      the three questions are in the existing setup page, in plain words, labelled, and post to the one route
 *   limits     the owner sees "We started you at ..." and a one-tap "Ask for higher limits"; the Controls and Limits
 *              figures sit together in one block that says which payments each one holds
 *   queue      the staff card shows the KYB tier, the answers and the last 30 days, and the approvals it needs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function handler(text, method) {
  const start = text.indexOf(`export async function ${method}`);
  assert.ok(start >= 0, `${method} is exported`);
  const next = text.indexOf('export async function', start + 10);
  return text.slice(start, next < 0 ? undefined : next);
}

const ROUTES = {
  'app/api/limits/answers/route.ts': ['saveLimitAnswers', true],
  'app/api/limits/answers/ask/route.ts': ['askForHigherFromAnswers', true],
};

test('the answers routes start at the session gate, take the business and the actor from it, and call one service function', () => {
  for (const [path, [fn, limited]] of Object.entries(ROUTES)) {
    assert.ok(existsSync(new URL(path, root)), path);
    const text = code(read(path));
    const body = handler(text, 'POST');
    assert.match(body, /await limitsRoute\(request\)/, `${path} opens at the gate`);
    assert.ok(body.indexOf('limitsRoute') < body.indexOf(fn), `${path}: the gate comes before the work`);
    assert.match(body, /if \(gate\.response\) return gate\.response/);
    assert.match(body, /orgId: gate\.route\.orgId/, `${path}: the business is the session's`);
    assert.match(body, /actorUserId: gate\.route\.authority\.userId/, `${path}: the actor is the signed-in person`);
    assert.doesNotMatch(body, /body\.(orgId|actor|userId|businessId|org|requested|kind|limits?)\b/, `${path}: nothing about whose it is, or what to ask for, comes from the request`);
    if (limited) assert.match(body, /limitChanges\(/, `${path} is rate limited`);
    assert.match(body, new RegExp(`\\b${fn}\\(`));
  }
  const save = code(read('app/api/limits/answers/route.ts'));
  assert.match(save, /monthlyUsdc: body\.monthlyUsdc/);
  assert.match(save, /paymentsPerWeek: body\.paymentsPerWeek/);
  assert.match(save, /firstTransferUsdc: body\.firstTransferUsdc/);
});

test('only those routes write the answers or start a limit from them', () => {
  const writers = ['saveLimitAnswers', 'askForHigherFromAnswers'];
  const files = ['app/api/limits/requests/route.ts', 'app/api/admin/limits/[id]/route.ts', 'app/api/onboarding/profile/route.ts', 'components/settings/LimitsCard.tsx', 'components/onboarding/SetupStepper.tsx', 'lib/server/onboarding.ts'];
  for (const file of files) {
    const text = code(read(file));
    for (const fn of writers) assert.doesNotMatch(text, new RegExp(`\\b${fn}\\b`), `${file} does not call ${fn} itself`);
    assert.doesNotMatch(text, /\.(insert|update|delete)\((?:schema\.)?businessLimitAnswers\b/, `${file} does not write the answers`);
  }
  assert.match(code(read('lib/server/onboarding.ts')), /limitAnswersNeeded\(/, 'the setup state asks whether to show the questions');
});

test('the staff decision route tells the owners only when the request is decided, not at a first approval', () => {
  const route = code(read('app/api/admin/limits/[id]/route.ts'));
  assert.match(route, /result\.stage/);
  assert.match(route, /stage === 'decided'|stage !== 'first_approval'/);
  assert.ok(route.indexOf('result.stage') < route.indexOf('sendLimitNotices('), 'the stage is read before anyone is told');
});

// ─── The setup page ──────────────────────────────────────────────────────────

const setup = code(read('components/onboarding/SetupStepper.tsx'));

test('the three questions are in the existing setup page, in plain words, each with its own label', () => {
  assert.match(setup, /state\.limitStart\.ask/);
  assert.match(setup, /How much do you expect to transfer each month\?/);
  assert.match(setup, /How many payments do you expect to make each week\?/);
  assert.match(setup, /How much will your first transfer into your wallet be\?/);
  assert.equal((setup.match(/<label/g) ?? []).length >= 6, true, 'the profile fields and the three questions are labelled');
  assert.match(setup, /\/api\/limits\/answers/);
  assert.match(setup, /inputMode="decimal"/);
  assert.match(setup, /inputMode="numeric"/);
  assert.match(setup, /autoComplete="off"/);
  assert.doesNotMatch(setup, /placeholder="(?:How|Enter)/, 'a label, not a placeholder, asks the question');
  assert.match(setup, /USDC/);
});

test('the questions say what they are for, and a refused answer is said beside its question', () => {
  assert.match(setup, /We use your answers to set your starting limits/);
  assert.match(setup, /aria-invalid/);
  assert.match(setup, /aria-describedby/);
  assert.match(setup, /problems\.(monthlyUsdc|paymentsPerWeek|firstTransferUsdc)|problems\[/);
});

test('the setup questions are an add-on to the existing flow: no second onboarding page or route was made', () => {
  assert.equal(existsSync(new URL('app/onboarding/limits', root)), false);
  assert.equal(existsSync(new URL('app/api/onboarding/limits', root)), false);
  assert.equal(existsSync(new URL('app/api/onboarding/answers', root)), false);
});

// ─── The Limits screen ───────────────────────────────────────────────────────

const card = code(read('components/settings/LimitsCard.tsx'));
const settings = code(read('components/settings/SettingsPage.tsx'));

test('the Limits screen shows "We started you at ..." and a one-tap Ask for higher limits that uses the request path', () => {
  assert.match(card, /data\.start/);
  assert.match(card, /start\.headline/);
  assert.match(card, /Ask for higher limits/);
  assert.match(card, /\/api\/limits\/answers\/ask/);
  assert.match(card, /start\.canAskHigher/);
  assert.match(card, /canAsk/, 'only owners are offered it');
  assert.match(card, /disabled=\{asking\}|disabled=\{busy\}/, 'a second tap while it is asking does nothing');
  assert.match(card, /start\.ask/, 'a business that has not answered can answer here');
  assert.match(card, /\/api\/limits\/answers['"`]/);
  assert.doesNotMatch(card, /dangerouslySetInnerHTML/, 'the owner’s own words are only ever text');
});

test('Settings, Controls and the Limits figures are shown together in one block that says which payments each one holds', () => {
  assert.match(card, /controls\?: \{|controls: \{|controls\??:/);
  assert.match(card, /controlsAndLimitsWords\(/);
  assert.match(settings, /<LimitsCard controls=\{/);
  assert.match(settings, /perTransferLimitUsd/);
  assert.match(settings, /dailyLimitUsd/);
  assert.doesNotMatch(card, /lower one (always )?wins/i, 'the code never holds a payment to both, so the page does not claim it');
  assert.match(card, /Settings, Controls/);
});

test('the Limits card no longer promises a ceiling it does not have', () => {
  assert.doesNotMatch(card, /Most Splash offers|This is the most Splash offers/);
  assert.doesNotMatch(card, /Every business starts with the same four/);
  assert.doesNotMatch(card, /atCeiling/);
});

test('nothing on these pages breaks the copy rules', () => {
  for (const [name, text] of [['setup', setup], ['card', card], ['queue', code(read('components/admin/AdminLimitRequests.tsx'))]]) {
    assert.doesNotMatch(text, /coming soon|\bdemo\b|testnet|non-custodial|coral/i, name);
    assert.ok(!text.includes('—'), `${name}: no em dash`);
  }
});

// ─── The staff card ──────────────────────────────────────────────────────────

const queue = code(read('components/admin/AdminLimitRequests.tsx'));

test('the staff card shows the KYB tier, the answers and the last 30 days beside the request, and what approval it needs', () => {
  assert.match(queue, /request\.context/);
  assert.match(queue, /KYB tier/);
  assert.match(queue, /context\.answers/);
  assert.match(queue, /Last 30 days/);
  assert.match(queue, /use30\./);
  assert.match(queue, /approvals\.needed/);
  assert.match(queue, /approvals\.first/);
  assert.match(queue, /youApprovedFirst/);
  assert.match(queue, /waitingFor/);
  assert.match(queue, /two people|second approval/i);
  assert.match(queue, /stage/);
  assert.doesNotMatch(queue, /most Splash will ever grant/i, 'the ceiling sentence is gone');
  assert.doesNotMatch(queue, /dangerouslySetInnerHTML/);
});

test('the first approver is not offered the button again, and the card says why', () => {
  assert.match(queue, /youApprovedFirst/);
  assert.match(queue, /You approved this first/);
  assert.match(queue, /disabled=\{[^}]*youApprovedFirst/);
});
