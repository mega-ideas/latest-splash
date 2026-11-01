/**
 * v2 Phase 3 (p3-decliners), Sky's decisions on "Declined by (name)":
 *
 *   - the signing panel names everyone who declined, all names; History keeps
 *     its cap of two names and then "and N more" (same facts, the panel shows all);
 *   - every label carries the person's title in brackets: "Aisha (CFO)". The title
 *     is the member's own title when set, else the role label ("Owner",
 *     "Finance lead");
 *   - name and title are cleaned SEPARATELY as plain words and only then put in
 *     the shape "Name (Title)", so a hostile name or title cannot add a bracket,
 *     a comma, a link or a second person; a name empty after cleaning falls back
 *     to the title alone, and with neither it is "an owner";
 *   - brackets and commas inside one field are removed in place (the earlier rule
 *     that dropped the whole name is replaced).
 *
 * Pure. tests/declined-by-history.test.mjs runs the same on a real database
 * (the snapshot at the moment of declining, leavers, renames, other businesses).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { copyViolations } from '../scripts/copy-rules.mjs';
import { cleanDecliners, declinedByAllLabel, declinedByLabel, declinerLabel, plainName } from '../lib/team/declined-by.ts';
import { memberTitle } from '../lib/team/member-title.ts';
import { buildHistory } from '../lib/history-page/entries.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const person = (name, title) => ({ name, title });

test('a label is "Name (Title)", the title alone when the name is empty, "an owner" when both are', () => {
  assert.equal(declinerLabel(person('Aisha', 'CFO')), 'Aisha (CFO)');
  assert.equal(declinerLabel(person('Ben', 'Finance lead')), 'Ben (Finance lead)');
  assert.equal(declinerLabel(person('Aisha', null)), 'Aisha');
  assert.equal(declinerLabel(person(null, 'CFO')), 'CFO');
  assert.equal(declinerLabel(person('   ', 'CFO')), 'CFO', 'a name that is empty after cleaning falls back to the title');
  assert.equal(declinerLabel(person('<<>>', 'Owner')), 'Owner');
  assert.equal(declinerLabel(person(null, null)), 'an owner');
  assert.equal(declinerLabel(person('https://evil.example', '1234')), 'an owner');
  assert.equal(declinerLabel(null), 'an owner');
  assert.equal(declinerLabel('Aisha'), 'Aisha', 'a plain string is a name with no title');
});

test('brackets and commas inside one field are removed in place; the name is not dropped', () => {
  assert.equal(plainName('Aisha (CFO)'), 'Aisha CFO');
  assert.equal(plainName('Tan, Aisha'), 'Tan Aisha');
  assert.equal(plainName('(((Aisha)))'), 'Aisha');
  assert.equal(plainName('[Aisha], {Ben}'), 'Aisha Ben');
  assert.equal(plainName('Aisha（CFO）'), 'Aisha CFO', 'full-width brackets too');
  assert.equal(plainName('「Aisha」'), 'Aisha', 'corner brackets too');
  assert.equal(plainName('Aisha，Ben'), 'Aisha Ben', 'a full-width comma too');
  // Punctuation that visibly separates two words must not fuse them into a made-up word ("TanAisha").
  assert.equal(plainName('Tan,Aisha'), 'Tan Aisha');
  assert.equal(plainName('Smith,John'), 'Smith John');
  assert.equal(plainName('Aisha(CFO)'), 'Aisha CFO');
  assert.equal(plainName('Aisha{Owner}'), 'Aisha Owner');
  assert.equal(plainName('Aisha[CFO]'), 'Aisha CFO');
  assert.equal(plainName('Aisha،Ben'), 'Aisha Ben', 'an Arabic comma too');
  assert.equal(declinerLabel(person('Tan,Aisha', 'Owner')), 'Tan Aisha (Owner)');
  assert.equal(plainName('(),'), null, 'nothing left is no name');
  assert.equal(declinerLabel(person('Aisha (CFO)', 'Owner')), 'Aisha CFO (Owner)');
  assert.equal(declinerLabel(person('Tan, Aisha', 'Owner')), 'Tan Aisha (Owner)');
});

test('a name and a title are cleaned separately, so neither can add a bracket, a comma, a link or a second person', () => {
  const hostile = [
    ['Aisha (CFO), Ben (Staff)', 'Owner'],
    ['Aisha', 'Owner), Ben (Owner'],
    ['Aisha) and Ben (', 'Owner'],
    ['Aisha', '(Owner) and Ben (Owner)'],
    ['Aisha', '[Finance](https://evil.example)'],
    ['[Aisha](https://evil.example)', 'Owner'],
    ['Aisha', 'https://evil.example/pay'],
    ['<b>Aisha</b>', '<i>Owner</i>'],
    ['Aisha', 'Owner\nBen (Owner)'],
    ['Aisha‮', 'Owner​'],
    ['Aisha', ')))((('],
    ['))((', 'Owner'],
    ['Aisha,Ben', 'Owner'],
    ['Aisha(CFO)Ben{Staff}', 'Owner,Ben(Owner)'],
  ];
  for (const [name, title] of hostile) {
    const label = declinerLabel(person(name, title));
    // At most one bracketed title, closed once, at the end; no comma, link, markup or direction character anywhere.
    assert.match(label, /^[^()[\]{}<>,:/@=​-‏‪-‮]*( \([^()[\]{}<>,:/@=​-‏‪-‮]+\))?$/u, `${JSON.stringify([name, title])} -> ${label}`);
    assert.doesNotMatch(label, /evil|https?|www/i, label);
    assert.doesNotMatch(label, /\band\b/i, `a name cannot make a second person: ${label}`);
  }
  assert.equal(declinerLabel(person('Aisha (CFO), Ben (Staff)', 'Owner')), 'Aisha CFO Ben Staff (Owner)', 'one account is one label, however it is written');
  assert.equal(declinerLabel(person('Aisha', 'Owner), Ben (Owner')), 'Aisha (Owner Ben Owner)');
  assert.equal(declinerLabel(person('Aisha', '[Finance](https://evil.example)')), 'Aisha (Finance)', 'the link is never shown, the plain word before it is');
  assert.equal(declinerLabel(person('Aisha', '(https://evil.example)')), 'Aisha');
  assert.equal(declinerLabel(person('Aisha', ')))(((')), 'Aisha', 'a title with nothing left is left out, not shown as empty brackets');
});

test('a name and a title are each cut once to a sensible length with the one ellipsis character', () => {
  const label = declinerLabel(person('A'.repeat(500), 'B'.repeat(500)));
  assert.match(label, /^A{30}… \(B{39}…\)$/, 'a name is cut at 30 and a title at 40 (the ellipsis counted)');
  assert.equal(declinerLabel(person(plainName('A'.repeat(500)), plainName('B'.repeat(500)))), label, 'cutting what was cut changes nothing');
  assert.equal(declinerLabel(person('  Aisha   binti    Rahman ', '  Finance    lead ')), 'Aisha binti Rahman (Finance lead)', 'spaces are collapsed');
});

test('the capped sentence (History) names two and counts the rest; the full sentence (the panel) names all', () => {
  const two = { names: [person('Aisha', 'CFO'), person('Ben', 'Finance lead')], unnamed: 0 };
  assert.equal(declinedByLabel(two), 'Declined by Aisha (CFO) and Ben (Finance lead)');
  assert.equal(declinedByAllLabel(two), 'Declined by Aisha (CFO) and Ben (Finance lead)');
  const three = { names: [person('Aisha', 'CFO'), person('Ben', 'Finance lead'), person('Chen', 'Owner')], unnamed: 0 };
  assert.equal(declinedByLabel(three), 'Declined by Aisha (CFO), Ben (Finance lead) and 1 more');
  assert.equal(declinedByAllLabel(three), 'Declined by Aisha (CFO), Ben (Finance lead) and Chen (Owner)');
  const four = { names: [...three.names, person('Dara', 'Owner')], unnamed: 0 };
  assert.equal(declinedByLabel(four), 'Declined by Aisha (CFO), Ben (Finance lead) and 2 more');
  assert.equal(declinedByAllLabel(four), 'Declined by Aisha (CFO), Ben (Finance lead), Chen (Owner) and Dara (Owner)');
  assert.equal(declinedByAllLabel({ names: [person('Aisha', 'CFO')], unnamed: 0 }), 'Declined by Aisha (CFO)');
  // The panel names everyone: a decliner with no usable name or title is "an owner", never a count (the count is History's).
  assert.equal(declinedByAllLabel({ names: [person('Aisha', 'Owner')], unnamed: 1 }), 'Declined by Aisha (Owner) and an owner');
  assert.equal(declinedByAllLabel({ names: [person('Aisha', 'CFO')], unnamed: 1 }), 'Declined by Aisha (CFO) and an owner');
  assert.equal(declinedByAllLabel({ names: [person('Aisha', 'CFO'), person('Ben', 'Owner')], unnamed: 2 }), 'Declined by Aisha (CFO), Ben (Owner), an owner and an owner');
  assert.equal(declinedByAllLabel({ names: [], unnamed: 1 }), 'Declined by an owner');
  assert.equal(declinedByAllLabel({ names: [], unnamed: 2 }), 'Declined by an owner and an owner');
  // History keeps its cap and its count.
  assert.equal(declinedByLabel({ names: [person('Aisha', 'Owner')], unnamed: 1 }), 'Declined by Aisha (Owner) and 1 more');
  assert.equal(declinedByLabel({ names: [person('Aisha', 'Owner')], unnamed: 2 }), 'Declined by Aisha (Owner) and 2 more');
  assert.equal(declinedByAllLabel(null), 'Declined by an owner');
  assert.equal(declinedByAllLabel({ names: [], unnamed: 3 }), 'Declined by an owner, an owner and an owner');
  assert.equal(declinedByAllLabel({ names: [], unnamed: 0 }), 'Declined by an owner', 'nobody usable and nobody counted still says an owner');
  assert.equal(declinedByAllLabel({ names: [person(null, null)], unnamed: 0 }), 'Declined by an owner', 'a person with neither is an owner, not blank');
});

test('cleaning what arrives gives only plain name and title, and counts a person with neither', () => {
  const clean = cleanDecliners({ names: [person('Aisha (CFO)', 'Owner'), person('https://evil.example', 'Staff'), person(null, null), 'Ben', 42, null], unnamed: 1 });
  assert.deepEqual(clean, { names: [person('Aisha CFO', 'Owner'), person(null, 'Staff'), person('Ben', null)], unnamed: 4 });
  assert.deepEqual(cleanDecliners(clean), clean, 'a second pass changes nothing');
  assert.deepEqual(cleanDecliners(undefined), { names: [], unnamed: 0 });
  assert.deepEqual(cleanDecliners({ names: 'Aisha' }), { names: [], unnamed: 0 });
});

test('a title is the member’s own title when set, else the role label, "Finance lead" for the appointment', () => {
  assert.equal(memberTitle({ title: 'CFO', role: 'admin' }), 'CFO');
  assert.equal(memberTitle({ title: '  Head   of Finance ', role: 'checker' }), 'Head of Finance');
  assert.equal(memberTitle({ role: 'admin' }), 'Owner');
  assert.equal(memberTitle({ role: 'maker' }), 'Staff');
  assert.equal(memberTitle({ role: 'checker' }), 'Approver');
  assert.equal(memberTitle({ role: 'viewer' }), 'Viewer');
  assert.equal(memberTitle({ role: 'checker', financeLead: true }), 'Finance lead');
  assert.equal(memberTitle({ title: 'CFO', role: 'checker', financeLead: true }), 'CFO', 'their own title wins');
  assert.equal(memberTitle({ title: 'https://evil.example', role: 'admin' }), 'Owner', 'an unusable title is not used');
  assert.equal(memberTitle({ title: '', role: null }), 'Member');
  assert.equal(memberTitle({}), 'Member', 'a person with no membership is still given a word');
});

test('History says the capped sentence, from the same facts', () => {
  const batch = (declinedBy) => ({ id: 'wb_1', label: 'October suppliers', status: 'declined', rowCount: 12, totalMinor: '4000000000', createdAt: '2026-10-22T08:00:00.000Z', declinedBy });
  const label = (declinedBy) => buildHistory({ transfers: [], batches: [batch(declinedBy)], withdrawals: [], earlier: [] })[0].status.label;
  assert.equal(label({ names: [person('Aisha', 'CFO'), person('Ben', 'Finance lead')], unnamed: 0 }), 'Declined by Aisha (CFO) and Ben (Finance lead)');
  assert.equal(label({ names: [person('Aisha', 'CFO'), person('Ben', 'Finance lead'), person('Chen', 'Owner')], unnamed: 0 }), 'Declined by Aisha (CFO), Ben (Finance lead) and 1 more');
});

test('the signing panel, the approve screen and the approve list say the full sentence through the one formatter', () => {
  for (const path of ['components/transfer/SignPanel.tsx', 'components/approve/ApproveInbox.tsx']) {
    const source = code(read(path));
    assert.match(source, /declinedByAllLabel/, `${path} names everyone who declined`);
    assert.doesNotMatch(source, /declinedBy[^\n]*\.names\.join|\.names\.slice/, `${path} does not build its own sentence`);
  }
  assert.match(code(read('components/approve/ApproveScreen.tsx')), /declined/i, 'the phone approve screen has a line for it');
  const panel = code(read('components/transfer/SignPanel.tsx'));
  assert.match(panel, /break-words/, 'a long label wraps inside the panel');
});

test('the words obey the copy rules', () => {
  const words = [
    declinedByAllLabel({ names: [person('Aisha', 'CFO'), person('Ben', 'Finance lead')], unnamed: 1 }),
    declinedByLabel({ names: [person('Aisha', 'CFO')], unnamed: 0 }),
    declinedByAllLabel(null),
  ].join('\n');
  assert.deepEqual(copyViolations('components/approve/declined.tsx', words), []);
  assert.deepEqual(copyViolations('lib/team/member-title.tsx', read('lib/team/member-title.ts')), []);
  assert.deepEqual(copyViolations('lib/team/declined-by.tsx', read('lib/team/declined-by.ts')), []);
});
