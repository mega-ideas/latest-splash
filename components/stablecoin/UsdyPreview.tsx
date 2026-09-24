'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, TrendingUp } from 'lucide-react';

import { formatUsdc } from '@/lib/payments/stablecoin-lane';

/**
 * Treasury in the business's own wallet: what USDC → Ondo USDY would give,
 * and a projection. A quote from lib/payments/treasury-usdy.ts — Splash swaps
 * nothing here, and it says so.
 *
 * Two numbers, deliberately side by side: what the USDC is worth in USDY at
 * the redemption rate, and what a Sui DEX would actually return for it right
 * now. On Sui they can be far apart — USDY liquidity there is thin — and the
 * gap is the thing a treasurer needs to see before anything else.
 */

type Quote = {
  allowed: boolean;
  mode: 'SANDBOX' | 'LIVE';
  reasons: string[];
  priceMicros: string | null;
  priceStatus: string;
  priceAsOf: string | null;
  priceSource?: string;
  usdyOutMinor: string | null;
  minUsdyOutMinor: string | null;
  market?: { usdyOutMinor: string; valueMinor: string | null; shortfallBps: number | null; providers: string[]; asOf: string; source: string } | null;
  fillable?: boolean | null;
  apyLabel: string;
  projections: Array<{ days: number; valueMinor: string; yieldMinor: string }>;
  error?: string;
};

function priceSourceLabel(source: string | undefined): string {
  if (!source) return '';
  if (source.startsWith('pyth:')) return 'Pyth redemption rate';
  if (source.startsWith('env:')) return 'configured price';
  return source;
}

function shortfallLabel(bps: number): string {
  if (bps <= 0) return 'no loss against the redemption value';
  const pct = bps / 100;
  return `${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}% below the redemption value`;
}

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

  const market = quote?.market ?? null;

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
          <div className="mt-3 space-y-2 text-[13px] text-[#1F4452]" aria-live="polite">
            {quote.usdyOutMinor ? (
              <>
                <div className="flex justify-between gap-3 tabular-nums"><span>At the redemption rate</span><span className="font-mono">{formatUsdc(BigInt(quote.usdyOutMinor))} USDY</span></div>
                {market ? (
                  <div className={`rounded-lg border px-2.5 py-2 ${quote.fillable === false ? 'border-[var(--warn)] bg-[var(--warn-bg)]' : 'border-[#326273]/12 bg-[#F6F0ED]/60'}`}>
                    <div className="flex justify-between gap-3 tabular-nums">
                      <span className="flex items-center gap-1.5 font-semibold">
                        {quote.fillable === false
                          ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--warn)]" aria-hidden />
                          : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--ok)]" aria-hidden />}
                        On Sui right now
                      </span>
                      <span className="font-mono font-semibold">{formatUsdc(BigInt(market.usdyOutMinor))} USDY</span>
                    </div>
                    <p className="mt-1 text-[12px] leading-5 text-[#326273]/75">
                      {market.shortfallBps !== null ? `${shortfallLabel(market.shortfallBps)}` : 'Value unknown without a redemption price'}
                      {market.providers.length > 0 ? ` · best route via ${market.providers.join(', ')}` : ''}
                    </p>
                  </div>
                ) : null}
                <div className="flex justify-between gap-3 tabular-nums text-[#326273]/75"><span>At least (0.5% slippage)</span><span className="font-mono">{formatUsdc(BigInt(quote.minUsdyOutMinor ?? '0'))} USDY</span></div>
                <div className="text-[12px] text-[#326273]/60">
                  USDY price ${formatUsdc(BigInt(quote.priceMicros ?? '0'))} ({[quote.priceStatus.toLowerCase(), priceSourceLabel(quote.priceSource), quote.priceAsOf ? new Date(quote.priceAsOf).toLocaleString() : ''].filter(Boolean).join(', ')})
                </div>
                <ul className="border-t border-[#326273]/10 pt-2">
                  {quote.projections.map((p) => (
                    <li key={p.days} className="flex justify-between tabular-nums"><span>After {p.days} days</span><span className="font-mono">{formatUsdc(BigInt(p.valueMinor))} ({BigInt(p.yieldMinor) >= 0n ? '+' : ''}{formatUsdc(BigInt(p.yieldMinor))})</span></li>
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
