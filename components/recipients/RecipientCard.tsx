'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeftRight, Building2, Landmark, Link2, Loader2, MailCheck, Wallet, type LucideIcon } from 'lucide-react';

import { call, errorText } from '@/components/transfer/api';
import { Modal, PrimaryButton, QuietButton } from '@/components/transfer/ui';
import { Address, CopyButton, Note, Pill } from '@/components/wallet/parts';
import { actionsFor, RECIPIENT_KINDS, removeWords, type Action, type Entry, type RecipientKind } from '@/lib/recipients-page/view';

const ICONS: Record<RecipientKind, LucideIcon> = {
  bank: Landmark,
  splash_business: Building2,
  exchange: ArrowLeftRight,
  self_custody: Wallet,
  cross_chain: Link2,
};

const LABELS: Record<Action, string> = {
  send_proof: 'Send proof link',
  approve: 'Approve for payment',
  withdraw_proof: 'Withdraw the proof',
  remove: 'Remove',
};

type Result = { link: string | null; emailedTo: string | null; expiresAt: string } | null;

/**
 * One recipient: what it is, where it stands (in words, never colour alone),
 * and the few things this person may do about it. The buttons are exactly the
 * ones the server would accept from this role (lib/recipients-page/view.ts
 * `actionsFor`); each one that cannot be undone asks first.
 */
export default function RecipientCard({ entry, role, onPolicy, onChanged }: { entry: Entry; role: string; /** Whether the spending policy on the chain still allows this address; null when it could not be read. */ onPolicy: boolean | null; onChanged: () => void }) {
  const Icon = ICONS[entry.kind];
  const actions = actionsFor(entry, role);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result>(null);
  const [confirming, setConfirming] = useState<'remove' | 'withdraw_proof' | 'approve' | null>(null);
  const owner = role === 'OWNER';

  async function run(action: Action) {
    setBusy(action);
    setError(null);
    let answer;
    if (action === 'send_proof') {
      answer = await call<{ link: string | null; emailedTo: string | null; expiresAt: string }>(`/api/recipients/${encodeURIComponent(entry.id)}/ownership-proof`, { method: 'POST', body: {} });
      if (answer.ok && answer.body) setResult({ link: answer.body.link, emailedTo: answer.body.emailedTo, expiresAt: answer.body.expiresAt });
    } else if (action === 'approve') {
      answer = await call(`/api/recipients/${encodeURIComponent(entry.id)}/approval`, { method: 'POST', body: {} });
    } else if (action === 'withdraw_proof') {
      answer = await call(`/api/recipients/${encodeURIComponent(entry.id)}/ownership-proof`, { method: 'DELETE' });
    } else {
      answer = await call(entry.source === 'beneficiary' ? `/api/wallet/payouts/beneficiaries/${encodeURIComponent(entry.id)}` : `/api/recipients/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
    }
    setBusy(null);
    setConfirming(null);
    if (!answer.ok) {
      setError(errorText(answer, 'That did not go through. Nothing was changed.'));
      return;
    }
    if (action !== 'send_proof') onChanged();
  }

  const asked = (action: Action) => {
    if (action === 'remove' || action === 'withdraw_proof' || action === 'approve') setConfirming(action);
    else void run(action);
  };

  return (
    <li className="dash-block p-3 sm:p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#5C9EAD]/10 text-[var(--info)]">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h3 className="min-w-0 truncate text-sm font-bold text-[#0c3e48]">{entry.name}</h3>
            <Pill tone={entry.state.tone}>{entry.state.label}</Pill>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-[#326273]">
            <span>{entry.subtitle}</span>
            {entry.country ? <span>{entry.country}</span> : null}
            {entry.masked ? <span className="font-mono">{entry.masked}</span> : null}
          </p>
          <p className="mt-1.5 text-[13px] leading-5 text-[#326273]">{entry.state.detail}</p>
        </div>
      </div>

      {result ? (
        <div role="status" className="mt-3 space-y-2 rounded-xl border border-[#326273]/15 bg-[#f4f8fa] p-3 text-[13px] leading-5 text-[#1F4452]">
          {result.emailedTo ? (
            <p className="flex items-start gap-2"><MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#145d6a]" aria-hidden="true" /><span>The link was emailed to {result.emailedTo}. It works once and expires on {result.expiresAt.slice(0, 10)}.</span></p>
          ) : null}
          {result.link && owner ? (
            <>
              <p>{result.emailedTo ? 'You can also pass the link on yourself:' : 'No email is on file, so pass this link to the supplier yourself. It works once and expires on ' + result.expiresAt.slice(0, 10) + '.'}</p>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1 rounded-lg bg-white p-2"><Address value={result.link} /></div>
                <CopyButton value={result.link} label="Copy the proof link" />
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {error ? <div className="mt-3"><Note tone="error">{error}</Note></div> : null}

      {actions.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.map((action) =>
            action === 'remove' ? (
              <QuietButton key={action} type="button" disabled={busy !== null} onClick={() => asked(action)} className="!text-[13px] text-[var(--error)]" aria-label={`Remove ${entry.name}`}>
                {busy === action ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {LABELS[action]}
              </QuietButton>
            ) : action === 'approve' || action === 'send_proof' ? (
              <PrimaryButton key={action} type="button" disabled={busy !== null} onClick={() => asked(action)} className="!text-[13px]" aria-label={`${LABELS[action]}: ${entry.name}`}>
                {busy === action ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {LABELS[action]}
              </PrimaryButton>
            ) : (
              <QuietButton key={action} type="button" disabled={busy !== null} onClick={() => asked(action)} className="!text-[13px]" aria-label={`${LABELS[action]}: ${entry.name}`}>
                {LABELS[action]}
              </QuietButton>
            ),
          )}
        </div>
      ) : null}
      {actions.includes('send_proof') ? <p className="mt-2 text-[13px] leading-5 text-[#326273]">Sending the link again replaces the earlier link, which stops working.</p> : null}

      <Modal open={confirming !== null} onClose={() => setConfirming(null)} title={confirming === 'remove' ? 'Remove this recipient?' : confirming === 'approve' ? 'Approve this address for payment?' : 'Withdraw the proof?'}>
        <div className="space-y-4">
          {confirming === 'approve' ? (
            <>
              <p className="text-sm leading-6 text-[#1F4452]">
                Approving makes this address one that can be paid. Check every character against what {entry.name} gave you before you go on.
              </p>
              <dl className="space-y-2 rounded-xl border border-[#326273]/15 bg-[#f4f8fa] p-3 text-[13px] leading-5 text-[#1F4452]">
                <div className="flex flex-wrap gap-x-2"><dt className="font-bold">Recipient</dt><dd>{entry.name}</dd></div>
                <div className="flex flex-wrap gap-x-2"><dt className="font-bold">Type</dt><dd>{RECIPIENT_KINDS.find((k) => k.id === entry.kind)?.label ?? entry.subtitle}</dd></div>
                <div className="flex flex-wrap gap-x-2"><dt className="font-bold">Screening</dt><dd>Passed. The address was screened clean.</dd></div>
                <div>
                  <dt className="font-bold">Address</dt>
                  <dd className="mt-1 flex items-start gap-2">
                    <div className="min-w-0 flex-1 rounded-lg bg-white p-2"><Address value={entry.address} /></div>
                    <CopyButton value={entry.address} label="Copy the address" />
                  </dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="text-sm leading-6 text-[#1F4452]">
              {confirming === 'remove'
                ? removeWords(entry, onPolicy)
                : `No payment can go to ${entry.name} until the supplier proves the wallet again. A spending rule that allows this wallet stops working for it.`}
            </p>
          )}
          {confirming === 'remove' && onPolicy !== false && (entry.kind === 'self_custody' || entry.kind === 'exchange') && entry.source === 'saved' ? (
            <p className="text-[13px] leading-5">
              <Link href="/dashboard/settings#policy" className="inline-flex min-h-11 items-center font-semibold text-[#0d6370] underline underline-offset-2">Open Settings to stop allowing it</Link>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <PrimaryButton type="button" disabled={busy !== null} onClick={() => confirming && void run(confirming)}>
              {busy ? 'Working…' : confirming === 'remove' ? 'Remove recipient' : confirming === 'approve' ? 'Approve for payment' : 'Withdraw the proof'}
            </PrimaryButton>
            <QuietButton type="button" onClick={() => setConfirming(null)}>{confirming === 'remove' ? 'Keep it' : 'Not yet'}</QuietButton>
          </div>
        </div>
      </Modal>
    </li>
  );
}
