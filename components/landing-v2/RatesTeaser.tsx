import { ArrowRight } from 'lucide-react';

import { Button, Chip } from '@/components/system';
import { getNetworkProfile } from '@/lib/network';

import Reveal from './Reveal';
import { Lede, Section, TwoTone } from './ui';

/** Illustrative sandbox rows; the real table lives at /rates and only carries live rows on mainnet with volume. */
const ROWS = [
  { date: '2026-09-01', mid: '56.42', executed: '56.48', spread: '0.11%' },
  { date: '2026-08-31', mid: '56.39', executed: '56.45', spread: '0.11%' },
  { date: '2026-08-30', mid: '56.47', executed: '56.53', spread: '0.11%' },
];

/** Rates transparency teaser (§3.6): Pyth mid next to what Splash executed. */
export default function RatesTeaser() {
  const { live } = getNetworkProfile();
  return (
    <Section id="rates" labelledBy="rates-title">
      <div className="grid gap-8 lg:grid-cols-12 lg:items-center">
        <Reveal className="lg:col-span-5">
          <TwoTone id="rates-title" line1="The rate you see" line2="is the rate on-chain." />
          <Lede className="mt-5">Every quote starts from the Pyth mid. The spread is published daily, per corridor, next to what actually executed.</Lede>
          <Button href="/rates" variant="ghost" className="mt-6">
            See daily rates <ArrowRight aria-hidden="true" />
          </Button>
        </Reveal>
        <Reveal delay={0.05} className="lg:col-span-7">
          <div className="overflow-hidden rounded-[16px] border border-[var(--line)] bg-[var(--surface)]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--divider)] px-4 py-3">
              <span className="text-[14px] font-semibold">USD / PHP</span>
              <Chip tone={live ? 'green' : 'default'}>{live ? 'live rows' : 'sandbox rows · illustrative'}</Chip>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-[14px]">
                <thead>
                  <tr className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
                    <th scope="col" className="sticky left-0 bg-[var(--surface)] px-4 py-2 text-left font-medium">Date</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Pyth mid</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Splash executed</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Spread</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--divider)]">
                  {ROWS.map((row) => (
                    <tr key={row.date}>
                      <th scope="row" className="sticky left-0 bg-[var(--surface)] px-4 py-2.5 text-left font-mono font-normal text-[var(--text-2)]">{row.date}</th>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{row.mid}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{row.executed}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[var(--teal-600)]">{row.spread}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-[var(--divider)] px-4 py-2 text-[11px] text-[var(--text-muted)]">Illustrative figures. Fees vary by corridor and volume; see pricing.</p>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
