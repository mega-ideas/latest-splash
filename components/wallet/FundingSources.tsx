'use client';

import { useState } from 'react';
import { Banknote, CreditCard, Plus, Wallet } from 'lucide-react';

import { call, errorText } from '@/components/transfer/api';
import { Field, PrimaryButton, QuietButton, Segmented, SelectInput, TextInput } from '@/components/transfer/ui';
import { sourceLine } from '@/lib/wallet-page/labels';
import { connectWallet, describeSignError, discoverWallets, signMessageWithWallet, type AcceptedWallet } from '@/lib/wallet/sui-signers';
import { Card, Note, Pill } from './parts';
import type { FundingOptions, FundingSource } from './types';

const ICON = { bank_account: Banknote, card: CreditCard, wallet: Wallet } as const;
const COUNTRIES = [['MY', 'Malaysia'], ['PH', 'the Philippines'], ['ID', 'Indonesia'], ['SG', 'Singapore'], ['TH', 'Thailand'], ['VN', 'Vietnam']] as const;

/**
 * Funding sources (v2 brief 4.3, 5.5): where the business's money may come
 * from. A bank account in the company's name or a card is checked once, on its
 * first deposit; a wallet is proven with a signature. Money from a source that
 * is not verified is held, not spent. Owners add and prove sources.
 */
export default function FundingSources({ funding, owner, onChanged }: { funding: FundingOptions; owner: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [proving, setProving] = useState<FundingSource | null>(null);

  const verified = funding.sources.filter((s) => s.status === 'verified').length;
  return (
    <Card
      id="funding-sources"
      title="Funding sources"
      aside={owner && !adding ? <QuietButton type="button" onClick={() => setAdding(true)}><Plus className="h-4 w-4" aria-hidden="true" />Add a source</QuietButton> : null}
    >
      <p className="mb-3 text-[13px] leading-5 text-[#326273]">
        Money from a source your business has not verified is held and not spent. {verified === 0 ? 'You have no verified source yet.' : `${verified} verified.`}
      </p>
      {funding.sources.length === 0 && !adding ? (
        <Note tone="warn">{owner ? 'Add a bank account in your company’s name, or a wallet you can prove you control.' : 'Ask an owner to add a funding source.'}</Note>
      ) : (
        <ul className="space-y-2">
          {funding.sources.map((s) => {
            const line = sourceLine(s);
            const Icon = ICON[s.kind] ?? Wallet;
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-[#326273]/15 bg-white p-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#eef4f5] text-[#145d6a]"><Icon className="h-4 w-4" aria-hidden="true" /></span>
                <span className="min-w-0 flex-1 basis-40">
                  <span className="block truncate text-sm font-bold text-[#0c3e48]">{line.name}</span>
                  <span className="block text-[13px] text-[#326273]">{line.kindLabel}{line.next ? `. ${line.next}` : ''}</span>
                </span>
                <Pill tone={line.tone}>{line.state}</Pill>
                {owner && s.kind === 'wallet' && s.status === 'pending' ? (
                  <QuietButton type="button" onClick={() => setProving(s)}>Prove it</QuietButton>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {adding ? <AddSource onClose={() => setAdding(false)} onAdded={() => { setAdding(false); onChanged(); }} /> : null}
      {proving ? <ProveWallet source={proving} onClose={() => setProving(null)} onProven={() => { setProving(null); onChanged(); }} /> : null}
    </Card>
  );
}

function AddSource({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [kind, setKind] = useState<'bank_account' | 'wallet'>('bank_account');
  const [f, setF] = useState({ holderName: '', country: 'MY', bankCode: '', accountNumber: '', label: '', chain: 'SUI', address: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((cur) => ({ ...cur, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    setError(null);
    const body = kind === 'bank_account'
      ? { kind, holderName: f.holderName.trim(), country: f.country, bankCode: f.bankCode.trim(), accountNumber: f.accountNumber.trim(), label: f.label.trim() }
      : { kind, chain: f.chain, address: f.address.trim(), label: f.label.trim() };
    const answer = await call('/api/wallet/funding/sources', { body });
    setBusy(false);
    if (!answer.ok) {
      setError(errorText(answer, 'The source was not added.'));
      return;
    }
    onAdded();
  }

  return (
    <div className="mt-4 space-y-3 rounded-xl border border-[#326273]/15 bg-[#f4f8fa] p-4">
      <Segmented label="Kind of source" value={kind} onChange={setKind} options={[{ value: 'bank_account', label: 'Bank account' }, { value: 'wallet', label: 'Wallet' }]} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name for this source" htmlFor="fs-label"><TextInput id="fs-label" value={f.label} onChange={set('label')} placeholder={kind === 'wallet' ? 'Treasury wallet' : 'Operating account'} maxLength={60} /></Field>
        {kind === 'bank_account' ? (
          <>
            <Field label="Name on the account" hint="Your company’s registered name" htmlFor="fs-holder"><TextInput id="fs-holder" value={f.holderName} onChange={set('holderName')} autoComplete="organization" /></Field>
            <Field label="Country" htmlFor="fs-country">
              <SelectInput id="fs-country" value={f.country} onChange={set('country')}>
                {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </SelectInput>
            </Field>
            <Field label="Bank code" htmlFor="fs-bank"><TextInput id="fs-bank" value={f.bankCode} onChange={set('bankCode')} mono /></Field>
            <Field label="Account number" hint="Only the last four digits are kept" htmlFor="fs-number"><TextInput id="fs-number" value={f.accountNumber} onChange={set('accountNumber')} inputMode="numeric" autoComplete="off" mono /></Field>
          </>
        ) : (
          <>
            <Field label="Network" htmlFor="fs-chain">
              <SelectInput id="fs-chain" value={f.chain} onChange={set('chain')}>
                <option value="SUI">Sui</option>
                <option value="SOLANA">Solana</option>
                <option value="EVM">Ethereum and other EVM chains</option>
              </SelectInput>
            </Field>
            <Field label="Wallet address" htmlFor="fs-address" className="sm:col-span-2"><TextInput id="fs-address" value={f.address} onChange={set('address')} mono spellCheck={false} autoComplete="off" /></Field>
          </>
        )}
      </div>
      {kind === 'wallet' ? <Note>Slush, MetaMask, Phantom and Backpack are only the app that holds the wallet. You prove you control it by signing a message with it.</Note> : <Note>A bank account must be in your company&rsquo;s name. It is checked once, against the first deposit.</Note>}
      {error ? <Note tone="error">{error}</Note> : null}
      <div className="flex flex-wrap gap-2">
        <PrimaryButton type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Adding…' : 'Add this source'}</PrimaryButton>
        <QuietButton type="button" onClick={onClose}>Cancel</QuietButton>
      </div>
    </div>
  );
}

function ProveWallet({ source, onClose, onProven }: { source: FundingSource; onClose: () => void; onProven: () => void }) {
  const [challenge, setChallenge] = useState<{ id: string; message: string; expiresAt: string } | null>(null);
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wallets, setWallets] = useState<AcceptedWallet[] | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    const answer = await call<{ challenge?: { id: string; message: string; expiresAt: string } }>(`/api/wallet/funding/sources/${encodeURIComponent(source.id)}/challenge`, { method: 'POST', body: {} });
    if (!answer.ok || !answer.body?.challenge) {
      setBusy(false);
      setError(errorText(answer, 'The message could not be prepared.'));
      return;
    }
    setChallenge(answer.body.challenge);
    if (source.chain === 'SUI') setWallets(await discoverWallets());
    setBusy(false);
  }

  async function verify(sig: string) {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    const answer = await call(`/api/wallet/funding/sources/${encodeURIComponent(source.id)}/verify`, { body: { challengeId: challenge.id, signature: sig.trim() } });
    setBusy(false);
    if (!answer.ok) {
      setError(errorText(answer, 'That signature did not prove the wallet. Ask for a new message and try again.'));
      setChallenge(null);
      return;
    }
    onProven();
  }

  async function signWith(accepted: AcceptedWallet) {
    if (!challenge) return;
    setError(null);
    try {
      const account = await connectWallet(accepted);
      if (source.address && account.address.toLowerCase() !== source.address.toLowerCase()) {
        setError('That is not the wallet you added. Choose the account with the address you added.');
        return;
      }
      await verify(await signMessageWithWallet(accepted, account, challenge.message));
    } catch (e) {
      setError(describeSignError(e));
    }
  }

  return (
    <div className="mt-4 space-y-3 rounded-xl border border-[#326273]/15 bg-[#f4f8fa] p-4" aria-live="polite">
      <h3 className="text-sm font-extrabold text-[#0c3e48]">Prove you control {source.label}</h3>
      {!challenge ? (
        <>
          <Note>Splash gives you a short message. You sign it with this wallet; nothing is sent from the wallet and no money moves. The message works once and lapses after 15 minutes.</Note>
          {error ? <Note tone="error">{error}</Note> : null}
          <div className="flex flex-wrap gap-2">
            <PrimaryButton type="button" disabled={busy} onClick={() => void start()}>{busy ? 'Preparing…' : 'Get the message'}</PrimaryButton>
            <QuietButton type="button" onClick={onClose}>Cancel</QuietButton>
          </div>
        </>
      ) : (
        <>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white p-3 font-mono text-[12px] leading-5 text-[#0c3e48]">{challenge.message}</pre>
          {wallets && wallets.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {wallets.map((w) => <QuietButton key={w.kind} type="button" disabled={busy} onClick={() => void signWith(w)}>Sign with {w.label}</QuietButton>)}
            </div>
          ) : null}
          <Field label="Or paste the signature" hint={source.chain === 'SUI' ? 'From your wallet' : 'Signed with this wallet'} htmlFor="fs-sig">
            <TextInput id="fs-sig" value={signature} onChange={(e) => setSignature(e.target.value)} mono spellCheck={false} autoComplete="off" />
          </Field>
          {error ? <Note tone="error">{error}</Note> : null}
          <div className="flex flex-wrap gap-2">
            <PrimaryButton type="button" disabled={busy || signature.trim().length < 20} onClick={() => void verify(signature)}>{busy ? 'Checking…' : 'Check the signature'}</PrimaryButton>
            <QuietButton type="button" onClick={onClose}>Cancel</QuietButton>
          </div>
        </>
      )}
    </div>
  );
}
