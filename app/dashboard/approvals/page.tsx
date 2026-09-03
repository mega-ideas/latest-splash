'use client';

import { Check, Settings2, X } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import ClearanceProgress from '@/components/shell/ClearanceProgress';
import DataTable from '@/components/shell/DataTable';
import EvidenceList from '@/components/shell/EvidenceList';
import Inspector, { InspectorField, InspectorSection } from '@/components/shell/Inspector';
import { GroupHeading, PageHeader, SummaryStrip, Workspace } from '@/components/shell/PageHeader';
import StatusLabel from '@/components/shell/StatusLabel';
import { Button } from '@/components/system';
import { brand } from '@/lib/brand';
import { formatMoney } from '@/lib/money';
import { recordPendingProposals } from '@/lib/oxwal-notify';
import { fromProposal, shortTime, type ProposalSummary } from '@/lib/payments/clearance';
import { cn } from '@/lib/utils';

type Settings = {
  perTransferLimitUsd: number;
  dailyLimitUsd: number;
  approvalThresholdUsd: number;
  requireTotp: boolean;
  requireDualApproval: boolean;
  blockHighRiskCorridors: boolean;
};

const KIND_LABEL: Record<string, string> = {
  PAYMENT: 'Payment',
  INTERNAL_TRANSFER: 'Internal transfer',
  FX_CONVERT: 'FX conversion',
  TREASURY_ALLOCATE: 'Treasury allocation',
  TREASURY_REDEEM: 'Treasury withdrawal',
  BATCH_PAYOUT: 'Batch payout',
  NETTING_SETTLE: 'Offset simulation (roadmap)',
};

const HISTORY_LABEL: Record<string, string> = {
  APPROVED: 'Approved',
  SIGNED: 'Approved',
  SUBMITTED: 'Executing',
  EXECUTED: 'Credited',
  ANCHORED: 'Reconciled',
  REJECTED: 'Returned',
  FAILED: 'Exception',
  EXPIRED: 'Quote expired',
  REVERSED: 'Returned',
};

/** Why approval is required, in plain words, from the server's own controls. */
function reasonRequired(proposal: ProposalSummary, settings: Settings | null): string {
  if (!settings) return 'Policy evaluated server-side';
  const amount = Number.parseFloat((proposal.amountLabel ?? '0').replace(/[^0-9.]/g, ''));
  if (proposal.evidenceQuality === 'untrusted') return 'Untrusted evidence · manual review';
  if (proposal.requiredApprovers > 1) return `Dual approval · amount ≥ ${formatMoney('USD', settings.approvalThresholdUsd)}`;
  if (Number.isFinite(amount) && amount > settings.perTransferLimitUsd) return `Over per-transfer limit (${formatMoney('USD', settings.perTransferLimitUsd)})`;
  return 'Every money movement needs a checker distinct from the maker';
}

/**
 * Approvals: an authorised checker makes a bounded decision. Maker, checker,
 * why approval is required, evidence completeness, quote expiry, policy
 * outcome and immutable ids are all in view; the decision goes through the
 * one real path (POST /api/proposals/[id]/submit) bound to the approval hash
 * the checker saw. Approval is separate from execution.
 */
export default function ApprovalsPage() {
  return (
    <Suspense fallback={null}>
      <ApprovalsDesk />
    </Suspense>
  );
}

function ApprovalsDesk() {
  const params = useSearchParams();
  const [queue, setQueue] = useState<ProposalSummary[] | null>(null);
  const [history, setHistory] = useState<ProposalSummary[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(params.get('id'));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [tab, setTab] = useState<'queue' | 'history'>('queue');
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    const [queueRes, historyRes, settingsRes] = await Promise.all([
      fetch('/api/proposals', { cache: 'no-store' }),
      fetch('/api/proposals?scope=history', { cache: 'no-store' }),
      fetch('/api/settings', { cache: 'no-store' }),
    ]);
    setNow(Date.now());
    const open = queueRes.ok ? ((await queueRes.json()) as { items: ProposalSummary[] }).items : [];
    setQueue(open);
    setHistory(historyRes.ok ? ((await historyRes.json()) as { items: ProposalSummary[] }).items : []);
    if (settingsRes.ok) setSettings((await settingsRes.json()) as Settings);
    recordPendingProposals({ count: open.length, label: open[0]?.recommendation ?? null });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => void load(), 15_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [load]);

  const rows = useMemo(() => (tab === 'queue' ? queue ?? [] : history ?? []), [tab, queue, history]);
  const selected = [...(queue ?? []), ...(history ?? [])].find((p) => p.id === selectedId) ?? null;
  const record = selected ? fromProposal(selected) : null;
  const isOpen = Boolean(selected && (queue ?? []).some((p) => p.id === selected.id));
  const expired = Boolean(selected?.expiresAt && new Date(selected.expiresAt).getTime() < now);
  const loading = queue === null || history === null;

  async function decide(decision: 'APPROVE' | 'REJECT') {
    if (!selected) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/proposals/${encodeURIComponent(selected.id)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signatureRef: `sig_desk_${selected.id}`, decision, approvalHash: selected.approvalHash ?? undefined, reason: reason || undefined }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string; status?: string };
      if (!response.ok) throw new Error(body.error ?? body.message ?? 'Decision was not recorded');
      const remaining = Math.max(0, (queue?.length ?? 1) - 1);
      const text = decision === 'APPROVE' ? `Approved — ${remaining} remaining` : `Returned to maker — ${remaining} remaining`;
      setAnnouncement(text);
      toast.success(body.message ?? text);
      setSelectedId(null);
      setReason('');
      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Decision was not recorded');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <PageHeader
        title="Approvals"
        supporting="Maker-checker control for every material movement."
        actions={
          <Button variant="secondary" href="/dashboard/settings?tab=security">
            <Settings2 aria-hidden="true" /> Approval settings
          </Button>
        }
      />

      <SummaryStrip
        items={[
          { label: 'Awaiting checker', value: queue ? String(queue.length) : '—', tone: queue && queue.length > 0 ? 'attention' : 'default' },
          { label: 'Decided (history)', value: history ? String(history.length) : '—' },
          { label: 'Threshold', value: settings ? formatMoney('USD', settings.approvalThresholdUsd) : '—', hint: settings?.requireDualApproval ? 'dual approval on' : 'dual approval off' },
          { label: 'TOTP on approval', value: settings ? (settings.requireTotp ? 'Required' : 'Off') : '—', tone: settings?.requireTotp ? 'verified' : 'attention' },
        ]}
      />

      <Workspace
        inspector={selected && record ? (
          <Inspector
            kicker={isOpen ? 'Decision' : 'Decided'}
            title={`${selected.id.slice(0, 18)} · ${KIND_LABEL[selected.kind] ?? selected.kind}`}
            subtitle={<StatusLabel compact>{isOpen ? (expired ? 'Quote expired' : record.status) : HISTORY_LABEL[selected.status] ?? selected.status}</StatusLabel>}
            onClose={() => setSelectedId(null)}
            actions={isOpen ? (
              <>
                <Button onClick={() => void decide('APPROVE')} disabled={busy || expired}>
                  <Check aria-hidden="true" /> Approve &amp; execute
                </Button>
                <Button variant="destructive" onClick={() => void decide('REJECT')} disabled={busy}>
                  <X aria-hidden="true" /> Return to maker
                </Button>
              </>
            ) : (
              <Button variant="secondary" href={`/dashboard/payments?q=${encodeURIComponent(selected.id)}`}>Open in Payments</Button>
            )}
          >
            <InspectorSection title="Why approval is required">
              <p className="border border-[var(--border-default)] bg-[var(--surface-raised)] px-3 py-2 text-[12.5px]">{reasonRequired(selected, settings)}</p>
              <p className="mt-2 text-[12.5px] text-[var(--text-2)]">{selected.recommendation}</p>
            </InspectorSection>
            <InspectorSection title="Money">
              <div className="grid grid-cols-2 gap-2 border-y border-[var(--border-default)] py-3">
                <InspectorField label="Amount" mono>{selected.amountLabel ?? '—'}</InspectorField>
                <InspectorField label="Corridor" mono>{selected.corridor ?? '—'}</InspectorField>
                <InspectorField label="Risk">{selected.risk.toLowerCase()} risk</InspectorField>
                <InspectorField label="Evidence">{selected.evidenceQuality === 'trusted' ? 'All sources trusted' : 'Contains untrusted data'}</InspectorField>
              </div>
            </InspectorSection>
            <InspectorSection title="Maker and checker">
              <div className="grid grid-cols-2 gap-2">
                <InspectorField label="Maker" mono>{selected.createdBy ? `${selected.createdBy.slice(0, 18)}…` : brand.agentName}</InspectorField>
                <InspectorField label="Checker">You · distinct from the maker</InspectorField>
                <InspectorField label="Approvals" mono>{selected.approvalsCollected} of {selected.requiredApprovers}</InspectorField>
                <InspectorField label="Quote expiry" mono>{selected.expiresAt ? (shortTime(selected.expiresAt) ?? '—') : 'No expiry set'}</InspectorField>
              </div>
              {expired ? <p className="mt-2 text-[12.5px] text-[var(--state-exception)]">This quote is no longer executable. Refresh the quote to compare current routes.</p> : null}
            </InspectorSection>
            <InspectorSection title="Checkpoints">
              <ClearanceProgress states={record.checkpoints} />
            </InspectorSection>
            <InspectorSection title="Evidence">
              <EvidenceList items={record.evidence} />
            </InspectorSection>
            <InspectorSection title="Immutable identifiers">
              <div className="grid gap-2">
                <InspectorField label="Proposal" mono>{selected.id}</InspectorField>
                <InspectorField label="Approval hash" mono>{selected.approvalHash ?? 'Not yet bound'}</InspectorField>
                <InspectorField label="Created" mono>{selected.createdAt}</InspectorField>
              </div>
            </InspectorSection>
            {isOpen ? (
              <InspectorSection title="Confirmation note">
                <textarea value={reason} onChange={(event) => setReason(event.target.value.slice(0, 280))} rows={2} placeholder="Optional · recorded with the decision" className="w-full rounded-[var(--r-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-2 text-[13px] outline-none focus:border-[var(--signal)]" />
                <p className="mt-2 text-[12px] text-[var(--text-2)]">Approve &amp; execute submits the approved instruction to the selected regulated rail. It cannot be recalled after the partner accepts it.</p>
              </InspectorSection>
            ) : null}
          </Inspector>
        ) : undefined}
      >
        <div className="flex items-center gap-1 border-b border-[var(--border-default)] px-2" role="tablist" aria-label="Approvals">
          {([['queue', `Awaiting checker (${queue?.length ?? 0})`], ['history', `Decided (${history?.length ?? 0})`]] as const).map(([id, text]) => (
            <button key={id} role="tab" type="button" aria-selected={tab === id} onClick={() => setTab(id)} className={cn('h-10 px-3 text-[12.5px] font-medium', tab === id ? 'border-b-2 border-[var(--signal)] text-[var(--text)]' : 'text-[var(--text-2)] hover:text-[var(--text)]')}>
              {text}
            </button>
          ))}
        </div>
        <GroupHeading label={tab === 'queue' ? 'Needs a decision' : 'Decisions taken'} count={loading ? undefined : rows.length} tone={tab === 'queue' && rows.length > 0 ? 'signal' : 'default'} />
        <DataTable
          caption={tab === 'queue' ? 'Proposals awaiting checker' : 'Decided proposals'}
          rows={rows}
          loading={loading}
          selectedId={selectedId}
          onSelect={(row) => setSelectedId(row.id)}
          emptyState={<div className="text-[13px] text-[var(--text-2)]">{tab === 'queue' ? `Nothing is waiting for a checker. Proposals from ${brand.agentName} and the desk appear here.` : 'No decisions yet.'}</div>}
          columns={[
            { key: 'id', header: 'Proposal', width: '150px', render: (p) => <span className="font-mono text-[12px] text-[var(--signal)]">{p.id.slice(0, 16)}</span> },
            { key: 'kind', header: 'Kind', render: (p) => <span className="grid"><span className="font-medium">{KIND_LABEL[p.kind] ?? p.kind}</span><span className="truncate text-[11px] text-[var(--text-muted)]">{p.recommendation}</span></span> },
            { key: 'amount', header: 'Amount', numeric: true, align: 'right', render: (p) => p.amountLabel ?? '—' },
            { key: 'reason', header: 'Why', secondary: true, render: (p) => <span className="text-[12px] text-[var(--text-2)]">{reasonRequired(p, settings)}</span> },
            { key: 'approvers', header: 'Approvers', secondary: true, numeric: true, align: 'right', render: (p) => `${p.approvalsCollected}/${p.requiredApprovers}` },
            { key: 'state', header: 'State', render: (p) => <StatusLabel compact>{tab === 'queue' ? fromProposal(p).status : HISTORY_LABEL[p.status] ?? p.status}</StatusLabel> },
          ]}
        />
      </Workspace>
    </>
  );
}
