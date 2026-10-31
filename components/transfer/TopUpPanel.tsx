'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Banknote, Check, CircleAlert, Clock3, CreditCard, Copy, Loader2, Wallet } from 'lucide-react';

import { formatUsdc } from '@/lib/fees/copy';
import { call, errorText } from './api';
import { PrimaryButton, QuietButton } from './ui';

type Source = { id: string; kind: 'bank_account' | 'card' | 'wallet'; label: string; status: string; last4: string | null; chain: string | null; address: string | null };
type Options = {
  wallet: string;
  channels: { provider: Array<{ id: string; label: string; available: boolean; reason: string | null }>; wallet: { address: string } };
  sources: Source[];
};
type QuoteLine = { payee: string; label: string; amountMinor: string };
type FundingQuote = { arrivesMinMinor: string; lines: QuoteLine[]; expiresAt: string | null; sandbox: boolean };
type Intent = { id: string; status: string; instructions: Record<string, unknown> | null; destination: string; progress?: { expectedMinMinor: string; clearedMinor: string; heldMinor: string } };

const CCTP_CHAINS = new Set(['ETHEREUM', 'BASE', 'ARBITRUM', 'SOLANA', 'OP_MAINNET', 'POLYGON_POS', 'AVALANCHE']);

/** What a source is sent as: the channel, method and chain the funding routes know. Null when the page cannot tell. */
function routeFor(source: Source, options: Options): Record<string, string> | null {
  if (source.kind === 'bank_account' || source.kind === 'card') {
    const provider = options.channels.provider.find((p) => p.available);
    return provider ? { channel: 'provider', provider: provider.id, method: source.kind === 'card' ? 'card' : 'bank' } : null;
  }
  const chain = (source.chain ?? 'SUI').toUpperCase();
  if (chain === 'SUI') return { channel: 'wallet', asset: 'USDC' };
  if (CCTP_CHAINS.has(chain)) return { channel: 'cctp', asset: 'USDC', sourceChain: chain, speed: 'standard' };
  return null;
}

const cents = (minor: bigint) => ((minor + 9_999n) / 10_000n) * 10_000n;
const decimal = (minor: bigint) => formatUsdc(minor).replace(/,/g, '');

/**
 * "Top up and continue" (v2 brief 4.3 and 5.4 step 3): add exactly the
 * shortfall from a source the business has already verified. Funds arrive in
 * the Splash Wallet first; the draft is kept; the rate is quoted after they
 * arrive. The page goes on only when the server says the top-up has arrived
 * (cleared by screening), never on the person's word.
 */
export default function TopUpPanel({ shortByMinor, intentKey, existingIntentId, onStarted, onArrived }: { shortByMinor: bigint; intentKey: string; existingIntentId: string | null; onStarted: (intentId: string) => void; onArrived: () => void }) {
  const [options, setOptions] = useState<Options | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [quote, setQuote] = useState<FundingQuote | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const arrived = useRef(false);
  const need = cents(shortByMinor);

  useEffect(() => {
    let live = true;
    void call<Options & { error?: string }>('/api/wallet/funding').then((answer) => {
      if (!live) return;
      if (!answer.ok || !answer.body) setLoadError(errorText(answer, 'Your funding sources could not be loaded.'));
      else setOptions(answer.body);
    });
    return () => {
      live = false;
    };
  }, []);

  const poll = useCallback(
    async (id: string) => {
      const answer = await call<{ intent?: Intent }>(`/api/wallet/funding/intents/${encodeURIComponent(id)}`);
      const next = answer.body?.intent;
      if (!next) return;
      setIntent(next);
      if (next.status === 'arrived' && !arrived.current) {
        arrived.current = true;
        onArrived();
      }
    },
    [onArrived],
  );

  useEffect(() => {
    if (!existingIntentId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- asks the server where a top-up stands; state is set when it answers
    void poll(existingIntentId);
  }, [existingIntentId, poll]);

  useEffect(() => {
    const id = intent?.id ?? existingIntentId;
    if (!id || arrived.current) return;
    const timer = window.setInterval(() => void poll(id), 5000);
    return () => window.clearInterval(timer);
  }, [intent?.id, existingIntentId, poll]);

  const source = options?.sources.find((s) => s.id === sourceId) ?? null;
  const route = source && options ? routeFor(source, options) : null;

  async function showQuote() {
    if (!source || !route) return;
    setBusy(true);
    setError(null);
    const answer = await call<{ quote?: FundingQuote }>('/api/wallet/funding/quotes', { body: { ...route, amount: decimal(need) } });
    setBusy(false);
    if (!answer.ok || !answer.body?.quote) {
      setError(errorText(answer, 'There is no quote for that source right now.'));
      return;
    }
    setQuote(answer.body.quote);
  }

  async function confirm() {
    if (!source || !route || !quote) return;
    setBusy(true);
    setError(null);
    const answer = await call<{ intent?: Intent }>('/api/wallet/funding/intents', {
      key: `${intentKey}_topup`,
      body: { ...route, amount: decimal(need), sourceId: source.id, purpose: 'transfer_top_up', transferRef: intentKey, acceptedArrivesMinMinor: quote.arrivesMinMinor },
    });
    setBusy(false);
    const made = answer.body?.intent;
    if (!answer.ok || !made) {
      setError(errorText(answer, 'The top-up was not started. Nothing was charged.'));
      return;
    }
    setIntent(made);
    onStarted(made.id);
  }

  if (loadError) return <p role="alert" className="rounded-xl border border-[var(--error)]/40 bg-[var(--error-bg)] p-4 text-sm font-medium text-[var(--error)]">{loadError}</p>;
  if (!options) return <p role="status" className="flex items-center gap-2 text-sm text-[#326273]"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading your funding sources…</p>;

  if (intent || existingIntentId) {
    const status = intent?.status ?? 'awaiting_funds';
    const waiting = status !== 'arrived';
    const instr = (intent?.instructions ?? {}) as { kind?: string; destination?: string; next?: unknown };
    return (
      <div className="space-y-3 rounded-2xl border border-[#326273]/15 bg-white p-4" aria-live="polite">
        <div className="flex items-center gap-3">
          <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${waiting ? 'bg-[var(--gold-tint)] text-[#0c3e48]' : 'bg-[var(--ok-bg)] text-[#145d6a]'}`}>
            {waiting ? <Clock3 className="h-5 w-5" aria-hidden="true" /> : <Check className="h-5 w-5" aria-hidden="true" />}
          </span>
          <div>
            <p className="text-sm font-bold text-[#0c3e48]">{status === 'arrived' ? 'Your funds have arrived' : status === 'arriving' ? 'Funds are arriving and being checked' : status === 'failed' || status === 'expired' || status === 'cancelled' ? 'This top-up did not complete' : 'Waiting for your funds'}</p>
            <p className="text-[13px] text-[#326273]">We keep this draft. When the funds clear their checks, the rate is quoted and the payment goes to approval.</p>
          </div>
        </div>
        {intent?.destination && waiting && (instr.kind === 'wallet' || intent.destination) ? (
          <div className="rounded-xl bg-[#F6F0ED] p-3 text-[13px] text-[#1F4452]">
            <p className="font-semibold">Send USDC on Sui to your Splash Wallet</p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="min-w-0 break-all font-mono text-[12px]">{intent.destination}</code>
              <button
                type="button"
                aria-label="Copy the wallet address"
                onClick={() => {
                  void navigator.clipboard?.writeText(intent.destination).then(() => setCopied(true));
                }}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[#326273]/20 bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]"
              >
                {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
              </button>
            </div>
          </div>
        ) : null}
        {intent?.progress ? <p className="text-[13px] text-[#326273]">Cleared {formatUsdc(BigInt(intent.progress.clearedMinor))} of at least {formatUsdc(BigInt(intent.progress.expectedMinMinor))} USDC{BigInt(intent.progress.heldMinor) > 0n ? `; ${formatUsdc(BigInt(intent.progress.heldMinor))} is held until its source is checked` : ''}.</p> : null}
      </div>
    );
  }

  const verified = options.sources.filter((s) => s.status === 'verified');
  const checking = options.sources.filter((s) => s.status === 'pending');
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-extrabold text-[#0c3e48]">Top up {formatUsdc(need)} USDC to continue</h3>
        <p className="mt-0.5 text-[13px] text-[#326273]">Funds arrive in your Splash Wallet first, then this payment goes on.</p>
      </div>
      {verified.length === 0 ? (
        <p className="rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] p-4 text-sm leading-6 text-[#1F4452]">
          You have no verified funding source yet. Add a bank account in your company&rsquo;s name, a card, or a wallet you prove you control, in Wallet. It is checked once; your draft is kept here.
        </p>
      ) : (
        <div role="radiogroup" aria-label="Pay the top-up from" className="grid gap-2">
          {verified.map((s) => {
            const on = s.id === sourceId;
            const ok = options ? routeFor(s, options) !== null : false;
            const Icon = s.kind === 'card' ? CreditCard : s.kind === 'wallet' ? Wallet : Banknote;
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!ok}
                onClick={() => {
                  setSourceId(s.id);
                  setQuote(null);
                }}
                className={`flex min-h-[64px] items-center gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] disabled:cursor-not-allowed disabled:opacity-60 ${on ? 'border-[#0d6370] bg-[#f4f8fa] shadow-[inset_3px_0_0_#0d6370]' : 'border-[#326273]/20 bg-white hover:border-[#0d6370]/60'}`}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#eef4f5] text-[#145d6a]"><Icon className="h-4 w-4" aria-hidden="true" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-[#0c3e48]">{s.label}{s.last4 ? ` ••${s.last4}` : ''}</span>
                  <span className="block text-[13px] text-[#326273]">{ok ? 'Verified source' : 'Add funds from Wallet to use this source'}</span>
                </span>
                <span className="rounded-full bg-[var(--ok-bg)] px-2.5 py-1 text-[12px] font-semibold text-[#145d6a]">Verified</span>
              </button>
            );
          })}
        </div>
      )}
      {checking.length > 0 ? <p className="text-[13px] text-[#326273]">{checking.map((s) => `${s.label}${s.last4 ? ` ••${s.last4}` : ''}`).join(', ')}: checking. It can be used once its first deposit has been checked.</p> : null}

      {quote ? (
        <div className="rounded-xl border border-[#326273]/15 bg-white p-4 text-sm text-[#1F4452]" aria-live="polite">
          <p className="font-bold text-[#0c3e48]">At least {formatUsdc(BigInt(quote.arrivesMinMinor))} USDC arrives</p>
          <ul className="mt-2 space-y-1 text-[13px]">
            {quote.lines.map((l, i) => (
              <li key={`${l.label}-${i}`} className="flex justify-between gap-3"><span>{l.label}</span><span className="font-mono">{formatUsdc(BigInt(l.amountMinor))} USDC</span></li>
            ))}
          </ul>
          <p className="mt-2 text-[13px] text-[#326273]">Any fee here is the funding partner&rsquo;s own. Splash adds none to a top-up.</p>
        </div>
      ) : null}
      {error ? <p role="alert" className="flex items-start gap-2 text-sm font-medium text-[var(--error)]"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {quote ? (
          <PrimaryButton type="button" disabled={busy} onClick={() => void confirm()}>{busy ? 'Starting…' : 'Top up and continue'}</PrimaryButton>
        ) : (
          <PrimaryButton type="button" disabled={busy || !source || !route} onClick={() => void showQuote()}>{busy ? 'Getting the quote…' : 'Top up and continue'}</PrimaryButton>
        )}
        {quote ? <QuietButton type="button" onClick={() => setQuote(null)}>Change source</QuietButton> : null}
      </div>
    </div>
  );
}
