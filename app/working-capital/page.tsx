import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, ArrowRight } from 'lucide-react';

import RoadmapChip from '@/components/supply/RoadmapChip';
import DiscountTermSheet from '@/components/supply/DiscountTermSheet';
import WorkingCapitalFlywheel from '@/components/supply/WorkingCapitalFlywheel';

export const metadata: Metadata = {
  title: 'Dynamic discounting for Southeast Asia — early invoice payment on Splash (roadmap)',
  description:
    'Splash is building buyer-funded dynamic discounting for the Philippines and Southeast Asia: early payment on verified invoices over the same Sui settlement rail that moves payouts today. Coming capability, subject to licensing.',
  keywords: [
    'dynamic discounting Philippines',
    'early payment program Southeast Asia',
    'invoice early payment',
    'buyer-funded discounting',
    'working capital Southeast Asia',
  ],
};

const heroProof = [
  { k: 'Funded by', v: 'The buyer, not a lender' },
  { k: 'Rail', v: 'Same one payouts use' },
  { k: 'Control', v: 'Approval-gated, human-final' },
];

const receivableFacts = [
  {
    number: '01',
    label: 'Verified',
    title: 'Issued between verified businesses.',
    copy: 'A Receivable would only exist between two KYB-verified counterparties already transacting on Splash — the same verification that gates every payout today.',
    image: '/isometric/wc-receivable-1.png',
    imageAlt: 'Isometric pair of KYB-verified business nodes linked on Splash',
    meta: 'KYB-gated on both sides',
  },
  {
    number: '02',
    label: 'History',
    title: 'Carries its settlement history.',
    copy: 'Quotes, approvals, receipts, and settlement proof would anchor to the invoice itself — an invoice that shows how reliably it gets paid.',
    image: '/isometric/wc-receivable-2.png',
    imageAlt: 'Isometric invoice accumulating stacked settlement-history evidence',
    meta: 'Audit spine attached',
  },
  {
    number: '03',
    label: 'Fundable',
    title: 'Safe to pay early.',
    copy: 'A receivable with a clean, verifiable history is the safest thing to fund early. No guesswork, no external credit file — the record is the underwriting.',
    image: '/isometric/wc-receivable-3.png',
    imageAlt: 'Isometric buyer reading an invoice history directly, no lender between',
    meta: 'History a buyer can read',
  },
];

const discountSteps = [
  {
    number: '01',
    label: 'Offer',
    title: 'Buyer offers early payment.',
    copy: 'Your buyer sees an approved 90-day invoice and offers to pay it now — with their own USD already on the settlement rail.',
    image: '/isometric/wc-discount-1.png',
    imageAlt: 'Isometric buyer node offering early payment on an invoice',
    meta: 'Buyer-initiated',
  },
  {
    number: '02',
    label: 'Accept',
    title: 'Supplier accepts a discount.',
    copy: 'You choose per invoice: the full amount on the due date, or a small discount today. No obligation either way.',
    image: '/isometric/wc-discount-2.png',
    imageAlt: 'Isometric supplier accepting a discount on the invoice',
    meta: 'Per-invoice choice',
  },
  {
    number: '03',
    label: 'Settle',
    title: 'Settlement, no lender.',
    copy: 'The buyer’s own funds would settle the early payment over Splash — no factoring house, no credit line, no lender between you.',
    image: '/isometric/wc-discount-3.png',
    imageAlt: 'Isometric buyer and supplier settling directly, no third-party lender',
    meta: 'No third-party lender',
  },
];

type Chapter = {
  index: string;
  kicker: string;
  title: ReactNode;
  lede: ReactNode;
};

function ChapterHeading({ index, kicker, title, lede }: Chapter) {
  return (
    <div className="wc-chapter">
      <span className="wc-chapter-index" aria-hidden="true">{index}</span>
      <div className="wc-chapter-title">
        <p className="iso-kicker">{kicker}</p>
        <h2 className="iso-section-title wc-h2">{title}</h2>
      </div>
      <p className="wc-chapter-lede">{lede}</p>
    </div>
  );
}

function FlowCards({ items }: { items: typeof receivableFacts }) {
  return (
    <ol className="iso-supply-grid wc-flow">
      {items.map((item, index) => (
        <li className={`iso-supply-card wc-flow-card wc-flow-card-${index + 1}`} key={item.number}>
          <span className="wc-flow-ghost" aria-hidden="true">{item.number}</span>
          <div className="iso-supply-meta">
            <span>{item.number}</span>
            <p>{item.label}</p>
          </div>
          <div className="iso-supply-art">
            <Image src={item.image} alt={item.imageAlt} width={640} height={480} />
          </div>
          <div className="iso-supply-copy">
            <h3>{item.title}</h3>
            <p>{item.copy}</p>
            <small>{item.meta}</small>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function WorkingCapitalPage() {
  return (
    <main className="wc-page">
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

      <section className="iso-section wc-hero">
        <div className="iso-shell wc-hero-grid">
          <div className="wc-hero-lead">
            <p className="iso-kicker">Supply loop · Roadmap</p>
            <div className="wc-hero-chiprow">
              <RoadmapChip detail="coming capability, subject to licensing" />
            </div>
            <h1 className="iso-section-title wc-hero-title">
              Your invoices are
              <span>working capital.</span>
            </h1>
            <p className="wc-hero-desc">
              Splash is building buyer-funded early payment on the same settlement rail that moves your
              payouts today. No third-party lender — your buyer&apos;s approved USD, released early
              against an invoice you both already trust.
            </p>
            <div className="wc-hero-actions">
              <Link href="/signup?interest=financing" className="iso-button">
                Register financing interest
                <ArrowRight aria-hidden="true" />
              </Link>
              <Link href="/" className="iso-button iso-button-ghost">
                See live settlement first
              </Link>
            </div>
            <dl className="wc-hero-proof">
              {heroProof.map((item) => (
                <div key={item.k}>
                  <dt>{item.k}</dt>
                  <dd>{item.v}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="wc-hero-ticket">
            <DiscountTermSheet />
          </div>
        </div>
      </section>

      <section className="iso-section iso-supply wc-receivable">
        <div className="iso-shell">
          <ChapterHeading
            index="§01"
            kicker="The Receivable"
            title={<>An invoice that carries<span>its own settlement history.</span></>}
            lede={
              <>
                In plain finance terms: a Receivable would be an invoice object that remembers how it
                gets paid — who approved it, on what rail, with what proof. History a lender would
                charge you to underwrite, your buyer can simply read.
              </>
            }
          />
          <FlowCards items={receivableFacts} />
        </div>
      </section>

      <section className="iso-section wc-mechanics">
        <div className="iso-shell">
          <ChapterHeading
            index="§02"
            kicker="Buyer-funded discounting"
            title={<>Early payment,<span>without a lender.</span></>}
            lede={
              <>
                Dynamic discounting is a trade between two parties who already trust each other: the
                buyer puts idle USD to work, the supplier turns a due date into cash flow. Splash would
                only referee the exchange.
              </>
            }
          />
          <FlowCards items={discountSteps} />
        </div>
      </section>

      <section className="iso-section iso-loops wc-flywheel">
        <div className="iso-shell">
          <ChapterHeading
            index="§03"
            kicker="Where Supply fits"
            title={<>One rail,<span>three loops.</span></>}
            lede={
              <>
                Settle is live and feeds the loop with verified counterparties and settlement history.
                Supply would compound it into working capital. Save keeps idle balances tidy in between.
              </>
            }
          />
          <WorkingCapitalFlywheel variant="full" />
        </div>
      </section>

      <section className="iso-section wc-cta">
        <div className="iso-shell">
          <div className="wc-close">
            <div className="wc-close-copy">
              <p className="iso-kicker">Shape the build order</p>
              <h2 className="iso-section-title wc-h2">
                Early interest decides
                <span>which corridor is first.</span>
              </h2>
              <p className="wc-legal">
                Dynamic discounting is a coming capability, subject to licensing. Registering interest
                does not create a financing commitment — it tells us which corridors to build first.
              </p>
            </div>
            <div className="wc-close-actions">
              <Link href="/signup?interest=financing" className="iso-button">
                Register financing interest
                <ArrowRight aria-hidden="true" />
              </Link>
              <Link href="/" className="iso-button iso-button-ghost iso-button-small">
                See live settlement
              </Link>
            </div>
          </div>
        </div>
      </section>

      <footer className="wc-footer">
        <div className="iso-shell wc-footer-inner">
          <span>© 2026 Splash Financial Labuan Ltd.</span>
          <span>Supply loop: roadmap · Settle loop: live on testnet</span>
        </div>
      </footer>
    </main>
  );
}
