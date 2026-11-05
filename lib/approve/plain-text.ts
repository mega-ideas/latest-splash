/**
 * Free text in a message that carries an official link.
 *
 * A signing message holds the real "Review it here: <link>". The business name
 * and an account holder's name sit beside it, and people type them. Left as
 * typed, a name could carry a second address (WhatsApp turns any of these into
 * something to tap) or an instruction to open one, and it would read as part of
 * an official message.
 *
 * So every free-text field is cut down to plain words before it goes into a
 * message, here and nowhere else:
 *
 *   - anything a phone would make tappable is removed: a scheme (https://,
 *     mailto:, tel:, javascript: and the like), www., a bare domain (with or
 *     without a path), an IPv4 address, an e-mail address;
 *   - invisible and control characters are dropped, line breaks and tabs become
 *     spaces, and look-alike dots (full-width, ideographic) are read as dots
 *     first, so a split or disguised address is still found;
 *   - only letters, marks, digits, spaces and . , & ' ( ) - are kept, which also
 *     removes WhatsApp's formatting marks (* _ ~ `) and quote marker (>);
 *   - the result is one line, trimmed, and capped.
 *
 * This is not a claim that the words are safe: a name can still say something
 * silly in plain words. It is the claim that a name cannot add an address or a
 * line to the message, so the Approve link is the only one in it. The screen
 * shows the real name and payee from the signed bytes' own record.
 *
 * Any future channel (e-mail, push) must use this too. No environment is read.
 */

const DOTS = /[。．｡․⸮]/g;
const INVISIBLE = /[\p{Cf}­]/gu;
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

// A scheme with or without slashes, up to the next space.
const SCHEME = /(?<![\p{L}\p{N}])[a-z][a-z0-9+.-]*:\/\/\S*/giu;
const SCHEMELESS = /(?<![\p{L}\p{N}])(?:mailto|tel|sms|smsto|javascript|data|file|ftp|blob|about|vbscript|whatsapp|intent|market):\S*/giu;
const WWW = /(?<![\p{L}\p{N}])www\.\S*/giu;
const IPV4 = /(?<![\p{L}\p{N}.])\d{1,3}(?:\.\d{1,3}){3}(?![\p{L}\p{N}])(?::\d+)?\S*/gu;
// name.name.tld, with an optional port or path after it
const DOMAIN = /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+\p{L}{2,}(?![\p{L}\p{N}])(?:[:/?#]\S*)?/gu;
const ADDRESS_MARK = /\S*@\S*/gu;

const KEPT = /[^\p{L}\p{M}\p{N} .,&'’()-]/gu;

/** The text as plain words on one line: no address, no marks, no more than `max` characters, or `fallback` if nothing is left. */
export function plainText(value: unknown, max = 64, fallback = ''): string {
  let text = String(value ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(BREAKS, ' ')
    .replace(DOTS, '.');
  // Longest forms first, so a path after a domain goes with it.
  for (const pattern of [SCHEME, SCHEMELESS, WWW, ADDRESS_MARK, IPV4, DOMAIN]) text = text.replace(pattern, ' ');
  text = text.replace(KEPT, ' ').replace(/\s+/g, ' ').trim();
  const letters = Array.from(text);
  if (letters.length > max) text = `${letters.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
  return text === '' ? fallback : text;
}
