'use client';

import { useState } from 'react';
import { BellRing, CalendarClock, Loader2, Plus, RefreshCw } from 'lucide-react';

import { type SigningView } from '@/components/transfer/api';
import { Modal, PrimaryButton, QuietButton } from '@/components/transfer/ui';
import { Card, Loading, Note, Pill, useLoad } from '@/components/wallet/parts';
import type { ClientRecipient } from '@/lib/recipients-page/wire';
import type { RuleBody } from '@/lib/team-rules/form';
import { expiryField } from '@/lib/team-rules/form';
import { revokeWords, rulesState } from '@/lib/team-rules/states';
import { ruleSummary } from '@/lib/team-rules/summary';
import { housekeeping, recipientOffers, ruleLine, type RuleLineView, type SpendWire } from '@/lib/team-rules/view';
import { formatUsdc } from '@/lib/fees/copy';
import RuleForm, { type StaffChoice } from './RuleForm';
import SignFlow, { askToSign } from './SignFlow';

type Alert = { id: string; severity: string; summary: string; detail: string };
type FormState = { mode: 'give' } | { mode: 'change'; rule: RuleLineView; initial: Record<string, string> };

const plain = (minor: string) => formatUsdc(BigInt(minor)).replaceAll(',', '');

/**
 * Spending rules (v2 §4.2, decision D2): what each staff member may pay alone,
 * read from the chain as it stands now (windows rolled over, what is left, the
 * time left in the window and in the rule), and said in plain words: what they
 * pay alone and what goes to the owners. An owner gives, changes and takes back
 * a rule; each is a request the owners sign on their own devices (the server
 * never signs) and takes effect at once, with no waiting period. A change keeps
 * what was spent, and taking a rule back stops that person's open payments at
 * once. Staff and approvers see only their own rule. Only an owner is offered a
 * change: the Finance lead is not an owner, and every rule route refuses them.
 *
 * It is always in one honest state: reading, could not be read (with a way to
 * try again), no spending policy yet, no staff yet, no rules yet, or the list.
 */
export default function RulesSection({ owner, spend, loading, error, onRetry, staff, onChanged }: {
  owner: boolean;
  spend: SpendWire | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  staff: StaffChoice[];
  onChanged: () => void;
}) {
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [request, setRequest] = useState<SigningView | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<RuleLineView | null>(null);
  const alerts = useLoad<{ alerts: Alert[] }>(owner && spend ? '/api/wallet/spending-rules/alerts' : null, 'The near-threshold alerts could not be read.');
  const saved = useLoad<ClientRecipient[]>(owner && form?.mode === 'give' ? '/api/recipients' : null, 'Your recipients could not be read.');
  const now = new Date();
  const lines = (spend?.rules ?? []).map((r) => ruleLine(r, now));
  // The alert cards name each recipient; the line that only counts them is dropped while they are shown.
  const attention = spend ? housekeeping(spend, { alertsShown: Boolean(owner && alerts.data && alerts.data.alerts.length > 0) }) : [];
  const state = rulesState({ owner, loading, error, hasPolicy: Boolean(spend?.policy), staff: staff.length, rules: lines.length });
  const free = staff.filter((s) => !s.hasRule);
  const offers = recipientOffers(spend?.policy ?? null, saved.data ?? []);

  async function ask(url: string, init: { method: string; body?: unknown }) {
    setBusy(true);
    setProblem(null);
    const made = await askToSign(url, init);
    setBusy(false);
    if (!made.ok) {
      setProblem(made.error);
      return;
    }
    const carried = made.body.carried as { windowSpentMinor?: string; lifetimeSpentMinor?: string } | undefined;
    setKept(carried ? 'What was spent so far carries over to the new rule, so a change does not give a fresh allowance.' : null);
    setForm(null);
    setRevoking(null);
    setRequest(made.request);
  }

  const done = () => {
    setRequest(null);
    onChanged();
  };

  if (request) {
    return (
      <Card id="rules" title="Spending rules">
        <div className="space-y-3">
          {kept ? <Note>{kept}</Note> : null}
          <Note>Each owner is asked in Splash and by their approval channel. They check the exact change on their own device and sign it there; it takes effect at once when enough of them have signed.</Note>
          <SignFlow request={request} onDone={done} onCancel={() => setRequest(null)} />
        </div>
      </Card>
    );
  }

  const closeForm = () => {
    setForm(null);
    setProblem(null);
  };

  return (
    <Card
      id="rules"
      title="Spending rules"
      aside={owner && spend?.policy && free.length > 0 ? (
        <QuietButton type="button" onClick={() => { setProblem(null); setForm({ mode: 'give' }); }} className="!h-10 !text-[13px]">
          <Plus className="h-4 w-4" aria-hidden="true" />
          Give a rule
        </QuietButton>
      ) : null}
    >
      <div className="space-y-4">
        <p className="text-[13px] leading-5 text-[#326273]">
          Inside a rule a staff member pays alone, from their own device, to recipients you have verified. A payment over the cap, over their limit or to anyone else goes to the owners.{spend?.policy ? ` A payment that takes what they have paid one recipient above ${formatUsdc(BigInt(spend.policy.secondApprovalThresholdMinor))} USDC also needs an owner’s approval, whoever makes it.` : ''} Your own changes take effect at once.
        </p>

        {state === 'loading' ? <Loading label="Reading the rules from the chain…" /> : null}
        {state === 'error' ? (
          <div className="space-y-3">
            <Note tone="error">{error}</Note>
            <QuietButton type="button" onClick={onRetry}><RefreshCw className="h-4 w-4" aria-hidden="true" />Try again</QuietButton>
          </div>
        ) : null}

        {attention.length > 0 ? (
          <ul className="space-y-2" aria-label="Needs your attention">
            {attention.map((a) => (
              <li key={a.id} className="space-y-2">
                <Note tone="warn">{a.text}</Note>
                {owner && a.id === 'reissue' ? (
                  <QuietButton type="button" disabled={busy} onClick={() => void ask('/api/wallet/spending-rules/reissue', { method: 'POST', body: {} })} className="!h-10 !text-[13px]">Reissue the rules under the new wallet</QuietButton>
                ) : null}
                {owner && a.id === 'orphaned' ? (
                  <QuietButton type="button" disabled={busy} onClick={() => void ask('/api/wallet/spending-rules/orphaned', { method: 'POST', body: {} })} className="!h-10 !text-[13px]">Take back those rules</QuietButton>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {!form && !revoking && problem ? <Note tone="error">{problem}</Note> : null}

        {owner && alerts.loading ? <Loading label="Looking for near-threshold flags…" /> : null}
        {owner && alerts.data && alerts.data.alerts.length > 0 ? (
          <ul className="space-y-2" aria-label="Payments near the approval threshold">
            {alerts.data.alerts.map((a) => (
              <li key={a.id} className="rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] p-3 text-[13px] leading-5 text-[#1F4452]">
                <p className="flex items-start gap-2 font-semibold"><BellRing className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warn-ink)]" aria-hidden="true" /><span>{a.summary}</span></p>
                <p className="mt-1 pl-6 [overflow-wrap:anywhere]">{a.detail}</p>
              </li>
            ))}
          </ul>
        ) : null}

        {state === 'no_policy' ? <Note>{owner ? 'Set the spending policy above first. Rules are given under it.' : 'No spending policy is set yet, so staff payments go to your owners.'}</Note> : null}
        {state === 'no_staff' ? (
          <div className="space-y-2">
            <p className="text-sm font-bold text-[#0c3e48]">No staff yet</p>
            <Note>A rule is for a staff member or an approver. Add a person under Team, then give them a rule here. Until then, payments you make go through the owners’ signatures.</Note>
            <a href="#team" className="inline-flex min-h-11 items-center rounded-xl border border-[#326273]/25 bg-white px-4 text-sm font-semibold text-[#1F4452] transition-colors hover:border-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">Add a person</a>
          </div>
        ) : null}
        {state === 'empty' ? <Note>{owner ? 'No staff member has a rule yet. Until one is given, staff ask the owners for each payment.' : 'You have no spending rule, so each payment you make goes to the owners.'}</Note> : null}

        {state === 'list' && spend ? (
          <ul className="space-y-3" aria-label="Rules">
            {lines.map((l, i) => {
              const raw = spend.rules[i];
              const current = raw.allowances.find((a) => a.current) ?? null;
              const summary = ruleSummary(raw, spend.policy, now);
              const renews = l.renewsIn ? `${l.renewsIn}${l.renews ? ` (${l.renews.replace(/^Renews /, '')})` : ''}` : l.renews;
              return (
                <li key={`${l.userId ?? raw.spender}-${i}`} className="rounded-xl border border-[#326273]/12 bg-white p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-bold text-[#0c3e48]">{l.name}</h3>
                    <Pill tone={l.state.tone}>{l.state.label}</Pill>
                  </div>
                  <p className="mt-0.5 text-[13px] text-[#326273]">Up to {l.perPayment} a payment</p>
                  {l.usage ? (
                    <div className="mt-2 space-y-1">
                      <div role="progressbar" aria-label={`${l.name}: ${l.usage.text}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={l.usage.percent} className="h-2 overflow-hidden rounded-full bg-[#F6F0ED]">
                        <div className="h-full rounded-full bg-[#0d6370]" style={{ width: `${l.usage.percent}%` }} />
                      </div>
                      <p className="text-[13px] text-[#1F4452]">{l.usage.text}</p>
                      <p className="text-[13px] text-[#326273]">{[l.left, renews].filter(Boolean).join('. ')}.</p>
                    </div>
                  ) : null}
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-[#326273]">
                    {l.ends ? <span className="inline-flex items-center gap-1"><CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />{l.ends}{l.endsIn ? `, ${l.endsIn.replace(/^Ends /, '')}` : ''}</span> : null}
                    {l.lifetime ? <span>{l.lifetime}</span> : null}
                    {l.paidInAll ? <span>{l.paidInAll}</span> : null}
                  </p>

                  <div className="mt-3 grid gap-3 border-t border-[#326273]/10 pt-3 md:grid-cols-2">
                    {summary.alone.length > 0 ? (
                      <section aria-label={`What ${l.name} can pay alone`} className="space-y-1">
                        <h4 className="text-[13px] font-extrabold text-[#0c3e48]">Can pay alone</h4>
                        <ul className="list-disc space-y-1 pl-5 text-[13px] leading-5 text-[#1F4452]">
                          {summary.alone.map((s) => <li key={s}>{s}</li>)}
                        </ul>
                      </section>
                    ) : null}
                    <section aria-label={`What needs the owners for ${l.name}`} className="space-y-1">
                      <h4 className="text-[13px] font-extrabold text-[#0c3e48]">{summary.alone.length > 0 ? 'Needs the owners' : 'Now'}</h4>
                      <ul className="list-disc space-y-1 pl-5 text-[13px] leading-5 text-[#1F4452]">
                        {summary.approval.map((s) => <li key={s}>{s}</li>)}
                      </ul>
                    </section>
                  </div>

                  {owner && l.userId ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {!l.orphaned ? (
                        <QuietButton
                          type="button"
                          className="!h-10 !text-[13px]"
                          aria-label={`Change the rule for ${l.name}`}
                          onClick={() => {
                            setProblem(null);
                            setForm({
                              mode: 'change',
                              rule: l,
                              initial: {
                                staffUserId: l.userId as string,
                                perPayment: plain(raw.perPaymentMaxMinor),
                                ...(current?.window ? { period: current.window.period === 'month' ? 'month' : 'day', cap: plain(current.window.limitMinor) } : {}),
                                ...(current?.lifetimeCapMinor ? { lifetimeCap: plain(current.lifetimeCapMinor) } : {}),
                                // A change keeps the end date the rule has; only a new rule starts from the default.
                                ...(expiryField(current?.expiresAtMs, now) ? { expires: expiryField(current?.expiresAtMs, now) as string } : {}),
                              },
                            });
                          }}
                        >
                          Change
                        </QuietButton>
                      ) : null}
                      <QuietButton type="button" className="!h-10 !text-[13px] text-[var(--error)]" aria-label={`Take back the rule for ${l.name}`} onClick={() => { setProblem(null); setRevoking(l); }}>Take back</QuietButton>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <Modal side open={form !== null} onClose={closeForm} title={form?.mode === 'change' ? `Change ${form.rule.name}’s rule` : 'Give a rule'}>
        {form ? (
          <RuleForm
            key={form.mode === 'change' ? form.rule.userId ?? 'change' : 'give'}
            staff={staff}
            policy={spend?.policy ?? null}
            recipients={{ loading: saved.loading, error: saved.error, allowed: offers.allowed, offers: offers.offers }}
            changing={form.mode === 'change'}
            initial={form.mode === 'change' ? form.initial : undefined}
            name={form.mode === 'change' ? form.rule.name : null}
            busy={busy}
            error={problem}
            onCancel={closeForm}
            onSubmit={(body: RuleBody) => {
              if (form.mode === 'change') void ask(`/api/wallet/spending-rules/${encodeURIComponent(body.staffUserId)}`, { method: 'PUT', body });
              else void ask('/api/wallet/spending-rules', { method: 'POST', body });
            }}
          />
        ) : null}
      </Modal>

      <Modal open={revoking !== null} onClose={() => { setRevoking(null); setProblem(null); }} title={revokeWords(revoking?.name ?? null).title}>
        {revoking ? (
          <div className="space-y-4">
            <RevokeBody name={revoking.name} />
            {problem ? <Note tone="error">{problem}</Note> : null}
            <div className="flex flex-wrap gap-2">
              <PrimaryButton type="button" disabled={busy} onClick={() => revoking.userId && void ask(`/api/wallet/spending-rules/${encodeURIComponent(revoking.userId)}`, { method: 'DELETE' })}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                Ask the owners to sign
              </PrimaryButton>
              <QuietButton type="button" onClick={() => { setRevoking(null); setProblem(null); }}>Keep the rule</QuietButton>
            </div>
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}

/** What stops, what stays, and that it needs no waiting. */
function RevokeBody({ name }: { name: string }) {
  const words = revokeWords(name);
  return (
    <div className="space-y-4 text-sm leading-6 text-[#1F4452]">
      <section aria-label="What stops" className="space-y-1">
        <h3 className="text-sm font-extrabold text-[#0c3e48]">What stops</h3>
        <ul className="list-disc space-y-1 pl-5">{words.stops.map((s) => <li key={s}>{s}</li>)}</ul>
      </section>
      <section aria-label="What stays" className="space-y-1">
        <h3 className="text-sm font-extrabold text-[#0c3e48]">What stays</h3>
        <ul className="list-disc space-y-1 pl-5">{words.stays.map((s) => <li key={s}>{s}</li>)}</ul>
      </section>
      <p className="text-[13px] leading-5 text-[#326273]">{words.note}</p>
    </div>
  );
}
