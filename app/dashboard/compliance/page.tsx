'use client';

import { FolderOpen, Download } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import DataTable from '@/components/shell/DataTable';
import Inspector, { InspectorField, InspectorSection } from '@/components/shell/Inspector';
import { GroupHeading, PageHeader, SummaryStrip, Workspace } from '@/components/shell/PageHeader';
import StatusLabel from '@/components/shell/StatusLabel';
import { Button } from '@/components/system';
import { formatMoney } from '@/lib/money';
import { fromTransfer, shortTime } from '@/lib/payments/clearance';
import type { RecipientRecord, TransferIntentRecord } from '@/lib/server/operations';

type Case = {
  id: string;
  kind: 'Beneficiary review' | 'Payment exception' | 'Screening';
  subject: string;
  exposure: string;
  source: string;
  confidence: string;
  state: 'Review required' | 'Blocked' | 'Verified' | 'Returned';
  opened: string;
  evidence: Array<{ label: string; ref: string | null }>;
  next: string;
  paymentHref?: string;
};

/**
 * Compliance: resolve risk without losing the payment context. Cases are
 * derived from what the system already knows — beneficiaries whose KYB is
 * incomplete, payouts that failed or were returned, funding that KYT
 * flagged — never from a client-side toggle. Red is for a confirmed block,
 * not every open case.
 */
export default function CompliancePage() {
  const [recipients, setRecipients] = useState<RecipientRecord[] | null>(null);
  const [transfers, setTransfers] = useState<TransferIntentRecord[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void Promise.all([fetch('/api/recipients', { cache: 'no-store' }), fetch('/api/transfers?filter=all', { cache: 'no-store' })]).then(async ([r, t]) => {
        setRecipients(r.ok ? ((await r.json()) as RecipientRecord[]) : []);
        setTransfers(t.ok ? ((await t.json()) as { items: TransferIntentRecord[] }).items : []);
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const cases = useMemo<Case[]>(() => {
    const out: Case[] = [];
    for (const r of recipients ?? []) {
      if (r.kybStatus === 'full') continue;
      out.push({
        id: `CASE-BEN-${r.id.slice(-6).toUpperCase()}`,
        kind: 'Beneficiary review',
        subject: r.name,
        exposure: '—',
        source: r.kybStatus === 'lite' ? 'KYB partially complete' : 'KYB not started',
        confidence: r.kybStatus === 'lite' ? 'Documents received' : 'No documents',
        state: 'Review required',
        opened: r.createdAt,
        evidence: [
          { label: 'Beneficiary record', ref: `REC-${r.id.slice(-6).toUpperCase()}` },
          { label: 'KYB invite', ref: r.kybInviteSent ? 'sent' : null },
          { label: 'Bank account', ref: r.account ? `${r.bank} · ${r.account.slice(-4)}` : null },
        ],
        next: 'Complete KYB before the first payout clears screening.',
      });
    }
    for (const t of transfers ?? []) {
      const record = fromTransfer(t);
      const blocked = t.fundingKytStatus === 'blocked';
      if (record.group !== 'attention' && !blocked) continue;
      out.push({
        id: `CASE-PAY-${t.id.slice(-6).toUpperCase()}`,
        kind: blocked ? 'Screening' : 'Payment exception',
        subject: t.recipientName,
        exposure: formatMoney('USD', t.sourceAmountUsd),
        source: blocked ? 'KYT screening' : t.failedAtState ? `Failed at ${t.failedAtState}` : 'Returned by rail',
        confidence: blocked ? 'Match on funding source' : 'Rail confirmation',
        state: blocked ? 'Blocked' : record.status === 'Returned' ? 'Returned' : 'Review required',
        opened: t.updatedAt,
        evidence: [
          { label: 'Payment', ref: t.id.slice(0, 16) },
          { label: 'Failure reason', ref: t.failureReason },
          { label: 'Sui digest', ref: t.suiTxDigest ? `${t.suiTxDigest.slice(0, 10)}…` : null },
        ],
        next: blocked ? 'Funds remain unexecuted while this case is open.' : 'Review the rail reason, then clear and resume or return to maker.',
        paymentHref: `/dashboard/receipts/${t.id}`,
      });
    }
    return out.sort((a, b) => (b.opened > a.opened ? 1 : -1));
  }, [recipients, transfers]);

  const loading = recipients === null || transfers === null;
  const selected = cases.find((c) => c.id === selectedId) ?? null;
  const open = cases.filter((c) => c.state !== 'Verified');
  const blocked = cases.filter((c) => c.state === 'Blocked');

  return (
    <>
      <PageHeader
        title="Compliance"
        supporting="Resolve risk without losing the payment context."
        actions={
          <>
            <Button variant="secondary" disabled>
              <Download aria-hidden="true" /> Export review log
            </Button>
            <Button href="/settings/kyb">
              <FolderOpen aria-hidden="true" /> Workspace verification
            </Button>
          </>
        }
      />

      <SummaryStrip
        items={[
          { label: 'Open cases', value: loading ? '—' : String(open.length), tone: open.length > 0 ? 'attention' : 'default' },
          { label: 'Confirmed blocks', value: loading ? '—' : String(blocked.length), tone: blocked.length > 0 ? 'exception' : 'default' },
          { label: 'Beneficiaries verified', value: loading ? '—' : `${(recipients ?? []).filter((r) => r.kybStatus === 'full').length} / ${(recipients ?? []).length}` },
          { label: 'Funds at risk', value: loading ? '—' : formatMoney('USD', (transfers ?? []).filter((t) => fromTransfer(t).group === 'attention').reduce((s, t) => s + Number.parseFloat(t.sourceAmountUsd || '0'), 0)), hint: 'Unexecuted or returned' },
        ]}
      />

      <Workspace
        inspector={selected ? (
          <Inspector kicker="Case" title={`${selected.id} · ${selected.subject}`} subtitle={<StatusLabel compact>{selected.state}</StatusLabel>} onClose={() => setSelectedId(null)} actions={selected.paymentHref ? <><Button href={selected.paymentHref}>Open clearance record</Button><Button variant="secondary" href="/dashboard/recipients">Open beneficiary</Button></> : <><Button href="/dashboard/recipients">Open beneficiary</Button><Button variant="secondary" href="/settings/kyb">Verification</Button></>}>
            <InspectorSection title="Risk">
              <div className="grid grid-cols-2 gap-2">
                <InspectorField label="Source">{selected.source}</InspectorField>
                <InspectorField label="Match confidence">{selected.confidence}</InspectorField>
                <InspectorField label="Exposure" mono>{selected.exposure}</InspectorField>
                <InspectorField label="Opened" mono>{shortTime(selected.opened) ?? '—'}</InspectorField>
              </div>
            </InspectorSection>
            <InspectorSection title="Evidence">
              <dl className="grid gap-1.5 text-[12.5px]">
                {selected.evidence.map((item) => (
                  <div key={item.label} className="flex items-center justify-between gap-2 border-b border-[var(--border-default)] py-1">
                    <dt className="text-[var(--text-2)]">{item.label}</dt>
                    <dd className="font-mono text-[11.5px]">{item.ref ?? '—'}</dd>
                  </div>
                ))}
              </dl>
            </InspectorSection>
            <InspectorSection title="Next action">
              <p className="border border-[var(--border-default)] bg-[var(--surface-raised)] px-3 py-2 text-[12.5px]">{selected.next}</p>
              {selected.state !== 'Verified' ? <p className="mt-2 text-[12px] text-[var(--state-attention)]">Funds remain unexecuted while this case is open.</p> : null}
            </InspectorSection>
          </Inspector>
        ) : undefined}
      >
        <GroupHeading label="Open cases" count={loading ? undefined : open.length} tone={open.length > 0 ? 'signal' : 'default'} />
        <DataTable
          caption="Compliance cases"
          rows={open}
          loading={loading}
          selectedId={selectedId}
          onSelect={(row) => setSelectedId(row.id)}
          emptyState={<div className="text-[13px] text-[var(--text-2)]">No open cases. Beneficiaries with incomplete KYB and payments returned by a rail appear here.</div>}
          columns={[
            { key: 'id', header: 'Case', width: '150px', render: (c) => <span className="font-mono text-[12px] text-[var(--signal)]">{c.id}</span> },
            { key: 'kind', header: 'Type', render: (c) => c.kind },
            { key: 'subject', header: 'Subject', render: (c) => <span className="font-medium">{c.subject}</span> },
            { key: 'source', header: 'Risk source', secondary: true, render: (c) => <span className="text-[var(--text-2)]">{c.source}</span> },
            { key: 'exposure', header: 'Exposure', numeric: true, align: 'right', render: (c) => c.exposure },
            { key: 'opened', header: 'Opened', secondary: true, render: (c) => <span className="font-mono text-[11.5px] text-[var(--text-2)]">{c.opened.slice(0, 16).replace('T', ' ')}</span> },
            { key: 'state', header: 'State', render: (c) => <StatusLabel>{c.state}</StatusLabel> },
          ]}
        />
      </Workspace>
    </>
  );
}
