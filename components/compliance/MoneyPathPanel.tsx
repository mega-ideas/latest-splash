import Link from 'next/link';
import { ArrowRight, ChevronDown, Landmark, Repeat, Send, ShieldCheck } from 'lucide-react';

import {
  MONEY_PATH_HEADER,
  MONEY_PATH_STEPS,
} from '@/content/money-path';

/**
 * W9.4 — "Where your money sits" (mockup 4).
 *
 * Four partner-of-record hops rendered ENTIRELY from content/money-path.ts —
 * no copy lives in this component, so partner names and license status
 * update in one place. The Splash step carries the locked honesty sentence
 * (enforced by scripts/check-copy.mjs).
 *
 * Collapsed by default: only the header line shows until the operator clicks
 * it — the partner path is reassurance, not workflow, so it must not shout.
 *
 * Mounts: treasury page, funding/deposit flow (compact), and linked from the
 * receipt's verify section (W9.2).
 */

const STEP_ICONS = [Landmark, Repeat, Send, ShieldCheck] as const;

export default function MoneyPathPanel({ compact = false }: { compact?: boolean }) {
  return (
    <details
      aria-label="Where your money sits"
      className="group overflow-hidden rounded-xl border border-[#326273]/14 bg-white"
    >
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 bg-[#F6F0ED]/70 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2 text-sm font-semibold text-[#1F4452]">
          <ShieldCheck size={15} className="shrink-0 text-[var(--info)]" aria-hidden="true" />
          {MONEY_PATH_HEADER}
        </span>
        <ChevronDown size={15} aria-hidden="true" className="shrink-0 text-[#326273]/45 transition-transform group-open:rotate-180" />
      </summary>
      <div className="flex justify-end border-t border-[#326273]/10 px-4 pt-2">
        <Link
          href="/trust"
          className="text-[13px] font-medium text-[var(--info)] underline-offset-4 hover:underline"
        >
          Trust &amp; compliance
        </Link>
      </div>

      <ol className={compact ? 'grid gap-0 divide-y divide-[#326273]/8' : 'grid gap-0 divide-y divide-[#326273]/8 lg:grid-cols-4 lg:divide-x lg:divide-y-0'}>
        {MONEY_PATH_STEPS.map((step, index) => {
          const Icon = STEP_ICONS[index] ?? ShieldCheck;
          const isSplashStep = index === MONEY_PATH_STEPS.length - 1;
          return (
            <li key={step.partner} className={compact ? 'flex items-start gap-3 px-4 py-3' : 'flex items-start gap-3 px-4 py-4'}>
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                  isSplashStep ? 'bg-[#1F4452] text-white' : 'bg-[var(--info-bg)] text-[var(--info)]'
                }`}
              >
                <Icon size={15} />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <strong className="text-sm font-semibold text-[#1F4452]">{step.partner}</strong>
                  <span className="text-[13px] font-medium text-[#326273]/55">· {step.role}</span>
                  {!compact && index < MONEY_PATH_STEPS.length - 1 ? (
                    <ArrowRight size={13} aria-hidden="true" className="hidden text-[#326273]/35 lg:inline" />
                  ) : null}
                </div>
                <p className="mt-1 text-[13px] font-medium leading-5 text-[#326273]/70">{step.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
