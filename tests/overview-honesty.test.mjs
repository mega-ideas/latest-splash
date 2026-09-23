import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The overview is read as a reading.
 *
 * It is the first screen after sign-in and it looked like an instrument panel,
 * so every figure on it was believed. Almost none of them were read from
 * anything:
 *
 *   Volume (30d)          $39,120 · +12.4%
 *   Settlement Pipeline   8 authorized / $4,540 … 19 settled today / $14,640
 *   Next window           16:30 MYT · 13 transfers · $7,510
 *   Recent Transactions   six invented rows carrying ids shaped like real ones
 *   Compliance            KYB status: Approved · Sumsub verified
 *                         Risk tier: Tier 1 · Low risk
 *                         Daily limit: 43% used · $12,100 remaining
 *   Header                Acme Trading Sdn Bhd, and a "verified" badge
 *
 * The compliance block is the one that matters most. It rendered identically
 * for an organisation in REGISTERED that cannot move a dollar — telling a
 * customer their KYB is approved when nothing has been checked is a statement
 * about our own regulatory posture, made in the place they are most likely to
 * believe it.
 */

const page = () =>
  readFile(new URL('../app/dashboard/overview/page.tsx', import.meta.url), 'utf8');

/** Comments describe what was removed, so assertions run against code only. */
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

test('no invented figures survive in the rendered code', async () => {
  const code = codeOnly(await page());

  for (const literal of [
    '$39,120',
    '+12.4%',
    '$4,540',
    '$14,640',
    '$2,960',
    '16:30 MYT',
    '$12,100',
    '43% used',
    'Sumsub verified',
    'Tier 1',
    'ti_m8q4_9b21fa',
    'batch_m8q2_12ac08',
    'Acme Trading Sdn Bhd',
  ]) {
    assert.ok(!code.includes(literal), `overview still asserts ${literal}`);
  }
});

test('compliance is read, not asserted', async () => {
  const source = await page();
  // The gate endpoint is the same call the dashboard layout makes, and it
  // fails closed: a state that cannot be read comes back REGISTERED + blocked.
  assert.match(source, /fetch\('\/api\/kyb\/state'/);
  assert.match(source, /KYB_COPY\[kyb\.state\]/);

  // Every lifecycle state has copy, so no state renders as a raw enum or,
  // worse, as the previous state's reassuring sentence.
  const code = codeOnly(source);
  for (const state of [
    'REGISTERED',
    'KYB_SUBMITTED',
    'KYB_PROVIDER_APPROVED',
    'ACTIVE',
    'REJECTED',
    'SUSPENDED',
  ]) {
    assert.ok(code.includes(state), `KYB_COPY is missing ${state}`);
  }

  // Only ACTIVE reads as verified.
  assert.match(source, /ACTIVE: \{ value: 'Approved[^']*', status: 'verified' \}/);
  assert.match(source, /REGISTERED: \{ value: 'Not started[^']*', status: 'pending' \}/);
});

test('the badge and the workspace name belong to the reader', async () => {
  const source = await page();
  assert.match(source, /status=\{kyb \? \(kyb\.blocked \? 'pending' : 'verified'\) : 'pending'\}/);
  assert.match(source, /workspace \? `\$\{workspace\} · Updated just now`/);
});

test('the numbers come from one read, so three panels cannot disagree', async () => {
  const source = await page();
  assert.match(source, /fetch\('\/api\/transfers\?filter=all'/);
  // Pipeline, recent list and 30-day volume all derive from `rows`.
  assert.match(source, /const pipeline = useMemo\(/);
  assert.match(source, /const recent = useMemo\(/);
  assert.match(source, /const volume30d = useMemo\(/);

  // Volume counts settled transfers only. An authorized transfer is money that
  // has not moved, and counting it would overstate what the business did.
  assert.match(source, /SETTLED_STATES\.has\(t\.state\) && new Date\(t\.createdAt\)/);
});

test('an empty desk says it is empty', async () => {
  const source = await page();
  // Six invented rows is how a demo becomes a claim. The honest alternative is
  // a sentence, and it has to be distinguishable from still-loading.
  assert.match(source, /No transfers yet\./);
  assert.match(source, /Loading transfers…/);
  assert.match(source, /transfers !== null && recent\.length === 0/);
});

test('what is still modeled is labelled modeled', async () => {
  const source = await page();
  // The corridor table keeps its figures, because its column headers already
  // say "Model volume" and "Test success". Labelled projection is not a lie;
  // an unlabelled one is. This test exists so the labels cannot quietly go.
  assert.match(source, /Model volume/);
  assert.match(source, /Test success/);
});
