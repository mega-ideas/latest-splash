/**
 * The receipt of a cross-chain USDC payment over CCTP V2 (v2 §4.7, D5c),
 * for ONE business: the burn on Sui, Circle's attestation, the mint on the
 * destination chain, each recorded once and only from its own source.
 *
 *   opened     when the owners' payment is opened: the saved CROSS_CHAIN
 *              recipient (its domain and mint recipient), the amount and
 *              Circle's fee bound, keyed once per business and payment
 *              reference (the intent id). A second open with anything else
 *              is refused.
 *   burned     the Sui transaction that paid it: it is this business's own
 *              executed signing request, signed by the owners' multisig (a
 *              cross-chain payment is never a rule payment), the chain shows
 *              it succeeded from that wallet and confirmed this intent under
 *              splash_core's original package id. Never a digest the caller
 *              merely names.
 *   attested   Circle's attestation service holds a complete message for
 *              that burn that mints exactly this amount to this recipient on
 *              this domain (lib/payments/cctp-receipts.ts). The message and
 *              attestation are kept as Circle gave them.
 *   minted     the destination chain's own receipt of the transaction shows
 *              Circle's MessageTransmitterV2 receiving this message (EVM).
 *              A Solana mint is not read yet: it stays attested.
 *
 * Forward only: the table's trigger refuses a step back and never replaces a
 * recorded burn, attestation or mint. Each step is a compare-and-set on the
 * row's status, so two callers record a step once. Nothing is signed or sent
 * here; anyone may relay a mint (destination caller zero), and Splash does
 * not.
 *
 * Fail closed: in production, Circle's service is asked only at the
 * configured CCTP_IRIS_API_URL and a mint is read only through a configured
 * RPC (CCTP_MINT_RPC_URLS_JSON); without them nothing advances, and no step
 * is ever recorded from anything but its source.
 */
import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { crossChainTransfers, suppliers, walletSigningRequests } from '../db/schema.ts';
import { FUNDING_CHAINS, SUI_CCTP_DOMAIN } from '../payments/cctp.ts';
import { irisMessagesOf, isEvmTxHash, messageTransmitterV2, readBurn, readEvmMint, type EvmReceipt, type IrisMessage } from '../payments/cctp-receipts.ts';
import { isCrossChainChain, moveDeliveryOf, type CrossChainChain } from '../recipients/wallet-recipients.ts';
import { isProductionRuntime } from './runtime-mode.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

type Refusal = { ok: false; status: number; code: string; error: string };
const refuse = (status: number, code: string, error: string): Refusal => ({ ok: false, status, code, error });

export type CrossChainRow = typeof crossChainTransfers.$inferSelect;

export class CctpUnavailable extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'CctpUnavailable';
    this.code = code;
  }
}

/** Circle's attestation service, asked for the messages of one Sui burn. */
export interface IrisClient {
  readonly sandbox: boolean;
  messagesForSuiBurn(digest: string): Promise<IrisMessage[]>;
}

/** The destination chain's receipt of one transaction. */
export interface MintReader {
  receipt(chain: CrossChainChain, txHash: string): Promise<EvmReceipt | null>;
}

type Fetcher = typeof fetch;

/** Circle's public sandbox (testnets). Never used in production. */
export const IRIS_SANDBOX_URL = 'https://iris-api-sandbox.circle.com';

export function irisClientFromEnv(env: NodeJS.ProcessEnv = process.env, fetcher: Fetcher = fetch): IrisClient {
  const configured = (env.CCTP_IRIS_API_URL ?? '').trim();
  const production = isProductionRuntime(env);
  if (production && !configured) {
    throw new CctpUnavailable("Circle's attestation service is not set up on this server (CCTP_IRIS_API_URL). Nothing was recorded.", 'cctp_not_configured');
  }
  const base = (configured || IRIS_SANDBOX_URL).replace(/\/+$/, '');
  if (production && base === IRIS_SANDBOX_URL) throw new CctpUnavailable("Production does not read Circle's sandbox.", 'cctp_not_configured');
  return {
    sandbox: base === IRIS_SANDBOX_URL,
    async messagesForSuiBurn(digest) {
      const res = await fetcher(`${base}/v2/messages/${SUI_CCTP_DOMAIN}?transactionHash=${encodeURIComponent(digest)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 404) return [];
      if (!res.ok) throw new CctpUnavailable(`Circle's attestation service answered ${res.status}.`, 'cctp_unavailable');
      return irisMessagesOf(await res.json());
    },
  };
}

/** JSON-RPC readers per chain from CCTP_MINT_RPC_URLS_JSON ({"BASE":"https://…"}). A chain without one cannot be read. */
export function mintReaderFromEnv(env: NodeJS.ProcessEnv = process.env, fetcher: Fetcher = fetch): MintReader {
  let urls: Record<string, string> = {};
  try {
    const parsed = JSON.parse((env.CCTP_MINT_RPC_URLS_JSON ?? '').trim() || '{}');
    if (parsed && typeof parsed === 'object') urls = parsed as Record<string, string>;
  } catch {
    urls = {};
  }
  return {
    async receipt(chain, txHash) {
      const url = typeof urls[chain] === 'string' ? urls[chain].trim() : '';
      if (!/^https:\/\//.test(url)) throw new CctpUnavailable(`No RPC for ${FUNDING_CHAINS[chain].label} is set up (CCTP_MINT_RPC_URLS_JSON), so the mint cannot be read.`, 'mint_check_not_configured');
      const res = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new CctpUnavailable(`The ${FUNDING_CHAINS[chain].label} RPC answered ${res.status}.`, 'mint_check_unavailable');
      const json = (await res.json()) as { result?: EvmReceipt | null; error?: unknown };
      if (json.error) throw new CctpUnavailable(`The ${FUNDING_CHAINS[chain].label} RPC refused the read.`, 'mint_check_unavailable');
      return json.result ?? null;
    },
  };
}

export type CrossChainDeps = {
  db: DrizzleDb;
  orgId: string;
  now: () => Date;
};

/** Open the receipt for one owners' cross-chain payment to a saved CROSS_CHAIN recipient. Idempotent on the payment reference. */
export async function openCrossChainTransfer(
  deps: CrossChainDeps,
  input: { paymentRef: string; recipientId: string; amountMinor: bigint; maxBridgeFeeMinor: bigint },
): Promise<{ ok: true; transfer: CrossChainRow; created: boolean } | Refusal> {
  let paymentRef: string;
  try {
    paymentRef = normalizeSuiAddress(input.paymentRef);
  } catch {
    return refuse(400, 'bad_payment', 'Name the payment by its intent id.');
  }
  if (input.amountMinor <= 0n) return refuse(400, 'bad_amount', 'A payment carries an amount.');
  if (input.maxBridgeFeeMinor < 0n || input.maxBridgeFeeMinor >= input.amountMinor) return refuse(400, 'bad_fee', "Circle's fee bound must leave something to arrive.");
  const [recipient] = await deps.db.select().from(suppliers).where(and(eq(suppliers.id, input.recipientId), eq(suppliers.orgId, deps.orgId))).limit(1);
  if (!recipient) return refuse(404, 'not_found', 'No such recipient.');
  const move = moveDeliveryOf({
    deliveryKind: recipient.deliveryKind as 'CROSS_CHAIN',
    destinationChain: recipient.destinationChain,
    destinationDomain: recipient.destinationDomain,
    mintRecipient: recipient.mintRecipient,
  });
  if (!move || move.kind !== 3) return refuse(409, 'not_cross_chain', 'That recipient is not paid on another chain.');
  const now = deps.now();
  const inserted = await deps.db
    .insert(crossChainTransfers)
    .values({
      id: `cct_${randomUUID()}`,
      orgId: deps.orgId,
      paymentRef,
      recipientId: recipient.id,
      destinationChain: move.chain,
      destinationDomain: move.destinationDomain,
      mintRecipient: move.mintRecipient,
      amountMinor: input.amountMinor,
      maxBridgeFeeMinor: input.maxBridgeFeeMinor,
      status: 'awaiting_burn',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { ok: true, transfer: inserted[0], created: true };
  const existing = await readCrossChainTransfer(deps.db, deps.orgId, paymentRef);
  if (!existing) return refuse(409, 'conflict', 'The payment could not be opened. Try again.');
  if (existing.amountMinor !== input.amountMinor || existing.mintRecipient !== move.mintRecipient || existing.destinationDomain !== move.destinationDomain || existing.maxBridgeFeeMinor !== input.maxBridgeFeeMinor) {
    return refuse(409, 'cross_chain_conflict', 'This payment was opened with another recipient, amount or fee bound.');
  }
  return { ok: true, transfer: existing, created: false };
}

export async function readCrossChainTransfer(db: DrizzleDb, orgId: string, paymentRef: string): Promise<CrossChainRow | null> {
  let ref: string;
  try {
    ref = normalizeSuiAddress(paymentRef);
  } catch {
    return null;
  }
  const [row] = await db.select().from(crossChainTransfers).where(and(eq(crossChainTransfers.orgId, orgId), eq(crossChainTransfers.paymentRef, ref))).limit(1);
  return row ?? null;
}

/** Move a row one step, only from the status it was read in. */
async function step(db: DrizzleDb, row: CrossChainRow, set: Partial<typeof crossChainTransfers.$inferInsert>): Promise<CrossChainRow | null> {
  const [done] = await db
    .update(crossChainTransfers)
    .set(set)
    .where(and(eq(crossChainTransfers.id, row.id), eq(crossChainTransfers.orgId, row.orgId), eq(crossChainTransfers.status, row.status)))
    .returning();
  return done ?? null;
}

export type SuiTx = { success: boolean; sender: string | null; events?: Array<{ eventType: string; json: unknown }> };

export type BurnDeps = CrossChainDeps & {
  readTransaction: (digest: string) => Promise<SuiTx | null>;
  corePackageOriginalId: string;
};

/** The wallet that sent this business's own executed signing request with this digest, or null: a burn is one the owners signed here. */
async function ownExecutedSender(db: DrizzleDb, orgId: string, digest: string): Promise<string | null> {
  const [row] = await db
    .select({ sender: walletSigningRequests.senderAddress, signerKind: walletSigningRequests.signerKind })
    .from(walletSigningRequests)
    .where(and(eq(walletSigningRequests.orgId, orgId), eq(walletSigningRequests.executedDigest, digest), eq(walletSigningRequests.status, 'executed')))
    .limit(1);
  // The owners' multisig only: a cross-chain payment is never a rule payment.
  return row && row.signerKind === 'multisig' ? row.sender : null;
}

function confirmedIntents(events: NonNullable<SuiTx["events"]>, coreOriginal: string): string[] {
  const type = `${normalizeSuiAddress(coreOriginal)}::payment_intent::IntentConfirmed`;
  const out: string[] = [];
  for (const e of events) {
    let t: string;
    try {
      const [addr, ...rest] = e.eventType.split('::');
      t = [normalizeSuiAddress(addr), ...rest].join('::');
    } catch {
      continue;
    }
    if (t !== type) continue;
    const id = (e.json as { intent_id?: unknown } | null)?.intent_id;
    if (typeof id === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(id)) out.push(normalizeSuiAddress(id));
  }
  return out;
}

/** Record the Sui burn: read from the chain, never taken from the caller's word. */
export async function recordCrossChainBurn(deps: BurnDeps, input: { paymentRef: string; burnDigest: unknown }): Promise<{ ok: true; transfer: CrossChainRow } | Refusal> {
  const row = await readCrossChainTransfer(deps.db, deps.orgId, input.paymentRef);
  if (!row) return refuse(404, 'not_found', 'No such cross-chain payment.');
  const digest = typeof input.burnDigest === 'string' ? input.burnDigest.trim() : '';
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(digest)) return refuse(400, 'bad_digest', 'A Sui transaction digest is 32 to 44 base58 characters.');
  if (row.status !== 'awaiting_burn') {
    if (row.burnDigest === digest) return { ok: true, transfer: row };
    return refuse(409, 'burn_recorded', 'Another transaction is already this payment’s burn.');
  }
  let tx: SuiTx | null;
  try {
    tx = await deps.readTransaction(digest);
  } catch {
    return refuse(502, 'chain_unreadable', 'The transaction could not be read from Sui. Nothing was recorded.');
  }
  if (!tx) return refuse(404, 'no_such_transaction', 'Sui has no such transaction.');
  if (!tx.success) return refuse(409, 'burn_failed', 'That transaction failed on Sui, so nothing was burned.');
  const signedHere = await ownExecutedSender(deps.db, deps.orgId, digest);
  if (!signedHere || !tx.sender || normalizeSuiAddress(tx.sender) !== normalizeSuiAddress(signedHere)) {
    return refuse(409, 'not_this_business', "That transaction is not one this business's owners signed from its wallet.");
  }
  if (!confirmedIntents(tx.events ?? [], deps.corePackageOriginalId).includes(row.paymentRef)) {
    return refuse(409, 'not_this_payment', 'That transaction did not pay this payment.');
  }
  const now = deps.now();
  const done = await step(deps.db, row, { status: 'burned', burnDigest: digest, burnedAt: now, updatedAt: now });
  if (!done) {
    const again = await readCrossChainTransfer(deps.db, deps.orgId, row.paymentRef);
    if (again?.burnDigest === digest) return { ok: true, transfer: again };
    return refuse(409, 'burn_recorded', 'Another transaction is already this payment’s burn.');
  }
  return { ok: true, transfer: done };
}

/** Ask Circle whether the burn is attested, and keep the attestation once it is. */
export async function refreshCrossChainAttestation(deps: CrossChainDeps & { iris: IrisClient }, input: { paymentRef: string }): Promise<{ ok: true; transfer: CrossChainRow; pending: boolean } | Refusal> {
  const row = await readCrossChainTransfer(deps.db, deps.orgId, input.paymentRef);
  if (!row) return refuse(404, 'not_found', 'No such cross-chain payment.');
  if (row.status === 'awaiting_burn' || !row.burnDigest) return refuse(409, 'not_burned', 'The payment has not been burned on Sui yet.');
  if (row.status === 'attested' || row.status === 'minted') return { ok: true, transfer: row, pending: false };
  let messages: IrisMessage[];
  try {
    messages = await deps.iris.messagesForSuiBurn(row.burnDigest);
  } catch (error) {
    if (error instanceof CctpUnavailable) return refuse(503, error.code, error.message);
    return refuse(502, 'cctp_unavailable', "Circle's attestation service could not be reached. Nothing was recorded.");
  }
  const reading = readBurn(messages, { destinationDomain: row.destinationDomain, mintRecipient: row.mintRecipient, amountMinor: row.amountMinor, maxBridgeFeeMinor: row.maxBridgeFeeMinor });
  if (reading.state === 'pending') return { ok: true, transfer: row, pending: true };
  if (reading.state === 'mismatch') {
    // An alert for ops: ids only.
    console.error(`[cross-chain] ALERT burn ${row.burnDigest} for payment ${row.paymentRef} does not match Circle's message: ${reading.reason}`);
    return refuse(409, 'burn_mismatch', `Circle's message for this burn does not match the payment (${reading.reason}). Nothing was recorded.`);
  }
  const now = deps.now();
  const done = await step(deps.db, row, {
    status: 'attested',
    message: reading.message,
    messageNonce: reading.nonce,
    attestation: reading.attestation,
    attestedAt: now,
    mintedAmountMinor: reading.mintsMinor,
    sandbox: deps.iris.sandbox,
    updatedAt: now,
  });
  return { ok: true, transfer: done ?? (await readCrossChainTransfer(deps.db, deps.orgId, row.paymentRef)) ?? row, pending: false };
}

/** Record the mint: believed only from the destination chain's own receipt. */
export async function recordCrossChainMint(
  deps: CrossChainDeps & { mints: MintReader; network: 'mainnet' | 'testnet' },
  input: { paymentRef: string; mintTxHash: unknown },
): Promise<{ ok: true; transfer: CrossChainRow } | Refusal> {
  const row = await readCrossChainTransfer(deps.db, deps.orgId, input.paymentRef);
  if (!row) return refuse(404, 'not_found', 'No such cross-chain payment.');
  if (row.status === 'minted') {
    if (typeof input.mintTxHash === 'string' && row.mintTxHash === input.mintTxHash.toLowerCase()) return { ok: true, transfer: row };
    return refuse(409, 'mint_recorded', 'This payment’s mint is already recorded.');
  }
  if (row.status !== 'attested' || !row.message || !row.messageNonce) return refuse(409, 'not_attested', "Circle has not attested this payment's burn yet.");
  if (!isCrossChainChain(row.destinationChain)) return refuse(409, 'bad_chain', 'The payment names a chain Splash does not pay.');
  const chain = row.destinationChain;
  if (FUNDING_CHAINS[chain].addressFormat !== 'EVM') return refuse(501, 'mint_check_not_built', `Splash does not read ${FUNDING_CHAINS[chain].label} mints yet; the payment stays attested.`);
  if (!isEvmTxHash(input.mintTxHash)) return refuse(400, 'bad_tx_hash', 'An EVM transaction hash is 0x followed by 64 hexadecimal characters.');
  const txHash = input.mintTxHash.toLowerCase();
  let receipt: EvmReceipt | null;
  try {
    receipt = await deps.mints.receipt(chain, txHash);
  } catch (error) {
    if (error instanceof CctpUnavailable) return refuse(503, error.code, error.message);
    return refuse(502, 'mint_check_unavailable', `The ${FUNDING_CHAINS[chain].label} transaction could not be read. Nothing was recorded.`);
  }
  const read = readEvmMint(receipt, { transmitter: messageTransmitterV2(chain, deps.network), nonce: row.messageNonce, message: row.message });
  if (!read.ok) return refuse(409, 'not_the_mint', `That transaction is not the mint of this payment (${read.reason}).`);
  const now = deps.now();
  let done: CrossChainRow | null;
  try {
    done = await step(deps.db, row, { status: 'minted', mintTxHash: txHash, mintedAt: now, mintedAmountMinor: read.mintedMinor, updatedAt: now });
  } catch (error) {
    if (/cross_chain_transfers_mint_unique|duplicate key/i.test(String((error as { message?: string })?.message ?? '') + String((error as { cause?: { message?: string } })?.cause?.message ?? ''))) {
      return refuse(409, 'mint_recorded', 'That transaction is already another payment’s mint.');
    }
    throw error;
  }
  return { ok: true, transfer: done ?? (await readCrossChainTransfer(deps.db, deps.orgId, row.paymentRef)) ?? row };
}

/** What the receipt shows. The attestation is Circle's, as given. */
export function crossChainReceiptView(row: CrossChainRow) {
  return {
    paymentRef: row.paymentRef,
    status: row.status,
    asset: 'USDC' as const,
    route: 'CCTP_V2' as const,
    destination: { chain: row.destinationChain, domain: row.destinationDomain, mintRecipient: row.mintRecipient },
    amount: row.amountMinor.toString(),
    maxBridgeFee: row.maxBridgeFeeMinor.toString(),
    burn: row.burnDigest ? { suiDigest: row.burnDigest, at: row.burnedAt?.toISOString() ?? null } : null,
    attestation: row.attestation ? { nonce: row.messageNonce, message: row.message, attestation: row.attestation, at: row.attestedAt?.toISOString() ?? null, sandbox: row.sandbox } : null,
    mint: row.mintTxHash ? { chain: row.destinationChain, txHash: row.mintTxHash, minted: row.mintedAmountMinor?.toString() ?? null, at: row.mintedAt?.toISOString() ?? null } : null,
  };
}
