import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  MONEY_PATH_HEADER,
  MONEY_PATH_STEPS,
  PH_PAYOUT_RAILS,
  REQUIRED_HONESTY_SENTENCE,
} from '../content/money-path.ts';

test('money path: ends with the Splash honesty sentence', () => {
  const splash = MONEY_PATH_STEPS.at(-1);
  assert.equal(splash.partner, 'Splash');
  // Locked copy — never paraphrased (also enforced by scripts/check-copy.mjs).
  assert.equal(splash.detail, REQUIRED_HONESTY_SENTENCE);
  assert.equal(
    REQUIRED_HONESTY_SENTENCE,
    'Labuan FSA license in process. Splash is not yet a licensed money-services business.',
  );
  assert.equal(MONEY_PATH_HEADER, 'Splash orchestrates — we never hold your funds.');
});

test('money path: exactly one active PHP payout rail renders in the path', () => {
  const active = PH_PAYOUT_RAILS.filter((rail) => rail.active);
  assert.equal(active.length, 1);
  const payout = MONEY_PATH_STEPS.find((step) => step.role === 'PHP payout');
  assert.equal(payout.partner, active[0].name);
});

test('money path: Splash is a party to exactly one step, and that step moves no money', () => {
  // The header says "Splash orchestrates - we never hold your funds." This is
  // that sentence as an assertion. A new hop where Splash touches client funds
  // fails here rather than silently contradicting the panel it renders under.
  const splashSteps = MONEY_PATH_STEPS.filter((step) => step.splashIsParty === true);
  assert.equal(splashSteps.length, 1, 'exactly one step may have splashIsParty === true');
  assert.equal(splashSteps[0].partner, 'Splash');
  assert.equal(splashSteps[0].role, 'Orchestrates and proves');

  // Every other hop is a licensed partner of record, and Splash is not a party.
  for (const step of MONEY_PATH_STEPS) {
    assert.equal(typeof step.splashIsParty, 'boolean', `${step.partner} must declare splashIsParty`);
    if (step.partner !== 'Splash') {
      assert.equal(step.splashIsParty, false, `${step.partner} is a partner of record, not Splash`);
    }
  }
});

test('money path: no partner appears who is not a partner of record', () => {
  // Hata was named as the conversion venue without being a signed partner.
  // Removing it is a claims fix; this keeps it from coming back by habit.
  const partners = MONEY_PATH_STEPS.map((step) => step.partner);
  assert.equal(partners.includes('Hata'), false, 'Hata is not a partner of record');
});

test('money path panel renders from config only — no hardcoded partner copy', async () => {
  const source = await readFile(new URL('../components/compliance/MoneyPathPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /from '@\/content\/money-path'/);
  assert.match(source, /MONEY_PATH_STEPS\.map/);
  // Partner names and license copy must come from the config, not the component.
  for (const literal of ['Airwallex', 'PDAX', 'GCash', 'Coins.ph', 'Labuan']) {
    assert.equal(source.includes(literal), false, `${literal} must live in content/money-path.ts, not the component`);
  }
  // The panel links to the trust page from every mount.
  assert.match(source, /href="\/trust"/);
});

test('money path mounts: treasury page and funding flow render the panel', async () => {
  const treasury = await readFile(new URL('../app/dashboard/treasury/page.tsx', import.meta.url), 'utf8');
  const quote = await readFile(new URL('../components/transfer/StepQuote.tsx', import.meta.url), 'utf8');
  assert.match(treasury, /<MoneyPathPanel \/>/);
  assert.match(quote, /<MoneyPathPanel compact \/>/);
});
