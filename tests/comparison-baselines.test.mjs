import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { baselineCostUsd, getComparisonBaseline } from '../lib/fx/comparison-baselines.ts';

test('comparison baselines: reviewed corridor returns labeled category figures', () => {
  const php = getComparisonBaseline('PHP');
  assert.ok(php, 'PHP (the live testnet corridor) must have a reviewed baseline');
  assert.match(php.lastReviewed, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(php.fintech.pct > 0 && php.bankWire.pct > php.fintech.pct, 'bank wire baseline costs more than fintech category');
  assert.ok(php.fintech.delivery.length > 0 && php.bankWire.delivery.length > 0);
});

test('comparison baselines: unreviewed corridor yields null so the strip hides', () => {
  assert.equal(getComparisonBaseline('MYR'), null);
  assert.equal(getComparisonBaseline('XXX'), null);
});

test('comparison baselines: category cost math is pct-of-amount plus flat', () => {
  const cost = baselineCostUsd({ pct: 2.5, flatUsd: 35, delivery: 'n/a' }, 2500);
  assert.equal(cost, 2500 * 0.025 + 35);
});

test('quote step derives all figures from the live quote and reads real settings', async () => {
  const source = await readFile(new URL('../components/transfer/StepQuote.tsx', import.meta.url), 'utf8');

  // Fee % derives from the quote object — no duplicated fee math in the card.
  assert.match(source, /quoteFeeUsd \/ sendAmountUsd/);
  assert.match(source, /state\.quote\.netReceived/);
  // Rate-lock chip reads the REAL hold expiry, never a hardcoded window.
  assert.match(source, /state\.rateHold\.holdUntil/);
  assert.doesNotMatch(source, /locked 10 min/i);
  // Maker-checker note reads operating settings server-side values.
  assert.match(source, /fetch\('\/api\/settings'\)/);
  assert.match(source, /approvalThresholdUsd/);
  // Comparison strip: generic categories only, labeled, and gated on a
  // reviewed baseline (hidden when getComparisonBaseline returns null).
  assert.match(source, /getComparisonBaseline/);
  assert.match(source, /Illustrative, mid-market baseline/);
  assert.match(source, /Fintech transfer/);
  assert.match(source, /Bank wire/);
  assert.doesNotMatch(source, /Wise|Revolut|Remitly|WorldRemit|Western Union|PayPal|Payoneer/i);
  // Mockup structure: supplier-receives line present.
  assert.match(source, /Supplier receives/);
});
