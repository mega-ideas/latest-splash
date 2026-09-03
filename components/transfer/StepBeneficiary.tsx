'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Building2,
  Check,
  CircleAlert,
  Landmark,
  Loader2,
  PencilLine,
  Search,
  UserRoundPlus,
  Users,
} from 'lucide-react';

import type { TransferState } from '@/app/dashboard/transfer/page';
import type { RecipientRecord } from '@/lib/server/operations';
import { checkMinimumSettlement, minSettlementUsd, formatUsd } from '@/lib/policy/limits';

type TransferPatch = (patch: Partial<TransferState>) => void;
type RecipientCountry = TransferState['recipient']['country'];
type TargetCurrency = TransferState['amount']['targetCurrency'];

const RATES: Record<TargetCurrency, number> = {
  MYR: 4.71,
  PHP: 56.42,
  IDR: 16284,
  SGD: 1.345,
  VND: 25385,
  THB: 35.82,
  EUR: 0.924,
  GBP: 0.789,
};

const COUNTRY_TO_CURRENCY: Record<RecipientCountry, TargetCurrency> = {
  MY: 'MYR', PH: 'PHP', ID: 'IDR', SG: 'SGD', VN: 'VND', TH: 'THB', EU: 'EUR', GB: 'GBP',
};

const COUNTRIES: Array<{ code: RecipientCountry; name: string; flag: string; live?: boolean }> = [
  { code: 'PH', name: 'Philippines', flag: '🇵🇭', live: true },
  { code: 'MY', name: 'Malaysia', flag: '🇲🇾' },
  { code: 'ID', name: 'Indonesia', flag: '🇮🇩' },
  { code: 'SG', name: 'Singapore', flag: '🇸🇬' },
  { code: 'VN', name: 'Vietnam', flag: '🇻🇳' },
  { code: 'TH', name: 'Thailand', flag: '🇹🇭' },
  { code: 'EU', name: 'Eurozone', flag: '🇪🇺' },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
];

const SUPPORTED_COUNTRIES = new Set<RecipientCountry>(COUNTRIES.map((c) => c.code));

const QUICK_AMOUNTS = ['250', '500', '1000', '2500'];

export default function StepBeneficiary({ state, set, next }: { state: TransferState; set: TransferPatch; next: () => void }) {
  const recipient = state.recipient;
  const amount = state.amount;

  const [mode, setMode] = useState<'saved' | 'new'>('saved');
  const [savedRecipients, setSavedRecipients] = useState<RecipientRecord[]>([]);
  const [recipientSearch, setRecipientSearch] = useState('');
  const [selectedRecipientId, setSelectedRecipientId] = useState<string | null>(null);
  const [loadingRecipients, setLoadingRecipients] = useState(true);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [touchedSubmit, setTouchedSubmit] = useState(false);

  const nameOk = recipient.name.trim().length > 1;
  const accountOk = Boolean(recipient.bank?.account?.trim());
  // Minimum settlement size — the same rule the API, the policy engine and the
  // contract enforce. Gating the step here means the operator cannot walk a
  // sub-minimum transfer all the way to the authorization screen.
  const minimumCheck = checkMinimumSettlement(Number.parseFloat(amount.value || '0'), 'transfer');
  const amountOk = minimumCheck.ok;
  const valid = nameOk && accountOk && amountOk;

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/recipients', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Saved recipients are unavailable');
        return response.json() as Promise<RecipientRecord[]>;
      })
      .then((records) => {
        setSavedRecipients(records);
        setRecipientError(null);
        // Nothing saved yet → open straight on manual entry.
        if (records.filter((r) => r.account).length === 0) setMode('new');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setRecipientError(error instanceof Error ? error.message : 'Saved recipients are unavailable');
        setMode('new');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingRecipients(false);
      });
    return () => controller.abort();
  }, []);

  const filteredRecipients = useMemo(() => {
    const query = recipientSearch.trim().toLowerCase();
    const records = savedRecipients.filter((item) => item.account);
    if (!query) return records.slice(0, 6);
    return records
      .filter((item) =>
        item.name.toLowerCase().includes(query) ||
        item.country.toLowerCase().includes(query) ||
        item.bank.toLowerCase().includes(query) ||
        item.account.toLowerCase().includes(query))
      .slice(0, 6);
  }, [recipientSearch, savedRecipients]);

  const rate = RATES[amount.targetCurrency];
  const converted = useMemo(() => {
    const value = Number.parseFloat(amount.value || '0');
    if (!Number.isFinite(value) || value <= 0) return null;
    return (value * rate).toLocaleString(undefined, {
      maximumFractionDigits: amount.targetCurrency === 'IDR' || amount.targetCurrency === 'VND' ? 0 : 2,
    });
  }, [amount.value, amount.targetCurrency, rate]);

  const selectedCountry = COUNTRIES.find((c) => c.code === recipient.country);

  function applySavedRecipient(saved: RecipientRecord) {
    const country = normalizeCountry(saved.country);
    setSelectedRecipientId(saved.id);
    set({
      recipient: {
        ...recipient,
        name: saved.name,
        country,
        rail: 'bank',
        bank: { swift: saved.swift ?? '', account: saved.account ?? '' },
      },
      amount: { ...amount, targetCurrency: COUNTRY_TO_CURRENCY[country] },
      deliveryTier: saved.tier,
    });
  }

  function selectCountry(code: RecipientCountry) {
    setSelectedRecipientId(null);
    set({
      recipient: { ...recipient, country: code },
      amount: { ...amount, targetCurrency: COUNTRY_TO_CURRENCY[code] },
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setTouchedSubmit(true);
        if (valid) next();
      }}
      className="space-y-6"
      noValidate
    >
      {/* ── Zone 1 · Who gets paid ─────────────────────────── */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-[#0C3E48]">Who gets paid?</h2>
            <p className="mt-0.5 text-sm text-[#326273]/60">Start from a saved contact or type a new beneficiary.</p>
          </div>
          {/* Mode switch */}
          <div className="grid grid-cols-2 rounded-xl border border-[#326273]/12 bg-[#F6F0ED] p-1 text-[13px] font-bold" role="tablist" aria-label="Beneficiary source">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'saved'}
              onClick={() => setMode('saved')}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 transition-all ${
                mode === 'saved' ? 'bg-white text-[#0C3E48] shadow-sm' : 'text-[#326273]/55 hover:text-[#326273]'
              }`}
            >
              <Users className="h-3.5 w-3.5" />
              Saved
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'new'}
              onClick={() => { setMode('new'); setSelectedRecipientId(null); }}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 transition-all ${
                mode === 'new' ? 'bg-white text-[#0C3E48] shadow-sm' : 'text-[#326273]/55 hover:text-[#326273]'
              }`}
            >
              <UserRoundPlus className="h-3.5 w-3.5" />
              New recipient
            </button>
          </div>
        </div>

        {mode === 'saved' ? (
          <div className="mt-4 space-y-3">
            <div className="flex min-h-10 items-center gap-2 rounded-xl border border-[#326273]/12 bg-white px-3 shadow-sm">
              <Search className="h-4 w-4 shrink-0 text-[#326273]/40" aria-hidden="true" />
              <input
                value={recipientSearch}
                onChange={(event) => setRecipientSearch(event.target.value)}
                className="min-w-0 flex-1 bg-transparent py-2.5 text-sm text-[#326273] outline-none placeholder:text-[#326273]/35"
                placeholder="Search name, bank, account or country"
                aria-label="Search saved recipients"
              />
            </div>

            {loadingRecipients ? (
              <div className="flex items-center gap-2 rounded-xl border border-[#326273]/10 bg-[#F6F0ED] px-4 py-3.5 text-sm font-medium text-[#326273]/65">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Loading saved recipients…
              </div>
            ) : recipientError ? (
              <div className="rounded-xl border border-[#E39774]/25 bg-[#E39774]/10 px-4 py-3.5 text-sm font-medium text-[#9b4e32]">
                {recipientError}. Switch to “New recipient” to continue.
              </div>
            ) : filteredRecipients.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {filteredRecipients.map((saved) => {
                  const active = selectedRecipientId === saved.id;
                  return (
                    <button
                      key={saved.id}
                      type="button"
                      onClick={() => applySavedRecipient(saved)}
                      className={`group flex items-center gap-3 rounded-xl border p-3.5 text-left transition-all hover:border-[#5C9EAD]/70 hover:bg-[#F8FCFD] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/20 ${
                        active
                          ? 'border-[#5C9EAD] bg-[#F8FCFD] shadow-[inset_3px_0_0_#5C9EAD,0_10px_22px_rgba(12,62,72,0.07)]'
                          : 'border-[#326273]/10 bg-white'
                      }`}
                    >
                      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold transition-colors ${
                        active ? 'bg-[#5C9EAD] text-white' : 'bg-[#5C9EAD]/10 text-[#326273]'
                      }`}>
                        {active ? <Check className="h-4 w-4" aria-hidden="true" /> : saved.name.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold text-[#0C3E48]">{saved.name}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-[#326273]/60">
                          <span className="font-semibold">{saved.country}</span>
                          <span className="truncate">{saved.bank || 'Bank transfer'}</span>
                          <span className="font-mono">···{saved.account.slice(-4)}</span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-[#326273]/18 bg-white px-4 py-4 text-sm text-[#326273]/60">
                No contacts match this search — try “New recipient” instead.
              </div>
            )}

            {selectedRecipientId && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-[#5C9EAD]/25 bg-[#5C9EAD]/8 px-4 py-3 text-sm">
                <span className="min-w-0 truncate font-semibold text-[#0C3E48]">
                  Paying {recipient.name} · {selectedCountry?.name}
                </span>
                <button
                  type="button"
                  onClick={() => setMode('new')}
                  className="inline-flex shrink-0 items-center gap-1 text-[13px] font-bold text-[#326273]/60 hover:text-[#326273]"
                >
                  <PencilLine className="h-3 w-3" />
                  Edit details
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {/* Destination country chips */}
            <div>
              <span className="text-xs font-semibold uppercase tracking-[0.1em] text-[#326273]/55">Destination</span>
              <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {COUNTRIES.map((country) => {
                  const active = recipient.country === country.code;
                  return (
                    <button
                      key={country.code}
                      type="button"
                      onClick={() => selectCountry(country.code)}
                      aria-pressed={active}
                      className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-all ${
                        active
                          ? 'border-[#0C3E48] bg-[#0C3E48] text-white shadow-[3px_3px_0_rgba(12,62,72,0.22)]'
                          : 'border-[#326273]/12 bg-white text-[#326273] hover:border-[#5C9EAD]/60'
                      }`}
                    >
                      <span aria-hidden="true" className="text-base leading-none">{country.flag}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-bold">{country.name}</span>
                        <span className={`block font-mono text-[13px] font-semibold ${active ? 'text-[#8FD7C7]' : 'text-[#326273]/45'}`}>
                          {COUNTRY_TO_CURRENCY[country.code]}
                          {country.live ? ' · testnet live' : ''}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Beneficiary details */}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Business name" error={touchedSubmit && !nameOk ? 'Enter the recipient’s registered name.' : null} className="sm:col-span-2">
                <div className="flex items-center gap-2 rounded-xl border border-[#326273]/15 bg-[#F6F0ED] px-3 focus-within:border-[#5C9EAD]">
                  <Building2 className="h-4 w-4 shrink-0 text-[#326273]/40" aria-hidden="true" />
                  <input
                    value={recipient.name}
                    onChange={(event) => {
                      setSelectedRecipientId(null);
                      set({ recipient: { ...recipient, name: event.target.value } });
                    }}
                    className="min-w-0 flex-1 bg-transparent py-3 text-sm font-medium text-[#326273] outline-none placeholder:text-[#326273]/35"
                    placeholder="Acme Trading Sdn Bhd"
                  />
                </div>
              </Field>

              <Field label="Bank account" error={touchedSubmit && !accountOk ? 'The local account number is required.' : null}>
                <div className="flex items-center gap-2 rounded-xl border border-[#326273]/15 bg-[#F6F0ED] px-3 focus-within:border-[#5C9EAD]">
                  <Landmark className="h-4 w-4 shrink-0 text-[#326273]/40" aria-hidden="true" />
                  <input
                    value={recipient.bank?.account ?? ''}
                    onChange={(event) => {
                      setSelectedRecipientId(null);
                      set({ recipient: { ...recipient, bank: { ...(recipient.bank ?? { swift: '' }), account: event.target.value } } });
                    }}
                    className="min-w-0 flex-1 bg-transparent py-3 font-mono text-sm text-[#326273] outline-none placeholder:font-sans placeholder:text-[#326273]/35"
                    placeholder="Account number"
                    inputMode="numeric"
                  />
                </div>
              </Field>

              <Field label="SWIFT / BIC" hint="Optional">
                <input
                  value={recipient.bank?.swift ?? ''}
                  onChange={(event) => {
                    setSelectedRecipientId(null);
                    set({ recipient: { ...recipient, bank: { ...(recipient.bank ?? { account: '' }), swift: event.target.value.toUpperCase() } } });
                  }}
                  className="w-full rounded-xl border border-[#326273]/15 bg-[#F6F0ED] px-3 py-3 font-mono text-sm uppercase text-[#326273] outline-none placeholder:font-sans placeholder:normal-case placeholder:text-[#326273]/35 focus:border-[#5C9EAD]"
                  placeholder="e.g. BPIAPHMM"
                  maxLength={11}
                />
              </Field>
            </div>
          </div>
        )}
      </section>

      {/* ── Zone 2 · Corridor ticket (amount) ──────────────── */}
      <section>
        <h2 className="text-xl font-bold text-[#0C3E48]">How much?</h2>
        <p className="mt-0.5 text-sm text-[#326273]/60">Funded in USD, delivered in {amount.targetCurrency}.</p>

        <div className="mt-3 overflow-hidden rounded-2xl border border-[#0C3E48]/25 bg-white shadow-[5px_6px_0_rgba(12,62,72,0.1)]">
          <div className="grid sm:grid-cols-[1fr_auto_1fr]">
            {/* You send */}
            <label className="block p-5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#326273]/50">You send</span>
              <span className="mt-2 flex items-baseline gap-2">
                <span className="text-lg font-bold text-[#326273]/40">$</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={amount.value}
                  onChange={(event) => set({ amount: { ...amount, value: event.target.value } })}
                  className="w-full min-w-0 bg-transparent text-3xl font-bold text-[#0C3E48] outline-none placeholder:text-[#326273]/25"
                  placeholder="0.00"
                  aria-label="Amount to send in US dollars"
                />
                <span className="font-mono text-sm font-bold text-[#326273]/55">USD</span>
              </span>
              <span className="mt-3 flex flex-wrap gap-1.5">
                {QUICK_AMOUNTS.map((quick) => (
                  <button
                    key={quick}
                    type="button"
                    onClick={() => set({ amount: { ...amount, value: quick } })}
                    className={`rounded-md px-2.5 py-1 font-mono text-[13px] font-bold transition-colors ${
                      amount.value === quick
                        ? 'bg-[#0C3E48] text-white'
                        : 'bg-[#326273]/8 text-[#326273]/70 hover:bg-[#326273]/15'
                    }`}
                  >
                    ${quick}
                  </button>
                ))}
              </span>
            </label>

            {/* Perforated seam with FX chip */}
            <div className="relative flex items-center justify-center border-t border-dashed border-[#326273]/25 px-5 py-3 sm:border-l sm:border-t-0 sm:py-5" aria-hidden="true">
              <span className="absolute -left-2 -top-2 hidden h-4 w-4 rounded-full border border-[#0C3E48]/25 bg-[#F6F0ED] sm:block" />
              <span className="absolute -bottom-2 -left-2 hidden h-4 w-4 rounded-full border border-[#0C3E48]/25 bg-[#F6F0ED] sm:block" />
              <span className="flex items-center gap-2 rounded-full bg-[#0C3E48] px-3 py-1.5 font-mono text-[13px] font-bold text-[#8FD7C7]">
                1 USD ≈ {rate.toLocaleString()} {amount.targetCurrency}
                <ArrowRight className="h-3 w-3" />
              </span>
            </div>

            {/* Recipient gets */}
            <div className="bg-[#F4F8FA] p-5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#326273]/50">
                Recipient gets · {selectedCountry?.flag ?? ''} {selectedCountry?.name ?? recipient.country}
              </span>
              <div className="mt-2 flex items-baseline gap-2">
                <span className={`truncate text-3xl font-bold ${converted ? 'text-[#0d6370]' : 'text-[#326273]/25'}`}>
                  {converted ?? '0.00'}
                </span>
                <span className="font-mono text-sm font-bold text-[#326273]/55">{amount.targetCurrency}</span>
              </div>
              <p className="mt-3 text-[13px] leading-4 text-[#326273]/50">
                Indicative only — the exact quote locks with fees shown before you sign.
                {' '}Minimum transfer {formatUsd(minSettlementUsd())}.
              </p>
            </div>
          </div>
        </div>
        {touchedSubmit && !amountOk && (
          <p className="mt-2 flex items-center gap-1.5 text-[13px] font-semibold text-[#9b4e32]">
            <CircleAlert className="h-3.5 w-3.5" /> {minimumCheck.ok ? 'Enter the USD amount to send.' : minimumCheck.message}
          </p>
        )}
      </section>

      {/* ── Continue ───────────────────────────────────────── */}
      <div className="flex flex-col gap-2 border-t border-[#326273]/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-[13px] font-medium text-[#326273]/55">
          {valid
            ? <>Next: choose how {recipient.name.split(' ')[0] || 'the recipient'} receives it.</>
            : 'Recipient, account and amount unlock the next step.'}
        </div>
        <button
          type="submit"
          disabled={!valid && touchedSubmit}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#326273] px-6 py-3 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[#264e5b] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Continue to delivery
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </form>
  );
}

function normalizeCountry(country: string): RecipientCountry {
  if (SUPPORTED_COUNTRIES.has(country as RecipientCountry)) return country as RecipientCountry;
  return 'PH';
}

function Field({ label, hint, error, children, className = '' }: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between">
        <label className="text-xs font-semibold uppercase tracking-[0.1em] text-[#326273]/55">{label}</label>
        {hint && <span className="text-[13px] font-semibold text-[#326273]/35">{hint}</span>}
      </div>
      <div className="mt-1.5">{children}</div>
      {error && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-[#9b4e32]">
          <CircleAlert className="h-3.5 w-3.5" /> {error}
        </p>
      )}
    </div>
  );
}
