/**
 * v2 final verification: on a phone, the Approve screen has a bar fixed to the
 * foot of the window ("Sign with your passkey", "Not now", the code). The
 * "Decline this request" (or "Withdraw the request") card sits under the
 * review, outside the review's own bottom padding, so scrolled to the end it
 * was behind that bar and could not be reached. Found in the final screenshots
 * at 390x844: the card's top edge sat 13px above the bar's, with the card
 * under it.
 *
 * What the component must contain is checked in its source (there is no browser
 * in this suite; the screenshots cover the rendering).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../components/approve/ApproveDetail.tsx', import.meta.url), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the page asks whether it is on a phone, the way the sign panel does', () => {
  assert.match(code, /import \{ usePhone \} from '@\/components\/dashboard\/Device'/);
  assert.match(code, /usePhone\(\)/);
});

test('while the phone bar is showing, the page keeps room below the decline card for it', () => {
  // The bar shows for a signer who has not signed, on a request still collecting; the room is at least the bar's height (129px).
  assert.match(code, /barShown\s*=\s*phone\s*&&[^;]*you\.mustSign[^;]*!request\.you\.signed[^;]*status === 'collecting'/);
  assert.match(code, /barShown \? 'pb-36'/);
});
