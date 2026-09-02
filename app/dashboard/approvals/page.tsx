'use client';

import { Check, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { EmptyState as IsoEmptyState } from '@/components/illustrations/iso';
import { Badge, Button, Card, Chip, EmptyState, PolicyCard, ProofRow, Skeleton, Table } from '@/components/system';
import type { BadgeTone } from '@/components/system';
import { brand } from '@/lib/brand';
import { getNetworkProfile } from '@/lib/network';
import { recordPendingProposals } from '@/lib/oxwal-notify';
import { cn } from '@/lib/utils';

type Proposal = {
  id: string;
  kind: string;
  status: string;
  corridor: string | null;
  recommendation: string;
  createdBy: string;
  approvalHash: string | null;
  evidenceQuality: 'trusted' | 'untrusted';
  amountLabel: string | null;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | string;
  approvalsCollected: number;
  requiredApprovers: number;
  createdAt: string;
  expiresAt: string | null;
};

type Settings = {
  perTransferLimitUsd: number;
  dailyLimitUsd: number;
  approvalThresholdUsd: number;
  requireTotp: boolean;
  requireDualApproval: boolean;
  blockHighRiskCorridors: boolean;
};

const usd = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const KIND_LABEL: Record<string, string> = {
  PAYMENT: 'Payment',
  INTERNAL_TRANSFER: 'Internal transfer',
  FX_CONVERT: 'FX conversion',
  TREASURY_ALLOCATE: 'Treasury allocation',
  TREASURY_REDEEM: 'Treasury withdrawal',
  BATCH_PAYOUT: 'Batch payout',
  NETTING_SETTLE: 'Offset simulation (roadmap)',
};

function riskTone(risk: string): BadgeTone {
  return risk === 'HIGH' ? 'red' : risk === 'MEDIUM' ? 'amber' : 'green';
}

function statusTone(status: string): BadgeTone {
  if (['APPROVED', 'SIGNED', 'SUBMITTED', 'EXECUTED', 'ANCHORED'].includes(status)) return 'green';
  if (['REJECTED', 'FAILED', 'EXPIRED', 'REVERSED'].includes(status)) return 'red';
  return 'amber';
}

/** Which policy a proposal trips, in plain words. */
function policyHit(proposal: Proposal, settings: Settings | null): string {
  if (!settings) return 'Policy evaluated server-side';
  const amount = Number.parseFloat((proposal.amountLabel ?? '0').replace(/[^0-9.]/g, ''));
  if (proposal.evidenceQuality === 'untrusted') return 'Untrusted evidence · manual review';
  if (proposal.requiredApprovers > 1) return `Dual approval · above ${usd.format(settings.approvalThresholdUsd)} USD`;
  if (Number.isFinite(amount) && amount > settings.perTransferLimitUsd) return `Over per-transfer limit (${usd.format(settings.perTransferLimitUsd)} USD)`;
  return 'Within limits · one approver';
}

/**
 * Approvals: the policies a human set, the queue those policies produced,
 * and the decisions taken. Approve/Reject go through the one real path
 * (POST /api/proposals/[id]/submit) with the approval hash the reviewer saw.
 */
export default function ApprovalsPage() {
  const [queue, setQueue] = useState<Proposal[] | null>(null);
  const [history, setHistory] = useState<Proposal[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selected, setSelected] = useState<Proposal | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const corridors = getNetworkProfile().corridors;

  const load = useCallback(async () => {
    const [queueRes, historyRes, settingsRes] = await Promise.all([
      fetch('/api/proposals', { cache: 'no-store' }),
      fetch('/api/proposals?scope=history', { cache: 'no-store' }),
      fetch('/api/settings', { cache: 'no-store' }),
    ]);
    const open = queueRes.ok ? ((await queueRes.json()) as { items: Proposal[] }).items : [];
    setQueue(open);
    recordPendingProposals({ count: open.length, label: open[0]?.recommendation ?? null });
    setHistory(historyRes.ok ? ((await historyRes.json()) as { items: Proposal[] }).items : []);
    setSettings(settingsRes.ok ? ((await settingsRes.json()) as Settings) : null);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => void load(), 15_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [load]);

  const policies = useMemo(() => {
    if (!settings) return [];
    return [
      {
        title: 'Per-transfer limit',
        scope: 'All corridors',
        rule: `No single payout above ${usd.format(settings.perTransferLimitUsd)} USD leaves the desk without a policy exception.`,
        chips: ['spend_meter', 'policy engine'],
      },
      {
        title: 'Daily limit',
        scope: 'Rolling 24 hours',
        rule: `Outflows are capped at ${usd.format(settings.dailyLimitUsd)} USD per day, summed from the ledger, not from the client.`,
        chips: ['ledger', 'circuit breaker'],
      },
      {
        title: 'Maker-checker',
        scope: settings.requireDualApproval ? 'Dual approval on' : 'Single approver',
        rule: settings.requireDualApproval
          ? `Any proposal above ${usd.format(settings.approvalThresholdUsd)} USD needs a second, distinct approver before the transaction is signed.`
          : `Proposals above ${usd.format(settings.approvalThresholdUsd)} USD are flagged for review; one approver signs.`,
        chips: ['maker ≠ checker', settings.requireTotp ? 'TOTP required' : 'TOTP off'],
        status: settings.requireDualApproval ? { label: 'Enforced', tone: 'green' as const } : { label: 'Relaxed', tone: 'amber' as const },
      },
      {
        title: 'Corridor allowlist',
        scope: corridors.map((corridor) => corridor.currency).join(' · '),
        rule: settings.blockHighRiskCorridors ? 'Payouts settle only to enabled corridors; high-risk routes are blocked in preflight and again at submit.' : 'High-risk corridors are not blocked by policy. Review this before mainnet.',
        chips: corridors.map((corridor) => corridor.partnerLabel),
        status: settings.blockHighRiskCorridors ? { label: 'Enforced', tone: 'green' as const } : { label: 'Open', tone: 'amber' as const },
      },
    ];
  }, [corridors, settings]);

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
      const text = decision === 'APPROVE' ? `Approved — ${remaining} remaining` : `Rejected — ${remaining} remaining`;
      setAnnouncement(text);
      toast.success(body.message ?? text);
      setSelected(null);
      setReason('');
      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Decision was not recorded');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 pb-24 md:pb-0">
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[var(--text-h1)] font-semibold leading-[1.1] tracking-[-0.02em]">Approvals</h1>
          <p className="mt-1 text-[14px] text-[var(--text-2)]">
            {brand.agentName} proposes → a human approves → deterministic execution. Nothing here can move money on its own.
          </p>
        </div>
        <Button variant="ghost" href="/dashboard/settings">
          Edit policies
        </Button>
      </header>

      <section className="grid gap-3 md:grid-cols-2" aria-label="Policies">
        {settings ? policies.map((policy) => <PolicyCard key={policy.title} {...policy} />) : <><Skeleton /><Skeleton /></>}
      </section>

      <section className="grid gap-3" aria-label="Queue">
        <h2 className="text-[15px] font-semibold">Queue</h2>
        <Table
          caption="Awaiting approval"
          exportName="approvals-queue"
          rows={queue ?? []}
          loading={queue === null}
          emptyState={<EmptyState art={<IsoEmptyState kind="approvals" decorative />} title="Nothing awaiting approval" body={`Proposals ${brand.agentName} prepares appear here with their impact, evidence and the policy they trip.`} />}
          columns={[
            { key: 'recommendation', header: 'Proposal', value: (row) => row.recommendation, render: (row) => (
              <span className="grid">
                <span className="font-medium">{KIND_LABEL[row.kind] ?? row.kind}</span>
                <span className="text-[13px] text-[var(--text-2)]">{row.recommendation}</span>
              </span>
            ) },
            { key: 'createdBy', header: 'Requester', mono: true, secondary: true, value: (row) => row.createdBy },
            { key: 'amountLabel', header: 'Amount', align: 'right', mono: true, value: (row) => row.amountLabel ?? '', render: (row) => row.amountLabel ?? '—' },
            { key: 'corridor', header: 'Corridor', value: (row) => row.corridor ?? '', render: (row) => row.corridor ?? '—' },
            { key: 'policy', header: 'Policy hit', value: (row) => policyHit(row, settings), render: (row) => (
              <span className="grid gap-1">
                <span className="text-[13px]">{policyHit(row, settings)}</span>
                <span className="flex gap-1">
                  <Badge tone={riskTone(row.risk)}>{row.risk}</Badge>
                  {row.evidenceQuality === 'untrusted' ? <Badge tone="amber">Untrusted data</Badge> : null}
                </span>
              </span>
            ) },
          ]}
          rowAction={(row) => (
            <Button size="sm" variant={selected?.id === row.id ? 'primary' : 'ghost'} onClick={() => setSelected(row)} aria-pressed={selected?.id === row.id}>
              Review
            </Button>
          )}
        />
      </section>

      {selected ? (
        <Card className="grid gap-4" aria-label={`Review ${selected.id}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-[15px] font-semibold">{KIND_LABEL[selected.kind] ?? selected.kind}</h2>
              <p className="text-[14px] text-[var(--text-2)]">{selected.recommendation}</p>
            </div>
            <Badge tone={riskTone(selected.risk)}>{selected.risk} risk</Badge>
          </div>
          <dl>
            <ProofRow label="Amount" value={selected.amountLabel ?? '—'} mono />
            <ProofRow label="Corridor" value={selected.corridor ?? '—'} />
            <ProofRow label="Requested by" value={selected.createdBy} mono />
            <ProofRow label="Approvals" value={`${selected.approvalsCollected} of ${selected.requiredApprovers}`} />
            <ProofRow label="Policy" value={policyHit(selected, settings)} />
            <ProofRow label="Approval hash" value={selected.approvalHash ? `${selected.approvalHash.slice(0, 18)}…` : 'not bound'} mono />
            <ProofRow label="Expires" value={selected.expiresAt ? selected.expiresAt.slice(0, 16).replace('T', ' ') : '—'} mono />
          </dl>
          <div className="flex flex-wrap gap-1.5">
            <Chip>simulated</Chip>
            <Chip tone="teal">policy re-evaluated at submit</Chip>
            <Chip tone="green">signed by a human</Chip>
          </div>
          <label className="grid gap-1 text-[14px] font-semibold">
            Reason (optional)
            <input value={reason} onChange={(event) => setReason(event.target.value.slice(0, 280))} placeholder="Recorded with the decision" className="h-11 rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface)] px-3 text-[16px] font-normal outline-none focus:border-[var(--teal-600)]" />
          </label>
          <div className="hidden gap-2 md:flex">
            <Button onClick={() => void decide('APPROVE')} disabled={busy}>
              <Check aria-hidden="true" /> Approve
            </Button>
            <Button variant="destructive-text" onClick={() => void decide('REJECT')} disabled={busy}>
              <X aria-hidden="true" /> Reject
            </Button>
            <Button variant="ghost" onClick={() => setSelected(null)} disabled={busy}>
              Close
            </Button>
          </div>
          <p className="inline-flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
            <ShieldCheck className="size-4" aria-hidden="true" /> Your approval binds the canonical hash you reviewed; if the proposal changes, the server refuses it and asks you to re-approve.
          </p>
        </Card>
      ) : null}

      {/* Mobile decision bar: two full-width buttons in the safe area. */}
      {selected ? (
        <div className={cn('fixed inset-x-0 bottom-14 z-30 grid grid-cols-2 gap-2 border-t border-[var(--divider)] bg-[var(--surface)] p-3 md:hidden')}>
          <Button size="lg" fullWidth onClick={() => void decide('APPROVE')} disabled={busy}>
            Approve
          </Button>
          <Button size="lg" fullWidth variant="destructive-text" onClick={() => void decide('REJECT')} disabled={busy} className="border border-[var(--error)]">
            Reject
          </Button>
        </div>
      ) : null}

      <section className="grid gap-3" aria-label="History">
        <h2 className="text-[15px] font-semibold">History</h2>
        <Table
          caption="Decisions"
          exportName="approvals-history"
          rows={history ?? []}
          loading={history === null}
          emptyState={<p className="text-[14px] text-[var(--text-muted)]">No decisions recorded yet.</p>}
          columns={[
            { key: 'createdAt', header: 'When', mono: true, secondary: true, value: (row) => row.createdAt, render: (row) => row.createdAt.slice(0, 16).replace('T', ' ') },
            { key: 'kind', header: 'Proposal', value: (row) => KIND_LABEL[row.kind] ?? row.kind, render: (row) => KIND_LABEL[row.kind] ?? row.kind },
            { key: 'amountLabel', header: 'Amount', align: 'right', mono: true, value: (row) => row.amountLabel ?? '', render: (row) => row.amountLabel ?? '—' },
            { key: 'status', header: 'Outcome', value: (row) => row.status, render: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge> },
          ]}
        />
      </section>
    </div>
  );
}
