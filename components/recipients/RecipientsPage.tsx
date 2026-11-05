'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Plus, RefreshCw, Search, ShieldCheck } from 'lucide-react';

import DashPageHeader from '@/components/dashboard/DashPageHeader';
import { useLaunchScope } from '@/components/dashboard/CustodyPhaseContext';
import QuickLinksCard from '@/components/dashboard/QuickLinksCard';
import { call, errorText } from '@/components/transfer/api';
import { PrimaryButton, QuietButton } from '@/components/transfer/ui';
import { Card, Loading, Note, useLoad } from '@/components/wallet/parts';
import type { Overview } from '@/components/wallet/types';
import { Layers, Send } from 'lucide-react';
import { buildEntries, countByKind, filterEntries, policyHolds, RECIPIENT_KINDS, type BankAccount, type PaidPayee, type RecipientKind } from '@/lib/recipients-page/view';
import { settingsWallet } from '@/lib/settings-page/wallet-gate';
import type { ClientRecipient } from '@/lib/recipients-page/wire';
import NewRecipient from './NewRecipient';
import RecipientCard from './RecipientCard';

type Loaded = { saved: ClientRecipient[]; beneficiaries: BankAccount[]; transfers: PaidPayee[] };

/**
 * Recipients (v2 brief 5.9): everyone this business pays, by type, with where
 * each one stands before it can be paid. A bank account is verified with the
 * bank; a self-custody wallet is proven by the supplier; an exchange account
 * and an address on another chain are screened and approved by an owner; a
 * business on Splash is found by name. Each row says what is missing and who
 * can supply it. Nothing here pays anyone: that is Transfer's.
 *
 * Every list is the signed-in person's own business, read from the session.
 */
export default function RecipientsPage() {
  const overview = useLoad<Overview>('/api/wallet/overview', 'Your role could not be read.');
  const bankOpen = useLaunchScope() !== 'stablecoin';
  const [data, setData] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [kind, setKind] = useState<RecipientKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    // A viewer may not read payouts or the payments list; their own page is the saved recipients only.
    const [saved, banks, paid] = await Promise.all([
      call<ClientRecipient[]>('/api/recipients'),
      call<{ beneficiaries?: BankAccount[] }>('/api/wallet/payouts/beneficiaries'),
      call<{ transfers?: PaidPayee[] }>('/api/wallet/transfers'),
    ]);
    if (!saved.ok || !Array.isArray(saved.body)) {
      setProblem(errorText(saved, 'Your recipients could not be loaded.'));
      return;
    }
    setProblem(null);
    setData({ saved: saved.body, beneficiaries: banks.ok ? banks.body?.beneficiaries ?? [] : [], transfers: paid.ok ? paid.body?.transfers ?? [] : [] });
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set when the answers arrive
    void load();
  }, [load]);

  const role = overview.data?.role ?? 'VIEWER';
  // The spending policy is on the chain: taking a wallet off this list does not take it off the policy. An owner reads the policy to say so.
  const hasWallet = settingsWallet(overview.data?.walletState).manage;
  const policy = useLoad<{ policy: { recipients: Array<{ address: string }> } | null }>(role === 'OWNER' && hasWallet ? '/api/wallet/spending-rules' : null, 'The spending policy could not be read.');
  const onPolicyOf = (address: string): boolean | null => {
    if (role !== 'OWNER' || !hasWallet || address === '') return false;
    if (policy.loading || policy.error || !policy.data) return null;
    return policyHolds(policy.data.policy, address);
  };
  const entries = useMemo(() => (data ? buildEntries(data) : []), [data]);
  const counts = useMemo(() => countByKind(entries), [entries]);
  const shown = useMemo(() => filterEntries(entries, { kind, query }), [entries, kind, query]);
  const canAdd = role === 'OWNER' || role === 'MAKER' || role === 'APPROVER';

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <DashPageHeader
        kicker="Who you pay"
        title="Recipients"
        description="Everyone your business pays, and where each one stands before money can move. Payments are made in Transfer; what has been paid is in History."
        actions={
          canAdd ? (
            <PrimaryButton type="button" onClick={() => setAdding((v) => !v)} aria-expanded={adding} className="!px-4 !text-[13px]">
              <Plus className="h-4 w-4" aria-hidden="true" />
              New recipient
            </PrimaryButton>
          ) : null
        }
      />

      {adding ? (
        <NewRecipient
          bankOpen={bankOpen}
          onClose={() => setAdding(false)}
          onSaved={(name) => {
            setAdding(false);
            setNotice(`${name} was saved. The row says what is left before it can be paid.`);
            void load();
          }}
        />
      ) : null}

      {notice ? <p role="status" className="rounded-xl border border-[#5C9EAD]/25 bg-[#5C9EAD]/10 px-4 py-3 text-sm font-semibold text-[#1F4452]">{notice}</p> : null}

      <section className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <div className="space-y-4">
          <div className="dash-surface space-y-3 p-3 sm:p-4">
            <div role="group" aria-label="Type of recipient" className="flex flex-wrap gap-2">
              {([{ id: 'all', label: 'All' }, ...RECIPIENT_KINDS.map((k) => ({ id: k.id, label: k.label }))] as Array<{ id: RecipientKind | 'all'; label: string }>).map((k) => {
                const on = kind === k.id;
                return (
                  <button
                    key={k.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setKind(k.id)}
                    className={`inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 text-[13px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] ${on ? 'border-[#0c3e48] bg-[#0c3e48] text-white' : 'border-[#326273]/20 bg-white text-[#1F4452] hover:border-[#0d6370]/60'}`}
                  >
                    {k.label}
                    <span className={`rounded-full px-1.5 text-[12px] font-bold tabular-nums ${on ? 'bg-white/20 text-white' : 'bg-[#326273]/10 text-[#1F4452]'}`}>{counts[k.id]}</span>
                  </button>
                );
              })}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#326273]" aria-hidden="true" />
              <input
                type="search"
                aria-label="Search recipients by name, bank or address"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, bank or address"
                className="h-11 w-full rounded-xl border border-[#326273]/25 bg-white pl-10 pr-3 text-sm text-[#0c3e48] outline-none placeholder:text-[#326273] focus:border-[#0d6370] focus:ring-2 focus:ring-[#0d6370]/20"
              />
            </div>
          </div>

          {problem ? (
            <div className="space-y-3">
              <Note tone="error">{problem}</Note>
              <QuietButton type="button" onClick={() => void load()}><RefreshCw className="h-4 w-4" aria-hidden="true" />Try again</QuietButton>
            </div>
          ) : !data ? (
            <Loading label="Reading your recipients…" />
          ) : shown.length === 0 ? (
            <div className="dash-surface p-6 text-center">
              <p className="text-sm font-bold text-[#0c3e48]">{entries.length === 0 ? 'No recipients yet' : 'No recipient matches'}</p>
              <p className="mx-auto mt-1 max-w-md text-[13px] leading-5 text-[#326273]">
                {entries.length === 0
                  ? canAdd
                    ? 'Save your first supplier here, or add a bank account in Transfer. Each one is checked before it can be paid.'
                    : 'An owner or a staff member saves the business’s recipients.'
                  : 'Try another type or a shorter search.'}
              </p>
            </div>
          ) : (
            <ul className="space-y-3" aria-label="Recipients">
              {shown.map((entry) => (
                <RecipientCard key={`${entry.source}-${entry.id}`} entry={entry} role={role} onPolicy={onPolicyOf(entry.address)} onChanged={() => { void load(); policy.reload(); }} />
              ))}
            </ul>
          )}
        </div>

        <aside className="space-y-4">
          <Card id="how-checked" title="How a recipient is checked">
            <ul className="space-y-2.5 text-[13px] leading-5 text-[#326273]">
              {RECIPIENT_KINDS.map((k) => (
                <li key={k.id}>
                  <span className="font-bold text-[#0c3e48]">{k.label}.</span> {k.blurb}
                </li>
              ))}
            </ul>
            <p className="mt-3 flex items-start gap-2 text-[13px] leading-5 text-[#1F4452]">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--info)]" aria-hidden="true" />
              <span>An address is screened before it is saved and again before every payment. A wallet or exchange address is paid only after an owner approves it.</span>
            </p>
          </Card>

          <section className="dash-block p-4" aria-labelledby="pay-links">
            <h2 id="pay-links" className="text-sm font-extrabold text-[#0c3e48]">Pay a recipient</h2>
            <p className="mt-0.5 text-[13px] text-[#326273]">Payments are made from your wallet, by your owners.</p>
            <QuickLinksCard
              className="mt-3"
              links={[
                { label: 'Make a transfer', href: '/dashboard/transfer', icon: Send },
                { label: 'Pay many at once', href: '/dashboard/batch', icon: Layers },
              ]}
            />
            <Link href="/dashboard/history" className="mt-3 inline-flex min-h-11 items-center gap-1 text-[13px] font-semibold text-[#1F4452] hover:underline">
              What has been paid <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </section>
        </aside>
      </section>
    </div>
  );
}
