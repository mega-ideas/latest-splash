/**
 * Zeke's answer about volume pricing (lib/agent/oxwal.ts) says what A1
 * prices by: where the payment goes and its size (A1 §2.2), rendered from
 * the schedule (A1 §2.7), with the 100 bps ceiling (A1 §2.4). There is no
 * corridor or batch rate, and the ceiling is not 2%. A1 §2.8 names Zeke's
 * reply copy among what must quote the schedule, never a typed rate.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { formatRate, pricingLine } from '../lib/fees/copy.ts';
import { lastPublishedFeeSchedule } from '../lib/fees/fee-config.ts';
import { FEE_CEILING_BPS } from '../lib/fees/schedule.ts';

async function ask(message) {
  const { runOxwalAgent } = await import('../lib/agent/oxwal.ts');
  let said = '';
  for await (const event of runOxwalAgent({ forceLocal: true, message })) if (event.type === 'delta') said += event.text;
  return said;
}

for (const message of ['do you give a discount for high volume?', 'is it cheaper at monthly volume?', 'any discount for enterprise volume']) {
  test(`Zeke on volume ("${message}") quotes the schedule and the 1% ceiling, not a 2% ceiling or a batch rate`, async () => {
    const said = await ask(message);
    assert.doesNotMatch(said, /(?<![\d.])2(?:\.0+)? ?%/, 'the ceiling is 100 bps, not 2%');
    assert.doesNotMatch(said, /15\s?[-–]\s?30 ?bps|blended rate|corridor pricing/i, 'there is no batch or corridor rate');
    assert.ok(said.includes(pricingLine(lastPublishedFeeSchedule())), 'the pricing line, rendered from the schedule');
    assert.ok(said.includes(formatRate(FEE_CEILING_BPS)), 'the ceiling, from FEE_CEILING_BPS');
  });
}
