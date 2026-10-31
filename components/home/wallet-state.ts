import { businessWalletFrom } from '@/lib/dashboard/home';

/**
 * The Splash Wallet card's state. Only `unavailable` (a failed read) offers
 * Try again: no wallet yet, one being set up, wallets switched off on this
 * server and no access each stay true until something else changes, and a
 * retry would only show the same thing.
 */
export type WalletState =
  | { kind: 'loading' }
  | { kind: 'business'; usdcMinor: string }
  | { kind: 'none' | 'pending' | 'off'; passkeyUsdcMinor: string | null }
  | { kind: 'no_access' }
  | { kind: 'unavailable' };

function minorFrom(body: unknown): string | null {
  const value = (body as { usdcMinor?: unknown } | null)?.usdcMinor;
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/**
 * The Splash Wallet balance, from the chain. The business wallet is the
 * Phase 2 API's (GET /api/wallet/business); until there is one, the person's
 * own passkey wallet is shown as theirs, never as the business's.
 */
export async function readWallet(): Promise<WalletState> {
  let kind: 'none' | 'pending' | 'off';
  try {
    const res = await fetch('/api/wallet/business', { cache: 'no-store' });
    const body = await res.json().catch(() => null);
    const source = businessWalletFrom(res.status, body);
    if (source.kind === 'error') return { kind: 'unavailable' };
    if (source.kind === 'no_access') return { kind: 'no_access' };
    if (source.kind === 'address') {
      const balance = await fetch(`/api/stablecoin/wallet?address=${encodeURIComponent(source.address)}`, { cache: 'no-store' });
      const minor = balance.ok ? minorFrom(await balance.json().catch(() => null)) : null;
      return minor === null ? { kind: 'unavailable' } : { kind: 'business', usdcMinor: minor };
    }
    kind = source.kind;
  } catch {
    return { kind: 'unavailable' };
  }
  let passkeyUsdcMinor: string | null = null;
  try {
    const own = await fetch('/api/stablecoin/wallet', { cache: 'no-store' });
    if (own.ok) passkeyUsdcMinor = minorFrom(await own.json().catch(() => null));
  } catch {
    /* the business figure is what matters here; the passkey line just stays off */
  }
  return { kind, passkeyUsdcMinor };
}
