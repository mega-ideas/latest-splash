'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from 'framer-motion';

import WaitlistCta from '@/components/landing/WaitlistCta';
import { lockedCopy } from '@/content/claims';

const HERO_IMG = '/cinematic/hero-district-v5.png';

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

const riseParent = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.09, delayChildren: 0.2 } },
};

const rise = {
  hidden: { opacity: 0, y: 28 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.8, ease: EASE_OUT_EXPO } },
};

const telemetry = [
  {
    id: 'corridor',
    className: 'cin-callout-a',
    enter: 0.27,
    tag: 'Corridor · Testnet',
    value: 'USD → PHP',
    meta: lockedCopy.speed,
    badge: '/cinematic/token-php.png',
    badgeAlt: 'Philippine peso token',
  },
  {
    id: 'fee',
    className: 'cin-callout-b',
    enter: 0.31,
    tag: 'Edge fee · Modeled',
    value: lockedCopy.fee,
    meta: lockedCopy.feeFootnote,
  },
  {
    id: 'treasury',
    className: 'cin-callout-c',
    enter: 0.35,
    tag: 'Treasury · Approval-gated',
    value: 'USDY posture',
    meta: lockedCopy.yield,
  },
  {
    id: 'agent',
    className: 'cin-callout-d',
    enter: 0.39,
    tag: 'Agent · Human-final',
    value: '0xWal desk',
    meta: lockedCopy.agent,
    badge: '/cinematic/agent-bot.png',
    badgeAlt: '0xWal assistant robot',
  },
];

/* Isometric currency tokens floating in the hero: position/size live in CSS;
   depth drives mouse parallax, rate drives scroll parallax. Click = coin spin. */
const tokens = [
  { className: 'cin-token-usd', src: '/cinematic/token-usd.png', alt: 'US dollar token', float: 'cin-float-slow', depth: -26, rate: -170 },
  { className: 'cin-token-myr', src: '/cinematic/token-myr.png', alt: 'Malaysian ringgit token', float: 'cin-float', depth: 30, rate: -120 },
  { className: 'cin-token-sui', src: '/cinematic/token-sui.png', alt: 'Sui token', float: 'cin-float-drift', depth: 44, rate: -240 },
];

function Callout({
  progress,
  enter,
  className,
  children,
}: {
  progress: MotionValue<number>;
  enter: number;
  className: string;
  children: ReactNode;
}) {
  const opacity = useTransform(progress, [enter, enter + 0.05, 0.52, 0.6], [0, 1, 1, 0]);
  const y = useTransform(progress, [enter, enter + 0.07], [22, 0]);
  return (
    <motion.div className={`cin-callout ${className}`} style={{ opacity, y }}>
      {children}
    </motion.div>
  );
}

function CalloutBody({
  tag,
  value,
  meta,
  badge,
  badgeAlt,
}: {
  tag: string;
  value: string;
  meta: string;
  badge?: string;
  badgeAlt?: string;
}) {
  return (
    <>
      {badge ? (
        <span className="cin-callout-badge">
          <Image src={badge} alt={badgeAlt ?? ''} width={1024} height={1024} sizes="72px" loading="eager" />
        </span>
      ) : null}
      <b aria-hidden="true" /><b aria-hidden="true" /><b aria-hidden="true" /><b aria-hidden="true" />
      <span className="cin-callout-wire" aria-hidden="true" />
      <i>{tag}</i>
      <strong>{value}</strong>
      <small>{meta}</small>
    </>
  );
}

function SpinButton({
  src,
  alt,
  float,
  sizes,
}: {
  src: string;
  alt: string;
  float: string;
  sizes: string;
}) {
  const [spinning, setSpinning] = useState(false);
  return (
    <button
      type="button"
      className={`cin-token-button ${spinning ? 'is-spinning' : ''}`}
      onClick={() => setSpinning(true)}
      onAnimationEnd={(event) => {
        if (event.animationName === 'cin-spin') setSpinning(false);
      }}
      aria-label={`${alt} — spin`}
    >
      <span className={`cin-token-inner ${float}`}>
        <Image src={src} alt="" width={1024} height={1024} sizes={sizes} loading="eager" />
      </span>
    </button>
  );
}

function Token({
  progress,
  mouseX,
  mouseY,
  className,
  src,
  alt,
  float,
  depth,
  rate,
}: {
  progress: MotionValue<number>;
  mouseX: MotionValue<number>;
  mouseY: MotionValue<number>;
  className: string;
  src: string;
  alt: string;
  float: string;
  depth: number;
  rate: number;
}) {
  const x = useTransform(mouseX, (value) => value * depth);
  const mouseLift = useTransform(mouseY, (value) => value * depth * 0.6);
  const scrollLift = useTransform(progress, [0, 1], [0, rate]);
  const y = useTransform([mouseLift, scrollLift], ([a, b]) => (a as number) + (b as number));
  const opacity = useTransform(progress, [0.38, 0.52], [1, 0]);

  return (
    <div className={`cin-token ${className}`}>
      <motion.div style={{ x, y, opacity }}>
        <SpinButton src={src} alt={alt} float={float} sizes="220px" />
      </motion.div>
    </div>
  );
}

function HeroCopy({ animated, onEnterEngine }: { animated: boolean; onEnterEngine?: () => void }) {
  return (
    <motion.div
      variants={animated ? riseParent : undefined}
      initial={animated ? 'hidden' : false}
      animate={animated ? 'shown' : undefined}
    >
      <motion.p variants={animated ? rise : undefined} className="iso-kicker">
        Splash · Settlement network on Sui
      </motion.p>
      {/* Display headline (visual) — the real <h1> below carries the SEO wedge. */}
      <motion.p variants={animated ? rise : undefined} className="iso-display" role="presentation">
        Move money.
        <span>Settle everything.</span>
      </motion.p>
      <motion.h1 variants={animated ? rise : undefined} className="cin-hero-h1">
        Send USD across Southeast Asia in minutes — starting with the Philippines
      </motion.h1>
      <motion.p variants={animated ? rise : undefined} className="iso-hero-description">
        A compliance-gated B2B account network for cross-border money. Between the invoice and the
        settlement, Splash nets, yields, discounts, and escrows — with human approval on every action.
      </motion.p>
      <motion.div variants={animated ? rise : undefined} className="iso-hero-actions">
        <Link href="/signup" className="iso-button">
          Open payment desk
          <ArrowRight aria-hidden="true" />
        </Link>
        {onEnterEngine ? (
          <button type="button" className="iso-button iso-button-ghost" onClick={onEnterEngine}>
            See the network
          </button>
        ) : null}
        {/* Pre-launch path: corridors roll out one at a time, so give the
            not-ready-yet visitor a "notify me" next to the primary CTA.
            Subordinate ghost styling keeps "Open payment desk" the one primary. */}
        <WaitlistCta />
      </motion.div>
      <motion.div variants={animated ? rise : undefined} className="iso-proof-line">
        <span><Check aria-hidden="true" /> Compliance-gated</span>
        <span><Check aria-hidden="true" /> {lockedCopy.speed}</span>
        <span><Check aria-hidden="true" /> Human-approved AI</span>
      </motion.div>
    </motion.div>
  );
}

function VisionCopy() {
  return (
    <>
      <Image
        src="/cinematic/brand-mark.png"
        alt=""
        width={256}
        height={256}
        className="cin-vision-mark"
        loading="eager"
      />
      <span className="cin-vision-chip">The product</span>
      <h2 className="cin-vision-title">
        Payments are the feature.
        <span>Treasury is the product.</span>
      </h2>
      <p className="cin-vision-lede">
        Stripe and Airwallex move money. Splash runs everything between the invoice and the
        settlement — netting it, yielding it, discounting it, escrowing it.
      </p>
      <div className="cin-vision-pillars" aria-hidden="true">
        <span>Netting</span>
        <span>Yield</span>
        <span>Discounting</span>
        <span>Escrow</span>
      </div>
      <div className="cin-vision-actions">
        <Link href="/signup" className="iso-button iso-button-gold">
          Open payment desk
          <ArrowRight aria-hidden="true" />
        </Link>
        <Link href="/login" className="iso-button iso-button-ghost">
          Log in
        </Link>
      </div>
    </>
  );
}

/** Non-pinned fallback for prefers-reduced-motion: same story, no choreography. */
function StaticCinematic() {
  return (
    <section id="cinematic" className="cin-section cin-section-static" aria-label="Splash settlement network">
      <div className="cin-static-hero">
        <div className="cin-orb cin-orb-gold" aria-hidden="true" />
        <div className="cin-orb cin-orb-mint" aria-hidden="true" />
        <div className="cin-grid" aria-hidden="true" />
        <div className="cin-static-stage" aria-hidden="true">
          <div className="cin-object-layer">
            <div className="cin-object">
              <div className="cin-object-glow" />
              <Image src={HERO_IMG} alt="" width={2752} height={1536} sizes="1700px" quality={90} priority />
            </div>
          </div>
        </div>
        <div className="iso-shell cin-copy cin-copy-static">
          <HeroCopy animated={false} />
        </div>
      </div>
      <div className="iso-shell cin-static-telemetry" aria-label="Network telemetry, simulated view">
        {telemetry.map((item) => (
          <div className="cin-callout cin-callout-static" key={item.id}>
            <CalloutBody tag={item.tag} value={item.value} meta={item.meta} badge={item.badge} badgeAlt={item.badgeAlt} />
          </div>
        ))}
      </div>
      <div className="iso-shell cin-vision cin-vision-static">
        <VisionCopy />
      </div>
    </section>
  );
}

export default function SettlementCinematic({ isPhone = false }: { isPhone?: boolean }) {
  const containerRef = useRef<HTMLElement>(null);
  const reducedMotion = useReducedMotion();
  const [compact, setCompact] = useState(false);
  const [artLoaded, setArtLoaded] = useState(false);
  // Phones (and narrow viewports) get the non-pinned static hero: same art,
  // copy, telemetry and vision, but no scroll-jacking — robust and readable
  // on a thumb. Seeded from the server UA flag so SSR matches on real phones.
  const [phoneLayout, setPhoneLayout] = useState(isPhone);

  /* Section-scoped scroll progress, driven manually so it never falls back
     to page-level measurement. */
  const scrollYProgress = useMotionValue(0);

  /* Pointer parallax, normalised to -0.5..0.5 and springed for weight. */
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const mouseX = useSpring(pointerX, { stiffness: 42, damping: 15 });
  const mouseY = useSpring(pointerY, { stiffness: 42, damping: 15 });

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    let top = 0;
    let range = 1;

    function update() {
      const value = (window.scrollY - top) / range;
      scrollYProgress.set(Math.min(Math.max(value, 0), 1));
    }

    function measure() {
      const rect = node!.getBoundingClientRect();
      top = rect.top + window.scrollY;
      range = Math.max(node!.offsetHeight - window.innerHeight, 1);
      update();
    }

    measure();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', measure);
    };
  }, [scrollYProgress]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 880px)');
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)');
    const update = () => setPhoneLayout(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  /* Act I — hero copy holds, then lifts away. */
  const heroOpacity = useTransform(scrollYProgress, [0, 0.1, 0.21], [1, 1, 0]);
  const heroY = useTransform(scrollYProgress, [0.08, 0.21], [0, -72]);
  const heroPointerEvents = useTransform(scrollYProgress, (value) => (value > 0.18 ? 'none' : 'auto'));
  const hintOpacity = useTransform(scrollYProgress, [0, 0.06], [1, 0]);

  /* The network artwork: drifts to centre, swells, then the camera pushes
     into the map. */
  const objectX = useTransform(
    scrollYProgress,
    [0.06, 0.38],
    compact ? ['0vw', '0vw'] : ['14vw', '0vw'],
  );
  const objectScale = useTransform(scrollYProgress, [0, 0.42, 0.56, 0.84], [1, 1.16, 1.22, 5]);
  const objectRotate = useTransform(scrollYProgress, [0, 0.84], [0, 5]);
  const objectOpacity = useTransform(scrollYProgress, [0.62, 0.78], [1, 0]);

  /* Act II — scan frame and telemetry callouts. */
  const scanOpacity = useTransform(scrollYProgress, [0.24, 0.3, 0.53, 0.61], [0, 1, 1, 0]);
  const scanScale = useTransform(scrollYProgress, [0.24, 0.34], [1.14, 1]);
  const statusOpacity = useTransform(scrollYProgress, [0.27, 0.33, 0.55, 0.63], [0, 1, 1, 0]);

  /* Act III — gold light burst, then the product vision. */
  const flashOpacity = useTransform(scrollYProgress, [0.58, 0.72, 0.82, 0.92], [0, 0.9, 0.35, 0]);
  const visionOpacity = useTransform(scrollYProgress, [0.74, 0.84], [0, 1]);
  const visionScale = useTransform(scrollYProgress, [0.74, 0.88], [0.93, 1]);
  const visionY = useTransform(scrollYProgress, [0.74, 0.86], [44, 0]);
  const visionPointerEvents = useTransform(scrollYProgress, (value) => (value > 0.78 ? 'auto' : 'none'));

  if (reducedMotion || phoneLayout) {
    return <StaticCinematic />;
  }

  function enterEngine() {
    const node = containerRef.current;
    if (!node) return;
    window.scrollTo({ top: node.offsetTop + node.offsetHeight * 0.66, behavior: 'smooth' });
  }

  function trackPointer(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'mouse') return;
    pointerX.set(event.clientX / window.innerWidth - 0.5);
    pointerY.set(event.clientY / window.innerHeight - 0.5);
  }

  return (
    <section id="cinematic" ref={containerRef} className="cin-section" aria-label="Splash settlement network">
      <div className="cin-sticky" onPointerMove={trackPointer}>
        <div className="cin-orb cin-orb-gold" aria-hidden="true" />
        <div className="cin-orb cin-orb-mint" aria-hidden="true" />
        <div className="cin-grid" aria-hidden="true" />

        {/* The isometric network artwork with its ambient life. */}
        <div className="cin-object-layer">
          <motion.div
            className="cin-object"
            style={{ x: objectX, scale: objectScale, rotate: objectRotate, opacity: objectOpacity }}
          >
            {!artLoaded && <div className="cin-object-poster" aria-hidden="true" />}
            <motion.div
              className="cin-float"
              initial={{ opacity: 0, scale: 0.92, y: 34 }}
              animate={artLoaded ? { opacity: 1, scale: 1, y: 0 } : undefined}
              transition={{ duration: 1.2, ease: EASE_OUT_EXPO }}
            >
              <div className="cin-object-glow" aria-hidden="true" />
              <Image
                src={HERO_IMG}
                alt="Isometric Splash headquarters campus on a floating platform: columned SPLASH building, Petronas towers, a glass tower, and a golden ring road with coin trucks"
                width={2752}
                height={1536}
                sizes="(max-width: 880px) 140vw, 1700px"
                quality={90}
                priority
                onLoad={() => setArtLoaded(true)}
              />
            </motion.div>
          </motion.div>
        </div>

        {/* Floating currency tokens with mouse + scroll parallax. */}
        <div className="cin-tokens">
          {tokens.map((token) => (
            <Token
              key={token.className}
              progress={scrollYProgress}
              mouseX={mouseX}
              mouseY={mouseY}
              {...token}
            />
          ))}
        </div>

        <div className="cin-vignette" aria-hidden="true" />

        {/* Act II — scan frame around the network. */}
        <motion.div
          className="cin-scan"
          style={{ opacity: scanOpacity, scale: scanScale }}
          aria-hidden="true"
        >
          <span className="cin-scan-corner is-tl" /><span className="cin-scan-corner is-tr" />
          <span className="cin-scan-corner is-bl" /><span className="cin-scan-corner is-br" />
        </motion.div>

        {telemetry.map((item) => (
          <Callout
            key={item.id}
            progress={scrollYProgress}
            enter={item.enter}
            className={item.className}
          >
            <CalloutBody tag={item.tag} value={item.value} meta={item.meta} badge={item.badge} badgeAlt={item.badgeAlt} />
          </Callout>
        ))}

        <motion.p className="cin-status" style={{ opacity: statusOpacity }}>
          Network telemetry · Sandbox environment · No real money moves
        </motion.p>

        {/* Act I — hero copy. */}
        <motion.div
          className="cin-copy-layer"
          style={{ opacity: heroOpacity, y: heroY, pointerEvents: heroPointerEvents }}
        >
          <div className="iso-shell cin-copy">
            <HeroCopy animated onEnterEngine={enterEngine} />
          </div>
        </motion.div>

        {/* Act III — gold light burst + vision. */}
        <motion.div className="cin-flash" style={{ opacity: flashOpacity }} aria-hidden="true" />
        <motion.div
          className="cin-vision"
          style={{ opacity: visionOpacity, scale: visionScale, y: visionY, pointerEvents: visionPointerEvents }}
        >
          <VisionCopy />
        </motion.div>

        <motion.div className="cin-hint" style={{ opacity: hintOpacity }} aria-hidden="true">
          <span className="cin-hint-wheel" />
          Scroll to settle
        </motion.div>
      </div>
    </section>
  );
}
