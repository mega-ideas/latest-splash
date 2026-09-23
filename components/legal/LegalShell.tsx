import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Shared chrome for the two documents Google's OAuth consent screen links to.
 *
 * Both carry the same not-yet-licensed disclosure the /trust page renders, for
 * the same reason it is rendered by a component there: a reader who arrives at
 * a legal page from a sign-in screen must meet the licensing position on that
 * page, not be expected to go looking for it.
 */
export default function LegalShell({
  kicker,
  title,
  intro,
  updated,
  draft,
  children,
}: {
  kicker: string;
  title: string;
  intro: string;
  updated: string;
  draft: boolean;
  children: ReactNode;
}) {
  return (
    <main className="wc-page legal-page">
      {draft ? (
        <div className="trust-watermark" aria-hidden="true">DRAFT — PENDING COUNSEL REVIEW</div>
      ) : null}

      <header className="wc-topbar">
        <div className="iso-shell wc-topbar-inner">
          <Link href="/" className="iso-brand" aria-label="Splash Finance home">
            <Image src="/splash-main-icon.png" alt="" width={841} height={823} className="iso-header-brand-icon" priority />
            <span className="iso-header-wordmark"><strong>Splash</strong></span>
          </Link>
          <nav className="wc-topbar-nav" aria-label="Page navigation">
            <Link href="/" className="wc-back-link">
              <ArrowLeft aria-hidden="true" /> Back to Splash
            </Link>
            <Link href="/trust" className="iso-button iso-button-small">
              Trust &amp; compliance
              <ArrowRight aria-hidden="true" />
            </Link>
          </nav>
        </div>
      </header>

      <section className="iso-section wc-hero legal-hero">
        <div className="iso-shell">
          <p className="iso-kicker">{kicker}</p>
          <h1 className="iso-section-title wc-hero-title">{title}</h1>
          <p className="wc-hero-desc">{intro}</p>
          <p className="legal-updated">Last updated: {updated}</p>
        </div>
      </section>

      <section className="iso-section legal-main">
        <div className="iso-shell legal-shell">
          <div className="trust-mandatory" role="note">
            <ShieldCheck aria-hidden="true" />
            <p>
              <strong>Splash is not yet a licensed money-services business.</strong> Today, licensed
              partners are the system of record for regulated activities; Splash operates the software
              and settlement layer between them.
            </p>
          </div>

          <div className="legal-prose">{children}</div>
        </div>
      </section>

      <footer className="wc-footer">
        <div className="iso-shell wc-footer-inner">
          <span>© 2026 Splash Financial Labuan Ltd.</span>
          <span>
            <Link href="/privacy-policy">Privacy</Link>
            {' · '}
            <Link href="/terms-of-service">Terms</Link>
            {' · '}
            <Link href="/trust">Trust</Link>
          </span>
        </div>
      </footer>
    </main>
  );
}
