import SettingsPage from '@/components/settings/SettingsPage';
import { subscriptionBillingEnabled } from '@/lib/billing/subscription';
import { getCustomerSession } from '@/lib/server/customer-auth';
import { readGovernanceBannerForSession } from '@/lib/server/governance-alerts-store';

export const dynamic = 'force-dynamic';

/**
 * Settings (v2 brief 5.9): team and spending rules, signers, funding sources,
 * approvals, upgrade alerts and operating controls. The route reads two things
 * a client page cannot: this person's own upgrade alerts, and whether billing
 * is switched on (it is not: the page is not given the Billing card, and its
 * routes answer 404). The page is components/settings/.
 */
export default async function Page() {
  // The layout already resolved the session; this reads the same person's own alerts for the card.
  const session = await getCustomerSession();
  const alerts = session ? await readGovernanceBannerForSession(session) : [];
  return <SettingsPage alerts={alerts} billingOn={subscriptionBillingEnabled()} />;
}
