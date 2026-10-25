/**
 * Reading a CCTP V2 payment out of Sui (v2 §4.7, D5c): what Circle's
 * attestation service says about the burn, and whether a transaction on the
 * destination chain is the mint of that burn.
 *
 * Sources (read 25 Oct 2026):
 *   - Circle's API reference, "Get messages" (V2):
 *     GET {iris}/v2/messages/{sourceDomainId}?transactionHash={hash}
 *     → { messages: [{ message, eventNonce, attestation, status, … }] };
 *     `attestation` is "PENDING" and `message` "0x" until it is ready;
 *     `status` is "complete" or "pending_confirmations".
 *   - circlefin/evm-cctp-contracts src/v2/MessageTransmitterV2.sol: the
 *     message header (version 4, sourceDomain 4, destinationDomain 4,
 *     nonce 32, sender 32, recipient 32, destinationCaller 32,
 *     minFinalityThreshold 4, finalityThresholdExecuted 4, body from 148)
 *     and `event MessageReceived(address indexed caller, uint32 sourceDomain,
 *     bytes32 indexed nonce, bytes32 sender, uint32 indexed
 *     finalityThresholdExecuted, bytes messageBody)`.
 *   - Circle's EVM contracts page: MessageTransmitterV2 at
 *     0x81D40F21F12A8F0E3252Bccb954D722d4c464B64 on mainnet chains (EDGE:
 *     0x5b61381Fc9e58E70EfC13a4A97516997019198ee) and
 *     0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275 on testnets.
 *
 * The attestation itself is not checked here: the destination chain's
 * MessageTransmitterV2 checks Circle's signatures when it mints, and a mint
 * is believed only from that chain's own receipt (below). Pure: no network.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { fromHex, toHex } from '@mysten/sui/utils';

import { decodeBurnMessageV2, mintedAmount, SUI_CCTP_DOMAIN, type CctpPeerChain } from './cctp.ts';

export type MessageV2 = {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  /** 32 bytes, 0x hex. Set by Circle when it attests; zero before. */
  nonce: string;
  sender: string;
  recipient: string;
  destinationCaller: string;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  body: Uint8Array;
};

const hex32 = (b: Uint8Array) => `0x${toHex(b)}`;

/** A CCTP V2 message, or null when the bytes are not one. */
export function decodeMessageV2(messageHex: string): MessageV2 | null {
  if (typeof messageHex !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(messageHex)) return null;
  const bytes = fromHex(messageHex);
  if (bytes.length < 148) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: view.getUint32(0, false),
    sourceDomain: view.getUint32(4, false),
    destinationDomain: view.getUint32(8, false),
    nonce: hex32(bytes.slice(12, 44)),
    sender: hex32(bytes.slice(44, 76)),
    recipient: hex32(bytes.slice(76, 108)),
    destinationCaller: hex32(bytes.slice(108, 140)),
    minFinalityThreshold: view.getUint32(140, false),
    finalityThresholdExecuted: view.getUint32(144, false),
    body: bytes.slice(148),
  };
}

export type IrisMessage = { message: string; attestation: string | null; status: string };

/** Circle's answer, read defensively: anything not in the documented shape is dropped. */
export function irisMessagesOf(json: unknown): IrisMessage[] {
  const list = (json as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(list)) return [];
  return list
    .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object')
    .map((m) => ({
      message: typeof m.message === 'string' ? m.message : '0x',
      attestation: typeof m.attestation === 'string' ? m.attestation : null,
      status: typeof m.status === 'string' ? m.status : '',
    }));
}

export type ExpectedBurn = { destinationDomain: number; mintRecipient: string; amountMinor: bigint; maxBridgeFeeMinor: bigint };

export type BurnReading =
  | { state: 'pending' }
  | { state: 'complete'; message: string; nonce: string; attestation: string; mintsMinor: bigint }
  | { state: 'mismatch'; reason: string };

/**
 * Which of Circle's messages for a Sui burn is this payment's, and is it
 * attested? A complete message must come from Sui, go to the payment's
 * domain, mint to its recipient exactly its amount with a fee no higher than
 * the payment's bridge fee bound, and anyone may relay it (zero destination
 * caller). A complete message that says anything else is a mismatch, never
 * this payment's receipt.
 */
export function readBurn(messages: IrisMessage[], expected: ExpectedBurn): BurnReading {
  const want = expected.mintRecipient.toLowerCase();
  let pending = false;
  for (const m of messages) {
    if (m.status !== 'complete' || !m.attestation || !/^0x[0-9a-fA-F]+$/.test(m.attestation)) {
      pending = true;
      continue;
    }
    const msg = decodeMessageV2(m.message);
    if (!msg) continue;
    const burn = decodeBurnMessageV2(msg.body);
    if (!burn) continue;
    if (burn.mintRecipient.toLowerCase() !== want) continue;
    if (msg.sourceDomain !== SUI_CCTP_DOMAIN) return { state: 'mismatch', reason: 'the message is not from Sui' };
    if (msg.destinationDomain !== expected.destinationDomain) return { state: 'mismatch', reason: 'the message goes to another chain' };
    if (burn.amount !== expected.amountMinor) return { state: 'mismatch', reason: 'the message burns another amount' };
    if (burn.maxFee > expected.maxBridgeFeeMinor) return { state: 'mismatch', reason: "the message allows Circle a higher fee than the payment's bound" };
    if (!/^0x0{64}$/.test(msg.destinationCaller)) return { state: 'mismatch', reason: 'the message names a destination caller' };
    if (/^0x0{64}$/.test(msg.nonce)) return { state: 'mismatch', reason: 'the attested message has no nonce' };
    return { state: 'complete', message: m.message.toLowerCase(), nonce: msg.nonce, attestation: m.attestation.toLowerCase(), mintsMinor: mintedAmount(burn) };
  }
  return pending ? { state: 'pending' } : { state: 'mismatch', reason: 'Circle holds no message for this burn to this recipient' };
}

// ─── The mint on an EVM chain ───────────────────────────────────────────────

/** Circle's MessageTransmitterV2 on EVM chains (see the header). */
export function messageTransmitterV2(chain: CctpPeerChain, network: 'mainnet' | 'testnet'): string {
  if (network === 'testnet') return '0xe737e5cebeeba77efe34d4aa090756590b1ce275';
  if (chain === 'EDGE') return '0x5b61381fc9e58e70efc13a4a97516997019198ee';
  return '0x81d40f21f12a8f0e3252bccb954d722d4c464b64';
}

/** topic0 of MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes). */
export const MESSAGE_RECEIVED_TOPIC = `0x${toHex(keccak_256(new TextEncoder().encode('MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)')))}`;

export type EvmReceipt = {
  status?: string;
  transactionHash?: string;
  logs?: Array<{ address?: string; topics?: string[]; data?: string; removed?: boolean }>;
};

/**
 * Whether an EVM transaction receipt is the mint of this message: it
 * succeeded, and Circle's MessageTransmitterV2 on that chain logged
 * MessageReceived for this nonce from Sui, with this message's body. Returns
 * what was minted (the amount less the fee Circle executed).
 */
export function readEvmMint(
  receipt: EvmReceipt | null,
  expected: { transmitter: string; nonce: string; message: string },
): { ok: true; mintedMinor: bigint } | { ok: false; reason: string } {
  if (!receipt) return { ok: false, reason: 'the chain has no such transaction' };
  if (receipt.status !== '0x1') return { ok: false, reason: 'the transaction failed' };
  const msg = decodeMessageV2(expected.message);
  if (!msg) return { ok: false, reason: 'the attested message cannot be read' };
  const bodyHex = toHex(msg.body);
  for (const log of receipt.logs ?? []) {
    if (log.removed) continue;
    if ((log.address ?? '').toLowerCase() !== expected.transmitter.toLowerCase()) continue;
    const topics = (log.topics ?? []).map((t) => t.toLowerCase());
    if (topics[0] !== MESSAGE_RECEIVED_TOPIC || topics[2] !== expected.nonce.toLowerCase()) continue;
    const data = (log.data ?? '').toLowerCase().replace(/^0x/, '');
    // sourceDomain, sender, offset, length, then the body, each word 32 bytes.
    if (data.length < 64 * 4) continue;
    const sourceDomain = Number.parseInt(data.slice(0, 64), 16);
    const length = Number.parseInt(data.slice(64 * 3, 64 * 4), 16);
    const body = data.slice(64 * 4, 64 * 4 + length * 2);
    if (sourceDomain !== SUI_CCTP_DOMAIN || body !== bodyHex) continue;
    const burn = decodeBurnMessageV2(msg.body);
    if (!burn) return { ok: false, reason: 'the message body cannot be read' };
    return { ok: true, mintedMinor: mintedAmount(burn) };
  }
  return { ok: false, reason: "the transaction is not Circle's mint of this payment" };
}

/** An EVM transaction hash. */
export const isEvmTxHash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
