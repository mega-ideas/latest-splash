'use client';

import { sheetAnnouncement } from '@/lib/oxwal/sheet-announce';
import type { OxwalThreadItem } from '@/lib/oxwal/use-oxwal-thread';

/**
 * One line for screen readers about the payout sheet in the thread, kept on
 * the page and changed in place so each change is announced. The card itself
 * stays out of the thread's live region (see SheetCard), so a screen reader
 * says "7 rows read, 3 cannot be paid" and not the whole table.
 */
export default function SheetStatus({ thread }: { thread: readonly OxwalThreadItem[] }) {
  return (
    <p role="status" className="sr-only">
      {sheetAnnouncement(thread)}
    </p>
  );
}
