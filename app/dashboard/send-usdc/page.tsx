import { redirect } from 'next/navigation';

/**
 * Send USDC became Wallet (v2 brief 5.1 and 5.5). Old links keep working,
 * including Zeke's handoff (lib/agent/usdc-handoff.ts), whose recipient and
 * amount travel in the query string: the redirect carries it over unchanged.
 */
export default async function SendUsdcPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, one);
  }
  const qs = query.toString();
  redirect(`/dashboard/wallet${qs ? `?${qs}` : ''}`);
}
