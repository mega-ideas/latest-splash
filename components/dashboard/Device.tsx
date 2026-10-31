'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';

import { PHONE_MEDIA_QUERY, resolvePhone } from '@/lib/device';

/**
 * One answer to "is this a phone?" for the whole dashboard (v2 brief 5.10).
 *
 * The server reads the User-Agent where the layout renders and hands it down
 * as `phoneHint`, so the first paint is the right layout. After that the
 * window's own width decides (`PHONE_MEDIA_QUERY`, the shell's `md` break),
 * through useSyncExternalStore so React renders the hint while it hydrates
 * and the window's answer straight after, with no mismatch: a desktop window
 * narrowed to a phone gets the phone layout, and a tablet keeps the desktop one.
 *
 * Where only the look changes, CSS (`md:`) is still the right tool. A
 * component that is a different screen on a phone (Transfer's one question at
 * a time, the Approve sign screen) asks `usePhone()`.
 */

type Chrome = {
  phoneHint: boolean;
  /** True while the phone's menu is open over the page: what sits outside the page's own tree (the action bar) is as inert as the page is. */
  modalOpen: boolean;
  /** How many screens have claimed the foot of the page for their own action bar. */
  claims: number;
  claim: () => () => void;
};

const DeviceContext = createContext<Chrome>({ phoneHint: false, modalOpen: false, claims: 0, claim: () => () => undefined });

export function DeviceProvider({ phoneHint, modalOpen = false, children }: { phoneHint: boolean; modalOpen?: boolean; children: ReactNode }) {
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((n) => n + 1);
    return () => setClaims((n) => Math.max(0, n - 1));
  }, []);
  const value = useMemo(() => ({ phoneHint, modalOpen, claims, claim }), [phoneHint, modalOpen, claims, claim]);
  return <DeviceContext value={value}>{children}</DeviceContext>;
}

/** True while the menu drawer is open over the page. */
export function useModalOpen(): boolean {
  return useContext(DeviceContext).modalOpen;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(PHONE_MEDIA_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function readWindow(): boolean | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(PHONE_MEDIA_QUERY).matches;
}

/** True on a phone: the window's answer, and the server's hint until the window can be asked. */
export function usePhone(): boolean {
  const { phoneHint } = useContext(DeviceContext);
  // The snapshot is a number (0 unknown, 1 no, 2 yes) so React compares it by value.
  const code = useSyncExternalStore(
    subscribe,
    () => {
      const asked = readWindow();
      return asked === null ? 0 : asked ? 2 : 1;
    },
    () => 0,
  );
  return resolvePhone(phoneHint, code === 0 ? null : code === 2);
}

/** Children only on a phone. */
export function OnPhone({ children }: { children: ReactNode }) {
  return usePhone() ? <>{children}</> : null;
}

/** Children only off a phone. */
export function OffPhone({ children }: { children: ReactNode }) {
  return usePhone() ? null : <>{children}</>;
}

/**
 * A screen with its own fixed action bar (Transfer's Continue, Approve's
 * passkey button) takes the foot of the page: while `active`, the tab bar
 * steps aside, so there is one bar at the foot, never two.
 */
export function usePhoneBottomBar(active: boolean): void {
  const { claim } = useContext(DeviceContext);
  useEffect(() => {
    if (!active) return;
    return claim();
  }, [active, claim]);
}

/** True while a screen has claimed the foot of the page. */
export function useBottomBarClaimed(): boolean {
  return useContext(DeviceContext).claims > 0;
}
