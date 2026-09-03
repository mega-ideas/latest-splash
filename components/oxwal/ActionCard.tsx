'use client';

import { AlertTriangle, CheckCircle2, ExternalLink, PenLine, Send, ShieldCheck, XCircle } from 'lucide-react';

import { buildActionCardModel, type ActionCardProposal } from '@/lib/agent/action-card';

const actionLabels = {
  sign: 'Sign & approve',
  send: 'Send for approval',
  reject: 'Reject',
} as const;

/* Risk states use semantic tokens (W9.0 coral rule): coral is brand accent
   only — never a risk/error signal. high=error, medium=warn, low=ok. */
function riskClass(tone: ReturnType<typeof buildActionCardModel>['riskTone']) {
  if (tone === 'high') return 'border-[var(--error)] bg-[var(--error-bg)] text-[var(--error-text)]';
  if (tone === 'medium') return 'border-[var(--warn)] bg-[var(--warn-bg)] text-[var(--warn-text)]';
  return 'border-[var(--ok)] bg-[var(--ok-bg)] text-[var(--ok-text)]';
}

function confidenceColor(tone: ReturnType<typeof buildActionCardModel>['riskTone'], hasUntrustedEvidence: boolean) {
  return tone === 'high' || hasUntrustedEvidence ? 'bg-[var(--warn)]' : 'bg-[var(--ok)]';
}

type ActionCardProps = {
  proposal: ActionCardProposal;
  /** View-only rendering for the chat thread: approval actions live in the
   *  queue, so the buttons are replaced by a status note. */
  readOnly?: boolean;
};

export default function ActionCard({ proposal, readOnly = false }: ActionCardProps) {
  const model = buildActionCardModel(proposal);
  const confidenceTone = confidenceColor(model.riskTone, model.hasUntrustedEvidence);

  return (
    <article className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--surface)]">
      <div className="grid gap-4 border-b border-[var(--divider)] p-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-[var(--ink-900)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white">
              {proposal.kind}
            </span>
            <span className={`rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${riskClass(model.riskTone)}`}>
              {proposal.explain.risk} risk
            </span>
            {model.hasUntrustedEvidence && (
              <span className="inline-flex items-center gap-1 rounded-md border border-[var(--warn)] bg-[var(--warn-bg)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--warn-text)]">
                <AlertTriangle className="h-3.5 w-3.5" />
                Untrusted data
              </span>
            )}
            {/* WS2 truth chip — evidence built on DEMO/MODELED sources says so. */}
            {model.containsDemoData && (
              <span className="inline-flex items-center gap-1 rounded-md border border-[var(--warn)] bg-[var(--warn-bg)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--warn-text)]">
                <AlertTriangle className="h-3.5 w-3.5" />
                Contains demo data
              </span>
            )}
          </div>
          <h2 className="mt-3 text-xl font-bold tracking-normal text-[var(--text)]">
            {proposal.explain.recommendation}
          </h2>
          <p className="mt-1 font-mono text-[13px] font-medium text-[var(--text-muted)]">
            {proposal.id} - {proposal.status} - {proposal.corridor ?? 'NO_CORRIDOR'}
          </p>
        </div>

        <div className="min-w-[190px]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">Confidence</span>
            <span className="font-mono text-sm font-bold text-[var(--text)]">{model.confidencePercent}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
            <div className={`h-full rounded-full ${confidenceTone}`} style={{ width: `${model.confidencePercent}%` }} />
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">Approvers</span>
            <span className="font-mono text-sm font-bold text-[var(--text)]">{model.approverText}</span>
          </div>
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[1fr_1fr]">
        <section className="border-b border-[var(--divider)] p-4 lg:border-b-0 lg:border-r">
          <div className="mb-3 flex items-center gap-2 text-sm font-bold text-[var(--text)]">
            <CheckCircle2 className="h-4 w-4 text-[var(--teal-600)]" />
            Impact table
          </div>
          <div className="overflow-hidden rounded-md border border-[var(--line)]">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-[var(--divider)]">
                {model.impactRows.map((item) => (
                  <tr key={item.label}>
                    <th className="bg-[var(--surface-2)] px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                      {item.label}
                    </th>
                    <td className="money px-3 py-2 font-medium text-[var(--text)]">{item.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-bold text-[var(--text)]">
            <ShieldCheck className="h-4 w-4 text-[var(--teal-600)]" />
            Simulation deltas
          </div>
          <div className="divide-y divide-[var(--divider)] rounded-md border border-[var(--line)]">
            {model.simulationRows.map((item) => (
              <div key={`${item.label}-${item.value}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 truncate font-medium text-[var(--text-muted)]">{item.label}</span>
                <span className={item.status === 'warning' ? 'money font-bold text-[var(--warn-text)]' : 'money font-bold text-[var(--text)]'}>
                  {item.value}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="border-t border-[var(--divider)] p-4">
        <div className="mb-3 text-sm font-bold text-[var(--text)]">Evidence</div>
        <div className="flex flex-wrap gap-2">
          {model.evidenceRows.map((item) => (
            <span
              key={`${item.source}-${item.ref}`}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[13px] font-bold ${item.tone === 'untrusted'
                ? 'border-[var(--warn)] bg-[var(--warn-bg)] text-[var(--warn-text)]'
                : 'border-[var(--ok)] bg-[var(--ok-bg)] text-[var(--ok-text)]'}`}
            >
              {item.source} - {item.trustLabel}
              {/* WS2 provenance chip: LIVE keeps default styling; anything else
                  is clearly marked with the existing caution accent. */}
              <span
                className={item.statusTone === 'live'
                  ? 'rounded border border-[var(--ok)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--ok-text)]'
                  : 'rounded border border-[var(--warn)] bg-[var(--warn-bg)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--warn-text)]'}
              >
                {item.statusLabel}
              </span>
            </span>
          ))}
        </div>
      </section>

      <div className="flex flex-col gap-3 border-t border-[var(--divider)] bg-[var(--surface-2)] p-4 md:flex-row md:items-center md:justify-between">
        <details className="group min-w-0 text-sm">
          <summary className="cursor-pointer font-bold text-[var(--text-2)]">Reasoning trace</summary>
          <a
            href={`/api/walrus/${encodeURIComponent(proposal.explain.reasoningTraceRef)}`}
            className="mt-2 inline-flex max-w-full items-center gap-1 break-all font-mono text-[13px] font-medium text-[var(--text-muted)]"
          >
            {proposal.explain.reasoningTraceRef}
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          </a>
        </details>

        {readOnly ? (
          <span className="inline-flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 font-mono text-xs font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">
            <ShieldCheck className="h-4 w-4 text-[var(--teal-600)]" />
            Approve or reject in the queue
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md bg-[var(--ink-900)] px-3 py-2 text-sm font-bold text-white"
            >
              <PenLine className="h-4 w-4" />
              {model.primaryActionLabel}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm font-bold text-[var(--text-2)]"
            >
              <Send className="h-4 w-4" />
              {actionLabels.send}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md border border-[var(--error)] bg-[var(--error-bg)] px-3 py-2 text-sm font-bold text-[var(--error-text)]"
            >
              <XCircle className="h-4 w-4" />
              {actionLabels.reject}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
