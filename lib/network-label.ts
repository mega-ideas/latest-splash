/**
 * W9.2 — the receipt's network line reads from the runtime profile so it
 * flips to "Sui mainnet" automatically at launch (config change, no code).
 *
 * The resolution now lives in lib/network.ts (the single source of truth for
 * network facts); this module stays as a stable import path for receipts.
 */
export { receiptNetworkLine } from '@/lib/network';
