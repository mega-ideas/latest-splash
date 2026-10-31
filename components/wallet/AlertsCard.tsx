'use client';

import { ShieldAlert, ShieldCheck } from 'lucide-react';

import type { GovernanceBannerAlert } from '@/lib/server/governance-events';
import { Card } from './parts';

/**
 * Upgrade alerts (v2 brief 3.5, 5.5): changes to Splash's payment contract
 * and fee schedule announced to this owner, still active. Splash's own
 * changes keep a 24-hour notice; an owner's own changes (rules, recipients,
 * limits) take effect at once. The same alerts reach an owner by email and
 * WhatsApp, and sit in the banner at the top of the dashboard.
 */
export default function AlertsCard({ alerts, owner }: { alerts: GovernanceBannerAlert[]; owner: boolean }) {
  return (
    <Card id="upgrade-alerts" title="Upgrade alerts">
      {alerts.length === 0 ? (
        <p className="flex items-start gap-2 text-[13px] leading-5 text-[#326273]">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ok)]" aria-hidden="true" />
          <span>{owner ? 'No change to the payment contract or its fees is waiting. Splash gives every owner 24 hours’ notice before one takes effect.' : 'Upgrade alerts go to the business’s owners.'}</span>
        </p>
      ) : (
        <ul className="space-y-3">
          {alerts.map((a) => (
            <li key={a.id} className="rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] p-3 text-[13px] leading-5 text-[#1F4452]">
              <p className="flex items-start gap-2 font-semibold"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warn-ink)]" aria-hidden="true" /><span>{a.summary}</span></p>
              {a.detail ? (
                <details className="mt-1 pl-6">
                  <summary className="min-h-11 cursor-pointer py-2.5 font-semibold text-[var(--ink)]">What this changes</summary>
                  <p className="[overflow-wrap:anywhere]">{a.detail}</p>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
