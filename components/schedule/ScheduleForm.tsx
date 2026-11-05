'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, Plus, Trash2 } from 'lucide-react';

import { call, errorText, type SavedRecipient } from '@/components/transfer/api';
import { Field, Modal, PrimaryButton, QuietButton, Segmented, SelectInput, TextInput } from '@/components/transfer/ui';
import { newKey, Note } from '@/components/wallet/parts';
import { formatUsdc } from '@/lib/fees/copy';
import { ASK_MIN_LEAD_MS, AUTO_MIN_LEAD_MS, CADENCE_WORDS, MODE_WORDS, SCHEDULE_MAX_ITEMS, graceWords, type Cadence, type ScheduleMode } from '@/lib/schedule/rules';
import type { ScheduleView } from '@/lib/schedule/views';
import { parseAmountMinor } from '@/lib/transfer/plan';

type Row = { key: number; recipientId: string; amount: string; reference: string };

const pad = (n: number) => String(n).padStart(2, '0');
/** The value a datetime-local input takes: the person's own clock. */
const inputValue = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Minor units as the amount text a person edits: "750.5". */
const amountText = (minor: string) => {
  const n = BigInt(minor);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
};

/** A wallet recipient this business saved: the kind a schedule can pay. */
const payable = (r: SavedRecipient) => r.delivery?.deliveryKind === 'SELF_CUSTODY' && Boolean(r.walletAddress);

type Props = {
  open: boolean;
  onClose: () => void;
  /** `automatic` is true when the schedule just saved pays automatically: the page then shows the summary of the allowance. */
  onSaved: (message: string, saved: { automatic: boolean }) => void;
  editing: ScheduleView | null;
  /** The owner may choose automatic and the scheduled payer is there. */
  canAutomatic: boolean;
  /** Why automatic is not offered, in a sentence. */
  autoWhy: string | null;
  /** The business's warning window before the first automatic payment, in minutes. */
  graceMinutes: number;
  /** The owners' allowance is in force, so saving an automatic schedule needs no new one. */
  allowanceActive: boolean;
};

/**
 * Set up or change a scheduled batch: a name, when it falls due and how often,
 * which mode (“Ask me first”, or paying automatically within the owners'
 * limits), and the recipients and amounts. Recipients are the ones the business
 * saved; a schedule never takes a name or an address typed here. Changes take
 * effect at once.
 */
export default function ScheduleForm(props: Props) {
  // The body mounts when the form opens, so every opening starts from the schedule being changed, or from a blank one.
  return (
    <Modal open={props.open} onClose={props.onClose} title={props.editing ? 'Change this schedule' : 'New scheduled payment'} eyebrow="Scheduled" wide>
      <Body {...props} />
    </Modal>
  );
}

function Body({ onClose, onSaved, editing, canAutomatic, autoWhy, graceMinutes, allowanceActive }: Props) {
  const [recipients, setRecipients] = useState<SavedRecipient[] | null>(null);
  const [name, setName] = useState(editing?.name ?? '');
  const [mode, setMode] = useState<ScheduleMode>(editing?.mode ?? 'ask');
  const [cadence, setCadence] = useState<Cadence>(editing?.cadence ?? 'monthly');
  const [opened] = useState(() => Date.now());
  const original = editing ? inputValue(Date.parse(editing.nextDueAt ?? editing.firstDueAt)) : null;
  const [when, setWhen] = useState(() => original ?? inputValue(opened + 2 * 86_400_000));
  const nextKey = useRef(2);
  const [rows, setRows] = useState<Row[]>(() =>
    editing
      ? editing.items.map((i, n) => ({ key: n + 1000, recipientId: i.payeeKind === 'recipient' ? i.payeeId : '', amount: amountText(i.amountMinor), reference: i.reference }))
      : [{ key: 1, recipientId: '', amount: '', reference: '' }],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One intent id for this opening of the form: a retry after a lost answer is the same schedule, never a second.
  const [intent] = useState(() => newKey('sched'));

  useEffect(() => {
    let live = true;
    void call<SavedRecipient[]>('/api/recipients').then((a) => {
      if (live) setRecipients(a.ok && Array.isArray(a.body) ? a.body : []);
    });
    return () => {
      live = false;
    };
  }, []);

  const choices = useMemo(() => (recipients ?? []).filter(payable), [recipients]);
  const total = rows.reduce((sum, r) => sum + (parseAmountMinor(r.amount) ?? 0n), 0n);
  const whenMs = when ? new Date(when).getTime() : Number.NaN;
  const lead = mode === 'auto' ? AUTO_MIN_LEAD_MS : ASK_MIN_LEAD_MS;
  // An edit that leaves the time alone is not held to the lead time.
  const timeMoved = original === null || when !== original;
  const tooSoon = (now: number) => timeMoved && whenMs < now + lead;
  const whenProblem = !Number.isFinite(whenMs) ? 'Choose when it falls due.' : tooSoon(opened) ? (mode === 'auto' ? 'An automatic schedule must fall due at least an hour from now, so your owners can read the notice first.' : 'Choose a time a few minutes from now or later.') : null;
  const rowProblem = rows.length === 0 ? 'Add at least one payment.' : rows.some((r) => !r.recipientId || parseAmountMinor(r.amount) === null) ? 'Every payment needs a recipient and an amount above zero, with at most six decimals.' : null;
  const problem = !name.trim() ? 'Give the schedule a name.' : (whenProblem ?? rowProblem);

  function setRow(key: number, patch: Partial<Row>) {
    setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function save() {
    if (problem) return;
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      mode,
      cadence,
      firstDueAt: new Date(whenMs).toISOString(),
      items: rows.map((r) => ({ recipientId: r.recipientId, amount: r.amount.trim(), reference: r.reference.trim() })),
    };
    const answer = editing
      ? await call(`/api/wallet/schedules/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body })
      : await call('/api/wallet/schedules', { method: 'POST', key: intent, body });
    setBusy(false);
    if (!answer.ok) {
      setError(errorText(answer, 'The schedule was not saved. Nothing was scheduled.'));
      return;
    }
    onSaved(editing ? 'Saved. The change is in force now.' : mode === 'auto' ? 'Scheduled. Your owners get a notice the day before it is paid.' : 'Scheduled. At the due time Splash prepares it and asks your owners to approve.', { automatic: mode === 'auto' });
    onClose();
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="space-y-5" noValidate>
      <Field label="Name" hint="Only you see it" htmlFor="sc-name">
        <TextInput id="sc-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" />
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-[13px] font-semibold text-[#1F4452]">How it is paid</legend>
        <Segmented<ScheduleMode>
          label="How it is paid"
          value={mode}
          onChange={(m) => (m === 'auto' && !canAutomatic ? undefined : setMode(m))}
          options={[
            { value: 'ask', label: MODE_WORDS.ask.label },
            ...(canAutomatic || mode === 'auto' ? [{ value: 'auto' as const, label: 'Pay automatically' }] : []),
          ]}
        />
        <p className="max-w-xl text-[13px] leading-5 text-[#326273]">{MODE_WORDS[mode].blurb}</p>
        {mode === 'auto' ? (
          <p className="max-w-xl text-[13px] leading-5 text-[#326273]">
            {graceWords(graceMinutes)} {allowanceActive ? 'It is paid inside the allowance your owners already signed.' : 'After you save, you check what Splash will pay before your owners sign the allowance.'}
          </p>
        ) : null}
        {!canAutomatic ? <Note>{autoWhy ?? 'Only an owner can make a schedule pay automatically.'}</Note> : null}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="How often" htmlFor="sc-cadence">
          <SelectInput id="sc-cadence" value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
            {(['once', 'weekly', 'monthly'] as const).map((c) => (
              <option key={c} value={c}>{CADENCE_WORDS[c]}</option>
            ))}
          </SelectInput>
        </Field>
        <Field label={cadence === 'once' ? 'When' : 'First time'} hint="Your clock" htmlFor="sc-when" error={whenProblem && timeMoved ? whenProblem : null}>
          <TextInput id="sc-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-[13px] font-semibold text-[#1F4452]">Payments</legend>
        {recipients === null ? <p role="status" className="text-[13px] text-[#326273]">Reading your recipients…</p> : null}
        {recipients !== null && choices.length === 0 ? <Note tone="warn">You have no saved wallet recipients to schedule yet. Add one in Recipients first: a schedule pays only people you have saved and Splash has screened.</Note> : null}
        <ul className="space-y-3">
          {rows.map((r, i) => (
            <li key={r.key} className="dash-block grid gap-3 p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
              <Field label={`Payment ${i + 1}: who`} htmlFor={`sc-who-${r.key}`}>
                <SelectInput id={`sc-who-${r.key}`} value={r.recipientId} onChange={(e) => setRow(r.key, { recipientId: e.target.value })}>
                  <option value="">Choose a recipient</option>
                  {choices.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                  {r.recipientId && !choices.some((c) => c.id === r.recipientId) ? <option value={r.recipientId}>A recipient you chose before</option> : null}
                </SelectInput>
              </Field>
              <Field label="Amount (USDC)" htmlFor={`sc-amt-${r.key}`}>
                <TextInput id={`sc-amt-${r.key}`} inputMode="decimal" value={r.amount} onChange={(e) => setRow(r.key, { amount: e.target.value })} className="tabular-nums" />
              </Field>
              <Field label="Reference" hint="Optional" htmlFor={`sc-ref-${r.key}`}>
                <TextInput id={`sc-ref-${r.key}`} value={r.reference} maxLength={60} onChange={(e) => setRow(r.key, { reference: e.target.value })} autoComplete="off" />
              </Field>
              <button
                type="button"
                onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}
                disabled={rows.length === 1}
                aria-label={`Remove payment ${i + 1}`}
                className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#326273]/20 bg-white text-[#1F4452] hover:border-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <QuietButton type="button" onClick={() => setRows((all) => [...all, { key: nextKey.current++, recipientId: '', amount: '', reference: '' }])} disabled={rows.length >= SCHEDULE_MAX_ITEMS}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add a payment
          </QuietButton>
          <p className="text-sm font-bold tabular-nums text-[#0c3e48]">{rows.length} {rows.length === 1 ? 'payment' : 'payments'} · {formatUsdc(total)} USDC</p>
        </div>
        <p className="text-[13px] leading-5 text-[#326273]">Splash&rsquo;s fee for each payment is worked out when you save and shown on the schedule. If it is ever higher at the due time, an automatic run comes to you for approval.</p>
      </fieldset>

      {problem && (name.trim() || rows.some((r) => r.recipientId)) ? (
        <p className="flex items-start gap-1.5 text-[13px] font-medium text-[var(--error)]"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{problem}</p>
      ) : null}
      {error ? <Note tone="error">{error}</Note> : null}
      <div className="flex flex-wrap justify-end gap-2 border-t border-[#326273]/12 pt-4">
        <QuietButton type="button" onClick={onClose}>Cancel</QuietButton>
        <PrimaryButton type="submit" disabled={busy || problem !== null}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Schedule it'}</PrimaryButton>
      </div>
    </form>
  );
}
