'use client';

import { useState } from 'react';
import { Loader2, TrendingUp } from 'lucide-react';

import { formatUsdc } from '@/lib/payments/stablecoin-lane';

/**
 * Treasury in the business's own wallet: what USDC → Ondo USDY would give,
 * and a projection. A quote from lib/payments/treasury-usdy.ts — Splash swaps
 * nothing here, and it says so.
 */

type Quote = {
  allowed: boolean;
  mode: 'SANDBOX' | 'LIVE';
  reasons: string[];
  priceMicros: string | null;
  priceStatus: string;
  priceAsOf: string | null;
  usdyOutMinor: string | null;
  minUsdyOutMinor: string | null;
  apyLabel: string;
  projections: Array<{ days: number; valueMinor: string; yieldMinor: string }>;
  error?: string;
};

export default function UsdyPreview() {
  const [amount, setAmount] = useState('1000');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask() {
    setBusy(true);
    try {
      const res = await fetch('/api/stablecoin/treasury-quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: amount.trim() }),
      });
      setQuote((await res.json()) as Quote);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dash-surface p-4" aria-labelledby="usdy-title">
      <div className="flex items-center justify-between gap-2">
        <h2 id="usdy-title" className="flex items-center gap-2 text-sm font-semibold text-[#326273]">
          <TrendingUp className="h-4 w-4 text-[var(--info)]" /> Treasury · Ondo USDY
        </h2>
        {quote?.mode === 'SANDBOX' ? <span className="rounded-full bg-[var(--warn-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--warn)]">Preview</span> : null}
      </div>
      <p className="mt-1 text-[12px] leading-5 text-[#326273]/65">
        Swap USDC for USDY in your own Splash wallet. USDY is priced above $1 and its price moves; the figures below are a projection at a variable modeled rate, not a promise. Verified, non-US businesses only.
      </p>
      <div className="mt-3 flex items-end gap-2">
        <div>
          <label htmlFor="usdy-amount" className="text-[12px] font-medium text-[#326273]/70">USDC</label>
          <input id="usdy-amount" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" className="mt-1 w-32 rounded-lg border border-[#326273]/25 bg-[#F6F0ED] px-2 py-2 font-mono text-[13px] text-[#1F4452]" />
        </div>
        <button type="button" onClick={() => void ask()} disabled={busy || !amount} className="dash-btn-ghost inline-flex items-center gap-1 !px-3 !py-2 !text-[13px]">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Quote
        </button>
      </div>
      {quote ? (
        quote.error ? (
          <p role="alert" className="mt-3 text-[13px] text-[var(--error)]">{quote.error}</p>
        ) : (
          <div className="mt-3 space-y-2 text-[13px] text-[#1F4452]">
            {quote.usdyOutMinor ? (
              <>
                <div className="flex justify-between tabular-nums"><span>You would get</span><span className="font-mono">{formatUsdc(BigInt(quote.usdyOutMinor))} USDY</span></div>
                <div className="flex justify-between tabular-nums text-[#326273]/75"><span>At least (0.5% slippage)</span><span className="font-mono">{formatUsdc(BigInt(quote.minUsdyOutMinor ?? '0'))} USDY</span></div>
                <div className="text-[12px] text-[#326273]/60">USDY price ${formatUsdc(BigInt(quote.priceMicros ?? '0'))} ({quote.priceStatus.toLowerCase()}{quote.priceAsOf ? `, ${new Date(quote.priceAsOf).toLocaleString()}` : ''})</div>
                <ul className="border-t border-[#326273]/10 pt-2">
                  {quote.projections.map((p) => (
                    <li key={p.days} className="flex justify-between tabular-nums"><span>After {p.days} days</span><span className="font-mono">{formatUsdc(BigInt(p.valueMinor))} (+{formatUsdc(BigInt(p.yieldMinor))})</span></li>
                  ))}
                </ul>
                <div className="text-[12px] text-[#326273]/60">{quote.apyLabel}</div>
              </>
            ) : null}
            {quote.reasons.map((r) => <p key={r} className="text-[12px] leading-5 text-[var(--warn)]">{r}</p>)}
          </div>
        )
      ) : null}
    </section>
  );
}
