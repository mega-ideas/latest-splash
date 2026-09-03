'use client';

import { useEffect, useState } from 'react';
import { ClipboardCheck, Copy, Database, ExternalLink, FileText, Lock, ShieldCheck, Timer } from 'lucide-react';
import { toast } from 'sonner';

import type { AuditReceipt, InvoiceRecord, SweepJob, TransferIntentRecord } from '@/lib/server/operations';
import type { SealPolicy } from '@/lib/server/seal';

type AuditView = { transfer: TransferIntentRecord; receipt: AuditReceipt; invoice: InvoiceRecord | null; sweepJob: SweepJob | null; policy: SealPolicy | null };

export default function AuditPage({ params }: { params: Promise<{ intentId: string }> }) {
  const [intentId, setIntentId] = useState('');
  const [view, setView] = useState<AuditView | null>(null);
  const [verifyState, setVerifyState] = useState<'idle' | 'loading' | 'verified' | 'mismatch'>('idle');
  useEffect(() => { void params.then(({ intentId: id }) => setIntentId(id)); }, [params]);
  useEffect(() => {
    if (!intentId) return;
    void fetch(`/api/audit/${intentId}`).then((response) => response.json()).then(setView);
  }, [intentId]);

  async function verify() {
    setVerifyState('loading');
    const response = await fetch(`/api/audit/${intentId}`, { method: 'POST' });
    const result = (await response.json()) as { verified?: boolean };
    setVerifyState(result.verified ? 'verified' : 'mismatch');
  }

  if (!view) return <div className="mx-auto max-w-5xl py-20 text-center text-foreground/50">Loading audit chain...</div>;
  const rows = [
    { icon: ClipboardCheck, label: 'Funding', value: view.receipt.funding ? `${view.receipt.funding.method} / ${view.receipt.funding.asset ?? view.receipt.funding.provider ?? 'bank'} / ${view.receipt.funding.feeTier}` : 'Legacy USD / STANDARD' },
    { icon: FileText, label: 'Invoice', value: view.invoice?.id ?? 'Not linked' },
    { icon: Database, label: 'Walrus blob', value: view.receipt.walrusBlobId ?? 'Not stored' },
    { icon: Lock, label: 'Seal policy', value: view.receipt.sealPolicyId ?? 'Not encrypted' },
    { icon: ShieldCheck, label: 'Seal allowlist', value: view.policy?.allowlist.join(', ') ?? 'Policy unavailable' },
    { icon: ClipboardCheck, label: 'Approval', value: view.receipt.approvedBy ? `${view.receipt.approvedBy} · ${view.receipt.approvedAt}` : 'Authorization recorded in status history' },
    { icon: ShieldCheck, label: 'Sui digest', value: view.receipt.suiTxDigest ?? 'Pending' },
    { icon: Timer, label: 'Sweep proof', value: view.sweepJob ? `${view.sweepJob.partnerPayoutRef} · held ${((view.sweepJob.heldDurationMs ?? 0) / 1000).toFixed(1)}s` : 'No sweep required' },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><span className="dash-kicker">Private to the world, provable to the auditor</span><h1 className="dash-title mt-2">Audit trail</h1><p className="mt-1 font-mono text-[13px] text-foreground/45">{intentId}</p></div>
        <button onClick={verify} className="rounded-xl bg-accent px-5 py-3 font-bold text-card">{verifyState === 'loading' ? 'Verifying...' : 'Verify document hash'}</button>
      </header>
      {verifyState !== 'idle' && verifyState !== 'loading' && <div className={`rounded-2xl p-4 font-bold ${verifyState === 'verified' ? 'bg-primary/15 text-primary' : 'bg-destructive/10 text-destructive'}`}>{verifyState === 'verified' ? 'Hash verified' : 'Hash mismatch'}</div>}
      <section className="grid gap-3 md:grid-cols-2">
        {rows.map(({ icon: Icon, label, value }) => <div key={label} className="dash-block p-5"><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-foreground/45"><Icon className="h-4 w-4 text-primary" /> {label}</div><div className="mt-3 break-all font-mono text-sm font-semibold">{value}</div></div>)}
      </section>
      <section className="dash-surface p-6">
        <h2 className="text-lg font-bold">0xWal extraction snapshot</h2>
        <pre className="mt-4 overflow-x-auto rounded-xl bg-muted/60 p-4 text-[13px] font-semibold text-foreground/70">{JSON.stringify(view.receipt.extractionSnapshot ?? { status: 'No extraction snapshot linked' }, null, 2)}</pre>
      </section>
      <section className="dash-surface p-6"><h2 className="text-lg font-bold">Status history</h2><div className="mt-5 space-y-4">{view.receipt.statusHistory.map((event, index) => <div key={`${event.state}-${event.at}`} className="grid grid-cols-[auto_1fr_auto] items-center gap-3"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-[13px] font-bold text-card">{index + 1}</span><strong>{event.state}</strong><time className="text-[13px] text-foreground/45">{new Date(event.at).toLocaleString()}</time></div>)}</div></section>
      {view.receipt.suiTxDigest && <a href={`https://testnet.suivision.xyz/txblock/${view.receipt.suiTxDigest}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-bold text-primary">Open Sui proof <ExternalLink className="h-4 w-4" /></a>}
      {view.receipt.suiTxDigest && <button onClick={() => { void navigator.clipboard.writeText(view.receipt.suiTxDigest!); toast.success('Sui digest copied'); }} className="ml-3 inline-flex items-center gap-2 text-sm font-bold text-primary"><Copy className="h-4 w-4" /> Copy Sui digest</button>}
      <button onClick={() => { void navigator.clipboard.writeText(intentId); toast.success('Intent ID copied'); }} className="ml-3 inline-flex items-center gap-2 text-sm font-bold text-primary"><Copy className="h-4 w-4" /> Copy intent ID</button>
    </div>
  );
}
