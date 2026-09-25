'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Clock3,
  FileWarning,
  Loader2,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  interpretSubmitResponse,
  isFinal,
  kindLabel,
  submitPath,
  submitRequestBody,
  type DecisionOutcome,
  type QueueDecision,
} from '@/lib/queue/queue-decision';

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
  /** The canonical hash of what the approver is looking at. Sent with the
   *  decision, so a proposal that changed after the page loaded is refused
   *  instead of signed unseen. Live proposals only. */
  approvalHash?: string;
};

export type QueueLaneData = { key: QueueLaneKey; label: string; items: QueueItem[] };

type Decided = QueueItem & { outcome: DecisionOutcome };

/* Lane tones + risk pills use semantic state tokens (W9.0 coral rule) —
   coral stays a brand accent, never a risk/error signal. */
const laneMeta: Record<QueueLaneKey, { label: string; icon: LucideIcon; tone: string }> = {
  PENDING_APPROVALS: { label: 'Pending approvals', icon: ShieldCheck, tone: 'text-[var(--info)]' },
  COMPLIANCE_HOLDS: { label: 'Compliance holds', icon: ShieldAlert, tone: 'text-[var(--warn)]' },
  EXPIRING_QUOTES: { label: 'Expiring quotes', icon: Clock3, tone: 'text-[var(--pending)]' },
  FAILED_SETTLEMENTS: { label: 'Failed settlements', icon: XCircle, tone: 'text-[var(--error)]' },
  ANOMALY_HALTS: { label: 'Anomaly halts', icon: AlertTriangle, tone: 'text-[var(--error)]' },
};

/* The word carries the level; the border and tint carry its colour. The
   tokens as text on their own tints are under 4.5:1 at 13px (--warn 3.72,
   --ok 4.25); ink is 8.75:1 or more on every tint. */
function riskClass(risk: QueueItem['risk']) {
  if (risk === 'HIGH') return 'border-[var(--error)] bg-[var(--error-bg)] text-[#1F4452]';
  if (risk === 'MEDIUM') return 'border-[var(--warn)] bg-[var(--warn-bg)] text-[#1F4452]';
  return 'border-[var(--ok)] bg-[var(--ok-bg)] text-[#1F4452]';
}

/** How each answer reads on the page: the server's words in ink, with the
 *  state's colour on the rule and the icon, so colour is never the only
 *  signal. The words used to take the colour, and --warn is 4.1:1 here. */
const outcomeTone: Record<DecisionOutcome['kind'], { icon: LucideIcon; rule: string; iconTone: string; label: string }> = {
  executed: { icon: CheckCircle2, rule: 'border-[var(--ok)]', iconTone: 'text-[var(--ok)]', label: 'Sent' },
  'approved-not-sent': { icon: AlertTriangle, rule: 'border-[var(--warn)]', iconTone: 'text-[var(--warn)]', label: 'Approved, not sent' },
  rejected: { icon: CircleSlash, rule: 'border-[#326273]/40', iconTone: 'text-[#326273]', label: 'Rejected' },
  closed: { icon: CircleSlash, rule: 'border-[#326273]/40', iconTone: 'text-[#326273]', label: 'No longer open' },
  recorded: { icon: ShieldCheck, rule: 'border-[var(--info)]', iconTone: 'text-[var(--info)]', label: 'Approval recorded' },
  held: { icon: ShieldAlert, rule: 'border-[var(--warn)]', iconTone: 'text-[var(--warn)]', label: 'Held for compliance' },
  changed: { icon: RotateCw, rule: 'border-[var(--warn)]', iconTone: 'text-[var(--warn)]', label: 'Changed since loaded' },
  refused: { icon: XCircle, rule: 'border-[var(--error)]', iconTone: 'text-[var(--error)]', label: 'Not approved' },
  'signed-out': { icon: XCircle, rule: 'border-[var(--error)]', iconTone: 'text-[var(--error)]', label: 'Signed out' },
  unreachable: { icon: AlertTriangle, rule: 'border-[var(--warn)]', iconTone: 'text-[var(--warn)]', label: 'No answer' },
};

const GRID = 'md:grid-cols-[1.3fr_0.8fr_0.7fr_0.6fr_0.6fr_1fr]';

function OutcomeLine({ outcome }: { outcome: DecisionOutcome }) {
  const tone = outcomeTone[outcome.kind];
  const Icon = tone.icon;
  return (
    <div className={`border-l-2 ${tone.rule} pl-3`}>
      <p className="flex items-start gap-2 text-[13px] font-semibold leading-5 text-[#1F4452]">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone.iconTone}`} aria-hidden="true" />
        <span>{outcome.message}</span>
      </p>
      {outcome.kind === 'executed' && outcome.ref && (
        <p className="mt-1 pl-6 font-mono text-[12px] text-[#326273]/90">Reference {outcome.ref}</p>
      )}
      {(outcome.kind === 'changed' || outcome.kind === 'unreachable') && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-2 ml-6 inline-flex min-h-9 items-center gap-1.5 rounded-md border border-[#326273]/25 px-3 text-[13px] font-bold text-[#1F4452] transition hover:bg-[#326273]/5 focus-ring"
        >
          <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
          Reload the queue
        </button>
      )}
      {outcome.kind === 'signed-out' && (
        <Link
          href="/login"
          className="mt-2 ml-6 inline-flex min-h-9 items-center rounded-md border border-[#326273]/25 px-3 text-[13px] font-bold text-[#1F4452] focus-ring"
        >
          Sign in
        </Link>
      )}
    </div>
  );
}

export default function ApprovalQueueBoard({
  live,
  examples,
}: {
  /** This workspace's proposals waiting for a decision. */
  live: QueueItem[];
  /** Fixtures that show what each lane looks like. Never actionable. */
  examples: { pending: QueueItem[]; lanes: QueueLaneData[] };
}) {
  const [openItems, setOpenItems] = useState<QueueItem[]>(live);
  const [decided, setDecided] = useState<Decided[]>([]);
  const [notes, setNotes] = useState<Record<string, DecisionOutcome>>({});
  const [inFlight, setInFlight] = useState<Record<string, QueueDecision>>({});
  const [confirmingReject, setConfirmingReject] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const exampleTotals = useMemo(() => {
    const map: Record<QueueLaneKey, number> = {
      PENDING_APPROVALS: examples.pending.length,
      COMPLIANCE_HOLDS: 0,
      EXPIRING_QUOTES: 0,
      FAILED_SETTLEMENTS: 0,
      ANOMALY_HALTS: 0,
    };
    for (const lane of examples.lanes) map[lane.key] = lane.items.length;
    return map;
  }, [examples]);

  /**
   * Send the decision and show what the server says came of it. Nothing on
   * this page claims a payment went unless the response says it was executed
   * (lib/queue/queue-decision.ts).
   */
  async function decide(item: QueueItem, decision: QueueDecision) {
    if (inFlight[item.id]) return;
    setConfirmingReject(null);
    setInFlight((current) => ({ ...current, [item.id]: decision }));

    let outcome: DecisionOutcome;
    try {
      const response = await fetch(submitPath(item.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitRequestBody(item, decision)),
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      outcome = interpretSubmitResponse(response.status, body, decision);
    } catch {
      outcome = interpretSubmitResponse(0, null, decision);
    }

    setInFlight((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    setStatus(`${item.recommendation}: ${outcome.message}`);

    if (isFinal(outcome)) {
      setOpenItems((current) => current.filter((row) => row.id !== item.id));
      setDecided((current) => [{ ...item, outcome }, ...current]);
      setNotes((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
    } else {
      setNotes((current) => ({ ...current, [item.id]: outcome }));
      if (outcome.kind === 'recorded') {
        setOpenItems((current) =>
          current.map((row) =>
            row.id === item.id
              ? { ...row, approvalsCollected: outcome.approvalsCollected, requiredApprovers: outcome.requiredApprovers }
              : row,
          ),
        );
      }
    }

    if (outcome.kind === 'executed') toast.success('Payment sent', { description: item.recommendation });
    else if (outcome.kind === 'recorded') toast.success('Approval recorded', { description: outcome.message });
    else if (outcome.kind === 'rejected') toast('Payment rejected', { description: item.recommendation });
    else if (outcome.kind === 'closed') toast(outcomeTone.closed.label, { description: outcome.message });
    else toast.error(outcomeTone[outcome.kind].label, { description: outcome.message });
  }

  return (
    <>
      {/* Screen-reader announcement of the latest decision and its outcome. */}
      <p aria-live="polite" className="sr-only">{status}</p>

      <section aria-labelledby="queue-live-heading" className="overflow-hidden rounded-lg border border-[#326273]/16 bg-white/80">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[#326273]/12 px-4 py-4">
          <div>
            <h2 id="queue-live-heading" className="text-lg font-bold text-[#1F4452]">Waiting for your decision</h2>
            <p className="mt-1 max-w-2xl text-[13px] font-medium leading-5 text-[#326273]/90">
              Approving re-checks policy and compliance, then sends the payment once every approver has signed.
              Rejecting returns it to the maker.
            </p>
          </div>
          <span className="text-2xl font-bold tabular-nums text-[#1F4452]" aria-label={`${openItems.length} waiting`}>
            {openItems.length}
          </span>
        </div>

        <div
          aria-hidden="true"
          className={`hidden gap-0 border-b border-[#326273]/12 bg-[#1F4452] px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-white/75 md:grid ${GRID}`}
        >
          <span>Proposal</span>
          <span>Kind</span>
          <span>Impact</span>
          <span>Approvers</span>
          <span>Risk</span>
          <span>Decision</span>
        </div>

        <ul className="divide-y divide-[#326273]/10">
          {openItems.length === 0 && (
            <li className="px-4 py-10 text-center">
              <ShieldCheck className="mx-auto h-7 w-7 text-[var(--info)]" aria-hidden="true" />
              <p className="mt-2 text-sm font-bold text-[#1F4452]">Nothing is waiting for a decision in this workspace</p>
              <p className="mt-1 text-[13px] font-medium text-[#326273]/90">
                A payment at or above your approval threshold appears here once its maker authorizes it.
              </p>
            </li>
          )}

          {openItems.map((item) => {
            const busy = inFlight[item.id];
            const confirming = confirmingReject === item.id;
            const note = notes[item.id];
            return (
              <li key={item.id} className="px-4 py-4">
                <div className={`grid grid-cols-1 gap-3 md:items-center ${GRID}`}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FileWarning className="h-4 w-4 shrink-0 text-[var(--pending)]" aria-hidden="true" />
                      <strong className="text-sm text-[#1F4452]">{item.recommendation}</strong>
                    </div>
                    <p className="mt-1 truncate text-[13px] font-medium text-[#326273]/90">
                      {item.id} · maker {item.maker} · {item.expiryLabel}
                    </p>
                  </div>
                  <span className="text-sm font-medium text-[#326273]">{kindLabel(item.kind)}</span>
                  <span className="money text-sm font-medium text-[#1F4452]">{item.amountLabel}</span>
                  <span className="text-sm font-semibold tabular-nums text-[#326273]">
                    {item.approvalsCollected} of {item.requiredApprovers}
                  </span>
                  <span className={`w-fit rounded-md border px-2 py-1 text-[13px] font-bold ${riskClass(item.risk)}`}>
                    {item.risk}
                  </span>

                  {confirming ? (
                    <div
                      role="group"
                      aria-label={`Confirm rejecting ${item.recommendation}`}
                      className="flex flex-wrap items-center gap-2"
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setConfirmingReject(null);
                      }}
                    >
                      <span className="text-[13px] font-semibold text-[#1F4452]">Reject and return it to the maker?</span>
                      <button
                        type="button"
                        autoFocus
                        onClick={() => setConfirmingReject(null)}
                        className="inline-flex h-11 items-center rounded-md border border-[#326273]/25 px-3 text-[13px] font-bold text-[#1F4452] transition hover:bg-[#326273]/5 focus-ring md:h-9"
                      >
                        Keep it
                      </button>
                      <button
                        type="button"
                        onClick={() => decide(item, 'REJECT')}
                        className="inline-flex h-11 items-center rounded-md bg-[var(--error)] px-3 text-[13px] font-bold text-white transition hover:opacity-90 focus-ring md:h-9"
                      >
                        Reject payment
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2" aria-busy={busy ? true : undefined}>
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() => decide(item, 'APPROVE')}
                        className="inline-flex h-11 items-center gap-1.5 rounded-md bg-[#1F4452] px-3 text-[13px] font-bold text-white transition hover:bg-[#326273] focus-ring disabled:cursor-not-allowed disabled:opacity-50 md:h-9"
                      >
                        {busy === 'APPROVE' ? (
                          <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                        )}
                        {busy === 'APPROVE' ? 'Approving…' : 'Approve'}
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() => setConfirmingReject(item.id)}
                        className="inline-flex h-11 items-center gap-1.5 rounded-md border border-[var(--error)] px-3 text-[13px] font-bold text-[var(--error)] transition hover:bg-[var(--error-bg)] focus-ring disabled:cursor-not-allowed disabled:opacity-50 md:h-9"
                      >
                        {busy === 'REJECT' ? (
                          <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                        ) : (
                          <XCircle className="h-4 w-4" aria-hidden="true" />
                        )}
                        {busy === 'REJECT' ? 'Rejecting…' : 'Reject'}
                      </button>
                    </div>
                  )}
                </div>

                {note && (
                  <div className="mt-3">
                    <OutcomeLine outcome={note} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {decided.length > 0 && (
        <section aria-labelledby="queue-decided-heading" className="overflow-hidden rounded-lg border border-[#326273]/16 bg-white/70">
          <div className="border-b border-[#326273]/10 px-4 py-3">
            <h2 id="queue-decided-heading" className="text-sm font-bold text-[#1F4452]">Decided just now</h2>
          </div>
          <ul className="divide-y divide-[#326273]/10">
            {decided.map((item) => (
              <li key={`${item.id}-${item.outcome.kind}`} className="grid gap-2 px-4 py-3 md:grid-cols-[1fr_1.4fr] md:items-start">
                <div className="min-w-0">
                  <strong className="text-sm text-[#1F4452]">{item.recommendation}</strong>
                  <p className="mt-0.5 truncate text-[13px] font-medium text-[#326273]/90">
                    {item.id} · {item.amountLabel}
                  </p>
                </div>
                <OutcomeLine outcome={item.outcome} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section
        aria-labelledby="queue-examples-heading"
        className="rounded-lg border border-dashed border-[#326273]/30 bg-[#326273]/[0.03] p-4"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="queue-examples-heading" className="text-sm font-bold uppercase tracking-[0.14em] text-[#326273]">
            Examples
          </h2>
          <p className="text-[13px] font-medium text-[#326273]/90">
            Sample proposals that show what each lane holds. They are not payments in your workspace and cannot be approved.
          </p>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3 md:grid-cols-5">
          {(Object.keys(laneMeta) as QueueLaneKey[]).map((lane) => {
            const meta = laneMeta[lane];
            const Icon = meta.icon;
            return (
              <div key={lane} className="rounded-lg border border-[#326273]/14 bg-white/60 p-4">
                <div className="flex items-center justify-between gap-3">
                  <Icon className={`h-5 w-5 ${meta.tone}`} aria-hidden="true" />
                  <span className="text-2xl font-bold tabular-nums text-[#1F4452]">{exampleTotals[lane]}</span>
                </div>
                <p className="mt-3 text-sm font-bold text-[#326273]">{meta.label}</p>
              </div>
            );
          })}
        </div>

        {examples.pending.length > 0 && (
          <ul className="mt-4 divide-y divide-[#326273]/10 rounded-lg border border-[#326273]/14 bg-white/60">
            {examples.pending.map((item) => (
              <li key={`example-${item.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="rounded border border-[#326273]/25 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.1em] text-[#326273]/90">
                      Example
                    </span>
                    <strong className="text-sm text-[#1F4452]">{item.recommendation}</strong>
                  </div>
                  <p className="mt-1 text-[13px] font-medium text-[#326273]/90">
                    {kindLabel(item.kind)} · <span className="money">{item.amountLabel}</span> · {item.approvalsCollected} of{' '}
                    {item.requiredApprovers} approvers · {item.expiryLabel}
                  </p>
                </div>
                <span className={`w-fit rounded-md border px-2 py-1 text-[13px] font-bold ${riskClass(item.risk)}`}>{item.risk}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {examples.lanes.map((lane) => {
            const meta = laneMeta[lane.key];
            const Icon = meta.icon;
            return (
              <div key={lane.key} className="rounded-lg border border-[#326273]/14 bg-white/60">
                <div className="flex items-center justify-between border-b border-[#326273]/10 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Icon className={`h-4 w-4 ${meta.tone}`} aria-hidden="true" />
                    <h3 className="text-sm font-bold text-[#1F4452]">{meta.label}</h3>
                  </div>
                  <span className="text-sm font-bold tabular-nums text-[#326273]">{lane.items.length}</span>
                </div>
                <ul className="divide-y divide-[#326273]/10">
                  {lane.items.map((item) => (
                    <li key={`${lane.key}-${item.id}`} className="grid gap-2 px-4 py-3 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <strong className="min-w-0 truncate text-[#1F4452]">{item.recommendation}</strong>
                        <span className="shrink-0 text-[13px] font-bold tabular-nums text-[#326273]/90">{item.expiryLabel}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-[#326273]/90">
                        <span>{kindLabel(item.kind)}</span>
                        <span className="money">{item.amountLabel}</span>
                        {item.reason && <span>{item.reason}</span>}
                      </div>
                    </li>
                  ))}
                  {lane.items.length === 0 && <li className="px-4 py-5 text-sm font-medium text-[#326273]/90">Clear</li>}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Link
          href="/dashboard"
          className="rounded-md border border-[#326273]/20 px-3 py-2 text-sm font-bold text-[#326273] focus-ring"
        >
          Back to Zeke
        </Link>
      </div>
    </>
  );
}
