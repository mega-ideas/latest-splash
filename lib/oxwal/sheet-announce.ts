/**
 * One line for a screen reader about the payout sheet in a thread (v2 Phase 3).
 *
 * The card itself is a table of up to 20 rows with their reasons; reading all
 * of it aloud when it appears is noise, so the card is kept out of the thread's
 * live region and this line is announced instead, from a status element that
 * stays on the page and changes its text. Client-safe: no imports at runtime.
 */
import type { OxwalThreadItem } from './use-oxwal-thread';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What to announce for the latest sheet in the thread; an empty string when there is none. */
export function sheetAnnouncement(thread: readonly OxwalThreadItem[]): string {
  const item = [...thread].reverse().find((row) => row.kind === 'sheet');
  if (!item || item.kind !== 'sheet') return '';
  const sheet = item.sheet;
  if (sheet.phase === 'reading') return 'Reading your sheet.';
  if (sheet.phase === 'failed') return sheet.text;
  const { card } = sheet;
  if (sheet.phase === 'prepared') return `Batch prepared with ${plural(card.rows.length, 'payment', 'payments')}. Nothing has been sent.`;
  const parts = [plural(card.rows.length, 'row', 'rows') + ' read'];
  if (card.blockedCount > 0) parts.push(`${card.blockedCount} cannot be paid`);
  if (card.confirmCount > 0) parts.push(`${card.confirmCount} to check`);
  if (card.mappedBy === 'assistant') parts.push('check the columns Zeke matched');
  if (card.blockedCount === 0 && card.confirmCount === 0 && card.mappedBy !== 'assistant') parts.push('all clear');
  return `Payout sheet: ${parts.join(', ')}.`;
}
