'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, ShieldCheck } from 'lucide-react';

import LocalTime from '@/components/LocalTime';
import { FUND_QUESTIONS, type FundQuestionId } from '@/lib/treasury/fund-eligibility';
import { cn } from '@/lib/utils';

/*
 * The fund-manager referral on Treasury (v2 D9, brief 5.7), shown only when
 * FEATURE_FUND_REFERRAL is on, which waits on legal sign-off of this wording.
 *
 * `label` is what the server may call the fund manager: its name once its
 * agreement is signed (lib/partners/signed-partners.ts), its role otherwise.
 * Splash refers; it does not sell, advise on or hold the fund. An owner
 * answers the eligibility questions for the business; everyone else reads.
 * Once an account is linked the holding is read-only, and a figure is shown
 * only if the fund manager's connection answered.
 */

type Referral = {
  label: string;
  assessment: { outcome: 'eligible' | 'not_eligible'; categoryLabel: string | null; reason: string; assessedAt: string } | null;
  /** Every time the business answered, newest first. Answering again never hides an earlier answer. */
  assessments?: Array<{ outcome: 'eligible' | 'not_eligible'; categoryLabel: string | null; assessedAt: string }>;
  referralUrl: string | null;
  referralOpenedAt?: string | null;
  linked: boolean;
  holding: { reference: string; units: string; value: string; currency: string; asOf: string; sandbox: boolean } | { unavailable: string } | null;
};

type Answers = Partial<Record<FundQuestionId, boolean>>;

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function FundReferralPanel({ label, canAnswer }: { label: string; canAnswer: boolean }) {
  const [referral, setReferral] = useState<Referral | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [editing, setEditing] = useState(false);
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/treasury/fund-referral', { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        setLoadError((body as { error?: string } | null)?.error ?? 'The referral could not be loaded.');
        return;
      }
      setReferral(body as Referral);
    } catch {
      setLoadError('The referral could not be loaded.');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set when it answers
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/treasury/fund-referral', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error ?? 'That did not go through.');
        return false;
      }
      setReferral(data as Referral);
      return true;
    } catch {
      setError('That did not go through. Try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const name = referral?.label ?? label;
  const complete = FUND_QUESTIONS.every((q) => typeof answers[q.id] === 'boolean');
  const assessment = referral?.assessment ?? null;
  const showForm = canAnswer && (!assessment || editing) && !referral?.linked;

  return (
    <section className="dash-surface overflow-hidden" aria-labelledby="fund-title">
      <div className="border-b border-[#326273]/8 px-5 py-3">
        <h2 id="fund-title" className="text-sm font-semibold text-[#1F4452]">A fund for sophisticated investors</h2>
        <p className="mt-0.5 max-w-2xl text-[13px] leading-5 text-[#326273]">
          {capitalise(name)} offers a fund to businesses that are sophisticated investors. Splash refers eligible businesses; it does not sell or advise on the fund, and the fund manager makes its own checks.
        </p>
      </div>

      <div className="space-y-4 p-5">
        {loadError && <p role="alert" className="text-[13px] font-medium text-[var(--error)]">{loadError}</p>}
        {!referral && !loadError && <p className="text-[13px] text-[#326273]">Loading…</p>}

        {referral && assessment && !editing && (
          <div className={cn('rounded-lg px-3 py-2.5 text-[13px]', assessment.outcome === 'eligible' ? 'bg-[var(--ok-bg)] text-[#1F4452]' : 'bg-[#F6F0ED] text-[#1F4452]')}>
            <p className="flex items-center gap-1.5 font-semibold">
              {assessment.outcome === 'eligible' ? <CheckCircle2 size={14} className="text-[var(--ok)]" aria-hidden="true" /> : null}
              {assessment.outcome === 'eligible' ? `Eligible: ${assessment.categoryLabel}` : 'Not eligible'}
            </p>
            {assessment.outcome !== 'eligible' && <p className="mt-0.5 text-[#326273]">{assessment.reason}</p>}
            <p className="mt-0.5 text-[12px] text-[#326273]">Answered <LocalTime value={assessment.assessedAt} format="date" /></p>
            {(referral.assessments?.length ?? 0) > 1 && (
              <div className="mt-1.5 border-t border-[#326273]/10 pt-1.5 text-[12px] text-[#326273]">
                <p className="font-semibold">Earlier answers, kept on record</p>
                <ul className="mt-0.5 space-y-0.5">
                  {referral.assessments!.slice(1).map((a) => (
                    <li key={a.assessedAt}>
                      {a.outcome === 'eligible' ? `Eligible: ${a.categoryLabel}` : 'Not eligible'}, <LocalTime value={a.assessedAt} format="date" />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {canAnswer && !referral.linked && (
              <button type="button" onClick={() => { setEditing(true); setAnswers({}); }} className="mt-1 inline-flex min-h-11 items-center text-[13px] font-semibold text-[#145d6a] underline decoration-1 underline-offset-2">
                Answer again
              </button>
            )}
          </div>
        )}

        {referral && !assessment && !canAnswer && (
          <p className="text-[13px] text-[#326273]">An owner answers the eligibility questions for the business.</p>
        )}

        {referral && showForm && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!complete) return;
              if (await post({ action: 'assess', answers })) setEditing(false);
            }}
            className="space-y-3"
          >
            <p className="text-[13px] text-[#326273]">Answer for the business. Every question needs an answer.</p>
            {FUND_QUESTIONS.map((q) => (
              <fieldset key={q.id} className="rounded-lg border border-[#326273]/12 px-3 py-2.5">
                {/* A floated legend sits inside the box: a long question no longer straddles the border. */}
                <legend className="float-left w-full text-[13px] font-medium leading-5 text-[#1F4452]">{q.question}</legend>
                {q.help && <p className="clear-left pt-1 text-[12px] leading-5 text-[#326273]">{q.help}</p>}
                <div className="clear-left flex gap-2 pt-2">
                  {([[true, q.id === 'declaration' ? 'I confirm' : 'Yes'], [false, q.id === 'declaration' ? 'I do not' : 'No']] as const).map(([value, text]) => (
                    <label key={String(value)} className={cn(
                      'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-[13px] font-semibold',
                      answers[q.id] === value ? 'border-[#237284] bg-[#237284]/8 text-[#0c3e48]' : 'border-[#326273]/20 text-[#326273]',
                    )}>
                      <input
                        type="radio"
                        name={q.id}
                        className="accent-[#237284]"
                        checked={answers[q.id] === value}
                        onChange={() => setAnswers((a) => ({ ...a, [q.id]: value }))}
                      />
                      {text}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" disabled={!complete || busy} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[#237284] px-4 text-sm font-semibold text-white transition hover:bg-[#145d6a] disabled:opacity-50">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} Check eligibility
              </button>
              {editing && (
                <button type="button" onClick={() => setEditing(false)} className="inline-flex min-h-11 items-center px-2 text-[13px] font-semibold text-[#326273]">Keep my answers</button>
              )}
            </div>
          </form>
        )}

        {referral && assessment?.outcome === 'eligible' && !editing && !referral.linked && (
          <div className="space-y-3">
            {referral.referralUrl ? (
              <a
                href={referral.referralUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => { if (canAnswer) void post({ action: 'opened' }); }}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[#C99A2E] px-4 text-sm font-semibold text-[#073d49] transition hover:bg-[#C99A2E]/85"
              >
                Open the referral <ExternalLink size={14} aria-hidden="true" />
              </a>
            ) : (
              <p className="text-[13px] text-[#326273]">The referral link is not set up on this server.</p>
            )}
            {canAnswer && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await post({ action: 'link', reference })) setReference('');
                }}
                className="flex flex-wrap items-end gap-2"
              >
                <div>
                  <label htmlFor="fund-reference" className="text-[12px] font-semibold uppercase tracking-wide text-[#326273]">Your account reference</label>
                  <input
                    id="fund-reference"
                    value={reference}
                    onChange={(e) => setReference(e.target.value.replace(/[^A-Za-z0-9-]/g, '').slice(0, 40))}
                    autoComplete="off"
                    placeholder="From the fund manager"
                    className="mt-1 block min-h-11 w-56 rounded-lg border border-[#326273]/20 bg-white px-3 font-mono text-[13px] text-[#1F4452] placeholder-[#326273]/60"
                  />
                </div>
                <button type="submit" disabled={busy || reference.length < 4} className="dash-btn-ghost inline-flex min-h-11 items-center !px-4 !text-[13px] disabled:opacity-50">
                  Link account
                </button>
              </form>
            )}
          </div>
        )}

        {referral?.linked && referral.holding && (
          'unavailable' in referral.holding ? (
            <p className="rounded-lg bg-[#F6F0ED] px-3 py-2.5 text-[13px] text-[#326273]">{referral.holding.unavailable}</p>
          ) : (
            <div className="rounded-lg border border-[#326273]/12 px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[#1F4452]">
                <ShieldCheck size={14} className="text-[var(--info)]" aria-hidden="true" /> Your holding, read-only
                {referral.holding.sandbox && <span className="rounded-full bg-[var(--warn-bg)] px-2 py-0.5 text-[12px] font-semibold text-[var(--warn-ink)]">Sandbox figures</span>}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-[13px]">
                <div><dt className="text-[#326273]">Units</dt><dd className="dash-num font-mono font-semibold text-[#1F4452]">{referral.holding.units}</dd></div>
                <div><dt className="text-[#326273]">Value</dt><dd className="dash-num font-mono font-semibold text-[#1F4452]">{referral.holding.currency} {referral.holding.value}</dd></div>
              </dl>
              <p className="mt-1 text-[12px] text-[#326273]">Account {referral.holding.reference} · as of <LocalTime value={referral.holding.asOf} /></p>
            </div>
          )
        )}

        {error && <p role="alert" className="text-[13px] font-medium text-[var(--error)]">{error}</p>}
      </div>
    </section>
  );
}
