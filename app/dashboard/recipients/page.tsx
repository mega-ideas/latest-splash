'use client';

import { Search, Trash2, UserRoundPlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { EmptyState as IsoEmptyState } from '@/components/illustrations/iso';
import { Badge, Button, Card, Chip, EmptyState, Stat, Table } from '@/components/system';
import type { BadgeTone } from '@/components/system';
import { getNetworkProfile } from '@/lib/network';
import { COUNTRIES, COUNTRY_TO_CURRENCY, type RecipientCountry } from '@/lib/send/state';
import type { RecipientRecord, TransferIntentRecord } from '@/lib/server/operations';
import { cn } from '@/lib/utils';

const fieldClass =
  'h-11 w-full rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface)] px-3 text-[16px] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--teal-600)]';

const KYB_LABEL: Record<RecipientRecord['kybStatus'], { label: string; tone: BadgeTone }> = {
  full: { label: 'Verified', tone: 'green' },
  lite: { label: 'Partially verified', tone: 'amber' },
  none: { label: 'Unverified', tone: 'slate' },
};

type Draft = { name: string; country: RecipientCountry; bank: string; swift: string; account: string };
const emptyDraft: Draft = { name: '', country: 'PH', bank: '', swift: '', account: '' };

/**
 * Recipients: verified counterparties, their verification state, how often
 * they have been paid, and which corridors reach them. Payouts only go to
 * records on this list.
 */
export default function RecipientsPage() {
  const [recipients, setRecipients] = useState<RecipientRecord[] | null>(null);
  const [transfers, setTransfers] = useState<TransferIntentRecord[]>([]);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const corridors = getNetworkProfile().corridors;

  async function load() {
    const [recipientsRes, transfersRes] = await Promise.all([fetch('/api/recipients', { cache: 'no-store' }), fetch('/api/transfers?filter=all', { cache: 'no-store' })]);
    setRecipients(recipientsRes.ok ? ((await recipientsRes.json()) as RecipientRecord[]) : []);
    setTransfers(transfersRes.ok ? ((await transfersRes.json()) as { items: TransferIntentRecord[] }).items : []);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const reuse = useMemo(() => {
    const counts = new Map<string, number>();
    for (const transfer of transfers) counts.set(transfer.recipientName, (counts.get(transfer.recipientName) ?? 0) + 1);
    return counts;
  }, [transfers]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = recipients ?? [];
    if (!needle) return list;
    return list.filter((record) => [record.name, record.country, record.bank, record.account].some((field) => field?.toLowerCase().includes(needle)));
  }, [query, recipients]);

  const verified = (recipients ?? []).filter((record) => record.kybStatus === 'full').length;
  const coverage = new Set((recipients ?? []).map((record) => record.country.toUpperCase()).filter((code) => corridors.some((corridor) => corridor.code === code))).size;

  async function add() {
    if (!draft.name.trim() || !draft.account.trim()) {
      toast.error('Name and account number are required');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/recipients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, tier: 'PAYOUT_ONLY', createdVia: 'manual' }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? 'Could not save the recipient');
      }
      toast.success('Recipient added');
      setDraft(emptyDraft);
      setAdding(false);
      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not save the recipient');
    } finally {
      setBusy(false);
    }
  }

  async function remove(record: RecipientRecord) {
    if (!window.confirm(`Remove ${record.name} from recipients? Past receipts keep their record.`)) return;
    const response = await fetch(`/api/recipients/${record.id}`, { method: 'DELETE' });
    if (!response.ok) {
      toast.error('Could not remove the recipient');
      return;
    }
    toast.success('Recipient removed');
    await load();
  }

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[var(--text-h1)] font-semibold leading-[1.1] tracking-[-0.02em]">Recipients</h1>
          <p className="mt-1 text-[14px] text-[var(--text-2)]">Verified counterparties. A payout can only go to a record on this list.</p>
        </div>
        <Button onClick={() => setAdding((value) => !value)} aria-expanded={adding}>
          <UserRoundPlus aria-hidden="true" /> Add recipient
        </Button>
      </header>

      <section className="grid gap-4 sm:grid-cols-3" aria-label="Recipient summary">
        <Card padding="sm">
          <Stat label="Recipients" value={recipients ? String(recipients.length) : null} loading={recipients === null} />
        </Card>
        <Card padding="sm">
          <Stat label="Verified" value={recipients ? String(verified) : null} tone="positive" loading={recipients === null} sub="KYB complete" />
        </Card>
        <Card padding="sm">
          <Stat label="Corridor coverage" value={recipients ? `${coverage} / ${corridors.length}` : null} loading={recipients === null} sub={corridors.map((corridor) => corridor.currency).join(' · ')} />
        </Card>
      </section>

      {adding ? (
        <Card className="grid gap-4">
          <h2 className="text-[15px] font-semibold">New recipient</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-[14px] font-semibold">
              Business name
              <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className={fieldClass} placeholder="Supplier legal name" />
            </label>
            <label className="grid gap-1 text-[14px] font-semibold">
              Country
              <select value={draft.country} onChange={(event) => setDraft({ ...draft, country: event.target.value as RecipientCountry })} className={fieldClass}>
                {COUNTRIES.map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.name} ({COUNTRY_TO_CURRENCY[country.code]})
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[14px] font-semibold">
              Bank
              <input value={draft.bank} onChange={(event) => setDraft({ ...draft, bank: event.target.value })} className={fieldClass} placeholder="Bank name" />
            </label>
            <label className="grid gap-1 text-[14px] font-semibold">
              SWIFT / BIC
              <input value={draft.swift} onChange={(event) => setDraft({ ...draft, swift: event.target.value.toUpperCase() })} className={cn(fieldClass, 'font-mono uppercase')} placeholder="Optional" />
            </label>
            <label className="grid gap-1 text-[14px] font-semibold md:col-span-2">
              Account number
              <input value={draft.account} onChange={(event) => setDraft({ ...draft, account: event.target.value })} className={cn(fieldClass, 'font-mono')} placeholder="Account or reference" />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void add()} disabled={busy}>
              {busy ? 'Saving…' : 'Save recipient'}
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
          <p className="text-[12px] text-[var(--text-muted)]">New recipients start unverified. KYB on the counterparty completes before a first payout clears screening.</p>
        </Card>
      ) : null}

      <label className="relative block max-w-md">
        <span className="sr-only">Search recipients</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, country or bank" className={cn(fieldClass, 'pl-10')} />
      </label>

      <Table
        caption="Counterparties"
        exportName="recipients"
        rows={filtered}
        loading={recipients === null}
        emptyState={<EmptyState art={<IsoEmptyState kind="recipients" decorative />} title="No recipients yet" body="Add a verified counterparty to send your first payout." action={<Button size="sm" onClick={() => setAdding(true)}>Add recipient</Button>} />}
        columns={[
          { key: 'name', header: 'Recipient', value: (row) => row.name, render: (row) => (
            <span className="grid">
              <span className="font-medium">{row.name}</span>
              <span className="font-mono text-[12px] text-[var(--text-muted)]">{row.bank} · {row.account}</span>
            </span>
          ) },
          { key: 'kyb', header: 'Verification', value: (row) => KYB_LABEL[row.kybStatus].label, render: (row) => <Badge tone={KYB_LABEL[row.kybStatus].tone}>{KYB_LABEL[row.kybStatus].label}</Badge> },
          { key: 'corridor', header: 'Corridor', value: (row) => row.country, render: (row) => {
            const corridor = corridors.find((entry) => entry.code === row.country.toUpperCase());
            return corridor ? <Chip tone="teal">{corridor.partnerLabel}</Chip> : <Chip ghost>{row.country} · modeled</Chip>;
          } },
          { key: 'reuse', header: 'Paid', align: 'right', mono: true, value: (row) => reuse.get(row.name) ?? 0, render: (row) => `${reuse.get(row.name) ?? 0}×` },
          { key: 'tier', header: 'Delivery', secondary: true, value: (row) => row.tier, render: (row) => (row.tier === 'PAYOUT_ONLY' ? 'Bank payout' : row.tier === 'SWEEP_ACCOUNT' ? 'Receive account' : 'Splash balance') },
        ]}
        rowAction={(row) => (
          <div className="flex justify-end gap-1">
            <Button href={`/dashboard/send?recipient=${encodeURIComponent(row.id)}`} variant="ghost" size="sm">
              Pay
            </Button>
            <Button variant="destructive-text" size="sm" onClick={() => void remove(row)} aria-label={`Remove ${row.name}`}>
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        )}
      />
    </div>
  );
}
