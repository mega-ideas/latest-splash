import { redirect } from 'next/navigation';

import IntentPicker from '@/components/onboarding/IntentPicker';
import { getCustomerSession } from '@/lib/server/customer-auth';
import { readOnboardingState } from '@/lib/server/onboarding';

export const dynamic = 'force-dynamic';

/**
 * "How will you use Splash?" — the one screen between signing up and the
 * dashboard. Orgs that already have payment history were backfilled to 'pay'
 * by migration 0019 and never see it; everyone else answers once.
 */
export default async function IntentPage() {
  const session = await getCustomerSession();
  if (!session) redirect('/login');

  // Already answered → straight to setup. Unreadable (no DB on this machine)
  // → the dashboard, which knows how to live without one.
  try {
    const state = await readOnboardingState(session);
    if (state.intent) redirect('/dashboard/setup');
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error; // the redirect itself
    redirect('/dashboard');
  }

  return (
    <main className="splash-page-bg min-h-dvh px-4 py-14">
      <div className="mx-auto w-full max-w-4xl">
        <p className="dash-kicker">Welcome to Splash</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-[#1F4452]">
          How will you use Splash?
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-[#326273]">
          Pick the flow that matches what you&apos;re doing — it shapes your setup, and you can
          change it later in Settings. Verification and approvals work the same whichever you
          choose.
        </p>
        <div className="mt-8">
          <IntentPicker />
        </div>
      </div>
    </main>
  );
}
