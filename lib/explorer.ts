/**
 * Explorer links that follow the network.
 *
 * Four sites hardcoded `testnet.suivision.xyz` and `suiscan.xyz/testnet`. On
 * mainnet every one of those would have pointed a customer at an explorer for
 * a different chain, where their transaction does not exist — a receipt whose
 * "verify this yourself" link proves nothing. That is the failure mode the
 * whole proof layer is built to avoid, so the network belongs in one place.
 *
 * Same resolution as lib/network-label.ts: SUI_NETWORK on the server,
 * NEXT_PUBLIC_SUI_NETWORK on the client, testnet unless told otherwise.
 * Setting SUI_NETWORK=mainnet moves these links with it, no code change.
 */

export type SuiNetworkName = 'testnet' | 'mainnet';

export function explorerNetwork(): SuiNetworkName {
  return process.env.SUI_NETWORK === 'mainnet' || process.env.NEXT_PUBLIC_SUI_NETWORK === 'mainnet'
    ? 'mainnet'
    : 'testnet';
}

/** SuiVision transaction page. */
export function suiVisionTxUrl(digest: string): string {
  const network = explorerNetwork();
  const host = network === 'mainnet' ? 'suivision.xyz' : `${network}.suivision.xyz`;
  return `https://${host}/txblock/${digest}`;
}

/** SuiVision account page. */
export function suiVisionAccountUrl(address: string): string {
  const network = explorerNetwork();
  const host = network === 'mainnet' ? 'suivision.xyz' : `${network}.suivision.xyz`;
  return `https://${host}/account/${address}`;
}

/** SuiVision object page. */
export function suiVisionObjectUrl(objectId: string): string {
  const network = explorerNetwork();
  const host = network === 'mainnet' ? 'suivision.xyz' : `${network}.suivision.xyz`;
  return `https://${host}/object/${objectId}`;
}

/** Suiscan root for the active network, for a general "open the explorer" link. */
export function suiScanBaseUrl(): string {
  return `https://suiscan.xyz/${explorerNetwork()}`;
}

/** Suiscan transaction page. Suiscan keeps the network in the path. */
export function suiScanTxUrl(digest: string): string {
  return `https://suiscan.xyz/${explorerNetwork()}/tx/${digest}`;
}

/**
 * Suiscan transaction page on a NAMED network, for a lane whose network does
 * not follow SUI_NETWORK: the stablecoin lane settles on mainnet even when
 * the rest of the app runs on testnet, and a testnet link to a mainnet
 * payment is the receipt-that-proves-nothing this module exists to prevent.
 */
export function suiScanTxUrlOn(network: SuiNetworkName, digest: string): string {
  return `https://suiscan.xyz/${network}/tx/${encodeURIComponent(digest)}`;
}

/**
 * The testnet faucet, or null on mainnet — where there is no faucet and
 * offering one is an invitation to look for free mainnet SUI.
 */
export function faucetUrl(address: string): string | null {
  if (explorerNetwork() === 'mainnet') return null;
  return `https://faucet.testnet.sui.io/?address=${address}`;
}
