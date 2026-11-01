/**
 * v2 Phase 3 (p3-labels), Sky's decision: a payment or batch the owners
 * declined reads "Declined by <who>" wherever its status shows, for example
 * "Declined by Aisha"; more than one owner names them in order ("Declined by
 * Aisha and Ben"), at most two names and then "and 1 more"; a record with no
 * usable name reads "Declined by an owner". "Withdrawn" is unchanged.
 *
 * This file pins the words and what may be said in them. The pure formatter is
 * client-safe, so a name that reaches it is cleaned again here: plain words
 * only, never a link, markup, a control or direction character, or a name long
 * enough to take over the row. tests/declined-by-history.test.mjs runs the same
 * on a real database, with the cross-tenant cases.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { copyViolations } from '../scripts/copy-rules.mjs';
import { declinedByLabel, plainName } from '../lib/team/declined-by.ts';
import { buildHistory } from '../lib/history-page/entries.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const USDC = (n) => String(Math.round(n * 1_000_000));

const transfer = (over = {}) => ({ id: 'wt_1', paymentRef: 'pay_1', status: 'declined', payeeKind: 'SELF_CUSTODY', payeeName: 'Dela Cruz Trading', payeeMasked: '0x7777…7777', payeeCountry: 'PH', amountMinor: USDC(250), reference: 'INV-204', createdAt: '2026-10-20T08:00:00.000Z', ...over });
const batch = (over = {}) => ({ id: 'wb_1', label: 'October suppliers', status: 'declined', rowCount: 12, totalMinor: USDC(4000), createdAt: '2026-10-22T08:00:00.000Z', ...over });
const labelOf = (row) => buildHistory({ transfers: [], batches: [row], withdrawals: [], earlier: [] })[0].status.label;
const transferLabel = (row) => buildHistory({ transfers: [row], batches: [], withdrawals: [], earlier: [] })[0].status.label;

test('one owner who declined is named: "Declined by Aisha"', () => {
  assert.equal(declinedByLabel({ names: ['Aisha'], unnamed: 0 }), 'Declined by Aisha');
});

test('two owners are named in the order they declined: "Declined by Aisha and Ben"', () => {
  assert.equal(declinedByLabel({ names: ['Aisha', 'Ben'], unnamed: 0 }), 'Declined by Aisha and Ben');
  assert.equal(declinedByLabel({ names: ['Ben', 'Aisha'], unnamed: 0 }), 'Declined by Ben and Aisha', 'the order given is the order said');
});

test('more than two name two and then count the rest: "and 1 more", "and 2 more"', () => {
  assert.equal(declinedByLabel({ names: ['Aisha', 'Ben', 'Chen'], unnamed: 0 }), 'Declined by Aisha, Ben and 1 more');
  assert.equal(declinedByLabel({ names: ['Aisha', 'Ben', 'Chen', 'Dara'], unnamed: 0 }), 'Declined by Aisha, Ben and 2 more');
  // A decliner with no name still counts as one of the people who declined.
  assert.equal(declinedByLabel({ names: ['Aisha', 'Ben'], unnamed: 1 }), 'Declined by Aisha, Ben and 1 more');
  assert.equal(declinedByLabel({ names: ['Aisha'], unnamed: 1 }), 'Declined by Aisha and 1 more');
});

test('a record with no name falls back to "Declined by an owner"', () => {
  for (const none of [null, undefined, { names: [], unnamed: 0 }, { names: [], unnamed: 1 }, { names: [], unnamed: 3 }, {}, { names: 'Aisha' }]) {
    assert.equal(declinedByLabel(none), 'Declined by an owner', JSON.stringify(none));
  }
});

test('a name is plain words: no link, markup, number, symbol, control or direction character survives', () => {
  assert.equal(plainName('Aisha'), 'Aisha');
  assert.equal(plainName('  Aisha   binti  Rahman '), 'Aisha binti Rahman');
  assert.equal(plainName("Siobhán O’Neill-Brown"), 'Siobhán O’Neill-Brown');
  assert.equal(plainName('Zoë'), 'Zoë');
  assert.equal(plainName('J.R. Tan'), 'J.R. Tan');
  assert.equal(plainName('Ai​sha'), 'Aisha', 'a zero-width character is removed, not kept in the middle of a name');
  assert.equal(plainName('‮ahsia'), 'ahsia', 'a direction override cannot turn the line around');
  assert.equal(plainName('Aisha\nBen\t'), 'Aisha Ben');
  for (const hostile of [
    'https://evil.example/pay Aisha',
    'Aisha http://evil.example',
    'www.evil.example Aisha',
    'evil.example Aisha',
    'Aisha evil[.]example',
    'pay@evil.example Aisha',
    '<script>alert(1)</script> Aisha',
    '<img src=x onerror=alert(1)> Aisha',
    '[Aisha](https://evil.example)',
    'Aisha 😀',
    'Aisha =HYPERLINK("https://evil.example")',
    '"; DROP TABLE users; -- Aisha',
  ]) {
    const clean = plainName(hostile);
    assert.ok(clean === null || /^[\p{L}\p{M}][\p{L}\p{M}'’. -]*$/u.test(clean), `${hostile} -> ${clean}`);
    assert.doesNotMatch(clean ?? '', /https?|www|@|<|>|\[|\]|=|"|;|:|\/|evil/i, `${hostile} -> ${clean}`);
  }
  assert.equal(plainName('https://evil.example/pay Aisha'), 'Aisha');
  assert.equal(plainName('https://evil.example'), null, 'a name that is only a link is no name');
  assert.equal(plainName('<<>>'), null);
  assert.equal(plainName('1234'), null);
  assert.equal(plainName(''), null);
  assert.equal(plainName('   '), null);
  assert.equal(plainName(null), null);
  assert.equal(plainName(undefined), null);
  assert.equal(plainName(42), null);
  assert.equal(plainName({ toString: () => 'Aisha' }), null, 'only a string is a name');
});

test('a very long name cannot take over the row', () => {
  const long = plainName('A'.repeat(500));
  assert.ok(long && long.length <= 31, `${long?.length}`);
  const words = plainName(Array.from({ length: 60 }, (_, i) => `Name${'x'.repeat(i % 5)}`).join(' ').replaceAll(/\d/g, ''));
  assert.ok(words && words.length <= 31, `${words?.length}`);
  const label = declinedByLabel({ names: ['B'.repeat(500), 'C'.repeat(500)], unnamed: 4 });
  assert.ok(label.length < 100, `${label.length}`);
  assert.match(label, /^Declined by B+…? and C+…?,? and 4 more$|^Declined by B+…?, C+…? and 4 more$/);
});

test('the formatter cleans a name again, so a name that arrives hostile is said as plain words or not at all', () => {
  assert.equal(declinedByLabel({ names: ['https://evil.example/pay Aisha'], unnamed: 0 }), 'Declined by Aisha');
  assert.equal(declinedByLabel({ names: ['https://evil.example'], unnamed: 0 }), 'Declined by an owner');
  assert.equal(declinedByLabel({ names: ['https://evil.example', 'Ben'], unnamed: 0 }), 'Declined by Ben and 1 more', 'an unusable name still counts as a person who declined');
  assert.equal(declinedByLabel({ names: ['<b>Aisha</b>', 'Ben'], unnamed: 0 }), 'Declined by Ben and 1 more');
});

test('History says who declined a payment and a batch, and a withdrawal stays "Withdrawn"', () => {
  assert.equal(transferLabel(transfer({ declinedBy: { names: ['Aisha'], unnamed: 0 } })), 'Declined by Aisha');
  assert.equal(transferLabel(transfer({ declinedBy: { names: ['Aisha', 'Ben'], unnamed: 0 } })), 'Declined by Aisha and Ben');
  assert.equal(labelOf(batch({ declinedBy: { names: ['Aisha', 'Ben', 'Chen'], unnamed: 0 } })), 'Declined by Aisha, Ben and 1 more');
  // No record of who: the row reads as it always did for a payment, and a batch now says the same.
  assert.equal(transferLabel(transfer()), 'Declined by an owner');
  assert.equal(labelOf(batch()), 'Declined by an owner');
  assert.equal(transferLabel(transfer({ status: 'withdrawn' })), 'Withdrawn');
  assert.equal(labelOf(batch({ status: 'withdrawn' })), 'Withdrawn');
  // Names belong to a declined row: a row in any other state never carries one.
  assert.equal(transferLabel(transfer({ status: 'withdrawn', declinedBy: { names: ['Aisha'], unnamed: 0 } })), 'Withdrawn');
  assert.equal(transferLabel(transfer({ status: 'settled', declinedBy: { names: ['Aisha'], unnamed: 0 } })), 'Paid');
  assert.equal(labelOf(batch({ status: 'expired', declinedBy: { names: ['Aisha'], unnamed: 0 } })), 'Expired before it was signed');
});

test('a declined row stays out of the failures and keeps its tone, group and no receipt', () => {
  const [e] = buildHistory({ transfers: [transfer({ declinedBy: { names: ['Aisha'], unnamed: 0 } })], batches: [], withdrawals: [], earlier: [] });
  assert.deepEqual([e.group, e.status.tone, e.href, e.explain, e.mayChange], ['not_paid', 'bad', null, null, false]);
  assert.match(e.noReceipt ?? '', /No payment was made/);
});

test('the export carries the same words, and a name cannot start a formula in a spreadsheet', async () => {
  const { historyCsv } = await import('../lib/history-page/entries.ts');
  const csv = historyCsv(buildHistory({ transfers: [transfer({ declinedBy: { names: ['=cmd|calc', 'Ben'], unnamed: 0 } })], batches: [batch({ declinedBy: { names: ['Aisha'], unnamed: 0 } })], withdrawals: [], earlier: [] }));
  assert.match(csv, /Declined by Aisha/);
  assert.match(csv, /Declined by Ben and 1 more/);
  assert.doesNotMatch(csv, /cmd|calc/);
});

test('every screen that words a declined batch or payment uses the one formatter', () => {
  const flow = code(read('components/batch/BatchFlow.tsx'));
  const send = code(read('components/batch/StepSend.tsx'));
  const history = code(read('lib/history-page/entries.ts'));
  for (const [name, source] of [['BatchFlow', flow], ['StepSend', send], ['entries', history]]) {
    assert.match(source, /declinedByLabel/, `${name} words a declined row through declinedByLabel`);
    assert.doesNotMatch(source, /Declined by the owners|declined the batch/, `${name} no longer says the owners as a group`);
  }
});

test('the batch page never reads a status from the plain table directly: every place goes through statusWords', () => {
  const flow = code(read('components/batch/BatchFlow.tsx'));
  const lookups = flow.match(/STATUS_WORDS\[[^\]]*\]/g) ?? [];
  assert.deepEqual(lookups, ['STATUS_WORDS[b.status]'], 'the one lookup is inside statusWords, which words a declined batch by who declined it');
  assert.match(flow, /statusWords\(made\.batch\)/, 'the summary beside the approval says who declined too');
  assert.match(flow, /statusWords\(b\)/, 'and so does the list of batches');
});

test('the words and the formatter obey the copy rules', () => {
  const words = [
    declinedByLabel({ names: ['Aisha'], unnamed: 0 }),
    declinedByLabel({ names: ['Aisha', 'Ben'], unnamed: 0 }),
    declinedByLabel({ names: ['Aisha', 'Ben'], unnamed: 2 }),
    declinedByLabel(null),
  ].join('\n');
  assert.deepEqual(copyViolations('components/history/words.tsx', words), []);
  assert.deepEqual(copyViolations('components/team/declined-by.tsx', read('lib/team/declined-by.ts')), []);
});
