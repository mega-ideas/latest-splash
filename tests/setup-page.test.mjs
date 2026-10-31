import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { copyViolations } from '../scripts/copy-rules.mjs';
import { setupSummary } from '../lib/setup-page/view.ts';

/**
 * v2 Phase 3, brief 5.9: Setup. The five steps stay (terms, business profile,
 * verification, approvals, a first recipient); what changes is that the page
 * says where the person is, what to do next and what unlocks, and that once
 * setup is complete it points to the next real things (the business wallet, a
 * first recipient, the team's rules) instead of staying a list of ticks.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const step = (id, done, over = {}) => ({ id, title: id, detail: '', done, href: `/x/${id}`, ...over });
const state = (flags, over = {}) => ({
  intent: 'pay',
  kyb: { state: 'REGISTERED', blocked: true, reason: 'Verify the business first.' },
  termsVersion: '2026-10',
  complete: flags.slice(0, 4).every(Boolean),
  steps: ['terms', 'profile', 'verify', 'approvals', 'recipient'].map((id, i) => step(id, flags[i], id === 'verify' && over.pending ? { pending: true } : {})),
  ...over.state,
});

test('a new workspace is at step one of four, with the terms next, and nothing unlocked', () => {
  const s = setupSummary(state([false, false, false, false, false]));
  assert.deepEqual([s.requiredDone, s.requiredTotal, s.complete], [0, 4, false]);
  assert.equal(s.next.id, 'terms');
  assert.equal(s.headline, 'Finish setting up this workspace');
  assert.match(s.progress, /0 of 4 required steps done/);
  assert.match(s.unlocks, /Payments unlock when/);
});

test('the next step is the first required one still to do, in order, and a step waiting on someone else is not the next', () => {
  assert.equal(setupSummary(state([true, false, false, false, false])).next.id, 'profile');
  assert.equal(setupSummary(state([true, true, false, false, false])).next.id, 'verify');
  const waiting = setupSummary(state([true, true, false, false, false], { pending: true }));
  assert.equal(waiting.next.id, 'approvals', 'verification is in review: the person can do the approvals meanwhile');
  assert.match(waiting.progress, /2 of 4 required steps done/);
  const onlyWaiting = setupSummary(state([true, true, false, true, false], { pending: true }));
  assert.equal(onlyWaiting.next, null);
  assert.match(onlyWaiting.headline, /Waiting for verification/);
  assert.match(onlyWaiting.subline, /nothing for you to do/i);
});

test('once the four required steps are done, setup is complete and points to what comes next', () => {
  const s = setupSummary(state([true, true, true, true, false]));
  assert.equal(s.complete, true);
  assert.equal(s.next, null);
  assert.equal(s.headline, 'Setup is complete');
  assert.deepEqual(s.after.map((a) => a.href), ['/dashboard/wallet', '/dashboard/recipients', '/dashboard/settings#team']);
  assert.deepEqual(s.after.map((a) => a.label), ['Create your business wallet', 'Save your first recipient', 'Give your team their rules']);
  // A first recipient already saved is not offered again.
  assert.deepEqual(setupSummary(state([true, true, true, true, true])).after.map((a) => a.href), ['/dashboard/wallet', '/dashboard/settings#team']);
});

test('the optional step is never counted as required', () => {
  const s = setupSummary(state([true, true, true, true, true]));
  assert.deepEqual([s.requiredDone, s.requiredTotal], [4, 4]);
  assert.deepEqual([setupSummary(state([false, false, false, false, true])).requiredDone, setupSummary(state([false, false, false, false, true])).requiredTotal], [0, 4]);
});

test('the words say what the money needs, and nothing is promised that setup does not decide', () => {
  const text = JSON.stringify([setupSummary(state([false, false, false, false, false])), setupSummary(state([true, true, true, true, true]))]);
  assert.doesNotMatch(text, /licen[cs]e|custod|Demo|Coming soon|testnet/i);
  assert.doesNotMatch(text, /—/, 'no long dash in prose');
});

test('an unreadable state is a sentence a customer can act on, with no developer instruction', () => {
  const page = code(read('app/dashboard/setup/page.tsx'));
  assert.doesNotMatch(page, /dev-db|DATABASE_URL|scripts\//);
  assert.match(page, /could not be read/);
  assert.match(page, /Nothing was changed/);
});

test('the stepper shows progress as a meter with words, highlights the next step, and links to where each step is done', () => {
  const s = code(read('components/onboarding/SetupStepper.tsx'));
  assert.match(s, /setupSummary\(state\)/);
  assert.match(s, /role="progressbar"/);
  assert.match(s, /aria-current="step"/);
  assert.match(s, /summary\.after/);
  assert.match(s, /href=\{step\.href\}/);
  // The two actions that are Setup's own are unchanged.
  assert.match(s, /\/api\/onboarding\/terms/);
  assert.match(s, /\/api\/onboarding\/profile/);
  assert.doesNotMatch(s, /E39774|coral|\bDemo\b|Coming soon|testnet/i);
});

test('the approvals step now lands on the controls in Settings, where approvals and rules are set', () => {
  assert.match(read('lib/server/onboarding.ts'), /href: '\/dashboard\/settings#controls'/);
});

test('the copy rules hold on every Setup file', () => {
  for (const file of ['app/dashboard/setup/page.tsx', 'components/onboarding/SetupStepper.tsx']) assert.deepEqual(copyViolations(file, read(file)), [], file);
});
