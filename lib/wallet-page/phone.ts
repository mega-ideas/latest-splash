/**
 * The Wallet page on a phone (v2 brief 5.10), as data.
 *
 * The page has ten sections and a phone has one narrow column. What waits for
 * the person's signature and the balance are always open; every other section
 * is folded under its own title, so the page reads as a list of things the
 * wallet does and the person opens the one they came for. A link to a folded
 * section (the balance's Add funds and Withdraw, a hash in the address)
 * opens it.
 *
 * No React and no I/O: tests/phone-pages.test.mjs runs it as plain Node.
 */

/** The sections, in the order the page shows them. */
export const SECTION_ORDER = ['needs-signature', 'balance', 'top-up', 'withdraw', 'funding-history', 'funding-sources', 'signers', 'spending-rules', 'migration', 'upgrade-alerts'] as const;

export type SectionId = (typeof SECTION_ORDER)[number];

/** Open before the person touches anything. The balance is not a folding section: it is the page. */
const OPEN_AT_FIRST: readonly SectionId[] = ['needs-signature'];

export function sectionsOpenAtFirst(): SectionId[] {
  return [...OPEN_AT_FIRST];
}

const FOLDED = new Set<string>(SECTION_ORDER.filter((id) => id !== 'balance' && !OPEN_AT_FIRST.includes(id)));

/** Whether a section with this id folds on a phone. */
export function foldsOnPhone(id: string | undefined): boolean {
  return id !== undefined && FOLDED.has(id);
}

/** The section a link's hash names, with or without the `#`; null for anything that is not one of this page's sections. */
export function sectionFromHash(hash: string): SectionId | null {
  const id = hash.startsWith('#') ? hash.slice(1) : hash;
  return (SECTION_ORDER as readonly string[]).includes(id) ? (id as SectionId) : null;
}

/** Dispatched on `window` to open a folded section (its id is the event's detail). */
export const OPEN_SECTION_EVENT = 'splash:open-wallet-section';
