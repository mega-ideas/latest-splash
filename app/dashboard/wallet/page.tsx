import { redirect } from 'next/navigation';

import WalletPage from '@/components/wallet/WalletPage';
import { getCustomerSession } from '@/lib/server/customer-auth';
import { readGovernanceBannerForSession } from '@/lib/server/governance-alerts-store';

export const dynamic = 'force-dynamic';

/** The keys a payment link carries. Nothing else is passed on to Transfer, which treats even these as untrusted text. */
const FORWARDED = new Set(['to', 'amount', 'from']);

/**
 * Wallet (v2 brief 5.5), built from the Send USDC page and keeping its look.
 * Sending moved to Transfer (5.4) and USDY to Treasury (5.7). An old link
 * that carries a recipient and an amount (Zeke's handoff, an earlier Send USDC
 * link) goes to Transfer with only those keys (to, amount, from), so nothing opens a
 * payment on a page that no longer sends.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const asked = await searchParams;
  if (asked.to !== undefined || asked.amount !== undefined) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(asked)) {
      if (!FORWARDED.has(key)) continue;
      for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, one);
    }
    redirect(`/dashboard/transfer?${query.toString()}`);
  }
  // The layout already resolved the session; this reads the same person's own alerts for the card below.
  const session = await getCustomerSession();
  const alerts = session ? await readGovernanceBannerForSession(session) : [];
  return <WalletPage alerts={alerts} />;
}
