import { Code2, LayoutDashboard } from 'lucide-react';

import { Button } from '@/components/system';

import Reveal from './Reveal';
import { Section, TwoTone } from './ui';

/** Two ways to onboard (§3.7). Stacked below md. */
export default function Onboard() {
  return (
    <Section id="onboard" tone="surface" labelledBy="onboard-title">
      <Reveal>
        <TwoTone id="onboard-title" line1="Two ways in." line2="Pick the one your team already uses." />
      </Reveal>
      <Reveal delay={0.05} className="mt-8 grid gap-4 md:grid-cols-2">
        <article className="flex flex-col gap-4 rounded-[16px] border border-[var(--line)] bg-[var(--paper)] p-6">
          <LayoutDashboard className="size-6 text-[var(--teal-600)]" aria-hidden="true" />
          <div>
            <h3 className="text-[20px] font-semibold">Dashboard</h3>
            <p className="mt-2 text-[15px] leading-[1.55] text-[var(--text-2)]">No integration. Verify the business, add a recipient, send. First payout target: under a week after KYB.</p>
          </div>
          <div className="mt-auto">
            <Button href="/login">Open payment desk</Button>
          </div>
        </article>
        <article className="flex flex-col gap-4 rounded-[16px] border border-[var(--line)] bg-[var(--paper)] p-6">
          <Code2 className="size-6 text-[var(--teal-600)]" aria-hidden="true" />
          <div>
            <h3 className="text-[20px] font-semibold">API</h3>
            <p className="mt-2 text-[15px] leading-[1.55] text-[var(--text-2)]">Sandbox credentials and docs today. Payment intents, batches and receipts over HTTPS. Live in two to four weeks.</p>
          </div>
          <div className="mt-auto flex flex-wrap gap-2">
            <Button href="/docs" variant="ghost">
              Read the docs
            </Button>
            <Button href="/sandbox" variant="ghost">
              Try the sandbox
            </Button>
          </div>
        </article>
      </Reveal>
    </Section>
  );
}
