import { ArrowRight } from 'lucide-react';

import { Button } from '@/components/system';

import CopyBlock from './CopyBlock';
import Reveal from './Reveal';
import { Lede, Mono, Section, TwoTone } from './ui';

/**
 * Trust (§3.8): why the protocol cannot hold your money. Three arguments,
 * the third one runnable. "Regulator-ready by design" is a design claim
 * about the package split, never a licence claim.
 */
export default function Trust() {
  return (
    <Section id="trust" labelledBy="trust-title">
      <Reveal>
        <TwoTone id="trust-title" line1="Why we can't hold your money." line2="Absent, not gated." />
        <Lede className="mt-5">The mainnet package has no place for customer funds to sit. That is a property of the code, and you can check it yourself.</Lede>
      </Reveal>
      <Reveal delay={0.05} className="mt-10 grid gap-4 md:grid-cols-3">
        <div className="rounded-[16px] border border-[var(--line)] bg-[var(--surface)] p-5">
          <h3 className="text-[17px] font-semibold">No struct can hold funds</h3>
          <p className="mt-2 text-[14px] leading-[1.55] text-[var(--text-2)]">
            <Mono>splash_core</Mono> carries no <Mono>Balance&lt;T&gt;</Mono>. The capability is absent from the package, not switched off.
          </p>
        </div>
        <div className="rounded-[16px] border border-[var(--line)] bg-[var(--surface)] p-5">
          <h3 className="text-[17px] font-semibold">Custody publishes with the licence</h3>
          <p className="mt-2 text-[14px] leading-[1.55] text-[var(--text-2)]">
            <Mono>splash_custody</Mono> goes on-chain only when the licence tier permits. Until then, licensed partners are the system of record.
          </p>
        </div>
        <div className="rounded-[16px] border border-[var(--line)] bg-[var(--surface)] p-5">
          <h3 className="text-[17px] font-semibold">Verify it yourself</h3>
          <p className="mt-2 text-[14px] leading-[1.55] text-[var(--text-2)]">One command scans the mainnet package for anything that could hold a balance and fails the build if it finds one.</p>
          <div className="mt-3">
            <CopyBlock command="npm run check:core" />
          </div>
        </div>
      </Reveal>
      <Reveal delay={0.1} className="mt-6 flex flex-wrap items-center gap-3">
        <span className="font-mono text-[12px] uppercase tracking-[0.1em] text-[var(--text-2)]">Regulator-ready by design</span>
        <Button href="/trust" variant="ghost" size="sm">
          Read the verification doc <ArrowRight aria-hidden="true" />
        </Button>
      </Reveal>
    </Section>
  );
}
