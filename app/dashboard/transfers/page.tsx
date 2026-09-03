'use client';

import { Clock3, TimerReset } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type RateHold = {
  id: string;
  corridorCurrency: string;
  rate: string;
  feeBps: number;
  holdUntil: string;
  state: 'ACTIVE' | 'EXECUTED' | 'EXPIRED' | 'CANCELLED';
  demo?: boolean;
  createdAt: string;
};

function remaining(holdUntil: string, now: number) {
  const milliseconds = Math.max(0, new Date(holdUntil).getTime() - now);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return `${hours}h ${minutes}m ${seconds}s`;
}

export default function RateHoldsPage() {
  const [holds, setHolds] = useState<RateHold[]>([]);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => setNow(Date.now()), 0);
    void fetch('/api/rate-holds').then((response) => response.json()).then((body: { items?: RateHold[] }) => setHolds(body.items ?? []));
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, []);

  const active = useMemo(() => now === 0 ? [] : holds.filter((hold) => hold.state === 'ACTIVE' && new Date(hold.holdUntil).getTime() > now), [holds, now]);
  const inactive = useMemo(() => now === 0 ? [] : holds.filter((hold) => !active.includes(hold)), [active, holds, now]);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <header>
        <span className="dash-kicker">Transfer timing</span>
        <h1 className="dash-title mt-2">Rate holds</h1>
        <p className="mt-1 max-w-2xl text-[13px] font-medium text-[#326273]/60">
          Keep a quoted corridor rate available for 48 hours, then choose when to use it. Every transfer still requires your authorization.
        </p>
      </header>

      <section className="dash-surface p-5 md:p-7">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#5C9EAD]/10 text-[var(--info)]"><Clock3 className="h-5 w-5" /></div>
          <div><h2 className="font-semibold text-[#326273]">Active rate holds</h2><p className="text-[13px] text-[#326273]/55">{active.length} ready to use</p></div>
        </div>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {active.map((hold) => (
            <article key={hold.id} className="rounded-2xl border border-[#5C9EAD]/30 bg-[#5C9EAD]/10 p-5 shadow-[5px_6px_0_rgba(50,98,115,0.12)]">
              <div className="flex items-start justify-between gap-3">
                <div><span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--info)]">Rate hold {hold.demo ? '· DEMO' : ''}</span><h3 className="mt-1 text-xl font-semibold text-[#326273]">USD → {hold.corridorCurrency}</h3></div>
                <span className="rounded-full bg-white px-2.5 py-1 text-[13px] font-bold text-[#326273]">ACTIVE</span>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
                <Metric label="Held rate" value={Number(hold.rate).toLocaleString()} />
                <Metric label="Time remaining" value={remaining(hold.holdUntil, now)} />
              </div>
              <Link href={`/dashboard/transfer?holdId=${encodeURIComponent(hold.id)}`} className="mt-5 inline-flex w-full items-center justify-center rounded-xl bg-[#E39774] px-4 py-3 text-sm font-bold text-white transition hover:bg-[#cd825f]">
                Use hold
              </Link>
            </article>
          ))}
          {active.length === 0 && <div className="col-span-full rounded-2xl border border-dashed border-[#326273]/20 p-8 text-center text-sm font-medium text-[#326273]/50">No active rate holds. Create one from the quote step of a transfer.</div>}
        </div>
      </section>

      {inactive.length > 0 && (
        <section className="dash-surface p-5 md:p-7">
          <div className="flex items-center gap-2 font-semibold text-[#326273]"><TimerReset className="h-4 w-4 text-[#E39774]" /> Previous rate holds</div>
          <div className="mt-4 divide-y divide-[#326273]/10">
            {inactive.map((hold) => <div key={hold.id} className="flex items-center justify-between gap-4 py-3 text-sm"><span className="font-semibold text-[#326273]">USD → {hold.corridorCurrency}</span><span className="font-mono text-[#326273]/60">{hold.rate}</span><span className="rounded-full bg-[#326273]/8 px-2 py-1 text-[13px] font-bold text-[#326273]/55">{hold.state === 'ACTIVE' ? 'EXPIRED' : hold.state}</span></div>)}
          </div>
        </section>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-white/75 p-3"><div className="text-[10px] font-semibold uppercase tracking-wide text-[#326273]/45">{label}</div><div className="mt-1 font-mono font-semibold text-[#326273]">{value}</div></div>;
}
