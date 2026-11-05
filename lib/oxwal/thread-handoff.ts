import type { OxwalThreadItem } from '@/lib/oxwal/use-oxwal-thread';

/**
 * The floating Zeke's conversation, handed to the Zeke page when someone
 * presses its expand button.
 *
 * Each surface keeps its own thread (useOxwalThread), so the expand button
 * used to open a fresh page and hide the conversation it was meant to make
 * bigger. The floating panel now hands its thread over here as it navigates,
 * and the Zeke page takes it once on mount.
 *
 * Held in this module's memory, not in browser storage and never in the URL:
 * the thread can hold payee names and amounts, and the desk keeps money out of
 * browser storage (tests/oxwal-frontend.test.mjs). The expand button is a
 * client-side navigation, so the module, and the handover, survive it; a
 * reload or a new tab starts clean, which is what "taken once" should mean
 * anyway.
 *
 * What travels is the conversation itself. In-chat approval windows do not:
 * a proposal arrives on the Zeke page as one waiting in the approval queue,
 * where it already is, so nothing can be approved twice or after its window.
 */

const MAX_ITEMS = 60;

export type ThreadHandoff = { thread: OxwalThreadItem[]; assistantName: string | null };

const CARRIED: ReadonlySet<OxwalThreadItem['kind']> = new Set(['user', 'assistant', 'activity', 'notice', 'proposal', 'handoff']);

let pending: ThreadHandoff | null = null;

export function stashThreadHandoff(handoff: ThreadHandoff): void {
  const thread = handoff.thread.filter((item) => CARRIED.has(item.kind)).slice(-MAX_ITEMS);
  // Nothing asked yet: nothing to continue.
  if (!thread.some((item) => item.kind === 'user')) {
    pending = null;
    return;
  }
  pending = { thread, assistantName: handoff.assistantName };
}

export function takeThreadHandoff(): ThreadHandoff | null {
  const taken = pending;
  pending = null;
  return taken;
}
