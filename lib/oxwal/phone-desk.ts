/**
 * The Zeke page on a phone (v2 brief 5.10), as data.
 *
 * On a desk the page is the question in the middle and a column of cards
 * beside it. On a phone there is no beside: Zeke leads with the question,
 * the composer and what to start with, then what Zeke prepared lately, and
 * every card that explains or links (what Zeke can do, what it remembers,
 * what MemWal stores, quick links, suggestions, the approvals) sits folded
 * under one title, so nothing is dropped and nothing crowds the composer.
 * What MemWal stores and the quick links stay on the page (brief 5.3).
 *
 * No React and no I/O: tests/phone-pages.test.mjs runs it as plain Node.
 */

export type ZekePhoneSection = 'composer' | 'starters' | 'recent' | 'approvals' | 'can-do' | 'remembers' | 'memwal-stores' | 'quick-links' | 'suggestions';

export function zekePhoneSections(): { visible: ZekePhoneSection[]; folded: ZekePhoneSection[] } {
  return {
    visible: ['composer', 'starters', 'recent'],
    folded: ['approvals', 'can-do', 'remembers', 'memwal-stores', 'quick-links', 'suggestions'],
  };
}
