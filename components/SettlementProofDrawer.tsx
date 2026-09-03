'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, Database, ExternalLink, FileKey2, Lock, ShieldCheck, XCircle } from 'lucide-react';

type SettlementProofResponse = {
  proof?: {
    receipt: {
      recipient: string;
      sent: string;
      delivered: string;
      rate: string | null;
      feeTier: string;
      status: string;
      source: string;
      reference: string;
      time: string;
    };
    independent: {
      walrusBlobFound: boolean;
      walrusMode: 'demo' | 'live' | null;
      sealPolicyFound: boolean;
      sealMode: 'demo' | 'live' | null;
      ciphertextHash: string | null;
      expectedCiphertextHash: string | null;
      walrusHashVerified: boolean;
      anchorRecorded: boolean;
      auditEventId: string | null;
      suiDigest: string | null;
      verified: boolean;
      checkedAt: string;
      error?: string;
    };
  };
};

type SettlementProofDrawerProps = {
  transferIntentId?: string;
  fallback?: {
    digest?: string | null;
    walrusBlobId?: string | null;
    auditAnchorId?: string | null;
  };
};

export default function SettlementProofDrawer({ transferIntentId, fallback }: SettlementProofDrawerProps) {
  const [proof, setProof] = useState<SettlementProofResponse['proof'] | null>(null);

  useEffect(() => {
    if (!transferIntentId) return;
    let active = true;
    void fetch(`/api/audit/${transferIntentId}`)
      .then((response) => response.ok ? response.json() as Promise<SettlementProofResponse> : null)
      .then((result) => {
        if (!active) return;
        setProof(result?.proof ?? null);
      });
    return () => { active = false; };
  }, [transferIntentId]);

  const independent = proof?.independent;
  const digest = independent?.suiDigest ?? fallback?.digest ?? null;
  const auditEventId = independent?.auditEventId ?? fallback?.auditAnchorId ?? null;
  const checking = Boolean(transferIntentId && !proof);

  return (
    <details className="group rounded-lg border border-[#326273]/15 bg-white/75">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3">
        <span className="inline-flex items-center gap-2 text-sm font-bold text-[#326273]">
          <ShieldCheck className="h-4 w-4 text-[var(--info)]" />
          View independent settlement proof
        </span>
        <ChevronDown className="h-4 w-4 text-[#326273]/55 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-[#326273]/10 px-4 py-4">
        {proof?.receipt && (
          <div className="grid gap-2 text-sm md:grid-cols-2">
            <ProofRow label="Recipient" value={proof.receipt.recipient} />
            <ProofRow label="Delivered" value={proof.receipt.delivered} />
            <ProofRow label="Sent" value={proof.receipt.sent} />
            <ProofRow label="Rate" value={proof.receipt.rate ?? 'Not recorded'} />
            <ProofRow label="Source" value={proof.receipt.source} />
            <ProofRow label="Reference" value={proof.receipt.reference} />
          </div>
        )}

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <CheckTile label="Walrus blob" ok={independent?.walrusBlobFound ?? Boolean(fallback?.walrusBlobId)} icon={Database} detail={fallback?.walrusBlobId ?? independent?.walrusMode ?? 'Pending'} />
          <CheckTile label="Seal policy" ok={independent?.sealPolicyFound ?? false} icon={Lock} detail={independent?.sealMode ?? 'Pending'} />
          <CheckTile label="Hash match" ok={independent?.walrusHashVerified ?? false} icon={FileKey2} detail={independent?.ciphertextHash?.slice(0, 16) ?? 'Pending'} />
        </div>

        <div className="mt-4 rounded-md bg-[#F6F0ED] p-3 text-[13px] text-[#326273]/70">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill ok={independent?.verified ?? false} label={independent?.verified ? 'Verified' : checking ? 'Checking' : 'Needs review'} />
            {independent?.anchorRecorded && <StatusPill ok label="Sui anchor recorded" />}
          </div>
          <div className="mt-3 grid gap-2 font-mono">
            <ProofRow label="Sui digest" value={digest ?? 'Pending'} mono />
            <ProofRow label="Audit event" value={auditEventId ?? 'Pending'} mono />
            <ProofRow label="Expected hash" value={independent?.expectedCiphertextHash ?? 'Pending'} mono />
          </div>
          {digest && (
            <a href={`https://testnet.suivision.xyz/txblock/${digest}`} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 font-bold text-[var(--info)]">
              Open Sui proof
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          {independent?.error && <div className="mt-3 font-semibold text-[#9A4A2D]">{independent.error}</div>}
        </div>
      </div>
    </details>
  );
}

function ProofRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 justify-between gap-3">
      <span className="shrink-0 font-semibold text-[#326273]/55">{label}</span>
      <span className={`min-w-0 break-all text-right font-medium text-[#326273] ${mono ? 'font-mono text-[13px]' : ''}`}>{value}</span>
    </div>
  );
}

function CheckTile({ label, ok, icon: Icon, detail }: { label: string; ok: boolean; icon: typeof ShieldCheck; detail: string }) {
  return (
    <div className={`rounded-md border p-3 ${ok ? 'border-[#5C9EAD]/35 bg-[#5C9EAD]/10' : 'border-[#E39774]/40 bg-[#E39774]/10'}`}>
      <div className="flex items-center justify-between gap-2">
        <Icon className={`h-4 w-4 ${ok ? 'text-[var(--info)]' : 'text-[#E39774]'}`} />
        {ok ? <CheckCircle2 className="h-4 w-4 text-[var(--info)]" /> : <XCircle className="h-4 w-4 text-[#E39774]" />}
      </div>
      <div className="mt-2 text-sm font-bold text-[#326273]">{label}</div>
      <div className="mt-1 break-all font-mono text-[13px] text-[#326273]/55">{detail}</div>
    </div>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-[13px] font-bold ${ok ? 'bg-[#5C9EAD]/15 text-[#326273]' : 'bg-[#E39774]/15 text-[#9A4A2D]'}`}>
      {label}
    </span>
  );
}
