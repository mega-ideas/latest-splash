import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, ArrowRight } from 'lucide-react';

import TrustCompliance from '@/components/compliance/TrustCompliance';

const legalApproved = process.env.LEGAL_APPROVED === 'true';

export const metadata: Metadata = {
  title: 'Trust & compliance — Splash',
  description:
    'How Splash handles licensing, custody governance, and audit evidence: licensed partners of record today, an explicit licensing path, and Seal-encrypted, Walrus-anchored records.',
  // Draft until counsel signs off — keep the page out of indexes.
  robots: legalApproved ? undefined : { index: false, follow: false },
};

export default function TrustPage() {
  const showDraftWatermark = !legalApproved && process.env.NODE_ENV !== 'production';

  return (
    <main className="wc-page trust-page">
      {showDraftWatermark ? (
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
            <Link href="/signup" className="iso-button iso-button-small">
              Start sending
              <ArrowRight aria-hidden="true" />
            </Link>
          </nav>
        </div>
      </header>

      <section className="iso-section wc-hero trust-hero">
        <div className="iso-shell">
          <p className="iso-kicker">Trust &amp; compliance</p>
          <h1 className="iso-section-title wc-hero-title">
            Licensed partners today.
            <span>Our own licenses next.</span>
          </h1>
          <p className="wc-hero-desc">
            Trust in payments is earned in a specific order: controls first, partners of record
            second, licenses third. This page states exactly where Splash is on that path — nothing
            more, nothing less.
          </p>
        </div>
      </section>

      <section className="iso-section trust-main">
        <div className="iso-shell">
          <TrustCompliance />
        </div>
      </section>

      <footer className="wc-footer">
        <div className="iso-shell wc-footer-inner">
          <span>© 2026 Splash Financial Labuan Ltd.</span>
          <span>Records: Seal-encrypted · Walrus-stored · Sui-anchored</span>
        </div>
      </footer>
    </main>
  );
}
