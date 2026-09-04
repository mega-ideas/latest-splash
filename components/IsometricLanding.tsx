'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState, useSyncExternalStore } from 'react';
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

import CorridorBoard from '@/components/landing/CorridorBoard';
import GuaranteeSequence from '@/components/landing/GuaranteeSequence';
import SettlementCinematic from '@/components/landing/SettlementCinematic';
import WaitlistCta from '@/components/landing/WaitlistCta';
import ControlPlaneExplainer from '@/components/oxwal/ControlPlaneExplainer';
import RoadmapChip from '@/components/supply/RoadmapChip';
import { claims, lockedCopy } from '@/content/claims';

/* These used to be Liquidity / Settlement / Treasury — the same product areas
   the three loops above already cover, which made this section read as a
   restatement rather than an argument. They are cut on a different axis now:
   not what the money does, but what holds true of every payment whichever loop
   it is in. Deliberately unnumbered — the loops are numbered because a reader
   walks them in order; these three are simultaneous, and numbering them would
   assert a sequence that does not exist. */

/* Each guarantee now carries the plate that illustrates it, and a `fit` that
   makes all three draw at the same ink width. The fits are measured, not
   guessed: the assets fill 64.6% / 83.8% / 68.9% of their own frames, so at
   equal frame size they draw 615 / 597 / 489px of actual ink. Without the
   correction the third plate reads as an unintended zoom-out mid-crossfade.

   Note which plate illustrates the third guarantee. treasury-island.png — an
   open vault of gold — was the obvious pick and is the wrong one: it would sit
   directly beside "Splash never takes custody of the funds it moves", which is
   a contradiction a compliance reader is exactly the person to catch.
   ctrl-approve.png draws the approval gesture instead, which is what the
   sentence is actually about. It is also 0.53MB against 5.5MB, and it leaves
   the vault to the close panel where the heading is "your global treasury". */
/* The query string cannot change without a navigation, so there is nothing
   to subscribe to. Declared once at module scope because a new function
   identity on every render would make useSyncExternalStore resubscribe. */
const NEVER_CHANGES = () => () => {};

const operatingLayers = [
  {
    label: 'Settlement is atomic',
    title: 'Funds cannot get stuck.',
    copy: 'A payment intent settles or reverts inside one Sui transaction. There is no half-sent state to chase, because there is no moment when only half of it has happened.',
    meta: lockedCopy.speed,
    plate: '/cinematic/settlement-machine.png',
    plateAlt:
      'Isometric settlement machine: a US dollar coin entering a checkpoint gate and leaving as local currency',
    fit: 1,
  },
  {
    label: 'A corridor that cannot settle does not quote',
    title: 'Nothing is promised before it can be funded.',
    copy: 'Payout inventory is checked before a quote exists. Corridors arm and pause under explicit controls, and settlement halts on a peg deviation or a compliance flag before any value moves.',
    meta: 'Corridor-gated · halts before value moves',
    plate: '/cinematic/liquidity-pools.png',
    plateAlt: 'Tiered isometric liquidity pools with gold coin reserves flowing between basins',
    fit: 1.03,
  },
  {
    label: 'A person releases it',
    title: 'Nothing leaves on a model’s say-so.',
    copy: '0xWal prepares and proposes; it cannot sign. A named approver releases the payment, and Splash never takes custody of the funds it moves.',
    meta: 'Maker-checker · approval-gated',
    plate: '/isometric/ctrl-approve.png',
    plateAlt: 'Isometric approval control: a prepared payment held at a gate until a person releases it',
    fit: 1.258,
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

/**
 * Pin coordinates for the corridor plate.
 *
 * THESE ARE HAND-FIT TO ONE EXACT ASSET: /cinematic/corridor-bridge-v3.png,
 * 1376x768. They are percentages of the drawn art, which only works because
 * .iso-plate locks the container to that same 1376/768 ratio with no crop and
 * no overshoot. If that asset is regenerated — and the filenames in this repo
 * say art does get regenerated (-v3, -v4, -v5, token-idr-v1, agent-bot-cut) —
 * every pin below still renders, still passes lint, still passes the contrast
 * check, and now points at empty sky. Nothing throws.
 *
 * To re-fit after an art change: run the dev server and append ?pins to the
 * landing URL. That draws a 5% crosshair grid over the plate. Read the new
 * coordinates off it and edit them here.
 *
 * `meta` is deliberately non-optional. Every pin ends in a source line, which
 * is what makes this an audited schematic rather than a pitch deck, and every
 * one of those lines quotes a claim that already exists elsewhere in the repo —
 * no pin asserts anything new.
 */
type CorridorPin = {
  x: string;
  y: string;
  label: string;
  title: string;
  meta: string;
  live?: boolean;
};

const CORRIDOR_PINS: CorridorPin[] = [
  { x: '18%', y: '66%', label: 'Collect', title: 'USD in · KL platform', meta: lockedCopy.fee },
  { x: '50%', y: '32%', label: 'Checkpoint', title: 'KYB and peg guard · bridge head', meta: 'Sumsub KYB · wired' },
  { x: '82%', y: '66%', label: 'Deliver', title: 'Local rail · Manila platform', meta: lockedCopy.speed, live: true },
];

/* One live route and seven modelled ones. The last column names the specific
   thing each modelled route is waiting on, rather than a bare "roadmap" pill —
   a named blocker is checkable, a pill is not. Airwallex already appears in the
   infrastructure rail on this page; naming it as the live route's rail adds no
   new claim. */
const CORRIDOR_ROUTES = [
  { route: 'USD → PHP', status: 'testnet live', rail: 'Airwallex', missing: null, live: true },
  { route: 'USD → MYR', status: 'modelled', rail: null, missing: 'local payout partner' },
  { route: 'USD → IDR', status: 'modelled', rail: null, missing: 'local payout partner' },
  { route: 'USD → VND', status: 'modelled', rail: null, missing: 'inbound licence step' },
  { route: 'USD → THB', status: 'modelled', rail: null, missing: 'local payout partner' },
  { route: 'USD → SGD', status: 'modelled', rail: null, missing: 'corridor controls' },
  { route: 'USD → EUR', status: 'modelled', rail: null, missing: 'corridor controls' },
  { route: 'USD → GBP', status: 'modelled', rail: null, missing: 'corridor controls' },
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

/* Follows the order the sections actually appear in, so the header is a map of
   the page rather than a second, contradicting one. #trust sits between
   Compare and Routes on the page but stays out of the nav, as before — it has
   its own route at /trust and the in-page section is a summary of it. */
const headerNavItems = [
  { href: '#how-it-works', label: 'How it works', detail: '5 steps' },
  { href: '#comparison', label: 'Compare', detail: 'Fees + speed' },
  { href: '#corridors', label: 'Routes', detail: 'MY-PH testnet' },
  { href: '#platform', label: 'Guarantees', detail: 'Every payment' },
  { href: '#supply', label: 'Working capital', detail: 'Supply loop' },
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

/* Unnumbered. The three loops run concurrently — an account is settling, saving
   and (eventually) financing at the same time — so 01/02/03 asserted a reading
   order that does not exist. The five steps in "How it works" keep their
   numbers, because there the order is the information. */
const loopCards = [
  {
    label: 'Settle',
    title: 'Move it in minutes.',
    copy: 'Collect USD, pay Southeast Asia. Every approved payout builds verified counterparties and settlement history.',
    image: '/isometric/loop-settle-v3.png',
    imageAlt: 'Isometric settlement: a USD coin crossing an approved rail in minutes to arrive as a PHP coin',
    meta: 'USD → PHP · live on testnet',
    roadmap: false,
  },
  {
    label: 'Save',
    title: 'Grow it while it waits.',
    copy: 'Idle USD follows a projected, variable treasury posture. Your business approves every move.',
    image: '/isometric/loop-save-v3.png',
    imageAlt: 'Isometric treasury tiers of idle USD growing along a yield curve, gated by an approve control',
    meta: 'Projected · variable · human-approved',
    roadmap: false,
  },
  {
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
  /* Dev-only crosshair overlay for re-fitting the corridor pins after an art
     change. Double-gated: the build must not be production AND ?pins must be
     present, so there is no path by which this reaches a visitor.

     Reads the query through useSyncExternalStore rather than useSearchParams.
     Both work — the route has a loading.tsx, so the boundary useSearchParams
     needs does exist — but this version does not suspend at all, and it states
     the server snapshot (false) explicitly rather than relying on the hook to
     agree across the boundary. The subscribe function is a module-level no-op
     because a query string cannot change without a navigation. */
  const showPinGrid = useSyncExternalStore(
    NEVER_CHANGES,
    () => process.env.NODE_ENV !== 'production' && new URLSearchParams(window.location.search).has('pins'),
    () => false, // server snapshot: the overlay never exists there
  );

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

      {/* Six static cells, not a scroller. The doubling was load-bearing for
          the animation — the keyframe translated the track 0 to -50%, so exactly
          2x duplication made the loop seam — and it goes with it. A moving strip
          of six facts asks to be watched rather than read, and the diamond
          separators were decoration between figures that already have labels. */}
      <div className="iso-marquee is-static" aria-label="Platform metrics">
        <div className="iso-marquee-track">
          {marqueeItems.map(([value, label]) => (
            <div className="iso-marquee-item" key={value}>
              <strong>{value}</strong>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>

      <section id="loops" className="iso-section iso-loops">
        <div className="iso-shell">
          <div className="iso-section-heading iso-heading-split">
            <div>
              <p className="iso-kicker">The three loops</p>
              <h2 className="iso-section-title">
                Move it. Grow it.{' '}
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
              <article className={`iso-loops-card iso-loops-card-${index + 1}`} key={loop.label}>
                <div className="iso-loops-meta">
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
        <div className="iso-shell iso-flow-layout">
          <div className="iso-flow-copy">
            <p className="iso-kicker">How it works</p>
            <h2 className="iso-section-title iso-section-title-light">
              Five steps.{' '}
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

      <section id="comparison" className="iso-section iso-comparison">
        <div className="iso-shell">
          <div className="iso-section-heading iso-heading-split">
            <div>
              <p className="iso-kicker">Comparison</p>
              {/* The one promoted heading on the page. It is spent here because
                  this is the only section carrying live data, and the extrude is
                  paired with the provenance in the table foot below — a heading
                  is a claim, and the as-of stamp is what discharges it. */}
              <h2 className="iso-section-title iso-section-title-band">
                Built for business.{' '}
                <span>Designed to move.</span>
              </h2>
            </div>
            <p>
              Splash makes internal account movement free, charges when value exits to local rails, and adds
              programmable settlement, approval-led AI, and private audit proof.
            </p>
          </div>

          {/* tabIndex makes the horizontal scroll reachable by keyboard. The
              wrap is already a scroll container, so browsers focus it anyway —
              this just makes it announced, and the focus floor paints the ring. */}
          <div className="iso-comparison-wrap" tabIndex={0} role="group" aria-labelledby="comparison-caption">
            <table className="iso-comparison-table">
              <caption id="comparison-caption" className="iso-comparison-caption">
                How one cross-border payout compares. Splash figures are for the live
                USD-to-PHP testnet corridor; the yield row is a reference benchmark,
                sourced and stamped in the table foot.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  <th scope="col">Bank</th>
                  <th scope="col">Broker</th>
                  <th scope="col">Wise</th>
                  <th scope="col" className="is-splash">Splash</th>
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
              {/* Provenance belongs inside the table border, not floating under
                  it: these are the sources for the row directly above. The asOf
                  guard suppresses a bogus stamp on the offline fallback, and the
                  timestamp is formatted client-side only, so there is no
                  hydration mismatch. */}
              <tfoot className="iso-comparison-foot">
                <tr>
                  <td colSpan={5}>
                    <span className="iso-foot-sources">
                      Reference yield benchmark — FDIC national savings · IBKR Pro cash ·
                      Wise USD Interest · Splash treasury projection
                    </span>
                    <span className="iso-foot-note">
                      Yield is hygiene, not the headline — the working-capital loop is.
                    </span>
                    {yieldBenchmarks.asOf ? (
                      <span className="iso-foot-stamp">
                        refreshed {new Date(yieldBenchmarks.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    ) : null}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Beside the yield row, not decorating the table. The tiers are the
              point: the row above compares four rates, and this is what a rate
              is a rate on. Kept small and quiet — the table is the argument. */}
          <figure className="iso-comparison-figure">
            <Image
              src="/cinematic/liquidity-pools.png"
              alt="Tiered isometric liquidity pools with gold coin reserves flowing between basins"
              width={1200}
              height={896}
              sizes="200px"
            />
            <figcaption>
              <strong>What the yield row is measuring.</strong>
              <p>
                Idle USD sits in tiers, not one pot. The benchmark above compares what each
                tier earns elsewhere against the treasury posture your business approves —
                projected and variable, never a fixed figure.
              </p>
            </figcaption>
          </figure>
        </div>
      </section>

      <section id="trust" className="iso-section iso-trust">
        <div className="iso-shell">
          <div className="iso-section-heading iso-heading-split">
            <div>
              <p className="iso-kicker">Trust · Four gates</p>
              <h2 className="iso-section-title iso-section-title-light">
                Every payout{' '}
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

      {/* No floating coin on this band. Once the plate carries informational
          pins, a second decoratively-pinned object stops "pinned" meaning
          anything. */}
      <section id="corridors" className="iso-section iso-corridors">
        <div className="iso-shell iso-corridor-layout">
          <div className="iso-corridor-copy">
            {/* Counted from the data rather than typed, so the kicker cannot
                drift from the board underneath it the day a route changes
                state. The old kicker — "One testnet corridor. Modeled
                expansion routes." — described the same facts without saying
                anything; this one states the tension the board then answers. */}
            <p className="iso-kicker">
              One live. {CORRIDOR_ROUTES.filter((r) => !r.live).length} waiting.
            </p>
            <h2 className="iso-section-title">
              USD in.{' '}
              <span>Local out.</span>
            </h2>
            <p>
              The MY-to-PH corridor is the proving ground. Additional routes stay modeled until partner, liquidity,
              and regulatory controls are ready market by market.
            </p>
            <CorridorBoard routes={CORRIDOR_ROUTES} />
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
            {/* The plate locks to the asset's true 1376x768 with no crop and no
                overshoot, because the pins are percentages of the drawn art. The
                old rule ran width:112%; margin-left:-7%; object-fit:contain,
                which letterboxed it — under that, a percentage of the container
                was not a percentage of the art and every coordinate would have
                been a lie. */}
            <figure className={`iso-plate${showPinGrid ? ' is-fitting' : ''}`}>
              <Image
                src="/cinematic/corridor-bridge-v3.png"
                alt="Two isometric city platforms, Kuala Lumpur and Manila, connected by a golden bridge of flowing coins"
                width={1376}
                height={768}
                sizes="(max-width: 1100px) 100vw, 780px"
              />

              {CORRIDOR_PINS.map((pin, index) => (
                <div
                  className={`iso-pin${pin.live ? ' is-live' : ''}`}
                  key={pin.title}
                  style={{ '--x': pin.x, '--y': pin.y } as React.CSSProperties}
                  aria-hidden="true"
                >
                  <span className="iso-pin-node" />
                  <span className="iso-pin-badge">{index + 1}</span>
                  <span className="iso-pin-leader" />
                  <div className="iso-pin-card">
                    <span className="iso-pin-label">{pin.label}</span>
                    <span className="iso-pin-title">{pin.title}</span>
                    <span className="iso-pin-meta">{pin.meta}</span>
                  </div>
                </div>
              ))}

              {showPinGrid ? <div className="iso-pin-grid" aria-hidden="true" /> : null}
            </figure>

            {/* Below 900px the pins become a legend. Call it that, because that
                is what it is — the spatial argument is a desktop argument, and
                a stacked list is a different reading of the same three facts.
                This is also the accessible copy: the pins above are aria-hidden
                so the same content is not announced twice. */}
            <ol className="iso-pin-legend">
              {CORRIDOR_PINS.map((pin, index) => (
                <li key={pin.title}>
                  <span className="iso-pin-badge">{index + 1}</span>
                  <div>
                    <span className="iso-pin-label">{pin.label}</span>
                    <strong>{pin.title}</strong>
                    <small>{pin.meta}</small>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section id="platform" className="iso-section iso-operating">
        <div className="iso-shell">
          <div className="iso-section-heading iso-heading-split">
            <div>
              <p className="iso-kicker">The guarantees</p>
              <h2 className="iso-section-title">
                True of every{' '}
                <span>payment.</span>
              </h2>
            </div>
            <p>
              The loops above are what your money does. These three hold whichever loop it is in —
              and they hold in the sandbox, before a licensed rail is active, because they are
              properties of how a payment is built rather than promises about how it is run.
            </p>
          </div>

          {/* One figure at asset scale, and nothing on top of it. This is the
              first place on the page a 2752px illustration is drawn at the size
              it was made for, instead of cropped into a 245px card thumbnail
              three times over.

              Nothing is annotated here on purpose: a 1px leader measures about
              1.2:1 on this ground and would fail 1.4.11 as a graphical object
              required to understand the figure, and one of the three guarantees
              — anchoring to Walrus and Sui — has no referent drawn in this
              asset at all. The corridor plate below is where pins are honest,
              because there position is a true statement. */}
          <GuaranteeSequence items={operatingLayers} />
        </div>
      </section>

      <section id="supply" className="iso-section iso-supply">
        <div className="iso-shell">
          <div className="iso-section-heading iso-heading-split">
            <div>
              <p className="iso-kicker">Supply · The moat</p>
              <h2 className="iso-section-title">
                Your invoices are{' '}
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

          {/* A ledger, not a third card grid. This is the page's only content
              that is entirely roadmap, and illustrating it at the same scale as
              the parts that actually run overstated it — the audit called that
              a compliance problem wearing a layout problem's clothes. Ruled
              rows state the sequence without dressing it as shipped product.
              It keeps 01/02/03 because this one genuinely is a sequence: an
              invoice is issued, then offered against, then settled. */}
          <ol className="iso-supply-ledger">
            {supplySteps.map((step) => (
              <li key={step.number}>
                <div className="iso-supply-ledger-stage">
                  <span className="iso-supply-ledger-num">{step.number}</span>
                  <strong>{step.label}</strong>
                </div>
                <div className="iso-supply-ledger-body">
                  <strong>{step.title}</strong>
                  <p>{step.copy}</p>
                </div>
                <div className="iso-supply-ledger-basis">{step.meta}</div>
              </li>
            ))}
          </ol>

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
              Context that gets{' '}
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
                Shipped, not{' '}
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
              Your global treasury,{' '}
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

          {/* The close says "your global treasury", so it gets the treasury.
              This replaces payments.svg, which was 512KB, carried a C2PA
              generative manifest, and held exactly one base64 raster and one
              <path> — an SVG extension on a bitmap, which is a trap for whoever
              reaches for it next expecting it to scale. treasury-island.png has
              a neutral matte, so it composites on this dark panel without a
              seam, and it is drawn at its real 2752x1536 rather than the
              1448x1086 the old declaration claimed. */}
          <div className="iso-final-art">
            <Image
              src="/cinematic/treasury-island.png"
              alt="Isometric floating treasury island with an open vault of reserves and orbiting coins"
              width={2752}
              height={1536}
              sizes="(max-width: 1100px) 60vw, 620px"
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
