import RoadmapChip from '@/components/supply/RoadmapChip';
import { brand } from '@/lib/brand';

import Reveal from './Reveal';
import { Lede, Mono, Section, TwoTone } from './ui';

/** A2 pillars: live verbs only, mono module sub-labels. */
const PILLARS = [
  { title: 'Atomic settlement', module: 'payment_intent', body: 'Intent, allocation and proof land together or not at all.' },
  { title: 'Batch payouts', module: 'PTB batch', body: 'Chunks settle as single transactions; a chunk is all-or-nothing.' },
  { title: 'On-chain proof', module: 'audit_anchor + receipt_v2', body: 'A digest your auditor can verify without asking us.' },
  { title: 'Spend guardrails', module: 'spend_meter + guardian', body: 'Limits and maker-checker enforced before anything is signed.' },
];

/** Treasury vision (§3.5): the product thesis, set in Geist, never extruded. */
export default function TreasuryVision() {
  return (
    <Section id="vision" tone="surface" labelledBy="vision-title">
      <div className="grid gap-10 lg:grid-cols-12">
        <Reveal className="lg:col-span-5">
          <TwoTone id="vision-title" line1="Payments are the feature." line2="Treasury is the product." />
          <Lede className="mt-5">{brand.name} runs everything between the invoice and the settlement: settling it atomically, batching it, proving it, guarding it.</Lede>
          <div className="mt-6">
            <RoadmapChip detail="treasury position is projected and variable · live when the e-money licence is granted" />
          </div>
        </Reveal>
        <Reveal delay={0.05} className="lg:col-span-7">
          <ul className="grid gap-4 sm:grid-cols-2" aria-label="What ships today">
            {PILLARS.map((pillar) => (
              <li key={pillar.title} className="rounded-[16px] border border-[var(--line)] bg-[var(--paper)] p-5">
                <h3 className="text-[17px] font-semibold">{pillar.title}</h3>
                <p className="mt-1 text-[14px] leading-[1.5] text-[var(--text-2)]">{pillar.body}</p>
                <Mono className="mt-4">{pillar.module}</Mono>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </Section>
  );
}
