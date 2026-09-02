'use client';

import { Search, UserRoundPlus, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Badge, Button, Card, Chip, PillToggle, Skeleton } from '@/components/system';
import { getNetworkProfile } from '@/lib/network';
import { COUNTRIES, COUNTRY_TO_CURRENCY, type RecipientCountry, type TransferState } from '@/lib/send/state';
import type { RecipientRecord } from '@/lib/server/operations';
import { cn } from '@/lib/utils';

const fieldClass =
  'h-12 w-full rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface)] px-4 text-[16px] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--teal-600)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--teal-500)]';

function normalizeCountry(value: string): RecipientCountry {
  const code = value.toUpperCase();
  return (COUNTRIES.some((entry) => entry.code === code) ? code : 'PH') as RecipientCountry;
}

/**
 * Who gets paid. Saved counterparties first (they are KYB-verified and
 * reusable); a new recipient is a name, a country and a bank reference.
 */
export default function RecipientStep({ state, set, next }: { state: TransferState; set: (patch: Partial<TransferState>) => void; next: () => void }) {
  const [mode, setMode] = useState<'saved' | 'new'>('saved');
  const [saved, setSaved] = useState<RecipientRecord[] | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const corridors = getNetworkProfile().corridors;

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/recipients', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => (response.ok ? ((await response.json()) as RecipientRecord[]) : []))
      .then((records) => {
        setSaved(records);
        if (records.filter((record) => record.account).length === 0) setMode('new');
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setSaved([]);
          setMode('new');
        }
      });
    return () => controller.abort();
  }, []);

  const filtered = useMemo(() => {
    const records = (saved ?? []).filter((record) => record.account);
    const needle = query.trim().toLowerCase();
    if (!needle) return records.slice(0, 6);
    return records.filter((record) => [record.name, record.country, record.bank, record.account].some((field) => field?.toLowerCase().includes(needle))).slice(0, 6);
  }, [query, saved]);

  const nameOk = state.recipient.name.trim().length > 1;
  const accountOk = Boolean(state.recipient.bank?.account?.trim());
  const valid = nameOk && accountOk;

  function choose(record: RecipientRecord) {
    const country = normalizeCountry(record.country);
    setSelectedId(record.id);
    set({
      recipient: { ...state.recipient, name: record.name, country, rail: 'bank', bank: { swift: record.swift ?? '', account: record.account ?? '' } },
      amount: { ...state.amount, targetCurrency: COUNTRY_TO_CURRENCY[country] },
      deliveryTier: record.tier,
    });
  }

  function selectCountry(code: RecipientCountry) {
    setSelectedId(null);
    set({ recipient: { ...state.recipient, country: code }, amount: { ...state.amount, targetCurrency: COUNTRY_TO_CURRENCY[code] } });
  }

  return (
    <form
      noValidate
      className="grid gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (valid) next();
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[var(--text-h2)] font-semibold leading-[1.15] tracking-[-0.02em]">Who gets paid?</h2>
          <p className="mt-1 text-[14px] text-[var(--text-2)]">Start from a saved counterparty or add a new one.</p>
        </div>
        <PillToggle
          label="Recipient source"
          value={mode}
          onChange={(value) => {
            setMode(value);
            if (value === 'new') setSelectedId(null);
          }}
          options={[
            { value: 'saved', label: 'Saved' },
            { value: 'new', label: 'New' },
          ]}
        />
      </div>

      {mode === 'saved' ? (
        <div className="grid gap-3">
          <label className="relative block">
            <span className="sr-only">Search saved recipients</span>
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, country or bank" className={cn(fieldClass, 'pl-11')} />
          </label>
          {saved === null ? (
            <div className="grid gap-2">
              <Skeleton />
              <Skeleton />
            </div>
          ) : filtered.length === 0 ? (
            <Card tone="tint" padding="sm" className="grid gap-2 text-[14px] text-[var(--text-2)]">
              No saved recipients match.
              <Button size="sm" variant="ghost" onClick={() => setMode('new')}>
                <UserRoundPlus aria-hidden="true" /> Add a new recipient
              </Button>
            </Card>
          ) : (
            <ul className="grid gap-2 md:grid-cols-2">
              {filtered.map((record) => {
                const active = selectedId === record.id;
                const corridor = corridors.find((entry) => entry.code === normalizeCountry(record.country));
                return (
                  <li key={record.id}>
                    <button
                      type="button"
                      onClick={() => choose(record)}
                      aria-pressed={active}
                      className={cn(
                        'grid w-full gap-1 rounded-[var(--r-md)] border p-4 text-left transition-colors duration-[var(--dur-ui)] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--teal-500)]',
                        active ? 'border-[var(--teal-600)] bg-[var(--teal-100)]' : 'border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-2)]',
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-[15px] font-semibold text-[var(--text)]">{record.name}</span>
                        <Badge tone={record.tier === 'PAYOUT_ONLY' ? 'slate' : 'teal'}>{record.tier === 'PAYOUT_ONLY' ? 'Bank payout' : record.tier === 'SWEEP_ACCOUNT' ? 'Receive account' : 'Splash balance'}</Badge>
                      </span>
                      <span className="font-mono text-[12px] text-[var(--text-muted)]">
                        {record.bank} · {record.account}
                      </span>
                      <span className="flex flex-wrap gap-1.5 pt-1">
                        <Chip>{normalizeCountry(record.country)}</Chip>
                        {corridor ? <Chip tone="teal">{corridor.partnerLabel}</Chip> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}

      <div className="grid gap-4">
        <div className="grid gap-2">
          <label htmlFor="recipient-name" className="text-[14px] font-semibold">
            Business name
          </label>
          <input
            id="recipient-name"
            value={state.recipient.name}
            onChange={(event) => {
              setSelectedId(null);
              set({ recipient: { ...state.recipient, name: event.target.value } });
            }}
            placeholder="Supplier legal name"
            autoComplete="organization"
            className={fieldClass}
            aria-invalid={touched && !nameOk}
          />
          {touched && !nameOk ? <p className="text-[13px] text-[var(--error)]">Enter the recipient&apos;s business name.</p> : null}
        </div>

        <fieldset className="grid gap-2">
          <legend className="text-[14px] font-semibold">Country</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Destination country">
            {COUNTRIES.map((country) => {
              const active = state.recipient.country === country.code;
              const live = corridors.some((entry) => entry.code === country.code);
              return (
                <button
                  key={country.code}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => selectCountry(country.code)}
                  className={cn(
                    'inline-flex min-h-11 items-center gap-2 rounded-[var(--r-pill)] border px-4 text-[14px] font-medium transition-colors outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--teal-500)]',
                    active ? 'border-[var(--ink-900)] bg-[var(--ink-900)] text-white' : 'border-[var(--line)] bg-[var(--surface)] text-[var(--text-2)] hover:bg-[var(--surface-2)]',
                  )}
                >
                  {country.name}
                  {live ? <span className={cn('font-mono text-[11px]', active ? 'text-white/70' : 'text-[var(--teal-600)]')}>{COUNTRY_TO_CURRENCY[country.code]}</span> : null}
                </button>
              );
            })}
          </div>
          <p className="text-[12px] text-[var(--text-muted)]">Corridors launch in a staggered order; other routes stay modeled until partner controls are active.</p>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <label htmlFor="recipient-account" className="text-[14px] font-semibold">
              Bank account or reference
            </label>
            <input
              id="recipient-account"
              value={state.recipient.bank?.account ?? ''}
              onChange={(event) => {
                setSelectedId(null);
                set({ recipient: { ...state.recipient, rail: 'bank', bank: { swift: state.recipient.bank?.swift ?? '', account: event.target.value } } });
              }}
              placeholder="Account number"
              inputMode="text"
              className={cn(fieldClass, 'font-mono')}
              aria-invalid={touched && !accountOk}
            />
            {touched && !accountOk ? <p className="text-[13px] text-[var(--error)]">A bank account or reference is required.</p> : null}
          </div>
          <div className="grid gap-2">
            <label htmlFor="recipient-swift" className="text-[14px] font-semibold">
              SWIFT / BIC <span className="font-normal text-[var(--text-muted)]">(optional)</span>
            </label>
            <input
              id="recipient-swift"
              value={state.recipient.bank?.swift ?? ''}
              onChange={(event) => set({ recipient: { ...state.recipient, rail: 'bank', bank: { swift: event.target.value.toUpperCase(), account: state.recipient.bank?.account ?? '' } } })}
              placeholder="e.g. BOPIPHMM"
              className={cn(fieldClass, 'font-mono uppercase')}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="inline-flex items-center gap-2 text-[13px] text-[var(--text-muted)]">
          <Users className="size-4" aria-hidden="true" /> Payouts go only to verified counterparties.
        </p>
        <Button type="submit" size="lg">
          Continue to amount
        </Button>
      </div>
    </form>
  );
}
