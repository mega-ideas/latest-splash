'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2, Route } from 'lucide-react';

/**
 * "How do I get USDC into this wallet?" — asked of the funding planner
 * (lib/payments/cctp.ts). It plans; it does not bridge.
 */

type Plan =
  | { available: true; route: 'DIRECT' | 'CCTP_V1'; arrives: string; wait: string; steps: Array<{ where: string; action: string }>; warnings: string[] }
  | { available: false; reason: string; alternatives: string[] }
  | { error: string };

const SOURCES = [
  ['SUI', 'Sui (direct)'],
  ['ETHEREUM', 'Ethereum'],
  ['ARBITRUM', 'Arbitrum'],
  ['BASE', 'Base'],
  ['SOLANA', 'Solana'],
  ['APTOS', 'Aptos'],
] as const;

export default function FundingPlanner({ destination }: { destination: string }) {
  const [source, setSource] = useState<(typeof SOURCES)[number][0]>('SUI');
  const [asset, setAsset] = useState<'USDC' | 'USDT'>('USDC');
  const [amount, setAmount] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask() {
    setBusy(true);
    try {
      const res = await fetch('/api/stablecoin/funding-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, asset, amount: amount.trim(), destination }),
      });
      setPlan((await res.json()) as Plan);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="mt-3 rounded-lg border border-[#326273]/12 bg-white p-3">
      <summary className="cursor-pointer text-[13px] font-semibold text-[#1F4452]">Fund this wallet from another chain</summary>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
        <div>
          <label htmlFor="fund-source" className="text-[12px] font-medium text-[#326273]/90">From</label>
          <select id="fund-source" value={source} onChange={(e) => { setSource(e.target.value as typeof source); setPlan(null); }} className="mt-1 w-full rounded-lg border border-[#326273]/25 bg-[#F6F0ED] px-2 py-2 text-[13px] text-[#1F4452]">
            {SOURCES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="fund-asset" className="text-[12px] font-medium text-[#326273]/90">Asset</label>
          <select id="fund-asset" value={asset} onChange={(e) => { setAsset(e.target.value as 'USDC' | 'USDT'); setPlan(null); }} className="mt-1 w-full rounded-lg border border-[#326273]/25 bg-[#F6F0ED] px-2 py-2 text-[13px] text-[#1F4452]">
            <option value="USDC">USDC</option>
            <option value="USDT">USDT</option>
          </select>
        </div>
        <div>
          <label htmlFor="fund-amount" className="text-[12px] font-medium text-[#326273]/90">Amount</label>
          <input id="fund-amount" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder="1000" className="mt-1 w-28 rounded-lg border border-[#326273]/25 bg-[#F6F0ED] px-2 py-2 font-mono text-[13px] text-[#1F4452]" />
        </div>
        <button type="button" onClick={() => void ask()} disabled={busy || !amount} className="dash-btn-ghost inline-flex items-center gap-1 !px-3 !py-2 !text-[13px]">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Route className="h-4 w-4" />} Plan it
        </button>
      </div>

      {plan ? (
        'error' in plan ? (
          <p role="alert" className="mt-3 text-[13px] text-[var(--error)]">{plan.error}</p>
        ) : plan.available ? (
          <div className="mt-3 text-[13px] text-[#1F4452]">
            <p><strong>{plan.route === 'DIRECT' ? 'Direct on Sui' : 'Circle CCTP (V1)'}</strong> · arrives: <span className="font-mono">{plan.arrives} USDC</span> · wait: {plan.wait}</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              {plan.steps.map((s) => <li key={s.action}><span className="font-semibold">{s.where}:</span> {s.action}</li>)}
            </ol>
            <ul className="mt-2 space-y-1">
              {plan.warnings.map((w) => (
                <li key={w} className="flex items-start gap-1.5 text-[12px] leading-5 text-[#326273]/90">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--warn)]" /> {w}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="mt-3 text-[13px] text-[#1F4452]">
            <p className="font-semibold text-[var(--error)]">{plan.reason}</p>
            <ul className="mt-1 list-disc pl-5 text-[#326273]/90">{plan.alternatives.map((a) => <li key={a}>{a}</li>)}</ul>
          </div>
        )
      ) : null}
    </details>
  );
}
