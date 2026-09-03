import { ArrowRight } from 'lucide-react';

import { Button } from '@/components/system';

import Reveal from './Reveal';
import { Section, TwoTone } from './ui';

/** The two milestones, always both, exact strings (§0). */
export const MILESTONES = [
  { title: 'Mainnet publish', when: 'September 2026', note: 'protocol live, no customer funds' },
  { title: 'First live corridor operations', when: 'October 2026', note: 'following MFCA activation' },
];

export default function RoadmapTeaser() {
  return (
    <Section id="roadmap" labelledBy="roadmap-title">
      <Reveal>
        <TwoTone id="roadmap-title" line1="Two dates that matter." line2="No customer funds until MFCA activation." />
      </Reveal>
      <Reveal delay={0.05} className="mt-8">
        <ol className="grid gap-4 md:grid-cols-2">
          {MILESTONES.map((milestone, index) => (
            <li key={milestone.title} className="relative rounded-[16px] border border-[var(--line)] bg-[var(--surface)] p-5">
              <div className="flex items-center gap-2 font-mono text-[12px] text-[var(--teal-600)]">
                <span className={`size-2 rounded-full ${index === 0 ? 'bg-[var(--teal-600)]' : 'border-2 border-[var(--teal-600)]'}`} aria-hidden="true" />
                {milestone.when}
              </div>
              <h3 className="mt-2 text-[17px] font-semibold">
                {milestone.title} · {milestone.when} ({milestone.note})
              </h3>
            </li>
          ))}
        </ol>
        <Button href="/roadmap" variant="ghost" className="mt-6">
          Read the roadmap <ArrowRight aria-hidden="true" />
        </Button>
      </Reveal>
    </Section>
  );
}
