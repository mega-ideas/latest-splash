import Image from 'next/image';
import Link from 'next/link';
import {
  ArrowRight,
  BadgeCheck,
  FileCheck2,
  Gauge,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import WaitlistCta from '@/components/landing/WaitlistCta';
import { claims, lockedCopy } from '@/content/claims';

/**
 * Phone-only landing. Server component — zero client JS beyond Next's
 * runtime: no scroll-jacked cinematic, no multi-megabyte hero art, CSS-only
 * motion. The desktop/iPad experience stays on IsometricLanding; this is a
 * single-column, thumb-first retelling of the same story.
 */

const proofChips = [
  '~400ms settlement',
  'From 0.80% fee',
  'Human-approved AI',
];

const marqueeItems = [
  ['1 live testnet', 'MY to PH corridor'],
  ['~400ms', 'Sui settlement finality'],
  ['From 0.80%', 'starting edge fee'],
  ['Human approved', 'AI recommendations'],
  ['Stored proof', 'Walrus + Sui audit'],
];

const steps = [
  { number: '01', title: 'Collect or upload', copy: 'Create a pay link, upload an invoice, or fund USD into the operating account.' },
  { number: '02', title: 'Review quotes', copy: 'KYB, route, fee, and evidence labels appear before anything is signed.' },
  { number: '03', title: 'Settle in one signature', copy: 'The payment completes as approved or stops safely before funds move.' },
  { number: '04', title: 'Deliver locally', copy: 'Pay a verified supplier or sweep value into the recipient ladder.' },
  { number: '05', title: 'Anchor the proof', copy: 'Receipts and audit evidence stay encrypted, permanent, and reviewable.' },
];

const compareRows = [
  { label: 'Settlement speed', bank: '2–5 days', splash: '~400ms finality' },
  { label: 'Starting fee', bank: '3–5%', splash: 'From 0.80%' },
  { label: 'Audit trail', bank: 'Siloed records', splash: 'Walrus + Sui proof' },
];

const trustPoints = [
  { icon: Gauge, title: 'Fast by default', copy: 'Sui settlement finality is measured in milliseconds, not banking days.' },
  { icon: ShieldCheck, title: 'You stay in control', copy: lockedCopy.agent + ' Every payout needs a human signature.' },
  { icon: FileCheck2, title: 'Proof that lasts', copy: 'Encrypted receipts and daily audit batches anchored on-chain.' },
];

const partners = [
  { src: '/stripe-logo.svg', name: 'Stripe' },
  { src: '/partners/pyth.png', name: 'Pyth' },
  { src: '/sumsub-logo.png', name: 'Sumsub' },
  { src: '/isometric/walrus-logo.png', name: 'Walrus' },
  { src: '/sui-logo-blue.svg', name: 'Sui' },
];

export default function MobileLanding() {
  return (
    <main className="mob-landing">
      {/* ── Sticky header ─────────────────────────────────── */}
      <header className="mob-header">
        <Link href="/" className="mob-brand" aria-label="Splash Finance home">
          <Image src="/splash-main-icon.png" alt="" width={64} height={63} priority />
          <strong>Splash</strong>
        </Link>
        <Link href="/signup" className="mob-btn mob-btn-small">
          Start sending
        </Link>
      </header>

      {/* ── Hero ──────────────────────────────────────────── */}
      <section className="mob-hero" aria-labelledby="mob-hero-title">
        <p className="mob-kicker">
          <span className="mob-kicker-dot" aria-hidden="true" />
          MY → PH corridor · testnet live
        </p>
        <h1 id="mob-hero-title" className="mob-display">
          Collect USD.
          <span>Pay SEA.</span>
        </h1>
        <p className="mob-hero-copy">
          The working-capital network for Southeast Asian finance teams — programmable
          settlement, approval-led AI, and audit proof that outlives the payment.
        </p>
        <div className="mob-hero-actions">
          <Link href="/signup" className="mob-btn mob-btn-primary">
            Start sending
            <ArrowRight aria-hidden="true" />
          </Link>
          <Link href="/login" className="mob-btn mob-btn-ghost">Log in</Link>
        </div>
        <ul className="mob-proof-chips" aria-label="Platform highlights">
          {proofChips.map((chip) => (
            <li key={chip}>
              <BadgeCheck aria-hidden="true" />
              {chip}
            </li>
          ))}
        </ul>
        <div className="mob-hero-art" aria-hidden="true">
          <Image
            src="/cinematic/agent-bot-cut.png"
            alt=""
            width={480}
            height={480}
            sizes="(max-width: 480px) 70vw, 340px"
            priority
          />
        </div>
      </section>

      {/* ── Metrics ticker ────────────────────────────────── */}
      <div className="mob-marquee" aria-label="Platform metrics">
        <div className="mob-marquee-track">
          {[...marqueeItems, ...marqueeItems].map(([value, label], index) => (
            <span className="mob-marquee-item" key={`${value}-${index}`}>
              <strong>{value}</strong> {label} <i aria-hidden="true">◆</i>
            </span>
          ))}
        </div>
      </div>

      {/* ── How it works ──────────────────────────────────── */}
      <section className="mob-section" aria-labelledby="mob-how-title">
        <p className="mob-eyebrow">How it works</p>
        <h2 id="mob-how-title" className="mob-title">
          Five steps.
          <span>No limbo.</span>
        </h2>
        <ol className="mob-steps">
          {steps.map((step) => (
            <li key={step.number} className="mob-step">
              <span className="mob-step-number" aria-hidden="true">{step.number}</span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Compare ───────────────────────────────────────── */}
      <section className="mob-section mob-section-dark" aria-labelledby="mob-compare-title">
        <p className="mob-eyebrow">Compare</p>
        <h2 id="mob-compare-title" className="mob-title mob-title-light">
          Built for business.
          <span>Designed to move.</span>
        </h2>
        <div className="mob-compare">
          <div className="mob-compare-head" aria-hidden="true">
            <span>Typical bank</span>
            <span className="is-splash">Splash</span>
          </div>
          {compareRows.map((row) => (
            <div className="mob-compare-row" key={row.label}>
              <span className="mob-compare-label">{row.label}</span>
              <span className="mob-compare-bank">{row.bank}</span>
              <span className="mob-compare-splash">
                <BadgeCheck aria-hidden="true" />
                {row.splash}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Trust ─────────────────────────────────────────── */}
      <section className="mob-section" aria-labelledby="mob-trust-title">
        <p className="mob-eyebrow">Trust</p>
        <h2 id="mob-trust-title" className="mob-title">
          Safe by
          <span>design.</span>
        </h2>
        <div className="mob-trust-list">
          {trustPoints.map(({ icon: Icon, title, copy }) => (
            <article className="mob-trust-card" key={title}>
              <span className="mob-trust-icon"><Icon aria-hidden="true" /></span>
              <div>
                <h3>{title}</h3>
                <p>{copy}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* ── Partners ──────────────────────────────────────── */}
      <section className="mob-section mob-partners" aria-label="Infrastructure partners">
        <p className="mob-eyebrow">Infrastructure &amp; partners</p>
        <div className="mob-partner-row">
          {partners.map((partner) => (
            <span key={partner.name} className="mob-partner">
              <Image src={partner.src} alt={`${partner.name} logo`} width={96} height={48} />
            </span>
          ))}
        </div>
      </section>

      {/* ── Final CTA ─────────────────────────────────────── */}
      <section className="mob-section mob-final" aria-labelledby="mob-final-title">
        <Sparkles className="mob-final-spark" aria-hidden="true" />
        <h2 id="mob-final-title" className="mob-title mob-title-light">
          Your treasury,
          <span>finally programmable.</span>
        </h2>
        <p className="mob-final-copy">
          Start with USD. Prove the MY-to-PH path. Expand when controls are ready.
        </p>
        <Link href="/signup" className="mob-btn mob-btn-gold">
          Open the payment desk
          <ArrowRight aria-hidden="true" />
        </Link>
        <div className="mob-waitlist-slot">
          <WaitlistCta variant="mob" />
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────── */}
      <footer className="mob-footer">
        <div className="mob-footer-brand">
          <Image src="/splash-main-icon.png" alt="" width={48} height={47} />
          <strong>Splash</strong>
        </div>
        <nav className="mob-footer-nav" aria-label="Footer">
          <Link href="/login">Log in</Link>
          <Link href="/signup">Create account</Link>
          <Link href="/trust">Trust &amp; compliance</Link>
          <Link href="/working-capital">Working capital</Link>
        </nav>
        <small>{claims.footerLegal.claim}</small>
        <small>© 2026 Splash Financial Labuan Ltd.</small>
      </footer>
    </main>
  );
}
