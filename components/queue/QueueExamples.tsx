'use client';

import { AlertTriangle, ChevronDown, Clock3, ShieldAlert, ShieldCheck, XCircle, type LucideIcon } from 'lucide-react';

import { kindLabel } from '@/lib/queue/queue-decision';
import { riskClass, type QueueItem, type QueueLaneData, type QueueLaneKey } from '@/components/queue/ApprovalQueueBoard';

/**
 * Sample proposals that show what each lane of the queue holds (v2 brief 5.3).
 *
 * Collapsed by default, under a summary that says what they are before
 * anyone opens it: "Examples (not your payments)". They sat open below the
 * live table, at the same weight, and a sample payment that looks like a real
 * one is read as one. They are never actionable: no approve, no reject.
 *
 * Each lane is a compact card: its count and up to two sample lines. Every
 * card says "Sample" on itself as well, because once the panel is open on a
 * phone the summary has scrolled away, and a card reading "Anomaly halts 1"
 * with a red icon is otherwise read as a live incident. The expiry stays
 * visible: when a sample would lapse is part of what it shows.
 */

/* Lane tones use semantic state tokens (W9.0 rule): a brand accent is never a
   risk or error signal. */
const laneMeta: Record<QueueLaneKey, { label: string; icon: LucideIcon; tone: string }> = {
  PENDING_APPROVALS: { label: 'Pending approvals', icon: ShieldCheck, tone: 'text-[var(--info)]' },
  COMPLIANCE_HOLDS: { label: 'Compliance holds', icon: ShieldAlert, tone: 'text-[var(--warn)]' },
  EXPIRING_QUOTES: { label: 'Expiring quotes', icon: Clock3, tone: 'text-[var(--pending)]' },
  FAILED_SETTLEMENTS: { label: 'Failed settlements', icon: XCircle, tone: 'text-[var(--error)]' },
  ANOMALY_HALTS: { label: 'Anomaly halts', icon: AlertTriangle, tone: 'text-[var(--error)]' },
};

const SHOWN_PER_LANE = 2;

export default function QueueExamples({ pending, lanes }: { pending: QueueItem[]; lanes: QueueLaneData[] }) {
  const all: QueueLaneData[] = [{ key: 'PENDING_APPROVALS', label: laneMeta.PENDING_APPROVALS.label, items: pending }, ...lanes];
  const total = all.reduce((sum, lane) => sum + lane.items.length, 0);

  return (
    <details className="group rounded-lg border border-dashed border-[#326273]/30 bg-[#326273]/[0.03]">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 focus-ring [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-sm font-bold text-[#1F4452]">Examples (not your payments)</span>
          <span className="mt-0.5 block text-[13px] font-medium text-[#326273]">
            {total} sample proposals that show what each lane holds. They cannot be approved.
          </span>
        </span>
        <ChevronDown className="h-5 w-5 shrink-0 text-[#326273] transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>

      <ul className="grid grid-cols-2 gap-3 px-4 pb-4 md:grid-cols-3 xl:grid-cols-5">
        {all.map((lane) => {
          const meta = laneMeta[lane.key];
          const Icon = meta.icon;
          return (
            <li key={lane.key} className="flex min-w-0 flex-col rounded-lg border border-[#326273]/14 bg-white/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Icon className={`h-4 w-4 shrink-0 ${meta.tone}`} aria-hidden="true" />
                  <span className="rounded border border-dashed border-[#326273]/40 px-1 text-[12px] font-bold text-[#326273]">
                    Sample
                  </span>
                </span>
                <span className="text-xl font-bold tabular-nums text-[#1F4452]">{lane.items.length}</span>
              </div>
              <h3 className="mt-2 text-[13px] font-bold text-[#1F4452]">{meta.label}</h3>
              {lane.items.length === 0 ? (
                <p className="mt-1 text-[12px] font-medium text-[#326273]">Clear</p>
              ) : (
                <ul className="mt-2 space-y-2 border-t border-[#326273]/10 pt-2">
                  {lane.items.slice(0, SHOWN_PER_LANE).map((item) => (
                    <li key={`${lane.key}-${item.id}`} className="min-w-0">
                      <p className="truncate text-[12px] font-semibold text-[#1F4452]" title={item.recommendation}>
                        {item.recommendation}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] font-medium text-[#326273]">
                        <span className="money">{item.amountLabel}</span>
                        <span className={`rounded border px-1 text-[12px] font-bold ${riskClass(item.risk)}`}>{item.risk}</span>
                      </p>
                      <p className="mt-0.5 text-[12px] font-medium text-[#326273]">{item.expiryLabel}</p>
                      <p className="sr-only">
                        {kindLabel(item.kind)}
                        {item.reason ? `, ${item.reason}` : ''}
                      </p>
                    </li>
                  ))}
                  {lane.items.length > SHOWN_PER_LANE && (
                    <li className="text-[12px] font-medium text-[#326273]">
                      and {lane.items.length - SHOWN_PER_LANE} more
                    </li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
