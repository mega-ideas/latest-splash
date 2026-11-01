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
 * Text folded the way a reader sees it: compatibility forms, hidden
 * characters, look-alike letters, and single letters spaced apart ("i g n o
 * r e", "p a y").
 */
export function foldForReading(value: string): string {
  const folded = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, '')
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

