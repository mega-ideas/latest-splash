import type { Metadata } from 'next';

import { Badge, Chip } from '@/components/system';
import DataTable, { type DataRow } from '@/components/site/DataTable';
import { PageBody, PageHeader, SiteShell } from '@/components/site/SiteShell';
import { lockedCopy } from '@/content/claims';
import { brand } from '@/lib/brand';
import { USD_CORRIDORS } from '@/lib/fx/corridors';
import { getNetworkProfile } from '@/lib/network';

export const metadata: Metadata = {
  title: `Pricing — ${brand.name}`,
  description: 'Illustrative fee ladder per corridor. From 0.80% at the edge; internal moves free; settlement gas sponsored.',
};

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/** Illustrative all-in cost for a sample notional, per corridor. */
function sample(bps: number, notional: number) {
  return `${(notional * (bps / 10_000)).toFixed(2)} USD`;
}

export default function PricingPage() {
  const { corridors } = getNetworkProfile();
  const liveCodes = new Set<string>(corridors.map((corridor) => corridor.code));
  const ladder = USD_CORRIDORS.filter((corridor) => corridor.status === 'active');

  const rows: DataRow[] = ladder.map((corridor) => {
    const live = liveCodes.has(corridor.country);
    return {
      id: corridor.pair,
      pair: (
        <span className="flex items-center gap-2">
          {corridor.pair}
          {live ? <Badge tone="teal">launch corridor</Badge> : <Chip ghost>modeled</Chip>}
        </span>
      ),
      fee: pct(corridor.feeBps),
      sample: sample(corridor.feeBps, 10_000),
      settlement: 'Sui · ~400ms',
      delivery: live ? 'Licensed payout partner · local rails' : 'Modeled until partner is signed',
    };
  });

  return (
    <SiteShell>
      <PageHeader line1="One fee, at the edge." line2="Nothing inside the network costs anything." lede={`${lockedCopy.fee}. ${lockedCopy.feeFootnote} Moving money between your own balances is free, and settlement gas is sponsored — you never hold SUI.`} />
      <PageBody>
        <section aria-labelledby="ladder-title" className="grid gap-4">
          <h2 id="ladder-title" className="text-[clamp(1.5rem,4vw,1.75rem)] font-semibold tracking-[-0.02em]">
            Fee ladder <span className="text-[var(--text-2)]">(illustrative)</span>
          </h2>
          <DataTable
            caption="Illustrative edge fee per corridor"
            columns={[
              { key: 'pair', header: 'Corridor', sticky: true },
              { key: 'fee', header: 'Edge fee', align: 'right', mono: true },
              { key: 'sample', header: 'On 10,000 USD', align: 'right', mono: true },
              { key: 'settlement', header: 'Settlement' },
              { key: 'delivery', header: 'Delivery' },
            ]}
            rows={rows}
            footnote="Illustrative. Fees vary by corridor and volume; the exact fee is shown on every quote before you approve it. Bounded on-chain at 2.00% (MAX_FEE_BPS). On-chain settlement ~400ms; delivery time depends on local payout rails."
          />
        </section>

        <section aria-labelledby="included-title" className="grid gap-4">
          <h2 id="included-title" className="text-[clamp(1.5rem,4vw,1.75rem)] font-semibold tracking-[-0.02em]">
            What the fee covers
          </h2>
          <ul className="grid gap-4 md:grid-cols-3">
            {[
              ['Verification and screening', 'KYB on the counterparty, sanctions and KYT checks on every payout, before a quote is issued.'],
              ['Live FX from Pyth', 'The rate you see is the rate that settles. The spread is published daily on the rates page.'],
              ['Proof and receipts', 'A settlement digest per payment, a receipt per supplier, and an audit anchor your auditor can verify.'],
            ].map(([title, body]) => (
              <li key={title} className="rounded-[16px] border border-[var(--line)] bg-[var(--surface)] p-5">
                <h3 className="text-[17px] font-semibold">{title}</h3>
                <p className="mt-2 text-[14px] leading-[1.55] text-[var(--text-2)]">{body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="free-title" className="rounded-[16px] bg-[var(--surface-2)] p-6">
          <h2 id="free-title" className="text-[17px] font-semibold">Always free</h2>
          <ul className="mt-3 grid gap-2 text-[14px] text-[var(--text-2)] md:grid-cols-3">
            <li>Moving between Available and Treasury (approval-gated).</li>
            <li>Settlement gas on Sui — sponsored, never charged.</li>
            <li>Receipts, exports and the audit trail.</li>
          </ul>
        </section>
      </PageBody>
    </SiteShell>
  );
}
