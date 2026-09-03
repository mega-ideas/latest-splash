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
import SettlementCinematic from '@/components/landing/SettlementCinematic';
import WaitlistCta from '@/components/landing/WaitlistCta';
import ControlPlaneExplainer from '@/components/oxwal/ControlPlaneExplainer';
import RoadmapChip from '@/components/supply/RoadmapChip';
import { claims, lockedCopy } from '@/content/claims';

const operatingLayers = [
  {
    number: '01',
    label: 'Liquidity',
    title: 'Keep USD productive.',
    copy: 'Keep payout inventory ready while treasury projections model how excess USD could remain productive.',
    image: '/cinematic/liquidity-pools.png',
    imageAlt: 'Tiered isometric liquidity pools with gold coin reserves flowing between basins',
    meta: 'Available cash - projected treasury',
  },
  {
    number: '02',
    label: 'Settlement',
    title: 'Funds cannot get stuck.',
    copy: 'Every payment intent settles or reverts atomically in one programmable Sui transaction.',
    image: '/cinematic/settlement-machine.png',
    imageAlt: 'Isometric settlement machine turning US dollar coins into local currency through a checkpoint',
    meta: lockedCopy.speed,
  },
  {
    number: '03',
    label: 'Treasury',
    title: 'Make cash work harder.',
    copy: '0xWal recommends a treasury posture. Your business approves every action; execution remains gated.',
    image: '/cinematic/treasury-island.png',
    imageAlt: 'Isometric floating treasury island with an open vault of reserves and orbiting coins',
    meta: 'Simulation - human approval',
  },
];

const flowSteps = [
  {
    id: 'intake',
    number: '01',
    title: 'Collect or upload',
    description: 'Create a pay link, upload an accepted invoice, or fund USD into the operating account.',
    image: '/cinematic/flow-collect-v4.png',
    imageAlt: 'Collect isometric typography with an invoice, pay link, and dollar coins',
    stat: 'Pay link or invoice',
  },
  {
    id: 'review',
    number: '02',
    title: 'Review quotes',
    description: 'KYB, recipient status, route, fee, treasury floor, and evidence labels appear before signature.',
    image: '/cinematic/flow-review-quotes-v4.png',
    imageAlt: 'Review quotes isometric typography with FX quote cards, checklist, and approval stamp',
    stat: 'Human approval',
  },
  {
    id: 'settle',
    number: '03',
    title: 'Settle in one signature',
    description: 'The prepared payment either completes as approved or stops safely before funds move.',
    image: '/cinematic/flow-settle-v4.png',
    imageAlt: 'Settle isometric typography with a coin passing an approval gate and a signing pen',
    stat: lockedCopy.speed,
  },
  {
    id: 'deliver',
    number: '04',
    title: 'Deliver locally',
    description: 'Pay a verified supplier or sweep value into the recipient ladder where the corridor allows it.',
    image: '/cinematic/flow-deliver-v4.png',
    imageAlt: 'Deliver isometric typography with a truck bringing a peso coin to a local shop',
    stat: lockedCopy.fee,
  },
  {
    id: 'proof',
    number: '05',
    title: 'Anchor the proof',
    description: 'Receipts, encrypted documents, and daily audit evidence remain available for review.',
    image: '/cinematic/flow-proof-v4.png',
    imageAlt: 'Proof isometric typography with an archive vault, sealed certificate, and shield badge',
    stat: 'Walrus + Sui audit',
  },
];

/* Metrics ticker: the moving bridge band at the bottom of the hero. */
const marqueeItems = [
  ['1 live testnet', 'MY to PH corridor'],
  ['Modeled routes', 'expand with controls'],
  ['~400ms', 'Sui settlement finality'],
  ['From 0.80%', 'starting edge fee'],
  ['Human approved', 'AI recommendations'],
  ['Stored proof', 'Walrus + Sui audit'],
];

const partnerRail: Array<{ src: string; name: string; role: string; logoClass?: string }> = [
  { src: '/stripe-logo.svg', name: 'Stripe', role: 'USD collection' },
  { src: '/partners/airwallex.png', name: 'Airwallex', role: 'bank rails', logoClass: 'iso-airwallex-logo' },
  { src: '/partners/pyth.png', name: 'Pyth', role: 'FX and peg data' },
  { src: '/deepbook-mark.png', name: 'DeepBook', role: 'amount-sized liquidity', logoClass: 'iso-deepbook-logo' },
  { src: '/sumsub-logo.png', name: 'Sumsub', role: 'KYB and KYC' },
  { src: '/isometric/walrus-logo.png', name: 'Walrus', role: 'permanent records' },
  { src: '/sui-logo-blue.svg', name: 'Sui', role: 'settlement network' },
];

/** Partner badge: logo only at rest. Hover (or focus) dims the logo and
    reveals the centred name + role. Click still balloon-pops the logo. */
function PartnerBadge({ src, name, role, logoClass }: (typeof partnerRail)[number]) {
  const [popping, setPopping] = useState(false);
  return (
    <button
      type="button"
      className="iso-partner-item cin-partner"
      onClick={() => setPopping(true)}
      aria-label={`${name} — ${role}`}
    >
      <span
        className={`cin-partner-logo ${popping ? 'is-popping' : ''}`}
        onAnimationEnd={(event) => {
          if (event.animationName === 'cin-balloon') setPopping(false);
        }}
      >
        <Image src={src} alt={`${name} logo`} width={240} height={140} className={logoClass} />
      </span>
      <span className="cin-partner-reveal" aria-hidden="true">
        <strong>{name}</strong>
        <small>{role}</small>
      </span>
    </button>
  );
}

const comparisonRows = [
  {
    feature: 'Settlement speed',
    bank: '2-5 days',
    broker: '1-3 days',
    wise: '1-2 days',
    splash: lockedCopy.speed,
  },
  {
    feature: 'Starting fee',
    bank: '3-5%',
    broker: '2-4%',
    wise: '0.5-1.5%',
    splash: lockedCopy.fee,
  },
  {
    feature: 'FX transparency',
    bank: 'Hidden markup',
    broker: 'Cash spread',
    wise: 'Mid-market',
    splash: 'Oracle-labeled quote',
  },
  {
    feature: 'Atomic settlement',
    bank: 'No',
    broker: 'No',
    wise: 'No',
    splash: 'Yes',
  },
  {
    feature: 'Batch payments',
    bank: 'Limited',
    broker: 'No',
    wise: 'Limited',
    splash: 'Native',
  },
  {
    feature: 'AI treasury copilot',
    bank: 'No',
    broker: 'No',
    wise: 'No',
    splash: lockedCopy.agent,
  },
  {
    feature: 'Early payment on invoices',
    bank: 'Manual factoring',
    broker: 'No',
    wise: 'No',
    splash: 'Buyer-approved discount offer',
  },
  {
    feature: 'Bilateral netting',
    bank: 'Manual',
    broker: 'No',
    wise: 'No',
    splash: 'Modeled in account loop',
  },
  {
    feature: 'Permanent audit trail',
    bank: 'Siloed records',
    broker: 'Manual receipts',
    wise: 'Platform history',
    splash: 'Encrypted Walrus + Sui',
  },
  {
    feature: 'Recipient account ladder',
    bank: 'Bank account only',
    broker: 'Cash-out only',
    wise: 'Wise account',
    splash: 'Payout, sweep, stored balance',
  },
];

type YieldBenchmarks = {
  bank: number;
  broker: number;
  wise: number;
  splash: number;
  asOf: string;
};

const fallbackYieldBenchmarks: YieldBenchmarks = {
  bank: 0.38,
  broker: 3.12,
  wise: 3.14,
  splash: 0,
  asOf: '',
};

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
    copy: 'Extract upcoming obligations from invoices while the original file remains encrypted on Walrus.',
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
    status: 'Phase 1 launch',
    copy: 'Let recipients sweep value into a Splash account and recruit the next counterparty.',
  },
  {
    number: '03',
    title: 'Stored balance',
    status: 'Corridor gated',
    copy: 'Keep value inside the network where regulation and partner controls permit it.',
  },
];

/* Trust · Four gates — the control sequence every payout passes, in order.
   Copy stays inside content/claims.ts truth: Sumsub KYB wired, human-final
   approval, atomic Sui settlement, Seal/Walrus/Sui evidence anchoring. */
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
    copy: '0xWal prepares. You approve. No payout, batch, or treasury move executes without a human signature.',
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
    copy: 'Receipts and Seal-encrypted documents anchor to Walrus and Sui — an audit spine you can hand to an auditor.',
    meta: 'Seal + Walrus + Sui',
  },
];

const headerNavItems = [
  { href: '#how-it-works', label: 'How it works', detail: '5 steps' },
  { href: '#platform', label: 'Platform', detail: 'Pay + treasury' },
  { href: '#supply', label: 'Working capital', detail: 'Supply loop' },
  { href: '#corridors', label: 'Routes', detail: 'MY-PH testnet' },
  { href: '#comparison', label: 'Compare', detail: 'Fees + speed' },
  { href: '#copilot', label: '0xWal', detail: 'Prepare + approve' },
];

const supplySteps = [
  {
    number: '01',
    label: 'Receivable',
    title: 'A buyer-accepted invoice.',
    copy: 'Issued between two KYB-verified businesses and anchored to the same audit spine as every payout — an invoice that carries its own settlement history.',
    image: '/isometric/supply-receivable.png',
    imageAlt: 'Isometric receivable: an invoice with docked quote, approval, and receipt proofs',
    meta: 'Verified counterparties',
  },
  {
    number: '02',
    label: 'Early offer',
    title: 'Buyer funds early payment.',
    copy: 'Your buyer offers to pay the 90-day invoice now. You choose per invoice: the full amount on the due date, or a small discount today.',
    image: '/isometric/supply-early-offer.png',
    imageAlt: 'Isometric early offer: a buyer offering early payment at a discount',
    meta: 'Buyer-funded · no third-party lender',
  },
  {
    number: '03',
    label: 'Settlement',
    title: 'Same rail, same proof.',
    copy: 'The early payment would settle over Splash like any payout — approval-gated, with Seal-encrypted evidence anchored on Walrus and Sui.',
    image: '/isometric/supply-settlement-v3.png',
    imageAlt: 'Isometric settlement: a payment-intent coin passing an approval gate into a sealed-proof vault anchored on Walrus and Sui',
    meta: 'Approval-gated · audit-anchored',
  },
];

const loopCards = [
  {
    number: '01',
    label: 'Settle',
    title: 'Move it in minutes.',
    copy: 'Collect USD, pay Southeast Asia. Every approved payout builds verified counterparties and settlement history.',
    image: '/isometric/loop-settle-v3.png',
    imageAlt: 'Isometric settlement: a USD coin crossing an approved rail in minutes to arrive as a PHP coin',
    meta: 'USD → PHP · live on testnet',
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

export default function IsometricLanding({ isPhone = false }: { isPhone?: boolean }) {
  const [activeFlow, setActiveFlow] = useState(flowSteps[0]);
  const [yieldBenchmarks, setYieldBenchmarks] = useState(fallbackYieldBenchmarks);
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
      '.iso-section > .iso-shell, .iso-partner-rail > .iso-shell',
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
    ...comparisonRows,
    {
      feature: 'Yield on idle USD',
      bank: `${formatPercent(yieldBenchmarks.bank)} APY`,
      broker: `${formatPercent(yieldBenchmarks.broker)} APY`,
      wise: `${formatPercent(yieldBenchmarks.wise)} APY`,
      splash: `${formatPercent(yieldBenchmarks.splash)} projected variable APY`,
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
            <span className="iso-header-status">
              <small>Sandbox</small>
              <strong>MY-PH testnet</strong>
            </span>
            <Link href="/signup" className="iso-button iso-button-small">
              Start sending
              <ArrowDownRight aria-hidden="true" />
            </Link>
          </div>
        </div>
      </header>

      <SettlementCinematic isPhone={isPhone} />

      <div className="iso-marquee is-static" aria-label="Platform metrics">
        <div className="iso-marquee-track">
          {[...marqueeItems, ...marqueeItems].map(([value, label], index) => (
            <div className="iso-marquee-item" key={`${value}-${index}`}>
              <strong>{value}</strong>
              <span>{label}</span>
              <i aria-hidden="true">◆</i>
            </div>
          ))}
        </div>
      </div>

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

      <section className="iso-partner-rail" aria-label="Infrastructure partners and benchmarks">
        <div className="iso-shell">
          <div className="iso-partner-intro">
            <span>Infrastructure &amp; Partners</span>
            <p>Licensed-partner rails outside. Sui-native settlement inside.</p>
          </div>
          <div className="iso-partner-grid">
            {partnerRail.map((partner) => (
              <PartnerBadge key={partner.name} {...partner} />
            ))}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="iso-section iso-flow">
        <div className="cin-drop" style={{ top: 34, right: '5%' }} aria-hidden="true">
          <FloatingToken src="/cinematic/token-sgd.png" alt="Singapore dollar token" size={112} float="cin-float-drift" />
        </div>
        <div className="iso-shell iso-flow-layout">
          <div className="iso-flow-copy">
            <p className="iso-kicker">How it works</p>
            <h2 className="iso-section-title iso-section-title-light">
              Five steps.
              <span>No limbo.</span>
            </h2>
            <div className="iso-flow-tabs" role="tablist" aria-label="Settlement flow">
              {flowSteps.map((step) => {
                const active = activeFlow.id === step.id;
                return (
                  <button
                    key={step.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={active ? 'is-active' : ''}
                    onClick={() => setActiveFlow(step)}
                  >
                    <span>{step.number}</span>
                    <strong>{step.title}</strong>
                    <ChevronRight aria-hidden="true" />
                  </button>
                );
              })}
            </div>
            <div className="iso-flow-branch">
              <strong>Working-capital branch</strong>
              <span>Accepted invoice to supplier discount offer to buyer approval to settlement proof.</span>
            </div>
          </div>

          <div className="iso-flow-visual" role="tabpanel" aria-live="polite">
            <div className="iso-flow-stat">
              <small>Current checkpoint</small>
              <strong>{activeFlow.stat}</strong>
            </div>
            <div className="iso-flow-image">
              <Image
                key={activeFlow.id}
                src={activeFlow.image}
                alt={activeFlow.imageAlt}
                width={1448}
                height={1086}
                priority={activeFlow.id === 'settle'}
              />
            </div>
            <div className="iso-flow-caption">
              <span>{activeFlow.number}</span>
              <div>
                <strong>{activeFlow.title}</strong>
                <p>{activeFlow.description}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="corridors" className="iso-section iso-corridors">
        <div className="cin-drop" style={{ bottom: 40, right: '6%' }} aria-hidden="true">
          <FloatingToken src="/cinematic/token-php.png" alt="Philippine peso token" size={120} />
        </div>
        <div className="iso-shell iso-corridor-layout">
          <div className="iso-corridor-copy">
            <p className="iso-kicker">One testnet corridor. Modeled expansion routes.</p>
            <h2 className="iso-section-title">
              USD in.
              <span>Local out.</span>
            </h2>
            <p>
              The MY-to-PH corridor is the proving ground. Additional routes stay modeled until partner, liquidity,
              and regulatory controls are ready market by market.
            </p>
            <div className="iso-route-list">
              <span className="is-live">PHP testnet</span><span>MYR</span><span>IDR</span><span>VND</span>
              <span>THB</span><span>SGD</span><span>EUR</span><span>GBP</span>
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

          <div className="iso-comparison-wrap">
            <table className="iso-comparison-table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>Bank</th>
                  <th>Broker</th>
                  <th>Wise</th>
                  <th className="is-splash">Splash</th>
                </tr>
              </thead>
              <tbody>
                {liveComparisonRows.map((row) => (
                  <tr key={row.feature}>
                    <th scope="row">{row.feature}</th>
                    <td>{row.bank}</td>
                    <td>{row.broker}</td>
                    <td>{row.wise}</td>
                    <td className="is-splash"><span className="iso-splash-cell"><Check aria-hidden="true" /> {row.splash}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="iso-yield-live is-demoted">
              <i aria-hidden="true" />
              <strong>Reference yield benchmark</strong>
              <span>
                FDIC national savings - IBKR Pro cash - Wise USD Interest - Splash treasury projection
                {yieldBenchmarks.asOf ? ` - refreshed ${new Date(yieldBenchmarks.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
                {' '}· Yield is hygiene, not the headline — the working-capital loop is.
              </span>
            </div>
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
            Sandbox environment · Labuan FSA licence application in progress · No real money moves
          </p>
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
              receivables, and treasury actions stay sandboxed until licensed rails are active.
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
                  <Image src={layer.image} alt={layer.imageAlt} width={1448} height={1086} />
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

      <section id="supply" className="iso-section iso-supply">
        <div className="cin-drop" style={{ top: 32, right: '4%' }} aria-hidden="true">
          <FloatingToken src="/cinematic/token-php.png" alt="Philippine peso token" size={106} float="cin-float-drift" />
        </div>
        <div className="iso-shell">
          <div className="iso-section-heading iso-heading-split">
            <div>
              <p className="iso-kicker">Supply · The moat</p>
              <h2 className="iso-section-title">
                Your invoices are
                <span>working capital.</span>
              </h2>
              <div className="iso-supply-chip"><RoadmapChip detail="coming capability, subject to licensing" /></div>
            </div>
            <p>
              A Receivable would be an invoice that remembers how it gets paid — quotes, approvals,
              receipts, proof. History a lender would charge you to underwrite, your buyer can
              simply read.
            </p>
          </div>

          <div className="iso-supply-grid">
            {supplySteps.map((step, index) => (
              <article className={`iso-supply-card iso-supply-card-${index + 1}`} key={step.number}>
                <div className="iso-supply-meta">
                  <span>{step.number}</span>
                  <p>{step.label}</p>
                </div>
                <div className="iso-supply-art">
                  <Image src={step.image} alt={step.imageAlt} width={640} height={480} />
                </div>
                <div className="iso-supply-copy">
                  <h3>{step.title}</h3>
                  <p>{step.copy}</p>
                  <small>{step.meta}</small>
                </div>
              </article>
            ))}
          </div>

          <div className="iso-supply-cta">
            <div className="iso-supply-cta-copy">
              <p className="iso-kicker">See the full Supply story</p>
              <h3>How a Receivable becomes working capital.</h3>
              <p>
                The whole loop — verified invoice, buyer-funded early offer, settlement with no
                third-party lender — laid out end to end.
              </p>
              <p className="iso-supply-cta-legal">
                Dynamic discounting is a coming capability, subject to licensing. Registering interest
                does not create a financing commitment — it tells us which corridors to build first.
              </p>
            </div>
            <div className="iso-supply-cta-actions">
              <Link href="/working-capital" className="iso-button">
                Explore working capital
                <ArrowRight aria-hidden="true" />
              </Link>
              <Link href="/signup?interest=financing" className="iso-button iso-button-ghost iso-button-small">
                Register financing interest
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section id="copilot" className="iso-section iso-copilot">
        <div className="iso-shell iso-copilot-layout">
          <div className="iso-copilot-stage">
            <Image
              src="/cinematic/copilot-desk.png"
              alt="0xWal, an isometric robot assistant at a desk, presenting suggestion cards"
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

        <div className="iso-shell iso-ctrl-shell">
          <div className="iso-section-heading iso-heading-split">
            <div>
              <p className="iso-kicker">The control plane</p>
              <h2 className="iso-section-title">
                Shipped, not
                <span>promised.</span>
              </h2>
            </div>
            <p>
              Every 0xWal recommendation runs this exact pipeline before money can move. The phase
              names below are the engine&apos;s own state machine — inspect them in the Action Queue.
            </p>
          </div>
          <ControlPlaneExplainer />
        </div>
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
                Start sending
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
              <span><i aria-hidden="true" /> Sandbox · MY-PH testnet</span>
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
            <a href="#copilot">0xWal control plane</a>
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
            <span>© 2026 Splash Financial Labuan Ltd.</span>
            <span className="cin-footer-tick">
              USD → PHP · {lockedCopy.speed} · {lockedCopy.fee} · zero-fee USD rail on Sui, gas-sponsored settlement — you never hold SUI
            </span>
          </div>
        </div>
      </footer>
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
