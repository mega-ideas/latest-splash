'use client';

import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import Wordmark from '@/components/brand/Wordmark';
import { Button } from '@/components/system';
import { cn } from '@/lib/utils';

const LINKS = [
  { label: 'Platform', href: '#platform' },
  { label: 'Network', href: '#network' },
  { label: 'Security', href: '#governance' },
  { label: 'Developers', href: '#developers' },
  { label: 'Company', href: '/trust' },
];

/** Dark navigation on the ink foundation. Mobile keeps the wordmark, the primary action and one menu button. */
export default function ClearanceNav() {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    panel.current?.querySelector<HTMLElement>('a, button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-[var(--surface-navigation)] text-[var(--text-on-dark)]">
      <div className="mx-auto flex h-14 w-full max-w-[1200px] items-center justify-between gap-4 px-5 md:px-8">
        <Wordmark size={24} className="text-[var(--text-on-dark)]" />
        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="rounded-[var(--r-control)] px-3 py-2 text-[13.5px] text-[var(--text-on-dark)]/80 hover:bg-white/5 hover:text-[var(--text-on-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--teal-300)]">
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/login" className="hidden rounded-[var(--r-control)] px-3 py-2 text-[13.5px] text-[var(--text-on-dark)]/80 hover:text-[var(--text-on-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--teal-300)] md:inline-flex">
            Sign in
          </Link>
          <Button href="/login" size="sm">Clear a payment</Button>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="landing-menu" aria-label={open ? 'Close menu' : 'Open menu'} className="grid size-9 place-items-center rounded-[var(--r-control)] text-[var(--text-on-dark)] hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--teal-300)] md:hidden">
            {open ? <X className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}
          </button>
        </div>
      </div>
      <div id="landing-menu" ref={panel} hidden={!open} className={cn('border-t border-white/10 bg-[var(--surface-navigation)] md:hidden')}>
        <nav className="mx-auto grid w-full max-w-[1200px] gap-1 px-5 py-3" aria-label="Primary, mobile">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} onClick={() => setOpen(false)} className="rounded-[var(--r-control)] px-3 py-2.5 text-[15px] text-[var(--text-on-dark)]/90 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--teal-300)]">
              {link.label}
            </Link>
          ))}
          <Link href="/login" onClick={() => setOpen(false)} className="rounded-[var(--r-control)] px-3 py-2.5 text-[15px] text-[var(--text-on-dark)]/90 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--teal-300)]">
            Sign in
          </Link>
        </nav>
      </div>
    </header>
  );
}
