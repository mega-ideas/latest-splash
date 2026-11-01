'use client';

import { useEffect, useId, useState } from 'react';
import { CircleAlert, Loader2, ShieldCheck } from 'lucide-react';

import { EXCHANGE_PURPOSES, type DisclosureText } from '@/lib/compliance/exchange-disclosure';
import { call, errorText } from './api';
import { Field, SelectInput } from './ui';

/** What the person confirmed: the purpose they picked and the hash of the message they read. The server checks both against its own. */
export type ExchangeConfirmation = { purpose: string; confirmedHash: string };

/**
 * Before a staff member pays an exchange account alone (v2 Phase 3): the message that will be shared with the exchange, in plain words,
 * the purpose they pick from a short list, and an explicit confirmation. The server builds the message from what it holds and answers
 * it with a hash; the payment is sent with that hash, and the server refuses it unless its own message still hashes the same. Showing
 * the message shares nothing and stores nothing.
 *
 * If the server would not build it (the owner's switch is off, the provider is not set up, something the exchange needs is missing),
 * its reason is shown in its words and the person is handed back to asking the owners.
 */
export default function ExchangeDisclosure({
  recipientId,
  amountMinor,
  intentKey,
  refreshKey,
  onConfirmation,
  onRefused,
}: {
  recipientId: string;
  amountMinor: string;
  intentKey: string;
  /** Bumped when the server says the message changed after it was read, so it is read again. */
  refreshKey: number;
  onConfirmation: (confirmation: ExchangeConfirmation | null) => void;
  onRefused: (reason: string) => void;
}) {
  const purposeId = useId();
  const checkId = useId();
  const [purpose, setPurpose] = useState('');
  const [text, setText] = useState<DisclosureText | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    // Whatever was read is no longer what will be sent: ask for the message again and the person confirms again.
    /* eslint-disable react-hooks/set-state-in-effect -- reset when the inputs change; the answer sets the rest */
    setConfirmed(false);
    onConfirmation(null);
    setText(null);
    setHash(null);
    setProblem(null);
    if (!purpose) return;
    let live = true;
    setLoading(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    void call<{ text?: DisclosureText; hash?: string; error?: string; code?: string }>('/api/wallet/transfers/exchange-disclosure', {
      key: intentKey,
      body: { payee: { kind: 'recipient', recipientId }, amountMinor, purpose },
    }).then((answer) => {
      if (!live) return;
      setLoading(false);
      if (!answer.ok || !answer.body?.text || !answer.body.hash) {
        const reason = errorText(answer, 'The message for the exchange could not be made. Nothing was sent.');
        setProblem(reason);
        // Only a purpose that was not accepted is the person's to change here. Anything else (the switch, the provider, a missing detail, a bad
        // amount or intent id) is not theirs to fix on this screen, so they are handed to asking the owners.
        if (answer.body?.code !== 'bad_purpose') onRefused(reason);
        return;
      }
      setText(answer.body.text);
      setHash(answer.body.hash);
    });
    return () => {
      live = false;
    };
    // onConfirmation and onRefused are the parent's setters; they do not change what is asked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purpose, recipientId, amountMinor, intentKey, refreshKey]);

  const confirm = (on: boolean) => {
    setConfirmed(on);
    onConfirmation(on && hash ? { purpose, confirmedHash: hash } : null);
  };

  return (
    <section aria-labelledby="exchange-share" className="space-y-3 rounded-2xl border border-[#326273]/15 bg-white p-4">
      <h3 id="exchange-share" className="flex items-center gap-2 text-sm font-extrabold text-[#0c3e48]">
        <ShieldCheck className="h-4 w-4 text-[#0d6370]" aria-hidden="true" />
        Before you pay an exchange account
      </h3>
      <p className="text-sm leading-6 text-[#1F4452]">Paying an exchange account means telling the exchange who is paying and why. Pick what this payment is for, then read what will be shared.</p>
      <Field label="What is this payment for?" htmlFor={purposeId}>
        <SelectInput id={purposeId} value={purpose} onChange={(e) => setPurpose(e.target.value)}>
          <option value="">Choose a purpose</option>
          {EXCHANGE_PURPOSES.map((p) => (
            <option key={p.code} value={p.code}>{p.label}</option>
          ))}
        </SelectInput>
      </Field>
      {loading ? (
        <p role="status" className="flex items-center gap-2 text-sm text-[#326273]"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Preparing the message…</p>
      ) : null}
      {problem ? (
        <p role="alert" className="flex items-start gap-2 text-sm font-medium text-[var(--error)]"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{problem}</p>
      ) : null}
      {text ? (
        <div className="space-y-3">
          <p className="text-sm font-bold text-[#0c3e48]">{text.headline}</p>
          <dl className="divide-y divide-[#326273]/10 rounded-xl border border-[#326273]/15 text-sm">
            {text.rows.map((row) => (
              <div key={row.label} className="flex flex-col gap-0.5 px-3 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
                <dt className="text-[#326273]">{row.label}</dt>
                {/* An address is one unbroken string: it breaks anywhere, in a steady face, rather than leaving a stray pair of characters on a line of its own. */}
                <dd className={`min-w-0 font-semibold text-[#0c3e48] sm:text-right ${/^0x[0-9a-f]{40,}$/i.test(row.value) ? 'break-all font-mono text-[13px] leading-5' : 'break-words'}`}>{row.value}</dd>
              </div>
            ))}
          </dl>
          {text.lines.slice(-2).map((line) => (
            <p key={line} className="text-[13px] leading-5 text-[#326273]">{line}</p>
          ))}
          <label htmlFor={checkId} className="flex items-start gap-3 rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] p-3.5 text-sm leading-6 text-[#1F4452]">
            <input id={checkId} type="checkbox" checked={confirmed} onChange={(e) => confirm(e.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-[#0d6370]" />
            <span>I have read this and it is right. Share it with the exchange when I pay.</span>
          </label>
        </div>
      ) : null}
    </section>
  );
}
