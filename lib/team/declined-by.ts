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
 * cleaned where it is read from the record and again here, and a word that is
 * not a plain word (a link, markup, a number, a symbol, an emoji) is dropped
 * with the rest of it. A decliner whose name leaves nothing still counts as
 * one of the people who declined. "Withdrawn" is not a decline and names
 * nobody; the caller only passes this a declined row.
 */

/** The people who declined, as the signing request's record has them: usable names in the order they declined, and how many had none. */
export type Decliners = { names: string[]; unnamed: number };

const MAX_NAME = 30;
const WORD = /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*$/u;
/** A dot between letters that reads as an address (evil.example), unlike the dots of "J.R." or "St." */
const ADDRESS_LIKE = /[\p{L}\p{N}]\.\p{L}{2,}/u;
const FALLBACK = 'Declined by an owner';

/** A name as plain words, or null when nothing plain is left. Only a string is a name. */
export function plainName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const words = raw
    .normalize('NFKC')
    // Control, format (zero-width, direction overrides) and unassigned characters are removed, not kept inside a word.
    .replace(/[\p{C}]/gu, (c) => (/\s/u.test(c) ? ' ' : ''))
    .split(/\s+/u)
    .filter((w) => w !== '' && WORD.test(w) && !ADDRESS_LIKE.test(w) && !/^www/iu.test(w));
  const joined = words.join(' ').trim();
  if (joined === '') return null;
  if (joined.length <= MAX_NAME) return joined;
  const cut = joined.slice(0, MAX_NAME);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > 0 ? cut.slice(0, atWord) : cut).trim()}…`;
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
