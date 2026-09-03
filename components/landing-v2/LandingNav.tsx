'use client';

import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import NetworkBadge from '@/components/brand/NetworkBadge';
import Wordmark from '@/components/brand/Wordmark';
import { Button } from '@/components/system';
import { cn } from '@/lib/utils';

import { container } from './ui';

const LINKS = [
  { label: 'How it settles', href: '#money-flow' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Rates', href: '/rates' },
  { label: 'Trust', href: '/trust' },
  { label: 'Roadmap', href: '/roadmap' },
  { label: 'Docs', href: '/docs' },
];

/** 64px sticky bar; single line at lg; sheet below md with Escape + focus restore. */
export default function LandingNav() {
  const [open, setOpen] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const first = sheetRef.current?.querySelector<HTMLElement>('a, button');
    const timer = window.setTimeout(() => first?.focus(), 20);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        launcherRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--divider)] bg-[var(--paper)]/85 backdrop-blur">
      <div className={cn(container, 'flex h-16 items-center justify-between gap-4')}>
        <Wordmark size={28} />
        <nav aria-label="Site" className="hidden items-center gap-1 lg:flex">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="rounded-[var(--r-sm)] px-3 py-2 text-[14px] font-medium text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--teal-100)]">
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          <span className="hidden xl:block">
            <NetworkBadge />
          </span>
          <Button variant="ghost" size="sm" href="/login">
            Sign in
          </Button>
          <Button size="sm" href="/login">
            Open payment desk
          </Button>
        </div>
        <button
          ref={launcherRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Open menu"
          className="grid size-11 place-items-center rounded-[var(--r-sm)] text-[var(--text)] md:hidden"
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>
      </div>

      {open ? (
        <div ref={sheetRef} role="dialog" aria-modal="true" aria-label="Menu" className="fixed inset-0 z-50 flex flex-col bg-[var(--paper)] md:hidden">
          <div className={cn(container, 'flex h-16 items-center justify-between')}>
            <Wordmark size={28} />
            <button type="button" onClick={() => { setOpen(false); launcherRef.current?.focus(); }} aria-label="Close menu" className="grid size-11 place-items-center rounded-[var(--r-sm)]">
              <X className="size-5" aria-hidden="true" />
            </button>
          </div>
          <nav aria-label="Site" className={cn(container, 'grid gap-1 pt-4')}>
            {LINKS.map((link) => (
              <Link key={link.href} href={link.href} onClick={() => setOpen(false)} className="flex min-h-12 items-center rounded-[var(--r-sm)] px-3 text-[17px] font-medium text-[var(--text)] hover:bg-[var(--surface-2)]">
                {link.label}
              </Link>
            ))}
          </nav>
          <div className={cn(container, 'mt-auto grid gap-2 pb-[calc(1.25rem+env(safe-area-inset-bottom))]')}>
            <Button href="/login" fullWidth size="lg">
              Open payment desk
            </Button>
            <Button href="/login" variant="ghost" fullWidth size="lg">
              Sign in
            </Button>
            <div className="justify-self-center pt-2">
              <NetworkBadge />
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
