/**
 * v2 Phase 3, brief 8, the final check on the live dashboard pages: contrast
 * of at least 4.5:1 on all text, including 11 to 12px labels and placeholders.
 * The rendered pages were measured (21 pages, both sizes); this holds the two
 * fixes that measurement led to. The static audit is dashboard-contrast.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('a placeholder is text and reads at 4.5:1: the dashboard draws it in the slate token, undimmed', () => {
  const css = read('app/globals.css');
  const rule = css.slice(css.lastIndexOf('.fintech-dashboard-shell ::placeholder'));
  assert.ok(rule.startsWith('.fintech-dashboard-shell ::placeholder {'), 'the rule is the stylesheet’s last word on placeholders');
  assert.ok(rule.includes('color: var(--slate);') && rule.includes('opacity: 1;'));
});

test('the unit beside a read-only operating control keeps full contrast: only the field’s value is dimmed', () => {
  const controls = read('components/settings/OperatingControls.tsx');
  assert.ok(controls.includes('disabled:opacity-50'), 'the value of a read-only field dims');
  assert.ok(!controls.includes('text-[var(--info)]">{suffix}'), 'the unit is not painted in the info colour at half opacity');
});
