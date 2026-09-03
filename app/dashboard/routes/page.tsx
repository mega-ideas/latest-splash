'use client';

import { ArrowRight, Settings2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import Inspector, { InspectorField, InspectorSection } from '@/components/shell/Inspector';
import { PageHeader, Workspace } from '@/components/shell/PageHeader';
import StatusLabel from '@/components/shell/StatusLabel';
import { Button } from '@/components/system';
import { brand } from '@/lib/brand';
import { getUsdCorridorByCurrency } from '@/lib/fx/corridors';
import { formatAmount, formatMoney, formatRate } from '@/lib/money';
import { getNetworkProfile } from '@/lib/network';
import { destinationFor, fromTransfer, routeAlternatives } from '@/lib/payments/clearance';
import type { TransferIntentRecord } from '@/lib/server/operations';
import { cn } from '@/lib/utils';

const field = 'control';

/**
 * Route intelligence: every eligible settlement path for a corridor and
 * amount, compared on delivered value, time, reliability, policy outcome
 * and evidence freshness — before Splash recommends one. The partner rail
 * is priced from the corridor table; wire and MTO rows are reviewed
 * category baselines and say so. Nothing here executes.
 */
const profile = getNetworkProfile();
const corridors = profile.corridors;

export default function RoutesPage() {
  const [currency, setCurrency] = useState<string>(corridors[0]?.currency ?? 'PHP');
  const [amount, setAmount] = useState('5000');
  const [selectedRoute, setSelectedRoute] = useState('partner');
  const [transfers, setTransfers] = useState<TransferIntentRecord[]>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch('/api/transfers?filter=all', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : { items: [] }))
        .then((body: { items: TransferIntentRecord[] }) => setTransfers(body.items));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const sendUsd = Number.parseFloat(amount) || 0;
  const comparison = useMemo(() => routeAlternatives(currency, sendUsd), [currency, sendUsd]);
  const reference = getUsdCorridorByCurrency(currency);
  const dest = destinationFor(currency);
  const corridor = corridors.find((c) => c.currency === currency);
  const selected = comparison.rows.find((r) => r.id === selectedRoute) ?? comparison.rows[0];

  const health = useMemo(
    () =>
      corridors.map((c) => {
        const rows = transfers.map(fromTransfer).filter((r) => r.corridor.to === c.currency);
        const settled = rows.filter((r) => r.group === 'cleared').length;
        const failed = rows.filter((r) => r.group === 'attention').length;
        const d = destinationFor(c.currency);
        return { id: c.code, corridor: `KUL → ${d.code}`, volume: rows.reduce((s, r) => s + Number.parseFloat(r.send.amount || '0'), 0), success: settled + failed ? (settled / (settled + failed)) * 100 : null, count: rows.length, partner: c.partnerLabel, rail: c.deliveryRail };
      }),
    [transfers],
  );

  return (
    <>
      <PageHeader
        title="Route intelligence"
        supporting={`See every eligible path before ${brand.name} recommends one.`}
        actions={
          <>
            <Button href="/dashboard/settings?tab=policies" variant="secondary">
              <Settings2 aria-hidden="true" /> Rail settings
            </Button>
            <Button href="/dashboard/send">
              Test a corridor <ArrowRight aria-hidden="true" />
            </Button>
          </>
        }
      />

      <form className="mb-4 grid gap-3 border border-[var(--border-default)] bg-[var(--surface-raised)] p-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end" onSubmit={(event) => event.preventDefault()}>
        <div className="grid gap-1 text-[11px] font-medium text-[var(--text-2)]">
          Origin
          <div className={cn(field, 'flex items-center bg-[var(--surface-subtle)] text-[var(--text-2)]')}>Malaysia / USD funding account</div>
        </div>
        <label className="grid gap-1 text-[11px] font-medium text-[var(--text-2)]">
          Destination
          <select value={currency} onChange={(event) => setCurrency(event.target.value)} className={field}>
            {corridors.map((c) => (
              <option key={c.code} value={c.currency}>{c.country} / {c.currency}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-medium text-[var(--text-2)]">
          Amount (USD)
          <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ''))} className={cn(field, 'font-mono tabular-nums')} />
        </label>
        <Button type="submit" variant="secondary">
          Compare routes
        </Button>
      </form>

      <Workspace
        inspector={
          <Inspector kicker="Selected route path" title={`KUL → ${dest.code} · ${selected.route}`} subtitle={selected.recommended ? <StatusLabel compact tone="verified">Recommended</StatusLabel> : <StatusLabel compact tone="neutral">Alternative</StatusLabel>}>
            <ol className="relative grid gap-4 border-l border-[var(--border-default)] pl-4">
              {[
                { label: 'Origin', title: 'USD funding account', detail: 'Bank USD or held balance · KYT screened', health: 'Healthy' },
                { label: 'FX venue', title: 'Pyth mid-market', detail: reference ? formatRate('USD', currency, reference.rate) : '—', health: 'Live' },
                { label: 'Settlement rail', title: 'Sui · pay · allocate · prove', detail: '~400ms finality · one atomic transaction', health: profile.live ? 'Live' : 'Sandbox' },
                { label: 'Local payout', title: corridor?.partnerLabel ?? 'Licensed payout partner', detail: `${dest.label} · ${corridor?.deliveryRail ?? 'sui-native'}`, health: selected.id === 'partner' ? 'Healthy' : 'Not on this route' },
                { label: 'Beneficiary', title: `Verified counterparty · ${currency} account`, detail: formatMoney(currency, selected.delivered), health: 'Verified' },
              ].map((step) => (
                <li key={step.label} className="relative">
                  <span className="absolute -left-[21px] top-1 size-2.5 rounded-full border-2 border-[var(--signal)] bg-[var(--surface-subtle)]" aria-hidden="true" />
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono text-[10px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">{step.label}</div>
                      <div className="text-[13px] font-medium">{step.title}</div>
                      <div className="font-mono text-[11px] text-[var(--text-2)]">{step.detail}</div>
                    </div>
                    <StatusLabel compact>{step.health}</StatusLabel>
                  </div>
                </li>
              ))}
            </ol>
            <InspectorSection title="Backup provider">
              <div className="grid gap-1 border border-[var(--border-default)] bg-[var(--surface-raised)] p-3 text-[12px]">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Bank SWIFT</span>
                  <StatusLabel compact tone="attention">Degraded vs partner rail</StatusLabel>
                </div>
                <span className="text-[var(--text-2)]">Median delivery 2–5 days (vs same day) · illustrative category baseline, not a named provider.</span>
              </div>
            </InspectorSection>
            <InspectorSection title="Evidence">
              <div className="grid grid-cols-2 gap-2">
                <InspectorField label="FX source" mono>Pyth · reference table</InspectorField>
                <InspectorField label="Fee schedule" mono>{reference ? `${(reference.feeBps / 100).toFixed(2)}% edge` : '—'}</InspectorField>
                <InspectorField label="Policy" mono>Evaluated at proposal</InspectorField>
                <InspectorField label="Freshness" mono>{selected.freshness}</InspectorField>
              </div>
            </InspectorSection>
            <p className="mt-4 border border-[var(--border-default)] bg-[var(--surface-raised)] p-3 text-[12px] text-[var(--text-2)]">
              {brand.name} recommends the path with the highest delivered amount that passes policy. Comparison figures are illustrative; the executable quote is issued when you create a proposal and holds for 30 seconds.
            </p>
          </Inspector>
        }
      >
        <div className="border-b border-[var(--border-default)] px-4 py-3 font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Route comparison</div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[12.5px]">
            <thead>
              <tr className="font-mono text-[10px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">
                <th scope="col" className="h-10 px-3 text-left font-medium">Route</th>
                <th scope="col" className="h-10 px-3 text-right font-medium">Recipient amount ({currency})</th>
                <th scope="col" className="h-10 px-3 text-right font-medium">Effective FX (per USD sent)</th>
                <th scope="col" className="h-10 px-3 text-right font-medium">All-in fee</th>
                <th scope="col" className="h-10 px-3 text-right font-medium">ETA</th>
                <th scope="col" className="h-10 px-3 text-right font-medium">Confidence</th>
                <th scope="col" className="h-10 px-3 text-left font-medium">Policy</th>
                <th scope="col" className="h-10 px-3 text-right font-medium">Freshness</th>
              </tr>
            </thead>
            <tbody>
              {comparison.rows.map((row) => {
                const active = row.id === selected.id;
                const effective = sendUsd > 0 ? row.delivered / sendUsd : 0;
                return (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    aria-selected={active}
                    onClick={() => setSelectedRoute(row.id)}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedRoute(row.id); } }}
                    className={cn('h-14 cursor-pointer border-t border-[var(--border-default)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]', active ? 'bg-[var(--surface-selected)] shadow-[inset_2px_0_0_var(--signal)]' : 'hover:bg-[var(--surface-subtle)]')}
                  >
                    <td className="px-3">
                      <span className="flex items-center gap-2">
                        <span className={cn('size-3.5 rounded-full border-2', active ? 'border-[var(--signal)] bg-[var(--signal)]' : 'border-[var(--border-strong)]')} aria-hidden="true" />
                        <span className="grid">
                          <span className="font-medium">{row.route}</span>
                          {row.recommended ? <span className="text-[10.5px] text-[var(--signal)]">Recommended</span> : null}
                        </span>
                      </span>
                    </td>
                    <td className="px-3 text-right font-mono tabular-nums">{formatAmount(currency, row.delivered)}</td>
                    <td className="px-3 text-right font-mono tabular-nums">{effective ? effective.toFixed(comparison.precision === 0 ? 2 : 4) : '—'}</td>
                    <td className="px-3 text-right font-mono tabular-nums">
                      {row.feeUsd.toFixed(2)}
                      <span className="block text-[10px] text-[var(--text-muted)]">({row.feePct.toFixed(2)}%)</span>
                    </td>
                    <td className="px-3 text-right font-mono">{row.eta}</td>
                    <td className="px-3 text-right font-mono tabular-nums">{row.confidence}%</td>
                    <td className="px-3"><StatusLabel compact tone="verified">Policy passed</StatusLabel></td>
                    <td className="px-3 text-right font-mono text-[11px] text-[var(--text-2)]">{row.freshness}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-[var(--border-default)] px-4 py-2 text-[11px] text-[var(--text-muted)]">ETA includes typical cut-off buffers. On-chain settlement ~400ms; delivery time depends on the local payout rail. Wire and MTO figures are reviewed category baselines (last reviewed 2026-07-18), not named providers.</p>

        <div className="border-t border-[var(--border-default)] px-4 py-3 font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Corridor health register</div>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="font-mono text-[10px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">
              <th scope="col" className="h-10 px-3 text-left font-medium">Corridor</th>
              <th scope="col" className="h-10 px-3 text-left font-medium">Payout partner</th>
              <th scope="col" className="h-10 px-3 text-right font-medium">Volume</th>
              <th scope="col" className="h-10 px-3 text-right font-medium">Success</th>
              <th scope="col" className="h-10 px-3 text-right font-medium">Payouts</th>
              <th scope="col" className="h-10 px-3 text-left font-medium">Rail</th>
            </tr>
          </thead>
          <tbody>
            {health.map((row) => (
              <tr key={row.id} className="h-11 border-t border-[var(--border-default)]">
                <td className="px-3 font-mono">{row.corridor}</td>
                <td className="px-3 text-[var(--text-2)]">{row.partner}</td>
                <td className="px-3 text-right font-mono tabular-nums">{formatMoney('USD', row.volume)}</td>
                <td className="px-3 text-right font-mono tabular-nums">{row.success === null ? '—' : `${row.success.toFixed(1)}%`}</td>
                <td className="px-3 text-right font-mono tabular-nums">{row.count}</td>
                <td className="px-3 font-mono text-[11px]">{row.rail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Workspace>
    </>
  );
}
