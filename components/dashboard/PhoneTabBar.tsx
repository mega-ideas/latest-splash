'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Fingerprint, House, Send, Wallet, type LucideIcon } from 'lucide-react';

import { useBottomBarClaimed } from '@/components/dashboard/Device';
import { PHONE_TABS, SIGNING_CHANGED_EVENT, SIGNING_POLL_MS, badgeText, phoneTabCurrent, readWaiting, type PhoneTabKey } from '@/lib/dashboard/phone';

const ICONS: Record<PhoneTabKey, LucideIcon> = { home: House, transfer: Send, approve: Fingerprint, wallet: Wallet, zeke: Bot };

/**
 * How many wallet requests wait for this person's signature. Their own
 * inbox, in their own business (the server takes both from the session).
 * It asks for the count alone, not for every request with its bytes. A look
 * that fails keeps the last count that was read (never a made-up number), and
 * a session that is gone or a person with no wallet stops the asking
 * (readWaiting). It is looked at every SIGNING_POLL_MS while the page is in
 * view, and at once when a screen says a signature was given or declined.
 */
function useWaiting(): number {
  const [count, setCount] = useState(0);
  const last = useRef(0);
  const stopped = useRef(false);
  const look = useCallback(async () => {
    if (stopped.current) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    let answer: { status: number; body?: unknown } | null = null;
    try {
      const response = await fetch('/api/wallet/signing-requests?count=1', { cache: 'no-store' });
      answer = { status: response.status, body: await response.json().catch(() => null) };
    } catch {
      answer = null;
    }
    const next = readWaiting(last.current, answer);
    last.current = next.count;
    if (next.stop) stopped.current = true;
    setCount(next.count);
  }, []);
  useEffect(() => {
    const first = window.setTimeout(() => void look(), 0);
    const timer = window.setInterval(() => void look(), SIGNING_POLL_MS);
    const onChanged = () => void look();
    window.addEventListener(SIGNING_CHANGED_EVENT, onChanged);
    document.addEventListener('visibilitychange', onChanged);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener(SIGNING_CHANGED_EVENT, onChanged);
      document.removeEventListener('visibilitychange', onChanged);
    };
  }, [look]);
  return count;
}

/** The phone's bottom bar: five tabs, each an icon and a word, 56px tall, clear of the home indicator. */
export default function PhoneTabBar() {
  const pathname = usePathname();
  const current = phoneTabCurrent(pathname);
  const claimed = useBottomBarClaimed();
  const waiting = useWaiting();
  if (claimed) return null;
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[#326273]/20 bg-[#fffaf6] pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_-16px_rgba(12,62,72,0.45)] md:hidden"
    >
      <ul className="mx-auto grid max-w-lg grid-cols-5">
        {PHONE_TABS.map((tab) => {
          const Icon = ICONS[tab.icon];
          const on = current === tab.key;
          const badge = tab.key === 'approve' ? badgeText(waiting) : null;
          return (
            <li key={tab.key}>
              <Link
                href={tab.href}
                aria-current={on ? 'page' : undefined}
                className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[12px] font-semibold transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0d6370] ${on ? 'text-[#0c3e48]' : 'text-[#326273]'}`}
              >
                {on ? <span aria-hidden="true" className="absolute inset-x-5 top-0 h-[3px] rounded-b-full bg-[#0d6370]" /> : null}
                <span className="relative">
                  <Icon className="h-[22px] w-[22px]" strokeWidth={on ? 2.4 : 1.9} aria-hidden="true" />
                  {badge ? (
                    <span className="absolute -right-3 -top-2 min-w-[18px] rounded-full bg-[var(--gold-light)] px-1 text-center text-[12px] font-bold leading-[18px] text-[#0c3e48]">
                      {badge}
                      <span className="sr-only"> waiting for your signature</span>
                    </span>
                  ) : null}
                </span>
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
