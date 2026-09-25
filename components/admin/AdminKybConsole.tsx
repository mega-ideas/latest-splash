'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardCheck, FileText, Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

import LocalTime from '@/components/LocalTime';
import type { KybCaseRecord, KybReviewState } from '@/lib/server/kyb';

type Props = {
  initialCases: KybCaseRecord[];
};

const stateLabels: Record<KybReviewState, string> = {
  SUBMITTED: 'Submitted',
  IN_REVIEW: 'In review',
  NEEDS_INFORMATION: 'Needs info',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

function stateClass(state: KybReviewState) {
  if (state === 'APPROVED') return 'border-[#5C9EAD]/30 bg-[#5C9EAD]/10 text-[#326273]';
  if (state === 'REJECTED') return 'border-red-500/30 bg-red-500/10 text-red-700';
  if (state === 'NEEDS_INFORMATION') return 'border-[#E39774]/40 bg-[#E39774]/10 text-[#9a4a2d]';
  return 'border-[#326273]/15 bg-white text-[#326273]';
}

export default function AdminKybConsole({ initialCases }: Props) {
  const [cases, setCases] = useState(initialCases);
  const [selectedId, setSelectedId] = useState(initialCases[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [loadingAction, setLoadingAction] = useState<KybReviewState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const selected = useMemo(() => cases.find((item) => item.id === selectedId) ?? cases[0] ?? null, [cases, selectedId]);

  async function refreshCases() {
    setRefreshing(true);

    try {
      const response = await fetch('/api/admin/kyb', { cache: 'no-store' });
      const body = await response.json() as { cases?: KybCaseRecord[]; error?: string };

      if (!response.ok || !body.cases) {
        throw new Error(body.error ?? 'KYB queue refresh failed');
      }

      setCases(body.cases);
      setSelectedId((current) => body.cases?.some((item) => item.id === current) ? current : body.cases?.[0]?.id ?? '');
      toast.success('KYB queue refreshed');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'KYB queue refresh failed';
      toast.error(message);
    } finally {
      setRefreshing(false);
    }
  }

  async function updateCase(state: KybReviewState) {
    if (!selected) return;
    setLoadingAction(state);

    try {
      const response = await fetch(`/api/admin/kyb/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, note, assignedTo: 'staff@splash.finance' }),
      });
      const body = await response.json() as { case?: KybCaseRecord; error?: string };

      if (!response.ok || !body.case) {
        throw new Error(body.error ?? 'KYB review update failed');
      }

      setCases((current) => current.map((item) => (item.id === body.case?.id ? body.case : item)));
      setSelectedId(body.case.id);
      setNote('');
      toast.success(`KYB case marked ${String(stateLabels[state] ?? state).toLowerCase()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'KYB review update failed';
      toast.error(message);
    } finally {
      setLoadingAction(null);
    }
  }

  const pendingCount = cases.filter((item) => item.state === 'SUBMITTED' || item.state === 'IN_REVIEW' || item.state === 'NEEDS_INFORMATION').length;
  const approvedCount = cases.filter((item) => item.state === 'APPROVED').length;
  const rejectedCount = cases.filter((item) => item.state === 'REJECTED').length;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 inline-flex rounded-full bg-[#5C9EAD]/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-[#145d6a]">Compliance Operations</div>
          <h1 className="text-3xl font-black tracking-[-0.03em] text-[#1f4350]">KYB approval verification</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#326273]/90">Smart contracts can settle funds and record receipts, but staff still need off-chain checks for business registration, directors, UBO evidence, sanctions/PEP flags, and approval rationale.</p>
        </div>
        <div className="grid grid-cols-3 gap-2 rounded-2xl border border-[#326273]/10 bg-white p-2 text-center shadow-sm">
          <Metric label="Pending" value={pendingCount} />
          <Metric label="Approved" value={approvedCount} />
          <Metric label="Rejected" value={rejectedCount} />
        </div>
      </header>

      <section className="grid gap-6 xl:grid-cols-[0.95fr_1.35fr]">
        <div className="rounded-2xl border border-[#326273]/10 bg-white p-4 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-bold text-[#1f4350]">Review queue</h2>
            <button type="button" disabled={refreshing} onClick={() => void refreshCases()} className="inline-flex items-center gap-2 rounded-lg border border-[#5C9EAD]/30 px-3 py-2 text-xs font-bold text-[#326273] hover:border-[#5C9EAD] disabled:opacity-60">
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4 text-[#237284]" />}
              Refresh
            </button>
          </div>
          <div className="space-y-3">
            {cases.map((item) => (
              <button key={item.id} type="button" onClick={() => setSelectedId(item.id)} className={`w-full rounded-2xl border p-4 text-left transition ${selected?.id === item.id ? 'border-[#5C9EAD] bg-[#5C9EAD]/10' : 'border-[#326273]/10 hover:border-[#5C9EAD]/40'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-bold text-[#1f4350]">{item.businessName}</div>
                    <div className="mt-1 font-mono text-[12px] text-[#326273]/90">{item.registrationNumber}</div>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[12px] font-bold ${stateClass(item.state)}`}>{stateLabels[item.state]}</span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-[12px] text-[#326273]/90">
                  <div>Risk: {item.riskTier.replace('_', ' ')}</div>
                  <div>Access: {item.corridorAccess}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {selected && (
          <div className="space-y-5">
            <section className="rounded-2xl border border-[#326273]/10 bg-white p-6 shadow-sm">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="text-xs font-bold uppercase tracking-[0.2em] text-[#237284]">{selected.id}</div>
                  <h2 className="mt-2 text-2xl font-black text-[#1f4350]">{selected.businessName}</h2>
                  <p className="mt-1 text-sm text-[#326273]/90">SSM registration {selected.registrationNumber}</p>
                </div>
                <span className={`rounded-full border px-3 py-1 text-xs font-bold ${stateClass(selected.state)}`}>{stateLabels[selected.state]}</span>
              </div>

              <div className="mt-6 grid gap-3 md:grid-cols-4">
                <Info label="Risk tier" value={selected.riskTier.replace('_', ' ')} />
                <Info label="Corridor access" value={selected.corridorAccess} />
                <Info label="Assigned to" value={selected.assignedTo ?? 'Unassigned'} />
                <Info label="Sumsub applicant" value={selected.sumsubApplicantId ?? 'Not linked'} />
              </div>
            </section>

            <section className="grid gap-5 lg:grid-cols-2">
              <div className="rounded-2xl border border-[#326273]/10 bg-white p-5 shadow-sm">
                <div className="mb-4 flex items-center gap-2 font-bold text-[#1f4350]"><FileText className="h-5 w-5 text-[#237284]" /> Documents</div>
                <div className="space-y-3">
                  {selected.documents.map((document) => (
                    <div key={document.sha256} className="rounded-xl border border-[#326273]/10 bg-[#F6F0ED] p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-bold text-[#1f4350]">{document.name}</div>
                          <div className="mt-1 text-xs text-[#326273]/90">{document.kind.replace('_', ' ')} · {(document.size / 1024).toFixed(1)} KB</div>
                        </div>
                        <span className="rounded-full bg-[#5C9EAD]/10 px-2 py-1 text-[12px] font-bold text-[#326273]">{document.virusScanResult}</span>
                      </div>
                      <div className="mt-2 break-all font-mono text-[12px] text-[#326273]/90">SHA-256 {document.sha256}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-[#326273]/10 bg-white p-5 shadow-sm">
                <div className="mb-4 flex items-center gap-2 font-bold text-[#1f4350]"><ShieldAlert className="h-5 w-5 text-[#9f5839]" /> Manual decision</div>
                <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={5} placeholder="Add approval rationale, missing-info request, or rejection reason" className="w-full resize-none rounded-xl border border-[#326273]/70 bg-[#F6F0ED] px-4 py-3 text-sm outline-none focus:border-[#5C9EAD]" />
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <ActionButton state="IN_REVIEW" label="Start review" loadingAction={loadingAction} onClick={updateCase} />
                  <ActionButton state="NEEDS_INFORMATION" label="Request info" loadingAction={loadingAction} onClick={updateCase} />
                  <ActionButton state="APPROVED" label="Approve KYB" loadingAction={loadingAction} onClick={updateCase} />
                  <ActionButton state="REJECTED" label="Reject KYB" loadingAction={loadingAction} onClick={updateCase} />
                </div>
                <div className="mt-4 rounded-xl border border-[#E39774]/20 bg-[#E39774]/10 p-3 text-xs leading-5 text-[#326273]/90">
                  <AlertTriangle className="mr-2 inline h-4 w-4 text-[#9f5839]" /> Approval unlocks off-chain customer access. Settlement contracts still enforce transfer execution separately.
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-[#326273]/10 bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-center gap-2 font-bold text-[#1f4350]"><CheckCircle2 className="h-5 w-5 text-[#237284]" /> Audit trail</div>
              <div className="space-y-3">
                {selected.auditTrail.map((event) => (
                  <div key={event.id} className="rounded-xl bg-[#F6F0ED] p-3 text-sm">
                    <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                      <span className="font-bold text-[#1f4350]">{event.action}</span>
                      <span className="text-xs text-[#326273]/90"><LocalTime value={event.createdAt} /></span>
                    </div>
                    <div className="mt-1 text-xs text-[#326273]/90">{event.actor}{event.note ? ` · ${event.note}` : ''}</div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-[#F6F0ED] px-5 py-3">
      <div className="text-2xl font-black text-[#1f4350]">{value}</div>
      <div className="text-[12px] font-bold uppercase tracking-wide text-[#326273]/90">{label}</div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-[#F6F0ED] p-3">
      <div className="text-[12px] font-bold uppercase tracking-wide text-[#326273]/90">{label}</div>
      <div className="mt-1 truncate text-sm font-bold text-[#1f4350]">{value}</div>
    </div>
  );
}

function ActionButton({ state, label, loadingAction, onClick }: { state: KybReviewState; label: string; loadingAction: KybReviewState | null; onClick: (state: KybReviewState) => Promise<void> }) {
  const isLoading = loadingAction === state;

  return (
    <button type="button" disabled={Boolean(loadingAction)} onClick={() => void onClick(state)} className={`flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold text-white transition disabled:opacity-60 ${state === 'APPROVED' ? 'bg-[#237284] hover:bg-[#145d6a]' : state === 'REJECTED' ? 'bg-red-600 hover:bg-red-700' : 'bg-[#326273] hover:bg-[#254e5c]'}`}>
      {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
      {label}
    </button>
  );
}
