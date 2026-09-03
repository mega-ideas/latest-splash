'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Badge, Button, EmptyState, Table } from '@/components/system';
import type { BadgeTone } from '@/components/system';
import { EmptyState as IsoEmptyState } from '@/components/illustrations/iso';
import type { TransferIntentRecord } from '@/lib/server/operations';

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function tone(state: string): BadgeTone {
  if (state === 'SETTLED' || state === 'DISBURSED' || state === 'CREDITED') return 'green';
  if (state === 'FAILED' || state === 'REFUNDED' || state === 'REFUNDING') return 'red';
  return 'amber';
}

const LABEL: Record<string, string> = {
  AUTHORIZED: 'Intent created',
  DEPOSIT_CONFIRMED: 'Funded',
  SETTLED: 'Settled on Sui',
  SWEEPING: 'Delivering',
  DISBURSED: 'Paid out',
  CREDITED: 'Paid out',
  FAILED: 'Returned',
  REFUNDING: 'Returning',
  REFUNDED: 'Returned',
};

/** Every payout with its receipt and proof; the daily audit batches stay on History. */
export default function ReceiptsPage() {
  const [rows, setRows] = useState<TransferIntentRecord[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'successful' | 'pending' | 'failed'>('all');

  useEffect(() => {
    let active = true;
    fetch(`/api/transfers?filter=${filter}&export=true`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((body: { items: TransferIntentRecord[] }) => {
        if (active) setRows(body.items);
      })
      .catch(() => {
        if (active) setRows([]);
      });
    return () => {
      active = false;
    };
  }, [filter]);

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[var(--text-h1)] font-semibold leading-[1.1] tracking-[-0.02em]">Receipts</h1>
          <p className="mt-1 text-[14px] text-[var(--text-2)]">Every payout with its settlement digest and delivery evidence.</p>
        </div>
        <Link href="/dashboard/history" className="text-[13px] font-medium text-[var(--teal-600)] underline underline-offset-4">
          Daily audit batches
        </Link>
      </header>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter receipts">
        {(['all', 'successful', 'pending', 'failed'] as const).map((value) => (
          <Button key={value} size="sm" variant={filter === value ? 'primary' : 'ghost'} onClick={() => setFilter(value)} aria-pressed={filter === value}>
            {value === 'all' ? 'All' : value === 'successful' ? 'Settled' : value === 'pending' ? 'In progress' : 'Returned'}
          </Button>
        ))}
      </div>

      <Table
        caption="Receipts"
        exportName="receipts"
        rows={rows ?? []}
        loading={rows === null}
        emptyState={<EmptyState art={<IsoEmptyState kind="receipts" decorative />} title="No receipts yet" body="Receipts appear here as soon as a payout is authorised." action={<Button size="sm" href="/dashboard/transfer">Send USD</Button>} />}
        columns={[
          { key: 'createdAt', header: 'When', mono: true, secondary: true, value: (row) => row.createdAt, render: (row) => row.createdAt.slice(0, 16).replace('T', ' ') },
          { key: 'recipientName', header: 'Recipient', value: (row) => row.recipientName },
          { key: 'corridor', header: 'Corridor', value: (row) => `USD → ${row.targetCurrency}`, render: (row) => `USD → ${row.targetCurrency}` },
          {
            key: 'amount',
            header: 'Amount (USD)',
            align: 'right',
            mono: true,
            value: (row) => row.sourceAmountUsd,
            render: (row) => (
              <Link href={`/dashboard/receipts/${row.id}`} className="underline decoration-[var(--line)] underline-offset-4 hover:decoration-[var(--teal-600)]">
                {money.format(Number.parseFloat(row.sourceAmountUsd || '0'))}
              </Link>
            ),
          },
          { key: 'state', header: 'State', value: (row) => LABEL[row.state] ?? row.state, render: (row) => <Badge tone={tone(row.state)}>{LABEL[row.state] ?? 'In progress'}</Badge> },
          { key: 'digest', header: 'Sui digest', mono: true, secondary: true, value: (row) => row.suiTxDigest ?? '', render: (row) => (row.suiTxDigest ? `${row.suiTxDigest.slice(0, 10)}…` : '—') },
        ]}
        rowAction={(row) => (
          <Button href={`/dashboard/receipts/${row.id}`} variant="ghost" size="sm">
            Open
          </Button>
        )}
      />
    </div>
  );
}
