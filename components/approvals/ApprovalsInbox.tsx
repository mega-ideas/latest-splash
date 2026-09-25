'use client';

import { useCallback, useEffect, useState } from 'react';
import { Fingerprint, Inbox, KeyRound, Loader2 } from 'lucide-react';

import { describeSignError, signApprovalWithPasskey } from '@/lib/wallet/sui-signers';

/**
 * WhatsApp approvals waiting on the signed-in person: a code was sent to
 * their phone for something someone asked for — a transfer, a settings or
 * profile change. They enter it here and confirm with their passkey.
 *
 * They act on the stored summary: what is approved is exactly what the
 * requester asked for, and the requester's save is refused if it differs.
 */

type Pending = {
  id: string;
  purpose: string;
  summary: string;
  requestedByName: string;
  stage: 'CODE' | 'PASSKEY';
  locked: boolean;
  expiresAt: string;
  message: string | null;
};

const PURPOSE_LABEL: Record<string, string> = {
  STABLECOIN_TRANSFER: 'USDC transfer',
  FIAT_TRANSFER: 'Payout',
  BATCH_PAYOUT: 'Batch payout',
  SETTINGS_CHANGE: 'Settings change',
  PROFILE_CHANGE: 'Profile change',
};

export default function ApprovalsInbox({ onChange }: { onChange?: () => void }) {
  const [items, setItems] = useState<Pending[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/step-up/pending', { cache: 'no-store' });
    const body = (await res.json().catch(() => ({}))) as { approvals?: Pending[]; error?: string };
    if (!res.ok) {
      setError(body.error ?? 'Approvals could not be loaded.');
      setItems([]);
      return;
    }
    setError('');
    setItems(body.approvals ?? []);
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [load]);

  return (
    <section className="dash-surface p-4" aria-labelledby="approvals-inbox-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="approvals-inbox-title" className="flex items-center gap-2 text-sm font-semibold text-[#326273]">
          <Inbox className="h-4 w-4 text-[var(--info)]" /> Waiting for your approval
        </h2>
        {items && items.length > 0 ? (
          <span className="rounded-full bg-[#E39774]/15 px-2 py-0.5 text-[12px] font-semibold text-[#9F5839]">{items.length}</span>
        ) : null}
      </div>
      {error ? <p role="alert" className="mt-2 text-[13px] text-[var(--error)]">{error}</p> : null}
      {items === null ? (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-[#326273]/90"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
      ) : items.length === 0 ? (
        <p className="mt-3 text-[13px] leading-5 text-[#326273]/90">Nothing waiting. WhatsApp codes sent to you appear here to approve.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {items.map((item) => (
            <InboxItem key={item.id} item={item} onDone={() => { void load(); onChange?.(); }} />
          ))}
        </ul>
      )}
    </section>
  );
}

function InboxItem({ item, onDone }: { item: Pending; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(item.message);
  const [busy, setBusy] = useState<'verify' | 'passkey' | null>(null);
  const [error, setError] = useState('');

  async function verify() {
    setBusy('verify');
    setError('');
    try {
      const res = await fetch('/api/step-up/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId: item.id, code }),
      });
      const body = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? 'That code did not work.');
      setMessage(body.message ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code did not work.');
    } finally {
      setBusy(null);
    }
  }

  async function passkey() {
    if (!message) return;
    setBusy('passkey');
    setError('');
    try {
      const walletRes = await fetch('/api/stablecoin/wallet', { cache: 'no-store' });
      const wallet = (await walletRes.json()) as { passkey?: { publicKey: string; rpId: string } | null; reason?: string };
      if (!wallet.passkey) throw new Error(wallet.reason ?? 'Create a passkey in Settings → Security first.');
      const signature = await signApprovalWithPasskey(wallet.passkey, message);
      const res = await fetch('/api/step-up/passkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId: item.id, signature }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'The passkey confirmation did not verify.');
      onDone();
    } catch (err) {
      setError(describeSignError(err));
    } finally {
      setBusy(null);
    }
  }

  const inputId = `inbox-code-${item.id}`;
  return (
    <li className="rounded-lg border border-[#326273]/12 bg-white p-3">
      <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[#326273]/90">
        {PURPOSE_LABEL[item.purpose] ?? item.purpose} · asked by {item.requestedByName}
      </div>
      <p className="mt-1 text-sm leading-6 text-[#1F4452]">{item.summary}</p>
      {item.locked ? (
        <p className="mt-2 text-[13px] text-[#326273]/90">Too many wrong attempts. {item.requestedByName} needs to request a new code.</p>
      ) : message ? (
        <button type="button" onClick={passkey} disabled={busy !== null} className="dash-btn mt-2 !px-4 !py-2 !text-[13px] disabled:cursor-not-allowed disabled:opacity-50">
          {busy === 'passkey' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
          Confirm with passkey
        </button>
      ) : (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor={inputId} className="text-[12px] font-medium text-[#326273]/90">Code from WhatsApp</label>
            <input
              id={inputId}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              className="mt-1 block w-36 rounded-lg border border-[#326273]/25 bg-[#F6F0ED] px-3 py-2 font-mono tracking-[0.3em] text-[#1F4452] focus:border-[#5C9EAD] focus-ring"
            />
          </div>
          <button type="button" onClick={verify} disabled={busy !== null || code.length !== 6} className="dash-btn !px-4 !py-2 !text-[13px] disabled:cursor-not-allowed disabled:opacity-50">
            {busy === 'verify' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Check code
          </button>
        </div>
      )}
      {error ? <p role="alert" className="mt-2 text-[13px] text-[var(--error)]">{error}</p> : null}
    </li>
  );
}
