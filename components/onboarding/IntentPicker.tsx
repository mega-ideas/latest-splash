'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, FileText, Send, TrendingUp } from 'lucide-react';

import type { OnboardingIntent } from '@/lib/server/onboarding';

/**
 * "How will you use Splash?" — one intent per workspace, chosen once
 * (changeable later only from Settings). The choice tailors which setup steps
 * the stepper emphasises and NOTHING else: the KYB lifecycle stays the single
 * authority on what may move money, whatever is picked here.
 */
const CARDS: Array<{
  intent: OnboardingIntent;
  icon: typeof Send;
  title: string;
  copy: string;
  bestFor: string;
  roadmap?: boolean;
}> = [
  {
    intent: 'pay',
    icon: Send,
    title: 'Pay suppliers',
    copy: 'Fund in US dollars, approve, and suppliers are paid in pesos with a record both sides keep.',
    bestFor: 'A business paying suppliers in the Philippines from USD.',
  },
  {
    intent: 'collect',
    icon: FileText,
    title: 'Collect and invoice',
    copy: 'Raise invoices, collect through pay links, and reconcile to the same record your payer sees.',
    bestFor: 'A business raising invoices and collecting from buyers.',
  },
  {
    intent: 'treasury',
    icon: TrendingUp,
    title: 'Treasury',
    copy: 'Idle USD under a projected, variable posture — every move human-approved.',
    bestFor: 'A business parking idle USD between payouts.',
    roadmap: true,
  },
];

export default function IntentPicker() {
  const router = useRouter();
  const [busy, setBusy] = useState<OnboardingIntent | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(intent: OnboardingIntent) {
    setBusy(intent);
    setError(null);
    try {
      const res = await fetch('/api/onboarding/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent }),
      });
      if (!res.ok) throw new Error(String(res.status));
      router.push('/dashboard/setup');
    } catch {
      setError('That did not save. Check your connection and try again.');
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {CARDS.map(({ intent, icon: Icon, title, copy, bestFor, roadmap }) => (
        <article key={intent} className="dash-surface flex flex-col gap-4 p-6">
          <div className="flex items-center justify-between">
            <Icon aria-hidden="true" className="h-6 w-6 text-[#1F4452]" />
            {roadmap ? (
              <span className="rounded-full border border-[#D9A441]/50 bg-[#D9A441]/10 px-2.5 py-0.5 text-[11px] font-semibold text-[#B4690E]">
                Coming — subject to licensing
              </span>
            ) : null}
          </div>
          <div>
            <h2 className="text-lg font-bold text-[#1F4452]">{title}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-[#326273]">{copy}</p>
          </div>
          <p className="text-[13px] text-[#326273]/80">
            <strong className="font-semibold text-[#1F4452]">Best for:</strong> {bestFor}
          </p>
          <button
            type="button"
            onClick={() => choose(intent)}
            disabled={busy !== null}
            className="dash-block mt-auto inline-flex min-h-[46px] items-center justify-center gap-2 rounded-lg bg-[#1F4452] px-5 text-sm font-semibold text-white transition hover:bg-[#326273] disabled:opacity-60"
          >
            {busy === intent ? 'Saving…' : roadmap ? 'Choose and register interest' : `Choose ${title.toLowerCase()}`}
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </button>
        </article>
      ))}
      {error ? (
        <p role="alert" className="md:col-span-3 text-sm font-medium text-[#B3402F]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
