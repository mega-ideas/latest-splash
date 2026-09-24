import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import DashboardShell from '@/components/dashboard/DashboardShell';
import { custodyPhaseEnabled, sweepAccountEnabled } from '@/lib/server/custody-phase';
import { getCustomerSession } from '@/lib/server/customer-auth';
import { readKybGateState } from '@/lib/server/kyb-gate';
import { readOnboardingState } from '@/lib/server/onboarding';

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
  try {
    const onboarding = await readOnboardingState(session);
    needsIntent = onboarding.intent === null;
    locks = {
      termsDone: onboarding.steps[0].done,
      moneyBlocked: kyb.blocked,
      custodyOn: custodyPhaseEnabled(),
      reason: kyb.reason,
    };
  } catch {
    locks = undefined;
  }
  if (needsIntent) redirect('/onboarding/intent');

  // One line on purpose: tests/oxwal-frontend.test.mjs pins the shape
  // {children}</DashboardShell> as the no-second-wrapper contract.
  // sweepOn needs no database, so it is resolved even when `locks` is not.
  return <DashboardShell session={session} kyb={kyb} locks={locks} sweepOn={sweepAccountEnabled()}>{children}</DashboardShell>;
}
