import { CorridorMap } from '@/components/illustrations/iso';
import { Chip } from '@/components/system';
import { getNetworkProfile } from '@/lib/network';

import Reveal from './Reveal';
import { Lede, Section, TwoTone } from './ui';

/** Corridors (§3.9): generic partner labels, a ghost for what comes next, no dates. */
export default function Corridors() {
  const { corridors } = getNetworkProfile();
  return (
    <Section id="corridors" tone="surface" labelledBy="corridors-title">
      <div className="grid gap-10 lg:grid-cols-12 lg:items-center">
        <Reveal className="lg:col-span-5">
          <TwoTone id="corridors-title" line1="USD in. Local out." line2="A licensed payout partner at the far end of every corridor." />
          <Lede className="mt-5">Two corridors first, launched one after the other. Every further route stays modeled until the partner, liquidity and controls are in place for that market.</Lede>
          <p className="mt-3 font-mono text-[12px] text-[var(--text-muted)]">Modeled expansion routes.</p>
        </Reveal>
        <Reveal delay={0.05} className="lg:col-span-7">
          <div className="grid gap-4 sm:grid-cols-[1fr_1fr] lg:grid-cols-[1.1fr_1fr]">
            <div className="hidden rounded-[16px] border border-[var(--line)] bg-[var(--paper)] p-4 sm:block">
              <CorridorMap decorative className="h-auto w-full" corridors={corridors.map((corridor) => ({ currency: corridor.currency, country: corridor.country }))} />
            </div>
            <ul className="grid gap-3">
              {corridors.map((corridor) => (
                <li key={corridor.code} className="rounded-[16px] border border-[var(--line)] bg-[var(--paper)] p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-[17px] font-semibold">{corridor.country}</h3>
                    <Chip tone="teal">{corridor.currency}</Chip>
                  </div>
                  <p className="mt-1 text-[14px] text-[var(--text-2)]">{corridor.partnerLabel}</p>
                  <p className="mt-2 font-mono text-[11px] text-[var(--text-muted)]">Local bank rails · statement descriptor explained on every receipt</p>
                </li>
              ))}
              <li className="rounded-[16px] border border-dashed border-[var(--line)] p-4 border-dashed">
                <h3 className="text-[17px] font-semibold">More corridors</h3>
                <p className="mt-1 text-[14px] text-[var(--text-2)]">Modeled until partner, liquidity and controls are ready.</p>
              </li>
            </ul>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
