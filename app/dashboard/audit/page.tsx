'use client';

import { Download } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import DataTable from '@/components/shell/DataTable';
import Inspector, { InspectorField, InspectorSection } from '@/components/shell/Inspector';
import { PageHeader, SummaryStrip, Workspace } from '@/components/shell/PageHeader';
import StatusLabel from '@/components/shell/StatusLabel';
import { Button } from '@/components/system';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

type AuditEvent = {
  id: string;
  name: string;
  actorHash: string | null;
  subjectHash: string | null;
  corridor: string | null;
  amountMinor: number | string | null;
  currency: string | null;
  props: Record<string, string | number | boolean | null>;
  occurredAt: string;
};

const field = 'h-8 rounded-[var(--r-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2 text-[12.5px] text-[var(--text)] focus:border-[var(--signal)] focus:outline-none';

function label(name: string) {
  return name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Audit log: an attributable, append-only record of material activity.
 * Nothing on this page edits anything. Actors and subjects are hashed at
 * write time; amounts are shown in minor units with their currency.
 */
export default function AuditLogPage() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [days, setDays] = useState('30');
  const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/events?days=${encodeURIComponent(days)}${name ? `&name=${encodeURIComponent(name)}` : ''}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      setEvents(((await response.json()) as { items: AuditEvent[] }).items);
      setError(null);
    } catch {
      setEvents([]);
      setError('The audit log could not be read. Retry, or check the events store.');
    }
  }, [days, name]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const names = useMemo(() => [...new Set((events ?? []).map((e) => e.name))].sort(), [events]);
  const selected = (events ?? []).find((e) => e.id === selectedId) ?? null;
  const money = (events ?? []).filter((e) => e.amountMinor !== null && e.amountMinor !== undefined);

  function exportCsv() {
    const rows = (events ?? []).map((e) => [e.occurredAt, e.name, e.actorHash ?? '', e.subjectHash ?? '', e.corridor ?? '', e.amountMinor ?? '', e.currency ?? '', JSON.stringify(e.props)].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const csv = ['occurred_at,event,actor_hash,subject_hash,corridor,amount_minor,currency,props', ...rows].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        title="Audit log"
        supporting="An attributable record of every material action."
        actions={
          <Button variant="secondary" onClick={exportCsv} disabled={!events || events.length === 0}>
            <Download aria-hidden="true" /> Export log
          </Button>
        }
      />

      {error ? (
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 border border-[var(--state-attention)] bg-[var(--surface-attention)] px-3 py-2 text-[13px] text-[var(--state-attention)]">
          {error}
          <Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>
        </div>
      ) : null}

      <SummaryStrip
        items={[
          { label: 'Events in window', value: events ? String(events.length) : '—', hint: `last ${days} days` },
          { label: 'Money-state events', value: events ? String(money.length) : '—', hint: 'emitted server-side' },
          { label: 'Distinct event types', value: events ? String(names.length) : '—' },
          { label: 'Editable actions', value: '0', tone: 'verified', hint: 'append-only' },
        ]}
      />

      <form className="mb-3 flex flex-wrap items-end gap-2" onSubmit={(event) => event.preventDefault()}>
        <label className="grid gap-1 text-[11px] font-medium text-[var(--text-2)]">
          Window
          <select value={days} onChange={(event) => setDays(event.target.value)} className={field}>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-medium text-[var(--text-2)]">
          Event
          <select value={name} onChange={(event) => setName(event.target.value)} className={field}>
            <option value="">All</option>
            {names.map((n) => (
              <option key={n} value={n}>{label(n)}</option>
            ))}
          </select>
        </label>
      </form>

      <Workspace
        inspector={selected ? (
          <Inspector kicker="Event" title={label(selected.name)} subtitle={<span className="font-mono text-[11px]">{selected.occurredAt.replace('T', ' ').slice(0, 19)} UTC</span>} onClose={() => setSelectedId(null)}>
            <InspectorSection title="Attribution">
              <div className="grid grid-cols-2 gap-2">
                <InspectorField label="Actor (hashed)" mono>{selected.actorHash ?? '—'}</InspectorField>
                <InspectorField label="Object (hashed)" mono>{selected.subjectHash ?? '—'}</InspectorField>
                <InspectorField label="Corridor" mono>{selected.corridor ?? '—'}</InspectorField>
                <InspectorField label="Amount" mono>{selected.amountMinor !== null && selected.currency ? formatMoney(selected.currency, Number(selected.amountMinor) / 100) : '—'}</InspectorField>
              </div>
            </InspectorSection>
            <InspectorSection title="Record">
              <div className="grid gap-2">
                <InspectorField label="Event id" mono>{selected.id}</InspectorField>
                <InspectorField label="Properties" mono>
                  <pre className="whitespace-pre-wrap break-all text-[11px]">{JSON.stringify(selected.props, null, 2)}</pre>
                </InspectorField>
              </div>
            </InspectorSection>
            <p className="mt-4 text-[12px] text-[var(--text-2)]">Events are written at the money-state transition by the server and cannot be edited or deleted from any surface.</p>
          </Inspector>
        ) : undefined}
      >
        <DataTable
          caption="Audit events"
          rows={events ?? []}
          loading={events === null}
          selectedId={selectedId}
          onSelect={(row) => setSelectedId(row.id)}
          emptyState={<div className="text-[13px] text-[var(--text-2)]">No events in this window. Money-state transitions and agent sessions appear here as they happen.</div>}
          columns={[
            { key: 'when', header: 'Occurred (UTC)', width: '170px', render: (e) => <span className="font-mono text-[11.5px]">{e.occurredAt.replace('T', ' ').slice(0, 19)}</span> },
            { key: 'name', header: 'Event', render: (e) => <StatusLabel compact tone={e.amountMinor !== null ? 'signal' : 'neutral'}>{label(e.name)}</StatusLabel> },
            { key: 'actor', header: 'Actor', secondary: true, render: (e) => <span className="font-mono text-[11px] text-[var(--text-2)]">{e.actorHash ? `${e.actorHash.slice(0, 12)}…` : '—'}</span> },
            { key: 'subject', header: 'Object', secondary: true, render: (e) => <span className="font-mono text-[11px] text-[var(--text-2)]">{e.subjectHash ? `${e.subjectHash.slice(0, 12)}…` : '—'}</span> },
            { key: 'corridor', header: 'Corridor', secondary: true, render: (e) => <span className="font-mono text-[11.5px]">{e.corridor ?? '—'}</span> },
            { key: 'amount', header: 'Amount', numeric: true, align: 'right', render: (e) => <span className={cn(e.amountMinor === null && 'text-[var(--text-muted)]')}>{e.amountMinor !== null && e.currency ? formatMoney(e.currency, Number(e.amountMinor) / 100) : '—'}</span> },
          ]}
        />
      </Workspace>
    </>
  );
}
