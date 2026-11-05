/**
 * W9.2 — the receipt's network line reads from the runtime profile so it
 * flips to "Sui mainnet" automatically at launch (config change, no code).
 *
 * Server code resolves via SUI_NETWORK (lib/sui.ts). Client components see
 * NEXT_PUBLIC_SUI_NETWORK, which the W5 mainnet profile sets alongside
 * SUI_NETWORK — until then the client default is the sandbox line, which is
 * the honest state.
 */
export function receiptNetworkLine(): string {
  const network =
    process.env.SUI_NETWORK === 'mainnet' || process.env.NEXT_PUBLIC_SUI_NETWORK === 'mainnet'
      ? 'mainnet'
      : 'testnet';
  return network === 'mainnet' ? 'Sui mainnet' : 'Sui · sandbox, no customer funds';
}

/**
 * The short form, for the dashboard rail and Zeke's composer tag (v2 brief
 * 5.1 asks for "Sui mainnet" there; the no-fabrication rule asks that it be
 * true). It reads only NEXT_PUBLIC_SUI_NETWORK: these labels render in client
 * components, where the server's SUI_NETWORK is never defined, so reading it
 * would print one label on the server and another after hydration. Anything
 * but mainnet is "Sui sandbox", which keeps "testnet" off customer surfaces
 * without claiming mainnet. `live` is whether a green ok dot may sit beside it.
 */
export function networkChip(): { label: 'Sui mainnet' | 'Sui sandbox'; live: boolean } {
  return process.env.NEXT_PUBLIC_SUI_NETWORK === 'mainnet'
    ? { label: 'Sui mainnet', live: true }
    : { label: 'Sui sandbox', live: false };
}
