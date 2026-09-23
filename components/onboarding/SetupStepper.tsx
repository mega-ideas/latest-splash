'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, Clock3 } from 'lucide-react';

import type { OnboardingState } from '@/lib/server/onboarding';

/**
 * Account setup, the Stablecorp grammar on Splash's machine: a horizontal
 * rail — checkmark for done, number for pending — and a card per step. Every
 * status here is DERIVED server-side from real records (see
 * lib/server/onboarding.ts); this component only renders it and posts the two
 * actions that are its own (terms, profile). KYB and approvals link to the
 * surfaces that already own them.
 */
export default function SetupStepper({ state }: { state: OnboardingState }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState({ legalName: '', registrationNumber: '', addressCountry: '' });

  async function post(path: string, body?: unknown) {
    setBusy(path);
    setError(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
    } catch {
      setError('That did not save. Try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-6">
      {/* The rail. */}
      <ol className="dash-surface flex flex-wrap items-stretch gap-0 overflow-x-auto p-2" aria-label="Setup progress">
        {state.steps.map((step, i) => (
          <li
            key={step.id}
            className={`flex min-w-[150px] flex-1 items-center gap-3 border-b-2 px-4 py-3 ${
              step.done ? 'border-[#2E7D6B]' : step.pending ? 'border-[#D9A441]' : 'border-transparent'
            }`}
            aria-current={!step.done && state.steps.slice(0, i).every((s) => s.done) ? 'step' : undefined}
          >
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold ${
                step.done
                  ? 'bg-[#2E7D6B] text-white'
                  : step.pending
                    ? 'bg-[#D9A441]/20 text-[#B4690E]'
                    : 'border border-[#C9BDB5] text-[#326273]'
              }`}
              aria-hidden="true"
            >
              {step.done ? <Check className="h-4 w-4" /> : step.pending ? <Clock3 className="h-4 w-4" /> : i + 1}
            </span>
            <span className="min-w-0">
              <strong className="block truncate text-[13.5px] font-semibold text-[#1F4452]">{step.title}</strong>
              <small className="block truncate text-[11.5px] text-[#326273]/75">
                {step.done ? 'Done' : step.pending ? 'In review' : 'To do'}
              </small>
            </span>
          </li>
        ))}
      </ol>

      {error ? (
        <p role="alert" className="text-sm font-medium text-[#B3402F]">{error}</p>
      ) : null}

      {/* 1 · Terms */}
      <section id="terms" className="dash-surface p-6">
        <StepHeading n={1} title="Accept the terms" done={state.steps[0].done} />
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#326273]">{state.steps[0].detail}</p>
        {state.steps[0].done ? null : (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link href="/terms-of-service" className="text-sm font-semibold text-[#1F4452] underline underline-offset-4">
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
      </section>

      {/* 2 · Business profile */}
      <section id="profile" className="dash-surface p-6">
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
      </section>

      {/* 3–5 · Owned elsewhere; this page shows the truth and points at the door. */}
      {state.steps.slice(2).map((step, i) => (
        <section key={step.id} id={step.id} className="dash-surface p-6">
          <StepHeading n={i + 3} title={step.title} done={step.done} pending={step.pending} />
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#326273]">{step.detail}</p>
          {step.done ? null : (
            <Link
              href={step.href}
              className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-[#1F4452] px-5 text-sm font-semibold text-[#1F4452] transition hover:bg-[#1F4452] hover:text-white"
            >
              Open
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          )}
        </section>
      ))}
    </div>
  );
}

function StepHeading({ n, title, done, pending }: { n: number; title: string; done: boolean; pending?: boolean }) {
  return (
    <h2 className="flex items-center gap-3 text-lg font-bold text-[#1F4452]">
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-full text-[13px] ${
          done ? 'bg-[#2E7D6B] text-white' : pending ? 'bg-[#D9A441]/20 text-[#B4690E]' : 'border border-[#C9BDB5] text-[#326273]'
        }`}
        aria-hidden="true"
      >
        {done ? <Check className="h-4 w-4" /> : n}
      </span>
      {title}
      {pending ? <span className="text-[12px] font-semibold text-[#B4690E]">In review</span> : null}
    </h2>
  );
}
