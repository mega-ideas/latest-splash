'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Clock3, ExternalLink } from 'lucide-react';

import { call, errorText } from '@/components/transfer/api';
import { Field, PrimaryButton, QuietButton, Segmented, SelectInput, TextInput } from '@/components/transfer/ui';
import { formatUsdc } from '@/lib/fees/copy';
import { Address, Card, CopyButton, Note, newKey } from './parts';
import type { FundingOptions } from './types';

type Channel = 'provider' | 'wallet' | 'cctp';
type QuoteLine = { payee: string; label: string; amountMinor: string };
type FundingQuote = { arrivesMinMinor: string; lines: QuoteLine[]; expiresAt: string | null; sandbox: boolean };
type Intent = {
  id: string;
  status: string;
  destination: string;
  instructions: { kind?: string; next?: { kind?: string; url?: string; reference?: string; note?: string }; sandbox?: boolean } | null;
  progress?: { expectedMinMinor: string; clearedMinor: string; heldMinor: string };
};

const AMOUNT = /^\d{1,9}(\.\d{1,6})?$/;
const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const DONE = ['arrived', 'failed', 'expired', 'cancelled'];

/** A link the partner gave us is followed only if it is https, or a path on this site. */
function safeLink(url: string | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Add funds (v2 brief 4.3, 5.5): one interface, many providers. Every way in
 * delivers to the business wallet the business account names on chain; the
 * page never names the destination. The quote is shown first, and a top-up
 * is made only at a quote the person saw (`acceptedArrivesMinMinor`).
 * Anything that arrives is screened; held money is not spent.
 */
export default function AddFunds({ funding, canAdd, onChanged }: { funding: FundingOptions; canAdd: boolean; onChanged: () => void }) {
  const providers = funding.channels.provider;
  const [channel, setChannel] = useState<Channel>('provider');
  const [providerId, setProviderId] = useState(providers.find((p) => p.available)?.id ?? providers[0]?.id ?? '');
  const provider = providers.find((p) => p.id === providerId) ?? null;
  const [method, setMethod] = useState<'bank' | 'card'>('bank');
  const [sourceId, setSourceId] = useState('');
  const [chain, setChain] = useState(funding.channels.cctp.chains[0]?.chain ?? '');
  const [speed, setSpeed] = useState<'standard' | 'fast'>('standard');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<FundingQuote | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per attempt: a retry after a dropped answer is the same top-up, never a second one.
  const key = useRef<string | null>(null);
  const arrived = useRef(false);

  const sourcesOfKind = funding.sources.filter((s) => s.status === 'verified' && s.kind === (method === 'card' ? 'card' : 'bank_account'));
  const valid = AMOUNT.test(amount.trim()) && Number(amount) > 0;

  const route = useCallback((): Record<string, string> => {
    if (channel === 'provider') return { channel, provider: providerId, method, ...(sourceId ? { sourceId } : {}) };
    if (channel === 'cctp') return { channel, asset: 'USDC', sourceChain: chain, speed };
    return { channel, asset: 'USDC' };
  }, [channel, providerId, method, sourceId, chain, speed]);

  const poll = useCallback(
    async (id: string) => {
      const answer = await call<{ intent?: Intent }>(`/api/wallet/funding/intents/${encodeURIComponent(id)}`);
      if (!answer.body?.intent) return;
      setIntent(answer.body.intent);
      if (answer.body.intent.status === 'arrived' && !arrived.current) {
        arrived.current = true;
        onChanged();
      }
    },
    [onChanged],
  );

  useEffect(() => {
    if (!intent || DONE.includes(intent.status)) return;
    const timer = window.setInterval(() => void poll(intent.id), 5000);
    return () => window.clearInterval(timer);
  }, [intent, poll]);

  function reset() {
    setQuote(null);
    setIntent(null);
    setError(null);
    key.current = null;
    arrived.current = false;
  }

  async function showQuote() {
    setBusy(true);
    setError(null);
    const answer = await call<{ quote?: FundingQuote }>('/api/wallet/funding/quotes', { body: { ...route(), amount: amount.trim() } });
    setBusy(false);
    if (!answer.ok || !answer.body?.quote) {
      setQuote(null);
      setError(errorText(answer, 'There is no quote for that right now.'));
      return;
    }
    setQuote(answer.body.quote);
    if (!key.current) key.current = newKey('top');
  }

  async function start() {
    if (!quote || !key.current) return;
    setBusy(true);
    setError(null);
    const answer = await call<{ intent?: Intent; quote?: FundingQuote }>('/api/wallet/funding/intents', { key: key.current, body: { ...route(), amount: amount.trim(), acceptedArrivesMinMinor: quote.arrivesMinMinor } });
    setBusy(false);
    if (!answer.ok || !answer.body?.intent) {
      // A worse quote than the one shown comes back to look at; nothing was made.
      if (answer.body?.quote) setQuote(answer.body.quote);
      setError(errorText(answer, 'The top-up was not started. Nothing was charged.'));
      return;
    }
    setIntent(answer.body.intent);
    onChanged();
  }

  const noSource = channel === 'provider' && sourcesOfKind.length === 0;
  return (
    <Card id="top-up" title="Add funds">
      {!canAdd ? <Note tone="warn">Viewers cannot add funds. Ask an owner.</Note> : (
        <div className="space-y-4">
          <Segmented
            label="How to add funds"
            value={channel}
            onChange={(c) => { setChannel(c); reset(); }}
            options={[{ value: 'provider', label: 'Bank or card' }, { value: 'wallet', label: 'Sui wallet' }, { value: 'cctp', label: 'Another chain' }]}
          />

          {channel === 'wallet' ? <WalletDeposit funding={funding} onChanged={onChanged} /> : (
            <div className="space-y-3">
              {channel === 'provider' ? (
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Funding partner" htmlFor="af-provider">
                    <SelectInput id="af-provider" value={providerId} onChange={(e) => { setProviderId(e.target.value); reset(); }}>
                      {providers.map((p) => <option key={p.id} value={p.id} disabled={!p.available}>{p.label}{p.available ? '' : ' (not available)'}</option>)}
                    </SelectInput>
                  </Field>
                  <Field label="Pay by" htmlFor="af-method">
                    <SelectInput id="af-method" value={method} onChange={(e) => { setMethod(e.target.value as 'bank' | 'card'); setSourceId(''); reset(); }}>
                      <option value="bank">Bank transfer</option>
                      <option value="card">Card</option>
                    </SelectInput>
                  </Field>
                  <Field label="From your source" htmlFor="af-source">
                    <SelectInput id="af-source" value={sourceId} onChange={(e) => { setSourceId(e.target.value); reset(); }}>
                      <option value="">Choose a verified source</option>
                      {sourcesOfKind.map((s) => <option key={s.id} value={s.id}>{s.label}{s.last4 ? ` ••${s.last4}` : ''}</option>)}
                    </SelectInput>
                  </Field>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Send from" htmlFor="af-chain">
                    <SelectInput id="af-chain" value={chain} onChange={(e) => { setChain(e.target.value); reset(); }}>
                      {funding.channels.cctp.chains.map((c) => <option key={c.chain} value={c.chain}>{c.label}</option>)}
                    </SelectInput>
                  </Field>
                  <Field label="Speed" htmlFor="af-speed">
                    <SelectInput id="af-speed" value={speed} onChange={(e) => { setSpeed(e.target.value as 'standard' | 'fast'); reset(); }}>
                      <option value="standard">Standard</option>
                      {funding.channels.cctp.chains.find((c) => c.chain === chain)?.fast ? <option value="fast">Fast (Circle charges a fee)</option> : null}
                    </SelectInput>
                  </Field>
                </div>
              )}
              {channel === 'provider' && provider && !provider.available ? <Note tone="warn">{provider.reason ?? 'This partner is not available.'}</Note> : null}
              {noSource ? <Note tone="warn">Add and verify {method === 'card' ? 'a card' : 'a bank account in your company’s name'} under Funding sources first. Money from an unverified source is held.</Note> : null}
              {!intent ? (
                <>
                  <Field label="Amount to arrive" hint="USDC" htmlFor="af-amount">
                    <TextInput id="af-amount" value={amount} onChange={(e) => { setAmount(e.target.value.replace(/[^\d.]/g, '')); setQuote(null); }} inputMode="decimal" mono placeholder="1,000.00" autoComplete="off" />
                  </Field>
                  {quote ? (
                    <div className="rounded-xl border border-[#326273]/15 bg-white p-4 text-sm text-[#1F4452]" aria-live="polite">
                      <p className="font-bold text-[#0c3e48]">At least {formatUsdc(BigInt(quote.arrivesMinMinor))} USDC arrives</p>
                      {quote.lines.length > 0 ? (
                        <ul className="mt-2 space-y-1 text-[13px]">
                          {quote.lines.map((l, i) => <li key={`${l.label}-${i}`} className="flex justify-between gap-3"><span>{l.label}</span><span className="font-mono">{formatUsdc(BigInt(l.amountMinor))} USDC</span></li>)}
                        </ul>
                      ) : null}
                      <p className="mt-2 text-[13px] text-[#326273]">Any fee here is the {channel === 'cctp' ? 'network’s' : 'funding partner’s'} own. Splash adds none to a top-up.{quote.sandbox ? ' This quote is from a sandbox.' : ''}</p>
                    </div>
                  ) : null}
                  {error ? <Note tone="error">{error}</Note> : null}
                  <div className="flex flex-wrap gap-2">
                    {quote ? (
                      <>
                        <PrimaryButton type="button" disabled={busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Start this top-up'}</PrimaryButton>
                        <QuietButton type="button" onClick={() => setQuote(null)}>Change</QuietButton>
                      </>
                    ) : (
                      <PrimaryButton type="button" disabled={busy || !valid || noSource || (channel === 'provider' && (!provider?.available || !sourceId))} onClick={() => void showQuote()}>{busy ? 'Getting the quote…' : 'Get a quote'}</PrimaryButton>
                    )}
                  </div>
                </>
              ) : (
                <IntentProgress intent={intent} onAnother={reset} />
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function IntentProgress({ intent, onAnother }: { intent: Intent; onAnother: () => void }) {
  const done = intent.status === 'arrived';
  const dead = ['failed', 'expired', 'cancelled'].includes(intent.status);
  const next = intent.instructions?.next;
  const link = next?.kind === 'redirect' ? safeLink(next.url) : null;
  return (
    <div className="space-y-3 rounded-xl border border-[#326273]/15 bg-white p-4" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${done ? 'bg-[var(--ok-bg)] text-[#145d6a]' : dead ? 'bg-[var(--error-bg)] text-[var(--error)]' : 'bg-[var(--warn-bg)] text-[var(--warn-ink)]'}`}>
          {done ? <Check className="h-5 w-5" aria-hidden="true" /> : <Clock3 className="h-5 w-5" aria-hidden="true" />}
        </span>
        <p className="text-sm font-bold text-[#0c3e48]">
          {done ? 'Your funds have arrived' : dead ? 'This top-up did not complete' : intent.status === 'arriving' ? 'Funds are arriving and being checked' : 'Waiting for your funds'}
        </p>
      </div>
      {!done && !dead ? (
        <div className="space-y-2 text-[13px] text-[#1F4452]">
          {next?.kind === 'bank_transfer' ? <p>Pay by bank transfer using this reference: <code className="font-mono font-semibold">{next.reference}</code>. {next.note}</p> : null}
          {link ? <a href={link} rel="noreferrer" className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-[var(--info)] underline underline-offset-2">Continue to payment<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /></a> : null}
          {intent.instructions?.kind === 'cctp' ? <p>Burn USDC on the other chain with Circle&rsquo;s CCTP V2 and name this wallet as the recipient of the mint:</p> : null}
          {intent.instructions?.kind === 'cctp' ? <div className="flex items-center gap-2"><Address value={intent.destination} /><CopyButton value={intent.destination} label="Copy the wallet address" /></div> : null}
        </div>
      ) : null}
      {intent.progress ? (
        <p className="text-[13px] text-[#326273]">
          Cleared {formatUsdc(BigInt(intent.progress.clearedMinor))} of at least {formatUsdc(BigInt(intent.progress.expectedMinMinor))} USDC
          {BigInt(intent.progress.heldMinor) > 0n ? `; ${formatUsdc(BigInt(intent.progress.heldMinor))} is held until its source is checked` : ''}.
        </p>
      ) : null}
      <QuietButton type="button" onClick={onAnother}>{done || dead ? 'Add more funds' : 'Start over'}</QuietButton>
    </div>
  );
}

function WalletDeposit({ funding, onChanged }: { funding: FundingOptions; onChanged: () => void }) {
  const [digest, setDigest] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'plain' | 'error'; text: string } | null>(null);
  const assets = funding.channels.wallet.assets;
  const converts = assets.filter((a) => a.converts).map((a) => (a.asset === 'USDSUI' ? 'USDsui' : a.asset));

  async function record() {
    setBusy(true);
    setNote(null);
    const answer = await call<{ deposits?: Array<{ status: string }> }>('/api/wallet/funding/deposits', { body: { digest: digest.trim() } });
    setBusy(false);
    if (!answer.ok) {
      setNote({ tone: 'error', text: errorText(answer, 'That transaction could not be read.') });
      return;
    }
    const held = answer.body?.deposits?.some((d) => d.status !== 'cleared');
    setNote({ tone: 'plain', text: held ? 'We found it. It is held until its source is checked; see the funding history.' : 'We found it and it is ready to use.' });
    setDigest('');
    onChanged();
  }

  return (
    <div className="space-y-3">
      <p className="text-sm leading-6 text-[#1F4452]">
        Send <strong>USDC on Sui</strong> from any Sui wallet (Slush, MetaMask with the Sui Snap, Phantom or Backpack are only labels) or from an exchange, to your business wallet:
      </p>
      <div className="flex items-center gap-2 rounded-xl bg-[#F6F0ED]/70 p-3">
        <Address value={funding.channels.wallet.address} />
        <CopyButton value={funding.channels.wallet.address} label="Copy the wallet address" />
      </div>
      {converts.length > 0 ? <Note>{converts.join(' and ')} also arrive. They are not counted as USDC and stay in your wallet as they are.</Note> : null}
      <Note>Everything that arrives is screened. Money from a funding source you have not verified is held, not spent.</Note>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field label="Already sent it? Paste the transaction digest" htmlFor="af-digest" hint="We read the amount from the chain">
          <TextInput id="af-digest" value={digest} onChange={(e) => setDigest(e.target.value.trim())} mono spellCheck={false} autoComplete="off" />
        </Field>
        <PrimaryButton type="button" disabled={busy || !DIGEST.test(digest)} onClick={() => void record()}>{busy ? 'Reading…' : 'Look for it'}</PrimaryButton>
      </div>
      {note ? <Note tone={note.tone}>{note.text}</Note> : null}
    </div>
  );
}
