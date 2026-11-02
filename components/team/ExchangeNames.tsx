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
 *
 * The switches stay focusable while a change saves (aria-disabled, never `disabled`, which would drop the keyboard's place), a
 * change made meanwhile is ignored rather than queued, and the result is said politely to a screen reader.
 */
export default function ExchangeNames({ userId, owner }: { userId: string; owner: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'business' | 'person' | null>(null);
  const [saved, setSaved] = useState<string>('');
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
    setSaved('');
    const answer =
      which === 'business'
        ? await call('/api/team/exchange-names', { method: 'PUT', body: { share } })
        : await call(`/api/team/members/${encodeURIComponent(userId)}/exchange-name`, { method: 'PUT', body: { share } });
    setBusy(null);
    if (answer.ok) setSaved('Saved.');
    else setError(errorText(answer, 'That did not work. Nothing was changed.'));
    await load();
  }

  return (
    <section aria-labelledby="exchange-names" className="space-y-2 rounded-xl bg-[#f4f8fa] p-3">
      <h3 id="exchange-names" className="text-[13px] font-extrabold text-[#0c3e48]">Names sent to exchanges</h3>
      <p className="text-[13px] leading-5 text-[#326273]">
        When a staff member pays an exchange account alone, the exchange is told who sent the payment: their name and job title. If you or your business turn this off, the exchange is told your business sent it, and no person’s name or title. Splash’s own record of who started and approved a payment is not changed.
      </p>
      {state ? (
        <div className="space-y-1">
          <Switch
            id={ownId}
            checked={state.person}
            busy={busy !== null}
            onChange={(next) => void choose('person', next)}
            title="Send my name and job title"
            hint={state.person ? 'On: your name goes with payments you send, if your business allows it too.' : 'Off: the exchange is told your business sent your payments.'}
          />
          {owner ? (
            <Switch
              id={businessId}
              checked={state.business}
              busy={busy !== null}
              onChange={(next) => void choose('business', next)}
              title="Send people’s names for the business"
              hint={state.business ? 'On: names go with payments, for people who also allow it.' : 'Off: no one’s name is sent, whatever they chose. Takes effect at once.'}
            />
          ) : (
            <p className="text-[13px] text-[#326273]">{state.business ? 'Your owners allow names to be sent.' : 'Your owners turned names off, so no one’s name is sent.'}</p>
          )}
        </div>
      ) : error ? null : (
        <p role="status" className="text-[13px] text-[#326273]">Reading this setting…</p>
      )}
      {/* Always in the page, so a screen reader hears "Saved." when it appears; kept a line high so nothing jumps. */}
      <p aria-live="polite" className="min-h-5 text-[13px] font-semibold text-[#0d6370]">{busy ? 'Saving…' : saved}</p>
      {error ? <Note tone="error">{error}</Note> : null}
    </section>
  );
}

/**
 * One on/off switch: a real checkbox with role="switch" (kept in the page, so the keyboard and screen readers have it), drawn as a track and
 * a knob. The whole label is the target, at least 44px high. Contrast: the on track is 6.4:1 and the off track 4.0:1 against the card, the
 * knob white on both; the focus ring shows on the track.
 */
function Switch({ id, checked, busy, onChange, title, hint }: { id: string; checked: boolean; busy: boolean; onChange: (next: boolean) => void; title: string; hint: string }) {
  return (
    <label htmlFor={id} className="flex min-h-11 cursor-pointer items-start gap-3 py-1.5 text-sm text-[#1F4452]">
      <input id={id} type="checkbox" role="switch" checked={checked} aria-disabled={busy} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span
        aria-hidden="true"
        className="relative mt-0.5 inline-block h-6 w-11 shrink-0 rounded-full bg-[var(--pending)] transition-colors peer-checked:bg-[#0d6370] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[#0c3e48] motion-reduce:transition-none after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-transform after:content-[''] peer-checked:after:translate-x-5 motion-reduce:after:transition-none"
      />
      <span>
        <span className="block font-semibold">{title}</span>
        <span className="block text-[13px] text-[#326273]">{hint}</span>
      </span>
    </label>
  );
}
