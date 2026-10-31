'use client';

import { useState } from 'react';
import { Check, Fingerprint, KeyRound, UserRound } from 'lucide-react';

import { call, errorText, type SigningView } from '@/components/transfer/api';
import SignPanel, { type SignLabels } from '@/components/transfer/SignPanel';
import { PrimaryButton } from '@/components/transfer/ui';
import { Card, Loading, Note, Pill, useLoad } from './parts';

type Business = {
  wallet: string | null;
  pendingWallet: string | null;
  owners: Array<{ userId: string; name: string; founder: boolean; onChainOwner: boolean }>;
  ownersWithoutPasskey: Array<{ userId: string; name: string }>;
  you: { userId: string; role: string };
};

export const WALLET_LABELS: SignLabels = {
  working: 'Sending your change',
  done: 'Signed and sent',
  doneNote: 'The change is on your business account. The next step, if there is one, appears under Needs your signature.',
  deadNote: 'Nothing was changed. You can start again.',
  restart: 'Start again',
};

/**
 * Create the business wallet (v2 brief 4.1). Owners add passkeys; Splash
 * builds the multisig of every owner's passkey, 2-of-N unless the business
 * chose a single signer, and asks the founder (the business account's own
 * owner) to sign the first transaction. The registration then goes to the
 * owners' inbox. Splash holds no key to the wallet.
 */
export default function SetupWallet({ onChanged }: { onChanged: () => void }) {
  const business = useLoad<Business>('/api/wallet/business', 'Your owners could not be loaded.');
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const [single, setSingle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<SigningView | null>(null);

  if (business.loading) return <Card title="Create your business wallet"><Loading label="Reading your owners…" /></Card>;
  if (!business.data) return <Card title="Create your business wallet"><Note tone="error">{business.error}</Note></Card>;
  const b = business.data;
  const founder = b.owners.find((o) => o.founder) ?? null;
  const iAmFounder = founder?.userId === b.you.userId;
  const soleOwner = b.owners.length === 1;
  const missing = b.ownersWithoutPasskey;
  const allLeftOut = missing.length === 0 || missing.every((m) => leftOut.includes(m.userId));

  async function create() {
    setBusy(true);
    setError(null);
    const answer = await call<{ request?: SigningView }>('/api/wallet/business', {
      body: { singleSignerChosen: soleOwner && single, confirmExcluded: leftOut },
    });
    setBusy(false);
    if (!answer.ok || !answer.body?.request) {
      setError(errorText(answer, 'The wallet could not be started. Nothing was changed.'));
      return;
    }
    setRequest(answer.body.request);
  }

  if (request) {
    return (
      <Card title="Create your business wallet">
        <SignPanel initial={request} labels={WALLET_LABELS} onExecuted={onChanged} onRestart={() => setRequest(null)} />
      </Card>
    );
  }

  return (
    <Card id="create-wallet" title="Create your business wallet">
      <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
        <div className="space-y-4">
          <p className="text-sm leading-6 text-[#1F4452]">
            Your business wallet holds your USDC. It is a shared wallet: your owners sign with their own passkeys, so no one person can move the money alone and Splash holds no key to it.
          </p>
          <ul className="space-y-2" aria-label="Owners">
            {b.owners.map((o) => (
              <li key={o.userId} className="flex min-h-11 items-center gap-3 rounded-xl bg-[#F6F0ED] px-3 text-sm text-[#1F4452]">
                <UserRound className="h-4 w-4 shrink-0 text-[#145d6a]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-semibold">{o.name}{o.userId === b.you.userId ? ' (you)' : ''}</span>
                {o.founder ? <Pill tone="ok">Starts the wallet</Pill> : null}
                <Pill tone="ok"><Check className="mr-1 h-3 w-3" aria-hidden="true" />Passkey set</Pill>
              </li>
            ))}
            {missing.map((o) => (
              <li key={o.userId} className="flex min-h-11 items-center gap-3 rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] px-3 text-sm text-[#1F4452]">
                <KeyRound className="h-4 w-4 shrink-0 text-[var(--warn-ink)]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-semibold">{o.name}</span>
                <Pill tone="wait">Needs a passkey</Pill>
              </li>
            ))}
          </ul>
          {missing.length > 0 ? (
            <fieldset className="space-y-2 rounded-xl border border-[#326273]/20 bg-white p-3">
              <legend className="px-1 text-[13px] font-semibold text-[#1F4452]">Owners without a passkey</legend>
              <p className="text-[13px] leading-5 text-[#326273]">Ask them to add a passkey in Settings, or leave them out. Someone left out is not a signer of the wallet.</p>
              {missing.map((o) => (
                <label key={o.userId} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-[#1F4452]">
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-[#0d6370]"
                    checked={leftOut.includes(o.userId)}
                    onChange={(e) => setLeftOut((cur) => (e.target.checked ? [...cur, o.userId] : cur.filter((id) => id !== o.userId)))}
                  />
                  Leave {o.name} out of the wallet
                </label>
              ))}
            </fieldset>
          ) : null}
          {soleOwner ? (
            <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-[#326273]/20 bg-white p-3 text-sm leading-5 text-[#1F4452]">
              <input type="checkbox" className="mt-0.5 h-5 w-5 accent-[#0d6370]" checked={single} onChange={(e) => setSingle(e.target.checked)} />
              <span>
                <span className="font-semibold">One person signs alone.</span> You are the only owner, so every payment needs your passkey alone. Add a second owner later to require two signatures.
              </span>
            </label>
          ) : (
            <Note>{`Every payment needs ${b.owners.length} owners' passkeys: at least two of them. You can change who signs later.`}</Note>
          )}
        </div>
        <aside className="space-y-3 rounded-xl bg-[#f4f8fa] p-4 text-sm text-[#1F4452]">
          <h3 className="text-sm font-extrabold text-[#0c3e48]">What happens next</h3>
          <ol className="list-decimal space-y-2 pl-4 leading-5">
            <li>{iAmFounder ? 'You sign the first step with your passkey.' : `${founder?.name ?? 'The person who opened the business account'} signs the first step.`}</li>
            <li>Each owner gets a request to sign the second step on their own device, and checks the transaction code first.</li>
            <li>When enough owners have signed, the wallet exists and you can add funds.</li>
          </ol>
          {error ? <Note tone="error">{error}</Note> : null}
          {iAmFounder ? (
            <PrimaryButton type="button" disabled={busy || !allLeftOut || (soleOwner && !single)} onClick={() => void create()}>
              <Fingerprint className="h-4 w-4" aria-hidden="true" />
              {busy ? 'Starting…' : 'Create the wallet'}
            </PrimaryButton>
          ) : (
            <Note tone="warn">Only {founder?.name ?? 'the person who opened the business account'} can start the wallet. Ask them to open this page.</Note>
          )}
        </aside>
      </div>
    </Card>
  );
}
