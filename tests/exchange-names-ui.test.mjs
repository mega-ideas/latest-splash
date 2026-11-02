/**
 * v2 Phase 3, the "Names sent to exchanges" card in Settings, after an
 * independent review of its accessibility.
 *
 *   - While a change was saving, both inputs were `disabled`. A disabled element
 *     drops keyboard focus, so a person toggling a switch had to tab back to it.
 *   - The result of a save was not announced; only errors were.
 *   - The inputs said role="switch" but were drawn as native checkboxes, and the
 *     controls were 20px (the target is at least 24px, and the label is the real
 *     hit area, which should be 44px high).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const card = readFileSync(new URL('../components/team/ExchangeNames.tsx', import.meta.url), 'utf8');

test('a switch keeps keyboard focus while it saves: nothing is `disabled` for the length of a save', () => {
  assert.doesNotMatch(card, /(?<!aria-)disabled=\{/);
  assert.match(card, /aria-disabled=\{busy\}/);
  assert.match(card, /busy=\{busy !== null\}/);
  assert.match(card, /if \(busy\) return;/, 'a second change while one is saving is ignored, not queued');
});

test('a saved change is announced politely, and an error stays an alert-style note', () => {
  assert.match(card, /aria-live="polite"/);
  assert.match(card, /Saved/);
  assert.match(card, /Note tone="error"/);
});

test('the switches are drawn as switches and the whole label is a 44px target', () => {
  assert.match(card, /role="switch"/);
  assert.match(card, /sr-only peer|peer sr-only/, 'the real input stays in the page for keyboards and screen readers');
  assert.match(card, /peer-checked:/);
  assert.match(card, /peer-focus-visible:/, 'a visible focus ring on the track');
  assert.match(card, /min-h-11/);
  assert.doesNotMatch(card, /accent-\[#0d6370\]/, 'no longer a native checkbox look');
});
