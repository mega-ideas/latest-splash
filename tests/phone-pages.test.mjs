/**
 * v2 Phase 3, brief 5.10: the phone layouts of Home, Wallet and Zeke, and the
 * phone frame they sit in (a bottom tab bar, no floating Zeke over the
 * content, room for the home indicator). What a component must contain is
 * checked in its source; the screenshots cover the rendering.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { copyViolations } from '../scripts/copy-rules.mjs';
import { SECTION_ORDER, sectionFromHash, sectionsOpenAtFirst } from '../lib/wallet-page/phone.ts';
import { zekePhoneSections } from '../lib/oxwal/phone-desk.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── The frame ─────────────────────────────────────────────────────────────────

test('the phone has a bottom tab bar of five tabs, each 44px or taller with an icon and a word, and a badge for what waits for a signature', () => {
  const bar = read('components/dashboard/PhoneTabBar.tsx');
  assert.match(bar, /PHONE_TABS\.map/);
  assert.match(bar, /aria-label="Main"/);
  assert.match(bar, /aria-current=\{on \? 'page' : undefined\}/);
  assert.match(bar, /min-h-14/);
  assert.match(bar, /env\(safe-area-inset-bottom\)/);
  assert.match(bar, /badgeText\(/);
  assert.match(bar, /md:hidden/, 'a window wide enough for the rail has no tab bar');
  assert.match(bar, /usePhoneBottomBar|claimed/, 'a screen with its own fixed action bar takes the tab bar’s place');
  assert.match(bar, /readWaiting\(/, 'the count is read from the server’s count-only answer (waitingForMe runs there)');
  assert.match(bar, /\/api\/wallet\/signing-requests/);
  assert.match(bar, /SIGNING_POLL_MS/);
  assert.match(bar, /document\.hidden|visibilityState/, 'a tab nobody is looking at does not poll');
});

test('the shell draws the phone frame: tab bar, Zeke only as a tab, content clear of the bar', () => {
  const shell = read('components/dashboard/DashboardShell.tsx');
  assert.match(shell, /<PhoneTabBar\b/);
  assert.match(shell, /phoneHint/);
  assert.match(shell, /pb-\[calc\(env\(safe-area-inset-bottom\)\+/, 'content is not hidden behind the bar');
  assert.match(shell, /<OffPhone>[\s\S]*<FloatingCopilot \/>/, 'the floating Zeke would cover the content a phone has so little of');
});

test('the phone bar shows the current tab and offers a way to everything else through the menu', () => {
  const shell = read('components/dashboard/DashboardShell.tsx');
  assert.match(shell, /aria-label="Open navigation"/, 'the drawer still holds every page');
  assert.match(shell, /Menu|menu/);
});

// ── Home ──────────────────────────────────────────────────────────────────────

test('Home on a phone is its own layout: balance first, what needs a signature, four actions, and recent payments as rows', () => {
  const page = read('app/dashboard/page.tsx');
  assert.match(page, /usePhone\(\)/);
  assert.match(page, /<PhoneHome\b/);
  const home = read('components/home/PhoneHome.tsx');
  assert.match(home, /Splash Wallet/);
  assert.match(home, /Needs your signature/);
  assert.match(home, /href="\/dashboard\/approve"/);
  for (const label of ['Pay someone', 'Add funds', 'Batch payout', 'Ask Zeke']) assert.match(home, new RegExp(label), label);
  assert.match(home, /Recent payments/);
  assert.match(home, /Sent this month/);
  assert.match(home, /Needs approval/);
  assert.ok(home.indexOf('Splash Wallet') < home.indexOf('Needs your signature'), 'the balance comes first');
  assert.ok(home.indexOf('Needs your signature') < home.indexOf('Recent payments'), 'what waits for the person comes before history');
});

test('Home’s phone layout reads the same figures as the desktop: it takes them as props and fetches nothing', () => {
  const home = read('components/home/PhoneHome.tsx');
  assert.doesNotMatch(code(home), /fetch\(|useEffect/, 'one set of reads, in the page');
  assert.match(home, /formatUsdcMinor/);
  const page = read('app/dashboard/page.tsx');
  assert.match(page, /import \{[^}]*readWallet[^}]*\} from '@\/components\/home\/wallet-state'/);
  assert.match(page, /\/api\/wallet\/signing-requests/);
  assert.match(page, /waitingForMe\(/);
});

test('a figure that could not be read is said, never zero, on the phone too', () => {
  const home = read('components/home/PhoneHome.tsx');
  assert.match(home, /Couldn&rsquo;t load/);
  assert.match(home, /Try again/);
  assert.match(home, /<WalletBody\b/, 'the balance says what is true in the desktop card’s own words');
  assert.match(read('components/home/WalletBody.tsx'), /Balance unavailable/);
});

// ── Wallet ────────────────────────────────────────────────────────────────────

test('on the Wallet page a phone sees the signature requests and the balance first, and every other section folded under its own title', () => {
  assert.deepEqual(sectionsOpenAtFirst(), ['needs-signature']);
  assert.deepEqual(SECTION_ORDER.slice(0, 2), ['needs-signature', 'balance']);
  for (const id of ['top-up', 'withdraw', 'funding-history', 'funding-sources', 'signers', 'spending-rules', 'migration', 'upgrade-alerts']) assert.ok(SECTION_ORDER.includes(id), id);
  const parts = read('components/wallet/parts.tsx');
  assert.match(parts, /usePhone\(\)/);
  assert.match(parts, /<details\b/);
  assert.match(parts, /<summary\b/);
  assert.match(parts, /hashchange/, 'the Add funds and Withdraw buttons open their section');
});

test('a link to a folded section opens it', () => {
  assert.equal(sectionFromHash('#top-up'), 'top-up');
  assert.equal(sectionFromHash('#withdraw'), 'withdraw');
  assert.equal(sectionFromHash('#funding-history'), 'funding-history');
  assert.equal(sectionFromHash('#nonsense'), null);
  assert.equal(sectionFromHash(''), null);
  assert.equal(sectionFromHash('top-up'), 'top-up', 'with or without the #');
  assert.equal(sectionFromHash('#__proto__'), null);
});

test('the balance card puts the three things a person does with a wallet within thumb reach on a phone', () => {
  const card = read('components/wallet/BalanceCard.tsx');
  assert.match(card, /usePhone\(\)/);
  assert.match(card, /grid-cols-3|grid grid-cols/);
  for (const label of ['Add funds', 'Withdraw', 'Send']) assert.match(card, new RegExp(label), label);
  assert.match(card, /min-h-1[1-9]|min-h-\[[4-9]\d/);
});

test('the Wallet page keeps every section and sends nothing the desktop did not', () => {
  const page = read('components/wallet/WalletPage.tsx');
  for (const part of ['BalanceCard', 'AddFunds', 'Withdraw', 'FundingHistory', 'FundingSources', 'WalletActivity', 'SignersCard', 'RulesCard', 'Migration', 'AlertsCard', 'SigningInbox', 'SetupWallet']) assert.match(page, new RegExp(`<${part}\\b`), part);
});

// ── Zeke ──────────────────────────────────────────────────────────────────────

test('on a phone Zeke leads with the question and the composer, and the cards come after, folded', () => {
  const sections = zekePhoneSections();
  assert.deepEqual(sections.visible, ['composer', 'starters', 'recent']);
  assert.deepEqual(sections.folded, ['approvals', 'can-do', 'remembers', 'memwal-stores', 'quick-links', 'suggestions']);
  assert.ok(sections.folded.includes('memwal-stores') && sections.folded.includes('quick-links'), 'What MemWal stores and the quick links are still there');
  const page = read('app/dashboard/zeke/page.tsx');
  assert.match(page, /usePhone\(\)/);
  assert.match(page, /<MemWalStores \/>/);
  assert.match(page, /<ZekeQuickLinks \/>/);
});

test('the starters are a row to swipe on a phone, each a 44px target, and the conversation keeps its composer under the thread above the tab bar', () => {
  const phone = read('components/oxwal/ZekePhone.tsx');
  assert.match(phone, /snap-x/);
  assert.match(phone, /overflow-x-auto/);
  assert.match(phone, /min-h-\[116px\]|min-h-1[1-9]|min-h-\[[4-9]\d/);
  assert.match(phone, /<details\b/);
  const page = read('app/dashboard/zeke/page.tsx');
  assert.match(page, /<PhoneStarters\b/);
  assert.match(page, /<PhoneMore\b/);
  assert.match(page, /env\(safe-area-inset-bottom\)/);
  assert.match(page, /shrink-0 border-t[^"]*"[\s\S]{0,200}variant="reply"/, 'the composer is docked under the thread');
});

test('the approvals Zeke knows of lead to Approve on a phone, where the passkey is', () => {
  const cards = read('components/oxwal/ZekeDeskCards.tsx');
  assert.match(cards, /href="\/queue"|href="\/dashboard\/approve"/);
});

// ── Words and colours ─────────────────────────────────────────────────────────

test('the phone files pass the copy rules and use no coral, Demo, testnet, grid, or partner name', () => {
  for (const file of ['components/dashboard/Device.tsx', 'components/dashboard/PhoneTabBar.tsx', 'components/home/PhoneHome.tsx', 'components/home/wallet-state.ts', 'components/home/WalletBody.tsx', 'components/home/parts.tsx', 'components/oxwal/ZekePhone.tsx', 'lib/dashboard/phone.ts', 'lib/wallet-page/phone.ts', 'lib/oxwal/phone-desk.ts', 'lib/device.ts']) {
    const text = read(file);
    assert.deepEqual(copyViolations(file, text), [], file);
    assert.doesNotMatch(text, /E39774|coral|\bDemo\b|\bDEMO\b|Coming soon|testnet|non-custodial|background-grid|bg-grid|grid-lines/i, file);
  }
});
