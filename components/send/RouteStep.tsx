'use client';

import { useState } from 'react';

import StatusLabel from '@/components/shell/StatusLabel';
import { Button } from '@/components/system';
import { formatAmount } from '@/lib/money';
import { routeAlternatives } from '@/lib/payments/clearance';
import type { TransferState } from '@/lib/send/state';
import { cn } from '@/lib/utils';

/**
 * Route: every eligible path for this amount and corridor, compared on
 * delivered amount, all-in cost, time and confidence, with the partner
 * rail recommended and the executable one. Wire and MTO rows are reviewed
 * category baselines, shown so the recommendation is never presented
 * without its alternatives. Selecting a route does not move funds.
 */
export default function RouteStep({ state, prev, next }: { state: TransferState; prev: () => void; next: () => void }) {
  const [route, setRoute] = useState('partner');
  const sendUsd = Number.parseFloat(state.amount.value || '0') || 0;
  const currency = state.amount.targetCurrency;
  const comparison = routeAlternatives(currency, sendUsd);
  const executable = route === 'partner';

  return (
    <div className="grid gap-4">
      <div>
        <h2 className="text-[18px] font-semibold">Route</h2>
        <p className="mt-1 text-[13px] text-[var(--text-2)]">Compare every eligible path. The regulated partner rail is the executable route in this workspace; the others are reviewed baselines for comparison.</p>
      </div>
      <fieldset className="border border-[var(--border-default)]">
        <legend className="sr-only">Settlement route</legend>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-[12.5px]">
            <thead>
              <tr className="font-mono text-[10px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">
                <th scope="col" className="h-10 px-3 text-left font-medium">Route</th>
                <th scope="col" className="h-10 px-3 text-right font-medium">They receive ({currency})</th>
                <th scope="col" className="h-10 px-3 text-right font-medium">All-in cost</th>
                <th scope="col" className="h-10 px-3 text-right font-medium">ETA</th>
                <th scope="col" className="h-10 px-3 text-right font-medium">Confidence</th>
                <th scope="col" className="h-10 px-3 text-left font-medium">Policy</th>
              </tr>
            </thead>
            <tbody>
              {comparison.rows.map((row) => {
                const active = row.id === route;
                return (
                  <tr key={row.id} className={cn('h-14 border-t border-[var(--border-default)]', active ? 'bg-[var(--surface-selected)] shadow-[inset_2px_0_0_var(--signal)]' : 'hover:bg-[var(--surface-subtle)]')}>
                    <td className="px-3">
                      <label className="flex cursor-pointer items-center gap-2">
                        <input type="radio" name="route" value={row.id} checked={active} onChange={() => setRoute(row.id)} className="size-4 accent-[var(--signal)]" />
                        <span className="grid">
                          <span className="font-medium">{row.route}</span>
                          <span className="text-[10.5px] text-[var(--text-muted)]">{row.recommended ? 'Recommended · executable' : 'Baseline · comparison only'}</span>
                        </span>
                      </label>
                    </td>
                    <td className="px-3 text-right font-mono tabular-nums">{formatAmount(currency, row.delivered)}</td>
                    <td className="px-3 text-right font-mono tabular-nums">USD {row.feeUsd.toFixed(2)}<span className="block text-[10px] text-[var(--text-muted)]">({row.feePct.toFixed(2)}%)</span></td>
                    <td className="px-3 text-right font-mono">{row.eta}</td>
                    <td className="px-3 text-right font-mono tabular-nums">{row.confidence}%</td>
                    <td className="px-3"><StatusLabel compact tone="verified">Policy passed</StatusLabel></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </fieldset>
      <p className="text-[11px] text-[var(--text-muted)]">Illustrative comparison. The executable quote was issued on the previous step and holds for 30 seconds; on-chain settlement ~400ms, delivery time depends on the local payout rail.</p>
      {!executable ? <p className="border border-[var(--state-attention)] bg-[var(--surface-attention)] px-3 py-2 text-[12.5px] text-[var(--state-attention)]">Only the regulated partner rail can execute from this workspace. Select it to continue, or keep this route for comparison.</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="secondary" onClick={prev}>Back</Button>
        <Button onClick={next} disabled={!executable}>Continue to review</Button>
      </div>
    </div>
  );
}
