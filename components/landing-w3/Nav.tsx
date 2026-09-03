'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

const LINKS = [
  ['Payments', '#payments'],
  ['Treasury', '#treasury'],
  ['Invoices', '#invoices'],
  ['Proof', '#proof'],
  ['Developers', '#developers'],
] as const;

/** Sticky nav: compresses once the hero scrolls past, mobile keeps the wordmark, the primary action and one menu button. */
export default function Nav() {
  const [open, setOpen] = useState(false);
  const [stuck, setStuck] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return undefined;
    const io = new IntersectionObserver((entries) => setStuck(!entries[0]?.isIntersecting), { threshold: 1 });
    io.observe(node);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <div ref={sentinel} aria-hidden="true" style={{ position: 'absolute', top: 0, height: 1, width: 1 }} />
      <header className="w3-nav" data-stuck={stuck}>
        <div className="wrap">
          <Link href="/" className="w3-mark" aria-label="Splash home">
            <i aria-hidden="true" />Splash
          </Link>
          <nav className="w3-links" aria-label="Primary">
            {LINKS.map(([label, href]) => (
              <a key={href} href={href}>{label}</a>
            ))}
          </nav>
          <div className="w3-nav__actions">
            <Link href="/login" className="btn btn--ghost btn--sm">Sign in</Link>
            <Link href="/login" className="btn btn--aqua btn--sm">Clear a payment</Link>
            <button type="button" className="w3-burger" aria-expanded={open} aria-controls="w3-sheet" aria-label={open ? 'Close menu' : 'Open menu'} onClick={() => setOpen((v) => !v)}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 8h16M4 16h16" />}
              </svg>
            </button>
          </div>
        </div>
        <div id="w3-sheet" className="w3-sheet" data-open={open}>
          {LINKS.map(([label, href]) => (
            <a key={href} href={href} onClick={() => setOpen(false)}>{label}</a>
          ))}
          <a href="/login" onClick={() => setOpen(false)}>Sign in</a>
        </div>
      </header>
    </>
  );
}
