'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, FileUp, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import LocalTime from '@/components/LocalTime';
import StatusBadge from '@/components/StatusBadge';

type UploadResponse = {
  kybCaseId: string;
  state: 'SUBMITTED';
  documents: { name: string; sha256: string; storageKey: string; virusScanResult: string }[];
};

type KybCaseStatus = {
  id: string;
  businessName: string;
  registrationNumber: string;
  state: 'SUBMITTED' | 'IN_REVIEW' | 'NEEDS_INFORMATION' | 'APPROVED' | 'REJECTED';
  riskTier: string;
  corridorAccess: string;
  submittedAt: string;
  updatedAt: string;
  sumsubApplicantId: string | null;
  reviewNotes: string | null;
  decisionReason: string | null;
  documents: { name: string; kind: string; type: string; size: number; sha256: string; virusScanResult: string; uploadedAt: string }[];
};

type SumsubResponse = {
  configured: boolean;
  provider?: 'SUMSUB';
  applicantId?: string | null;
  externalUserId?: string;
  levelName?: string;
  accessToken?: string;
  expiresAt?: string;
  error?: string;
};

type SumsubBuilder = {
  withConf: (config: Record<string, unknown>) => SumsubBuilder;
  withOptions: (options: Record<string, unknown>) => SumsubBuilder;
  on: (event: string, callback: (payload: unknown) => void) => SumsubBuilder;
  build: () => { launch: (selector: string) => void };
};

declare global {
  interface Window {
    snsWebSdk?: {
      init: (accessToken: string, refreshToken: () => Promise<string>) => SumsubBuilder;
    };
  }
}

const sumsubScriptId = 'sumsub-websdk-builder';

export default function KybSettings() {
  const [businessName, setBusinessName] = useState('Acme Trading Sdn Bhd');
  const [ssmNumber, setSsmNumber] = useState('202401012345');
  const [form9, setForm9] = useState<File | null>(null);
  const [directorId, setDirectorId] = useState<File | null>(null);
  const [kybCaseId, setKybCaseId] = useState<string | null>(null);
  const [sumsubApplicantId, setSumsubApplicantId] = useState<string | null>(null);
  const [sumsubLevel, setSumsubLevel] = useState<string | null>(null);
  const [sumsubStatus, setSumsubStatus] = useState<'idle' | 'starting' | 'ready' | 'completed' | 'unconfigured' | 'failed'>('idle');
  const [sumsubError, setSumsubError] = useState<string | null>(null);
  const [status, setStatus] = useState<'unverified' | 'pending' | 'verified' | 'failed'>('unverified');
  const [caseStatus, setCaseStatus] = useState<KybCaseStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function loadSumsubScript() {
    if (window.snsWebSdk) return;

    await new Promise<void>((resolve, reject) => {
      const existing = document.getElementById(sumsubScriptId) as HTMLScriptElement | null;

      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('Sumsub WebSDK failed to load')), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.id = sumsubScriptId;
      script.src = 'https://static.sumsub.com/idensic/static/sns-websdk-builder.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Sumsub WebSDK failed to load'));
      document.body.appendChild(script);
    });
  }

  async function requestSumsubSession(caseId: string) {
    const response = await fetch('/api/kyb/sumsub', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kybCaseId: caseId, businessName, registrationNumber: ssmNumber }),
    });

    const body = (await response.json()) as SumsubResponse;

    if (!response.ok) {
      throw new Error(body.error ?? 'Sumsub KYB session failed');
    }

    return body;
  }

  const applyCaseStatus = useCallback((record: KybCaseStatus) => {
    setCaseStatus(record);
    setKybCaseId(record.id);
    setSumsubApplicantId(record.sumsubApplicantId);

    if (record.state === 'APPROVED') {
      setStatus('verified');
      return;
    }

    if (record.state === 'REJECTED') {
      setStatus('failed');
      return;
    }

    setStatus('pending');
  }, []);

  const syncLatestCaseStatus = useCallback(async (showToast = false) => {
    const params = new URLSearchParams({ businessName, registrationNumber: ssmNumber });
    const response = await fetch(`/api/kyb/cases/latest?${params.toString()}`, { cache: 'no-store' });
    const body = await response.json() as { case?: KybCaseStatus | null; error?: string };

    if (!response.ok) {
      throw new Error(body.error ?? 'Latest KYB status refresh failed');
    }

    if (body.case) {
      applyCaseStatus(body.case);
      if (showToast) toast.success(`KYB status: ${String(body.case.state ?? 'unknown').replace('_', ' ').toLowerCase()}`);
    } else if (showToast) {
      toast.error('No KYB case found for this business yet');
    }
  }, [applyCaseStatus, businessName, ssmNumber]);

  useEffect(() => {
    const timeout = setTimeout(() => void syncLatestCaseStatus(), 0);
    const interval = window.setInterval(() => {
      void syncLatestCaseStatus();
    }, 6000);

    return () => {
      clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [syncLatestCaseStatus]);

  async function refreshCaseStatus() {
    if (!kybCaseId) {
      await syncLatestCaseStatus(true);
      return;
    }

    try {
      const response = await fetch(`/api/kyb/cases/${kybCaseId}`, { cache: 'no-store' });
      const body = await response.json() as { case?: KybCaseStatus; error?: string };

      if (!response.ok || !body.case) {
        throw new Error(body.error ?? 'KYB case refresh failed');
      }

      applyCaseStatus(body.case);
      toast.success(`KYB status: ${String(body.case.state ?? 'unknown').replace('_', ' ').toLowerCase()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'KYB case refresh failed';
      toast.error(message);
    }
  }

  async function refreshUploadedCase(caseId: string) {
    const response = await fetch(`/api/kyb/cases/${caseId}`, { cache: 'no-store' });
    const body = await response.json() as { case?: KybCaseStatus };

    if (response.ok && body.case) {
      applyCaseStatus(body.case);
    }
  }

  async function startSumsub(caseId: string) {
    setSumsubStatus('starting');
    setSumsubError(null);

    try {
      const session = await requestSumsubSession(caseId);

      if (!session.configured) {
        setSumsubStatus('unconfigured');
        setSumsubError(session.error ?? 'Sumsub environment variables are not configured');
        return;
      }

      if (!session.accessToken) {
        throw new Error('Sumsub access token was not returned');
      }

      setSumsubApplicantId(session.applicantId ?? session.externalUserId ?? null);
      setSumsubLevel(session.levelName ?? null);
      await loadSumsubScript();

      if (!window.snsWebSdk) {
        throw new Error('Sumsub WebSDK is unavailable');
      }

      window.snsWebSdk
        .init(session.accessToken, async () => {
          const refreshed = await requestSumsubSession(caseId);

          if (!refreshed.accessToken) {
            throw new Error('Sumsub token refresh failed');
          }

          return refreshed.accessToken;
        })
        .withConf({ lang: 'en' })
        .withOptions({ addViewportTag: false, adaptIframeHeight: true })
        .on('idCheck.onApplicantStatusChanged', () => {
          setSumsubStatus('completed');
          toast.success('Sumsub KYB status updated');
        })
        .on('idCheck.onError', (payload) => {
          setSumsubStatus('failed');
          setSumsubError(JSON.stringify(payload));
        })
        .build()
        .launch('#sumsub-websdk-container');

      setSumsubStatus('ready');
      toast.success('Sumsub KYB verification ready');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sumsub verification failed';
      setSumsubStatus('failed');
      setSumsubError(message);
      toast.error(message);
    }
  }

  async function submitKyb(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!form9 || !directorId) {
      toast.error('Upload Form 9 and Director ID');
      return;
    }

    setSubmitting(true);
    setStatus('pending');

    try {
      const formData = new FormData();
      formData.append('businessName', businessName);
      formData.append('ssmNumber', ssmNumber);
      formData.append('documents', form9);
      formData.append('documents', directorId);

      const upload = await fetch('/api/kyb/upload', { method: 'POST', body: formData });

      if (!upload.ok) {
        throw new Error('KYB upload failed');
      }

      const uploaded = (await upload.json()) as UploadResponse;
      setKybCaseId(uploaded.kybCaseId);
      setStatus('pending');
      toast.success(`KYB case ${uploaded.kybCaseId} submitted to staff review`);
      await refreshUploadedCase(uploaded.kybCaseId);
      await startSumsub(uploaded.kybCaseId);
      setSubmitting(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'KYB submission failed';
      setStatus('failed');
      setSubmitting(false);
      toast.error(message);
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
      <section className="space-y-6">
        <div>
          <div className="mb-3 inline-flex rounded-full bg-[#5C9EAD]/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-[#5C9EAD]">KYB Identity Layer</div>
          <h1 className="text-4xl font-extrabold text-[#326273]">Verify your Malaysian business.</h1>
          <p className="mt-3 max-w-xl text-[#326273]/70">Upload company documents, submit them for compliance review, and unlock protected settlement flows after approval.</p>
        </div>

        <div className="rounded-2xl border border-[#326273]/10 bg-white p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm text-[#326273]/60">Verification status</div>
              <div className="mt-1 font-bold text-[#326273]">{status === 'verified' ? 'Ready for payout execution' : 'Waiting for compliance review'}</div>
            </div>
            <StatusBadge status={status} />
          </div>
          <div className="mt-5 h-2 overflow-hidden rounded-full bg-[#326273]/10">
            <div className="h-full rounded-full bg-[#5C9EAD] transition-all" style={{ width: status === 'verified' ? '100%' : status === 'pending' ? '68%' : status === 'failed' ? '28%' : '18%' }} />
          </div>
          {kybCaseId && (
            <div className="mt-4 rounded-xl bg-[#F6F0ED] p-3 text-xs text-[#326273]/70">
              <div className="break-all font-mono">KYB case: {kybCaseId}</div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void refreshCaseStatus()} className="rounded-lg border border-[#5C9EAD]/40 px-3 py-1.5 font-bold text-[#326273] hover:border-[#5C9EAD]">
                  Refresh admin decision
                </button>
                {caseStatus && <span className="font-bold uppercase tracking-wide text-[#5C9EAD]">{caseStatus.state.replace('_', ' ')}</span>}
              </div>
            </div>
          )}
          {caseStatus && (
            <div className="mt-4 rounded-xl border border-[#326273]/10 bg-[#F6F0ED] p-4 text-sm text-[#326273]/75">
              <div className="font-bold text-[#326273]">Staff review status</div>
              <div className="mt-2 grid gap-2 text-xs md:grid-cols-2">
                <div>Risk tier: {caseStatus.riskTier.replace('_', ' ')}</div>
                <div>Corridor access: {caseStatus.corridorAccess}</div>
                <div>Documents: {caseStatus.documents.length}</div>
                <div>Updated: <LocalTime value={caseStatus.updatedAt} /></div>
              </div>
              {(caseStatus.reviewNotes || caseStatus.decisionReason) && (
                <div className="mt-3 rounded-lg bg-white p-3 text-xs leading-5">
                  {caseStatus.reviewNotes ?? caseStatus.decisionReason}
                </div>
              )}
            </div>
          )}
          <div className="mt-4 rounded-xl bg-[#F6F0ED] p-4 text-sm text-[#326273]/75">
            <div className="flex items-center gap-2 font-bold text-[#326273]">
              {sumsubStatus === 'starting' ? <Loader2 className="h-4 w-4 animate-spin text-[#5C9EAD]" /> : <CheckCircle2 className="h-4 w-4 text-[#5C9EAD]" />}
              Sumsub verification
            </div>
            <div className="mt-2 text-xs">
              {sumsubStatus === 'idle' && 'Submit the KYB case to start Sumsub business verification.'}
              {sumsubStatus === 'starting' && 'Creating Sumsub applicant and access token…'}
              {sumsubStatus === 'ready' && 'Sumsub WebSDK is ready below.'}
              {sumsubStatus === 'completed' && 'Sumsub returned a status update for this applicant.'}
              {sumsubStatus === 'unconfigured' && 'Sumsub is not configured in this environment.'}
              {sumsubStatus === 'failed' && (sumsubError ?? 'Sumsub verification failed.')}
            </div>
            {sumsubLevel && <div className="mt-2 font-mono text-[11px] text-[#326273]/50">Level: {sumsubLevel}</div>}
            {sumsubApplicantId && <div className="mt-1 break-all font-mono text-[11px] text-[#326273]/50">Applicant: {sumsubApplicantId}</div>}
            {kybCaseId && sumsubStatus !== 'starting' && (
              <button type="button" onClick={() => void startSumsub(kybCaseId)} className="mt-3 rounded-lg border border-[#5C9EAD]/40 px-4 py-2 text-xs font-bold text-[#326273] hover:border-[#5C9EAD]">
                Restart Sumsub verification
              </button>
            )}
          </div>
        </div>
      </section>

      <form onSubmit={submitKyb} className="space-y-5 rounded-2xl border border-[#326273]/10 bg-white p-6 shadow-sm">
        <div>
          <h2 className="text-2xl font-bold text-[#326273]">Business application</h2>
          <p className="mt-1 text-sm text-[#326273]/60">Submits a KYB case, stores document metadata, and starts Sumsub business verification.</p>
        </div>
        <Field label="Registered business name">
          <input value={businessName} onChange={(event) => setBusinessName(event.target.value)} className="w-full rounded-lg border border-[#326273]/20 bg-[#F6F0ED] px-4 py-3 text-[#326273] focus:border-[#5C9EAD] focus:outline-none" required />
        </Field>
        <Field label="SSM registration number">
          <input value={ssmNumber} onChange={(event) => setSsmNumber(event.target.value)} className="w-full rounded-lg border border-[#326273]/20 bg-[#F6F0ED] px-4 py-3 text-[#326273] focus:border-[#5C9EAD] focus:outline-none" required />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <UploadTile title="Form 9" description="Company incorporation certificate" file={form9} onChange={setForm9} />
          <UploadTile title="Director ID" description="NRIC or passport scan" file={directorId} onChange={setDirectorId} />
        </div>
        <div className="rounded-xl border border-[#5C9EAD]/20 bg-[#5C9EAD]/10 p-4 text-sm text-[#326273]/75">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 text-[#5C9EAD]" />
            <span>Each document is fingerprinted with SHA-256 for tamper evidence on submission. Sumsub handles business verification and reviewer workflow.</span>
          </div>
        </div>
        <div id="sumsub-websdk-container" className="min-h-0 overflow-hidden rounded-2xl border border-[#326273]/10 bg-[#F6F0ED]" />
        <button disabled={submitting} className="w-full rounded-lg bg-[#E39774] py-3 font-bold text-white hover:bg-[#cd825f] disabled:opacity-50">
          {submitting ? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Submitting…</span> : 'Submit KYB application'}
        </button>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-semibold text-[#326273]/70">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function UploadTile({ title, description, file, onChange }: { title: string; description: string; file: File | null; onChange: (file: File | null) => void }) {
  return (
    <label className="grid min-h-40 cursor-pointer place-items-center rounded-2xl border border-dashed border-[#326273]/25 bg-[#F6F0ED]/80 p-5 text-center hover:border-[#5C9EAD]">
      <div className="space-y-3">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-[#5C9EAD] shadow-sm">
          <FileUp className="h-5 w-5" />
        </div>
        <div>
          <p className="font-medium text-[#326273]">{title}</p>
          <p className="text-sm text-[#326273]/60">{file ? file.name : description}</p>
        </div>
      </div>
      <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg" onChange={(event) => onChange(event.target.files?.[0] ?? null)} />
    </label>
  );
}
