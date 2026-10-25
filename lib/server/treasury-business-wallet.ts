/**
 * The business wallet Treasury works with, resolved on the server and never
 * taken from the request (v2 D9, brief 5.7; the 5.7 review).
 *
 * The wallet is the one the org's own on-chain BusinessAccount names: its id
 * comes from `organizations.sui_business_account_id` (written by Splash when
 * the business was verified), and the `wallet` field is read from the object
 * itself. This is the same reading Phase 2's wallet routes make
 * (`parseBusinessAccount` in lib/server/wallet-deps.ts on v2/phase2-backend);
 * when the branches meet, this module should call that context's
 * `readAccount()` instead of reading the object itself, so the two can never
 * disagree.
 *
 * Fails closed: no database, no account id, an object of another type, or a
 * read that fails answers a refusal with a code, never a stand-in address.
 * Balances are read from the Sui network USDY lives on (STABLECOIN_NETWORK).
 */
import 'server-only';

import { eq } from 'drizzle-orm';

import { organizations } from '@/lib/db/schema';
import { normaliseSuiAddress } from '@/lib/payments/stablecoin-lane';
import type { WalletRead } from '@/lib/server/treasury-wallet';

const ACCOUNT_ID = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^(0x)?[0-9a-fA-F]{1,64}$/;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Option<address> as the fullnode renders it: null, the value, or `{ vec: [v] }`. */
function optionAddress(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const inner = isObject(v) && Array.isArray(v.vec) ? (v.vec.length ? v.vec[0] : null) : v;
  if (inner === null) return null;
  if (typeof inner !== 'string' || !ADDRESS.test(inner)) throw new Error('the BusinessAccount wallet is not an address');
  return normaliseSuiAddress('0x' + inner.replace(/^0x/, '').padStart(64, '0'));
}

/** The `wallet` of a splash_core::business_account::BusinessAccount, or null when it has none yet. */
export function businessAccountWallet(type: string, json: unknown): string | null {
  if (!type.endsWith('::business_account::BusinessAccount')) throw new Error('the account id names another kind of object');
  if (!isObject(json)) throw new Error('the BusinessAccount could not be read');
  return optionAddress(json.wallet);
}

export async function resolveTreasuryWallet(orgId: string): Promise<WalletRead> {
  if (!process.env.DATABASE_URL) {
    return { ok: false, status: 503, code: 'wallets_off', error: 'Business wallets are not available on this server.' };
  }
  const { getDb } = await import('@/lib/db/client');
  const [org] = await getDb()
    .select({ accountId: organizations.suiBusinessAccountId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const accountId = (org?.accountId ?? '').trim();
  if (!ACCOUNT_ID.test(accountId)) {
    return { ok: false, status: 409, code: 'no_wallet', error: 'Your business has no Splash Wallet yet. Set it up in Wallet first.' };
  }
  try {
    const { suiClient } = await import('@/lib/sui');
    const { object } = (await suiClient.core.getObject({ objectId: accountId, include: { json: true } })) as unknown as {
      object: { type: string; json?: unknown };
    };
    const wallet = businessAccountWallet(object.type, object.json);
    if (!wallet) {
      return { ok: false, status: 409, code: 'no_wallet', error: 'Your business has no Splash Wallet yet. Set it up in Wallet first.' };
    }
    return { ok: true, address: wallet };
  } catch (error) {
    console.error('[treasury] the business account could not be read', { orgId, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, status: 502, code: 'wallet_unreadable', error: 'Your business wallet could not be read from Sui just now. Try again.' };
  }
}

/** One coin's balance of the wallet, read-only, on the network USDY lives on. */
export async function readTreasuryWalletBalance(address: string, coinType: string): Promise<bigint> {
  const { laneClient } = await import('@/lib/server/stablecoin-chain');
  const { balance } = await laneClient().core.getBalance({ owner: address, coinType });
  return BigInt(balance.balance);
}
