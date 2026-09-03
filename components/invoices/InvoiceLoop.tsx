'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  BadgeCheck,
  Bot,
  CheckCircle2,
  Copy,
  Database,
  FileText,
  FileUp,
  KeyRound,
  Loader2,
  Lock,
  Route,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import MemWalBehaviorCard from '@/components/MemWalBehaviorCard';
import OxWalComposer, { type OxWalComposerChip } from '@/components/oxwal/OxWalComposer';
import StatusBadge from '@/components/StatusBadge';
import { stashBatchDraft } from '@/lib/batch-parse';
import type { CopilotSuggestion } from '@/lib/server/copilot';
import type { InvoiceRecord } from '@/lib/server/operations';

type Extraction = { amount: number; currency: string; recipient: string; confidence: number };
type WalrusProof = { blobId: string; sizeBytes: number; epochs: number; mode: 'demo' | 'live'; createdAt: string };
type GateState = 'complete' | 'active' | 'locked' | 'warning';
type GateStage = { label: string; detail: string; state: GateState; icon: LucideIcon };

const invoicePromptChips: OxWalComposerChip[] = [
  { label: 'Extract invoice', prompt: 'Extract and recommend route for the selected invoice', icon: 'file' },
  { label: 'Check Seal', prompt: 'Check Seal access for Splash Demo Ltd', icon: 'search' },
  { label: 'Open action desk', prompt: 'Open action desk', icon: 'write' },
];

export default function InvoiceLoop() {
  const router = useRouter();
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [selected, setSelected] = useState<InvoiceRecord | null>(null);
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [suggestion, setSuggestion] = useState<CopilotSuggestion | null>(null);
  const [access, setAccess] = useState<Record<string, boolean>>({});
  const [proof, setProof] = useState<WalrusProof | null>(null);
  const [prompt, setPrompt] = useState('');
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [checkingIdentity, setCheckingIdentity] = useState<string | null>(null);

  const allowedIdentities = useMemo(
    () => [selected?.issuerOrg, selected?.payerOrgEmail ?? selected?.payerOrgName, 'auditor']
      .filter((identity): identity is string => Boolean(identity)),
    [selected],
  );
  const accessChecks = Object.entries(access);
  const hasGrantedAccess = accessChecks.some(([, granted]) => granted);
  const selectedAmount = selected ? `${formatUsd(selected.amountUsd)} -> ${selected.targetCurrency}` : 'No invoice selected';
  const selectedCounterparty = selected?.payerOrgName ?? selected?.payerOrgEmail ?? 'No counterparty selected';
  const confidenceLabel = suggestion ? `${Math.round(suggestion.confidence * 100)}%` : extraction ? `${Math.round(extraction.confidence * 100)}%` : 'Pending';
  const transferHref = selected ? `/dashboard/transfer?invoiceId=${selected.id}` : '/dashboard/transfer';

  const releaseStages = useMemo<GateStage[]>(() => [
    {
      label: 'Invoice intake',
      detail: selected ? selectedCounterparty : 'Upload or select a document',
      state: selected ? 'complete' : 'active',
      icon: FileText,
    },
    {
      label: 'Walrus proof',
      detail: selected?.walrusBlobId ? shortId(selected.walrusBlobId) : 'Ciphertext proof missing',
      state: selected?.walrusBlobId ? 'complete' : selected ? 'warning' : 'locked',
      icon: Database,
    },
    {
      label: 'Seal access',
      detail: hasGrantedAccess ? 'Allowed identity verified' : selected?.sealPolicyId ? 'Policy ready to test' : 'No policy on record',
      state: hasGrantedAccess ? 'complete' : selected?.sealPolicyId ? 'active' : 'locked',
      icon: Lock,
    },
    {
      label: '0xWal draft',
      detail: suggestion ? 'Route recommendation ready' : selected ? 'Ready for extraction' : 'Needs invoice first',
      state: suggestion ? 'complete' : selected ? 'active' : 'locked',
      icon: Sparkles,
    },
    {
      label: 'Payment intent',
      detail: suggestion ? 'Transfer flow is unlocked' : 'Requires a recommendation',
      state: suggestion ? 'active' : 'locked',
      icon: Route,
    },
  ], [hasGrantedAccess, selected, selectedCounterparty, suggestion]);

  async function load() {
    const response = await fetch('/api/invoices');
    const result = (await response.json()) as { invoices: InvoiceRecord[] };
    setInvoices(result.invoices);
    setSelected((current) => current ?? result.invoices[0] ?? null);
  }

  useEffect(() => {
    let active = true;
    void fetch('/api/invoices')
      .then((response) => response.json())
      .then((result: { invoices: InvoiceRecord[] }) => {
        if (!active) return;
        setInvoices(result.invoices);
        setSelected((current) => current ?? result.invoices[0] ?? null);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selected?.walrusBlobId) {
      return;
    }
    let active = true;
    void fetch(`/api/walrus/${encodeURIComponent(selected.walrusBlobId)}`)
      .then((response) => response.ok ? response.json() as Promise<WalrusProof> : null)
      .then((result) => { if (active) setProof(result); })
      .catch(() => { if (active) setProof(null); });
    return () => { active = false; };
  }, [selected?.walrusBlobId]);

  async function upload(file: File) {
    setUploading(true);
    try {
      const documentBase64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.readAsDataURL(file);
      });
      const response = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issuerOrg: 'Splash Demo Ltd',
          payerOrgName: 'Acme Manufacturing PH',
          payerOrgEmail: 'finance@acme-ph.example',
          amountUsd: 5000,
          targetCurrency: 'PHP',
          dueDate: '2026-06-28',
          memo: 'Acme PH component supply',
          documentBase64,
        }),
      });
      const result = (await response.json()) as { invoice?: InvoiceRecord };
      if (!response.ok || !result.invoice) {
        toast.error('Invoice upload failed');
        return;
      }
      setSelected(result.invoice);
      setExtraction(null);
      setSuggestion(null);
      setProof(null);
      await load();
      toast.success('Encrypted and stored on Walrus');
    } finally {
      setUploading(false);
    }
  }

  function chooseInvoice(invoice: InvoiceRecord) {
    setSelected(invoice);
    setExtraction(null);
    setSuggestion(null);
    setProof(null);
    setAccess({});
  }

  async function checkAccess(identity: string) {
    if (!selected?.sealPolicyId) return;
    setCheckingIdentity(identity);
    try {
      const response = await fetch('/api/seal/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policyId: selected.sealPolicyId, identity }),
      });
      const result = (await response.json()) as { granted: boolean };
      setAccess((current) => ({ ...current, [identity]: result.granted }));
    } finally {
      setCheckingIdentity(null);
    }
  }

  async function extract() {
    if (!selected) return;
    setExtracting(true);
    try {
      const response = await fetch('/api/copilot/extract-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: selected.id }),
      });
      if (!response.ok) throw new Error('Invoice extraction failed');
      const result = (await response.json()) as { extraction: Extraction; suggestion: CopilotSuggestion };
      setExtraction(result.extraction);
      setSuggestion(result.suggestion);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Invoice extraction failed');
    } finally {
      setExtracting(false);
    }
  }

  function runPrompt(rawPrompt = prompt) {
    const text = rawPrompt.trim();
    if (!text) return;
    setPrompt('');

    const lower = text.toLowerCase();
    if (lower.includes('open action') || lower.includes('chat')) {
      router.push('/dashboard');
      return;
    }

    if (lower.includes('seal') || lower.includes('access')) {
      if (!selected?.sealPolicyId) {
        toast.error('Select an invoice with a Seal policy first');
        return;
      }
      void checkAccess('Splash Demo Ltd');
      toast.success('Seal access check started');
      return;
    }

    if (!selected) {
      toast.error('Upload or select an invoice first');
      return;
    }
    void extract();
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5">
      <header className="overflow-hidden rounded-lg border border-[#0C3E48]/20 bg-[#0C3E48] text-white shadow-[8px_8px_0_rgba(12,62,72,0.16)]">
        <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_420px] lg:p-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md border border-white/20 bg-white/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/70">
                Seal &middot; Walrus audit trail
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-[#D9A441]/35 bg-[#D9A441]/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#FFE6A4]">
                <ShieldCheck className="h-3.5 w-3.5" />
                Human release gate
              </span>
            </div>
            <h1 className="mt-4 max-w-3xl text-3xl font-bold tracking-tight text-white md:text-4xl">
              0xWal invoice command desk
            </h1>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-6 text-white/70">
              Move a private invoice from encrypted document to verifiable recommendation, then into a payment intent only after evidence and access checks are visible.
            </p>
            <div className="mt-5 grid gap-2 sm:grid-cols-4">
              <CommandMetric label="Case" value={selected ? selected.status : 'Waiting'} />
              <CommandMetric label="Amount" value={selectedAmount} />
              <CommandMetric label="Proof" value={proof ? proof.mode : selected?.walrusBlobId ? 'Loading' : 'Missing'} />
              <CommandMetric label="Confidence" value={confidenceLabel} />
            </div>
          </div>

          <div className="rounded-lg border border-white/15 bg-white/8 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45">Active invoice</div>
                <div className="mt-2 truncate text-xl font-bold text-white">{selectedCounterparty}</div>
                <div className="mt-1 text-[13px] font-medium text-white/55">
                  {selected ? `${selected.id} / due ${formatDate(selected.dueDate)}` : 'Select or upload an invoice to begin.'}
                </div>
              </div>
              <Link
                href="/dashboard"
                className="inline-flex shrink-0 items-center gap-2 rounded-md border border-white/20 bg-white/10 px-3 py-2 text-[13px] font-bold text-white transition hover:bg-white/15 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/20"
              >
                <Bot className="h-4 w-4" />
                Chat
              </Link>
            </div>
            <div className="mt-4 grid gap-2 text-[13px] font-semibold text-white/65">
              <HeroRow label="Walrus" value={selected?.walrusBlobId ? shortId(selected.walrusBlobId) : 'No blob'} />
              <HeroRow label="Seal" value={selected?.sealPolicyId ? shortId(selected.sealPolicyId) : 'No policy'} />
              <HeroRow label="Route" value={suggestion?.title ?? 'Not recommended'} />
            </div>
          </div>
        </div>
      </header>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_390px]">
        <div className="space-y-4">
          <section className="rounded-lg border border-[#326273]/15 bg-white/85 p-4 shadow-[0_18px_38px_-28px_rgba(50,98,115,0.45)] md:p-5">
            <SectionTitle
              icon={Sparkles}
              eyebrow="Inspection console"
              title="What should 0xWal inspect?"
              body="Use the prompt when you know the task, or work through the evidence panels below."
            />
            <div className="mt-4">
              <OxWalComposer
                title="What should 0xWal inspect?"
                value={prompt}
                onChange={setPrompt}
                onSubmit={() => runPrompt()}
                onChipSubmit={runPrompt}
                onFilePrepared={(batch) => { stashBatchDraft(batch); router.push('/dashboard/batch?draft=1'); }}
                chips={invoicePromptChips}
                disabled={uploading || extracting}
                placeholder="Ask 0xWal, or attach a payout sheet"
                compact
                className="max-w-none text-left [&_h2]:sr-only"
              />
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
            <UploadPanel uploading={uploading} onUpload={(file) => void upload(file)} />
            <InvoicePanel invoices={invoices} selected={selected} onSelect={chooseInvoice} />
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <WalrusPanel selected={selected} proof={proof} />
            <SealPanel
              selected={selected}
              identities={allowedIdentities}
              access={access}
              checkingIdentity={checkingIdentity}
              onCheck={(identity) => void checkAccess(identity)}
            />
          </section>

          <ExtractionPanel
            selected={selected}
            extraction={extraction}
            suggestion={suggestion}
            extracting={extracting}
            onExtract={() => void extract()}
          />
        </div>

        <aside className="space-y-4">
          <ReleaseRail stages={releaseStages} />
          <MemWalBehaviorCard compact />
          <IntentPanel selected={selected} suggestion={suggestion} href={transferHref} />
        </aside>
      </section>
    </div>
  );
}

function CommandMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-white/15 bg-white/10 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/45">{label}</div>
      <div className="mt-1 truncate text-sm font-bold text-white">{value}</div>
    </div>
  );
}

function HeroRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-white/10 bg-white/8 px-3 py-2">
      <span className="text-white/45">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-white/82">{value}</span>
    </div>
  );
}

function SectionTitle({
  icon: Icon,
  eyebrow,
  title,
  body,
}: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#5C9EAD]/12 text-[#326273]">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--info)]">{eyebrow}</div>
        <h2 className="mt-1 text-lg font-bold text-[#1F4452]">{title}</h2>
        <p className="mt-1 text-[13px] font-medium leading-5 text-[#326273]/60">{body}</p>
      </div>
    </div>
  );
}

function UploadPanel({ uploading, onUpload }: { uploading: boolean; onUpload: (file: File) => void }) {
  return (
    <section className="rounded-lg border border-[#326273]/15 bg-white/80 p-4 shadow-sm md:p-5">
      <SectionTitle
        icon={FileUp}
        eyebrow="Intake"
        title="Encrypted document"
        body="Upload a PDF or image. Demo metadata is attached so the full loop can run immediately."
      />
      <label className="mt-4 flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-[#5C9EAD]/35 bg-[#5C9EAD]/8 p-5 text-center transition hover:border-[#5C9EAD]/70 hover:bg-[#5C9EAD]/12">
        <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-white text-[#326273] shadow-sm">
          {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <UploadCloud className="h-5 w-5" />}
        </span>
        <strong className="mt-3 text-sm text-[#1F4452]">{uploading ? 'Encrypting and storing...' : 'Drop or choose a PDF/image'}</strong>
        <small className="mt-1 text-[13px] font-medium leading-5 text-[#326273]/55">Demo defaults to Acme PH, $5,000, due Jun 28.</small>
        <input
          type="file"
          accept=".pdf,image/*"
          className="hidden"
          disabled={uploading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onUpload(file);
          }}
        />
      </label>
    </section>
  );
}

function InvoicePanel({
  invoices,
  selected,
  onSelect,
}: {
  invoices: InvoiceRecord[];
  selected: InvoiceRecord | null;
  onSelect: (invoice: InvoiceRecord) => void;
}) {
  return (
    <section className="rounded-lg border border-[#326273]/15 bg-white/80 p-4 shadow-sm md:p-5">
      <SectionTitle
        icon={FileText}
        eyebrow="Case file"
        title="Invoice queue"
        body="Select the document 0xWal should inspect. Switching resets extraction and access evidence for clarity."
      />
      <div className="mt-4 grid gap-2">
        {invoices.length > 0 ? invoices.map((invoice) => {
          const active = selected?.id === invoice.id;
          return (
            <button
              key={invoice.id}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(invoice)}
              className={`grid min-h-20 gap-1 rounded-lg border p-3 text-left transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/20 ${active ? 'border-[#0C3E48] bg-[#0C3E48] text-white shadow-[0_12px_24px_rgba(12,62,72,0.16)]' : 'border-[#326273]/12 bg-white text-[#326273] hover:border-[#5C9EAD]/65 hover:bg-[#F8FCFD]'}`}
            >
              <span className="flex items-center justify-between gap-3">
                <strong className="truncate text-sm">{invoice.payerOrgName ?? invoice.id}</strong>
                <span className={active ? 'text-[10px] font-semibold uppercase tracking-[0.12em] text-[#BFE6EE]' : 'text-[10px] font-semibold uppercase tracking-[0.12em] text-[#326273]/45'}>{invoice.status}</span>
              </span>
              <span className={active ? 'text-[13px] font-medium text-white/65' : 'text-[13px] font-medium text-[#326273]/60'}>
                {formatUsd(invoice.amountUsd)} {'->'} {invoice.targetCurrency} / due {formatDate(invoice.dueDate)}
              </span>
              <span className={active ? 'truncate font-mono text-[13px] text-white/55' : 'truncate font-mono text-[13px] text-[#326273]/45'}>{invoice.id}</span>
            </button>
          );
        }) : (
          <p className="rounded-lg border border-[#326273]/10 bg-[#F6F0ED]/60 p-4 text-sm font-medium text-[#326273]/60">
            No invoices are loaded yet.
          </p>
        )}
      </div>
    </section>
  );
}

function WalrusPanel({ selected, proof }: { selected: InvoiceRecord | null; proof: WalrusProof | null }) {
  const blobId = selected?.walrusBlobId;
  return (
    <section className="rounded-lg border border-[#326273]/15 bg-white/80 p-4 shadow-sm md:p-5">
      <SectionTitle
        icon={Database}
        eyebrow="Evidence"
        title="Walrus proof"
        body="Keep the blob identifier visible before any recommendation moves forward."
      />
      {blobId ? (
        <div className="mt-4 rounded-lg border border-[#326273]/10 bg-[#F6F0ED]/55 p-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white text-[#326273]">
              <Database className="h-5 w-5" />
            </span>
            <code className="min-w-0 flex-1 break-all text-[13px] font-semibold text-[#1F4452]">{blobId}</code>
            <button
              type="button"
              aria-label="Copy Walrus blob ID"
              onClick={() => { void navigator.clipboard.writeText(blobId); toast.success('Blob ID copied'); }}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[#326273] transition hover:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/20"
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {proof?.mode === 'demo' ? <StatusBadge status="demo" /> : <StatusBadge status="live" />}
            <ProofPill label="Bytes" value={proof ? proof.sizeBytes.toLocaleString() : 'Loading'} />
            <ProofPill label="Epochs" value={proof ? String(proof.epochs) : 'Loading'} />
          </div>
        </div>
      ) : (
        <EmptyState title="No document proof" body="Upload an invoice or select one with a stored Walrus blob." />
      )}
    </section>
  );
}

function SealPanel({
  selected,
  identities,
  access,
  checkingIdentity,
  onCheck,
}: {
  selected: InvoiceRecord | null;
  identities: string[];
  access: Record<string, boolean>;
  checkingIdentity: string | null;
  onCheck: (identity: string) => void;
}) {
  return (
    <section className="rounded-lg border border-[#326273]/15 bg-white/80 p-4 shadow-sm md:p-5">
      <SectionTitle
        icon={Lock}
        eyebrow="Access"
        title="Seal policy"
        body="Decryptability is checked by identity. Unknown parties should fail closed."
      />
      <div className="mt-4 flex flex-wrap gap-2">
        {identities.map((identity) => (
          <span key={identity} className="rounded-md border border-[#5C9EAD]/20 bg-[#5C9EAD]/10 px-2.5 py-1 text-[13px] font-bold text-[#326273]">
            {identity}
          </span>
        ))}
      </div>
      <div className="mt-4 grid gap-2">
        {['Splash Demo Ltd', 'unknown@org'].map((identity) => {
          const checking = checkingIdentity === identity;
          return (
            <button
              key={identity}
              type="button"
              disabled={!selected?.sealPolicyId || checkingIdentity !== null}
              onClick={() => onCheck(identity)}
              className="flex min-h-12 items-center justify-between gap-3 rounded-lg border border-[#326273]/10 bg-white p-3 text-left text-sm font-bold text-[#1F4452] transition hover:border-[#5C9EAD]/55 hover:bg-[#F8FCFD] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/20 disabled:cursor-not-allowed disabled:opacity-55"
            >
              <span className="truncate">Check access: {identity}</span>
              <AccessIcon checking={checking} granted={access[identity]} />
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ExtractionPanel({
  selected,
  extraction,
  suggestion,
  extracting,
  onExtract,
}: {
  selected: InvoiceRecord | null;
  extraction: Extraction | null;
  suggestion: CopilotSuggestion | null;
  extracting: boolean;
  onExtract: () => void;
}) {
  return (
    <section className="rounded-lg border border-[#326273]/15 bg-white/85 p-4 shadow-sm md:p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <SectionTitle
          icon={Sparkles}
          eyebrow="Recommendation"
          title="0xWal extraction"
          body="The result can draft a transfer route, but execution remains human gated."
        />
        <button
          type="button"
          disabled={!selected || extracting}
          onClick={onExtract}
          className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#E39774] px-4 py-2 text-sm font-bold text-white shadow-[0_12px_24px_rgba(227,151,116,0.24)] transition hover:bg-[#CD825F] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#E39774]/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {extracting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {extracting ? 'Inspecting...' : 'Extract and recommend route'}
        </button>
      </div>

      {extraction && suggestion ? (
        <div className="mt-5 grid gap-3 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-lg border border-[#326273]/10 bg-[#F6F0ED]/55 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#326273]/45">Extracted facts</div>
            <strong className="mt-2 block text-lg text-[#1F4452]">{extraction.recipient || selected?.payerOrgName}</strong>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <ProofPill label="Amount" value={`$${extraction.amount.toLocaleString()}`} />
              <ProofPill label="Currency" value={extraction.currency} />
            </div>
            <div className="mt-3 text-sm font-bold text-[#326273]">{Math.round(suggestion.confidence * 100)}% confidence</div>
          </div>
          <div className="rounded-lg border border-[#E39774]/28 bg-[#E39774]/10 p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-[#9F5839]">
                <Route className="h-4 w-4" />
              </span>
              <div>
                <strong className="text-[#1F4452]">{suggestion.title}</strong>
                <p className="mt-2 text-sm font-medium leading-6 text-[#326273]/68">{suggestion.description}</p>
                <span className="mt-3 inline-flex rounded-md border border-[#E39774]/25 bg-white/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9F5839]">
                  Approval required
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <EmptyState title="No extraction yet" body="Run extraction after selecting an invoice. The recommendation will appear here before any transfer flow opens." />
      )}
    </section>
  );
}

function ReleaseRail({ stages }: { stages: GateStage[] }) {
  return (
    <section className="rounded-lg border border-[#0C3E48]/18 bg-[#0C3E48] p-4 text-white shadow-[6px_7px_0_rgba(12,62,72,0.14)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45">Release gate</div>
          <h2 className="mt-2 text-xl font-bold">Evidence before execution</h2>
        </div>
        <BadgeCheck className="h-5 w-5 text-[#D9A441]" />
      </div>
      <div className="mt-5 grid gap-3">
        {stages.map((stage, index) => (
          <div key={stage.label} className="grid grid-cols-[auto_1fr] gap-3">
            <div className="flex flex-col items-center">
              <span className={`flex h-9 w-9 items-center justify-center rounded-lg border ${gateTone(stage.state)}`}>
                <stage.icon className="h-4 w-4" />
              </span>
              {index < stages.length - 1 ? <span className="mt-2 h-full min-h-6 w-px bg-white/16" /> : null}
            </div>
            <div className="min-w-0 pb-3">
              <div className="flex items-center justify-between gap-3">
                <strong className="text-sm text-white">{stage.label}</strong>
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/40">{stage.state}</span>
              </div>
              <p className="mt-1 truncate text-[13px] font-medium text-white/55">{stage.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function IntentPanel({ selected, suggestion, href }: { selected: InvoiceRecord | null; suggestion: CopilotSuggestion | null; href: string }) {
  return (
    <section className="rounded-lg border border-[#326273]/15 bg-white/80 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#D9A441]/18 text-[#8B6418]">
          <KeyRound className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="font-bold text-[#1F4452]">Next allowed action</h2>
          <p className="mt-1 text-[13px] font-medium leading-5 text-[#326273]/60">
            {suggestion ? 'Open the transfer flow with this invoice attached.' : 'Extract a route recommendation before opening execution.'}
          </p>
        </div>
      </div>
      <Link
        href={href}
        aria-disabled={!selected || !suggestion}
        className={`mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/22 ${selected && suggestion ? 'bg-[#0C3E48] text-white shadow-[0_12px_24px_rgba(12,62,72,0.2)] hover:bg-[#145D6A]' : 'pointer-events-none border border-[#326273]/12 bg-[#F6F0ED] text-[#326273]/45'}`}
      >
        Open payment intent
        <ArrowRight className="h-4 w-4" />
      </Link>
    </section>
  );
}

function AccessIcon({ checking, granted }: { checking: boolean; granted?: boolean }) {
  if (checking) return <Loader2 className="h-5 w-5 shrink-0 animate-spin text-[var(--info)]" />;
  if (granted === true) return <CheckCircle2 className="h-5 w-5 shrink-0 text-[var(--info)]" />;
  if (granted === false) return <XCircle className="h-5 w-5 shrink-0 text-[var(--error)]" />;
  return <ShieldCheck className="h-5 w-5 shrink-0 text-[#326273]/30" />;
}

function ProofPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-md border border-[#326273]/10 bg-white px-2.5 py-1 text-[13px] font-bold text-[#326273]">
      <span className="text-[#326273]/45">{label}</span>
      <span className="font-mono">{value}</span>
    </span>
  );
}

function EmptyState({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="mt-4 rounded-lg border border-[#326273]/10 bg-[#F6F0ED]/55 p-4">
      <strong className="text-sm text-[#1F4452]">{title}</strong>
      <p className="mt-1 text-[13px] font-medium leading-5 text-[#326273]/58">{body}</p>
    </div>
  );
}

function gateTone(state: GateState) {
  if (state === 'complete') return 'border-[#6FB4A0]/35 bg-[#6FB4A0]/18 text-[#D8FFF4]';
  if (state === 'active') return 'border-[#D9A441]/45 bg-[#D9A441]/18 text-[#FFE6A4]';
  if (state === 'warning') return 'border-[var(--warn)] bg-[var(--warn-bg)] text-[var(--warn)]';
  return 'border-white/12 bg-white/8 text-white/38';
}

function shortId(value: string) {
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function formatUsd(value: string) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return `$${value}`;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(parsed);
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
