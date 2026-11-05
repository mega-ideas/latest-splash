'use client';

import { useEffect, useState } from 'react';
import { Building2, Check, Loader2, Search } from 'lucide-react';

import { call, errorText } from './api';
import { Field, TextInput } from './ui';
import type { StepProps } from './flow';

type Found = { id: string; name: string; country: string | null };

/** Step 2 for a business on Splash: find it by its registered name. Only a name, a country and an id come back. */
export default function DetailsBusiness({ flow, patch }: Pick<StepProps, 'flow' | 'patch'>) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Found[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = flow.chosen?.kind === 'splash_business' ? flow.chosen : null;

  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears a search that is too short
      setFound(null);
      setError(null);
      return;
    }
    setBusy(true);
    const timer = window.setTimeout(async () => {
      const answer = await call<{ businesses?: Found[] }>(`/api/wallet/transfers/businesses?q=${encodeURIComponent(q)}`);
      setBusy(false);
      if (!answer.ok) {
        setFound(null);
        setError(errorText(answer, 'The search did not work. Try again.'));
        return;
      }
      setError(null);
      setFound(answer.body?.businesses ?? []);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  return (
    <div className="space-y-4">
      {chosen ? (
        <div className="flex items-center gap-3 rounded-xl border border-[#0d6370] bg-[#f4f8fa] p-3 shadow-[inset_3px_0_0_#0d6370]">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#0d6370] text-white"><Check className="h-4 w-4" aria-hidden="true" /></span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold text-[#0c3e48]">{chosen.name}</span>
            <span className="block text-[13px] text-[#326273]">On Splash · USDC lands in their Splash Wallet</span>
          </span>
          <button type="button" onClick={() => patch({ chosen: null })} className="ml-auto h-11 shrink-0 px-2 text-sm font-semibold text-[#0d6370] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">Change</button>
        </div>
      ) : (
        <>
          <Field label="Their registered business name" hint="At least three letters" htmlFor="sb-q">
            <TextInput id="sb-q" icon={Search} value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" aria-describedby="sb-help" />
          </Field>
          <p id="sb-help" className="text-[13px] text-[#326273]">Only businesses that have finished verification and have a Splash Wallet are found.</p>
          {busy ? <p className="flex items-center gap-2 text-sm text-[#326273]" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Searching…</p> : null}
          {error ? <p role="alert" className="text-sm font-medium text-[var(--error)]">{error}</p> : null}
          {found && found.length === 0 && !busy ? <p role="status" className="rounded-xl border border-dashed border-[#326273]/25 bg-white p-4 text-sm text-[#1F4452]">No business on Splash has that registered name. Check the spelling, or pay a bank account or a Sui wallet instead.</p> : null}
          {found && found.length > 0 ? (
            <ul className="grid gap-2 sm:grid-cols-2">
              {found.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    onClick={() => patch({ chosen: { kind: 'splash_business', businessId: b.id, name: b.name, country: b.country } })}
                    className="flex min-h-[64px] w-full items-center gap-3 rounded-xl border border-[#326273]/20 bg-white p-3 text-left transition-colors hover:border-[#0d6370]/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#eef4f5] text-[#145d6a]"><Building2 className="h-4 w-4" aria-hidden="true" /></span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-bold text-[#0c3e48]">{b.name}</span>
                      <span className="block text-[13px] text-[#326273]">{b.country ?? 'Country not given'}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
