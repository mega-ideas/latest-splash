import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * v2 Phase 3 (p3-d-custody): the staff console on a phone, and its transactions page.
 *
 * At 390px the phone header put the brand, nine icon-only links and Log out in
 * one row. That row is wider than the screen, so the whole page scrolled
 * sideways and the brand was clipped to "Ad". The nine sections now sit in a
 * row of their own that scrolls inside itself, each link named. The
 * transactions page also showed the transfer volume in "RM" and the peg in
 * emoji, on a USDC-only product.
 */

const layout = await readFile(new URL('../app/admin/(console)/layout.tsx', import.meta.url), 'utf8');
const page = await readFile(new URL('../app/admin/(console)/transactions/page.tsx', import.meta.url), 'utf8');

const header = layout.slice(layout.indexOf('<header'), layout.indexOf('</header>'));

test('the phone header keeps its sections in a row that scrolls inside itself', () => {
  assert.ok(header.length > 0, 'the phone header exists');
  assert.match(header, /<nav[^>]*aria-label="Staff console"/);
  assert.match(header, /<nav[^>]*overflow-x-auto/, 'the links scroll inside the nav, not the page');
  // The header itself never lays brand, nav and logout out as one wide row.
  const bar = header.slice(0, header.indexOf('<nav'));
  assert.doesNotMatch(bar, /navItems\.map/, 'the nav items are not in the brand row');
});

test('every phone nav link says where it goes and is a full-size target', () => {
  const nav = header.slice(header.indexOf('<nav'));
  const link = nav.slice(nav.indexOf('<Link'), nav.indexOf('</Link>'));
  assert.match(link, /\{label\}/, 'the link carries its name, not only an icon');
  assert.match(link, /min-h-11/, 'at least 44px tall');
  assert.match(link, /shrink-0/, 'a link keeps its width and the row scrolls instead');
});

test('the transactions page speaks USDC, with the peg in words and no emoji or ringgit', () => {
  assert.doesNotMatch(page, /RM\s*\$|`RM |'RM |"RM /, 'no ringgit amount');
  assert.doesNotMatch(page, /\p{Extended_Pictographic}/u, 'no emoji');
  assert.doesNotMatch(page, /24h Volume/, 'the figure sums every transfer, not 24 hours');
  assert.match(page, /Transfer volume/);
  assert.match(page, /PEG_WORDS/);
});

const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

test('the desktop sidebar scrolls inside itself and keeps its posture and account blocks whole on a 900px screen', () => {
  // Eleven links, the posture block, the signed-in person and Log out are taller than 900px. The aside is a column of fixed height, so
  // without these the posture block shrank to a strip with its second line cut off.
  const aside = layout.slice(layout.indexOf('<aside'), layout.indexOf('>', layout.indexOf('<aside')));
  assert.match(aside, /overflow-y-auto/, 'the sidebar scrolls inside itself when its content is taller than the screen');
  const trust = css.slice(css.lastIndexOf('.fintech-admin-trust {'));
  assert.match(trust.slice(0, trust.indexOf('}')), /flex-shrink:\s*0/, 'the posture block is never squeezed');
  const account = layout.slice(layout.indexOf('rounded-2xl border border-white/10 bg-white/10 p-4'), layout.indexOf('<AdminLogoutButton />'));
  assert.match(account, /shrink-0/, 'the account block is never squeezed');
});
