'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Fingerprint, Hourglass, KeyRound, Loader2, MessageCircle, MousePointerClick, RefreshCw } from 'lucide-react';

import { describeSignError, signApprovalWithPasskey } from '@/lib/wallet/sui-signers';

/**
 * Approval, in the workspace's chosen style (Settings → WhatsApp approvals).
 *
 *   WhatsApp + passkey  Send code → the approver types it → the approver
 *                       confirms with their passkey. If the approver is
 *                       someone else, this waits and polls; they approve from
 *                       their own Approvals inbox.
 *   Click               Approve → done, unless a second person is required
 *                       (maker-checker), in which case this waits for them.
 *
 * The server decides everything — who approves, whether it is allowed, what
 * the approval covers. This component only shows where it stands.
 */

export type ApprovalPurpose = 'STABLECOIN_TRANSFER' | 'FIAT_TRANSFER' | 'BATCH_PAYOUT' | 'SETTINGS_CHANGE' | 'PROFILE_CHANGE';

type Status = {
  ok: boolean;
  error?: string;
  style?: 'WHATSAPP_PASSKEY' | 'CLICK';
  state?: 'NONE' | 'SENT' | 'AWAITING_PASSKEY' | 'APPROVED' | 'EXPIRED' | 'LOCKED' | 'CHANGED';
  summary?: string;
  approverName?: string | null;
  sentTo?: string | null;
  approvalId?: string;
  approverIsYou?: boolean;
  youAreRequester?: boolean;
  secondPersonRequired?: boolean;
  youCanApprove?: boolean;
  message?: string;
};

async function post<T>(url: string, body: unknown): Promise<T & { ok: boolean; error?: string; code?: string }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({ ok: false, error: `Request failed (${res.status})` }));
  return { ...json, ok: res.ok && json.ok !== false };
}

export default function ApprovalFlow({
  purpose,
  subjectId,
  payload,
  onApproved,
}: {
  purpose: ApprovalPurpose;
  subjectId?: string;
  payload?: Record<string, unknown>;
  onApproved: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [code, setCode] = useState('');
  const [passkeyMessage, setPasskeyMessage] = useState<string | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const approvedOnce = useRef(false);
  // A ref, not a dependency: callers pass inline functions, and a parent that
  // re-renders every second (a countdown) must not re-fetch every second.
  const onApprovedRef = useRef(onApproved);
  useEffect(() => { onApprovedRef.current = onApproved; }, [onApproved]);
  const subject = { purpose, subjectId, payload };
  const subjectKey = JSON.stringify(subject);

  const refresh = useCallback(async () => {
    const next = await post<Status>('/api/step-up/status', JSON.parse(subjectKey));
    setStatus(next);
    if (next.ok && next.state === 'APPROVED' && !approvedOnce.current) {
      approvedOnce.current = true;
      onApprovedRef.current();
    }
    if (next.ok && next.approverIsYou && next.approvalId) {
      setApprovalId(next.approvalId);
      if (next.state === 'AWAITING_PASSKEY' && next.message) setPasskeyMessage(next.message);
    }
    return next;
  }, [subjectKey]);

  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(first);
  }, [refresh]);

  // Waiting on someone else: look again every few seconds.
  const waitingOnOthers = status?.ok && status.state !== 'APPROVED'
    && ((status.style === 'WHATSAPP_PASSKEY' && (status.state === 'SENT' || status.state === 'AWAITING_PASSKEY') && !status.approverIsYou)
      || (status.style === 'CLICK' && !status.youCanApprove));
  useEffect(() => {
    if (!waitingOnOthers) return;
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [waitingOnOthers, refresh]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(describeSignError(err));
    } finally {
      setBusy(null);
    }
  }

  const sendCode = () => run('send', async () => {
    const r = await post<{ id?: string; selfApproval?: boolean; approverName?: string; sentTo?: string; delivered?: boolean; deliveryError?: string | null; alreadyApproved?: boolean }>(
      '/api/step-up/request', subject,
    );
    if (!r.ok) throw new Error(r.error ?? 'The code could not be sent.');
    if (r.alreadyApproved) return void (await refresh());
    setNotice(r.delivered
      ? `Code sent on WhatsApp to ${r.approverName} (${r.sentTo}).`
      : `WhatsApp could not deliver the code (${r.deliveryError}). Locally, the code is in the server log.`);
    if (r.selfApproval && r.id) setApprovalId(r.id);
    setCode('');
    setPasskeyMessage(null);
    await refresh();
  });

  const verifyCode = () => run('verify', async () => {
    if (!approvalId) throw new Error('Request a code first.');
    const r = await post<{ next?: string; message?: string }>('/api/step-up/verify', { approvalId, code });
    if (!r.ok) throw new Error(r.error ?? 'That code did not work.');
    if (r.next === 'PASSKEY' && r.message) setPasskeyMessage(r.message);
    await refresh();
  });

  const confirmPasskey = () => run('passkey', async () => {
    if (!approvalId || !passkeyMessage) throw new Error('Enter the WhatsApp code first.');
    const res = await fetch('/api/stablecoin/wallet', { cache: 'no-store' });
    const wallet = (await res.json()) as { passkey?: { publicKey: string; rpId: string } | null; reason?: string };
    if (!wallet.passkey) throw new Error(wallet.reason ?? 'Create a passkey in Settings → Security first.');
    const signature = await signApprovalWithPasskey(wallet.passkey, passkeyMessage);
    const r = await post('/api/step-up/passkey', { approvalId, signature });
    if (!r.ok) throw new Error(r.error ?? 'The passkey confirmation did not verify.');
    await refresh();
  });

  const approveClick = () => run('approve', async () => {
    const r = await post('/api/step-up/approve', subject);
    if (!r.ok) {
      if (r.code === 'maker_checker') {
        setNotice('A second person has to approve this. An admin or checker other than you can approve it from their Approvals inbox — this page will update when they do.');
        await refresh();
        return;
      }
      throw new Error(r.error ?? 'Approval failed.');
    }
    await refresh();
  });

  if (!status) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-[#326273]/70" role="status">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking approval…
      </div>
    );
  }
  if (!status.ok) {
    return <p role="alert" className="text-[13px] font-medium text-[var(--error)]">{status.error}</p>;
  }

  const approved = status.state === 'APPROVED';
  const whatsapp = status.style === 'WHATSAPP_PASSKEY';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-[#326273]/60">
        {whatsapp ? <MessageCircle className="h-3.5 w-3.5" /> : <MousePointerClick className="h-3.5 w-3.5" />}
        {whatsapp ? 'WhatsApp code + passkey' : 'Click to approve'}
        {!whatsapp && status.secondPersonRequired ? <span className="rounded-full bg-[#E39774]/15 px-2 py-0.5 text-[#9F5839]">second person required</span> : null}
      </div>
      {status.summary ? <p className="text-sm leading-6 text-[#1F4452]">{status.summary}</p> : null}

      {approved ? (
        <div role="status" className="flex items-center gap-2 rounded-lg border border-[#6FB4A0]/40 bg-[#6FB4A0]/12 px-3 py-2 text-sm font-semibold text-[var(--ok)]">
          <CheckCircle2 className="h-4 w-4" /> Approved{status.approverName ? ` by ${status.approverName}` : ''}.
        </div>
      ) : whatsapp ? (
        <WhatsAppSteps
          status={status}
          busy={busy}
          code={code}
          setCode={setCode}
          canEnterCode={Boolean(approvalId) && (status.approverIsYou ?? false) && !passkeyMessage}
          canPasskey={Boolean(passkeyMessage) && (status.approverIsYou ?? false)}
          onSend={sendCode}
          onVerify={verifyCode}
          onPasskey={confirmPasskey}
        />
      ) : !status.youCanApprove ? (
        <p className="flex items-start gap-2 text-[13px] leading-5 text-[#326273]/75">
          <Hourglass className="mt-0.5 h-4 w-4 shrink-0" />
          {status.secondPersonRequired && status.youAreRequester
            ? 'Waiting for a second approver. An admin or checker other than you approves it on their Send USDC page; this updates when they do.'
            : 'Waiting for an admin or checker to approve it on their Send USDC page; this updates when they do.'}
        </p>
      ) : (
        <button type="button" onClick={approveClick} disabled={busy !== null} className="dash-btn !px-4 !py-2 !text-[13px] disabled:cursor-not-allowed disabled:opacity-50">
          {busy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          Approve
        </button>
      )}

      {notice && !approved ? <p className="text-[13px] leading-5 text-[#326273]/75" aria-live="polite">{notice}</p> : null}
      {error ? <p role="alert" className="text-[13px] font-medium text-[var(--error)]">{error}</p> : null}
    </div>
  );
}

function WhatsAppSteps({
  status,
  busy,
  code,
  setCode,
  canEnterCode,
  canPasskey,
  onSend,
  onVerify,
  onPasskey,
}: {
  status: Status;
  busy: string | null;
  code: string;
  setCode: (value: string) => void;
  canEnterCode: boolean;
  canPasskey: boolean;
  onSend: () => void;
  onVerify: () => void;
  onPasskey: () => void;
}) {
  const sent = status.state === 'SENT' || status.state === 'AWAITING_PASSKEY';
  const waitingOnOther = sent && !status.approverIsYou;
  return (
    <div className="space-y-3">
      {!sent || status.state === 'EXPIRED' || status.state === 'LOCKED' || status.state === 'CHANGED' ? (
        <div className="space-y-2">
          {status.state === 'EXPIRED' ? <p className="text-[13px] text-[#326273]/75">The last code expired.</p> : null}
          {status.state === 'LOCKED' ? <p className="text-[13px] text-[#326273]/75">Too many wrong attempts on the last code.</p> : null}
          {status.state === 'CHANGED' ? <p className="text-[13px] text-[#326273]/75">The details changed after the last code was sent.</p> : null}
          <button type="button" onClick={onSend} disabled={busy !== null} className="dash-btn !px-4 !py-2 !text-[13px] disabled:cursor-not-allowed disabled:opacity-50">
            {busy === 'send' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
            Send WhatsApp code
          </button>
        </div>
      ) : null}

      {waitingOnOther ? (
        <p className="flex items-start gap-2 text-[13px] leading-5 text-[#326273]/75">
          <Hourglass className="mt-0.5 h-4 w-4 shrink-0" />
          Code sent to {status.approverName} ({status.sentTo}). They enter it and confirm with their passkey from their own Approvals inbox; this page updates when they do.
        </p>
      ) : null}

      {canEnterCode ? (
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="approval-code" className="text-[13px] font-medium text-[#326273]/75">6-digit code from WhatsApp</label>
            <input
              id="approval-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              className="mt-1 block w-40 rounded-lg border border-[#326273]/25 bg-[#F6F0ED] px-3 py-2 font-mono text-lg tracking-[0.3em] text-[#1F4452] focus:border-[#5C9EAD] focus-ring"
            />
          </div>
          <button type="button" onClick={onVerify} disabled={busy !== null || code.length !== 6} className="dash-btn !px-4 !py-2 !text-[13px] disabled:cursor-not-allowed disabled:opacity-50">
            {busy === 'verify' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Check code
          </button>
          <button type="button" onClick={onSend} disabled={busy !== null} className="dash-btn-ghost inline-flex items-center gap-1 !px-3 !py-2 !text-[13px]">
            <RefreshCw className="h-3.5 w-3.5" /> New code
          </button>
        </div>
      ) : null}

      {canPasskey ? (
        <button type="button" onClick={onPasskey} disabled={busy !== null} className="dash-btn !px-4 !py-2 !text-[13px] disabled:cursor-not-allowed disabled:opacity-50">
          {busy === 'passkey' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
          Confirm with passkey
        </button>
      ) : null}
    </div>
  );
}
