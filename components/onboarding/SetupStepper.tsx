'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, Clock3 } from 'lucide-react';

import type { OnboardingState } from '@/lib/server/onboarding';
import { setupSummary } from '@/lib/setup-page/view';

/**
 * Account setup: a progress meter that says where the person is and what is
 * next, a rail of the steps (a checkmark for done, a clock for waiting on
 * someone else, a number for to do) and a card per step. Every status is
 * DERIVED server-side from real records (lib/server/onboarding.ts); this only
 * renders it and posts the two actions that are its own (terms, profile). KYB
 * and approvals link to the surfaces that already own them. Once the four
 * required steps are done it points to what comes next.
 */
export default function SetupStepper({ state }: { state: OnboardingState }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState({ legalName: '', registrationNumber: '', addressCountry: '' });
  const summary = setupSummary(state);
  const percent = Math.round((summary.requiredDone / summary.requiredTotal) * 100);

  async function post(path: string, body?: unknown) {
    setBusy(path);
    setError(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        // A refusal the server explains (only an owner may change the
        // registered name, and not once verification has started) is shown
        // as it is; anything else is a plain retry.
        const answer = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
        if (typeof answer?.code === 'string' && typeof answer.error === 'string') {
          setError(answer.error);
          return;
        }
        throw new Error(String(res.status));
      }
      router.refresh();
    } catch {
      setError('That did not save. Try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-6">
      {/* Where you are. */}
      <section className="dash-surface p-5 sm:p-6" aria-labelledby="setup-progress-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 id="setup-progress-title" className="text-lg font-extrabold text-[#0c3e48]">{summary.headline}</h2>
            <p className="mt-1 max-w-xl text-sm leading-6 text-[#326273]">{summary.subline}</p>
          </div>
          <p className="font-mono text-sm font-bold tabular-nums text-[#0c3e48]">{summary.progress}</p>
        </div>
        <div
          role="progressbar"
          aria-label="Required setup steps done"
          aria-valuemin={0}
          aria-valuemax={summary.requiredTotal}
          aria-valuenow={summary.requiredDone}
          aria-valuetext={summary.progress}
          className="mt-4 h-2.5 overflow-hidden rounded-full bg-[#F6F0ED]"
        >
          <div className="h-full rounded-full bg-[#2E7D6B]" style={{ width: `${percent}%` }} />
        </div>
        {!summary.complete ? <p className="mt-3 text-[13px] leading-5 text-[#326273]">{summary.unlocks}</p> : null}
        {summary.next ? (
          <Link
            href={summary.next.href}
            className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#0d6370] px-5 text-sm font-bold text-white transition-colors hover:bg-[#073d49] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]"
          >
            Next: {summary.next.title}
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        ) : null}
      </section>

      {summary.after.length > 0 ? (
        <section className="dash-surface p-5 sm:p-6" aria-labelledby="setup-after-title">
          <h2 id="setup-after-title" className="text-lg font-extrabold text-[#0c3e48]">What comes next</h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-3">
            {summary.after.map((a) => (
              <li key={a.href}>
                <Link href={a.href} className="flex h-full min-h-24 flex-col justify-between gap-2 rounded-xl border border-[#326273]/15 bg-white p-4 transition-colors hover:border-[#0d6370]/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">
                  <span className="text-sm font-bold text-[#0c3e48]">{a.label}</span>
                  <span className="text-[13px] leading-5 text-[#326273]">{a.detail}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* The rail. */}
      <ol className="dash-surface grid gap-0 p-2 sm:grid-cols-3 lg:grid-cols-5" aria-label="Setup steps">
        {state.steps.map((step, i) => {
          const isNext = summary.next?.id === step.id;
          return (
            <li
              key={step.id}
              className={`border-b-2 ${
                step.done ? 'border-[#2E7D6B]' : step.pending ? 'border-[#D9A441]' : isNext ? 'border-[#0d6370]' : 'border-transparent'
              }`}
              aria-current={isNext ? 'step' : undefined}
            >
             <a href={`#${step.id}`} className="flex min-h-14 items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-[#F6F0ED] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold ${
                  step.done
                    ? 'bg-[#2E7D6B] text-white'
                    : step.pending
                      ? 'bg-[#D9A441]/20 text-[#1F4452]'
                      : 'border border-[#C9BDB5] text-[#326273]'
                }`}
                aria-hidden="true"
              >
                {step.done ? <Check className="h-4 w-4" /> : step.pending ? <Clock3 className="h-4 w-4" /> : i + 1}
              </span>
              <span className="min-w-0">
                <strong className="block text-[13.5px] font-semibold leading-5 text-[#1F4452]">{step.title}</strong>
                <small className="block text-[12px] text-[#326273]">
                  {step.done ? 'Done' : step.pending ? 'In review' : isNext ? 'Next' : 'To do'}
                </small>
              </span>
             </a>
            </li>
          );
        })}
      </ol>

      {error ? (
        <p role="alert" className="rounded-lg bg-[var(--error-bg)] px-3 py-2 text-sm font-medium text-[var(--error)]">{error}</p>
      ) : null}

      {/* 1 · Terms */}
      <StepCard id="terms" compact={state.steps[0].done} next={summary.next?.id === 'terms'}>
        <StepHeading n={1} title="Accept the terms" done={state.steps[0].done} />
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#326273]">{state.steps[0].detail}</p>
        {state.steps[0].done ? null : (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link href="/terms-of-service" className="inline-flex min-h-11 items-center text-sm font-semibold text-[#1F4452] underline underline-offset-4">
              Read the terms
            </Link>
            <button
              type="button"
              onClick={() => post('/api/onboarding/terms')}
              disabled={busy !== null}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-[#1F4452] px-5 text-sm font-semibold text-white transition hover:bg-[#326273] disabled:opacity-60"
            >
              {busy === '/api/onboarding/terms' ? 'Saving…' : `Accept version ${state.termsVersion}`}
            </button>
          </div>
        )}
      </StepCard>

      {/* 2 · Business profile */}
      <StepCard id="profile" compact={state.steps[1].done} next={summary.next?.id === 'profile'}>
        <StepHeading n={2} title="Business profile" done={state.steps[1].done} />
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#326273]">{state.steps[1].detail}</p>
        {state.steps[1].done ? null : (
          <form
            className="mt-4 grid max-w-xl gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void post('/api/onboarding/profile', profile);
            }}
          >
            <label className="grid gap-1 text-[13px] font-semibold text-[#1F4452]">
              Legal name
              <input
                required
                minLength={2}
                autoComplete="organization"
                value={profile.legalName}
                onChange={(e) => setProfile((p) => ({ ...p, legalName: e.target.value }))}
                className="min-h-[44px] rounded-lg border border-[#C9BDB5] bg-white px-3 text-sm font-normal text-[#1F4452]"
              />
            </label>
            <label className="grid gap-1 text-[13px] font-semibold text-[#1F4452]">
              Registration number
              <input
                required
                minLength={2}
                placeholder="SSM, UEN, ACRA, DTI, NPWP…"
                value={profile.registrationNumber}
                onChange={(e) => setProfile((p) => ({ ...p, registrationNumber: e.target.value }))}
                className="min-h-[44px] rounded-lg border border-[#C9BDB5] bg-white px-3 text-sm font-normal text-[#1F4452]"
              />
            </label>
            <label className="grid gap-1 text-[13px] font-semibold text-[#1F4452]">
              Country (two letters)
              <input
                required
                minLength={2}
                maxLength={2}
                placeholder="MY"
                autoComplete="country"
                value={profile.addressCountry}
                onChange={(e) => setProfile((p) => ({ ...p, addressCountry: e.target.value }))}
                className="min-h-[44px] w-28 rounded-lg border border-[#C9BDB5] bg-white px-3 text-sm font-normal uppercase text-[#1F4452]"
              />
            </label>
            <button
              type="submit"
              disabled={busy !== null}
              className="mt-1 inline-flex min-h-[44px] w-fit items-center gap-2 rounded-lg bg-[#1F4452] px-5 text-sm font-semibold text-white transition hover:bg-[#326273] disabled:opacity-60"
            >
              {busy === '/api/onboarding/profile' ? 'Saving…' : 'Save profile'}
            </button>
          </form>
        )}
      </StepCard>

      {/* 3 to 5 · Owned elsewhere; this page shows the truth and points at the door. */}
      {state.steps.slice(2).map((step, i) => (
        <StepCard key={step.id} id={step.id} compact={step.done} next={summary.next?.id === step.id}>
          <StepHeading n={i + 3} title={step.title} done={step.done} pending={step.pending} />
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#326273]">{step.detail}</p>
          {step.done ? null : (
            <Link
              href={step.href}
              className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-[#1F4452] px-5 text-sm font-semibold text-[#1F4452] transition hover:bg-[#1F4452] hover:text-white"
            >
              {step.pending ? 'See where it stands' : 'Open'}
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          )}
        </StepCard>
      ))}
    </div>
  );
}

/** One step's card: the next one is ringed, and one already done takes less room than one still to do. */
function StepCard({ id, compact, next, children }: { id: string; compact: boolean; next: boolean; children: ReactNode }) {
  return (
    <section id={id} className={`dash-surface scroll-mt-24 ${compact ? 'p-4' : 'p-6'} ${next ? 'ring-2 ring-[#0d6370]/40' : ''}`}>
      {children}
    </section>
  );
}

function StepHeading({ n, title, done, pending }: { n: number; title: string; done: boolean; pending?: boolean }) {
  return (
    <h2 className="flex flex-wrap items-center gap-3 text-lg font-bold text-[#1F4452]">
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-full text-[13px] ${
          done ? 'bg-[#2E7D6B] text-white' : pending ? 'bg-[#D9A441]/20 text-[#1F4452]' : 'border border-[#C9BDB5] text-[#326273]'
        }`}
        aria-hidden="true"
      >
        {done ? <Check className="h-4 w-4" /> : n}
      </span>
      {title}
      {pending ? <span className="text-[12px] font-semibold text-[var(--warn-ink)]">In review</span> : null}
    </h2>
  );
}
