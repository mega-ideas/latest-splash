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
import ControlPlaneExplainer from '@/components/oxwal/ControlPlaneExplainer';
import RoadmapChip from '@/components/supply/RoadmapChip';
import { lockedCopy, saasCompliance } from '@/content/claims';
import { pricingSummary, type FeeScheduleWire, type PricingSummary } from '@/lib/fees/copy';
import { LAUNCH_SCHEDULE } from '@/lib/fees/schedule';
import { getComparisonBaseline } from '@/lib/fx/comparison-baselines';
import { comparisonRows, SPEED_LINE } from '@/lib/landing/comparison';
import { landingImage, type LandingImage } from '@/lib/landing/images';
import { PILOT_ROUTES, QUOTABLE_ROUTES } from '@/lib/landing/routes';
import { BRAND } from '@/content/brand';

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
    meta: SPEED_LINE,
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
   a named, dated dataset (lib/fx/comparison-baselines.ts); every other
   competitor cell says "Varies" (lib/landing/comparison.ts). */
const COMPARISON_BASELINE = getComparisonBaseline('PHP');
/** The dataset's ISO date as a reader says it ("31 March 2025"): a calendar
 *  date, not a moment, so it is spelled out the same on server and client. */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function calendarDate(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}
const BASELINE_DATE = COMPARISON_BASELINE ? calendarDate(COMPARISON_BASELINE.dataset.asOf) : '';

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

/* Where a payment can land (v2 brief section 6). A bank in local currency
   through a partner of record, or a wallet in stablecoin; and the money
   waiting to be sent sits in the business's own Splash Wallet. There is no
   Splash account that holds anyone's funds (D3). */
const recipientLadder = [
  {
    number: '01',
    title: 'Bank payout',
    status: 'Live',
    copy: 'Local currency to a verified recipient’s bank, paid by a partner of record.',
  },
  {
    number: '02',
    title: 'Wallet payout',
    status: 'Live',
    copy: 'Stablecoin to another Splash business or a wallet whose owner has proved it.',
  },
  {
    number: '03',
    title: 'Splash Wallet',
    status: 'Stablecoins only',
    copy: 'Held by your business. Your owners sign; Splash has no key to it.',
  },
];

/* Trust: four gates, the control sequence every payment passes in order,
   whether it lands in a bank or a wallet (v2 brief section 6). */
const trustGates = [
  {
    number: '01',
    label: 'Verify',
    icon: ShieldCheck,
    title: 'Verified before money moves.',
    copy: 'KYB on your business. KYB or a signed ownership proof on every recipient, before a quote is prepared.',
    meta: 'Your business and every payee',
  },
  {
    number: '02',
    label: 'Approve',
    icon: PenLine,
    title: 'A person signs.',
    copy: 'Your owners’ multisig signs, or a spending rule they set does. Zeke prepares a payment; it never signs one.',
    meta: lockedCopy.agent,
  },
  {
    number: '03',
    label: 'Settle',
    icon: Zap,
    title: 'Exactly as approved.',
    copy: 'Amount, payee and rate are fixed at approval. The Sui step is all-or-nothing; the bank leg is tracked until the partner confirms.',
    meta: SPEED_LINE,
  },
  {
    number: '04',
    label: 'Prove',
    icon: Anchor,
    title: 'Proof that outlives the payment.',
    copy: 'The receipt and encrypted documents are kept where they cannot be quietly changed: a record you can hand to an auditor.',
    meta: 'Encrypted and kept',
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
    title: 'Finance it early.',
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
  const [showBackToTop, setShowBackToTop] = useState(false);

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

  const rows = comparisonRows(pricing, COMPARISON_BASELINE);

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

      <section id="comparison" className="iso-section iso-comparison" aria-labelledby="routes-title">
        <div className="cin-drop" style={{ top: 26, right: '4%' }} aria-hidden="true">
          <FloatingToken src="/cinematic/token-thb.png" alt="Thai baht token" size={104} float="cin-float-slow" />
        </div>
        <div className="iso-shell">
          <div id="corridors" className="iso-corridor-layout iso-corridor-embed">
            <div className="iso-corridor-copy">
              <p className="iso-kicker">Routes</p>
              <h2 className="iso-section-title" id="routes-title">
                One engine.
                <span>Route by route.</span>
              </h2>
              <p>
                Every payment settles in USDC on Sui first. A partner of record then pays the local bank.
                A new country is a new partner on the same engine, not a new system to learn.
              </p>

              <div className="iso-route-groups">
                <div className="iso-route-group">
                  <h3>
                    Live <small>{QUOTABLE_ROUTES.length} routes</small>
                  </h3>
                  <ul>
                    {QUOTABLE_ROUTES.map((route) => (
                      <li key={route.currency} className="is-live">
                        <strong>{route.currency}</strong>
                        <span>{route.country}</span>
                        <small>{route.arrives}</small>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="iso-route-group is-pilot">
                  <h3>
                    Pilot access <small>{PILOT_ROUTES.length} routes</small>
                  </h3>
                  <ul>
                    {PILOT_ROUTES.map((route) => (
                      <li key={route.currency}>
                        <strong>{route.currency}</strong>
                        <span>{route.country}</span>
                      </li>
                    ))}
                  </ul>
                  <a href="#product" className="iso-inline-link">
                    Request access
                    <ArrowRight aria-hidden="true" />
                  </a>
                </div>
              </div>

              <ol className="iso-recipient-ladder" aria-label="Where a payment can land">
                {recipientLadder.map((step) => (
                  <li key={step.number}>
                    <span aria-hidden="true">{step.number}</span>
                    <div>
                      <small>{step.status}</small>
                      <strong>{step.title}</strong>
                      <p>{step.copy}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <div className="iso-corridor-stage">
              <Image
                src="/cinematic/corridor-bridge-v3.png"
                alt="Two isometric city platforms connected by a golden bridge of flowing coins"
                width={2752}
                height={1536}
                sizes="(max-width: 900px) 92vw, 620px"
              />
            </div>
          </div>

          <div className="iso-comparison-head">
            <h3 className="iso-section-title iso-comparison-title">
              Built for business.
              <span>Designed to move.</span>
            </h3>
            <p>
              A payment through a bank, a broker or a fintech app, beside the same payment on Splash.
              Splash&apos;s column is what it does today.
            </p>
          </div>

          <div className="iso-comparison-wrap">
            <table className="iso-comparison-table">
              <caption className="sr-only">Splash compared with a bank wire, a broker and a fintech app</caption>
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  <th scope="col">Bank</th>
                  <th scope="col">Broker</th>
                  <th scope="col">Fintech app</th>
                  <th scope="col" className="is-splash">Splash</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.feature}>
                    <th scope="row">{row.feature}</th>
                    <td data-label="Bank">{row.bank}</td>
                    <td data-label="Broker">{row.broker}</td>
                    <td data-label="Fintech app">{row.fintech}</td>
                    <td className="is-splash" data-label="Splash"><span className="iso-splash-cell"><Check aria-hidden="true" /> {row.splash}</span></td>
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
                  <a href={COMPARISON_BASELINE.dataset.url} rel="noopener noreferrer" target="_blank">{COMPARISON_BASELINE.dataset.name}</a>, as of {BASELINE_DATE}: a correspondent wire with its FX margin and the digital-provider category, not a named provider. A cell with no published figure says Varies.
                </span>
              </p>
            ) : null}
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
              Idle dollars on Sui already move for free. Splash&apos;s job is what the transfer
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

      <section id="trust" className="iso-section iso-trust" aria-labelledby="trust-title">
        <div className="cin-drop" style={{ top: 30, right: '5%' }} aria-hidden="true">
          <FloatingToken src="/cinematic/token-sui.png" alt="Sui token" size={104} float="cin-float-slow" />
        </div>
        <div className="iso-shell">
          <div className="iso-section-heading iso-heading-split">
            <div>
              <p className="iso-kicker">Trust · Four gates</p>
              <h2 className="iso-section-title iso-section-title-light" id="trust-title">
                Every payment
                <span>proves itself.</span>
              </h2>
            </div>
            <p>
              To a bank or to a wallet, a payment on Splash passes the same four gates, in order. None
              of them can be skipped.
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

          <p className="iso-trust-foot">Splash is software; it has no key to your Splash Wallet.</p>
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
            <p>Stablecoin payments for Southeast Asian businesses, to a bank or a wallet.</p>
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
          </nav>

          <nav className="cin-footer-col" aria-label="Get started">
            <strong>Get started</strong>
            <Link href="/login">Log in</Link>
            <Link href="/signup">Open payment desk</Link>
          </nav>
        </div>

        <div className="iso-shell cin-footer-compliance">
          {saasCompliance(BRAND.legalEntity).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>

        <div className="cin-footer-bar">
          <div className="iso-shell cin-footer-bar-inner">
            <span>{BRAND.copyright()}</span>
            <span className="cin-footer-tick">
              {SPEED_LINE} · {pricing.bankFeePhrase}
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
