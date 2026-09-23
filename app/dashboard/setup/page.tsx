import { redirect } from 'next/navigation';

import SetupStepper from '@/components/onboarding/SetupStepper';
import { getCustomerSession } from '@/lib/server/customer-auth';
import { readOnboardingState, type OnboardingState } from '@/lib/server/onboarding';

export const dynamic = 'force-dynamic';

/**
 * Account setup. The state is derived server-side on every render — flipping
 * a KYB state in the admin console changes step 3 here with no writes, which
 * is the whole argument for not storing progress.
 */
export default async function SetupPage() {
  const session = await getCustomerSession();
  if (!session) redirect('/login');

  let state: OnboardingState | null = null;
  try {
    state = await readOnboardingState(session);
  } catch {
    state = null;
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <p className="dash-kicker">Account setup</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight text-[#1F4452]">
        Finish setting up this workspace
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#326273]">
        Five steps; the last one is optional. Money movement unlocks when verification completes —
        everything else here is yours to finish at your own pace.
      </p>

      <div className="mt-8">
        {state ? (
          <SetupStepper state={state} />
        ) : (
          <section className="dash-surface p-6">
            <h2 className="text-lg font-bold text-[#1F4452]">Setup is unavailable on this machine</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#326273]">
              No database is configured, so setup state cannot be read or written here. Start the
              local dev database (scripts/dev-db.mjs) or point DATABASE_URL at a cluster.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
