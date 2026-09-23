'use client';

/**
 * Cross-page notifier for Zeke work that still needs a human.
 *
 * The desk page records how many unsigned proposals are waiting whenever the
 * agent streams one in; the floating Zeke widget subscribes so it can remind
 * the operator when they are anywhere else in the app. Storage is
 * display-metadata only (a count and one short label) — never proposal
 * contents, amounts, or recipients.
 */

export type OxwalPendingSnapshot = {
  count: number;
  label: string | null;
  updatedAt: number;
};

const STORAGE_KEY = 'oxwal_pending_proposals_v1';
const EVENT_NAME = 'oxwal-pending-change';

const EMPTY: OxwalPendingSnapshot = { count: 0, label: null, updatedAt: 0 };

export function readPendingProposals(): OxwalPendingSnapshot {
  if (typeof window === 'undefined') return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<OxwalPendingSnapshot>;
    const count = Number(parsed.count);
    if (!Number.isFinite(count) || count < 0) return EMPTY;
    return {
      count: Math.floor(count),
      label: typeof parsed.label === 'string' && parsed.label.trim() ? parsed.label.slice(0, 120) : null,
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    return EMPTY;
  }
}

export function recordPendingProposals(input: { count: number; label?: string | null }): void {
  if (typeof window === 'undefined') return;
  const snapshot: OxwalPendingSnapshot = {
    count: Math.max(0, Math.floor(input.count)),
    label: input.label?.trim() ? input.label.slice(0, 120) : null,
    updatedAt: Date.now(),
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage full or blocked — the in-tab event below still delivers.
  }
  window.dispatchEvent(new CustomEvent<OxwalPendingSnapshot>(EVENT_NAME, { detail: snapshot }));
}

export function clearPendingProposals(): void {
  recordPendingProposals({ count: 0, label: null });
}

export function subscribePendingProposals(callback: (snapshot: OxwalPendingSnapshot) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onCustom = (event: Event) => {
    const detail = (event as CustomEvent<OxwalPendingSnapshot>).detail;
    callback(detail ?? readPendingProposals());
  };
  // `storage` fires for other tabs; the custom event covers this tab.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) callback(readPendingProposals());
  };

  window.addEventListener(EVENT_NAME, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}
