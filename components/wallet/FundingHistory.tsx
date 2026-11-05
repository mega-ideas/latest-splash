'use client';

import { useState } from 'react';

import { call, errorText } from '@/components/transfer/api';
import { QuietButton } from '@/components/transfer/ui';
import LocalTime from '@/components/LocalTime';
import { fundingHistory, type DepositLine } from '@/lib/wallet-page/labels';
import { Card, Loading, Note, Pill, useLoad } from './parts';
import type { Deposit } from './types';

/**
 * Funding history (v2 brief 4.3, 5.5): what arrived in the business wallet,
 * whether it is ready to use, held or blocked, and why. Coins that arrive as
 * something other than USDC (USDT, USDsui) are their own list: they are
 * shown as the coin that arrived and never counted as USDC.
 */
export default function FundingHistory({ refreshKey }: { refreshKey: number }) {
  const data = useLoad<{ deposits: Deposit[] }>(`/api/wallet/funding/deposits?k=${refreshKey}`, 'Your funding history could not be loaded.');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (data.loading) return <Card id="funding-history" title="Funding history"><Loading label="Loading…" /></Card>;
  if (!data.data) return <Card id="funding-history" title="Funding history"><Note tone="error">{data.error}</Note></Card>;
  const deposits = data.data.deposits;
  const history = fundingHistory(deposits);
  async function lookAgain(id: string) {
    setBusyId(id);
    setError(null);
    const answer = await call(`/api/wallet/funding/deposits/${encodeURIComponent(id)}`, { method: 'POST', body: {} });
    setBusyId(null);
    if (!answer.ok) setError(errorText(answer, 'It could not be checked again.'));
    else data.reload();
  }

  const row = (line: DepositLine & { item: Deposit }) => (
    <li key={line.item.id} className="rounded-xl border border-[#326273]/12 bg-white p-3 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-sm font-semibold tabular-nums text-[#0c3e48]">{line.amount}</span>
        <Pill tone={line.tone}>{line.state}</Pill>
      </div>
      {line.when ? <p className="mt-0.5 text-[#326273]"><LocalTime value={line.when} options={{ dateStyle: 'medium', timeStyle: 'short' }} /></p> : null}
      {line.note ? <p className="mt-1 text-[#326273]">{line.note}</p> : null}
      {line.reasons.length > 0 ? <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[#1F4452]">{line.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
      {line.state === 'Held, not spent' ? (
        <div className="mt-2"><QuietButton type="button" disabled={busyId === line.item.id} onClick={() => void lookAgain(line.item.id)}>{busyId === line.item.id ? 'Checking…' : 'Check again'}</QuietButton></div>
      ) : null}
    </li>
  );

  return (
    <Card id="funding-history" title="Funding history">
      {deposits.length === 0 ? (
        <Note>Nothing has arrived yet. When you add funds, each arrival is listed here with its screening result.</Note>
      ) : (
        <div className="space-y-4">
          {error ? <Note tone="error">{error}</Note> : null}
          <ul className="space-y-2" aria-label="USDC arrivals">{history.usdc.map(row)}</ul>
          {history.converted.length > 0 ? (
            <div>
              <h3 className="text-[13px] font-extrabold text-[#0c3e48]">Other coins that arrived</h3>
              <ul className="mt-2 space-y-2">{history.converted.map(row)}</ul>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
