'use client';

import { useState } from 'react';
import { BellRing, CalendarClock, Loader2, Plus } from 'lucide-react';

import { type SigningView } from '@/components/transfer/api';
import { Modal, PrimaryButton, QuietButton } from '@/components/transfer/ui';
import { Card, Loading, Note, Pill, useLoad } from '@/components/wallet/parts';
import type { RuleBody } from '@/lib/team-rules/form';
import { housekeeping, ruleLine, type RuleLineView, type SpendWire } from '@/lib/team-rules/view';
import { formatUsdc } from '@/lib/fees/copy';
import { expiryField } from '@/lib/team-rules/form';
import RuleForm, { type StaffChoice } from './RuleForm';
import SignFlow, { askToSign } from './SignFlow';

type Alert = { id: string; severity: string; summary: string; detail: string };

const plain = (minor: string) => formatUsdc(BigInt(minor)).replaceAll(',', '');

/**
 * Spending rules (v2 §4.2): what each staff member may pay alone, read from the
 * chain as it stands now (windows rolled over, what is left, when it renews and
 * ends). An owner gives, changes and takes back a rule; each is a request the
 * owners sign on their own devices and takes effect at once, with no waiting
 * period. A change keeps what was spent, and taking a rule back stops that
 * person's open payments at once. Staff and approvers see only their own rule.
 */
export default function RulesSection({ owner, spend, staff, onChanged }: { owner: boolean; spend: SpendWire; staff: StaffChoice[]; onChanged: () => void }) {
  const [form, setForm] = useState<{ mode: 'give' } | { mode: 'change'; rule: RuleLineView; initial: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<SigningView | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<RuleLineView | null>(null);
  const alerts = useLoad<{ alerts: Alert[] }>(owner ? '/api/wallet/spending-rules/alerts' : null, 'The near-threshold alerts could not be read.');
  const now = new Date();
  const lines = spend.rules.map((r) => ruleLine(r, now));
  // The alert cards name each recipient; the line that only counts them is dropped while they are shown.
  const attention = housekeeping(spend, { alertsShown: Boolean(owner && alerts.data && alerts.data.alerts.length > 0) });
  const policyMax = spend.policy ? BigInt(spend.policy.perPaymentMaxMinor) : null;

  async function ask(url: string, init: { method: string; body?: unknown }) {
    setBusy(true);
    setError(null);
    const made = await askToSign(url, init);
    setBusy(false);
    setRevoking(null);
    if (!made.ok) {
      setError(made.error);
      return;
    }
    const carried = made.body.carried as { windowSpentMinor?: string; lifetimeSpentMinor?: string } | undefined;
    setKept(carried ? 'What was spent so far carries over to the new rule, so a change does not give a fresh allowance.' : null);
    setForm(null);
    setRequest(made.request);
  }

  const done = () => {
    setRequest(null);
    onChanged();
  };

  if (request) {
    return (
      <Card id="rules" title="Spending rules">
        {kept ? <div className="mb-3"><Note>{kept}</Note></div> : null}
        <SignFlow request={request} onDone={done} onCancel={() => setRequest(null)} />
      </Card>
    );
  }

  return (
    <Card
      id="rules"
      title="Spending rules"
      aside={owner && !form && spend.policy ? (
        <QuietButton type="button" onClick={() => { setError(null); setForm({ mode: 'give' }); }} className="!h-10 !text-[13px]">
          <Plus className="h-4 w-4" aria-hidden="true" />
          Give a rule
        </QuietButton>
      ) : null}
    >
      <div className="space-y-4">
        <p className="text-[13px] leading-5 text-[#326273]">
          Inside a rule a staff member pays alone, from their own device, to recipients you have allowed. A payment over the cap, over their limit or to anyone else goes to the owners.{spend.policy ? ` A payment of ${policyThresholdWords(spend)} or more also needs an owner’s approval, whoever makes it.` : ''} Your own changes take effect at once.
        </p>

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

        {form ? (
          <RuleForm
            staff={staff}
            policyMaxMinor={policyMax}
            changing={form.mode === 'change'}
            initial={form.mode === 'change' ? form.initial : undefined}
            busy={busy}
            error={error}
            onCancel={() => { setForm(null); setError(null); }}
            onSubmit={(body: RuleBody) => {
              if (form.mode === 'change') void ask(`/api/wallet/spending-rules/${encodeURIComponent(body.staffUserId)}`, { method: 'PUT', body });
              else void ask('/api/wallet/spending-rules', { method: 'POST', body });
            }}
          />
        ) : error ? <Note tone="error">{error}</Note> : null}

        {!spend.policy ? (
          <Note>{owner ? 'Set the spending policy above first. Rules are given under it.' : 'No spending policy is set yet, so staff payments go to your owners.'}</Note>
        ) : lines.length === 0 ? (
          <Note>{owner ? 'No staff member has a rule yet. Until one is given, staff ask the owners for each payment.' : 'You have no spending rule, so each payment you make goes to the owners.'}</Note>
        ) : (
          <ul className="space-y-3" aria-label="Rules">
            {lines.map((l, i) => {
              const raw = spend.rules[i];
              const current = raw.allowances.find((a) => a.current) ?? null;
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
                      <p className="text-[13px] text-[#326273]">{[l.left, l.renews].filter(Boolean).join('. ')}.</p>
                    </div>
                  ) : null}
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-3 text-[13px] text-[#326273]">
                    {l.ends ? <span className="inline-flex items-center gap-1"><CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />{l.ends}</span> : null}
                    {l.lifetime ? <span>{l.lifetime}</span> : null}
                  </p>
                  {owner && l.userId ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {!l.orphaned ? (
                        <QuietButton
                          type="button"
                          className="!h-10 !text-[13px]"
                          aria-label={`Change the rule for ${l.name}`}
                          onClick={() => {
                            setError(null);
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
                      <QuietButton type="button" className="!h-10 !text-[13px] text-[var(--error)]" aria-label={`Take back the rule for ${l.name}`} onClick={() => setRevoking(l)}>Take back</QuietButton>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Modal open={revoking !== null} onClose={() => setRevoking(null)} title="Take back this rule?">
        <div className="space-y-4">
          <p className="text-sm leading-6 text-[#1F4452]">
            {revoking?.name} cannot pay on their own after this. Their allowance is revoked and their open payments stop at once; what was spent stays on the record. Their later payments go to the owners. You can give a new rule later.
          </p>
          <div className="flex flex-wrap gap-2">
            <PrimaryButton type="button" disabled={busy} onClick={() => revoking?.userId && void ask(`/api/wallet/spending-rules/${encodeURIComponent(revoking.userId)}`, { method: 'DELETE' })}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Ask the owners to sign
            </PrimaryButton>
            <QuietButton type="button" onClick={() => setRevoking(null)}>Keep the rule</QuietButton>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

function policyThresholdWords(spend: SpendWire): string {
  return spend.policy ? `${formatUsdc(BigInt(spend.policy.secondApprovalThresholdMinor))} USDC` : '';
}
