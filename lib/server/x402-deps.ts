import { safeGet } from '@/lib/server/safe-fetch';
import { liveSendDeps } from '@/lib/server/stablecoin-deps';
import { screenWalletAddress } from '@/lib/server/wallet-screening';
import type { X402Deps } from '@/lib/server/x402-pay';

/** Real dependencies for x402: the wallet lane's ledger, chain and approvals,
 *  plus a guarded fetch for the seller and sanctions screening for its payee. */
export async function liveX402Deps(): Promise<X402Deps | null> {
  const send = await liveSendDeps();
  if (!send) return null;
  return {
    db: send.db,
    chain: send.chain,
    approval: send.approval,
    get: (url, init) => safeGet(url, { headers: init?.headers, timeoutMs: init?.timeoutMs }),
    screen: (address) => screenWalletAddress(address),
  };
}
