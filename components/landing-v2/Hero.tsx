import { Button } from '@/components/system';

import HeroDeskPreview from './HeroDeskPreview';
import HeroPhonePreview from './HeroPhonePreview';
import { container, TwoTone } from './ui';

/**
 * Hero (§3.1). Left: the locked two-line H1, one sub, two CTAs. Right: the
 * real product on the hero gradient — desk render above md, phone render
 * everywhere (the phone IS the hero image on mobile).
 */
export default function Hero() {
  return (
    <section aria-labelledby="hero-title" className={`${container} grid items-center gap-10 pb-16 pt-10 md:pb-24 md:pt-16 lg:grid-cols-12`}>
      <div className="lg:col-span-6">
        <TwoTone as="h1" id="hero-title" size="display" line1="Send USD across Southeast Asia in minutes" line2="— starting with the Philippines and Indonesia." />
        <p className="mt-5 max-w-[46ch] text-[17px] leading-[1.55] text-[var(--text-2)]">One operating account for invoices, FX, payouts and proof. Settled atomically on Sui; a human approves every action.</p>
        <div className="mt-8 flex flex-col gap-2 sm:flex-row">
          <Button href="/login" size="lg">
            Open payment desk
          </Button>
          <Button href="#money-flow" variant="ghost" size="lg">
            See how it settles
          </Button>
        </div>
      </div>

      <div className="lg:col-span-6">
        <div className="relative rounded-[20px] p-4 md:p-6 lg:pr-24" style={{ background: 'linear-gradient(135deg, var(--ink-900) 0%, var(--teal-600) 100%)' }}>
          <div className="hidden md:block">
            <HeroDeskPreview />
          </div>
          <div className="flex justify-center md:hidden">
            <HeroPhonePreview />
          </div>
          <div className="pointer-events-none absolute -bottom-6 right-6 hidden origin-bottom-right scale-[0.72] md:block lg:right-4 lg:scale-[0.8]">
            <HeroPhonePreview />
          </div>
        </div>
      </div>
    </section>
  );
}
