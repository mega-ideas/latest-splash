'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUp,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleCheckBig,
  Database,
  FileCheck2,
  Gauge,
  KeyRound,
  Layers3,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Workflow,
  X,
} from 'lucide-react';

import { claims, lockedCopy } from '@/content/claims';

const operatingLayers = [
  {
    number: '01',
    label: 'Liquidity',
    title: 'Keep USD productive.',
    copy: 'Keep payout inventory ready while treasury projections model how excess USD could remain productive.',
    image: '/isometric/liquidity-pools.svg',
    imageAlt: 'Isometric stablecoin liquidity pools',
    meta: 'Available cash - projected treasury',
  },
  {
    number: '02',
    label: 'Settlement',
    title: 'Funds cannot get stuck.',
    copy: 'Every payment intent settles or reverts atomically in one programmable Sui transaction.',
    image: '/isometric/transfer.svg',
    imageAlt: 'Transparent isometric payment settlement receipt',
    meta: lockedCopy.speed,
  },
  {
    number: '03',
    label: 'Treasury',
    title: 'Make cash work harder.',
    copy: '0xWal recommends a treasury posture. Your business approves every action; execution remains gated.',
    image: '/isometric/treasury.svg',
    imageAlt: 'Isometric smart treasury card',
    meta: 'Simulation - human approval',
  },
];

const flowSteps = [
  {
    id: 'intake',
    number: '01',
    title: 'Collect or upload',
    description: 'Create a pay link, upload an accepted invoice, or fund USD into the operating account.',
    image: '/isometric/USD.svg',
    imageAlt: 'USD and stablecoin isometric illustration',
    stat: 'Pay link or invoice',
  },
  {
    id: 'review',
    number: '02',
    title: 'Review controls',
    description: 'KYB, recipient status, route, fee, treasury floor, and evidence labels appear before signature.',
    image: '/isometric/checklist-icon.svg',
    imageAlt: 'Isometric operating checklist',
    stat: 'Human approval',
  },
  {
    id: 'settle',
    number: '03',
    title: 'Settle in one signature',
    description: 'The prepared payment either completes as approved or stops safely before funds move.',
    image: '/isometric/payment-intent.svg',
    imageAlt: 'Isometric Sui payment intent',
    stat: lockedCopy.speed,
  },
  {
    id: 'deliver',
    number: '04',
    title: 'Deliver locally',
    description: 'Pay a verified supplier or sweep value into the recipient ladder where the corridor allows it.',
    image: '/isometric/payments.svg',
    imageAlt: 'Isometric cross-border payment receipt',
    stat: lockedCopy.fee,
  },
  {
    id: 'proof',
    number: '05',
    title: 'Anchor the proof',
    description: 'Receipts, encrypted documents, and daily audit evidence remain available for review.',
    image: '/isometric/walrus-logo.svg',
    imageAlt: 'Walrus storage proof illustration',
    stat: 'Walrus + Sui audit',
  },
];

const marqueeItems = [
  ['1 live testnet', 'MY to PH corridor'],
  ['Modeled routes', 'expand with controls'],
  ['~400ms', 'Sui settlement finality'],
  ['From 0.80%', 'starting edge fee'],
  ['Human approved', 'AI recommendations'],
  ['Stored proof', 'Walrus + Sui audit'],
];

const clientProofPoints = [
  {
    icon: Gauge,
    title: 'Fast transfers',
    copy: 'Go from recipient to quote to approval in one guided flow, with Sui settlement finality measured in milliseconds.',
  },
  {
    icon: ShieldCheck,
    title: 'Safe authorization',
    copy: 'Every payout keeps source selection, risk checks, rate holds, and human approval visible before money moves.',
  },
  {
    icon: FileCheck2,
    title: 'Audit-ready records',
    copy: 'Invoices, receipts, payment intents, and settlement proof stay connected so audit prep is already organized.',
  },
];

const partnerRail: Array<{ src: string; name: string; role: string; logoClass?: string }> = [
  { src: '/stripe-logo.svg', name: 'Stripe', role: 'USD collection' },
  { src: '/airwallex-mark.svg', name: 'Airwallex', role: 'bank rails', logoClass: 'iso-airwallex-logo' },
  { src: '/pyth-logo.png', name: 'Pyth', role: 'FX and peg data' },
  { src: '/deepbook-mark.png', name: 'DeepBook', role: 'amount-sized liquidity', logoClass: 'iso-deepbook-logo' },
  { src: '/sumsub-logo.png', name: 'Sumsub', role: 'KYB and KYC' },
  { src: '/walrus-logo.svg', name: 'Walrus', role: 'permanent records' },
  { src: '/sui-logo-blue.svg', name: 'Sui', role: 'settlement network' },
];

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

const walrusProofs = [
  {
    icon: KeyRound,
    title: 'Seal-ready ownership',
    copy: 'Invoice files are access-controlled before permanent storage.',
    meta: 'Only approved keys can decrypt',
  },
  {
    icon: Database,
    title: 'Daily audit batches',
    copy: 'Settlement events are collected into a tamper-evident Merkle batch every day.',
    meta: 'Seven-year retention',
  },
  {
    icon: ShieldCheck,
    title: 'Anchored on Sui',
    copy: 'Every Walrus batch is connected to an immutable on-chain AuditAnchor.',
    meta: 'Regulator-verifiable',
  },
];

const walrusSlides = [
  {
    image: '/isometric/walrus-receipt-v2.png',
    label: '01 / Walrus receipt',
    tab: 'Audit',
    title: 'Permanent audit proof',
    copy: 'A normal payment receipt becomes immutable, independently verified, and auditable on Walrus.',
    facts: ['On-chain receipt', 'Daily audit batch', 'Regulator-verifiable'],
  },
  {
    image: '/isometric/memwal-agent-v2.png',
    label: '02 / MemWal',
    tab: 'AI',
    title: 'The AI copilot remembers',
    copy: 'An agent remembers safe behavior patterns, keeps useful memory, and suggests the next best action.',
    facts: ['Behavior memory', 'Proactive suggestions', 'Human approval stays final'],
  },
  {
    image: '/isometric/seal-vaults-sui-v3.png',
    label: '03 / Seal',
    tab: 'Ownership',
    title: 'Encrypted ownership',
    copy: 'Large sealed vaults protect owned data while permissioned verification keeps every audit possible.',
    facts: ['Identity-based encryption', 'Owner-held access', 'Auditor access by permission'],
  },
];

const readinessGates = [
  {
    icon: CircleCheckBig,
    title: 'Payout proof',
    copy: 'The MY-to-PH testnet path proves quote, intent, settlement, receipt, and audit evidence as one flow.',
  },
  {
    icon: ShieldCheck,
    title: 'Sweep-account launch',
    copy: 'Phase 1 adds pay, get paid, sweep, and keep with corridor-by-corridor regulatory controls.',
  },
  {
    icon: TrendingUp,
    title: 'Closed-loop proof',
    copy: 'Scale follows netting ratio, counterparty pull, repeat volume, and reliable external delivery.',
  },
];

const scaleMetrics = [
  ['Netting ratio', 'Value kept inside the loop'],
  ['Counterparty pull', 'Pay links that recruit accounts'],
  ['Treasury opt-in', 'Approved use of treasury tools'],
  ['Discount capture', 'Invoice savings realized'],
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

const phaseOneTools = [
  {
    icon: Workflow,
    number: '01',
    title: 'Batch payouts',
    copy: 'Authorize a full payout run once, then follow every recipient from quote to receipt.',
    href: '/dashboard/batch',
    image: '/isometric/op-batch.svg',
    imageAlt: 'Isometric batch payout illustration',
    metric: '128 recipients',
    result: 'One approval, every payout traced',
    facts: ['Pre-screen recipients', 'Label 24-72h rate holds', 'Track every receipt'],
  },
  {
    icon: ReceiptText,
    number: '02',
    title: 'Invoice desk',
    copy: 'Turn invoices and pay links into structured payment instructions that recruit the next counterparty.',
    href: '/dashboard/invoices',
    image: '/isometric/op-invoice.svg',
    imageAlt: 'Isometric encrypted invoice illustration',
    metric: 'Pay link to intent',
    result: 'Get paid, then keep value in the loop',
    facts: ['Extract payment fields', 'Invite counterparties', 'Approve before settlement'],
  },
  {
    icon: FileCheck2,
    number: '03',
    title: 'Reconciliation & proof',
    copy: 'Auto-match payment activity to accounting systems while private artifacts stay encrypted and verifiable.',
    href: '/settings/kyb',
    image: '/isometric/op-compliance.svg',
    imageAlt: 'Isometric compliance archive illustration',
    metric: 'Books to proof',
    result: 'Reconciled without exposing private data',
    facts: ['Xero + QuickBooks ready', 'Keep KYB off Walrus', 'Anchor daily audit batches'],
  },
  {
    icon: Layers3,
    number: '04',
    title: 'Treasury controls',
    copy: 'Model available USD, corridor inventory, and projected productive liquidity from one operating view.',
    href: '/dashboard/treasury',
    image: '/isometric/op-treasury.svg',
    imageAlt: 'Isometric treasury controls illustration',
    metric: 'Projected USDY rate',
    result: 'Approval-gated treasury simulation',
    facts: ['Watch corridor inventory', 'Separate available cash', 'Approve every action'],
  },
  {
    icon: TrendingUp,
    number: '05',
    title: 'Early Pay',
    copy: 'Let suppliers offer a discount on buyer-accepted invoices, then prepare settlement for approval.',
    href: '/dashboard/invoices',
    image: '/isometric/op-invoice.svg',
    imageAlt: 'Isometric early payment invoice illustration',
    metric: 'Supplier offer',
    result: 'Buyer approval stays final',
    facts: ['Buyer-signed invoice', 'Supplier sets discount', '0xWal prepares only'],
  },
];

export default function IsometricLanding() {
  const [activeFlow, setActiveFlow] = useState(flowSteps[0]);
  const [activeWalrus, setActiveWalrus] = useState(0);
  const [yieldBenchmarks, setYieldBenchmarks] = useState(fallbackYieldBenchmarks);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [arrowLaunching, setArrowLaunching] = useState(false);
  const [arrowGone, setArrowGone] = useState(false);
  const [activeTool, setActiveTool] = useState<(typeof phaseOneTools)[number] | null>(null);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setActiveWalrus((current) => (current + 1) % walrusSlides.length);
    }, 6500);
    return () => window.clearInterval(interval);
  }, []);

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
    const hero = document.querySelector('#hero');
    if (!hero) return;

    const observer = new IntersectionObserver(([entry]) => {
      setShowBackToTop(!entry.isIntersecting);
    }, { threshold: 0.12 });
    observer.observe(hero);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!activeTool) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setActiveTool(null);
    }

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [activeTool]);

  function launchArrow() {
    if (arrowLaunching || arrowGone) return;
    setArrowLaunching(true);
    window.setTimeout(() => {
      document.querySelector('#walrus')?.scrollIntoView({ behavior: 'smooth' });
    }, 620);
    window.setTimeout(() => {
      setArrowGone(true);
      setArrowLaunching(false);
    }, 1050);
  }

  const walrusSlide = walrusSlides[activeWalrus];
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
    <main className="iso-landing">
      <header className={`iso-header ${showBackToTop ? 'is-scrolled' : ''}`}>
        <div className="iso-shell iso-header-inner">
          <Link href="/" className="iso-brand" aria-label="Splash Finance home">
            <Image src="/splash-main-icon.png" alt="" width={48} height={47} className="iso-header-brand-icon" priority />
            <span className="iso-header-wordmark">
              <strong>Splash</strong>
              <small>Account network for cross-border money</small>
            </span>
          </Link>

          <nav className="iso-nav" aria-label="Primary navigation">
            <a href="#operating-layer">Platform</a>
            <a href="#comparison">Compare</a>
            <a href="#how-it-works">How it works</a>
            <a href="#walrus">Walrus</a>
            <a href="#corridors">Corridors</a>
            <a href="#readiness">Readiness</a>
          </nav>

          <div className="iso-header-actions">
            <Link href="/signup" className="iso-button iso-button-small">
              Start sending
              <ArrowDownRight aria-hidden="true" />
            </Link>
          </div>
        </div>
      </header>

      <section id="hero" className="iso-hero">
        <div className="iso-grid-plane" aria-hidden="true" />
        <div className="iso-orb iso-orb-a" aria-hidden="true" />
        <div className="iso-orb iso-orb-b" aria-hidden="true" />

        <div className="iso-shell iso-hero-layout">
          <div className="iso-hero-copy">
            <p className="iso-kicker">Splash</p>
            <h1 className="iso-display">
              MOVE MONEY.
              <span>Faster &amp; Wiser.</span>
            </h1>
            <p className="iso-hero-description">
              A compliance-gated B2B account network for cross-border money: pay, get paid, sweep, and keep value
              with human-approved AI, access-controlled records, and Sui settlement.
            </p>

            <div className="iso-hero-actions">
              <Link href="/signup" className="iso-button">
                Open payment desk
                <ArrowRight aria-hidden="true" />
              </Link>
              <a href="#how-it-works" className="iso-button iso-button-ghost">
                See the money move
              </a>
            </div>

            <div className="iso-proof-line">
              <span><Check aria-hidden="true" /> Compliance-gated</span>
              <span><Check aria-hidden="true" /> Verifiable</span>
            </div>
          </div>

          <div className="iso-hero-stage" aria-label="Splash Finance isometric settlement network">
            <div className="iso-stage-shadow" aria-hidden="true" />
            <Image
              src="/isometric/hero-bg.svg"
              alt="Isometric Southeast Asia payment and treasury network"
              width={2172}
              height={1629}
              priority
              className="iso-hero-main-art"
            />
            <div className="iso-floating-note iso-floating-note-a">
              <span>TESTNET</span>
              <strong>USD to PHP</strong>
              <small>{lockedCopy.speed}</small>
            </div>
            <div className="iso-floating-note iso-floating-note-b">
              <span>MODELED</span>
              <strong>USD to MYR</strong>
              <small>partner activation required</small>
            </div>
            <div className="iso-floating-note iso-floating-note-c">
              <span>TREASURY</span>
              <strong>USDY</strong>
              <small>variable APY, approval gated</small>
            </div>
          </div>
        </div>

        <div className="iso-marquee" aria-label="Platform metrics">
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
      </section>

      <section className="iso-partner-rail" aria-label="Infrastructure partners and benchmarks">
        <div className="iso-shell">
          <div className="iso-partner-intro">
            <span>Infrastructure &amp; Partners</span>
            <p>Licensed-partner rails outside. Sui-native settlement inside.</p>
          </div>
          <div className="iso-partner-grid">
            {partnerRail.map((partner) => (
              <div className="iso-partner-item" key={partner.name}>
                <Image
                  src={partner.src}
                  alt={`${partner.name} logo`}
                  width={120}
                  height={80}
                  className={partner.logoClass}
                />
                <span>
                  <strong>{partner.name}</strong>
                  <small>{partner.role}</small>
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="comparison" className="iso-section iso-comparison">
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
                    <td className="is-splash"><Check aria-hidden="true" /> {row.splash}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="iso-yield-live">
              <i aria-hidden="true" />
              <strong>Reference yield benchmark</strong>
              <span>
                FDIC national savings - IBKR Pro cash - Wise USD Interest - Splash treasury projection
                {yieldBenchmarks.asOf ? ` - refreshed ${new Date(yieldBenchmarks.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section id="operating-layer" className="iso-section iso-operating">
        <div className="iso-shell">
          <div className="iso-section-heading iso-heading-split">
            <div>
              <p className="iso-kicker">One operating layer</p>
              <h2 className="iso-section-title">
                Finance, with
                <span>depth.</span>
              </h2>
            </div>
            <p>
              Splash turns settlement primitives into clear operating tools. Funding, payout, receivables,
              and treasury actions stay approval-gated and sandboxed until licensed rails are active.
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

      <section id="how-it-works" className="iso-section iso-flow">
        <div className="iso-shell iso-flow-layout">
          <div className="iso-flow-copy">
            <p className="iso-kicker">How it works</p>
            <h2 className="iso-section-title iso-section-title-light">
              Five steps.
              <span>No limbo.</span>
            </h2>
            <p className="iso-flow-intro">
              Follow value from invoice or USD intake, through controls, settlement, local delivery, and proof.
            </p>

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
            <div className={`iso-flow-image ${activeFlow.id === 'intake' ? 'iso-flow-image-white iso-flow-image-fund' : ''}`}>
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

      <section id="copilot" className="iso-section iso-copilot">
        <div className="iso-shell iso-copilot-layout">
          <div className="iso-copilot-stage">
            <Image
              src="/isometric/walrus-logo.svg"
              alt="Walrus isometric logo"
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
          {!arrowGone && (
            <button
              type="button"
              onClick={launchArrow}
              className={`iso-copilot-next ${arrowLaunching ? 'is-launching' : ''}`}
              aria-label="Continue to permanent records on Walrus"
            >
              <Image src="/isometric/arrow-coin.svg" alt="" width={180} height={180} />
              <span>More below</span>
            </button>
          )}
        </div>
      </section>

      <section id="walrus" className="iso-section iso-walrus">
        <div className="iso-shell iso-walrus-layout">
          <div className="iso-walrus-copy">
            <div className="iso-walrus-brand">
              <Image src="/isometric/walrus-logo.svg" alt="Walrus" width={48} height={48} />
              <span>Permanent records on Walrus</span>
            </div>
            <h2 className="iso-section-title iso-section-title-light">
              Proof that outlives
              <span>the payment.</span>
            </h2>
            <p>
              Splash stores encrypted invoices and daily settlement proofs on Walrus, then anchors every batch on Sui.
              Your records remain durable, private, and independently verifiable.
            </p>

            <div className="iso-walrus-proof-list">
              {walrusProofs.map(({ icon: Icon, title, copy, meta }) => (
                <article key={title}>
                  <div className="iso-walrus-proof-icon"><Icon aria-hidden="true" /></div>
                  <div>
                    <h3>{title}</h3>
                    <p>{copy}</p>
                    <small>{meta}</small>
                  </div>
                </article>
              ))}
            </div>
          </div>

          <div className="iso-walrus-carousel" aria-label="Walrus, MemWal, and Seal showcase">
            <div className="iso-walrus-slide-art">
              <Image
                key={walrusSlide.image}
                src={walrusSlide.image}
                alt={`${walrusSlide.title} isometric typography illustration`}
                width={1536}
                height={1024}
                priority={activeWalrus === 0}
              />
            </div>
            <div className="iso-walrus-slide-copy" aria-live="polite">
              <span>{walrusSlide.label}</span>
              <h3>{walrusSlide.title}</h3>
              <p>{walrusSlide.copy}</p>
              <div>
                {walrusSlide.facts.map((fact) => (
                  <small key={fact}><Check aria-hidden="true" /> {fact}</small>
                ))}
              </div>
            </div>
            <div className="iso-walrus-controls" role="tablist" aria-label="Select Walrus showcase slide">
              {walrusSlides.map((slide, index) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeWalrus === index}
                  aria-label={slide.title}
                  className={activeWalrus === index ? 'is-active' : ''}
                  onClick={() => setActiveWalrus(index)}
                  key={slide.title}
                >
                  <span>0{index + 1}</span>
                  {slide.tab}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="corridors" className="iso-section iso-corridors">
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
            <div className="iso-corridor-number" aria-hidden="true">01</div>
            <Image
              src="/isometric/corridors.svg"
              alt="Isometric platform showing modeled corridor expansion"
              width={1448}
              height={1086}
            />
          </div>
        </div>
      </section>

      <section id="readiness" className="iso-section iso-readiness">
        <div className="iso-shell iso-readiness-layout">
          <div className="iso-readiness-copy">
            <p className="iso-kicker">Scale</p>
            <h2 className="iso-section-title">
              Proof becomes
              <span>repeatable.</span>
            </h2>
            <p>
              Scale is earned, not announced. These are the gates that turn a payout prototype into a repeatable
              closed-loop account network.
            </p>
            <div className="iso-readiness-list">
              {readinessGates.map(({ icon: Icon, title, copy }) => (
                <article key={title}>
                  <Icon aria-hidden="true" />
                  <span>
                    <strong>{title}</strong>
                    <small>{copy}</small>
                  </span>
                </article>
              ))}
            </div>
            <div className="iso-scale-metrics" aria-label="Scale proof metrics">
              {scaleMetrics.map(([metric, definition]) => (
                <span key={metric}>
                  <strong>{metric}</strong>
                  <small>{definition}</small>
                </span>
              ))}
            </div>
          </div>
          <div className="iso-readiness-stage">
            <Image src="/isometric/splash-hero.svg" alt="Splash isometric global settlement engine" width={2172} height={1629} />
            <div className="iso-readiness-card">
              <Sparkles aria-hidden="true" />
              <span>
                <small>Scale unlock</small>
                <strong>Pay + get paid + sweep + keep</strong>
                <p>After corridor controls, reliability, netting, counterparty pull, and retention are repeatable.</p>
              </span>
            </div>
          </div>
        </div>
      </section>

      <section id="operations" className="iso-section iso-products">
        <div className="iso-shell">
          <div className="iso-section-heading iso-heading-split">
            <div>
              <p className="iso-kicker">Operating Desk</p>
              <h2 className="iso-section-title">
                More than
                <span>a transfer.</span>
              </h2>
            </div>
            <p>
              The operating desk connects payout, receivables, reconciliation, access-controlled records, and approval-led
              recommendations so finance teams can run the full loop.
            </p>
          </div>

          <div className="iso-product-rail">
            {phaseOneTools.map((tool) => {
              const Icon = tool.icon;
              const active = activeTool?.number === tool.number;
              return (
                <button
                  type="button"
                  className={`iso-product-row ${active ? 'is-active' : ''}`}
                  aria-expanded={active}
                  onClick={() => setActiveTool(tool)}
                  key={tool.number}
                >
                  <span className="iso-product-number">{tool.number}</span>
                  <span className="iso-product-icon"><Icon aria-hidden="true" /></span>
                  <span className="iso-product-copy">
                    <strong>{tool.title}</strong>
                    <small>{tool.copy}</small>
                  </span>
                  <ChevronRight className="iso-product-chevron" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {activeTool && (
        <div className="iso-tool-modal" role="presentation" onClick={() => setActiveTool(null)}>
          <article
            role="dialog"
            aria-modal="true"
            aria-labelledby="iso-tool-modal-title"
            className="iso-tool-modal-panel"
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" className="iso-tool-modal-close" onClick={() => setActiveTool(null)} aria-label="Close tool preview">
              <X aria-hidden="true" />
            </button>
            <div className="iso-tool-modal-art">
              <div className="iso-tool-modal-wordmark" aria-hidden="true">
                <span>{activeTool.number}</span>
                <strong>{activeTool.title}</strong>
              </div>
              <Image src={activeTool.image} alt={activeTool.imageAlt} width={1448} height={1086} />
              <div className="iso-tool-modal-metric">
                <span>{activeTool.number}</span>
                <strong>{activeTool.metric}</strong>
                <small>{activeTool.result}</small>
              </div>
            </div>
            <div className="iso-tool-modal-copy">
              <span>Operating Desk / {activeTool.number}</span>
              <h3 id="iso-tool-modal-title">{activeTool.title}</h3>
              <p>{activeTool.copy}</p>
              <div className="iso-tool-modal-facts">
                {activeTool.facts.map((fact) => <small key={fact}><Check aria-hidden="true" /> {fact}</small>)}
              </div>
              <Link href={activeTool.href} className="iso-button">
                Open {activeTool.title}
                <ArrowRight aria-hidden="true" />
              </Link>
            </div>
          </article>
        </div>
      )}

      <section className="iso-section iso-client-proof" aria-labelledby="client-proof-title">
        <div className="iso-shell iso-client-proof-layout">
          <div className="iso-feedback-quote">
            <p className="iso-kicker">User feedback</p>
            <blockquote>
              &ldquo;I don&rsquo;t have time to compile every payout, chase every invoice, and gather proof every time an auditor asks.&rdquo;
            </blockquote>
            <p>
              Splash turns that messy back-office work into a single transfer path: choose a saved recipient, approve the source,
              send safely, and keep the proof ready.
            </p>
          </div>

          <div className="iso-benefit-stack" aria-label="Splash transfer benefits">
            <h2 id="client-proof-title" className="iso-section-title">
              Built for teams that need money to move
              <span>fast, safely, and with proof.</span>
            </h2>
            <div className="iso-benefit-grid">
              {clientProofPoints.map(({ icon: Icon, title, copy }) => (
                <article className="iso-benefit-card" key={title}>
                  <div className="iso-benefit-icon">
                    <Icon aria-hidden="true" />
                  </div>
                  <div>
                    <h3>{title}</h3>
                    <p>{copy}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
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

      <footer className="iso-footer">
        <div className="iso-shell iso-footer-inner">
          <div className="iso-brand iso-brand-footer">
            <Image src="/splash-main-logo.png" alt="Splash Finance" width={310} height={90} className="iso-main-logo iso-main-logo-footer" />
          </div>
          <p>USD-first settlement infrastructure for Southeast Asian finance teams.</p>
          <nav aria-label="Footer navigation">
            <a href="#operating-layer">Platform</a>
            <a href="#comparison">Compare</a>
            <a href="#how-it-works">How it works</a>
            <a href="#walrus">Walrus</a>
            <a href="#corridors">Corridors</a>
            <a href="#readiness">Readiness</a>
            <Link href="/login">Log in</Link>
          </nav>
          <small>{claims.footerLegal.claim}</small>
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
