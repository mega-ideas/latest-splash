'use client';

import { useState } from 'react';
import { Building2, Hash, Mail, MapPin, Wallet } from 'lucide-react';

import { call, errorText, type SavedRecipient } from '@/components/transfer/api';
import { Field, PrimaryButton, QuietButton, SelectInput, TextInput } from '@/components/transfer/ui';
import { checkPayeeField, CROSS_CHAIN_PICKS, crossChainLabel } from '@/lib/transfer/addresses';
import { EXCHANGE_OPTIONS } from '@/lib/transfer/payee';

export type WalletKind = 'EXCHANGE' | 'SELF_CUSTODY' | 'CROSS_CHAIN';

type Form = {
  legalName: string;
  registrationNumber: string;
  country: string;
  addressLine1: string;
  addressCity: string;
  email: string;
  exchange: string;
  walletLabel: string;
  chain: string;
  address: string;
  tokenAccount: boolean;
};
const BLANK: Form = { legalName: '', registrationNumber: '', country: '', addressLine1: '', addressCity: '', email: '', exchange: EXCHANGE_OPTIONS[0].id, walletLabel: 'SLUSH', chain: 'ETHEREUM', address: '', tokenAccount: false };

/**
 * Who receives it, and where: the form that saves an exchange account, a wallet
 * the supplier holds, or an address on another chain. It is used by Transfer
 * (step 2) and by Recipients, so the two cannot disagree about what is asked
 * or checked. The address is checked and normalised here and again, with the
 * screening, on the server; nothing is saved until both pass.
 */
export default function WalletRecipientForm({ kind, onSaved, onCancel }: { kind: WalletKind; onSaved: (record: SavedRecipient) => void; onCancel: () => void }) {
  const [form, setForm] = useState<Form>(BLANK);
  const [errors, setErrors] = useState<Partial<Record<keyof Form | 'form', string>>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    const next: typeof errors = {};
    if (form.legalName.trim().length < 2) next.legalName = "Enter the supplier's registered business name.";
    if (!form.registrationNumber.trim()) next.registrationNumber = "Enter the supplier's company registration number.";
    if (!/^[A-Za-z]{2}$/.test(form.country.trim())) next.country = 'Enter the country as two letters, for example PH.';
    if (!form.addressLine1.trim()) next.addressLine1 = "Enter the supplier's registered address.";
    if (!form.addressCity.trim()) next.addressCity = 'Enter the town or city.';
    const field = checkPayeeField(kind === 'CROSS_CHAIN' ? 'cross_chain' : kind === 'EXCHANGE' ? 'exchange' : 'sui_wallet', form.address, { chain: form.chain });
    if (!field.ok) next.address = field.message;
    if (kind === 'CROSS_CHAIN' && form.chain === 'SOLANA' && !form.tokenAccount) next.address = "For Solana, give the supplier's USDC token account (not their wallet address) and confirm that is what it is.";
    setErrors(next);
    if (Object.keys(next).length > 0 || !field.ok) return;
    setBusy(true);
    const answer = await call<SavedRecipient & { error?: string }>('/api/recipients', {
      body: {
        deliveryKind: kind,
        legalName: form.legalName.trim(),
        name: form.legalName.trim(),
        registrationNumber: form.registrationNumber.trim(),
        country: form.country.trim().toUpperCase(),
        addressLine1: form.addressLine1.trim(),
        addressCity: form.addressCity.trim(),
        email: form.email.trim() || undefined,
        asset: 'USDC',
        ...(kind === 'EXCHANGE' ? { exchange: form.exchange, network: 'SUI', depositAddress: field.address } : {}),
        ...(kind === 'SELF_CUSTODY' ? { walletLabel: form.walletLabel, address: field.address } : {}),
        ...(kind === 'CROSS_CHAIN' ? { chain: form.chain, address: field.address, addressIsUsdcTokenAccount: form.chain === 'SOLANA' ? true : undefined } : {}),
      },
    });
    setBusy(false);
    if (!answer.ok || !answer.body) {
      setErrors({ form: errorText(answer, 'The recipient could not be saved. Nothing was sent.') });
      return;
    }
    setErrors({});
    setForm(BLANK);
    onSaved({ ...answer.body, delivery: answer.body.delivery ?? { deliveryKind: kind, ownershipStatus: kind === 'SELF_CUSTODY' ? 'unproven' : null } });
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="space-y-4 rounded-2xl border border-[#326273]/15 bg-white p-4 sm:p-5"
    >
      <h3 className="text-base font-extrabold text-[#0c3e48]">Who receives it</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Registered business name" error={errors.legalName} htmlFor="w-name" className="sm:col-span-2">
          <TextInput id="w-name" icon={Building2} value={form.legalName} onChange={(e) => set('legalName', e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Company registration number" error={errors.registrationNumber} htmlFor="w-reg">
          <TextInput id="w-reg" icon={Hash} value={form.registrationNumber} onChange={(e) => set('registrationNumber', e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Country" error={errors.country} hint="Two letters" htmlFor="w-country">
          <TextInput id="w-country" icon={MapPin} maxLength={2} value={form.country} onChange={(e) => set('country', e.target.value.toUpperCase())} autoComplete="off" />
        </Field>
        <Field label="Registered address" error={errors.addressLine1} htmlFor="w-addr" className="sm:col-span-2">
          <TextInput id="w-addr" icon={MapPin} value={form.addressLine1} onChange={(e) => set('addressLine1', e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Town or city" error={errors.addressCity} htmlFor="w-city">
          <TextInput id="w-city" icon={MapPin} value={form.addressCity} onChange={(e) => set('addressCity', e.target.value)} autoComplete="off" />
        </Field>
        {kind === 'SELF_CUSTODY' ? (
          <Field label="Their email" hint="For the proof link" htmlFor="w-mail">
            <TextInput id="w-mail" icon={Mail} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} autoComplete="off" />
          </Field>
        ) : null}
        {kind === 'EXCHANGE' ? (
          <Field label="Exchange" htmlFor="w-ex">
            <SelectInput id="w-ex" value={form.exchange} onChange={(e) => set('exchange', e.target.value)}>
              {EXCHANGE_OPTIONS.map((x) => (
                <option key={x.id} value={x.id}>{x.label}</option>
              ))}
            </SelectInput>
          </Field>
        ) : null}
        {kind === 'SELF_CUSTODY' ? (
          <Field label="Their wallet app" hint="A label only" htmlFor="w-app">
            <SelectInput id="w-app" value={form.walletLabel} onChange={(e) => set('walletLabel', e.target.value)}>
              <option value="SLUSH">Slush</option>
              <option value="METAMASK_SUI_SNAP">MetaMask (Sui Snap)</option>
              <option value="BACKPACK">Backpack</option>
              <option value="OTHER">Another wallet</option>
            </SelectInput>
          </Field>
        ) : null}
        {kind === 'CROSS_CHAIN' ? (
          <Field label="Chain" htmlFor="w-chain">
            <SelectInput id="w-chain" value={form.chain} onChange={(e) => set('chain', e.target.value)}>
              {CROSS_CHAIN_PICKS.map((c) => (
                <option key={c} value={c}>{crossChainLabel(c)}</option>
              ))}
            </SelectInput>
          </Field>
        ) : null}
        <Field
          label={kind === 'CROSS_CHAIN' ? (form.chain === 'SOLANA' ? 'USDC token account' : 'Address on that chain') : kind === 'EXCHANGE' ? 'Deposit address on Sui' : 'Sui wallet address'}
          error={errors.address}
          htmlFor="w-address"
          className="sm:col-span-2"
        >
          <TextInput id="w-address" icon={Wallet} mono value={form.address} onChange={(e) => set('address', e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        {kind === 'CROSS_CHAIN' && form.chain === 'SOLANA' ? (
          <label className="flex min-h-11 items-start gap-3 text-sm text-[#1F4452] sm:col-span-2">
            <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[#0d6370]" checked={form.tokenAccount} onChange={(e) => set('tokenAccount', e.target.checked)} />
            <span>This is the supplier&rsquo;s USDC token account, not their wallet address.</span>
          </label>
        ) : null}
      </div>
      {errors.form ? <p role="alert" className="text-sm font-medium text-[var(--error)]">{errors.form}</p> : null}
      <div className="flex flex-wrap gap-2">
        <PrimaryButton type="submit" disabled={busy}>{busy ? 'Checking the address…' : 'Check and save'}</PrimaryButton>
        <QuietButton type="button" onClick={onCancel}>Cancel</QuietButton>
      </div>
      <p className="text-[13px] leading-5 text-[#326273]">The address is screened before it is saved. A payment on Sui is final once it is sent, so check it against what the supplier gave you.</p>
    </form>
  );
}
