'use client';

import { useState } from 'react';
import { Fingerprint, UserRound } from 'lucide-react';

import { call, errorText, type SigningView } from '@/components/transfer/api';
import SignPanel from '@/components/transfer/SignPanel';
import { PrimaryButton, QuietButton } from '@/components/transfer/ui';
import { Card, Note, Pill } from './parts';
import { WALLET_LABELS } from './SetupWallet';
import type { Overview } from './types';

/**
 * Signers and threshold (v2 brief 4.1, 5.5): who signs for the business
 * wallet and how many must. The signers are the owners' passkeys, recorded
 * when the wallet was registered; changing them is a request the current
 * signers approve, then the new signers confirm.
 */
export default function SignersCard({ overview, onChanged }: { overview: Overview; onChanged: () => void }) {
  const s = overview.signers;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<SigningView | null>(null);

  async function change() {
    setBusy(true);
    setError(null);
    const answer = await call<{ request?: SigningView }>('/api/wallet/business/rotation', { body: {} });
    setBusy(false);
    if (!answer.ok || !answer.body?.request) {
      setError(errorText(answer, 'The change of signers was not started. Nothing was changed.'));
      return;
    }
    setConfirming(false);
    setRequest(answer.body.request);
  }

  return (
    <Card id="signers" title="Signers and threshold">
      {!s ? (
        <Note>Your signers are not on record yet.</Note>
      ) : (
        <div className="space-y-3">
          <p className="text-sm leading-6 text-[#1F4452]">
            <span className="font-mono text-lg font-bold text-[#0c3e48]">{s.threshold} of {s.totalWeight}</span>{' '}
            {s.singleSigner ? 'One person can sign alone, because the business chose that.' : 'signatures are needed to move money from this wallet.'}
          </p>
          <ul className="space-y-1.5" aria-label="Signers">
            {s.members.map((m, i) => (
              <li key={`${m.name}-${i}`} className="flex min-h-11 items-center gap-3 rounded-xl bg-[#F6F0ED] px-3 text-sm text-[#1F4452]">
                <UserRound className="h-4 w-4 shrink-0 text-[#145d6a]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-semibold">{m.name}{m.you ? ' (you)' : ''}</span>
                <Pill tone="ok"><Fingerprint className="mr-1 h-3 w-3" aria-hidden="true" />Passkey</Pill>
              </li>
            ))}
          </ul>
        </div>
      )}
      {request ? (
        <div className="mt-3">
          <SignPanel initial={request} labels={WALLET_LABELS} onExecuted={onChanged} onRestart={() => setRequest(null)} />
        </div>
      ) : overview.canManage ? (
        <div className="mt-3 space-y-2">
          {confirming ? (
            <div className="space-y-2 rounded-xl border border-[#326273]/15 bg-[#f4f8fa] p-3">
              <Note>This makes today&rsquo;s owners, each with their passkey, the signers. The current signers approve it, then the new signers confirm. Until then nothing changes.</Note>
              {error ? <Note tone="error">{error}</Note> : null}
              <div className="flex flex-wrap gap-2">
                <PrimaryButton type="button" disabled={busy} onClick={() => void change()}>{busy ? 'Starting…' : 'Ask the signers to approve'}</PrimaryButton>
                <QuietButton type="button" onClick={() => setConfirming(false)}>Cancel</QuietButton>
              </div>
            </div>
          ) : (
            <QuietButton type="button" onClick={() => setConfirming(true)}>Change who signs</QuietButton>
          )}
        </div>
      ) : null}
    </Card>
  );
}
