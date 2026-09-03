'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileWarning,
  ShieldAlert,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';

export type QueueLaneKey =
  | 'PENDING_APPROVALS'
  | 'COMPLIANCE_HOLDS'
  | 'EXPIRING_QUOTES'
  | 'FAILED_SETTLEMENTS'
  | 'ANOMALY_HALTS';

export type QueueItem = {
  id: string;
  recommendation: string;
  kind: string;
  maker: string;
  amountLabel: string;
  approvalsCollected: number;
  requiredApprovers: number;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  expiryLabel: string;
  reason?: string;
};

export type QueueLaneData = { key: QueueLaneKey; label: string; items: QueueItem[] };

type Resolution = 'approved' | 'rejected';
type ResolvedItem = QueueItem & { resolution: Resolution; approvalsFinal: number };

/* Lane tones + risk pills use semantic state tokens (W9.0 coral rule) —
   coral stays a brand accent, never a risk/error signal. */
const laneMeta: Record<QueueLaneKey, { label: string; icon: LucideIcon; tone: string }> = {
  PENDING_APPROVALS: { label: 'Pending approvals', icon: ShieldCheck, tone: 'text-[var(--info)]' },
  COMPLIANCE_HOLDS: { label: 'Compliance holds', icon: ShieldAlert, tone: 'text-[var(--warn)]' },
  EXPIRING_QUOTES: { label: 'Expiring quotes', icon: Clock3, tone: 'text-[var(--pending)]' },
  FAILED_SETTLEMENTS: { label: 'Failed settlements', icon: XCircle, tone: 'text-[var(--error)]' },
  ANOMALY_HALTS: { label: 'Anomaly halts', icon: AlertTriangle, tone: 'text-[var(--error)]' },
};

function riskClass(risk: QueueItem['risk']) {
  if (risk === 'HIGH') return 'border-[var(--error)] bg-[var(--error-bg)] text-[var(--error)]';
  if (risk === 'MEDIUM') return 'border-[var(--warn)] bg-[var(--warn-bg)] text-[var(--warn)]';
  return 'border-[var(--ok)] bg-[var(--ok-bg)] text-[var(--ok)]';
}

export default function ApprovalQueueBoard({
  pending,
  otherLanes,
}: {
  pending: QueueItem[];
  otherLanes: QueueLaneData[];
}) {
  // Live approval state keyed by proposal id. A proposal leaves the pending
  // lane once it is approved (enough signatures) or rejected — exactly the
  // maker-checker transition the demo needs to show.
  const [openItems, setOpenItems] = useState<QueueItem[]>(pending);
  const [resolved, setResolved] = useState<ResolvedItem[]>([]);
  const [status, setStatus] = useState('');

  const totals = useMemo(() => {
    const map: Record<QueueLaneKey, number> = {
      PENDING_APPROVALS: openItems.length,
      COMPLIANCE_HOLDS: 0,
      EXPIRING_QUOTES: 0,
      FAILED_SETTLEMENTS: 0,
      ANOMALY_HALTS: 0,
    };
    for (const lane of otherLanes) map[lane.key] = lane.items.length;
    return map;
  }, [openItems.length, otherLanes]);

  function approve(item: QueueItem) {
    const nextApprovals = item.approvalsCollected + 1;
    // One recorded signature reaches the seeded threshold on every demo row
    // (single-approver rows need 1; the dual-control row already holds 1).
    if (nextApprovals < item.requiredApprovers) {
      setOpenItems((current) =>
        current.map((row) => (row.id === item.id ? { ...row, approvalsCollected: nextApprovals } : row)),
      );
      const remaining = item.requiredApprovers - nextApprovals;
      setStatus(`Your approval on ${item.recommendation} is recorded. ${remaining} more approver needed.`);
      toast.success('Approval recorded', { description: `${nextApprovals}/${item.requiredApprovers} — awaiting a co-approver.` });
      return;
    }
    setOpenItems((current) => current.filter((row) => row.id !== item.id));
    setResolved((current) => [{ ...item, resolution: 'approved', approvalsFinal: nextApprovals }, ...current]);
    setStatus(`${item.recommendation} approved and queued for settlement.`);
    toast.success('Approved & queued for settlement', { description: item.recommendation });
  }

  function reject(item: QueueItem) {
    const ok = window.confirm(`Reject "${item.recommendation}"? This returns it to the maker and nothing settles.`);
    if (!ok) return;
    setOpenItems((current) => current.filter((row) => row.id !== item.id));
    setResolved((current) => [{ ...item, resolution: 'rejected', approvalsFinal: item.approvalsCollected }, ...current]);
    setStatus(`${item.recommendation} rejected and returned to the maker.`);
    toast('Proposal rejected', { description: item.recommendation });
  }

  return (
    <>
      {/* Screen-reader announcement of the latest maker-checker decision. */}
      <p aria-live="polite" className="sr-only">{status}</p>

      <section className="grid gap-3 md:grid-cols-5">
        {(Object.keys(laneMeta) as QueueLaneKey[]).map((lane) => {
          const meta = laneMeta[lane];
          const Icon = meta.icon;
          return (
            <div key={lane} className="rounded-lg border border-[#326273]/14 bg-white/75 p-4">
              <div className="flex items-center justify-between gap-3">
                <Icon className={`h-5 w-5 ${meta.tone}`} />
                <span className="text-2xl font-bold tabular-nums text-[#1F4452]">{totals[lane]}</span>
              </div>
              <p className="mt-3 text-sm font-bold text-[#326273]">{meta.label}</p>
            </div>
          );
        })}
      </section>

      <section className="overflow-hidden rounded-lg border border-[#326273]/16 bg-white/80">
        <div className="grid grid-cols-[1.3fr_0.9fr_0.7fr_0.7fr_0.8fr_0.9fr] gap-0 border-b border-[#326273]/12 bg-[#1F4452] px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-white/75">
          <span>Proposal</span>
          <span>Kind</span>
          <span>Impact</span>
          <span>Approvers</span>
          <span>Risk</span>
          <span>Actions</span>
        </div>
        <div className="divide-y divide-[#326273]/10">
          {openItems.length === 0 && (
            <div className="px-4 py-10 text-center">
              <ShieldCheck className="mx-auto h-7 w-7 text-[var(--info)]" />
              <p className="mt-2 text-sm font-bold text-[#1F4452]">No proposals waiting for approval</p>
              <p className="mt-1 text-[13px] font-medium text-[#326273]/60">Cleared items move to settlement; rejected items return to the maker.</p>
            </div>
          )}
          {openItems.map((item) => (
            <div key={item.id} className="grid grid-cols-1 gap-3 px-4 py-4 md:grid-cols-[1.3fr_0.9fr_0.7fr_0.7fr_0.8fr_0.9fr] md:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <FileWarning className="h-4 w-4 text-[var(--pending)]" />
                  <strong className="truncate text-sm text-[#1F4452]">{item.recommendation}</strong>
                </div>
                <p className="mt-1 truncate text-[13px] font-medium text-[#326273]/65">{item.id} · maker {item.maker}</p>
              </div>
              <span className="text-sm font-medium text-[#326273]">{item.kind}</span>
              <span className="money text-sm font-medium text-[#1F4452]">{item.amountLabel}</span>
              <span className="text-sm font-semibold tabular-nums text-[#326273]">{item.approvalsCollected}/{item.requiredApprovers}</span>
              <span className={`w-fit rounded-md border px-2 py-1 text-[13px] font-bold ${riskClass(item.risk)}`}>{item.risk}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => approve(item)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[#1F4452] px-3 text-[13px] font-bold text-white transition hover:bg-[#326273] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/30"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => reject(item)}
                  aria-label={`Reject ${item.recommendation}`}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[var(--error)] text-[var(--error)] transition hover:bg-[var(--error-bg)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--error)]/25"
                >
                  <XCircle className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {resolved.length > 0 && (
        <section className="overflow-hidden rounded-lg border border-[#326273]/16 bg-white/70">
          <div className="border-b border-[#326273]/10 px-4 py-3">
            <h2 className="text-sm font-bold text-[#1F4452]">Recently resolved</h2>
          </div>
          <div className="divide-y divide-[#326273]/10">
            {resolved.map((item) => (
              <div key={`${item.id}-${item.resolution}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <strong className="truncate text-sm text-[#1F4452]">{item.recommendation}</strong>
                  <p className="mt-0.5 truncate text-[13px] font-medium text-[#326273]/60">{item.id} · {item.amountLabel}</p>
                </div>
                {item.resolution === 'approved' ? (
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--ok)] bg-[var(--ok-bg)] px-2.5 py-1 text-[13px] font-medium text-[var(--ok)]">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Approved {item.approvalsFinal}/{item.requiredApprovers} · queued for settlement
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--error)] bg-[var(--error-bg)] px-2.5 py-1 text-[13px] font-medium text-[var(--error)]">
                    <XCircle className="h-3.5 w-3.5" />
                    Rejected · returned to maker
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="grid gap-4 lg:grid-cols-2">
        {otherLanes.map((lane) => {
          const meta = laneMeta[lane.key];
          const Icon = meta.icon;
          return (
            <div key={lane.key} className="rounded-lg border border-[#326273]/14 bg-white/72">
              <div className="flex items-center justify-between border-b border-[#326273]/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Icon className={`h-4 w-4 ${meta.tone}`} />
                  <h2 className="text-sm font-bold text-[#1F4452]">{meta.label}</h2>
                </div>
                <span className="text-sm font-bold tabular-nums text-[#326273]">{lane.items.length}</span>
              </div>
              <div className="divide-y divide-[#326273]/10">
                {lane.items.map((item) => (
                  <div key={`${lane.key}-${item.id}`} className="grid gap-2 px-4 py-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <strong className="min-w-0 truncate text-[#1F4452]">{item.recommendation}</strong>
                      <span className="shrink-0 text-[13px] font-bold tabular-nums text-[#326273]/60">{item.expiryLabel}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-[#326273]/65">
                      <span>{item.kind}</span>
                      <span className="money">{item.amountLabel}</span>
                      {item.reason && <span>{item.reason}</span>}
                    </div>
                  </div>
                ))}
                {lane.items.length === 0 && (
                  <div className="px-4 py-5 text-sm font-medium text-[#326273]/55">Clear</div>
                )}
              </div>
            </div>
          );
        })}
      </section>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Link href="/dashboard" className="rounded-md border border-[#326273]/20 px-3 py-2 text-sm font-bold text-[#326273]">Back to 0xWal</Link>
      </div>
    </>
  );
}
