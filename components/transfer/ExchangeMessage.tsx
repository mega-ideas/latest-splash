'use client';

import { useEffect, useState } from 'react';

import { call, errorText } from './api';
import { QuietButton } from './ui';

type MessageState = { state: 'sent' | 'not_sent'; text: string };

/**
 * Whether the exchange's Travel Rule message for a staff member's own payment has gone to the provider, and, if it has not, the way to
 * send it again. The payment cannot be signed until it has. It reads the state from the server every time it is shown (by the payment's
 * signing request), so it is the same after a reload, after a replayed send and in the signing inbox. A payment with no such message
 * shows nothing.
 */
export default function ExchangeMessage({ signingId }: { signingId: string }) {
  const [state, setState] = useState<MessageState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void call<{ travelRule?: MessageState | null }>(`/api/wallet/transfers/${encodeURIComponent(signingId)}/exchange-message`).then((answer) => {
      if (live) setState(answer.ok ? (answer.body?.travelRule ?? null) : null);
    });
    return () => {
      live = false;
    };
  }, [signingId]);

  async function resend() {
    setBusy(true);
    const answer = await call<{ travelRule?: MessageState }>(`/api/wallet/transfers/${encodeURIComponent(signingId)}/exchange-message`, { body: {} });
    setBusy(false);
    setState(answer.body?.travelRule ?? { state: 'not_sent', text: errorText(answer, 'The message could not be sent. Nothing left your wallet.') });
  }

  if (!state) return null;
  return (
    <div role="status" className={`space-y-2 rounded-2xl border p-4 text-sm leading-6 text-[#1F4452] ${state.state === 'sent' ? 'border-[#326273]/15 bg-white' : 'border-[var(--warn)] bg-[var(--warn-bg)]'}`}>
      <p>{state.text}</p>
      {state.state === 'not_sent' ? (
        <QuietButton type="button" disabled={busy} onClick={() => void resend()}>{busy ? 'Sending…' : 'Send the message again'}</QuietButton>
      ) : null}
    </div>
  );
}
