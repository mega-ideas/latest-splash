import { Badge, Chip } from '@/components/system';
import { brand } from '@/lib/brand';

/**
 * Hero desk render: the real Home surface built from the same system
 * components the app uses, fed with static sandbox sample data. A live
 * render instead of a screenshot: crisp at every DPR, themed, zero image
 * weight, explicit box (no layout shift). Decorative for assistive tech.
 */
const ROWS = [
  { when: '09:41', to: 'Manila Components Inc.', corridor: 'PHP', amount: '282,100.00', state: 'Paid out', tone: 'green' as const },
  { when: '09:12', to: 'PT Surabaya Textile', corridor: 'IDR', amount: '4,120,500', state: 'Delivered', tone: 'teal' as const },
  { when: '08:57', to: 'Cebu Freight Co.', corridor: 'PHP', amount: '61,880.00', state: 'Settled', tone: 'green' as const },
];

export default function HeroDeskPreview() {
  return (
    <div aria-hidden="true" className="w-full overflow-hidden rounded-[16px] border border-white/15 bg-[var(--paper)] text-[var(--text)] shadow-[0_24px_60px_-30px_rgba(11,42,51,.6)]" style={{ aspectRatio: '16 / 10' }}>
      <div className="flex h-9 items-center justify-between border-b border-[var(--divider)] bg-[var(--surface)] px-3">
        <span className="text-[11px] font-semibold">{brand.name} Demo Ltd</span>
        <span className="rounded-[999px] border border-[var(--amber-100)] bg-[var(--amber-100)] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-[var(--amber-600)]">Sandbox · no customer funds</span>
      </div>
      <div className="grid gap-3 p-3">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-2.5">
            <div className="font-mono text-[15px] font-semibold tabular-nums">11,140.00</div>
            <div className="font-mono text-[9px] uppercase tracking-[0.08em] text-[var(--text-muted)]">USDC</div>
            <div className="mt-1 text-[10px] text-[var(--text-2)]">Available</div>
          </div>
          <div className="rounded-[12px] bg-[var(--surface-2)] p-2.5">
            <div className="font-mono text-[15px] font-semibold tabular-nums text-[var(--amber-600)]">4,730.00</div>
            <div className="font-mono text-[9px] uppercase tracking-[0.08em] text-[var(--text-muted)]">USD claim</div>
            <div className="mt-1 text-[10px] text-[var(--text-2)]">Scheduled outflows</div>
          </div>
          <div className="rounded-[12px] bg-[var(--ink-900)] p-2.5 text-white">
            <div className="font-mono text-[15px] font-semibold tabular-nums">1</div>
            <div className="font-mono text-[9px] uppercase tracking-[0.08em] text-white/60">proposal</div>
            <div className="mt-1 text-[10px] text-white/80">Awaiting your approval</div>
          </div>
        </div>
        <div className="overflow-hidden rounded-[12px] border border-[var(--line)] bg-[var(--surface)]">
          <div className="grid grid-cols-[44px_1fr_52px_84px_78px] gap-2 border-b border-[var(--divider)] px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
            <span>When</span>
            <span>Recipient</span>
            <span>Rail</span>
            <span className="text-right">Amount</span>
            <span>State</span>
          </div>
          {ROWS.map((row) => (
            <div key={row.to} className="grid grid-cols-[44px_1fr_52px_84px_78px] items-center gap-2 border-b border-[var(--divider)] px-2.5 py-1.5 text-[10.5px] last:border-b-0">
              <span className="font-mono text-[var(--text-muted)]">{row.when}</span>
              <span className="truncate font-medium">{row.to}</span>
              <Chip className="h-5 px-1.5 text-[9px]">{row.corridor}</Chip>
              <span className="text-right font-mono tabular-nums">{row.amount}</span>
              <Badge tone={row.tone} className="h-5 px-1.5 text-[9px]">
                {row.state}
              </Badge>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between rounded-[12px] border border-[var(--line)] bg-[var(--surface)] px-2.5 py-2">
          <div>
            <div className="text-[10.5px] font-semibold">Maker-checker</div>
            <div className="text-[9.5px] text-[var(--text-2)]">Above 10,000 USD a second approver signs.</div>
          </div>
          <Badge tone="green" className="h-5 px-1.5 text-[9px]">
            Enforced
          </Badge>
        </div>
      </div>
    </div>
  );
}
