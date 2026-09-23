import { createHash } from 'node:crypto';

import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';

/**
 * Did the chain do exactly what Splash quoted — no more, no less?
 *
 * Checked twice for every wallet transfer: once on a dry run of the SIGNED
 * bytes before they are submitted (so a wallet that changed the transaction
 * is caught while nothing has moved), and once on the executed transaction
 * (so what is recorded is what happened, not what was intended).
 *
 * The test is on balance changes in the settlement coin, because that is the
 * one thing that cannot be dressed up: the recipient's USDC went up by exactly
 * the principal, Splash's fee address by exactly the fee, the sender's went
 * down by exactly their sum, and nobody else's USDC moved at all. Gas is paid
 * in SUI and does not appear here.
 */

export interface ExpectedTransfer {
  sender: string;
  coinType: string;
  legs: Array<{ address: string; amountMinor: bigint }>;
}

export interface ObservedTransaction {
  success: boolean;
  error?: string | null;
  sender: string | null;
  balanceChanges: Array<{ coinType: string; address: string; amount: string }>;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

const addr = (a: string) => normalizeSuiAddress(a);

export function verifyStablecoinTransfer(expected: ExpectedTransfer, observed: ObservedTransaction): VerifyResult {
  if (!observed.success) {
    return { ok: false, reason: `The transaction failed on chain${observed.error ? `: ${observed.error}` : ''}.` };
  }
  if (!observed.sender || addr(observed.sender) !== addr(expected.sender)) {
    return { ok: false, reason: 'The transaction was signed by a different wallet than the one quoted.' };
  }

  const coin = normalizeStructTag(expected.coinType);
  // Net change per address, in the settlement coin only.
  const net = new Map<string, bigint>();
  for (const change of observed.balanceChanges) {
    if (normalizeStructTag(change.coinType) !== coin) continue;
    const key = addr(change.address);
    net.set(key, (net.get(key) ?? 0n) + BigInt(change.amount));
  }

  // Legs to the same address are one credit. (A quote never produces that —
  // the fee address may not be the recipient — but the arithmetic should not
  // depend on it.)
  const credits = new Map<string, bigint>();
  let total = 0n;
  for (const leg of expected.legs) {
    if (leg.amountMinor <= 0n) continue;
    const key = addr(leg.address);
    credits.set(key, (credits.get(key) ?? 0n) + leg.amountMinor);
    total += leg.amountMinor;
  }

  const sender = addr(expected.sender);
  const senderChange = net.get(sender) ?? 0n;
  if (senderChange !== -total) {
    return { ok: false, reason: `The sending wallet's USDC changed by ${senderChange} base units; the quote was ${-total}.` };
  }
  for (const [address, amount] of credits) {
    const got = net.get(address) ?? 0n;
    if (got !== amount) {
      return { ok: false, reason: `${address} received ${got} base units of USDC; the quote was ${amount}.` };
    }
  }
  for (const [address, change] of net) {
    if (address === sender || credits.has(address)) continue;
    if (change !== 0n) {
      return { ok: false, reason: `The transaction also moved USDC for ${address}, which was not in the quote.` };
    }
  }
  return { ok: true };
}

/**
 * The record's fingerprint for the audit trail: canonical JSON of the facts
 * that make the payment what it was, hashed. The daily audit batch anchors
 * these; a mainnet record keeps its hash until Splash's contracts are on
 * mainnet to anchor it.
 */
export function outflowAuditHash(record: {
  id: string;
  orgId: string;
  kind: string;
  network: string;
  coinType: string;
  principalMinor: bigint;
  feeMinor: bigint;
  senderAddress: string;
  recipientAddress: string;
  feeAddress: string | null;
  txDigest: string;
}): string {
  const canonical = JSON.stringify({
    schema: 'splash.stablecoin-outflow.v1',
    id: record.id,
    orgId: record.orgId,
    kind: record.kind,
    network: record.network,
    coinType: normalizeStructTag(record.coinType),
    principalMinor: record.principalMinor.toString(),
    feeMinor: record.feeMinor.toString(),
    sender: addr(record.senderAddress),
    recipient: addr(record.recipientAddress),
    feeAddress: record.feeAddress ? addr(record.feeAddress) : null,
    txDigest: record.txDigest,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
