import type { Metadata } from 'next';

import { Chip } from '@/components/system';
import DataTable from '@/components/site/DataTable';
import { PageBody, PageHeader, SiteShell } from '@/components/site/SiteShell';
import { brand } from '@/lib/brand';
import { formatInstant } from '@/lib/format/time';
import { getDailyRates } from '@/lib/rates/daily';

export const metadata: Metadata = {
  title: `Rates — ${brand.name}`,
  description: 'Daily rate transparency: the Pyth mid next to what Splash executed, per corridor.',
};

export const dynamic = 'force-dynamic';

export default function RatesPage() {
  const rates = getDailyRates();
  const pairs = [...new Set(rates.rows.map((row) => row.pair))];

  return (
    <SiteShell>
      <PageHeader line1="The rate you see" line2="is the rate on-chain." lede="Every quote starts from the Pyth mid. This table publishes, per corridor and per day, the mid and what actually executed, so the spread is never a surprise.">
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Chip tone={rates.live ? 'green' : 'default'}>{rates.live ? 'live executions' : 'sandbox rows · illustrative'}</Chip>
          <span className="font-mono text-[12px] text-[var(--text-muted)]">as of {formatInstant(rates.asOf)}</span>
        </div>
      </PageHeader>
      <PageBody>
        {rates.live && rates.rows.length === 0 ? (
          <div className="rounded-[16px] border border-[var(--line)] bg-[var(--surface)] p-6 text-[15px] text-[var(--text-2)]">No executed volume yet. Rows appear here the day the first corridor executes a payout.</div>
        ) : null}
        {pairs.map((pair) => (
          <section key={pair} aria-labelledby={`pair-${pair}`} className="grid gap-4">
            <h2 id={`pair-${pair}`} className="text-[clamp(1.5rem,4vw,1.75rem)] font-semibold tracking-[-0.02em]">
              {pair}
            </h2>
            <DataTable
              scroll
              caption={`Daily rates for ${pair}`}
              columns={[
                { key: 'date', header: 'Date', sticky: true, mono: true },
                { key: 'pythMid', header: 'Pyth mid', align: 'right', mono: true },
                { key: 'executed', header: `${brand.name} executed`, align: 'right', mono: true },
                { key: 'spreadPct', header: 'Spread', align: 'right', mono: true },
              ]}
              rows={rates.rows.filter((row) => row.pair === pair)}
              footnote={rates.live ? 'Executed rates are volume-weighted daily averages.' : 'Sandbox rows derived from corridor reference rates. Real rows appear only on mainnet with executed volume. Illustrative — see pricing.'}
            />
          </section>
        ))}
        <section className="rounded-[16px] bg-[var(--surface-2)] p-6 text-[14px] leading-[1.6] text-[var(--text-2)]">
          <h2 className="text-[17px] font-semibold text-[var(--text)]">How to read this</h2>
          <p className="mt-2">Pyth mid is the oracle mid-market price at execution. Executed is the rate written into the settlement intent on Sui. Spread is the difference, expressed as a percentage of mid; it is the FX share of the edge fee and is already included in the quote you approve.</p>
        </section>
      </PageBody>
    </SiteShell>
  );
}
