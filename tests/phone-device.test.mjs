/**
 * v2 Phase 3, brief 5.10: the dashboard has phone layouts, and one rule for
 * which device gets them. The server's hint (the User-Agent, read where the
 * layout renders) is only the first paint; the width of the window decides
 * after that, so a desktop window narrowed to a phone gets the phone layout
 * and a tablet keeps the desktop one.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { PHONE_MAX_WIDTH, PHONE_MEDIA_QUERY, isPhoneUserAgent, phoneHintFromHeaders, resolvePhone } from '../lib/device.ts';
import { PHONE_TABS, SIGNING_POLL_MS, badgeText, phoneTabCurrent, waitingForMe } from '../lib/dashboard/phone.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null });

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const PIXEL = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

test('the phone breakpoint is the one the shell already uses (below md, 768px)', () => {
  assert.equal(PHONE_MAX_WIDTH, 767);
  assert.equal(PHONE_MEDIA_QUERY, '(max-width: 767px)');
});

test('the server hint is a phone for phones and not for tablets or desktops', () => {
  assert.equal(phoneHintFromHeaders(headers({ 'user-agent': IPHONE })), true);
  assert.equal(phoneHintFromHeaders(headers({ 'user-agent': PIXEL })), true);
  assert.equal(phoneHintFromHeaders(headers({ 'user-agent': ANDROID_TABLET })), false);
  assert.equal(phoneHintFromHeaders(headers({ 'user-agent': IPAD })), false);
  assert.equal(phoneHintFromHeaders(headers({ 'user-agent': DESKTOP })), false);
  assert.equal(phoneHintFromHeaders(headers({})), false, 'no User-Agent is not a phone');
  // The same decision the landing page makes.
  assert.equal(phoneHintFromHeaders(headers({ 'user-agent': IPHONE })), isPhoneUserAgent(IPHONE));
});

test('the client asks the window, and the hint only stands in until it can', () => {
  assert.equal(resolvePhone(true, null), true, 'before the window can be asked, the hint');
  assert.equal(resolvePhone(false, null), false);
  assert.equal(resolvePhone(true, false), false, 'a phone turned sideways to a wide window gets the wide layout');
  assert.equal(resolvePhone(false, true), true, 'a desktop window narrowed to a phone gets the phone layout');
});

test('the phone has five tabs: Home, Transfer, Approve, Wallet, Zeke, each with an icon and a word', () => {
  assert.deepEqual(PHONE_TABS.map((t) => t.label), ['Home', 'Transfer', 'Approve', 'Wallet', 'Zeke']);
  assert.deepEqual(PHONE_TABS.map((t) => t.href), ['/dashboard', '/dashboard/transfer', '/dashboard/approve', '/dashboard/wallet', '/dashboard/zeke']);
  assert.ok(PHONE_TABS.length <= 5, 'a bottom bar holds five at most');
  for (const tab of PHONE_TABS) assert.ok(tab.icon && tab.label, tab.href);
});

test('the current tab is the page being shown: Home only on Home, the others by path segment', () => {
  assert.equal(phoneTabCurrent('/dashboard'), 'home');
  assert.equal(phoneTabCurrent('/dashboard/transfer'), 'transfer');
  assert.equal(phoneTabCurrent('/dashboard/approve/abc'), 'approve');
  assert.equal(phoneTabCurrent('/dashboard/wallet'), 'wallet');
  assert.equal(phoneTabCurrent('/dashboard/zeke'), 'zeke');
  assert.equal(phoneTabCurrent('/dashboard/walletx'), null, 'a path that only starts with the word is not that tab');
  assert.equal(phoneTabCurrent('/dashboard/history'), null, 'a page that is not a tab leaves none current');
  assert.equal(phoneTabCurrent('/dashboard/copilot'), 'zeke', 'the old Zeke address belongs to Zeke');
});

test('the badge says how many requests wait for this person, and stops counting at nine', () => {
  assert.equal(badgeText(0), null);
  assert.equal(badgeText(-3), null);
  assert.equal(badgeText(Number.NaN), null);
  assert.equal(badgeText(1), '1');
  assert.equal(badgeText(9), '9');
  assert.equal(badgeText(10), '9+');
  assert.ok(SIGNING_POLL_MS >= 15_000, 'the count is looked at every so often, not on every frame');
});

test('only a request still collecting, that this person must sign and has not signed or declined, is waiting for them', () => {
  const r = (over) => ({ status: 'collecting', you: { mustSign: true, signed: false, declined: false, requested: false }, ...over });
  assert.equal(waitingForMe([r(), r(), r({ status: 'executed' })]), 2);
  assert.equal(waitingForMe([r({ you: { mustSign: false, signed: false, declined: false, requested: true } })]), 0, 'their own request, signed by others, is not theirs to sign');
  assert.equal(waitingForMe([r({ you: { mustSign: true, signed: true, declined: false, requested: false } })]), 0);
  assert.equal(waitingForMe([r({ you: { mustSign: true, signed: false, declined: true, requested: false } })]), 0);
  assert.equal(waitingForMe([r({ status: 'expired' }), r({ status: 'failed' }), r({ status: 'cancelled' })]), 0);
  assert.equal(waitingForMe(null), 0);
  assert.equal(waitingForMe(undefined), 0);
  assert.equal(waitingForMe('nonsense'), 0, 'an answer that is not a list is no requests');
});

test('the layout reads the device where it renders and passes it to the shell without a second wrapper', () => {
  const layout = read('app/dashboard/layout.tsx');
  assert.match(layout, /phoneHintFromHeaders\(await headers\(\)\)/);
  assert.match(layout, /phoneHint=\{/);
  assert.match(layout, /\{children\}<\/DashboardShell>/, 'tests/oxwal-frontend.test.mjs pins the one-line shape');
  assert.match(layout, /viewportFit: 'cover'/, 'the bottom bars clear the home indicator');
});

test('one provider and one hook say which layout a component renders', () => {
  const device = read('components/dashboard/Device.tsx');
  assert.match(device, /useSyncExternalStore/, 'the first paint is the hint and the window decides after, with no mismatch');
  assert.match(device, /matchMedia\(PHONE_MEDIA_QUERY\)/);
  assert.match(device, /export function usePhone\(/);
  assert.match(device, /export function OnPhone\(/);
  assert.match(device, /export function OffPhone\(/);
  assert.match(device, /export function usePhoneBottomBar\(/);
  const shell = read('components/dashboard/DashboardShell.tsx');
  assert.match(shell, /<DeviceProvider phoneHint=\{phoneHint\}/);
  assert.match(shell, /<PhoneTabBar\b/);
});
