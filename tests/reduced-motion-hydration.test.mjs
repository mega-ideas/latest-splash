/**
 * A visitor who asks for reduced motion gets the same server HTML as anyone
 * else, then the reduced variant after hydration (the A1 review).
 *
 * framer-motion's useReducedMotion() reads matchMedia during the first
 * client render, so a component that picks its markup from it renders one
 * tree on the server (no preference known) and another while hydrating.
 * On the landing that was SettlementCinematic: the server sent
 * `cin-section`, the client `cin-section cin-section-static`, and React
 * threw "Hydration failed" for every reduced-motion visitor, which the dev
 * overlay showed as "1 Issue" in every review screenshot (they emulate
 * reduced motion). /working-capital's two supply components branch the
 * same way. Each now reads the preference through
 * components/useHydratedReducedMotion.ts, whose server snapshot is false,
 * so hydration matches and the reduced variant follows straight after.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const HOOK = 'components/useHydratedReducedMotion.ts';
const USERS = [
  'components/landing/SettlementCinematic.tsx',
  'components/supply/DiscountTermSheet.tsx',
  'components/supply/WorkingCapitalFlywheel.tsx',
];

test('the reduced-motion hook reads no preference on the server or while hydrating', () => {
  assert.ok(existsSync(HOOK), `${HOOK} exists`);
  const hook = readFileSync(HOOK, 'utf8');
  assert.match(hook, /useSyncExternalStore\(/);
  assert.match(hook, /\(prefers-reduced-motion: reduce\)/);
  assert.match(hook, /useSyncExternalStore\(\s*subscribe\s*,\s*getSnapshot\s*,\s*\(\)\s*=>\s*false\s*\)/, 'the server snapshot is false');
});

test('no component that branches markup on reduced motion reads framer-motion directly', () => {
  for (const file of USERS) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\buseReducedMotion\b/, `${file} uses framer-motion's useReducedMotion`);
    assert.match(source, /useHydratedReducedMotion\(\)/, `${file} reads the hydration-safe hook`);
  }
});
