import { brand } from '@/lib/brand';

/**
 * Hero phone render: a real 0xWal approval thread, built from the desk's
 * own vocabulary (activity lines, a read-only proposal, approval elsewhere).
 * Fixed 240×480 box, decorative for assistive tech.
 */
export default function HeroPhonePreview({ className = '' }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`w-[240px] shrink-0 overflow-hidden rounded-[32px] border-[6px] border-[var(--ink-900)] bg-[var(--paper)] text-[var(--text)] shadow-[0_24px_60px_-30px_rgba(11,42,51,.7)] ${className}`} style={{ height: 480 }}>
      <div className="flex h-10 items-center justify-between px-4 pt-1 font-mono text-[10px] text-[var(--text-muted)]">
        <span>9:41</span>
        <span className="h-4 w-14 rounded-full bg-[var(--ink-900)]" />
        <span>●●●</span>
      </div>
      <div className="flex items-center gap-2 border-b border-[var(--divider)] px-3 pb-2">
        <span className="grid size-6 place-items-center rounded-full bg-[var(--teal-100)] font-mono text-[9px] font-semibold text-[var(--teal-600)]">0x</span>
        <span className="text-[12px] font-semibold">{brand.agentName}</span>
        <span className="ml-auto rounded-[999px] border border-[var(--green-100)] bg-[var(--green-100)] px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.08em] text-[var(--green-700)]">Online</span>
      </div>
      <div className="grid gap-2 p-3 text-[11px] leading-[1.45]">
        <div className="ml-auto max-w-[85%] rounded-[12px] rounded-tr-[4px] bg-[var(--ink-900)] px-2.5 py-1.5 text-white">Pay invoice INV-2041 to Manila Components</div>
        <div className="flex flex-wrap gap-1 pl-1">
          <span className="rounded-[999px] border border-[var(--line)] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[8.5px] text-[var(--text-2)]">Verifying counterparty</span>
          <span className="rounded-[999px] border border-[var(--line)] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[8.5px] text-[var(--text-2)]">Fetching FX rate</span>
          <span className="rounded-[999px] border border-[var(--teal-100)] bg-[var(--teal-100)] px-1.5 py-0.5 font-mono text-[8.5px] text-[var(--teal-600)]">Preparing payment proposal</span>
        </div>
        <div className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-2.5">
          <div className="flex items-center justify-between">
            <span className="rounded-[4px] bg-[var(--ink-900)] px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.1em] text-white">Payment</span>
            <span className="rounded-[4px] border border-[var(--green-100)] bg-[var(--green-100)] px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.1em] text-[var(--green-700)]">Low risk</span>
          </div>
          <div className="mt-2 font-mono text-[16px] font-semibold tabular-nums">282,100.00 <span className="text-[10px] text-[var(--text-muted)]">PHP</span></div>
          <div className="text-[10px] text-[var(--text-2)]">≈ 5,000.00 USDC · Licensed payout partner · PHP</div>
          <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-[8.5px] text-[var(--text-muted)]">
            <span>KYB · clear</span>
            <span>Sanctions · clear</span>
            <span>Rate · Pyth mid</span>
            <span>Policy · within limit</span>
          </div>
        </div>
        <div className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] px-2.5 py-2 text-[10px] text-[var(--text-2)]">Waiting in Approvals. Nothing moves until a human signs it.</div>
        <div className="grid h-10 place-items-center rounded-[10px] bg-[var(--teal-600)] text-[12px] font-semibold text-white">Review in Approvals</div>
      </div>
    </div>
  );
}
