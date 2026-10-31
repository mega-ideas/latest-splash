/**
 * The phone frame of the dashboard (v2 brief 5.10), as data.
 *
 * A phone has a bottom bar of five tabs (Home, Transfer, Approve, Wallet,
 * Zeke); every other page stays one tap away in the menu, which still holds
 * the whole rail (lib/dashboard/nav.ts). Approve carries a badge with the
 * number of wallet requests that wait for this person's signature.
 *
 * No I/O and no React: the tab bar draws this, and
 * tests/phone-device.test.mjs runs it as plain Node.
 */

export type PhoneTabKey = 'home' | 'transfer' | 'approve' | 'wallet' | 'zeke';

export type PhoneTab = { key: PhoneTabKey; label: string; href: string; icon: PhoneTabKey };

export const PHONE_TABS: readonly PhoneTab[] = [
  { key: 'home', label: 'Home', href: '/dashboard', icon: 'home' },
  { key: 'transfer', label: 'Transfer', href: '/dashboard/transfer', icon: 'transfer' },
  { key: 'approve', label: 'Approve', href: '/dashboard/approve', icon: 'approve' },
  { key: 'wallet', label: 'Wallet', href: '/dashboard/wallet', icon: 'wallet' },
  { key: 'zeke', label: 'Zeke', href: '/dashboard/zeke', icon: 'zeke' },
];

/** Paths that belong to a tab besides its own (Zeke's old address). */
const ALSO: Record<string, PhoneTabKey> = { '/dashboard/copilot': 'zeke' };

const within = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

/** The tab for the page being shown, or null when the page is not one of the five. Home only on Home. */
export function phoneTabCurrent(pathname: string): PhoneTabKey | null {
  if (pathname === '/dashboard') return 'home';
  for (const tab of PHONE_TABS) {
    if (tab.key !== 'home' && within(pathname, tab.href)) return tab.key;
  }
  for (const [href, key] of Object.entries(ALSO)) if (within(pathname, href)) return key;
  return null;
}

/** The badge's text: nothing for none, the number up to nine, then "9+". */
export function badgeText(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 9 ? '9+' : String(Math.floor(count));
}

/** How often the count of waiting requests is looked at while the page is in view. */
export const SIGNING_POLL_MS = 30_000;

/** Dispatched on `window` when a signature was given or declined, so the badge is looked at at once. */
export const SIGNING_CHANGED_EVENT = 'splash:signing-changed';

type WaitingView = { status?: unknown; you?: { mustSign?: unknown; signed?: unknown; declined?: unknown } | null };

/**
 * How many requests wait for this person's signature: still collecting, that
 * they must sign, and that they have neither signed nor declined. Anything
 * that is not a list is no requests (a failed read is not a number).
 */
export function waitingForMe(requests: unknown): number {
  if (!Array.isArray(requests)) return 0;
  return (requests as WaitingView[]).filter((r) => r?.status === 'collecting' && r.you?.mustSign === true && r.you.signed !== true && r.you.declined !== true).length;
}

/** (Not yet built.) */
export function readWaiting(previous: number, _answer: { status: number; body?: unknown } | null): { count: number; stop: boolean } {
  return { count: previous, stop: false };
}
