import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import DashboardShell from '@/components/dashboard/DashboardShell';
import { custodyPhaseEnabled, sweepAccountEnabled } from '@/lib/server/custody-phase';
import { getCustomerSession } from '@/lib/server/customer-auth';
import { readGovernanceBannerForSession } from '@/lib/server/governance-alerts-store';
import { readKybGateState } from '@/lib/server/kyb-gate';
import { readOnboardingState } from '@/lib/server/onboarding';
import { launchScope } from '@/lib/server/launch-scope';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getCustomerSession();

  if (!session) {
    redirect('/login');
  }

  // Wallet spec §3.2 — resolve the KYB state ONCE, here. Every page under
  // /dashboard is a client component and cannot read the session or the DB, so
  // the banner state has to be computed server-side and passed down.
  // This is presentation only: the money routes enforce the gate themselves
  // (lib/server/kyb-gate.ts), because /queue lives outside this layout.
  const kyb = await readKybGateState(session);

  // Onboarding: the intent question is asked exactly once, and the nav locks
  // are computed from the same server truths the money routes enforce. On a
  // machine without a database the state is unreadable — nothing locks and
  // nothing redirects, mirroring how the gates themselves behave in dev.
  let locks: { termsDone: boolean; moneyBlocked: boolean; custodyOn: boolean; reason: string } | undefined;
  let needsIntent = false;
  // Account setup sits on the rail until its required steps (1-4) are done,
  // then under Settings (v2 brief 5.1). Unreadable means no nudge.
  let setup: { done: number; total: number; complete: boolean } | undefined;
  try {
    const onboarding = await readOnboardingState(session);
    needsIntent = onboarding.intent === null;
    const required = onboarding.steps.slice(0, 4);
    setup = { done: required.filter((step) => step.done).length, total: required.length, complete: onboarding.complete };
    locks = {
      termsDone: onboarding.steps[0].done,
      moneyBlocked: kyb.blocked,
      custodyOn: custodyPhaseEnabled(),
      reason: kyb.reason,
    };
  } catch {
    locks = undefined;
    setup = undefined;
  }
  if (needsIntent) redirect('/onboarding/intent');

  // v2 governance (brief 3.5): the contract changes this person, as a business
  // owner, was told about and that are still active. Their own deliveries
  // only; it never throws, and an unreadable store means no banner, not a
  // broken dashboard (email and WhatsApp carry the same alert).
  const governanceAlerts = await readGovernanceBannerForSession(session);

  // One line on purpose: tests/oxwal-frontend.test.mjs pins the shape
  // {children}</DashboardShell> as the no-second-wrapper contract.
  // sweepOn needs no database, so it is resolved even when `locks` is not.
  return <DashboardShell session={session} kyb={kyb} locks={locks} setup={setup} sweepOn={sweepAccountEnabled()} launchScope={launchScope()} governanceAlerts={governanceAlerts}>{children}</DashboardShell>;
}
