'use client';

import { useEffect, useState } from 'react';
import { Activity, TrendingDown, TrendingUp } from 'lucide-react';

import LocalTime from '@/components/LocalTime';

const RATES = [
  { pair: 'USD/PHP', rate: 56.42, precision: 2 },
  { pair: 'USD/MYR', rate: 4.71, precision: 2 },
  { pair: 'USD/IDR', rate: 16284, precision: 0 },
  { pair: 'USD/EUR', rate: 0.924, precision: 3 },
  { pair: 'USD/GBP', rate: 0.789, precision: 3 },
];

export default function LiveExchangeTicker() {
  const [rates, setRates] = useState(() => RATES.map((rate) => ({ ...rate, change: 0 })));
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  useEffect(() => {
    // Initial date is set on mount to avoid SSR hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLastUpdate(new Date());
    let tick = 0;
    const interval = window.setInterval(() => {
      tick += 1;
      setRates((prev) =>
        prev.map((r, index) => {
          const base = RATES.find((item) => item.pair === r.pair)?.rate ?? r.rate;
          const change = Math.sin(tick / 2 + index) * (base * 0.0009);

          return {
            ...r,
            rate: Math.max(base + change, 0),
            change,
          };
        })
      );
      setLastUpdate(new Date());
    }, 3000);

    return () => window.clearInterval(interval);
  }, []);

  return (
    <>
      <style>{`
        @keyframes splashFxTicker {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
      `}</style>
      <div className="overflow-hidden rounded-2xl border border-[#326273]/10 bg-[#1F4452] py-3 shadow-lg shadow-[#326273]/10">
        <div className="flex items-center gap-8">
          <div className="flex shrink-0 items-center gap-2 border-r border-white/10 px-5 text-sm font-semibold text-white/80">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#E39774] opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#E39774]" />
            </span>
            <Activity className="h-4 w-4 text-[#bfe6ee]" />
            <span>USD INDICATIVE FX</span>
            <span className="hidden text-[13px] text-white/80 sm:inline">Updated {lastUpdate ? <LocalTime value={lastUpdate} format="time" /> : '—'}</span>
          </div>
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="flex w-max animate-[splashFxTicker_38s_linear_infinite] items-center gap-8 whitespace-nowrap">
              {[...rates, ...rates].map((item, index) => {
                const positive = item.change >= 0;

                return (
                  <div key={`${item.pair}-${index}`} className="flex items-center gap-2 whitespace-nowrap">
                    <span className="text-sm font-medium text-white">{item.pair}</span>
                    <span className="font-mono text-sm text-[#bfe6ee]">{item.rate.toFixed(item.precision)}</span>
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[13px] font-mono ${positive ? 'bg-[#5C9EAD]/10 text-[#d8fff4]' : 'bg-[#E39774]/10 text-[#ffd9c9]'}`}>
                      {positive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                      {positive ? '+' : ''}{item.change.toFixed(item.precision)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
