/**
 * "Declined by <who>" (v2 Phase 3, Sky's decision): a payment or batch the
 * owners declined says who declined it, in History and wherever the same status
 * shows. Pure and client-safe, so the server and the page say it the same way.
 *
 *   one owner          Declined by Aisha
 *   two owners         Declined by Aisha and Ben           (in the order they declined)
 *   more than two      Declined by Aisha, Ben and 1 more   (two names, then the count)
 *   no usable name     Declined by an owner
 *
 * A name is a person's own text, so it is only ever said as plain words: it is
 * cleaned where it is read from the record and again here (the second pass
 * changes nothing), and it stops at the first word that is not a plain word (a
 * link, markup, a number, a symbol, an emoji). A decliner whose name leaves
 * nothing still counts as one of the people who declined. "Withdrawn" is not a
 * decline and names nobody; the caller only passes this a declined row.
 */

/** The people who declined, as the signing request's record has them: usable names in the order they declined, and how many had none. */
export type Decliners = { names: string[]; unnamed: number };

const MAX_NAME = 30;
const ELLIPSIS = '…';
const WORD = /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*$/u;
/** A dot between letters that reads as an address (evil.example), unlike the dots of "J.R." or "St." */
const ADDRESS_LIKE = /[\p{L}\p{N}]\.\p{L}{2,}/u;
/** The hyphens and dashes a keyboard other than ours types: NFKC leaves most of them alone, so they are mapped to the hyphen of a name. */
const DASHES = /[‐-―−﹘﹣－]/gu;
/** A cut name ends in the ellipsis character, which NFKC turns into three dots; reading that ending back is what makes cutting a cut name a no-op. */
const CUT_MARK = /\.{3}\s*$/u;
/** More combining marks in a row than any real letter carries would stack through the lines around the name. */
const MARK_STACK = /\p{M}{4,}/u;
/** Words that make one account read as two people or as a sentence of its own. */
const NOT_A_NAME_WORD = new Set(['and', 'declined']);
/** The scripts one word may not mix (a Cyrillic look-alike inside a Latin word). Han and kana are one group, as Japanese writes them together. */
const SCRIPTS: readonly RegExp[] = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
  /\p{Script=Arabic}/u,
  /\p{Script=Hebrew}/u,
  /\p{Script=Armenian}/u,
  /\p{Script=Georgian}/u,
  /\p{Script=Devanagari}/u,
  /\p{Script=Thai}/u,
  /\p{Script=Hangul}/u,
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
];
const FALLBACK = 'Declined by an owner';

function isPlainWord(word: string): boolean {
  if (!WORD.test(word) || ADDRESS_LIKE.test(word) || /^www/iu.test(word) || MARK_STACK.test(word)) return false;
  if (NOT_A_NAME_WORD.has(word.toLowerCase())) return false;
  return SCRIPTS.filter((script) => script.test(word)).length <= 1;
}

/**
 * A name as plain words, or null when nothing plain is left. Only a string is a name.
 *
 * The name is the plain words up to the first word that is not plain: what
 * follows a link, markup, a number or a symbol is never shown as the person, and
 * a name that starts with one is no name (the person still counts, as "an owner").
 * A name over 30 characters is cut once at a word, by whole characters, and ends
 * in the one ellipsis character; cutting a cut name changes nothing.
 */
export function plainName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw
    .normalize('NFKC')
    .replace(DASHES, '-')
    // Control, format (zero-width, direction overrides) and unassigned characters are removed, not kept inside a word.
    .replace(/[\p{C}]/gu, (c) => (/\s/u.test(c) ? ' ' : ''))
    .trim();
  const cutAlready = CUT_MARK.test(text);
  const plain: string[] = [];
  for (const word of text.replace(CUT_MARK, '').split(/\s+/u)) {
    if (word === '') continue;
    if (!isPlainWord(word)) break;
    plain.push(word);
  }
  const joined = plain.join(' ');
  if (joined === '') return null;
  const chars = Array.from(joined);
  if (chars.length <= MAX_NAME) return cutAlready ? `${joined}${ELLIPSIS}` : joined;
  const head = chars.slice(0, MAX_NAME);
  const atWord = chars[MAX_NAME] === ' ' ? -1 : head.lastIndexOf(' ');
  return `${(atWord > 0 ? head.slice(0, atWord) : head).join('').trim()}${ELLIPSIS}`;
}

/** Whatever arrived, as a Decliners with only plain names; an unusable name moves to the count. */
export function cleanDecliners(value: unknown): Decliners {
  const v = value && typeof value === 'object' ? (value as { names?: unknown; unnamed?: unknown }) : {};
  const names: string[] = [];
  let unnamed = Number.isSafeInteger(v.unnamed) && (v.unnamed as number) > 0 ? (v.unnamed as number) : 0;
  for (const raw of Array.isArray(v.names) ? v.names : []) {
    const name = plainName(raw);
    if (name) names.push(name);
    else unnamed += 1;
  }
  return { names, unnamed };
}

/** The status words of a declined payment or batch. */
export function declinedByLabel(declined: Decliners | null | undefined): string {
  const { names, unnamed } = cleanDecliners(declined);
  if (names.length === 0) return FALLBACK;
  const shown = names.slice(0, 2);
  const more = names.length + unnamed - shown.length;
  if (more === 0) return `Declined by ${shown.join(' and ')}`;
  return `Declined by ${shown.join(', ')} and ${more} more`;
}
