import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { customerRefusal } from '../lib/server/wallet-refusal.ts';
import { settingsWallet } from '../lib/settings-page/wallet-gate.ts';
import { statTones } from '../lib/history-page/entries.ts';

/**
 * v2 Phase 3, brief 5.9, second pass: what Recipients, History, Settings and
 * Setup showed when the page was looked at on a desktop and on a phone, with the
 * business wallet not yet open for the workspace (the state every new business
 * starts in).
 *
 *  - A person was shown the names of server settings (SPLASH_CORE_PACKAGE_ID,
 *    DATABASE_URL) as an error. A refusal for a missing setting is now a plain
 *    sentence; the reason stays in the server log.
 *  - Three cards in a row each said the same thing about the wallet. One card
 *    now says it, and the cards that need a wallet appear when there is one.
 *  - On a phone the left column grew wider than the screen and clipped the cards.
 *  - A number was cut off in its box, a card title was a size of its own, a zero
 *    was in the colour of an alarm, and the Setup rail cut its words short.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* A refusal a customer can read ------------------------------------------------ */

const SETTING_NAMES = /SPLASH_[A-Z_]+|DATABASE_URL|SUI_NETWORK|WALLET_[A-Z_]+|\.env|0x\s*\+|64 hex|environment|env var/i;

test('a missing server setting is a sentence for the customer, and never the name of the setting', () => {
  for (const reason of [
    'the v2 wallet needs SPLASH_CORE_PACKAGE_ID, SPLASH_COMPLIANCE_CONFIG_ID, SPLASH_FEE_CONFIG_ID, SPLASH_ADDRESS_REGISTRY_ID (0x + 64 hex each)',
    'the business wallet needs the database, and DATABASE_URL is not set',
    'the business wallet is not open on mainnet: WALLET_MAINNET_ENABLED and WALLET_HARDWARE_CHECK_REF are not both set',
  ]) {
    const out = customerRefusal({ ok: false, status: 503, error: reason });
    assert.equal(out.status, 503, 'the status stays: the Wallet and Home pages read it as "not open yet"');
    assert.doesNotMatch(out.error, SETTING_NAMES, out.error);
    assert.match(out.error, /not available|not open/i);
    assert.match(out.error, /Nothing was changed/);
  }
});

test('the refusals that are the customer’s own are passed on in their words', () => {
  const own = { ok: false, status: 409, error: 'this business has no on-chain account yet, so it cannot have a business wallet' };
  assert.deepEqual(customerRefusal(own), { status: own.status, error: own.error });
  assert.equal(customerRefusal({ ok: false, status: 502, error: 'the chain did not answer' }).status, 502);
  assert.doesNotMatch(customerRefusal({ ok: false, status: 502, error: 'RPC https://fullnode.mainnet.sui.io:443 refused the connection' }).error, /https?:|sui\.io/i);
});

test('every wallet route goes through the one gate that words the refusal', () => {
  const route = code(read('lib/server/wallet-route.ts'));
  assert.match(route, /customerRefusal\(live\)/);
  assert.doesNotMatch(route, /error: live\.error/, 'the raw reason is never sent to the browser');
  assert.match(route, /console\.warn\(/, 'the reason is kept for the operator');
});

/* The page says it once --------------------------------------------------------- */

test('settings with no business wallet say so once, and offer only what can work', () => {
  const none = settingsWallet('none');
  assert.deepEqual({ inbox: none.inbox, manage: none.manage }, { inbox: false, manage: false });
  assert.equal(none.note, 'none');
  assert.equal(settingsWallet('off').note, 'off');
  assert.equal(settingsWallet('unavailable').note, 'unavailable');
  const pending = settingsWallet('pending');
  assert.equal(pending.inbox, true, 'a request waiting for the owner’s signature is shown while the wallet is being set up');
  assert.equal(pending.manage, false);
  const ready = settingsWallet('ready');
  assert.deepEqual({ inbox: ready.inbox, manage: ready.manage, note: ready.note }, { inbox: true, manage: true, note: null });
  assert.equal(settingsWallet(undefined).note, 'loading', 'nothing is claimed before the wallet has been read');
});

test('the Settings page reads the team once and hands it to the card, and does not ask a wallet route when there is no wallet', () => {
  const page = code(read('components/settings/SettingsPage.tsx'));
  const team = code(read('components/settings/TeamCard.tsx'));
  assert.equal((page.match(/\/api\/wallet\/persons-in-charge/g) ?? []).length, 1);
  assert.doesNotMatch(team, /useLoad/, 'the card is given the team; it does not fetch it again');
  assert.match(page, /settingsWallet\(/);
  assert.match(page, /manage \? \(/);
  assert.match(page, /wallet\.manage \? '\/api\/wallet\/persons-in-charge' : null|manage \? '\/api\/wallet\/persons-in-charge' : null/);
});

/* A phone ------------------------------------------------------------------------ */

test('the Settings columns can shrink to the screen, so a long word cannot push a card past the edge', () => {
  const page = code(read('components/settings/SettingsPage.tsx'));
  assert.match(page, /grid-cols-\[minmax\(0,1fr\)\]/);
  assert.match(page, /xl:grid-cols-\[minmax\(0,1\.35fr\)_minmax\(0,1fr\)\]/);
  assert.match(page, /<div className="min-w-0 space-y-5">/);
  assert.match(page, /<aside className="min-w-0 space-y-5">/);
});

test('a number in the operating controls is not cut off, and the approvals card has the title every other card has', () => {
  const controls = code(read('components/settings/OperatingControls.tsx'));
  assert.match(controls, /<input type="number"[\s\S]*?className="[^"]*\bw-full\b[^"]*\bmin-w-0\b[^"]*\btext-xl\b/);
  assert.doesNotMatch(controls, /text-2xl font-bold text-\[#326273\] outline-none/);
  const approvals = code(read('components/settings/ApprovalChannelCard.tsx'));
  assert.doesNotMatch(approvals, /<h2 className="text-xl/);
  assert.match(approvals, /<h2 className="text-sm font-extrabold text-\[#0c3e48\]">Approvals on WhatsApp<\/h2>/);
});

/* History and Setup -------------------------------------------------------------- */

test('History colours a count as an alarm only when there is something to look at', () => {
  assert.deepEqual(statTones({ inProgress: 0, notPaid: 0 }), { inProgress: 'text-[#326273]', notPaid: 'text-[#326273]' });
  assert.deepEqual(statTones({ inProgress: 2, notPaid: 0 }), { inProgress: 'text-[var(--gold-ink)]', notPaid: 'text-[#326273]' });
  assert.deepEqual(statTones({ inProgress: 0, notPaid: 1 }), { inProgress: 'text-[#326273]', notPaid: 'text-[var(--error)]' });
  const page = code(read('components/history/HistoryPage.tsx'));
  assert.match(page, /statTones\(summary\)/);
  assert.doesNotMatch(page, /gold-ink/, 'a failure never takes the gold accent, and the page does not choose colours beside it');
});

test('the Setup rail says each step in full, and a step that is done takes less room than one still to do', () => {
  const stepper = code(read('components/onboarding/SetupStepper.tsx'));
  assert.doesNotMatch(stepper, /\btruncate\b/, 'a step name is never cut short');
  assert.match(stepper, /compact=\{/, 'a done step is drawn compactly');
});

/* Pressing twice ------------------------------------------------------------------ */

test('a control that opens a signing request, changes a recipient or saves a step cannot be pressed twice while it is working', () => {
  const buttons = (file) => [...code(read(file)).matchAll(/<(?:PrimaryButton|QuietButton|button)\b[^>]*?onClick=\{[^]*?\}[^>]*>/g)].map((m) => m[0]);
  for (const [file, busy] of [
    ['components/settings/RulesSection.tsx', /disabled=\{busy\}/],
    ['components/settings/PolicyCard.tsx', /disabled=\{busy\}/],
    ['components/recipients/RecipientCard.tsx', /disabled=\{busy !== null\}/],
    ['components/onboarding/SetupStepper.tsx', /disabled=\{busy !== null\}/],
  ]) {
    const asking = buttons(file).filter((b) => /ask\(|recipients\(|asked\(|run\(|post\(/.test(b));
    assert.ok(asking.length >= 1, `${file}: found the buttons that ask`);
    for (const b of asking) assert.match(b, busy, `${file}: ${b.slice(0, 90)}`);
  }
  // A form's submit is guarded too, and its sending is `busy` until the answer is in.
  for (const file of ['components/settings/RuleForm.tsx', 'components/settings/PolicyCard.tsx']) assert.match(code(read(file)), /<PrimaryButton type="submit" disabled=\{busy\}>/, file);
  const stepper = code(read('components/onboarding/SetupStepper.tsx'));
  assert.match(stepper, /<button\s+type="submit"\s+disabled=\{busy !== null\}/);
});
