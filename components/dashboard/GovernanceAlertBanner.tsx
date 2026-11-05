import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';

import type { GovernanceBannerAlert } from '@/lib/server/governance-events';

/**
 * The in-app half of the governance alert (v2, brief 3.5): a change to the
 * payment contract has been announced, or has taken effect, and this owner
 * should check their spending rules and allowances.
 *
 * The alerts are resolved server-side in app/dashboard/layout.tsx from this
 * person's own recorded in-app deliveries, so the banner appears exactly for
 * the owners the cron told. Same construction as the shell's read-only
 * (KYB) banner, on the warning tokens: this is a call to check something
 * before a date, not an error. One link, the same for every alert, because
 * every alert asks for the same action.
 */
export default function GovernanceAlertBanner({ alerts }: { alerts: GovernanceBannerAlert[] }) {
  if (alerts.length === 0) return null;
  const reviewPath = alerts[0].reviewPath;
  return (
    <section
      aria-labelledby="governance-alert-heading"
      className="mb-5 flex flex-wrap items-start gap-3 rounded-lg border border-[var(--warn)] bg-[var(--warn-bg)] px-4 py-3"
    >
      <ShieldAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warn)]" />
      {/* A 16rem basis, so on a phone the link wraps below the text instead
          of squeezing it to a sliver. */}
      <div className="min-w-0 flex-1 basis-64">
        <p id="governance-alert-heading" className="text-[13px] font-bold text-[var(--warn-ink)]">
          Payment contract {alerts.length === 1 ? 'change' : 'changes'}
        </p>
        <ul className="mt-1 space-y-2">
          {alerts.map((alert) => (
            <li key={alert.id} className="break-words text-[13px] font-medium leading-relaxed text-[var(--slate)]">
              <p>{alert.summary}</p>
              {alert.detail ? (
                <details className="mt-1">
                  <summary className="cursor-pointer py-1.5 text-[13px] font-semibold text-[var(--ink)]">What this changes</summary>
                  {/* Digests and full type names are 64 hex characters long. */}
                  <p className="mt-1 [overflow-wrap:anywhere]">{alert.detail}</p>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <Link
        href={reviewPath}
        className="inline-flex min-h-[44px] shrink-0 items-center justify-center rounded-md bg-[var(--ink)] px-3 text-[13px] font-bold text-white transition-colors hover:bg-[var(--slate)] max-sm:w-full"
      >
        Review spending rules and allowances
      </Link>
    </section>
  );
}
