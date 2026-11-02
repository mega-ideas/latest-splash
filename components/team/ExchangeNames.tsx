'use client';

import { useCallback, useEffect, useId, useState } from 'react';

import { call, errorText } from '@/components/transfer/api';
import { Note } from '@/components/wallet/parts';

type State = { business: boolean; person: boolean; shared: boolean };

/**
 * "Names sent to exchanges" in Settings, Team (Sky's decision).
 *
 * When a staff member pays an exchange account alone, the exchange is told who sent the payment: by default their
 * name and job title. Two switches decide it, both on until someone turns them off:
 *
 *   the business's   owners only. Off: no person's name is sent for anyone.
 *   your own         every member, for themselves. Off: your name and title are not sent.
 *
 * If either is off, the exchange is told "Sent by" and the business's name, and no person. This changes only what the
 * exchange is told and what the confirmation shows; Splash's record of who started and approved a payment is not
 * affected. Both save the moment they are switched, and the server decides: the page only asks.
 */
export default function ExchangeNames({ userId, owner }: { userId: string; owner: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'business' | 'person' | null>(null);
  const ownId = useId();
  const businessId = useId();

  const load = useCallback(async () => {
    const answer = await call<State>('/api/team/exchange-names');
    if (answer.ok && answer.body) {
      setState(answer.body);
      setError(null);
    } else {
      setError(errorText(answer, 'Could not read this setting.'));
    }
  }, []);

  useEffect(() => {
    // The first read, once, when the card opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function choose(which: 'business' | 'person', share: boolean) {
    if (busy) return;
    setBusy(which);
    setError(null);
    const answer =
      which === 'business'
        ? await call('/api/team/exchange-names', { method: 'PUT', body: { share } })
        : await call(`/api/team/members/${encodeURIComponent(userId)}/exchange-name`, { method: 'PUT', body: { share } });
    setBusy(null);
    if (!answer.ok) setError(errorText(answer, 'That did not work. Nothing was changed.'));
    await load();
  }

  return (
    <section aria-labelledby="exchange-names" className="space-y-2 rounded-xl bg-[#f4f8fa] p-3">
      <h3 id="exchange-names" className="text-[13px] font-extrabold text-[#0c3e48]">Names sent to exchanges</h3>
      <p className="text-[13px] leading-5 text-[#326273]">
        When a staff member pays an exchange account alone, the exchange is told who sent the payment: their name and job title. If you or your business turn this off, the exchange is told your business sent it, and no person’s name or title. Splash’s own record of who started and approved a payment is not changed.
      </p>
      {state ? (
        <div className="space-y-2">
          <label htmlFor={ownId} className="flex items-start gap-3 text-sm text-[#1F4452]">
            <input id={ownId} type="checkbox" role="switch" checked={state.person} disabled={busy !== null} onChange={(e) => void choose('person', e.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-[#0d6370]" />
            <span>
              <span className="block font-semibold">Send my name and job title</span>
              <span className="block text-[13px] text-[#326273]">{state.person ? 'On: your name goes with payments you send, if your business allows it too.' : 'Off: the exchange is told your business sent your payments.'}</span>
            </span>
          </label>
          {owner ? (
            <label htmlFor={businessId} className="flex items-start gap-3 text-sm text-[#1F4452]">
              <input id={businessId} type="checkbox" role="switch" checked={state.business} disabled={busy !== null} onChange={(e) => void choose('business', e.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-[#0d6370]" />
              <span>
                <span className="block font-semibold">Send people’s names for the business</span>
                <span className="block text-[13px] text-[#326273]">{state.business ? 'On: names go with payments, for people who also allow it.' : 'Off: no one’s name is sent, whatever they chose. Takes effect at once.'}</span>
              </span>
            </label>
          ) : (
            <p className="text-[13px] text-[#326273]">{state.business ? 'Your owners allow names to be sent.' : 'Your owners turned names off, so no one’s name is sent.'}</p>
          )}
        </div>
      ) : error ? null : (
        <p role="status" className="text-[13px] text-[#326273]">Reading this setting…</p>
      )}
      {error ? <Note tone="error">{error}</Note> : null}
    </section>
  );
}
