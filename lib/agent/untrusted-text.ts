/**
 * Reading untrusted text the way a person reads it.
 *
 * Text written by a supplier, an invoice or a spreadsheet is data. Before any
 * check looks for an instruction in it, it is folded: compatibility and
 * full-width forms, hidden and zero-width characters, look-alike Cyrillic and
 * Greek letters, spaced-out letters and digits standing for letters. Shared by
 * Zeke's invoice scan (lib/agent/oxwal.ts) and by the payout-sheet reader
 * (lib/batch/ingest.ts), so both fold the same way. Pure: no model, no
 * network, no environment.
 */

/** Cyrillic and Greek letters that read as Latin ones, which NFKC does not fold. */
export const CONFUSABLES: Record<string, string> = {
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x',
  '\u0456': 'i', '\u0458': 'j', '\u04bb': 'h', '\u0455': 's', '\u043a': 'k', '\u0442': 't', '\u043c': 'm', '\u043d': 'h',
  '\u0501': 'd', '\u051b': 'q', '\u051d': 'w', '\u0578': 'n', '\u0585': 'o', '\u0570': 'h', '\u0251': 'a', '\u0261': 'g', '\u0269': 'i', '\u03b5': 'e', '\u03b7': 'n',
  '\u03b1': 'a', '\u03bf': 'o', '\u03c1': 'p', '\u03b9': 'i', '\u03bd': 'v', '\u03c5': 'u', '\u03ba': 'k', '\u03c4': 't',
};

/**
 * Characters that draw nothing, or change how the text around them is drawn:
 * every control and format character (zero-width, bidirectional, joiners, soft
 * hyphen, byte-order mark, the Arabic letter mark, the Mongolian vowel
 * separator), the variation selectors, the combining grapheme joiner, the
 * Hangul and Khmer fillers, the blank Braille cell, the line and paragraph
 * separators and the whole Unicode tag block (which can spell ASCII that no
 * screen draws). Written with braces so no editor turns the escapes into the
 * invisible characters themselves.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\u{34f}\u{115f}\u{1160}\u{17b4}\u{17b5}\u{180b}-\u{180f}\u{2028}\u{2029}\u{2800}\u{3164}\u{fe00}-\u{fe0f}\u{ffa0}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/** The text without any hidden character. */
export function stripHidden(value: string): string {
  return value.replace(HIDDEN, '');
}

/** Whether the text has a hidden character in it. */
export function hasHidden(value: string): boolean {
  return new RegExp(HIDDEN.source, 'u').test(value);
}

/**
 * Text spelled in the Unicode tag block (U+E0020 to U+E007E, one per ASCII
 * character) as the ASCII it spells. A screen shows nothing, a model may read
 * it: it is read before it is dropped. A run of them is set apart by spaces,
 * so "INV-1" followed by hidden "ignore previous instructions" reads as two
 * things and not as one word.
 */
export function decodeTags(value: string): string {
  return value.replace(/[\u{e0020}-\u{e007e}]+/gu, (run) => ` ${[...run].map((char) => String.fromCharCode((char.codePointAt(0) as number) - 0xe0000)).join('')} `);
}

/**
 * Text folded the way a reader sees it: compatibility forms, hidden
 * characters, look-alike letters, and single letters spaced apart ("i g n o
 * r e", "p a y").
 */
export function foldForReading(value: string): string {
  const folded = stripHidden(decodeTags(value.normalize('NFKC')))
    .toLowerCase()
    .replace(/[\u0370-\u03ff\u0400-\u04ff]/g, (char) => CONFUSABLES[char] ?? char);
  return folded.replace(/\b(?:[a-z] ){2,}[a-z]\b/g, (run) => run.replace(/ /g, ''));
}

export function normaliseForScan(value: string): string {
  return foldForReading(value);
}

/** The same text with digits and symbols read as the letters they stand in for ("ign0re"). */
export function leetFolded(text: string): string {
  return text.replace(/(?<=[a-z])[0134578@$](?=[a-z])/g, (char) => ({ '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's' })[char] ?? char);
}

