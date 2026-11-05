/**
 * "Declined by <who>" (v2 Phase 3, Sky's decisions): a payment or batch the
 * owners declined says who declined it, in History and wherever the same status
 * shows, and the signing panel says it to the people still signing. Pure and
 * client-safe, so the server and the page say it the same way.
 *
 * Each person is "Name (Title)": the name and the title as they were when the
 * person declined (the signing request keeps them), the title being the
 * member's own title when set (Settings, Team; at most 40 characters), else
 * their role ("Owner", "Finance lead").
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
/** A title is at most this many characters, the ellipsis of a cut one included (a member's job title, lib/team/member-title.ts). */
export const TITLE_MAX = 40;
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

/**
 * What differs between a name and a title: the length (a name is cut at 30 characters and the ellipsis comes after them; a
 * title is cut so that the ellipsis is the 40th character), and two kindnesses to a title that a name does not need. A short
 * word with one ampersand inside it (R&D, P&L, M&A) is a word. And a title cut at a word that is not plain does not end on a
 * connector ("Head of 3 teams" is "Head", not "Head of"). The words allowed are otherwise the same.
 */
type Kind = { max: number; ellipsisCounts: boolean; title: boolean };
const NAME: Kind = { max: MAX_NAME, ellipsisCounts: false, title: false };
const TITLE: Kind = { max: TITLE_MAX, ellipsisCounts: true, title: true };

/** A short word of letters with one ampersand between them: R&D, P&L, M&A, AT&T. Too short to hold a second person's name. */
const AMPERSAND_WORD = /^\p{L}+&\p{L}+$/u;
const AMPERSAND_WORD_MAX = 6;
/** Words a title cannot end on after it was cut: what follows them was left out. */
const TRAILING_CONNECTORS = new Set(['of', 'to', 'for', 'the', 'a', 'an', 'in', 'at', 'on', 'with', 'by']);
/** The word a title stopped at is said back to the person who typed it: never more than this. */
const LEFT_OUT_MAX = 20;

function isPlainWord(word: string, kind: Kind): boolean {
  if (kind.title && word.includes('&')) {
    if (!AMPERSAND_WORD.test(word) || Array.from(word).length > AMPERSAND_WORD_MAX) return false;
  } else if (!WORD.test(word)) {
    return false;
  }
  if (ADDRESS_LIKE.test(word) || /^www/iu.test(word) || MARK_STACK.test(word)) return false;
  if (NOT_A_NAME_WORD.has(word.toLowerCase())) return false;
  return SCRIPTS.filter((script) => script.test(word)).length <= 1;
}

/**
 * A name as plain words, or null when nothing plain is left. Only a string is one.
 *
 * Brackets and commas are removed where they stand, so "Aisha (CFO)" is "Aisha CFO" and
 * "Tan, Aisha" is "Tan Aisha"; the name is then the plain words up to the first word that
 * is not plain: what follows a link, markup, a number or a symbol is never shown as the
 * person, and a name that starts with one is no name (the title or "an owner" is said
 * instead). A name over 30 characters is cut once at a word, by whole characters, and ends
 * in the one ellipsis character; cutting a cut name changes nothing.
 */
export function plainName(raw: unknown): string | null {
  return plainWords(raw, NAME).text;
}

/**
 * A member's job title as plain words, or null when nothing plain is left: exactly the cleaning of
 * a name (so it cannot add a bracket, a comma, a link, or a word such as "and" that makes one
 * account read as two people), with a limit of 40 characters instead of 30, the ellipsis of a cut
 * title being the 40th. Cutting a cut title changes nothing.
 */
export function plainTitle(raw: unknown): string | null {
  return plainWords(raw, TITLE).text;
}

/**
 * The same cleaning, and the word it stopped at (at most 20 characters of it): what a person who typed
 * "Level 2 Support" is told, that "2" and everything after it was left out. Null when nothing was left out.
 */
export function plainTitleDetail(raw: unknown): { title: string | null; stoppedAt: string | null } {
  const { text, stoppedAt } = plainWords(raw, TITLE);
  return { title: text, stoppedAt };
}

function plainWords(raw: unknown, kind: Kind): { text: string | null; stoppedAt: string | null } {
  if (typeof raw !== 'string') return { text: null, stoppedAt: null };
  const text = raw
    // Bounded before any pattern runs: a paste of a million characters is cut, it does not cost a million.
    .slice(0, 4000)
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
  let stoppedAt: string | null = null;
  for (const word of text.replace(CUT_MARK, '').split(/\s+/u)) {
    if (word === '') continue;
    if (!isPlainWord(word, kind)) {
      stoppedAt = Array.from(word).slice(0, LEFT_OUT_MAX).join('');
      break;
    }
    plain.push(word);
  }
  // A title that was cut at a word is not left hanging on "of" or "the".
  if (kind.title && stoppedAt !== null) {
    while (plain.length > 0 && TRAILING_CONNECTORS.has(plain[plain.length - 1].toLowerCase())) plain.pop();
  }
  const joined = plain.join(' ');
  if (joined === '') return { text: null, stoppedAt };
  const chars = Array.from(joined);
  const room = kind.ellipsisCounts ? kind.max - 1 : kind.max;
  if (chars.length + (kind.ellipsisCounts && cutAlready ? 1 : 0) <= kind.max) return { text: cutAlready ? `${joined}${ELLIPSIS}` : joined, stoppedAt };
  const head = chars.slice(0, room);
  const atWord = chars[room] === ' ' ? -1 : head.lastIndexOf(' ');
  return { text: `${(atWord > 0 ? head.slice(0, atWord) : head).join('').trim()}${ELLIPSIS}`, stoppedAt };
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
  const title = plainTitle(p.title);
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
    const title = plainTitle(p.title);
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
