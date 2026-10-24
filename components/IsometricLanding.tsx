'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Anchor,
  ArrowDownRight,
  ArrowRight,
  ArrowUp,
  BrainCircuit,
  Check,
  ChevronRight,
  FileCheck2,
  Gauge,
  PenLine,
  ShieldCheck,
  TrendingUp,
  Workflow,
  Zap,
} from 'lucide-react';

import FloatingToken from '@/components/landing/FloatingToken';
import HowItWorks from '@/components/landing/HowItWorks';
import PartnersRail, { type SignedPartner } from '@/components/landing/PartnersRail';
import PhoneStickyCta from '@/components/landing/PhoneStickyCta';
import ProductSection from '@/components/landing/ProductSection';
import SettlementCinematic from '@/components/landing/SettlementCinematic';
import WaitlistCta from '@/components/landing/WaitlistCta';
import LocalTime from '@/components/LocalTime';
import ControlPlaneExplainer from '@/components/oxwal/ControlPlaneExplainer';
import RoadmapChip from '@/components/supply/RoadmapChip';
import { claims, lockedCopy } from '@/content/claims';
import { pricingSummary, type FeeScheduleWire, type PricingSummary } from '@/lib/fees/copy';
import { LAUNCH_SCHEDULE } from '@/lib/fees/schedule';
import { formatBps } from '@/lib/fx/calculator';
import { getComparisonBaseline } from '@/lib/fx/comparison-baselines';
import { formatMinor } from '@/lib/money';
import { landingImage, type LandingImage } from '@/lib/landing/images';
import { BRAND } from '@/content/brand';
import { CUSTODY_LICENCE } from '@/lib/custody-phase-rules';

const LIQUIDITY_ART = landingImage('liquidity-pools');

const operatingLayers: Array<{ number: string; label: string; title: string; copy: string; image: string; art?: LandingImage; imageAlt: string; meta: string }> = [
  {
    number: '01',
    label: 'Liquidity',
    title: 'Keep USD productive.',
    copy: 'Keep payout inventory ready while treasury projections model how excess USD could remain productive.',
    image: LIQUIDITY_ART.src,
    art: LIQUIDITY_ART,
    imageAlt: 'Tiered isometric liquidity pools with gold coin reserves flowing between basins',
    meta: 'Available cash - projected treasury',
  },
  {
    number: '02',
    label: 'Settlement',
    title: 'Funds cannot get stuck.',
    copy: 'Every payment settles completely or not at all. It never lands halfway.',
    image: '/cinematic/settlement-machine.png',
    imageAlt: 'Isometric settlement machine turning US dollar coins into local currency through a checkpoint',
    meta: lockedCopy.speed,
  },
  {
    number: '03',
    label: 'Treasury',
    title: 'Make cash work harder.',
    copy: 'Zeke recommends a treasury posture. Your business approves every action; execution remains gated.',
    image: '/cinematic/treasury-island.png',
    imageAlt: 'Isometric floating treasury island with an open vault of reserves and orbiting coins',
    meta: 'Simulation - human approval',
  },
];

/* The comparison's competitor figures (the A1 review). The bank and
   fintech columns are the reviewed category midpoints for USD to PHP from
   a named, dated dataset (lib/fx/comparison-baselines.ts): a correspondent
   wire with its FX margin, and the digital-provider category, never a
   named provider. No broker figure has a source, so its cells show none
   rather than a number nobody can check. */
const COMPARISON_BASELINE = getComparisonBaseline('PHP');
const UNSOURCED = 'Varies';
const BANK_WIRE = COMPARISON_BASELINE?.bankWire ?? null;
const BANK_WIRE_DELIVERY = BANK_WIRE?.delivery ?? UNSOURCED;
const BANK_WIRE_COST = BANK_WIRE ? `US$${formatMinor(BANK_WIRE.flatUsdMinor, 2)} + ${formatBps(BANK_WIRE.marginBps)} FX margin` : UNSOURCED;
const FINTECH = COMPARISON_BASELINE?.fintech ?? null;
const FINTECH_DELIVERY = FINTECH?.delivery ?? UNSOURCED;
const FINTECH_COST = FINTECH ? `US$${formatMinor(FINTECH.flatUsdMinor, 2)} + ${formatBps(FINTECH.marginBps)} FX margin` : UNSOURCED;
/** The dataset's ISO date as a reader says it ("31 March 2025"): a calendar
 *  date, not a moment, so it is spelled out the same on server and client. */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function calendarDate(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}
const BASELINE_DATE = COMPARISON_BASELINE ? calendarDate(COMPARISON_BASELINE.dataset.asOf) : '';

const comparisonRowsFor = (pricing: PricingSummary) => [
  {
    feature: 'Settlement speed',
    bank: BANK_WIRE_DELIVERY,
    broker: UNSOURCED,
    fintech: FINTECH_DELIVERY,
    splash: lockedCopy.speed,
  },
  {
    feature: 'Fee to a bank',
    bank: BANK_WIRE_COST,
    broker: UNSOURCED,
    fintech: FINTECH_COST,
    // The schedule once fees are on; until then, none is charged.
    splash: pricing.feesOn ? pricing.bank : pricing.bankFeePhrase,
  },
  {
    feature: 'FX transparency',
    bank: 'Hidden markup',
    broker: 'Cash spread',
    fintech: 'Margin in the rate',
    splash: 'Oracle-labeled quote',
  },
  {
    feature: 'Atomic settlement',
    bank: 'No',
    broker: 'No',
    fintech: 'No',
    splash: 'Yes',
  },
  {
    feature: 'Batch payments',
    bank: 'Limited',
    broker: 'No',
    fintech: 'Limited',
    splash: 'Native',
  },
  {
    feature: 'AI treasury copilot',
    bank: 'No',
    broker: 'No',
    fintech: 'No',
    splash: lockedCopy.agent,
  },
  {
    feature: 'Early payment on invoices',
    bank: 'Manual factoring',
    broker: 'No',
    fintech: 'No',
    splash: 'Buyer-approved discount offer',
  },
  {
    feature: 'Bilateral netting',
    bank: 'Manual',
    broker: 'No',
    fintech: 'No',
    splash: 'Modeled in account loop',
  },
  {
    feature: 'Permanent audit trail',
    bank: 'Siloed records',
    broker: 'Manual receipts',
    fintech: 'Platform history',
    splash: 'Encrypted and kept',
  },
  {
    feature: 'Recipient account ladder',
    bank: 'Bank account only',
    broker: 'Cash-out only',
    fintech: 'Provider account',
    splash: 'Payout, sweep, stored balance',
  },
];

/** Each benchmark as its source published it, read live by /api/market/yields; null when it could not be read. */
type YieldBenchmarks = {
  bank: number | null;
  broker: number | null;
  wise: number | null;
  splash: number | null;
  asOf: string;
};

/** Nothing is shown until a source has been read: no remembered rate stands in for a reading. */
const unreadYieldBenchmarks: YieldBenchmarks = {
  bank: null,
  broker: null,
  wise: null,
  splash: null,
  asOf: '',
};

/** A benchmark rate for a table cell, or "No reading" when its source could not be read. */
function yieldCell(value: number | null, suffix: string) {
  return value === null ? 'No reading' : `${formatPercent(value)} ${suffix}`;
}

const percentFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatPercent(value: number) {
  return `${percentFormatter.format(value)}%`;
}

const copilotLayers = [
  {
    icon: Gauge,
    title: 'Rate intelligence',
    copy: 'Watch every corridor and surface better timing before a payment is approved.',
  },
  {
    icon: FileCheck2,
    title: 'Invoice forecasting',
    copy: 'Extract upcoming obligations from invoices while the original file stays encrypted.',
  },
  {
    icon: Workflow,
    title: 'Batch optimizer',
    copy: 'Recognize repeat corridor patterns and suggest grouped payouts with lower operating cost.',
  },
  {
    icon: TrendingUp,
    title: 'Treasury advisor',
    copy: 'Model payout liquidity and projected yield, then wait for explicit business approval.',
  },
];

// Rungs 02 and 03 hold customer funds: Phase 2, behind the same custody gate
// the transfer form and /api/transfers/authorize enforce.
const recipientLadder = [
  {
    number: '01',
    title: 'Payout',
    status: 'Live-model',
    copy: 'Deliver local currency to a verified recipient through the current payout rail.',
  },
  {
    number: '02',
    title: 'Sweep account',
    status: 'Phase 2',
    copy: `A Splash account that sweeps to the recipient's bank. It holds funds, which needs ${CUSTODY_LICENCE}.`,
  },
  {
    number: '03',
    title: 'Stored balance',
    status: 'Phase 2',
    copy: 'Keep value inside the network where regulation and partner controls permit it.',
  },
];

/* Trust · Four gates — the control sequence every payout passes, in order.
   Copy stays inside content/claims.ts truth: Sumsub KYB wired, human-final
   approval, settlement, and the encrypted evidence recorded beside it. */
const trustGates = [
  {
    number: '01',
    label: 'Verify',
    icon: ShieldCheck,
    title: 'KYB on both sides.',
    copy: 'A payout only exists between verified businesses. Sumsub gates every counterparty before a quote is even prepared.',
    meta: 'Sumsub KYB · wired',
  },
  {
    number: '02',
    label: 'Approve',
    icon: PenLine,
    title: 'A person signs. Always.',
    copy: 'Zeke prepares. You approve. No payout, batch, or treasury move executes without a human signature.',
    meta: 'Maker-checker · human-final',
  },
  {
    number: '03',
    label: 'Settle',
    icon: Zap,
    title: 'Atomic or not at all.',
    copy: 'The prepared payment completes exactly as approved — or stops safely before funds move. No partial states.',
    meta: lockedCopy.speed,
  },
  {
    number: '04',
    label: 'Prove',
    icon: Anchor,
    title: 'Evidence outlives the payment.',
    copy: 'Receipts and encrypted documents are written where they cannot be quietly changed — a record you can hand to an auditor.',
    meta: 'Encrypted and recorded',
  },
];

const headerNavItems = [
  { href: '#how-it-works', label: 'How it works', detail: '5 steps' },
  { href: '#platform', label: 'Platform', detail: 'Pay + treasury' },
  { href: '/working-capital', label: 'Working capital', detail: 'Supply loop' },
  { href: '#corridors', label: 'Routes', detail: 'PH and ID' },
  { href: '#comparison', label: 'Compare', detail: 'Fees + speed' },
  { href: '#copilot', label: 'Zeke', detail: 'Prepare + approve' },
];


const loopCards = [
  {
    number: '01',
    label: 'Settle',
    title: 'Move it in minutes.',
    copy: 'Collect USD, pay Southeast Asia. Every approved payout builds verified counterparties and settlement history.',
    image: '/isometric/loop-settle-v3.png',
    imageAlt: 'Isometric settlement: a USD coin crossing an approved rail in minutes to arrive as a PHP coin',
    meta: 'USDC → PHP and IDR',
    roadmap: false,
  },
  {
    number: '02',
    label: 'Save',
    title: 'Grow it while it waits.',
    copy: 'Idle USD follows a projected, variable treasury posture. Your business approves every move.',
    image: '/isometric/loop-save-v3.png',
    imageAlt: 'Isometric treasury tiers of idle USD growing along a yield curve, gated by an approve control',
    meta: 'Projected · variable · human-approved',
    roadmap: false,
  },
  {
    number: '03',
    label: 'Supply',
    title: 'Finance it — the moat.',
    copy: 'Invoices would become working capital: your buyer funds early payment against a receivable both sides can verify.',
    image: '/isometric/loop-supply.png',
    imageAlt: 'Isometric supply loop: an invoice financed early and returned as working capital',
    meta: 'Buyer-funded · no third-party lender',
    roadmap: true,
  },
];

const LAUNCH_PRICING = pricingSummary(LAUNCH_SCHEDULE);

/**
 * The value on the closing art's Fee row (the A1 review). The receipt in
 * public/isometric/payments.svg is a raster, and the rate once baked into
 * it is gone; this writes Splash's bank fee there from the schedule in
 * force, or "None yet" while the fees are off (PricingSummary.bankFee), so
 * no rate on the art is one the schedule did not set.
 *
 * It is drawn in the art's own coordinates and laid over it in the same box
 * (globals.css .iso-final-art-fee), so it tracks the art at every width. The
 * outer matrix is the one payments.svg places its raster with; the inner one
 * puts the text on the Fee row's isometric baseline (it climbs 0.48 px per
 * px), condensed to the art's lettering, right-aligned where the old rate
 * ended. Decorative: the fee is in words on the page itself.
 */
function ReceiptArtFee({ value }: { value: string }) {
  return (
    <svg className="iso-final-art-fee" viewBox="0 0 1086 814.5" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
      <g transform="matrix(0.861356 0 0 0.862736 280.465514 -15.590548)">
        <text transform="matrix(0.72 -0.3456 0 1 507 669)" textAnchor="end">{value}</text>
      </g>
    </svg>
  );
}

/**
 * `pricing` is Splash's fee schedule in words, from app/page.tsx, which reads
 * the schedule in force (lib/fees/fee-config.ts publishedFeeSchedule). The
 * launch schedule is only the default for a caller that passes none.
 */
export default function IsometricLanding({
  isPhone = false,
  pricing = LAUNCH_PRICING,
  fees,
  signedPartners = [],
  fundingPartners = [],
}: {
  isPhone?: boolean;
  pricing?: PricingSummary;
  /** The published schedule and whether its fees are on, for the calculator. */
  fees: { schedule: FeeScheduleWire; feesOn: boolean };
  /** Partners whose agreements are signed (SIGNED_PARTNERS), read on the server. */
  signedPartners?: readonly SignedPartner[];
  /** The signed funding providers' names, for the Splash Wallet card. */
  fundingPartners?: readonly string[];
}) {
  // The control plane reveals below the copilot on demand — a credit-roll,
  // not a second section.
  const [ctrlOpen, setCtrlOpen] = useState(false);
  const [yieldBenchmarks, setYieldBenchmarks] = useState(unreadYieldBenchmarks);
  const [showBackToTop, setShowBackToTop] = useState(false);

  useEffect(() => {
    let active = true;

    async function refreshYields() {
      try {
        const response = await fetch('/api/market/yields');
        if (!response.ok) return;
        const body = await response.json() as YieldBenchmarks;
        if (active) setYieldBenchmarks(body);
      } catch {
        // Keep the latest known benchmarks if a source is temporarily unavailable.
      }
    }

    void refreshYields();
    const interval = window.setInterval(refreshYields, 5 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    function updateHeaderState() {
      setShowBackToTop(window.scrollY > Math.max(20, window.innerHeight * 0.05));
    }

    updateHeaderState();
    window.addEventListener('scroll', updateHeaderState, { passive: true });
    window.addEventListener('resize', updateHeaderState);
    return () => {
      window.removeEventListener('scroll', updateHeaderState);
      window.removeEventListener('resize', updateHeaderState);
    };
  }, []);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const targets = document.querySelectorAll(
      '.iso-section > .iso-shell',
    );
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-inview');
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -12% 0px' },
    );
    targets.forEach((el) => {
      el.classList.add('cin-reveal');
      observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  const liveComparisonRows = [
    ...comparisonRowsFor(pricing),
    {
      feature: 'Yield on idle USD',
      bank: yieldCell(yieldBenchmarks.bank, 'APY'),
      broker: yieldCell(yieldBenchmarks.broker, 'APY'),
      fintech: yieldCell(yieldBenchmarks.wise, 'APY'),
      splash: yieldCell(yieldBenchmarks.splash, 'projected variable APY'),
    },
  ];

  return (
    <main className={`iso-landing${isPhone ? ' is-phone' : ''}`}>
      <header className={`iso-header ${showBackToTop ? 'is-scrolled' : ''}`}>
        <div className="iso-shell iso-header-inner">
          <Link href="/" className="iso-brand" aria-label="Splash Finance home">
            <Image src="/splash-main-icon.png" alt="" width={841} height={823} className="iso-header-brand-icon" priority />
            <span className="iso-header-wordmark">
              <strong>Splash</strong>
            </span>
          </Link>

          <nav className="iso-nav" aria-label="Primary navigation">
            {headerNavItems.map((item) => (
              <a href={item.href} key={item.href}>
                <span>{item.label}</span>
                <small>{item.detail}</small>
              </a>
            ))}
          </nav>

          <div className="iso-header-actions">
            <Link href="/signup" className="iso-button iso-button-small">
              Open payment desk
              <ArrowDownRight aria-hidden="true" />
            </Link>
          </div>
        </div>
      </header>

      <SettlementCinematic isPhone={isPhone} pricing={pricing} />

      <ProductSection fees={fees} />

      <PartnersRail signed={signedPartners} />

      <section id="how-it-works" className="iso-section iso-flow" aria-labelledby="how-title">
        <HowItWorks fundingPartners={fundingPartners} />
      </section>

      <section id="comparison" className="iso-section iso-comparison">
        <div className="cin-drop" style={{ top: 26, right: '4%' }} aria-hidden="true">
          <FloatingToken src="/cinematic/token-thb.png" alt="Thai baht token" size={104} float="cin-float-slow" />
        </div>
        <div className="iso-shell">
          <div className="iso-section-heading iso-heading-split">
            <div>
              <p className="iso-kicker">Comparison</p>
              <h2 className="iso-section-title">
                Built for business.
                <span>Designed to move.</span>
              </h2>
            </div>
            <p>
              Splash makes internal account movement free, charges when value exits to local rails, and adds
              programmable settlement, approval-led AI, and private audit proof.
            </p>
          </div>

          <div id="corridors" className="iso-corridor-layout iso-corridor-embed">
          <div className="iso-corridor-copy">
            <p className="iso-kicker">PH and ID first. Four more under pilot access.</p>
            <h2 className="iso-section-title">
              USD in.
              <span>Local out.</span>
            </h2>
            <p>
              The MY-to-PH corridor is the proving ground. Additional routes stay modeled until partner, liquidity,
              and regulatory controls are ready market by market.
            </p>
            <div className="iso-route-list">
              <span className="is-live">PHP</span><span className="is-live">IDR</span><span>MYR</span><span>VND</span>
              <span>THB</span><span>SGD</span>
            </div>
            <div className="iso-recipient-ladder">
              {recipientLadder.map((step) => (
                <article key={step.number}>
                  <span>{step.number}</span>
                  <div>
                    <small>{step.status}</small>
                    <strong>{step.title}</strong>
                    <p>{step.copy}</p>
                  </div>
                </article>
              ))}
            </div>
            <Link href="/signup" className="iso-inline-link">
              Open the payout desk
              <ArrowRight aria-hidden="true" />
            </Link>
          </div>

          <div className="iso-corridor-stage">
            <Image
              src="/cinematic/corridor-bridge-v3.png"
              alt="Two isometric city platforms, Kuala Lumpur and Manila, connected by a golden bridge of flowing coins"
              width={2752}
              height={1536}
            />
          </div>
        </div>

          <div className="iso-comparison-wrap">
            <table className="iso-comparison-table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>Bank</th>
                  <th>Broker</th>
                  <th>Fintech app</th>
                  <th className="is-splash">Splash</th>
                </tr>
              </thead>
              <tbody>
                {liveComparisonRows.map((row) => (
                  <tr key={row.feature}>
                    <th scope="row">{row.feature}</th>
                    <td>{row.bank}</td>
                    <td>{row.broker}</td>
                    <td>{row.fintech}</td>
                    <td className="is-splash"><span className="iso-splash-cell"><Check aria-hidden="true" /> {row.splash}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="iso-pricing-line">
              <strong>Splash pricing</strong>
              <span>{pricing.line}</span>
            </p>
            {COMPARISON_BASELINE ? (
              <p className="iso-pricing-line">
                <strong>Bank and fintech figures</strong>
                <span>
                  Category midpoints for a transfer of US$1,000 or more, from{' '}
                  <a href={COMPARISON_BASELINE.dataset.url} rel="noopener noreferrer" target="_blank">{COMPARISON_BASELINE.dataset.name}</a>, as of {BASELINE_DATE}: a correspondent wire with its FX margin and the digital-provider category, not a named provider. No broker figure is shown without a source.
                </span>
              </p>
            ) : null}
            <div className="iso-yield-live is-demoted">
              <i aria-hidden="true" />
              <strong>Reference yield benchmark</strong>
              <span>
                FDIC national savings - IBKR Pro cash - Wise USD Interest - Splash treasury projection
                {yieldBenchmarks.asOf ? <> - refreshed <LocalTime value={yieldBenchmarks.asOf} format="time" options={{ hour: '2-digit', minute: '2-digit' }} /></> : ''}
                {' '}· Yield is hygiene, not the headline — the working-capital loop is.
              </span>
            </div>
          </div>
        </div>
      </section>

      <section id="loops" className="iso-section iso-loops">
        <div className="cin-drop" style={{ top: 28, right: '4%' }} aria-hidden="true">
          <FloatingToken src="/cinematic/token-usd.png" alt="US dollar token" size={104} float="cin-float-slow" />
        </div>
        <div className="iso-shell">
          <div className="iso-section-heading iso-heading-split">
            <div>
              <p className="iso-kicker">The three loops</p>
              <h2 className="iso-section-title">
                Move it. Grow it.
                <span>Finance it.</span>
              </h2>
            </div>
            <p>
              Idle dollars on Sui already move for free — Splash&apos;s job is what the transfer
              alone can&apos;t do. Settle in minutes. Save while it waits. Supply turns invoices
              into working capital.
            </p>
          </div>

          <div className="iso-loops-grid">
            {loopCards.map((loop, index) => (
              <article className={`iso-loops-card iso-loops-card-${index + 1}`} key={loop.number}>
                <div className="iso-loops-meta">
                  <span>{loop.number}</span>
                  <p>{loop.label}</p>
                  {loop.roadmap ? <RoadmapChip /> : <em className="iso-loops-live"><i aria-hidden="true" /> Live</em>}
                </div>
                <div className="iso-loops-art">
                  <Image src={loop.image} alt={loop.imageAlt} width={640} height={480} />
                </div>
                <div className="iso-loops-copy">
                  <h3>{loop.title}</h3>
                  <p>{loop.copy}</p>
                  <small>{loop.meta}</small>
                  {loop.roadmap ? (
                    <Link href="/working-capital" className="iso-inline-link iso-loops-more">
                      Learn more
                      <ArrowRight aria-hidden="true" />
                    </Link>
                  ) : null}
                </div>
              </article>
            ))}
          </div>

          <div className="iso-loops-foot">
            <p className="iso-gasless-note">
              <strong>Where the fees live:</strong> simple USD payouts ride Sui&apos;s zero-fee
              rail; programmable settlement is gas-sponsored. You never hold SUI.
            </p>
            <Link href="/working-capital" className="iso-button iso-button-small">
              Explore the Supply loop
              <ArrowRight aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>

      <section id="platform" className="iso-section iso-operating">
        <div className="cin-drop" style={{ top: 30, right: '5%' }} aria-hidden="true">
          <FloatingToken src="/cinematic/token-idr-v1.png" alt="Indonesian rupiah token" size={108} float="cin-float-slow" />
        </div>
        <div className="iso-shell">
          <div className="iso-section-heading iso-heading-split">
            <div>
              <p className="iso-kicker">The platform</p>
              <h2 className="iso-section-title">
                Everything between invoice
                <span>and settlement.</span>
              </h2>
            </div>
            <p>
              One approval-gated desk for liquidity, settlement, and treasury. Funding, payout,
              receivables, and treasury actions stay sandboxed until those rails are active.
            </p>
          </div>

          <div className="iso-layer-grid">
            {operatingLayers.map((layer, index) => (
              <article className={`iso-layer-card iso-layer-card-${index + 1}`} key={layer.number}>
                <div className="iso-layer-meta">
                  <span>{layer.number}</span>
                  <p>{layer.label}</p>
                </div>
                <div className="iso-layer-art">
                  {layer.art ? (
                    <Image src={layer.art.src} loader={layer.art.loader} alt={layer.imageAlt} width={layer.art.width} height={layer.art.height} sizes="(max-width: 900px) 92vw, 440px" />
                  ) : (
                    <Image src={layer.image} alt={layer.imageAlt} width={1448} height={1086} />
                  )}
                </div>
                <div className="iso-layer-copy">
                  <h3>{layer.title}</h3>
                  <p>{layer.copy}</p>
                  <small>{layer.meta}</small>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="trust" className="iso-section iso-trust">
        <div className="cin-drop" style={{ top: 30, right: '5%' }} aria-hidden="true">
          <FloatingToken src="/cinematic/token-sui.png" alt="Sui token" size={104} float="cin-float-slow" />
        </div>
        <div className="iso-shell">
          <div className="iso-section-heading iso-heading-split">
            <div>
              <p className="iso-kicker">Trust · Four gates</p>
              <h2 className="iso-section-title iso-section-title-light">
                Every payout
                <span>proves itself.</span>
              </h2>
            </div>
            <p>
              A payment on Splash cannot skip a checkpoint: verified before it&apos;s quoted,
              approved before it&apos;s signed, atomic when it settles, anchored after it lands.
            </p>
          </div>

          <div className="iso-trust-rail" aria-hidden="true">
            {trustGates.map((gate) => (
              <span key={gate.number}><i /></span>
            ))}
          </div>

          <ol className="iso-trust-grid">
            {trustGates.map((gate) => (
              <li className="iso-trust-card" key={gate.number}>
                <div className="iso-trust-meta">
                  <span>{gate.number}</span>
                  <p>{gate.label}</p>
                  <gate.icon aria-hidden="true" />
                </div>
                <h3>{gate.title}</h3>
                <p>{gate.copy}</p>
                <small>{gate.meta}</small>
              </li>
            ))}
          </ol>

          <p className="iso-trust-foot">
            Sandbox environment · Not yet a licensed money-services business · No real money moves
          </p>
        </div>
      </section>

      <section id="copilot" className="iso-section iso-copilot">
        <div className="iso-shell iso-copilot-layout">
          <div className="iso-copilot-stack">
          <div className="iso-copilot-stage">
            <Image
              src="/cinematic/copilot-desk.png"
              alt="Zeke, an isometric robot assistant at a desk, presenting suggestion cards"
              width={2172}
              height={1629}
            />
            <div className="iso-copilot-memory">
              <BrainCircuit aria-hidden="true" />
              <span>
                <small>MemWal remembers patterns</small>
                <strong>AI proposes. Your team approves.</strong>
              </span>
            </div>
          </div>

          {/* The MemWal badge is pinned to the stage's bottom edge, so this
              sits in flow directly beneath it — the stage column's own CTA. */}
          <button
            type="button"
            className="iso-ctrl-toggle"
            aria-expanded={ctrlOpen}
            aria-controls="control-plane"
            onClick={() => setCtrlOpen((open) => !open)}
          >
            <Workflow aria-hidden="true" />
            <span>
              <small>The control plane</small>
              <strong>{ctrlOpen ? 'Hide the pipeline' : 'See the pipeline it runs'}</strong>
            </span>
            <ChevronRight aria-hidden="true" className="iso-ctrl-toggle-chevron" />
          </button>
          </div>

          <div className="iso-copilot-copy">
            <p className="iso-kicker">AI Copilot</p>
            <h2 className="iso-section-title">
              Context that gets
              <span>more useful.</span>
            </h2>
            <p>
              The copilot connects rates, invoices, batch habits, and treasury posture without storing PII,
              account numbers, transaction hashes, or raw dollar amounts in MemWal.
            </p>
            <div className="iso-copilot-list">
              {copilotLayers.map(({ icon: Icon, title, copy }) => (
                <article key={title}>
                  <Icon aria-hidden="true" />
                  <span>
                    <strong>{title}</strong>
                    <small>{copy}</small>
                  </span>
                </article>
              ))}
            </div>
          </div>
        </div>

        {ctrlOpen ? (
          <div className="iso-shell iso-ctrl-shell iso-ctrl-revealed" id="control-plane">
            <span className="iso-ctrl-reveal-line" aria-hidden="true" />
            <div className="iso-section-heading iso-heading-split">
              <div>
                <p className="iso-kicker">The control plane</p>
                <h2 className="iso-section-title">
                  Shipped, not
                  <span>promised.</span>
                </h2>
              </div>
              <p>
                Every Zeke recommendation runs this exact pipeline before money can move. The phase
                names below are the engine&apos;s own state machine — inspect them in the Action Queue.
              </p>
            </div>
            <ControlPlaneExplainer />
          </div>
        ) : null}
      </section>

      <section className="iso-section iso-final">
        <div className="iso-shell iso-final-panel">
          <div className="iso-final-copy">
            <p className="iso-kicker">Move money better</p>
            <h2 className="iso-section-title iso-section-title-light">
              Your global treasury,
              <span>finally programmable.</span>
            </h2>
            <p>
              Start with USD. Prove the MY-to-PH path. Expand only when controls and partners are ready.
            </p>
            <div className="iso-hero-actions">
              <Link href="/signup" className="iso-button iso-button-gold">
                Open payment desk
                <ArrowRight aria-hidden="true" />
              </Link>
              <Link href="/login" className="iso-button iso-button-dark-ghost">Log in</Link>
              <WaitlistCta tone="dark" />
            </div>
          </div>

          <div className="iso-final-art">
            <Image
              src="/isometric/payments.svg"
              alt="Isometric local currency payment receipt"
              width={1448}
              height={1086}
            />
            <ReceiptArtFee value={pricing.bankFee} />
          </div>
        </div>
      </section>

      <footer className="iso-footer cin-footer">
        <div className="iso-shell cin-footer-grid">
          <div className="cin-footer-brand">
            <span className="cin-footer-logo">
              <Image src="/splash-main-icon.png" alt="" width={841} height={823} />
              <strong>Splash</strong>
            </span>
            <p>USD-first settlement infrastructure for Southeast Asian finance teams.</p>
            <div className="cin-footer-status" aria-label="Network status">
              <span><i aria-hidden="true" /> Payouts to PH and ID</span>
              <span><i aria-hidden="true" /> {lockedCopy.speed}</span>
              <span><i aria-hidden="true" /> {lockedCopy.agent}</span>
            </div>
          </div>

          <nav className="cin-footer-col" aria-label="Product">
            <strong>Product</strong>
            <a href="#how-it-works">How it works</a>
            <a href="#comparison">Compare</a>
            <a href="#platform">Platform</a>
            <Link href="/working-capital">Working capital</Link>
            <a href="#corridors">Routes</a>
          </nav>

          <nav className="cin-footer-col" aria-label="Trust">
            <strong>Trust</strong>
            <Link href="/trust">Trust &amp; compliance</Link>
            <a href="#copilot">Zeke control plane</a>
            <Link href="/login">Log in</Link>
            <Link href="/signup">Open payment desk</Link>
          </nav>

          <div className="cin-footer-col cin-footer-compliance">
            <strong>Compliance</strong>
            <small>{claims.footerLegal.claim}</small>
          </div>
        </div>

        <div className="cin-footer-bar">
          <div className="iso-shell cin-footer-bar-inner">
            <span>{BRAND.copyright()}</span>
            <span className="cin-footer-tick">
              {pricing.parts[0]} · {lockedCopy.speed} · {pricing.bankFeePhrase}
            </span>
          </div>
        </div>
      </footer>
      <PhoneStickyCta />
      <button
        type="button"
        className={`iso-back-to-top ${showBackToTop ? 'is-visible' : ''}`}
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        aria-label="Back to top"
      >
        <ArrowUp aria-hidden="true" />
      </button>
    </main>
  );
}
