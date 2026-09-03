'use client';

import Link from 'next/link';
import { useState } from 'react';

const LINKS = [
  ['Platform', '#platform'],
  ['Network', '#network'],
  ['Security', '#security'],
  ['Developers', '#developers'],
  ['Company', '#company'],
] as const;

/** Header per the handoff: wordmark left, links centre, Sign in + Clear a payment right; mobile keeps wordmark, primary action and one menu button. */
export default function LandingHeader() {
  const [open, setOpen] = useState(false);
  return (
    <header className="lv4-header">
      <div className="wrap">
        <Link href="/" className="lv4-wordmark" aria-label="Splash home">
          splash
          <span className="signal">
            <svg viewBox="0 0 22 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M0 6h20M15 1l5 5-5 5" /></svg>
          </span>
        </Link>
        <nav className="lv4-nav" aria-label="Website">
          {LINKS.map(([label, href]) => (
            <a key={href} href={href}>{label}</a>
          ))}
        </nav>
        <div className="lv4-header__actions">
          <Link href="/login" className="btn btn--quiet">Sign in</Link>
          <Link href="/login" className="btn btn--signal btn--sm">Clear a payment <span aria-hidden="true">→</span></Link>
          <button type="button" className="lv4-menu" aria-expanded={open} aria-controls="lv4-menu" aria-label={open ? 'Close menu' : 'Open menu'} onClick={() => setOpen((v) => !v)}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">{open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}</svg>
          </button>
        </div>
      </div>
      <div id="lv4-menu" className="lv4-menu-panel" data-open={open}>
        {LINKS.map(([label, href]) => (
          <a key={href} href={href} onClick={() => setOpen(false)}>{label}</a>
        ))}
        <Link href="/login" onClick={() => setOpen(false)}>Sign in</Link>
      </div>
    </header>
  );
}
