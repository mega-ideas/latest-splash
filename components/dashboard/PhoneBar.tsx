'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useModalOpen, usePhoneBottomBar } from '@/components/dashboard/Device';

const noop = () => () => undefined;

/**
 * The one action bar at the foot of a phone screen (v2 brief 5.10): Transfer's
 * Continue, Approve's passkey button, Review's Approve. It is fixed to the
 * bottom of the screen, clear of the home indicator, and while it is there the
 * tab bar steps aside, so there is one bar at the foot, never two.
 *
 * It is drawn in the body, not where it is written: the dashboard's cards blur
 * what is behind them (`backdrop-filter`), and a fixed element inside one is
 * fixed to the card, not to the screen.
 *
 * Being in the body, it is outside the page that the menu drawer makes inert:
 * it is made inert with it, so its button is not reachable by keyboard or
 * screen reader behind the drawer.
 */
export default function PhoneBar({ children }: { children: ReactNode }) {
  usePhoneBottomBar(true);
  const modalOpen = useModalOpen();
  // The server has no body to draw into: the bar appears once the page is in the browser.
  const inBrowser = useSyncExternalStore(noop, () => true, () => false);
  if (!inBrowser) return null;
  return createPortal(
    <div inert={modalOpen} className="fixed inset-x-0 bottom-0 z-40 border-t border-[#326273]/20 bg-[#fffaf6] px-4 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] shadow-[0_-10px_28px_-16px_rgba(12,62,72,0.5)]">
      <div className="mx-auto max-w-lg">{children}</div>
    </div>,
    document.body,
  );
}
