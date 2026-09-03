import SandboxRibbon from '@/components/brand/SandboxRibbon';

import Bento from './Bento';
import Corridors from './Corridors';
import FiveSteps from './FiveSteps';
import Footer from './Footer';
import Hero from './Hero';
import LandingNav from './LandingNav';
import MoneyFlow from './MoneyFlow';
import Onboard from './Onboard';
import ProofStrip from './ProofStrip';
import RatesTeaser from './RatesTeaser';
import RoadmapTeaser from './RoadmapTeaser';
import TreasuryVision from './TreasuryVision';
import Trust from './Trust';

/**
 * Landing v2 (brief §3): one responsive tree, 375px-first, Palette v2
 * tokens only, Geist for every headline, isometric work as illustration.
 * Section order is the reading order of a first visit: what it is, what it
 * does, how it settles, what it costs, how to start, why it is safe, where
 * it runs, when.
 */
export default function LandingV2() {
  return (
    <div className="min-h-dvh bg-[var(--paper)] text-[var(--text)]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-[var(--r-sm)] focus:bg-[var(--surface)] focus:px-3 focus:py-2">
        Skip to content
      </a>
      <SandboxRibbon />
      <LandingNav />
      <main id="main">
        <Hero />
        <ProofStrip />
        <Bento />
        <MoneyFlow />
        <FiveSteps />
        <TreasuryVision />
        <RatesTeaser />
        <Onboard />
        <Trust />
        <Corridors />
        <RoadmapTeaser />
      </main>
      <Footer />
    </div>
  );
}
