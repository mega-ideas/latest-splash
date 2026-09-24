'use client';

import { useState } from 'react';

import type { ComplianceControls } from '@/lib/server/sui-settlement';

export default function ComplianceControlForm({ initial }: { initial: ComplianceControls }) {
  const [values, setValues] = useState(initial);
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);

  async function save() {
    setPending(true);
    setStatus('');
    try {
      const response = await fetch('/api/admin/compliance', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Update failed');
      setValues(data);
      setStatus(`On-chain update confirmed: ${String(data.digest).slice(0, 12)}...`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Update failed');
    } finally {
      setPending(false);
    }
  }

  const numberFields = [
    ['maxDeviationPpm', 'Peg max deviation', 'ppm'],
    ['maxStalenessMs', 'Peg reading max age', 'ms'],
    ['maxSlippageBps', 'DeepBook max slippage', 'bps'],
    ['minDepthBaseUnits', 'DeepBook minimum depth', 'base units'],
    ['minSettlementAmount', 'Minimum settlement', 'minor units'],
  ] as const;

  return (
    <section className="dash-surface p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span className="dash-kicker">On-chain risk controls</span>
          <h2 className="mt-2 text-lg font-bold text-[#1f4350]">Peg limits + DeepBook V3 execution</h2>
          <p className="mt-1 max-w-2xl text-sm text-[#326273]/65">Updates require the owned ComplianceCap. The pause switch fails every settlement closed.</p>
        </div>
        <label className="flex items-center gap-2 rounded-full border border-[#326273]/15 px-3 py-2 text-xs font-bold text-[#326273]">
          <input type="checkbox" checked={values.paused} onChange={(event) => setValues({ ...values, paused: event.target.checked })} />
          Pause settlement
        </label>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {numberFields.map(([key, label, unit]) => (
          <label key={key} className="grid gap-1 text-xs font-bold text-[#326273]">
            {label}
            <span className="flex items-center rounded-xl border border-[#326273]/15 bg-white px-3">
              <input
                className="min-w-0 flex-1 bg-transparent py-2.5 font-mono outline-none"
                type="number"
                min={1}
                value={values[key] === undefined || values[key] === null ? '' : String(values[key])}
                onChange={(event) => {
                  const raw = event.target.value;
                  // Empty means "leave the on-chain value alone". Coercing it to
                  // 0 would be rejected on chain (a zero floor disables the
                  // control), so keep null distinct from a real zero.
                  setValues({ ...values, [key]: raw === '' ? null : Number(raw) });
                }}
              />
              <small className="text-[#326273]/45">{unit}</small>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-4 rounded-xl border border-[#326273]/15 bg-white/60 px-4 py-3">
        <span className="text-xs font-bold text-[#326273]">DeepBook venues allowed on chain</span>
        {values.poolWhitelistEnforced ? (
          <ul className="mt-2 grid gap-1">
            {values.allowedDeepbookPools.map((poolId) => (
              <li key={poolId} className="font-mono text-xs text-[#326273]/75">
                {poolId}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-[#326273]/70">
            The deployed package predates the venue whitelist, so the liquidity guard still accepts any pool the
            operator passes. Republish to enforce it.
          </p>
        )}
        <p className="mt-2 text-xs text-[#326273]/60">
          Venues change through allow_pool / disallow_pool with the ComplianceCap, not from this form — each change
          emits its own on-chain event.
        </p>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-[#326273]/60">{status || (initial.configured ? 'Loaded from the shared ComplianceConfig.' : 'Configure contract IDs before saving.')}</span>
        <button type="button" onClick={save} disabled={pending || !initial.configured} className="iso-button iso-button-small disabled:cursor-not-allowed disabled:opacity-50">
          {pending ? 'Submitting...' : 'Update on Sui'}
        </button>
      </div>
    </section>
  );
}
