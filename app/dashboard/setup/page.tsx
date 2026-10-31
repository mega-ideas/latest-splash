import { redirect } from 'next/navigation';

import SetupStepper from '@/components/onboarding/SetupStepper';
import { getCustomerSession } from '@/lib/server/customer-auth';
import { readOnboardingState, type OnboardingState } from '@/lib/server/onboarding';

export const dynamic = 'force-dynamic';

/**
 * Account setup. The state is derived server-side on every render: flipping
 * a KYB state in the admin console changes step 3 here with no writes, which
 * is the whole argument for not storing progress. Until the four required
 * steps are done it sits on the rail; after that, under Settings.
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
      <h1 className="dash-title mt-2">Set up your workspace</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#326273]">
        Four steps open payments for your business. Each one is done where it belongs, and this page keeps count.
      </p>

      <div className="mt-8">
        {state ? (
          <SetupStepper state={state} />
        ) : (
          <section className="dash-surface p-6" role="status">
            <h2 className="text-lg font-bold text-[#1F4452]">Your setup could not be read just now</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#326273]">
              Splash could not reach your account&rsquo;s records, so it cannot show which steps are done. Nothing was changed. Reload the page in a moment; if it keeps happening, contact Splash support.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
