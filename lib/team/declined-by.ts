/**
 * "Declined by <who>" (v2 Phase 3, Sky's decisions): a payment or batch the
 * owners declined says who declined it, in History and wherever the same status
 * shows, and the signing panel says it to the people still signing. Pure and
 * client-safe, so the server and the page say it the same way.
 *
 * Each person is "Name (Title)": the name and the title as they were when the
 * person declined (the signing request keeps them), the title being the
 * member's own title when set, else their role ("Owner", "Finance lead").
 *
 *   History (capped)   Declined by Aisha (CFO) and Ben (Finance lead)
 *                      Declined by Aisha (CFO), Ben (Staff) and 1 more       (two, then the count)
 *   Signing panel      Declined by Aisha (CFO), Ben (Staff) and Chen (Owner) (all of them)
 *   nobody usable      Declined by an owner (the panel says "an owner" for each person with nothing to name)
 *
 * A name and a title are a person's own text, so each is only ever said as plain
 * words, cleaned SEPARATELY (where it is read from the record and again here; the
 * second pass changes nothing) and only then put in the shape "Name (Title)". So
 * neither can add a bracket, a comma, a link or a second person. Brackets and
 * commas inside one field become spaces; a field stops at the first word
 * that is not a plain word (a link, markup, a number, a symbol, an emoji). A name
 * left with nothing is said by the title alone. A person with neither is "an
 * owner" in the signing panel (which names everyone) and one of the "N more" in
 * History (which names two). "Withdrawn" is not a decline and names nobody; the
 * caller only passes this a declined row.
 */

/** One person who declined: their name and title as they were when they declined. Each is plain words or null. */
export type Decliner = { name: string | null; title: string | null };

/**
 * The people who declined, as the signing request's own record has them: those with a usable name or
 * title in the order they declined, and how many had neither. (An entry that is a plain string is read
 * as a name with no title.)
 */
export type Decliners = { names: Decliner[]; unnamed: number };

const MAX_NAME = 30;
const ELLIPSIS = '…';
const WORD = /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*$/u;
/** A dot between letters that reads as an address (evil.example), unlike the dots of "J.R." or "St." */
const ADDRESS_LIKE = /[\p{L}\p{N}]\.\p{L}{2,}/u;
/** The hyphens and dashes a keyboard other than ours types: NFKC leaves most of them alone, so they are mapped to the hyphen of a name. */
const DASHES = /[‐-―−﹘﹣－]/gu;
/** Brackets of every kind and the commas of every keyboard: removed in place inside one field, so they can never frame or separate a second person. */
const BRACKETS_AND_COMMAS = /[\p{Ps}\p{Pe},،、﹐﹑]/gu;
/** A dot in brackets, the way an address is written to get past a filter. */
const DEFANGED_DOT = /[\p{Ps}]\.+[\p{Pe}]/gu;
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
 * A name (or a title) as plain words, or null when nothing plain is left. Only a string is one.
 *
 * Brackets and commas are removed where they stand, so "Aisha (CFO)" is "Aisha CFO" and
 * "Tan, Aisha" is "Tan Aisha"; the name is then the plain words up to the first word that
 * is not plain: what follows a link, markup, a number or a symbol is never shown as the
 * person, and a name that starts with one is no name (the title or "an owner" is said
 * instead). A name over 30 characters is cut once at a word, by whole characters, and ends
 * in the one ellipsis character; cutting a cut name changes nothing.
 */
export function plainName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw
    .normalize('NFKC')
    .replace(DASHES, '-')
    // A defanged address ("evil[.]example") is still an address: the bracketed dot goes back to a dot, so the word stops the name.
    .replace(DEFANGED_DOT, '.')
    // A bracket or comma visibly separates words, so it becomes a space (never fuses "Tan,Aisha" into "TanAisha"); the split below collapses runs of spaces.
    .replace(BRACKETS_AND_COMMAS, ' ')
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

/** A person as the record gives them (an entry that is a plain string is a name with no title). */
function personOf(raw: unknown): { name: unknown; title: unknown } {
  if (typeof raw === 'string') return { name: raw, title: null };
  return raw && typeof raw === 'object' ? (raw as { name: unknown; title: unknown }) : { name: null, title: null };
}

/**
 * "Name (Title)". Each is cleaned on its own first, then put in the shape, so neither can reach
 * into the other's place. A name that is empty after cleaning is replaced by the title alone, a
 * title that is empty is left out, and a person with neither is "an owner".
 */
export function declinerLabel(person: unknown): string {
  const p = personOf(person);
  const name = plainName(p.name);
  const title = plainName(p.title);
  if (name && title) return `${name} (${title})`;
  return name ?? title ?? 'an owner';
}

/** Whatever arrived, as a Decliners with only plain names and titles; a person with neither moves to the count. */
export function cleanDecliners(value: unknown): Decliners {
  const v = value && typeof value === 'object' ? (value as { names?: unknown; unnamed?: unknown }) : {};
  const names: Decliner[] = [];
  let unnamed = Number.isSafeInteger(v.unnamed) && (v.unnamed as number) > 0 ? (v.unnamed as number) : 0;
  for (const raw of Array.isArray(v.names) ? v.names : []) {
    const p = personOf(raw);
    const name = plainName(p.name);
    const title = plainName(p.title);
    if (name || title) names.push({ name, title });
    else unnamed += 1;
  }
  return { names, unnamed };
}

/** The status words of a declined payment or batch in History: two people, then the count of the rest. */
export function declinedByLabel(declined: Decliners | null | undefined): string {
  const { names, unnamed } = cleanDecliners(declined);
  if (names.length === 0) return FALLBACK;
  const shown = names.slice(0, 2).map(declinerLabel);
  const more = names.length + unnamed - shown.length;
  if (more === 0) return `Declined by ${shown.join(' and ')}`;
  return `Declined by ${shown.join(', ')} and ${more} more`;
}

/** No wallet has this many owners; the cap only keeps a bad count from building a huge sentence. */
const MAX_UNNAMED_SAID = 20;

/**
 * The same facts for the signing panel, which names every person who declined. A person with
 * no usable name or title is said as "an owner" (never counted as "N more": the count is History's).
 */
export function declinedByAllLabel(declined: Decliners | null | undefined): string {
  const { names, unnamed } = cleanDecliners(declined);
  const parts = names.map(declinerLabel);
  for (let i = 0; i < Math.min(unnamed, MAX_UNNAMED_SAID); i += 1) parts.push('an owner');
  if (parts.length === 0) return FALLBACK;
  if (parts.length === 1) return `Declined by ${parts[0]}`;
  return `Declined by ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
