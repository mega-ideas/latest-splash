/**
 * The reviewer's findings on how the limits read and behave on the page (v2
 * Phase 3), checked where they live: the owner's Limits card and the operator
 * queue. These read the components' source, the way tests/limits-routes.test.mjs
 * reads the routes, because the claims are about words, labels and which route a
 * button calls.
 *
 *   owner card   a button that is off says why, in words under the figure (a title
 *                attribute is not read on a phone); a limit that was lowered offers
 *                Restore; the sheet's close button is "Close", not "Cancel", which
 *                means something else beside "Cancel this request"; a bad submit
 *                moves focus to the first field that is wrong; a lowering to under
 *                a tenth asks for a second look; lowering a length of allowance
 *                says it holds for the next allowance, not for the one given
 *   cross-reference  the Limits card and Settings, Controls each say which limit
 *                governs which payments
 *   queue        the choice that approves as asked is not labelled like the submit
 *                button; a failed refresh is said; a decided card cannot be
 *                decided again from the same screen
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const card = code(read('components/settings/LimitsCard.tsx'));
const queue = code(read('components/admin/AdminLimitRequests.tsx'));

test('a button that is off says why in visible words, not only in a title attribute', () => {
  assert.doesNotMatch(card, /title=\{/, 'no control relies on a title for its reason');
  assert.match(card, /This is the most Splash offers\./);
  assert.match(card, /A request is already open for this limit\./);
  assert.match(card, /This is the lowest a limit can be\./);
});

test('a limit that was lowered offers Restore, which calls the restore route and not a request', () => {
  assert.match(card, /canRestore/);
  assert.match(card, /Restore to /);
  assert.match(card, /\/api\/limits\/restore/);
  assert.ok(existsSync(new URL('app/api/limits/restore/route.ts', root)), 'the restore route exists');
  const route = code(read('app/api/limits/restore/route.ts'));
  assert.match(route, /await limitsRoute\(request\)/);
  assert.match(route, /restoreLimit\(/);
  assert.match(route, /orgId: gate\.route\.orgId/);
  assert.match(route, /gate\.route\.authority\.userId/);
  assert.match(route, /limitChanges\(/);
});

test('the sheet closes with "Close"; "Cancel" is left to cancelling a request', () => {
  assert.match(card, /onClick=\{onClose\}>Close</);
  assert.doesNotMatch(card, /onClick=\{onClose\}>Cancel</);
  assert.match(card, /Cancel this request/);
});

test('a submit that is not valid moves focus to the first field that is wrong', () => {
  assert.match(card, /\.focus\(\)/);
  assert.match(card, /getElementById\('limit-figure'\)|figureRef/);
});

test('a lowering to under a tenth of the limit asks for a second look before it goes', () => {
  assert.match(card, /lowerNeedsConfirm/);
  assert.match(card, /less than a tenth/i);
});

test('lowering the length of an allowance says what is true: it holds for the next allowance', () => {
  assert.match(card, /next allowance you give/);
  assert.match(card, /keeps its length until you give it again or take it back/);
  assert.match(card, /Settings|Automatic/);
});

test('the Limits card and Settings, Controls each say which limit governs which payments', () => {
  assert.match(card, /Controls/);
  assert.match(card, /payments Splash makes for you automatically|automatic payments/);
  const controls = code(read('components/settings/OperatingControls.tsx'));
  assert.match(controls, /Limits on automatic payments|Settings, Limits/);
  assert.match(controls, /#limits/);
});

test('the queue: the choice that approves as asked is not labelled like the submit button, a failed refresh is said, and a decided card is closed', () => {
  assert.match(queue, /Approve as asked/);
  assert.doesNotMatch(queue, /\['approve', `Approve \$\{request\.requestedWords\}`\]/);
  assert.match(queue, /could not be refreshed|Refresh failed|could not be read/i);
  assert.match(queue, /Decision saved|You decided this/);
  assert.match(queue, /earlierRequests/);
});

test('the limit words say what is true about the monthly figure', () => {
  const rules = code(read('lib/limits/rules.ts'));
  assert.doesNotMatch(rules, /in a calendar month/);
  assert.match(rules, /in any 30 days/);
});
