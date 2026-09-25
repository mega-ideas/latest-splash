import { randomInt } from 'node:crypto';

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { coinWithBalance, Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';

import { STABLECOIN_NETWORK, type GasMode } from '@/lib/payments/stablecoin-lane';
import type { ObservedTransaction } from '@/lib/payments/stablecoin-verify';

/**
 * The stablecoin lane's view of the chain: build the transfer a business will
 * sign, dry-run what it signed, submit it, and read back what happened.
 *
 * Splash never holds a key here, and pays no gas. It builds the transaction
 * from the SENDER's own USDC, the sender's wallet signs it, and Splash submits
 * the signed bytes only after a dry run shows they do exactly what was quoted.
 * Submitting (not leaving it to the wallet) is what lets the dry run sit
 * between the signature and the chain.
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

export interface TransferInput {
  sender: string;
  coinType: string;
  legs: TransferLeg[];
  /** Who pays the network fee (lib/payments/stablecoin-lane.ts, Gas). */
  gas: GasMode;
}

/**
 * The unsigned transfer: each leg paid from the sender's own USDC, in one
 * transaction, so the recipient and Splash's fee are paid together or not at
 * all. Throws when the wallet cannot cover it, or when the network will not
 * take it as asked — see describeBuildError.
 *
 *   GASLESS      nothing but balance::send_funds, with gas price 0, budget 0
 *                and no gas coins. Building resolves the sender's USDC — its
 *                address balance, or its coins merged and converted, the
 *                change going back to its address balance — and then this
 *                dry-runs the result, so a transaction Sui would not run
 *                gasless fails here rather than after approval and signing.
 *   SENDER_PAYS  a coin per leg; gas comes from the sender's SUI.
 */
export async function buildTransferBytes(client: SuiGrpcClient, input: TransferInput): Promise<Uint8Array> {
  if (input.gas === 'GASLESS') {
    const [{ systemState }, { chainIdentifier }] = await Promise.all([
      client.core.getCurrentSystemState(),
      client.core.getChainIdentifier(),
    ]);
    const tx = gaslessTransferTransaction(input, {
      epoch: BigInt(systemState.epoch),
      chain: chainIdentifier,
      nonce: randomInt(0, 2 ** 32),
    });
    const bytes = await tx.build({ client });
    // With every gas field already set, the SDK builds without asking the
    // node anything, so ask it here: a transfer Sui would not run gasless
    // (change under 0.01 USDC, a coin off the allowlist) is refused now, before
    // anyone approves or signs, and the quote can fall back.
    const dry = await client.core.simulateTransaction({ transaction: bytes, include: { effects: true }, doGasSelection: false });
    if (dry.$kind === 'FailedTransaction') {
      throw new Error(`Sui would not run this transfer gasless: ${dry.FailedTransaction.status.error?.message ?? 'the dry run failed'}`);
    }
    return bytes;
  }
  const tx = new Transaction();
  tx.setSender(input.sender);
  for (const leg of input.legs) {
    if (leg.amountMinor <= 0n) continue;
    tx.transferObjects([coinWithBalance({ type: input.coinType, balance: leg.amountMinor })], leg.address);
  }
  return tx.build({ client });
}

/**
 * The gasless transfer before it is resolved against the chain. Everything
 * that makes it gasless is set here, not left to the node's gas selection, so
 * a wallet that rebuilds the transaction from its JSON keeps it: the SDK only
 * fills gas fields that are empty. (The MetaMask Sui Snap rebuilds with the
 * SDK over gRPC — its source, 2026-06 — and signs what it rebuilt.)
 *
 * The expiration is required: a transfer paid from an address balance has
 * no owned input to stop a replay, so Sui asks for a ValidDuring window and a
 * nonce. It runs this epoch or the next — far longer than the quote holds.
 */
export function gaslessTransferTransaction(
  input: Omit<TransferInput, 'gas'>,
  validity: { epoch: bigint; chain: string; nonce: number },
): Transaction {
  const tx = new Transaction();
  tx.setSender(input.sender);
  for (const leg of input.legs) {
    if (leg.amountMinor <= 0n) continue;
    tx.moveCall({
      target: '0x2::balance::send_funds',
      typeArguments: [input.coinType],
      arguments: [tx.balance({ type: input.coinType, balance: leg.amountMinor }), tx.pure.address(leg.address)],
    });
  }
  tx.setGasPrice(0);
  tx.setGasBudget(0);
  tx.setGasPayment([]);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: String(validity.epoch),
      maxEpoch: String(validity.epoch + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain: validity.chain,
      nonce: validity.nonce,
    },
  });
  return tx;
}

/** What a build failure means for the person holding the wallet. */
export function describeBuildError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/insufficient|not enough|balance/i.test(message) && /usdc/i.test(message)) {
    return 'Your wallet does not hold enough USDC on Sui for this payment (and its fee, if the quote shows one).';
  }
  // Only a transfer the wallet pays gas for gets here: x402, or a wallet
  // transfer that Sui would not take gasless (lib/server/stablecoin-send.ts).
  if (/gas/i.test(message)) {
    return 'This transfer needs a little SUI in your wallet for the network fee (gas). Add some and try again.';
  }
  if (/insufficient|not enough|balance/i.test(message)) {
    return 'Your wallet does not hold enough for this payment (and its fee, if the quote shows one).';
  }
  return `The transfer could not be prepared: ${message}`;
}

/**
 * Why Sui would not take a transfer gasless, in words the sender can act on —
 * or null when the refusal is not one they can fix by changing the amount.
 * Checked on mainnet (2026-09-26): a gasless transfer must leave the sending
 * wallet with nothing, or with at least 0.01 USDC; the node says "Gasless
 * transactions must either use the entire address balance, or leave at least
 * 10000".
 */
export function explainGaslessRefusal(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/entire address balance|leave at least|below (the )?minimum|minimum (transfer|deposit)/i.test(message)) {
    return 'Sui carries a transfer without a network fee only when it leaves the wallet with no USDC or with at least 0.01 USDC. Change the amount by a cent, send the whole balance, or add a little SUI to pay the fee.';
  }
  return null;
}

/**
 * The node did not answer (rate limit, overload, a dropped connection), as
 * opposed to refusing the transaction. Worth trying again as it was, rather
 * than falling back to a transfer the wallet pays gas for.
 */
export function isTransientChainError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return /too many requests|resource.?exhausted|overloaded|retry.?after|unavailable|timed? ?out|timeout|econnreset|etimedout|socket hang up|fetch failed|network error/i.test(message)
    || code === 'RESOURCE_EXHAUSTED' || code === 'UNAVAILABLE' || code === 'DEADLINE_EXCEEDED';
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

/** Dry-run signed (or unsigned) bytes: what they WOULD do, moving nothing.
 *  Exactly these bytes: the node is not asked to pick gas for a gasless
 *  transaction's empty payment. */
export async function simulateTransfer(client: SuiGrpcClient, bytes: Uint8Array) {
  return observe(await client.core.simulateTransaction({ transaction: bytes, include: INCLUDE, doGasSelection: false }));
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
