import { Check } from 'lucide-react';

import { Badge, BentoCell, BentoGrid, Chip, PolicyCard } from '@/components/system';
import { brand } from '@/lib/brand';

import Reveal from './Reveal';
import { Mono, Section, TwoTone } from './ui';

/**
 * Bento (§3.2): five cells, exactly one dark (0xWal), first in the DOM so it
 * leads on mobile. Body copy ≤12 words; every cell carries a mono module chip
 * and a real fragment of the product, not decoration.
 */
export default function Bento() {
  return (
    <Section id="product" labelledBy="bento-title">
      <Reveal>
        <TwoTone id="bento-title" line1="Payments are the feature." line2="Proof is the product." />
      </Reveal>
      <Reveal delay={0.05} className="mt-8">
        <BentoGrid>
          <BentoCell tone="dark" span={2} rowSpan={2} className="gap-4">
            <div>
              <h3 className="text-[17px] font-semibold">{brand.agentName} prepares. You approve.</h3>
              <p className="mt-1 text-[14px] text-white/75">Reads state, drafts unsigned proposals, explains its reasoning.</p>
            </div>
            <div className="grid gap-2 text-[12px]">
              <div className="ml-auto max-w-[90%] rounded-[12px] rounded-tr-[4px] bg-white/10 px-2.5 py-1.5">Allocate idle treasury for MY_PH</div>
              <div className="flex flex-wrap gap-1">
                <span className="rounded-[999px] border border-white/20 px-1.5 py-0.5 font-mono text-[10px] text-white/80">Reading balances</span>
                <span className="rounded-[999px] border border-white/20 px-1.5 py-0.5 font-mono text-[10px] text-white/80">Checking corridor liquidity</span>
              </div>
              <div className="rounded-[12px] border border-white/15 bg-white/5 p-2.5">
                <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-white/60">Unsigned proposal</div>
                <div className="mt-1 text-[13px]">Move 6,000 USDC above scheduled outflows into the treasury position.</div>
                <div className="mt-2 text-[11px] text-white/70">Waiting in Approvals · policy re-check at submit</div>
              </div>
            </div>
            <div className="mt-auto">
              <Mono className="border-white/20 bg-white/10 text-white/85">read + propose · never execute</Mono>
            </div>
          </BentoCell>

          <BentoCell span={4} className="gap-4">
            <div>
              <h3 className="text-[17px] font-semibold">Atomic settlement</h3>
              <p className="mt-1 text-[14px] text-[var(--text-2)]">Pay, allocate and prove in one transaction, or nothing happens.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {['pay', 'allocate', 'prove'].map((slab, index) => (
                <div key={slab} className="rounded-[12px] border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5">
                  <div className="font-mono text-[11px] text-[var(--text-muted)]">0{index + 1}</div>
                  <div className="font-mono text-[14px] font-semibold text-[var(--text)]">{slab}</div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 font-mono text-[12px] text-[var(--text-2)]">
              <span className="text-[var(--text-muted)]">digest</span>
              <span className="truncate">0x7f3a…c21e</span>
              <Badge tone="green" className="ml-auto">
                Settled · ~400ms
              </Badge>
            </div>
            <Mono className="self-start">payment_intent · PTB</Mono>
          </BentoCell>

          <BentoCell span={2} className="gap-4">
            <div>
              <h3 className="text-[17px] font-semibold">Batch payouts</h3>
              <p className="mt-1 text-[14px] text-[var(--text-2)]">One file, every row validated, one digest per chunk.</p>
            </div>
            <ul className="grid gap-1.5 text-[12px]">
              {['48 rows validated', '2 corridors · PHP, IDR', '1 chunk · 1 digest'].map((line) => (
                <li key={line} className="flex items-center gap-2">
                  <Check className="size-3.5 text-[var(--green-700)]" aria-hidden="true" />
                  <span className="font-mono">{line}</span>
                </li>
              ))}
            </ul>
            <Mono className="mt-auto self-start">PTB batch</Mono>
          </BentoCell>

          <BentoCell span={2} padding="sm" className="gap-2">
            <PolicyCard title="Maker-checker" rule="Above 10,000 USD a second, distinct approver signs." scope="Dual approval on" status={{ label: 'Enforced', tone: 'green' }} chips={['spend_meter', 'guardian']} />
          </BentoCell>

          <BentoCell span={6} tone="tint" className="gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-[17px] font-semibold">Treasury, labelled truthfully</h3>
              <p className="mt-1 text-[14px] text-[var(--text-2)]">Every balance says what it is. Projections stay projections.</p>
            </div>
            <dl className="grid grid-cols-3 gap-3 md:min-w-[440px]">
              {[
                ['11,140.00', 'USDC', 'Available'],
                ['4,730.00', 'USD claim', 'Scheduled outflows'],
                ['24,598.72', 'USDY', 'Position · projected'],
              ].map(([value, asset, label]) => (
                <div key={label} className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5">
                  <dd className="font-mono text-[15px] font-semibold tabular-nums">{value}</dd>
                  <dd className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">{asset}</dd>
                  <dt className="mt-1 text-[11px] text-[var(--text-2)]">{label}</dt>
                </div>
              ))}
            </dl>
            <Chip className="md:hidden">sandbox sample</Chip>
          </BentoCell>
        </BentoGrid>
      </Reveal>
    </Section>
  );
}
