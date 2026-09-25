import { SuiGrpcClient } from '@mysten/sui/grpc';
import { coinWithBalance, Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';

import { STABLECOIN_NETWORK } from '@/lib/payments/stablecoin-lane';
import type { ObservedTransaction } from '@/lib/payments/stablecoin-verify';

/**
 * The stablecoin lane's view of the chain: build the transfer a business will
 * sign, dry-run what it signed, submit it, and read back what happened.
 *
 * Splash never holds a key here. It builds the transaction from the SENDER's
 * own coins, the sender's wallet signs it, and Splash submits the signed bytes
 * only after a dry run shows they do exactly what was quoted. Submitting (not
 * leaving it to the wallet) is what lets the dry run sit between the signature
 * and the chain.
 *
 * Its own client, on mainnet: the lane is mainnet-only while the rest of the
 * app may run against testnet, so it cannot share lib/sui.ts's client.
 */

// Not SUI_RPC_URL: this client speaks gRPC-web, and a JSON-RPC endpoint
// (publicnode's, for one) answers it with "Bad Request".
const DEFAULT_MAINNET_RPC = 'https://fullnode.mainnet.sui.io:443';

let client: SuiGrpcClient | null = null;

export function laneClient(): SuiGrpcClient {
  client ??= new SuiGrpcClient({
    network: STABLECOIN_NETWORK,
    baseUrl: process.env.SUI_MAINNET_RPC_URL || DEFAULT_MAINNET_RPC,
  });
  return client;
}

export interface TransferLeg {
  address: string;
  amountMinor: bigint;
}

/**
 * The unsigned transfer: each leg paid from the sender's own USDC, in one
 * transaction, so the recipient and Splash's fee are paid together or not at
 * all. Gas comes from the sender's SUI. Throws when the wallet cannot cover
 * either — see describeBuildError.
 */
export async function buildTransferBytes(
  client: SuiGrpcClient,
  input: { sender: string; coinType: string; legs: TransferLeg[] },
): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(input.sender);
  for (const leg of input.legs) {
    if (leg.amountMinor <= 0n) continue;
    tx.transferObjects([coinWithBalance({ type: input.coinType, balance: leg.amountMinor })], leg.address);
  }
  return tx.build({ client });
}

/** What a build failure means for the person holding the wallet. */
export function describeBuildError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/insufficient|not enough|balance/i.test(message) && /usdc/i.test(message)) {
    return 'Your wallet does not hold enough USDC on Sui for this payment plus the fee.';
  }
  if (/gas/i.test(message)) {
    return 'Your wallet needs a little SUI to pay the network fee (gas). Add SUI to it and try again.';
  }
  if (/insufficient|not enough|balance/i.test(message)) {
    return 'Your wallet does not hold enough for this payment plus the fee.';
  }
  return `The transfer could not be prepared: ${message}`;
}

/** The digest a set of transaction bytes will have on chain. */
export function digestOf(bytes: Uint8Array): string {
  return TransactionDataBuilder.getDigestFromBytes(bytes);
}

/** The sender written into a set of transaction bytes. */
export function senderOf(bytes: Uint8Array): string | null {
  return Transaction.from(bytes).getData().sender ?? null;
}

const INCLUDE = { balanceChanges: true, transaction: true, effects: true } as const;

type LaneResult = Awaited<ReturnType<SuiGrpcClient['core']['getTransaction']>>;

export function observe(result: LaneResult | Awaited<ReturnType<SuiGrpcClient['core']['simulateTransaction']>>): ObservedTransaction & { digest: string } {
  const t = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction;
  const data = t as unknown as {
    digest?: string;
    effects?: { transactionDigest?: string } | null;
    status: { success: boolean; error: { message?: string } | null };
    balanceChanges?: Array<{ coinType: string; address: string; amount: string }>;
    transaction?: { sender?: string | null };
  };
  return {
    // A dry run of unsigned bytes has no top-level digest (checked on mainnet,
    // 2026-09-25); its effects carry the one the transaction will have.
    digest: data.digest ?? data.effects?.transactionDigest ?? '',
    success: data.status.success,
    error: data.status.success ? null : data.status.error?.message ?? 'execution failed',
    sender: data.transaction?.sender ?? null,
    balanceChanges: data.balanceChanges ?? [],
  };
}

/** Dry-run signed (or unsigned) bytes: what they WOULD do, moving nothing. */
export async function simulateTransfer(client: SuiGrpcClient, bytes: Uint8Array) {
  return observe(await client.core.simulateTransaction({ transaction: bytes, include: INCLUDE }));
}

/** Submit the business's signed bytes. */
export async function executeTransfer(client: SuiGrpcClient, bytes: Uint8Array, signature: string) {
  return observe(await client.core.executeTransaction({ transaction: bytes, signatures: [signature], include: INCLUDE }));
}

/** What the chain says a digest did, or null if it has never seen it. */
export async function readTransfer(client: SuiGrpcClient, digest: string) {
  try {
    return observe(await client.core.getTransaction({ digest, include: INCLUDE }));
  } catch (error) {
    if (/not ?found|does not exist|unknown/i.test(error instanceof Error ? error.message : '')) return null;
    throw error;
  }
}
