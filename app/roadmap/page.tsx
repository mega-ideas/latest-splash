import type { Metadata } from 'next';

import RoadmapChip from '@/components/supply/RoadmapChip';
import { PageBody, PageHeader, SiteShell } from '@/components/site/SiteShell';
import { brand } from '@/lib/brand';
import { AFTERWARDS, MILESTONES } from '@/lib/site/roadmap';

export const metadata: Metadata = {
  title: `Roadmap — ${brand.name}`,
  description: 'Mainnet publish · September 2026 (protocol live, no customer funds). First live corridor operations · October 2026, following MFCA activation.',
};

export default function RoadmapPage() {
  return (
    <SiteShell>
      <PageHeader line1="Two dates that matter." line2="No customer funds until MFCA activation." lede="Everything else on this page follows from those two milestones. There are no volume targets here, and there will not be." />
      <PageBody>
        <ol className="relative grid gap-6 border-l-2 border-[var(--divider)] pl-8 md:grid-cols-2 md:gap-6 md:border-l-0 md:border-t-2 md:pl-0 md:pt-8" aria-label="Milestones">
          {MILESTONES.map((milestone, index) => (
            <li key={milestone.id} className="relative rounded-[16px] border border-[var(--line)] bg-[var(--surface)] p-6">
              <span className="absolute -left-[41px] top-7 grid size-4 place-items-center rounded-full border-2 border-[var(--teal-600)] bg-[var(--paper)] md:-top-[41px] md:left-6" aria-hidden="true">
                {index === 0 ? <span className="size-1.5 rounded-full bg-[var(--teal-600)]" /> : null}
              </span>
              <div className="font-mono text-[12px] text-[var(--teal-600)]">{milestone.when}</div>
              <h2 className="mt-2 text-[20px] font-semibold leading-tight">{milestone.label}</h2>
              <p className="mt-3 text-[14px] leading-[1.6] text-[var(--text-2)]">{milestone.detail}</p>
            </li>
          ))}
        </ol>

        <section aria-labelledby="after-title" className="grid gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="after-title" className="text-[clamp(1.5rem,4vw,1.75rem)] font-semibold tracking-[-0.02em]">
              After the first corridor
            </h2>
            <RoadmapChip detail="no dates, no volume promises" />
          </div>
          <ul className="grid gap-4 md:grid-cols-3">
            {AFTERWARDS.map((item) => (
              <li key={item.title} className="rounded-[16px] border border-[var(--line)] bg-[var(--surface)] p-5">
                <h3 className="text-[17px] font-semibold">{item.title}</h3>
                <p className="mt-2 text-[14px] leading-[1.55] text-[var(--text-2)]">{item.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-[16px] bg-[var(--surface-2)] p-6 text-[14px] leading-[1.6] text-[var(--text-2)]">
          <h2 className="text-[17px] font-semibold text-[var(--text)]">What does not change</h2>
          <p className="mt-2">{brand.agentName} prepares and a human approves, at every tier. Licensed partners remain the system of record for customer funds until {brand.name}&apos;s own licence permits otherwise. {brand.name} is not yet a licensed money-services business.</p>
        </section>
      </PageBody>
    </SiteShell>
  );
}
