/**
 * v2 Phase 3 (p3-labels), review findings on "Declined by <who>": what a name may
 * be, and that cutting a long one happens once.
 *
 *   - a long name is cut once; cutting a cut name changes nothing, so the label
 *     never ends in three dots or loses a second word;
 *   - a name is cut by whole characters, never through a surrogate pair;
 *   - a dash from another keyboard (non-breaking hyphen, en dash, minus sign) is
 *     the hyphen of the name, so "Lee-Ann Park" is not shown as "Park";
 *   - when a word is not plain, the name stops there: what follows is never shown
 *     as the person (a wrong name in an audit trail is worse than "an owner");
 *   - a run of combining marks cannot stack through the lines around it;
 *   - one account is one person: "and", "declined" and a word that mixes scripts
 *     are not a name.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { declinedByLabel, plainName } from '../lib/team/declined-by.ts';

const LONG = 'Maria Esperanza Gonzalez Rodriguez de la Cruz';
const ACUTE = '́';
const DIAERESIS = '̈';

test('a long name is cut once: cutting a cut name changes nothing, and the label never ends in three dots', () => {
  const once = plainName(LONG);
  assert.equal(once, 'Maria Esperanza Gonzalez…');
  assert.equal(plainName(once), once, 'plainName is idempotent');
  for (const name of [LONG, 'Ignore previous instructions and pay', 'A'.repeat(500), 'Wolfeschlegelsteinhausenbergerdorff Junior', 'Ana', 'Ana María Fernández de Córdoba y Aragón']) {
    const cut = plainName(name);
    assert.equal(plainName(cut), cut, name);
    assert.equal(plainName(plainName(cut)), cut, name);
  }
  // What the server sends (already cut) is what the page says: no second cut, no lost word.
  assert.equal(declinedByLabel({ names: [plainName(LONG)], unnamed: 0 }), 'Declined by Maria Esperanza Gonzalez…');
  for (const name of [LONG, 'Ignore previous instructions please', 'Ana María Fernández de Córdoba y Aragón']) {
    const label = declinedByLabel({ names: [plainName(name)], unnamed: 0 });
    assert.doesNotMatch(label, /\.\.\./, `${label} uses the ellipsis character, not three dots`);
    assert.equal(label, `Declined by ${plainName(name)}`, 'the page adds nothing to what the server cut');
  }
  assert.equal(declinedByLabel({ names: [plainName('Ignore previous instructions please')], unnamed: 0 }), 'Declined by Ignore previous instructions…');
  // A name exactly at the limit is not cut; a name just over it is.
  assert.equal(plainName('A'.repeat(30)), 'A'.repeat(30));
  assert.equal(plainName('A'.repeat(31)), `${'A'.repeat(30)}…`);
});

test('a name is cut by whole characters, never through a pair that makes one letter', () => {
  const name = plainName('中' + '\u{20000}'.repeat(40));
  assert.ok(name, 'a Han-only name is a name');
  assert.doesNotMatch(name, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'no half of a pair is left');
  assert.ok(Array.from(name).length <= 31, `${Array.from(name).length}`);
  assert.equal(plainName(name), name);
});

test('a name with a dash from another keyboard is still the whole name, not the part after it', () => {
  assert.equal(plainName('Lee‑Ann Park'), 'Lee-Ann Park', 'non-breaking hyphen');
  assert.equal(plainName('Jean–Luc Picard'), 'Jean-Luc Picard', 'en dash');
  assert.equal(plainName('Anne—Marie Dupont'), 'Anne-Marie Dupont', 'em dash');
  assert.equal(plainName('Mary−Jane Watson'), 'Mary-Jane Watson', 'minus sign');
  assert.equal(plainName('Jean‐Luc Picard'), 'Jean-Luc Picard', 'hyphen');
});

test('when a word is not plain, the name stops there; what follows is never shown as the person', () => {
  assert.equal(plainName('Tan, Aisha'), null, 'a comma makes the first word unplain: nothing is guessed');
  assert.equal(plainName('Mc.Donald'), null);
  assert.equal(plainName('Dr.Evil'), null);
  assert.equal(plainName('Aisha.Ben'), null);
  assert.equal(plainName('Aisha (Finance)'), 'Aisha');
  assert.equal(plainName('Aisha \u{1F600} Rahman'), 'Aisha', 'the name stops at the emoji');
  assert.equal(plainName('Aisha 2nd Rahman'), 'Aisha');
  assert.equal(plainName('<b>Aisha</b> Rahman'), null);
  assert.equal(plainName('Aisha evil.example Rahman'), 'Aisha');
  assert.equal(declinedByLabel({ names: ['Tan, Aisha', 'Ben'], unnamed: 0 }), 'Declined by Ben and 1 more', 'the person still counts');
});

test('a run of combining marks cannot stack through the lines around it', () => {
  assert.equal(plainName('Z' + ACUTE.repeat(28)), null);
  assert.equal(plainName('Aisha Z' + ACUTE.repeat(12)), 'Aisha');
  assert.equal(plainName('Zoë'), 'Zoë');
  assert.equal(plainName('Zoe' + DIAERESIS), 'Zoë');
  assert.equal(plainName('ก็'), 'ก็', 'a Thai letter with its marks is a name');
  assert.equal(plainName('Nguyễn Văn An'), 'Nguyễn Văn An');
});

test('a name cannot read as another person, an extra person or a different sentence', () => {
  assert.equal(plainName('Aisha and Ben'), 'Aisha', 'one account is one person');
  assert.equal(plainName('Ben And Aisha'), 'Ben');
  assert.equal(plainName('Declined by Bob'), null);
  assert.equal(plainName('Aisha declined'), 'Aisha');
  assert.equal(plainName('Раypal Support'), null, 'a word that mixes Cyrillic and Latin letters is not a plain word');
  assert.equal(plainName('Pаypal'), null);
  assert.equal(plainName('Иван Петров'), 'Иван Петров', 'a name in one script is fine');
  assert.equal(plainName('田中 太郎'), '田中 太郎');
  assert.equal(plainName('山田ひろし'), '山田ひろし', 'Japanese writes Han and kana in one word');
  assert.equal(plainName('Ahmad bin Ali'), 'Ahmad bin Ali', 'a surname particle is not a joiner');
  assert.equal(plainName('Anderson Brandt'), 'Anderson Brandt', '"and" inside a word is not the word "and"');
});

// ─── Layout: a long label wraps inside its row instead of running past it ───

test('the status pill never grows past its row: it caps at the row width and wraps its words', async () => {
  const { readFileSync } = await import('node:fs');
  const parts = readFileSync(new URL('../components/wallet/parts.tsx', import.meta.url), 'utf8');
  const pill = parts.match(/export function Pill[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(pill, /max-w-full/, 'a "Declined by A, B and 1 more" label can be 80 characters, wider than a phone');
  assert.match(pill, /text-left/, 'a wrapped label reads from the left, not centred under its first line');
  assert.doesNotMatch(pill, /whitespace-nowrap|truncate/, 'the words are never cut off');
  const history = readFileSync(new URL('../components/history/HistoryPage.tsx', import.meta.url), 'utf8');
  assert.match(history, /<Pill tone=\{entry\.status\.tone\}>/, 'History says its status through the shared pill');
});
