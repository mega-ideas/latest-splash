'use client';

/**
 * Persisted 0xWal conversation.
 *
 * What is kept: the visible turns (yours and 0xWal's), activity lines,
 * notices, and a *reference* to each proposal — its id, kind, corridor and
 * one-line recommendation. What is never kept in the browser: proposal
 * bodies (amounts, recipients, evidence). Those live in the proposal store
 * and render from the Approvals surface. Reload the desk and the
 * conversation is where you left it; the money detail is fetched fresh.
 */

export type PersistedThreadItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'activity'; id: string; label: string; tone: 'read' | 'propose' }
  | { kind: 'notice'; id: string; text: string }
  | { kind: 'proposal-ref'; id: string; proposalId: string; proposalKind: string; corridor: string | null; recommendation: string };

export type PersistedThread = {
  version: 1;
  organization: string;
  savedAt: number;
  items: PersistedThreadItem[];
};

export const THREAD_STORAGE_KEY = 'oxwal_thread_v1';
export const THREAD_ITEM_CAP = 120;

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readThread(organization: string): PersistedThreadItem[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(THREAD_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<PersistedThread>;
    if (parsed.version !== 1 || parsed.organization !== organization || !Array.isArray(parsed.items)) return [];
    return parsed.items.filter((item): item is PersistedThreadItem => typeof item === 'object' && item !== null && 'kind' in item);
  } catch {
    return [];
  }
}

export function writeThread(organization: string, items: PersistedThreadItem[]): void {
  const store = storage();
  if (!store) return;
  const payload: PersistedThread = {
    version: 1,
    organization,
    savedAt: Date.now(),
    items: items.slice(-THREAD_ITEM_CAP),
  };
  try {
    store.setItem(THREAD_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* storage full or blocked: the in-memory thread still works */
  }
}

export function clearThread(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(THREAD_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
