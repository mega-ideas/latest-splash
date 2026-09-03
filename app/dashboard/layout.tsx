import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import DashboardShell from '@/components/dashboard/DashboardShell';
import { getCustomerSession } from '@/lib/server/customer-auth';
import { readKybGateState } from '@/lib/server/kyb-gate';

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

  return <DashboardShell session={session} kyb={kyb}>{children}</DashboardShell>;
}
