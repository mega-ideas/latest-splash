'use client';

import { Search, Trash2, Upload, UserRoundPlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import DataTable from '@/components/shell/DataTable';
import Inspector, { InspectorField, InspectorSection } from '@/components/shell/Inspector';
import { PageHeader, SummaryStrip, Workspace } from '@/components/shell/PageHeader';
import StatusLabel from '@/components/shell/StatusLabel';
import { Button } from '@/components/system';
import { formatMoney } from '@/lib/money';
import { getNetworkProfile } from '@/lib/network';
import { COUNTRIES, COUNTRY_TO_CURRENCY, type RecipientCountry } from '@/lib/send/state';
import type { RecipientRecord, TransferIntentRecord } from '@/lib/server/operations';
import { cn } from '@/lib/utils';

const field = 'control';

const KYB: Record<RecipientRecord['kybStatus'], { label: string; tone: 'verified' | 'attention' | 'neutral' }> = {
  full: { label: 'Verified', tone: 'verified' },
  lite: { label: 'Beneficiary review', tone: 'attention' },
  none: { label: 'Review required', tone: 'attention' },
};

type Draft = { name: string; country: RecipientCountry; bank: string; swift: string; account: string };
const emptyDraft: Draft = { name: '', country: 'PH', bank: '', swift: '', account: '' };

/**
 * Beneficiaries: verified payout identities, distinct from contacts. Legal
 * identity, account verification, KYB evidence, screening state, allowed
 * corridors and payment history live in the inspector. "Verified" is never
 * set from a client-side toggle — it is the server's KYB state.
 */
export default function BeneficiariesPage() {
  const [recipients, setRecipients] = useState<RecipientRecord[] | null>(null);
  const [transfers, setTransfers] = useState<TransferIntentRecord[]>([]);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const history = useMemo(() => {
    const map = new Map<string, TransferIntentRecord[]>();
    for (const t of transfers) map.set(t.recipientName, [...(map.get(t.recipientName) ?? []), t]);
    return map;
  }, [transfers]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = recipients ?? [];
    if (!needle) return list;
    return list.filter((record) => [record.name, record.country, record.bank, record.account].some((v) => v?.toLowerCase().includes(needle)));
  }, [query, recipients]);

  const selected = (recipients ?? []).find((r) => r.id === selectedId) ?? null;
  const verified = (recipients ?? []).filter((r) => r.kybStatus === 'full').length;
  const coverage = new Set((recipients ?? []).map((r) => r.country.toUpperCase()).filter((code) => corridors.some((c) => c.code === code))).size;

  async function add() {
    if (!draft.name.trim() || !draft.account.trim()) {
      toast.error('Legal name and account number are required');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/recipients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...draft, tier: 'PAYOUT_ONLY', createdVia: 'manual' }) });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? 'Could not save the beneficiary');
      toast.success('Beneficiary added · KYB review opened');
      setDraft(emptyDraft);
      setAdding(false);
      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not save the beneficiary');
    } finally {
      setBusy(false);
    }
  }

  async function remove(record: RecipientRecord) {
    if (!window.confirm(`Remove ${record.name}? Past receipts keep their record.`)) return;
    const response = await fetch(`/api/recipients/${record.id}`, { method: 'DELETE' });
    if (!response.ok) {
      toast.error('Could not remove the beneficiary');
      return;
    }
    toast.success('Beneficiary removed');
    setSelectedId(null);
    await load();
  }

  return (
    <>
      <PageHeader
        title="Beneficiaries"
        supporting="Verify once. Pay with confidence."
        actions={
          <>
            <Button variant="secondary" href="/dashboard/batch">
              <Upload aria-hidden="true" /> Import
            </Button>
            <Button onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
              <UserRoundPlus aria-hidden="true" /> Add beneficiary
            </Button>
          </>
        }
      />

      <SummaryStrip
        items={[
          { label: 'Beneficiaries', value: recipients ? String(recipients.length) : '—' },
          { label: 'Verified', value: recipients ? String(verified) : '—', tone: 'verified', hint: 'KYB complete' },
          { label: 'Review required', value: recipients ? String(recipients.length - verified) : '—', tone: recipients && recipients.length - verified > 0 ? 'attention' : 'default' },
          { label: 'Corridor coverage', value: recipients ? `${coverage} / ${corridors.length}` : '—', hint: corridors.map((c) => c.currency).join(' · ') },
        ]}
      />

      {adding ? (
        <form className="mb-4 grid gap-3 border border-[var(--border-default)] bg-[var(--surface-raised)] p-4" onSubmit={(event) => { event.preventDefault(); void add(); }}>
          <h2 className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">New beneficiary</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-[12px] font-medium text-[var(--text-2)]">
              Legal name
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={field} placeholder="Registered business name" />
            </label>
            <label className="grid gap-1 text-[12px] font-medium text-[var(--text-2)]">
              Country
              <select value={draft.country} onChange={(e) => setDraft({ ...draft, country: e.target.value as RecipientCountry })} className={field}>
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.name} ({COUNTRY_TO_CURRENCY[c.code]})</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[12px] font-medium text-[var(--text-2)]">
              Bank
              <input value={draft.bank} onChange={(e) => setDraft({ ...draft, bank: e.target.value })} className={field} placeholder="Bank name" />
            </label>
            <label className="grid gap-1 text-[12px] font-medium text-[var(--text-2)]">
              SWIFT / BIC
              <input value={draft.swift} onChange={(e) => setDraft({ ...draft, swift: e.target.value.toUpperCase() })} className={cn(field, 'font-mono uppercase')} placeholder="Optional" />
            </label>
            <label className="grid gap-1 text-[12px] font-medium text-[var(--text-2)] md:col-span-2">
              Account number
              <input value={draft.account} onChange={(e) => setDraft({ ...draft, account: e.target.value })} className={cn(field, 'font-mono')} placeholder="Account or reference" />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save beneficiary'}</Button>
            <Button variant="quiet" onClick={() => setAdding(false)}>Cancel</Button>
            <span className="text-[12px] text-[var(--text-muted)]">New beneficiaries start in review. KYB completes before a first payout clears screening.</span>
          </div>
        </form>
      ) : null}

      <div className="mb-3 flex items-center gap-2">
        <label className="relative block w-full max-w-md">
          <span className="sr-only">Search beneficiaries</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden="true" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, country, bank or account" className={cn(field, 'h-9 pl-9 text-[13px]')} />
        </label>
        <span className="ml-auto font-mono text-[11px] text-[var(--text-muted)]">{recipients ? `${filtered.length} of ${recipients.length}` : '—'}</span>
      </div>

      <Workspace
        inspector={selected ? (
          <Inspector kicker="Beneficiary" title={selected.name} subtitle={<StatusLabel compact tone={KYB[selected.kybStatus].tone}>{KYB[selected.kybStatus].label}</StatusLabel>} onClose={() => setSelectedId(null)} actions={<><Button href={`/dashboard/send?recipient=${encodeURIComponent(selected.id)}`} disabled={selected.kybStatus !== 'full'}>Clear a payment</Button><Button variant="destructive" onClick={() => void remove(selected)}><Trash2 aria-hidden="true" /> Remove</Button></>}>
            <InspectorSection title="Legal identity">
              <div className="grid grid-cols-2 gap-2">
                <InspectorField label="Registered name">{selected.name}</InspectorField>
                <InspectorField label="Country">{COUNTRIES.find((c) => c.code === selected.country)?.name ?? selected.country}</InspectorField>
                <InspectorField label="Record" mono>{selected.id}</InspectorField>
                <InspectorField label="Created" mono>{selected.createdAt.slice(0, 10)} · {selected.createdVia === 'invoice_link' ? 'via invoice link' : 'manual'}</InspectorField>
              </div>
            </InspectorSection>
            <InspectorSection title="Account verification">
              <div className="grid grid-cols-2 gap-2">
                <InspectorField label="Bank">{selected.bank || '—'}</InspectorField>
                <InspectorField label="SWIFT / BIC" mono>{selected.swift || '—'}</InspectorField>
                <InspectorField label="Account" mono>{selected.account ? `••••${selected.account.slice(-4)}` : '—'}</InspectorField>
                <InspectorField label="Delivery">{selected.tier === 'PAYOUT_ONLY' ? 'Bank payout' : selected.tier === 'SWEEP_ACCOUNT' ? 'Receive account' : 'Held balance'}</InspectorField>
              </div>
            </InspectorSection>
            <InspectorSection title="KYB evidence">
              <ul className="grid gap-1.5 text-[12.5px]">
                {[
                  ['Business registration', selected.kybStatus === 'full' ? 'complete' : selected.kybStatus === 'lite' ? 'received' : 'missing'],
                  ['Owners and controllers', selected.kybStatus === 'full' ? 'complete' : 'pending'],
                  ['Sanctions screening', selected.kybStatus === 'none' ? 'not run' : 'clear'],
                  ['KYB invite', selected.kybInviteSent ? 'sent' : 'not sent'],
                ].map(([label, value]) => (
                  <li key={label} className="flex items-center justify-between gap-2 border-b border-[var(--border-default)] py-1">
                    <span className="text-[var(--text-2)]">{label}</span>
                    <StatusLabel compact tone={/complete|clear|sent$/.test(value) && value !== 'not sent' ? 'verified' : /missing|not/.test(value) ? 'exception' : 'attention'}>{value}</StatusLabel>
                  </li>
                ))}
              </ul>
            </InspectorSection>
            <InspectorSection title="Allowed corridors">
              <div className="flex flex-wrap gap-1.5">
                {corridors.filter((c) => c.code === selected.country.toUpperCase()).map((c) => (
                  <StatusLabel key={c.code} compact tone="signal">{c.partnerLabel}</StatusLabel>
                ))}
                {!corridors.some((c) => c.code === selected.country.toUpperCase()) ? <StatusLabel compact tone="neutral">No live corridor · modeled</StatusLabel> : null}
              </div>
            </InspectorSection>
            <InspectorSection title="Payment history">
              {(history.get(selected.name) ?? []).length === 0 ? (
                <p className="text-[12.5px] text-[var(--text-2)]">No payments yet.</p>
              ) : (
                <ul className="grid gap-1 text-[12px]">
                  {(history.get(selected.name) ?? []).slice(0, 6).map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-2 border-b border-[var(--border-default)] py-1">
                      <span className="font-mono text-[11px] text-[var(--signal)]">{t.id.slice(0, 14)}</span>
                      <span className="font-mono tabular-nums">{formatMoney('USD', t.sourceAmountUsd)}</span>
                      <span className="text-[var(--text-muted)]">{t.createdAt.slice(0, 10)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </InspectorSection>
          </Inspector>
        ) : undefined}
      >
        <DataTable
          caption="Beneficiaries"
          rows={filtered}
          loading={recipients === null}
          selectedId={selectedId}
          onSelect={(row) => setSelectedId(row.id)}
          emptyState={<div className="text-[13px] text-[var(--text-2)]">No beneficiaries yet. Add a verified counterparty to clear your first payment.</div>}
          columns={[
            { key: 'name', header: 'Beneficiary', render: (r) => <span className="grid"><span className="truncate font-medium">{r.name}</span><span className="truncate font-mono text-[11px] text-[var(--text-muted)]">{r.bank} · ••••{r.account.slice(-4)}</span></span> },
            { key: 'kyb', header: 'Verification', render: (r) => <StatusLabel compact tone={KYB[r.kybStatus].tone}>{KYB[r.kybStatus].label}</StatusLabel> },
            { key: 'corridor', header: 'Corridor', secondary: true, render: (r) => { const c = corridors.find((x) => x.code === r.country.toUpperCase()); return <span className="text-[12px] text-[var(--text-2)]">{c ? c.partnerLabel : `${r.country} · modeled`}</span>; } },
            { key: 'paid', header: 'Payments', numeric: true, align: 'right', render: (r) => String((history.get(r.name) ?? []).length) },
            { key: 'tier', header: 'Delivery', secondary: true, render: (r) => (r.tier === 'PAYOUT_ONLY' ? 'Bank payout' : r.tier === 'SWEEP_ACCOUNT' ? 'Receive account' : 'Held balance') },
          ]}
        />
      </Workspace>
    </>
  );
}
